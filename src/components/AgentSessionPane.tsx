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

const PROVIDER_LABELS: Record<string, string> = {
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  cursor: 'Cursor Agent CLI',
};

function providerLabel(provider: string | null | undefined) {
  if (!provider) return 'Agent';
  return PROVIDER_LABELS[provider] || provider;
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

function renderHistoryItem(item: SessionAgentHistoryItem) {
  const timestamp = formatTimestamp(item.updatedAt || item.createdAt);

  switch (item.kind) {
    case 'user':
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-blue-600 px-4 py-3 text-sm text-white shadow-sm">
            <div className="whitespace-pre-wrap break-words">{item.text}</div>
            {timestamp ? <div className="mt-2 text-[10px] text-blue-100/80">{timestamp}</div> : null}
          </div>
        </div>
      );
    case 'assistant':
      return (
        <div className="rounded-2xl rounded-bl-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-800 shadow-sm dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-100">
          {item.phase ? (
            <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              {item.phase}
            </div>
          ) : null}
          <div className="whitespace-pre-wrap break-words">{item.text || ' '}</div>
          {timestamp ? <div className="mt-2 text-[10px] text-slate-400 dark:text-slate-500">{timestamp}</div> : null}
        </div>
      );
    case 'reasoning':
      return (
        <details className="rounded-2xl border border-violet-200 bg-violet-50/60 px-4 py-3 text-sm text-violet-950 shadow-sm dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-100">
          <summary className="cursor-pointer list-none text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-200">
            Reasoning
          </summary>
          {trimEmpty(item.summary) ? (
            <div className="mt-3 whitespace-pre-wrap break-words text-sm font-medium">{item.summary}</div>
          ) : null}
          {trimEmpty(item.text) ? (
            <div className="mt-2 whitespace-pre-wrap break-words text-sm opacity-90">{item.text}</div>
          ) : null}
          {timestamp ? <div className="mt-3 text-[10px] text-violet-700/70 dark:text-violet-200/70">{timestamp}</div> : null}
        </details>
      );
    case 'plan':
      return (
        <div className="rounded-2xl border border-sky-200 bg-sky-50/70 px-4 py-3 text-sm text-sky-900 shadow-sm dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-sky-700 dark:text-sky-200">Plan</div>
          <div className="whitespace-pre-wrap break-words">{item.text}</div>
          {timestamp ? <div className="mt-3 text-[10px] text-sky-700/70 dark:text-sky-200/70">{timestamp}</div> : null}
        </div>
      );
    case 'command':
      return (
        <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm dark:border-[#30363d] dark:bg-[#0d1117]">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-slate-700 dark:bg-slate-800 dark:text-slate-200">
              Command
            </span>
            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${runStateTone(item.status)}`}>
              {formatRunState(item.status)}
            </span>
            {item.exitCode !== null ? (
              <span className="text-[10px] text-slate-500 dark:text-slate-400">exit {item.exitCode}</span>
            ) : null}
          </div>
          <div className="mt-3 space-y-2">
            <div className="rounded-lg bg-slate-100 px-3 py-2 font-mono text-[11px] text-slate-800 dark:bg-slate-900 dark:text-slate-100">
              {item.command}
            </div>
            <div className="text-[11px] text-slate-500 dark:text-slate-400">cwd: {item.cwd || '.'}</div>
            {codeBlock(item.output)}
          </div>
          {timestamp ? <div className="mt-3 text-[10px] text-slate-400 dark:text-slate-500">{timestamp}</div> : null}
        </div>
      );
    case 'tool':
      return (
        <details className="rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm dark:border-[#30363d] dark:bg-[#0d1117]">
          <summary className="cursor-pointer list-none">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                Tool
              </span>
              <span className="font-medium text-slate-800 dark:text-slate-100">{item.tool}</span>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${runStateTone(item.status)}`}>
                {formatRunState(item.status)}
              </span>
            </div>
          </summary>
          <div className="mt-3 space-y-3">
            <div className="grid gap-2 text-[11px] text-slate-500 dark:text-slate-400 sm:grid-cols-2">
              <div>source: {item.source}</div>
              <div>{item.server ? `server: ${item.server}` : 'server: n/a'}</div>
            </div>
            {trimEmpty(item.message) ? <div className="whitespace-pre-wrap break-words">{item.message}</div> : null}
            {item.input ? <div><div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Input</div>{codeBlock(item.input)}</div> : null}
            {item.result ? <div><div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Result</div>{codeBlock(item.result)}</div> : null}
            {item.error ? <div><div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-red-500 dark:text-red-300">Error</div>{codeBlock(item.error)}</div> : null}
          </div>
          {timestamp ? <div className="mt-3 text-[10px] text-slate-400 dark:text-slate-500">{timestamp}</div> : null}
        </details>
      );
    case 'fileChange':
      return (
        <details className="rounded-2xl border border-emerald-200 bg-emerald-50/70 px-4 py-3 text-sm text-emerald-950 shadow-sm dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-100">
          <summary className="cursor-pointer list-none">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-white/80 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-200">
                File Changes
              </span>
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${runStateTone(item.status)}`}>
                {formatRunState(item.status)}
              </span>
              <span className="text-[11px] opacity-80">
                {item.changes.length} file{item.changes.length === 1 ? '' : 's'}
              </span>
            </div>
          </summary>
          <div className="mt-3 space-y-3">
            {item.changes.length > 0 ? (
              <div className="space-y-2">
                {item.changes.map((change) => (
                  <div key={`${item.id}-${change.path}`} className="rounded-lg border border-emerald-200/80 bg-white/80 px-3 py-2 text-[11px] dark:border-emerald-500/20 dark:bg-emerald-950/20">
                    <div className="font-mono">{change.path}</div>
                    <div className="mt-1 uppercase tracking-wide opacity-70">{change.kind}</div>
                    {codeBlock(change.diff)}
                  </div>
                ))}
              </div>
            ) : null}
            {trimEmpty(item.output) ? codeBlock(item.output) : null}
          </div>
          {timestamp ? <div className="mt-3 text-[10px] text-emerald-700/70 dark:text-emerald-200/70">{timestamp}</div> : null}
        </details>
      );
    default:
      return null;
  }
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const pendingSelectionRef = useRef<number | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const refreshTimerRef = useRef<number | null>(null);

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
  }, [history, loading]);

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
  const canSend = !loading && !isSending && !isTurnActive && composerValue.trim().length > 0;

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

  const handleSubmit = useCallback(async () => {
    const message = composerValue.trim();
    if (!message || isTurnActive || isSending) return;

    setIsSending(true);
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

      setComposerValue('');
      onFeedback?.('Sent message to agent');
      shouldStickToBottomRef.current = true;
      scheduleRefresh(0);
    } catch (submitError) {
      const messageText = submitError instanceof Error ? submitError.message : 'Failed to send message.';
      setError(messageText);
      onFeedback?.(messageText);
    } finally {
      setIsSending(false);
    }
  }, [composerValue, isSending, isTurnActive, onFeedback, scheduleRefresh, sessionId]);

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

  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent">
      <div className="border-b border-slate-200 px-4 py-3 dark:border-[#30363d]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
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
            <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-slate-500 dark:text-slate-400">
              {runtimeDetails.map((detail) => (
                <span key={detail}>{detail}</span>
              ))}
              <span className="truncate" title={workspacePath}>cwd: {workspacePath}</span>
            </div>
          </div>
          <button
            type="button"
            className="inline-flex h-8 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-200 dark:hover:bg-[#161b22]"
            onClick={() => void handleCancel()}
            disabled={!isTurnActive || isCancelling}
          >
            {isCancelling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
            Cancel
          </button>
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
        className="custom-scrollbar flex-1 space-y-3 overflow-y-auto px-4 py-4"
        onScroll={(event) => {
          const target = event.currentTarget;
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
          history.map((item) => (
            <div key={`${item.id}-${item.updatedAt}`}>
              {renderHistoryItem(item)}
            </div>
          ))
        )}
      </div>

      <div className="border-t border-slate-200 px-4 py-3 dark:border-[#30363d]">
        {error ? (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="whitespace-pre-wrap break-words">{error}</span>
          </div>
        ) : null}
        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-[#30363d] dark:bg-[#0d1117]">
          <textarea
            ref={textareaRef}
            className="h-28 w-full resize-none border-none bg-transparent font-mono text-sm leading-relaxed text-slate-900 outline-none placeholder:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500"
            placeholder="Send a follow-up task or ask the agent to continue..."
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
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

export default AgentSessionPane;
