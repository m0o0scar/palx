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
import { AlertCircle, Clock3, Loader2, PlayCircle, Send, Square } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
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
};

type AgentSessionPaneProps = {
  sessionId: string;
  workspacePath: string;
  onFeedback?: (message: string) => void;
};

type PendingMessage = {
  id: string;
  text: string;
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

function codeBlock(value: string | null | undefined) {
  const text = trimEmpty(value);
  if (!text) return null;
  return (
    <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-slate-950/95 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-100 dark:bg-black">
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

function MarkdownMessage({ value }: { value: string | null | undefined }) {
  const text = trimEmpty(value);
  if (!text) return null;

  return (
    <div className="markdown-message overflow-x-auto text-sm leading-7">
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
            <div className="mb-3 overflow-x-auto last:mb-0">
              <table className="min-w-full border-collapse text-left text-xs">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="border-b border-slate-300 dark:border-slate-600">{children}</thead>,
          th: ({ children }) => <th className="px-3 py-2 font-semibold">{children}</th>,
          td: ({ children }) => <td className="border-b border-slate-200 px-3 py-2 align-top dark:border-slate-700">{children}</td>,
          hr: () => <hr className="my-4 border-slate-300 dark:border-slate-600" />,
          code: ({ className, children }) => {
            const textContent = String(children).replace(/\n$/, '');
            const isBlock = Boolean(className) || textContent.includes('\n');

            if (isBlock) {
              return (
                <code className="block overflow-x-auto whitespace-pre rounded-lg bg-slate-950/95 px-3 py-2 font-mono text-[11px] leading-relaxed text-slate-100 dark:bg-black">
                  {textContent}
                </code>
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
  label: string;
  title?: string;
  className: string;
  summaryClassName: string;
  labelClassName: string;
  titleClassName: string;
  timestamp?: string;
  timestampClassName: string;
  children: React.ReactNode;
};

function renderCollapsibleHistoryItem({
  label,
  title,
  className,
  summaryClassName,
  labelClassName,
  titleClassName,
  timestamp,
  timestampClassName,
  children,
}: CollapsibleHistoryItemProps) {
  const summaryTitle = title ? `${label}: ${title}` : label;

  return (
    <details className={className}>
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

function renderHistoryItem(item: SessionAgentHistoryItem) {
  const timestamp = formatTimestamp(item.updatedAt || item.createdAt);

  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-blue-100 px-4 py-3 text-sm text-blue-950 shadow-sm dark:bg-blue-500/15 dark:text-blue-50">
            <div className="whitespace-pre-wrap break-words">{item.text}</div>
            {timestamp ? <div className="mt-2 text-[10px] text-blue-700/80 dark:text-blue-100/70">{timestamp}</div> : null}
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div className="px-1 py-1 text-sm text-slate-800 dark:text-slate-100">
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
        label: 'Reasoning',
        title: plainTextPreview(item.summary) || plainTextPreview(item.text) || undefined,
        className: 'rounded-xl border border-violet-200/80 bg-violet-50/45 px-3 py-2 text-sm text-violet-950 dark:border-violet-500/25 dark:bg-violet-500/8 dark:text-violet-100',
        summaryClassName: 'flex min-w-0 items-baseline gap-2 cursor-pointer list-none',
        labelClassName: 'shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-700 dark:text-violet-200',
        titleClassName: 'min-w-0 truncate whitespace-nowrap text-[11px] font-normal text-violet-700/75 dark:text-violet-200/75',
        timestamp,
        timestampClassName: 'mt-2 text-[10px] text-violet-700/65 dark:text-violet-200/65',
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
        <div className="rounded-2xl border border-sky-200 bg-sky-50/70 px-4 py-3 text-sm text-sky-900 shadow-sm dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-200">Plan</div>
          <div className="whitespace-pre-wrap break-words">{item.text}</div>
          {timestamp ? <div className="mt-3 text-[10px] text-sky-700/70 dark:text-sky-200/70">{timestamp}</div> : null}
        </div>
      );
    case 'command':
      return renderCollapsibleHistoryItem({
        label: 'Command',
        title: firstLinePreview(item.command) || undefined,
        className: 'rounded-xl border border-slate-200/80 bg-slate-50/65 px-3 py-2 text-sm dark:border-[#30363d] dark:bg-[#0d1117]/75',
        summaryClassName: 'flex min-w-0 items-baseline gap-2 cursor-pointer list-none',
        labelClassName: 'shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-300',
        titleClassName: 'min-w-0 truncate whitespace-nowrap font-mono text-[11px] font-normal text-slate-500 dark:text-slate-400',
        timestamp,
        timestampClassName: 'mt-2 text-[10px] text-slate-400 dark:text-slate-500',
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
    case 'tool':
      return renderCollapsibleHistoryItem({
        label: `Tool: ${item.tool}`,
        title: firstLinePreview(item.message) || firstLinePreview(item.input) || firstLinePreview(item.result) || undefined,
        className: 'rounded-xl border border-slate-200/80 bg-slate-50/65 px-3 py-2 text-sm dark:border-[#30363d] dark:bg-[#0d1117]/75',
        summaryClassName: 'flex min-w-0 items-baseline gap-2 cursor-pointer list-none',
        labelClassName: 'shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-600 dark:text-slate-300',
        titleClassName: 'min-w-0 truncate whitespace-nowrap text-[11px] font-normal text-slate-500 dark:text-slate-400',
        timestamp,
        timestampClassName: 'mt-2 text-[10px] text-slate-400 dark:text-slate-500',
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
    case 'fileChange':
      return renderCollapsibleHistoryItem({
        label: 'File Changes',
        title: item.changes[0]?.path?.trim()
          ? (item.changes.length > 1
            ? `${item.changes[0].path.trim()} +${item.changes.length - 1} more`
            : item.changes[0].path.trim())
          : (item.changes.length > 0 ? `${item.changes.length} files` : undefined),
        className: 'rounded-xl border border-emerald-200/80 bg-emerald-50/50 px-3 py-2 text-sm text-emerald-950 dark:border-emerald-500/25 dark:bg-emerald-500/8 dark:text-emerald-100',
        summaryClassName: 'flex min-w-0 items-baseline gap-2 cursor-pointer list-none',
        labelClassName: 'shrink-0 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-200',
        titleClassName: 'min-w-0 truncate whitespace-nowrap text-[11px] font-normal text-emerald-700/75 dark:text-emerald-200/75',
        timestamp,
        timestampClassName: 'mt-2 text-[10px] text-emerald-700/65 dark:text-emerald-200/65',
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

function createPendingMessage(text: string): PendingMessage {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
  };
}

type VirtualHistoryRowProps = {
  item: SessionAgentHistoryItem;
  onMeasure: (key: string, height: number) => void;
};

function VirtualHistoryRow({ item, onMeasure }: VirtualHistoryRowProps) {
  const itemKey = `${item.id}-${item.updatedAt}`;
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
    <div ref={rowRef}>
      {renderHistoryItem(item)}
    </div>
  );
}

const AgentSessionPane = forwardRef<AgentSessionPaneHandle, AgentSessionPaneProps>(function AgentSessionPane(
  { sessionId, workspacePath, onFeedback },
  ref,
) {
  const [runtime, setRuntime] = useState<SessionAgentRuntimeState | null>(null);
  const [history, setHistory] = useState<SessionAgentHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [composerValue, setComposerValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const [steerTargetId, setSteerTargetId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const pendingSelectionRef = useRef<number | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const refreshTimerRef = useRef<number | null>(null);
  const historySizeMapRef = useRef<Record<string, number>>({});
  const [historySizeVersion, setHistorySizeVersion] = useState(0);
  const [timelineScrollTop, setTimelineScrollTop] = useState(0);
  const [timelineViewportHeight, setTimelineViewportHeight] = useState(0);

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
  }), [onFeedback]);

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
  }, [history, historySizeVersion, loading]);

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
            scheduleRefresh();
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

  const activeRunState = runtime?.runState ?? 'idle';
  const isTurnActive = activeRunState === 'queued' || activeRunState === 'running';
  const canSend = !loading && !isSending && composerValue.trim().length > 0;
  const liveHistoryTailCount = useMemo(
    () => Math.min(history.length, isTurnActive ? STREAMING_HISTORY_TAIL_COUNT : Math.min(2, history.length)),
    [history.length, isTurnActive],
  );
  const virtualizedHistory = useMemo(
    () => history.slice(0, Math.max(0, history.length - liveHistoryTailCount)),
    [history, liveHistoryTailCount],
  );
  const liveTailHistory = useMemo(
    () => history.slice(Math.max(0, history.length - liveHistoryTailCount)),
    [history, liveHistoryTailCount],
  );
  const historyMetrics = useMemo(() => {
    void historySizeVersion;
    const metrics: VirtualHistoryMetrics[] = [];
    let offset = 0;

    virtualizedHistory.forEach((item, index) => {
      const itemKey = `${item.id}-${item.updatedAt}`;
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
          itemKey: `${item.id}-${item.updatedAt}`,
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
    const activeKeys = new Set(history.map((item) => `${item.id}-${item.updatedAt}`));
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
  }, [history]);

  const providerName = providerLabel(runtime?.agentProvider || null);
  const runtimeDetails = useMemo(() => {
    if (!runtime) return [];

    const details: string[] = [];
    if (runtime.model) {
      details.push(runtime.model);
    }
    if (runtime.reasoningEffort) {
      details.push(`reasoning: ${runtime.reasoningEffort}`);
    }
    if (runtime.threadId) {
      details.push(`thread ${runtime.threadId}`);
    }
    return details;
  }, [runtime]);

  const submitMessageToAgent = useCallback(async (message: string) => {
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

  const handleSubmit = useCallback(async () => {
    const message = composerValue.trim();
    if (!message || isSending) return;

    setComposerValue('');

    if (isTurnActive) {
      setPendingMessages((current) => [...current, createPendingMessage(message)]);
      onFeedback?.('Queued message for the next turn');
      return;
    }

    setIsSending(true);
    const result = await submitMessageToAgent(message);
    if (result.success) {
      onFeedback?.('Sent message to agent');
    }
    setIsSending(false);
  }, [composerValue, isSending, isTurnActive, onFeedback, submitMessageToAgent]);

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
    const result = await submitMessageToAgent(nextMessage.text);
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
      <div className="border-b border-slate-200 px-4 py-2.5 dark:border-[#30363d]">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{providerName}</span>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${runStateTone(activeRunState)}`}>
                {formatRunState(activeRunState)}
              </span>
              <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                socketConnected
                  ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-200'
                  : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
              }`}>
                <Clock3 className="h-3 w-3" />
                {socketConnected ? 'live' : 'offline'}
              </span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
              {runtimeDetails.map((detail) => (
                <span key={detail}>{detail}</span>
              ))}
              <span className="max-w-full truncate" title={workspacePath}>cwd: {workspacePath}</span>
            </div>
          </div>
          {(isTurnActive || isCancelling) ? (
            <button
              type="button"
              className="inline-flex h-8 shrink-0 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-200 dark:hover:bg-[#161b22]"
              onClick={() => void handleCancel()}
              disabled={isCancelling}
            >
              {isCancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
              Cancel
            </button>
          ) : null}
        </div>
        {runtime?.lastError ? (
          <div className="mt-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="whitespace-pre-wrap break-words">{runtime.lastError}</span>
          </div>
        ) : null}
      </div>

      <div
        ref={timelineRef}
        className="custom-scrollbar flex-1 overflow-y-auto px-4 py-4"
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
        ) : history.length === 0 ? (
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
                    <VirtualHistoryRow item={item} onMeasure={handleMeasureHistoryItem} />
                  </div>
                ))}
              </div>
            ) : null}
            {liveTailHistory.length > 0 ? (
              <div className="space-y-3">
                {liveTailHistory.map((item) => (
                  <div key={`${item.id}-${item.updatedAt}`}>
                    {renderHistoryItem(item)}
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>

      <div className="border-t border-slate-200 px-4 py-3 dark:border-[#30363d]">
        {error ? (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="whitespace-pre-wrap break-words">{error}</span>
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
                    <div className="whitespace-pre-wrap break-words">{item.text}</div>
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
        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-[#30363d] dark:bg-[#0d1117]">
          <textarea
            ref={textareaRef}
            className="max-h-28 min-h-20 w-full resize-y border-none bg-transparent font-mono text-sm leading-relaxed text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500"
            style={{ height: COMPOSER_MAX_HEIGHT / 1.4 }}
            placeholder={isTurnActive
              ? 'Queue a follow-up message, or add steering instructions...'
              : 'Send a follow-up task or ask the agent to continue...'}
            value={composerValue}
            onChange={(event) => setComposerValue(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void handleSubmit();
              }
            }}
          />
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
              {isTurnActive ? (
                <span className="inline-flex items-center gap-1">
                  <PlayCircle className="h-3.5 w-3.5" />
                  Turn in progress
                </span>
              ) : (
                <span>Press Ctrl+Enter to send</span>
              )}
            </div>
            <button
              type="button"
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
              onClick={() => void handleSubmit()}
              disabled={!canSend}
            >
              {isSending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {isTurnActive ? 'Queue' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

export default AgentSessionPane;
