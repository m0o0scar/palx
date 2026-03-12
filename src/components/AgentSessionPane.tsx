'use client';

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AlertCircle, Clock3, Loader2, Paperclip, PlayCircle, Send, Square, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import SyntaxHighlighter from 'react-syntax-highlighter';
import remarkGfm from 'remark-gfm';
import { listRepoFiles, saveAttachments } from '@/app/actions/git';
import {
  createOptimisticUserMessage,
  reconcileOptimisticUserMessages,
  type OptimisticUserMessage,
} from '@/lib/optimistic-user-history';
import { projectSessionHistoryEvent } from '@/lib/agent/session-history-events';
import { normalizeMarkdownLists } from '@/lib/markdown';
import { getBaseName } from '@/lib/path';
import { buildRepoMentionSuggestions } from '@/lib/repo-mention-suggestions';
import type {
  AgentProvider,
  ChatStreamEvent,
  SessionAgentHistoryItem,
  SessionAgentRunState,
  SessionAgentRuntimeState,
} from '@/lib/types';

type SessionSnapshotResponse = {
  metadata: {
    sessionName: string;
    projectPath: string;
    workspacePath: string;
    agentProvider?: AgentProvider;
    model: string;
    reasoningEffort?: string;
  };
  runtime: SessionAgentRuntimeState;
  history: SessionAgentHistoryItem[];
};

type AgentSocketPayload = {
  type: 'session-agent-event';
  sessionId: string;
  snapshot: SessionAgentRuntimeState;
  event: ChatStreamEvent;
  timestamp: string;
};

export type AgentSessionPaneHandle = {
  focusComposer: () => void;
  insertText: (text: string) => boolean;
  openAgentDetails: () => void;
  cancelActiveTurn: () => Promise<void>;
};

export type AgentSessionHeaderMeta = {
  providerName: string;
  model: string;
  runState: SessionAgentRunState | 'idle';
  socketConnected: boolean;
  threadId: string | null;
  reasoningEffort: string | null;
  workspacePath: string;
  canCancel: boolean;
  isCancelling: boolean;
  lastActivityAt: string | null;
  lastError: string | null;
};

type AgentSessionPaneProps = {
  sessionId: string;
  workspacePath: string;
  onFeedback?: (message: string) => void;
  onHeaderMetaChange?: (meta: AgentSessionHeaderMeta) => void;
};

type PendingMessage = {
  id: string;
  text: string;
  attachmentPaths: string[];
  displayText: string;
};

type VirtualHistoryMetrics = {
  end: number;
  size: number;
  start: number;
};

const HISTORY_ITEM_GAP_PX = 12;
const HISTORY_ITEM_OVERSCAN_PX = 600;
const COMPOSER_MAX_HEIGHT = 112;
const STREAMING_HISTORY_TAIL_COUNT = 4;

const PROVIDER_LABELS: Record<string, string> = {
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  cursor: 'Cursor Agent CLI',
};

function providerLabel(provider: string | null | undefined) {
  if (!provider) return 'Agent';
  return PROVIDER_LABELS[provider] || provider;
}

function estimateHistoryItemHeight(item: SessionAgentHistoryItem) {
  switch (item.kind) {
    case 'user':
      return 88;
    case 'assistant':
      return 164;
    case 'reasoning':
      return 116;
    case 'plan':
      return 112;
    case 'command':
      return 132;
    case 'tool':
      return 124;
    case 'fileChange':
      return 148;
    default:
      return 120;
  }
}

function runStateTone(runState: SessionAgentRunState | null | undefined) {
  switch (runState) {
    case 'running':
      return 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200';
    case 'queued':
      return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200';
    case 'completed':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200';
    case 'cancelled':
      return 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-500/30 dark:bg-slate-500/10 dark:text-slate-200';
    case 'error':
      return 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200';
    case 'needs_auth':
      return 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-700 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-300';
  }
}

function formatRunState(runState: SessionAgentRunState | null | undefined) {
  if (!runState) return 'idle';
  return runState.replace(/_/g, ' ');
}

function trimEmpty(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : '';
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

function formatDuration(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '';
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 10_000) return `${(value / 1000).toFixed(1)}s`;
  if (value < 60_000) return `${Math.round(value / 1000)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

function diagnosticStepTone(status: string) {
  switch (status) {
    case 'completed':
      return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-200';
    case 'failed':
      return 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-200';
    case 'running':
      return 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-200';
    default:
      return 'border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-300';
  }
}

function codeBlock(value: string | null | undefined) {
  const text = trimEmpty(value);
  if (!text) return null;
  return (
    <pre className="max-w-full overflow-x-hidden whitespace-pre-wrap break-words rounded-lg bg-slate-950/95 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-100 dark:bg-black">
      {text}
    </pre>
  );
}

function firstLinePreview(value: string | null | undefined) {
  const text = trimEmpty(value);
  if (!text) return '';

  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);

  return firstLine || '';
}

function formatToolDisplayName(value: string | null | undefined) {
  const text = trimEmpty(value);
  if (!text) return 'unknown';
  const normalized = text.replace(/\s*\{\s*$/, '').trim();
  return normalized || text;
}

function formatToolPreview(value: string | null | undefined) {
  const preview = firstLinePreview(value);
  if (!preview) return '';
  const normalized = preview.replace(/\s*\{\s*$/, '').trim();
  return normalized;
}

function stripMarkdownSyntax(value: string) {
  return value
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/^\s{0,3}(#{1,6}|\d+\.\s|[-+*]\s|>\s)/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function plainTextPreview(value: string | null | undefined) {
  const preview = firstLinePreview(value);
  return preview ? stripMarkdownSyntax(preview) : '';
}

function formatAttachmentSummary(attachmentPaths: string[]) {
  if (attachmentPaths.length === 0) return '';
  return `Attached ${attachmentPaths.length} file${attachmentPaths.length === 1 ? '' : 's'}.`;
}

function buildDisplayMessage(message: string, attachmentPaths: string[]) {
  if (message) return message;
  return formatAttachmentSummary(attachmentPaths);
}

function buildPendingMessageDisplayText(message: string, attachmentPaths: string[]) {
  const attachmentSummary = formatAttachmentSummary(attachmentPaths);
  if (!message) return attachmentSummary;
  if (!attachmentSummary) return message;
  return `${message}\n\n${attachmentSummary}`;
}

function getClipboardImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];

  const files: File[] = [];
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) {
      files.push(file);
    }
  }
  return files;
}

function MarkdownMessage({ value }: { value: string | null | undefined }) {
  const text = normalizeMarkdownLists(trimEmpty(value));
  if (!text) return null;

  return (
    <div className="markdown-message min-w-0 max-w-full overflow-x-hidden break-words text-sm leading-7">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="mb-3 text-lg font-semibold last:mb-0">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-3 text-base font-semibold last:mb-0">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-2 text-sm font-semibold last:mb-0">{children}</h3>,
          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
          ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
          ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
          li: ({ children }) => <li className="pl-1">{children}</li>,
          blockquote: ({ children }) => (
            <blockquote className="mb-3 border-l-2 border-slate-300 pl-4 italic text-slate-600 last:mb-0 dark:border-slate-600 dark:text-slate-300">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              className="text-blue-600 underline underline-offset-2 dark:text-blue-300"
              target={href?.startsWith('#') ? undefined : '_blank'}
              rel={href?.startsWith('#') ? undefined : 'noreferrer'}
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="mb-3 max-w-full overflow-x-hidden last:mb-0">
              <table className="w-full table-fixed border-collapse text-left text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="border-b border-slate-300 dark:border-slate-600">{children}</thead>,
          th: ({ children }) => <th className="break-words px-3 py-2 font-semibold">{children}</th>,
          td: ({ children }) => <td className="border-b border-slate-200 px-3 py-2 align-top break-words dark:border-slate-700">{children}</td>,
          hr: () => <hr className="my-4 border-slate-300 dark:border-slate-600" />,
          code: ({ className, children }) => {
            const textContent = String(children).replace(/\n$/, '');
            const isBlock = Boolean(className) || textContent.includes('\n');
            const language = /language-([\w-]+)/.exec(className || '')?.[1];

            if (isBlock) {
              return (
                <SyntaxHighlighter
                  language={language}
                  useInlineStyles={false}
                  customStyle={{
                    margin: 0,
                    borderRadius: '0.5rem',
                    fontSize: '11px',
                    lineHeight: 1.6,
                  }}
                >
                  {textContent}
                </SyntaxHighlighter>
              );
            }

            return (
              <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[0.9em] text-slate-800 dark:bg-slate-800 dark:text-slate-100">
                {textContent}
              </code>
            );
          },
          pre: ({ children }) => <div className="mb-3 last:mb-0">{children}</div>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

type CollapsibleHistoryItemProps = {
  itemId: string;
  label: string;
  title?: string;
  className: string;
  summaryClassName: string;
  labelClassName: string;
  titleClassName: string;
  timestamp?: string;
  timestampClassName: string;
  isOpen: boolean;
  onToggle: (itemId: string, open: boolean) => void;
  children: React.ReactNode;
};

function renderCollapsibleHistoryItem({
  itemId,
  label,
  title,
  className,
  summaryClassName,
  labelClassName,
  titleClassName,
  timestamp,
  timestampClassName,
  isOpen,
  onToggle,
  children,
}: CollapsibleHistoryItemProps) {
  const summaryTitle = title ? `${label}: ${title}` : label;

  return (
    <details
      open={isOpen}
      className={`min-w-0 overflow-hidden ${className}`}
      onToggle={(event) => {
        onToggle(itemId, event.currentTarget.open);
      }}
    >
      <summary className={summaryClassName} title={summaryTitle}>
        <span className={labelClassName}>{label}</span>
        {title ? <span className={titleClassName}>{title}</span> : null}
      </summary>
      <div className="mt-2 space-y-2.5">
        {children}
      </div>
      {timestamp ? <div className={timestampClassName}>{timestamp}</div> : null}
    </details>
  );
}

function renderHistoryItem(item: SessionAgentHistoryItem, options: RenderHistoryItemOptions = {}) {
  const timestamp = formatTimestamp(item.updatedAt || item.createdAt);
  const isExpanded = Boolean(options.expandedItems?.[item.id]);
  const handleToggleExpanded = options.onToggleExpanded ?? (() => {});

  switch (item.kind) {
    case 'user':
      return (
        <div className="flex min-w-0 justify-end">
          <div className={`min-w-0 max-w-[85%] overflow-hidden rounded-2xl rounded-br-md bg-blue-100 px-4 py-3 text-sm text-blue-950 shadow-sm dark:bg-blue-500/15 dark:text-blue-50 ${options.pulse ? 'animate-pulse' : ''}`}>
            {options.status ? (
              <div className="mb-2 flex items-center justify-end">
                <span className="rounded-full border border-blue-300/80 bg-white/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-700 dark:border-blue-300/20 dark:bg-blue-950/40 dark:text-blue-100">
                  {options.status}
                </span>
              </div>
            ) : null}
            <div className="whitespace-pre-wrap break-words">{item.text}</div>
            {timestamp ? <div className="mt-2 text-[10px] text-blue-700/80 dark:text-blue-100/70">{timestamp}</div> : null}
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div className="min-w-0 overflow-hidden px-1 py-1 text-sm text-slate-800 dark:text-slate-100">
          {item.phase ? (
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {item.phase}
            </div>
          ) : null}
          <MarkdownMessage value={item.text || ' '} />
          {timestamp ? <div className="mt-2 text-[10px] text-slate-400 dark:text-slate-500">{timestamp}</div> : null}
        </div>
      );
    case 'reasoning':
      return renderCollapsibleHistoryItem({
        itemId: item.id,
        label: 'Reasoning',
        title: plainTextPreview(item.summary) || plainTextPreview(item.text) || undefined,
        className: 'rounded-xl bg-violet-50/45 px-3 py-2 text-sm text-violet-950 dark:bg-violet-500/8 dark:text-violet-100',
        summaryClassName: 'flex min-w-0 items-baseline gap-2 cursor-pointer list-none',
        labelClassName: 'shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-700 dark:text-violet-200',
        titleClassName: 'min-w-0 truncate whitespace-nowrap text-[11px] font-normal text-violet-700/75 dark:text-violet-200/75',
        timestamp,
        timestampClassName: 'mt-2 text-[10px] text-violet-700/65 dark:text-violet-200/65',
        isOpen: isExpanded,
        onToggle: handleToggleExpanded,
        children: (
          <>
            {trimEmpty(item.summary) ? (
              <div className="font-medium">
                <MarkdownMessage value={item.summary} />
              </div>
            ) : null}
            {trimEmpty(item.text) ? (
              <div className="opacity-90">
                <MarkdownMessage value={item.text} />
              </div>
            ) : null}
          </>
        ),
      });
    case 'plan':
      return (
        <div className="rounded-2xl bg-sky-50/70 px-4 py-3 text-sm text-sky-900 shadow-sm dark:bg-sky-500/10 dark:text-sky-100">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-200">Plan</div>
          <div className="whitespace-pre-wrap break-words">{item.text}</div>
          {timestamp ? <div className="mt-3 text-[10px] text-sky-700/70 dark:text-sky-200/70">{timestamp}</div> : null}
        </div>
      );
    case 'command':
      return renderCollapsibleHistoryItem({
        itemId: item.id,
        label: 'Command',
        title: firstLinePreview(item.command) || undefined,
        className: 'rounded-xl bg-slate-50/65 px-3 py-2 text-sm dark:bg-[#0d1117]/75',
        summaryClassName: 'flex min-w-0 items-baseline gap-2 cursor-pointer list-none',
        labelClassName: 'shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-300',
        titleClassName: 'min-w-0 truncate whitespace-nowrap font-mono text-[11px] font-normal text-slate-500 dark:text-slate-400',
        timestamp,
        timestampClassName: 'mt-2 text-[10px] text-slate-400 dark:text-slate-500',
        isOpen: isExpanded,
        onToggle: handleToggleExpanded,
        children: (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${runStateTone(item.status)}`}>
                {formatRunState(item.status)}
              </span>
              {item.exitCode !== null ? (
                <span className="text-[10px] text-slate-500 dark:text-slate-400">exit {item.exitCode}</span>
              ) : null}
            </div>
            <div className="rounded-md bg-slate-100 px-2.5 py-1.5 font-mono text-[11px] text-slate-800 dark:bg-slate-900 dark:text-slate-100">
              {item.command}
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400">cwd: {item.cwd || '.'}</div>
            {codeBlock(item.output)}
          </>
        ),
      });
    case 'tool': {
      const toolName = formatToolDisplayName(item.tool);
      const toolTitle = formatToolPreview(item.message)
        || formatToolPreview(item.input)
        || formatToolPreview(item.result)
        || undefined;

      return renderCollapsibleHistoryItem({
        itemId: item.id,
        label: `Tool: ${toolName}`,
        title: toolTitle,
        className: 'rounded-xl bg-slate-50/65 px-3 py-2 text-sm dark:bg-[#0d1117]/75',
        summaryClassName: 'flex min-w-0 items-baseline gap-2 cursor-pointer list-none',
        labelClassName: 'shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-300',
        titleClassName: 'min-w-0 truncate whitespace-nowrap text-[11px] font-normal text-slate-500 dark:text-slate-400',
        timestamp,
        timestampClassName: 'mt-2 text-[10px] text-slate-400 dark:text-slate-500',
        isOpen: isExpanded,
        onToggle: handleToggleExpanded,
        children: (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${runStateTone(item.status)}`}>
                {formatRunState(item.status)}
              </span>
            </div>
            <div className="grid gap-2 text-[11px] text-slate-500 dark:text-slate-400 sm:grid-cols-2">
              <div>source: {item.source}</div>
              <div>{item.server ? `server: ${item.server}` : 'server: n/a'}</div>
            </div>
            {trimEmpty(item.message) ? <div className="whitespace-pre-wrap break-words">{item.message}</div> : null}
            {item.input ? <div><div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Input</div>{codeBlock(item.input)}</div> : null}
            {item.result ? <div><div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Result</div>{codeBlock(item.result)}</div> : null}
            {item.error ? <div><div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-red-500 dark:text-red-300">Error</div>{codeBlock(item.error)}</div> : null}
          </>
        ),
      });
    }
    case 'fileChange':
      return renderCollapsibleHistoryItem({
        itemId: item.id,
        label: 'File Changes',
        title: item.changes[0]?.path?.trim()
          ? (item.changes.length > 1
            ? `${item.changes[0].path.trim()} +${item.changes.length - 1} more`
            : item.changes[0].path.trim())
          : (item.changes.length > 0 ? `${item.changes.length} files` : undefined),
        className: 'rounded-xl bg-emerald-50/50 px-3 py-2 text-sm text-emerald-950 dark:bg-emerald-500/8 dark:text-emerald-100',
        summaryClassName: 'flex min-w-0 items-baseline gap-2 cursor-pointer list-none',
        labelClassName: 'shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-200',
        titleClassName: 'min-w-0 truncate whitespace-nowrap text-[11px] font-normal text-emerald-700/75 dark:text-emerald-200/75',
        timestamp,
        timestampClassName: 'mt-2 text-[10px] text-emerald-700/65 dark:text-emerald-200/65',
        isOpen: isExpanded,
        onToggle: handleToggleExpanded,
        children: (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${runStateTone(item.status)}`}>
                {formatRunState(item.status)}
              </span>
              <span className="text-[11px] opacity-80">
                {item.changes.length} file{item.changes.length === 1 ? '' : 's'}
              </span>
            </div>
            {item.changes.length > 0 ? (
              <div className="space-y-2">
                {item.changes.map((change) => (
                  <div key={`${item.id}-${change.path}`} className="rounded-md border border-emerald-200/80 bg-white/80 px-2.5 py-2 text-[11px] dark:border-emerald-500/20 dark:bg-emerald-950/20">
                    <div className="font-mono">{change.path}</div>
                    <div className="mt-1 uppercase tracking-wide opacity-70">{change.kind}</div>
                    {codeBlock(change.diff)}
                  </div>
                ))}
              </div>
            ) : null}
            {trimEmpty(item.output) ? codeBlock(item.output) : null}
          </>
        ),
      });
    default:
      return null;
  }
}

function createPendingMessage(text: string, attachmentPaths: string[]): PendingMessage {
  const normalizedAttachments = Array.from(new Set(attachmentPaths.map((entry) => entry.trim()).filter(Boolean)));
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    attachmentPaths: normalizedAttachments,
    displayText: buildPendingMessageDisplayText(text, normalizedAttachments),
  };
}

type VirtualHistoryRowProps = {
  item: SessionAgentHistoryItem;
  onMeasure: (key: string, height: number) => void;
  expandedItems: Record<string, boolean>;
  onToggleExpanded: (itemId: string, open: boolean) => void;
};

type RenderHistoryItemOptions = {
  status?: string | null;
  pulse?: boolean;
  expandedItems?: Record<string, boolean>;
  onToggleExpanded?: (itemId: string, open: boolean) => void;
};

function VirtualHistoryRow({ item, onMeasure, expandedItems, onToggleExpanded }: VirtualHistoryRowProps) {
  const itemKey = item.id;
  const rowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = rowRef.current;
    if (!element) return;

    const reportSize = () => {
      onMeasure(itemKey, element.getBoundingClientRect().height);
    };

    reportSize();

    const observer = new ResizeObserver(() => {
      reportSize();
    });

    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [itemKey, onMeasure]);

  return (
    <div ref={rowRef} className="min-w-0 max-w-full">
      {renderHistoryItem(item, {
        ...(item.itemStatus === 'sending' ? { status: 'sending', pulse: true } : {}),
        expandedItems,
        onToggleExpanded,
      })}
    </div>
  );
}

function buildOptimisticHistoryItem(
  message: OptimisticUserMessage,
  sessionName: string,
  ordinal: number,
): SessionAgentHistoryItem {
  return {
    kind: 'user',
    id: message.id,
    text: message.text,
    sessionName,
    ordinal,
    itemStatus: 'sending',
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
  };
}

const AgentSessionPane = forwardRef<AgentSessionPaneHandle, AgentSessionPaneProps>(function AgentSessionPane(
  { sessionId, workspacePath, onFeedback, onHeaderMetaChange },
  ref,
) {
  const [runtime, setRuntime] = useState<SessionAgentRuntimeState | null>(null);
  const [history, setHistory] = useState<SessionAgentHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composerValue, setComposerValue] = useState('');
  const [pendingAttachmentPaths, setPendingAttachmentPaths] = useState<string[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [isPastingAttachments, setIsPastingAttachments] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const [optimisticMessages, setOptimisticMessages] = useState<OptimisticUserMessage[]>([]);
  const [steerTargetId, setSteerTargetId] = useState<string | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestionList, setSuggestionList] = useState<string[]>([]);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [cursorPosition, setCursorPosition] = useState(0);
  const [workspaceEntriesCache, setWorkspaceEntriesCache] = useState<string[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const pendingSelectionRef = useRef<number | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const refreshTimerRef = useRef<number | null>(null);
  const historySizeMapRef = useRef<Record<string, number>>({});
  const [historySizeVersion, setHistorySizeVersion] = useState(0);
  const [timelineScrollTop, setTimelineScrollTop] = useState(0);
  const [timelineViewportHeight, setTimelineViewportHeight] = useState(0);
  const [expandedHistoryItems, setExpandedHistoryItems] = useState<Record<string, boolean>>({});

  const scheduleRefresh = useCallback((delay = 120) => {
    if (refreshTimerRef.current !== null) {
      return;
    }

    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void (async () => {
        try {
          const response = await fetch(`/api/agent/session?sessionId=${encodeURIComponent(sessionId)}`, {
            cache: 'no-store',
          });
          const payload = await response.json().catch(() => null) as SessionSnapshotResponse | { error?: string } | null;
          if (!response.ok || !payload || !('runtime' in payload) || !('history' in payload)) {
            throw new Error((payload && 'error' in payload && typeof payload.error === 'string')
              ? payload.error
              : 'Failed to refresh agent session.');
          }

          setRuntime(payload.runtime);
          setHistory(payload.history);
          setError(null);
        } catch (refreshError) {
          setError(refreshError instanceof Error ? refreshError.message : 'Failed to refresh agent session.');
        }
      })();
    }, delay);
  }, [sessionId]);

  const loadSnapshot = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/agent/session?sessionId=${encodeURIComponent(sessionId)}`, {
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => null) as SessionSnapshotResponse | { error?: string } | null;
      if (!response.ok || !payload || !('runtime' in payload) || !('history' in payload)) {
        throw new Error((payload && 'error' in payload && typeof payload.error === 'string')
          ? payload.error
          : 'Failed to load agent session.');
      }

      setRuntime(payload.runtime);
      setHistory(payload.history);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load agent session.');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    const nextSelection = pendingSelectionRef.current;
    if (nextSelection === null) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    pendingSelectionRef.current = null;
    textarea.focus();
    textarea.setSelectionRange(nextSelection, nextSelection);
  }, [composerValue]);

  useEffect(() => {
    if (!timelineRef.current) return;
    if (!shouldStickToBottomRef.current) return;

    timelineRef.current.scrollTop = timelineRef.current.scrollHeight;
  }, [historySizeVersion, loading, optimisticMessages, history]);

  useEffect(() => {
    const element = timelineRef.current;
    if (!element) return;

    const updateViewport = () => {
      setTimelineViewportHeight(element.clientHeight);
      setTimelineScrollTop(element.scrollTop);
    };

    updateViewport();

    const observer = new ResizeObserver(() => {
      updateViewport();
    });

    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let reconnectAttempt = 0;

    const clearReconnectTimer = () => {
      if (reconnectTimer === null) return;
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    };

    const scheduleReconnect = () => {
      if (cancelled) return;
      const delay = Math.min(10000, 1000 * (2 ** reconnectAttempt));
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      try {
        const response = await fetch(`/api/agent/socket?sessionId=${encodeURIComponent(sessionId)}`, {
          cache: 'no-store',
        });
        const payload = await response.json().catch(() => null) as { wsUrl?: string; error?: string } | null;
        if (!response.ok || !payload?.wsUrl) {
          throw new Error(payload?.error || 'Failed to initialize agent socket.');
        }

        if (cancelled) return;

        socket = new WebSocket(payload.wsUrl);
        socket.onopen = () => {
          reconnectAttempt = 0;
          setSocketConnected(true);
          setError(null);
          scheduleRefresh(0);
        };
        socket.onerror = () => {
          socket?.close();
        };
        socket.onclose = () => {
          setSocketConnected(false);
          if (!cancelled) {
            scheduleReconnect();
          }
        };
        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data as string) as AgentSocketPayload;
            if (message.type !== 'session-agent-event' || message.sessionId !== sessionId) {
              return;
            }

            setRuntime(message.snapshot);
            setError(null);
            setHistory((current) => {
              const projected = projectSessionHistoryEvent(current, sessionId, message.event, message.timestamp);
              if (!projected.handled) {
                scheduleRefresh();
                return current;
              }
              return projected.changed ? projected.history : current;
            });

            if (message.event.type === 'turn_completed' || message.event.type === 'error') {
              scheduleRefresh(250);
            }
          } catch {
            // Ignore malformed socket payloads.
          }
        };
      } catch (socketError) {
        setSocketConnected(false);
        if (!cancelled) {
          setError(socketError instanceof Error ? socketError.message : 'Failed to initialize agent socket.');
          scheduleReconnect();
        }
      }
    };

    void connect();

    return () => {
      cancelled = true;
      clearReconnectTimer();
      setSocketConnected(false);
      socket?.close();
    };
  }, [scheduleRefresh, sessionId]);

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setWorkspaceEntriesCache([]);
  }, [workspacePath]);

  const activeRunState = runtime?.runState ?? 'idle';
  const isTurnActive = activeRunState === 'queued' || activeRunState === 'running';

  const canSend = !loading && !isSending && (composerValue.trim().length > 0 || pendingAttachmentPaths.length > 0);
  const optimisticHistory = useMemo(
    () => optimisticMessages.map((message, index) => buildOptimisticHistoryItem(
      message,
      runtime?.sessionName || sessionId,
      history.length + index,
    )),
    [history.length, optimisticMessages, runtime?.sessionName, sessionId],
  );
  const displayHistory = useMemo(
    () => [...history, ...optimisticHistory],
    [history, optimisticHistory],
  );
  const liveHistoryTailCount = useMemo(
    () => Math.min(displayHistory.length, isTurnActive ? STREAMING_HISTORY_TAIL_COUNT : Math.min(2, displayHistory.length)),
    [displayHistory.length, isTurnActive],
  );
  const virtualizedHistory = useMemo(
    () => displayHistory.slice(0, Math.max(0, displayHistory.length - liveHistoryTailCount)),
    [displayHistory, liveHistoryTailCount],
  );
  const liveTailHistory = useMemo(
    () => displayHistory.slice(Math.max(0, displayHistory.length - liveHistoryTailCount)),
    [displayHistory, liveHistoryTailCount],
  );
  const historyMetrics = useMemo(() => {
    void historySizeVersion;
    const metrics: VirtualHistoryMetrics[] = [];
    let offset = 0;

    virtualizedHistory.forEach((item, index) => {
      const itemKey = item.id;
      const size = historySizeMapRef.current[itemKey] ?? estimateHistoryItemHeight(item);
      metrics.push({
        start: offset,
        size,
        end: offset + size,
      });
      offset += size;
      if (index < virtualizedHistory.length - 1) {
        offset += HISTORY_ITEM_GAP_PX;
      }
    });

    return {
      items: metrics,
      totalHeight: offset,
    };
  }, [historySizeVersion, virtualizedHistory]);
  const visibleHistoryRange = useMemo(() => {
    if (virtualizedHistory.length === 0) {
      return { startIndex: 0, endIndex: -1 };
    }

    const viewportTop = Math.max(0, timelineScrollTop - HISTORY_ITEM_OVERSCAN_PX);
    const viewportBottom = timelineScrollTop + timelineViewportHeight + HISTORY_ITEM_OVERSCAN_PX;
    const metrics = historyMetrics.items;

    let startIndex = 0;
    while (startIndex < metrics.length && metrics[startIndex].end < viewportTop) {
      startIndex += 1;
    }

    let endIndex = startIndex;
    while (endIndex < metrics.length && metrics[endIndex].start <= viewportBottom) {
      endIndex += 1;
    }

    return {
      startIndex,
      endIndex: Math.min(metrics.length - 1, Math.max(startIndex, endIndex - 1)),
    };
  }, [historyMetrics.items, timelineScrollTop, timelineViewportHeight, virtualizedHistory.length]);
  const visibleHistoryItems = useMemo(() => {
    if (visibleHistoryRange.endIndex < visibleHistoryRange.startIndex) return [];

    return virtualizedHistory
      .slice(visibleHistoryRange.startIndex, visibleHistoryRange.endIndex + 1)
      .map((item, index) => {
        const actualIndex = visibleHistoryRange.startIndex + index;
        return {
          item,
          itemKey: item.id,
          top: historyMetrics.items[actualIndex]?.start ?? 0,
        };
      });
  }, [historyMetrics.items, virtualizedHistory, visibleHistoryRange.endIndex, visibleHistoryRange.startIndex]);
  const handleMeasureHistoryItem = useCallback((key: string, height: number) => {
    const nextHeight = Math.ceil(height);
    if (!Number.isFinite(nextHeight) || nextHeight <= 0) return;
    if (historySizeMapRef.current[key] === nextHeight) return;

    historySizeMapRef.current = {
      ...historySizeMapRef.current,
      [key]: nextHeight,
    };
    setHistorySizeVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    const activeKeys = new Set(displayHistory.map((item) => item.id));
    const currentKeys = Object.keys(historySizeMapRef.current);
    if (currentKeys.every((key) => activeKeys.has(key))) return;

    const nextSizeMap: Record<string, number> = {};
    activeKeys.forEach((key) => {
      const existing = historySizeMapRef.current[key];
      if (typeof existing === 'number') {
        nextSizeMap[key] = existing;
      }
    });
    historySizeMapRef.current = nextSizeMap;
    setHistorySizeVersion((current) => current + 1);
  }, [displayHistory]);

  useEffect(() => {
    const activeItemIds = new Set(displayHistory.map((item) => item.id));
    setExpandedHistoryItems((current) => {
      const nextEntries = Object.entries(current).filter(([itemId, isOpen]) => isOpen && activeItemIds.has(itemId));
      if (nextEntries.length === Object.keys(current).length) {
        return current;
      }
      return Object.fromEntries(nextEntries);
    });
  }, [displayHistory]);

  const handleToggleExpanded = useCallback((itemId: string, open: boolean) => {
    setExpandedHistoryItems((current) => {
      if (open) {
        if (current[itemId]) return current;
        return {
          ...current,
          [itemId]: true,
        };
      }

      if (!current[itemId]) return current;
      const next = { ...current };
      delete next[itemId];
      return next;
    });
  }, []);

  useEffect(() => {
    setOptimisticMessages((current) => reconcileOptimisticUserMessages(history, current));
  }, [history]);

  const providerName = providerLabel(runtime?.agentProvider || null);
  const turnDiagnostics = runtime?.turnDiagnostics ?? null;
  const [isAgentDetailsDialogOpen, setIsAgentDetailsDialogOpen] = useState(false);

  const submitMessageToAgent = useCallback(async (message: string, attachmentPaths: string[] = []) => {
    const normalizedAttachmentPaths = Array.from(new Set(attachmentPaths.map((entry) => entry.trim()).filter(Boolean)));
    const displayMessage = buildDisplayMessage(message, normalizedAttachmentPaths);
    setError(null);
    try {
      const response = await fetch('/api/agent/message', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId,
          message,
          displayMessage,
          attachmentPaths: normalizedAttachmentPaths,
        }),
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to send message.');
      }
      shouldStickToBottomRef.current = true;
      scheduleRefresh(0);
      return { success: true as const };
    } catch (submitError) {
      const messageText = submitError instanceof Error ? submitError.message : 'Failed to send message.';
      setError(messageText);
      onFeedback?.(messageText);
      return { success: false as const, error: messageText };
    }
  }, [onFeedback, scheduleRefresh, sessionId]);

  const updateComposerSuggestions = useCallback((query: string, entries: string[], currentAttachments: string[]) => {
    const nextSuggestions = buildRepoMentionSuggestions({
      query,
      repoEntries: entries,
      currentAttachments,
      carriedAttachments: [],
    });
    setSuggestionList(nextSuggestions);
    setSelectedSuggestionIndex(0);
  }, []);

  const handleSelectSuggestion = useCallback((suggestion: string) => {
    setComposerValue((previous) => {
      const textBeforeCursor = previous.substring(0, cursorPosition);
      const lastAt = textBeforeCursor.lastIndexOf('@');
      if (lastAt === -1) {
        return previous;
      }

      const prefix = previous.substring(0, lastAt);
      const suffix = previous.substring(cursorPosition);
      const nextValue = `${prefix}@${suggestion} ${suffix}`;
      pendingSelectionRef.current = prefix.length + suggestion.length + 2;
      return nextValue;
    });

    setShowSuggestions(false);
  }, [cursorPosition]);

  const handleComposerChange = useCallback(async (nextValue: string, nextCursorPosition: number) => {
    setComposerValue(nextValue);
    setCursorPosition(nextCursorPosition);

    const textBeforeCursor = nextValue.substring(0, nextCursorPosition);
    const lastAt = textBeforeCursor.lastIndexOf('@');

    if (lastAt !== -1) {
      const query = textBeforeCursor.substring(lastAt + 1);
      if (!/\s/.test(query)) {
        setShowSuggestions(true);
        let entries = workspaceEntriesCache;
        if (entries.length === 0) {
          entries = await listRepoFiles(workspacePath);
          setWorkspaceEntriesCache(entries);
        }
        updateComposerSuggestions(
          query,
          entries,
          pendingAttachmentPaths.map((attachmentPath) => getBaseName(attachmentPath))
        );
        return;
      }
    }

    setShowSuggestions(false);
  }, [pendingAttachmentPaths, updateComposerSuggestions, workspaceEntriesCache, workspacePath]);

  const handleComposerPaste = useCallback(async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const imageFiles = getClipboardImageFiles(event.clipboardData);
    if (imageFiles.length === 0) {
      return;
    }

    event.preventDefault();
    setError(null);
    setIsPastingAttachments(true);

    try {
      const formData = new FormData();
      const timestamp = Date.now();
      imageFiles.forEach((file, index) => {
        const defaultExtension = file.type.startsWith('image/')
          ? file.type.slice('image/'.length).replace(/[^a-zA-Z0-9]/g, '') || 'png'
          : 'png';
        const normalizedExtension = defaultExtension === 'jpeg' ? 'jpg' : defaultExtension;
        const trimmedName = file.name.trim();
        const hasExtension = trimmedName.includes('.');
        const fileName = trimmedName
          ? (hasExtension ? trimmedName : `${trimmedName}.${normalizedExtension}`)
          : `pasted-image-${timestamp}-${index + 1}.${normalizedExtension}`;
        formData.append(`image-${index}`, new File([file], fileName, { type: file.type || 'image/png' }));
      });

      const savedPaths = await saveAttachments(workspacePath, formData);
      if (savedPaths.length === 0) {
        throw new Error('Failed to save pasted images.');
      }

      setPendingAttachmentPaths((current) => Array.from(new Set([...current, ...savedPaths])));
      onFeedback?.(`Attached ${savedPaths.length} image file${savedPaths.length === 1 ? '' : 's'} from clipboard`);
    } catch (pasteError) {
      const messageText = pasteError instanceof Error ? pasteError.message : 'Failed to paste image attachments.';
      setError(messageText);
      onFeedback?.(messageText);
    } finally {
      setIsPastingAttachments(false);
    }
  }, [onFeedback, workspacePath]);

  const removePendingAttachment = useCallback((targetPath: string) => {
    setPendingAttachmentPaths((current) => current.filter((entry) => entry !== targetPath));
  }, []);

  const handleSubmit = useCallback(async () => {
    const message = composerValue.trim();
    const attachmentPaths = pendingAttachmentPaths;
    if ((!message && attachmentPaths.length === 0) || isSending) return;

    setComposerValue('');
    setPendingAttachmentPaths([]);

    if (isTurnActive) {
      setPendingMessages((current) => [...current, createPendingMessage(message, attachmentPaths)]);
      onFeedback?.('Queued message for the next turn');
      return;
    }

    const optimisticMessage = createOptimisticUserMessage(buildDisplayMessage(message, attachmentPaths));
    setOptimisticMessages((current) => [...current, optimisticMessage]);
    shouldStickToBottomRef.current = true;
    setIsSending(true);
    const result = await submitMessageToAgent(message, attachmentPaths);
    if (result.success) {
      onFeedback?.('Sent message to agent');
    } else {
      setOptimisticMessages((current) => current.filter((item) => item.id !== optimisticMessage.id));
    }
    setIsSending(false);
  }, [composerValue, isSending, isTurnActive, onFeedback, pendingAttachmentPaths, submitMessageToAgent]);

  const handleCancel = useCallback(async () => {
    if (!runtime || !isTurnActive || isCancelling) return;

    setIsCancelling(true);
    setError(null);
    try {
      const response = await fetch('/api/agent/cancel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId,
        }),
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to cancel turn.');
      }

      onFeedback?.('Cancelled active agent turn');
      scheduleRefresh(0);
    } catch (cancelError) {
      const messageText = cancelError instanceof Error ? cancelError.message : 'Failed to cancel turn.';
      setError(messageText);
      onFeedback?.(messageText);
    } finally {
      setIsCancelling(false);
    }
  }, [isCancelling, isTurnActive, onFeedback, runtime, scheduleRefresh, sessionId]);

  const dispatchQueuedMessage = useCallback(async (targetId?: string | null) => {
    if (isSending) return false;

    const queue = pendingMessages;
    if (queue.length === 0) return false;

    const nextIndex = targetId
      ? queue.findIndex((item) => item.id === targetId)
      : 0;
    if (nextIndex < 0) return false;

    const nextMessage = queue[nextIndex];
    setIsSending(true);
    setPendingMessages((current) => current.filter((item) => item.id !== nextMessage.id));
    const result = await submitMessageToAgent(nextMessage.text, nextMessage.attachmentPaths);
    setIsSending(false);

    if (result.success) {
      onFeedback?.(targetId ? 'Sent steer message to agent' : 'Sent queued message to agent');
      return true;
    }

    setPendingMessages((current) => [nextMessage, ...current]);
    return false;
  }, [isSending, onFeedback, pendingMessages, submitMessageToAgent]);

  const handleSteerMessage = useCallback(async (messageId: string) => {
    if (isSending || isCancelling) return;

    if (!isTurnActive) {
      void dispatchQueuedMessage(messageId);
      return;
    }

    setSteerTargetId(messageId);
    onFeedback?.('Steering agent with queued message...');
    await handleCancel();
  }, [dispatchQueuedMessage, handleCancel, isCancelling, isSending, isTurnActive, onFeedback]);

  const headerMeta = useMemo<AgentSessionHeaderMeta>(() => ({
    providerName,
    model: runtime?.model || '',
    runState: activeRunState,
    socketConnected,
    threadId: runtime?.threadId || null,
    reasoningEffort: runtime?.reasoningEffort || null,
    workspacePath,
    canCancel: Boolean(runtime) && (isTurnActive || isCancelling),
    isCancelling,
    lastActivityAt: runtime?.lastActivityAt || null,
    lastError: runtime?.lastError || null,
  }), [
    activeRunState,
    isCancelling,
    isTurnActive,
    providerName,
    runtime,
    socketConnected,
    workspacePath,
  ]);

  useEffect(() => {
    onHeaderMetaChange?.(headerMeta);
  }, [headerMeta, onHeaderMetaChange]);

  useImperativeHandle(ref, () => ({
    focusComposer() {
      textareaRef.current?.focus();
    },
    insertText(text: string) {
      const value = text ?? '';
      if (!value) return true;

      setComposerValue((previous) => {
        const textarea = textareaRef.current;
        const start = textarea?.selectionStart ?? previous.length;
        const end = textarea?.selectionEnd ?? previous.length;
        const nextValue = `${previous.slice(0, start)}${value}${previous.slice(end)}`;
        pendingSelectionRef.current = start + value.length;
        return nextValue;
      });

      onFeedback?.('Inserted text into agent input');
      return true;
    },
    openAgentDetails() {
      setIsAgentDetailsDialogOpen(true);
    },
    async cancelActiveTurn() {
      await handleCancel();
    },
  }), [handleCancel, onFeedback]);

  useEffect(() => {
    if (isTurnActive || isSending || pendingMessages.length === 0) return;

    const nextTargetId = steerTargetId ?? pendingMessages[0]?.id ?? null;
    if (!nextTargetId) return;

    let cancelled = false;
    void (async () => {
      const dispatched = await dispatchQueuedMessage(nextTargetId);
      if (!cancelled && steerTargetId === nextTargetId) {
        setSteerTargetId(null);
      }
      if (!dispatched && !cancelled && steerTargetId === nextTargetId) {
        setSteerTargetId(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [dispatchQueuedMessage, isSending, isTurnActive, pendingMessages, steerTargetId]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent">
      {isAgentDetailsDialogOpen ? (
        <dialog className="modal modal-open">
          <div className="modal-box max-w-2xl">
            <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">Agent Details</h3>
            <div className="mt-3 grid gap-3 text-sm">
              <div className="grid gap-2 rounded-xl border border-slate-200/80 bg-slate-50/80 p-3 dark:border-[#30363d] dark:bg-[#0d1117]/80 sm:grid-cols-2">
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Agent</div>
                  <div className="mt-0.5 font-medium text-slate-900 dark:text-slate-100">{providerName}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Status</div>
                  <div className="mt-0.5">
                    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${runStateTone(activeRunState)}`}>
                      {formatRunState(activeRunState)}
                    </span>
                  </div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Model</div>
                  <div className="mt-0.5 break-all font-mono text-xs text-slate-700 dark:text-slate-200">{runtime?.model || 'n/a'}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Connection</div>
                  <div className="mt-0.5 inline-flex items-center gap-1 text-xs text-slate-700 dark:text-slate-200">
                    <Clock3 className="h-3 w-3" />
                    {socketConnected ? 'live' : 'offline'}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Thread</div>
                  <div className="mt-0.5 break-all font-mono text-xs text-slate-700 dark:text-slate-200">{runtime?.threadId || 'n/a'}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Reasoning</div>
                  <div className="mt-0.5 text-xs text-slate-700 dark:text-slate-200">{runtime?.reasoningEffort || 'n/a'}</div>
                </div>
                <div className="sm:col-span-2">
                  <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">CWD</div>
                  <div className="mt-0.5 break-all font-mono text-xs text-slate-700 dark:text-slate-200">{workspacePath || '.'}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Last Activity</div>
                  <div className="mt-0.5 text-xs text-slate-700 dark:text-slate-200">{formatTimestamp(runtime?.lastActivityAt) || 'n/a'}</div>
                </div>
                {turnDiagnostics ? (
                  <div className="sm:col-span-2">
                    <div className="text-[11px] uppercase tracking-wide text-slate-500 dark:text-slate-400">Startup Diagnostics</div>
                    <div className="mt-2 rounded-xl border border-slate-200/80 bg-slate-50/80 px-3 py-2 dark:border-[#30363d] dark:bg-[#0d1117]/80">
                      <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-600 dark:text-slate-300">
                        <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
                          {turnDiagnostics.transport}
                        </span>
                        {turnDiagnostics.timeToTurnStartMs != null ? (
                          <span>to running {formatDuration(turnDiagnostics.timeToTurnStartMs)}</span>
                        ) : (
                          <span>queued since {formatTimestamp(turnDiagnostics.queuedAt)}</span>
                        )}
                      </div>
                      {turnDiagnostics.steps.length > 0 ? (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {turnDiagnostics.steps.map((step) => {
                            const durationLabel = step.status === 'running'
                              ? 'in progress'
                              : formatDuration(step.durationMs);
                            return (
                              <span
                                key={step.key}
                                title={step.detail || undefined}
                                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${diagnosticStepTone(step.status)}`}
                              >
                                <span>{step.label}</span>
                                {durationLabel ? <span>{durationLabel}</span> : null}
                              </span>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
              {runtime?.lastError ? (
                <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
                  <div className="mb-1 font-semibold uppercase tracking-wide">Last Error</div>
                  <div className="whitespace-pre-wrap break-words">{runtime.lastError}</div>
                </div>
              ) : null}
            </div>
            <div className="modal-action">
              <button
                type="button"
                className="btn"
                onClick={() => setIsAgentDetailsDialogOpen(false)}
              >
                Close
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={() => setIsAgentDetailsDialogOpen(false)}>close</button>
          </form>
        </dialog>
      ) : null}

      <div
        ref={timelineRef}
        className="custom-scrollbar flex-1 overflow-x-hidden overflow-y-auto px-4 py-4"
        onScroll={(event) => {
          const target = event.currentTarget;
          setTimelineScrollTop(target.scrollTop);
          setTimelineViewportHeight(target.clientHeight);
          shouldStickToBottomRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 48;
        }}
      >
        {loading ? (
          <div className="flex h-full min-h-[180px] items-center justify-center">
            <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 shadow-sm dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-300">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading agent timeline...
            </div>
          </div>
        ) : displayHistory.length === 0 ? (
          <div className="flex h-full min-h-[180px] items-center justify-center">
            <div className="max-w-md rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-5 py-6 text-center text-sm text-slate-500 dark:border-[#30363d] dark:bg-[#0d1117]/50 dark:text-slate-400">
              No agent activity yet. Send a task below to start a background turn.
            </div>
          </div>
        ) : (
          <>
            {virtualizedHistory.length > 0 ? (
              <div
                style={{
                  height: historyMetrics.totalHeight,
                  marginBottom: liveTailHistory.length > 0 ? HISTORY_ITEM_GAP_PX : 0,
                  position: 'relative',
                }}
              >
                {visibleHistoryItems.map(({ item, itemKey, top }) => (
                  <div
                    key={itemKey}
                    className="absolute left-0 right-0"
                    style={{ top }}
                  >
                    <VirtualHistoryRow
                      item={item}
                      onMeasure={handleMeasureHistoryItem}
                      expandedItems={expandedHistoryItems}
                      onToggleExpanded={handleToggleExpanded}
                    />
                  </div>
                ))}
              </div>
            ) : null}
            {liveTailHistory.length > 0 ? (
              <div className="space-y-3">
                {liveTailHistory.map((item) => (
                  <div key={item.id}>
                    {renderHistoryItem(item, {
                      ...(item.itemStatus === 'sending' ? { status: 'sending', pulse: true } : {}),
                      expandedItems: expandedHistoryItems,
                      onToggleExpanded: handleToggleExpanded,
                    })}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="border-t border-slate-200 px-4 py-3 dark:border-[#30363d]">
        {(error || runtime?.lastError) ? (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="whitespace-pre-wrap break-words">{error || runtime?.lastError}</span>
          </div>
        ) : null}
        {pendingMessages.length > 0 ? (
          <div className="mb-3 space-y-2">
            {pendingMessages.map((item, index) => {
              const isSteerTarget = item.id === steerTargetId;
              return (
                <div
                  key={item.id}
                  className="flex items-start gap-3 rounded-xl border border-amber-200/80 bg-amber-50/80 px-3 py-2 text-sm text-amber-950 dark:border-amber-500/25 dark:bg-amber-500/10 dark:text-amber-100"
                >
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-700/80 dark:text-amber-200/80">
                      {index === 0 ? 'Next in Queue' : `Queued ${index + 1}`}
                    </div>
                    <div className="whitespace-pre-wrap break-words">{item.displayText}</div>
                    {item.attachmentPaths.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {item.attachmentPaths.map((attachmentPath) => (
                          <span
                            key={`${item.id}-${attachmentPath}`}
                            className="inline-flex items-center gap-1 rounded-full border border-amber-300/80 bg-white/80 px-2 py-0.5 text-[10px] dark:border-amber-400/30 dark:bg-amber-950/30"
                            title={attachmentPath}
                          >
                            <Paperclip className="h-3 w-3" />
                            <span className="max-w-40 truncate">{getBaseName(attachmentPath)}</span>
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    className="shrink-0 rounded-lg border border-amber-300 bg-white px-2.5 py-1 text-[11px] font-semibold text-amber-700 transition hover:bg-amber-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-amber-400/30 dark:bg-amber-950/30 dark:text-amber-100 dark:hover:bg-amber-950/50"
                    onClick={() => void handleSteerMessage(item.id)}
                    disabled={isSending || isCancelling || isSteerTarget}
                  >
                    {isSteerTarget ? 'Steering' : 'Steer'}
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
        <div className="relative rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-[#30363d] dark:bg-[#0d1117]">
          {pendingAttachmentPaths.length > 0 ? (
            <div className="mb-3 flex flex-wrap gap-2">
              {pendingAttachmentPaths.map((attachmentPath) => (
                <span
                  key={attachmentPath}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-slate-300 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-700 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
                  title={attachmentPath}
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  <span className="max-w-52 truncate">{getBaseName(attachmentPath)}</span>
                  <button
                    type="button"
                    className="rounded text-slate-500 transition hover:text-red-500 dark:text-slate-400 dark:hover:text-red-300"
                    onClick={() => removePendingAttachment(attachmentPath)}
                    title="Remove attachment"
                    aria-label={`Remove ${getBaseName(attachmentPath)}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            ref={textareaRef}
            className="max-h-28 min-h-20 w-full resize-y border-none bg-transparent font-mono text-sm leading-relaxed text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500"
            style={{ height: COMPOSER_MAX_HEIGHT / 1.4 }}
            placeholder={isTurnActive
              ? 'Queue a follow-up message, or add steering instructions...'
              : 'Send a follow-up task or ask the agent to continue...'}
            value={composerValue}
            onChange={(event) => {
              const nextValue = event.target.value;
              const nextCursorPosition = event.target.selectionStart;
              void handleComposerChange(nextValue, nextCursorPosition);
            }}
            onClick={(event) => {
              setCursorPosition(event.currentTarget.selectionStart);
              setShowSuggestions(false);
            }}
            onKeyUp={(event) => {
              setCursorPosition(event.currentTarget.selectionStart);
            }}
            onPaste={(event) => {
              void handleComposerPaste(event);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                if (showSuggestions && suggestionList.length > 0) {
                  if (event.shiftKey) {
                    event.preventDefault();
                    setShowSuggestions(false);
                    const textarea = event.currentTarget;
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    const val = composerValue;
                    const newVal = val.slice(0, start) + '\n' + val.slice(end);
                    void handleComposerChange(newVal, start + 1);
                    return;
                  }
                  event.preventDefault();
                  handleSelectSuggestion(suggestionList[selectedSuggestionIndex]);
                  return;
                }
                if (!event.shiftKey) {
                  event.preventDefault();
                  void handleSubmit();
                  return;
                }
                return;
              }

              if (showSuggestions && suggestionList.length > 0) {
                if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setSelectedSuggestionIndex((previous) => (
                    previous > 0 ? previous - 1 : suggestionList.length - 1
                  ));
                  return;
                }
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setSelectedSuggestionIndex((previous) => (
                    previous < suggestionList.length - 1 ? previous + 1 : 0
                  ));
                  return;
                }
                if (event.key === 'Tab') {
                  event.preventDefault();
                  handleSelectSuggestion(suggestionList[selectedSuggestionIndex]);
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setShowSuggestions(false);
                  return;
                }
              }
            }}
          />
          {showSuggestions && suggestionList.length > 0 ? (
            <div className="absolute bottom-20 left-6 right-6 z-20 max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg dark:border-[#30363d] dark:bg-[#161b22]">
              {suggestionList.map((suggestion, index) => (
                <button
                  key={suggestion}
                  type="button"
                  className={`w-full truncate border-b border-slate-100 px-3 py-2 text-left text-xs last:border-0 ${
                    index === selectedSuggestionIndex
                      ? 'bg-primary text-white'
                      : 'text-slate-700 hover:bg-slate-50 dark:border-slate-700/60 dark:text-slate-300 dark:hover:bg-slate-800/60'
                  }`}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    handleSelectSuggestion(suggestion);
                  }}
                >
                  {suggestion}
                </button>
              ))}
            </div>
          ) : null}
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
              {isPastingAttachments ? (
                <span className="inline-flex items-center gap-1">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Saving pasted image...
                </span>
              ) : isTurnActive ? (
                <span className="inline-flex items-center gap-1">
                  <PlayCircle className="h-3.5 w-3.5" />
                  Turn in progress
                </span>
              ) : (
                <span>Paste images with Cmd/Ctrl+V · Press Enter to send, Shift+Enter for new line</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => void handleSubmit()}
                disabled={!canSend}
              >
                {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {isTurnActive ? 'Queue' : 'Send'}
              </button>
              {(isTurnActive || isCancelling) ? (
                <button
                  type="button"
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-[#161b22] dark:text-slate-200 dark:hover:bg-[#1f2937]"
                  onClick={() => void handleCancel()}
                  disabled={isCancelling}
                >
                  {isCancelling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Square className="h-4 w-4" />}
                  Stop
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

export default AgentSessionPane;
