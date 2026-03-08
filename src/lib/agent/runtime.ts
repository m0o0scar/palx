import { randomUUID } from 'node:crypto';

import { normalizeText, stringifyCompact } from '@/lib/agent/common';
import { normalizeProviderReasoningEffort } from '@/lib/agent/reasoning';
import { getAgentAdapter } from '@/lib/agent/providers';
import type {
  AgentChatInput,
  AgentProvider,
  AgentSessionView,
  AgentSocketMessage,
  ChatStreamEvent,
  FileChange,
  HistoryEntry,
  ReasoningEffort,
  RuntimeSessionSnapshot,
} from '@/lib/agent/types';

const MAX_SESSION_EVENTS = 1000;

type AgentSessionRecord = {
  snapshot: RuntimeSessionSnapshot;
  historyById: Map<string, HistoryEntry>;
  historyOrder: string[];
  historyHydrated: boolean;
  subscribers: Set<(message: AgentSocketMessage) => void>;
  activeRun:
    | {
        abortController: AbortController;
        promise: Promise<void>;
      }
    | null;
};

export type AgentSessionRegistration = {
  sessionId: string;
  provider: AgentProvider;
  workspacePath: string;
  threadId?: string | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
  history?: HistoryEntry[];
  runState?: RuntimeSessionSnapshot['runState'];
  lastError?: string | null;
  lastActivityAt?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  events?: ChatStreamEvent[];
};

export type StartAgentSessionTurnInput = AgentSessionRegistration & {
  message: string;
};

declare global {
  var __palxAgentRuntimeSessions: Map<string, AgentSessionRecord> | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function globalRecords() {
  if (!globalThis.__palxAgentRuntimeSessions) {
    globalThis.__palxAgentRuntimeSessions = new Map();
  }

  return globalThis.__palxAgentRuntimeSessions;
}

function defaultSnapshot(input: {
  sessionId: string;
  provider: AgentProvider;
  workspacePath: string;
  threadId?: string | null;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
}): RuntimeSessionSnapshot {
  const reasoningEffort = normalizeProviderReasoningEffort(
    input.provider,
    input.reasoningEffort,
  );
  return {
    sessionId: input.sessionId,
    provider: input.provider,
    workspacePath: input.workspacePath,
    threadId: input.threadId ?? null,
    model: input.model ?? null,
    reasoningEffort: reasoningEffort ?? null,
    runState: 'idle',
    lastError: null,
    lastActivityAt: null,
    startedAt: null,
    completedAt: null,
    events: [],
  };
}

function toView(record: AgentSessionRecord): AgentSessionView {
  return {
    snapshot: {
      ...record.snapshot,
      events: [...record.snapshot.events],
    },
    history: record.historyOrder
      .map((id) => record.historyById.get(id))
      .filter((entry): entry is HistoryEntry => Boolean(entry)),
  };
}

function ensureOrder(record: AgentSessionRecord, id: string) {
  if (!record.historyById.has(id)) {
    record.historyOrder.push(id);
  }
}

function replaceHistory(record: AgentSessionRecord, entries: HistoryEntry[]) {
  record.historyById.clear();
  record.historyOrder.length = 0;

  for (const entry of entries) {
    ensureOrder(record, entry.id);
    record.historyById.set(entry.id, entry);
  }

  record.historyHydrated = true;
}

function appendEvent(snapshot: RuntimeSessionSnapshot, event: ChatStreamEvent) {
  snapshot.events = [...snapshot.events, event].slice(-MAX_SESSION_EVENTS);
}

function normalizeStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item === 'string') {
      return [item];
    }

    if (isRecord(item) && typeof item.text === 'string') {
      return [item.text];
    }

    return [];
  });
}

function normalizeFileChanges(value: unknown): FileChange[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((change) => {
      if (!isRecord(change)) {
        return null;
      }

      const filePath = normalizeText(change.path);
      if (!filePath) {
        return null;
      }

      return {
        path: filePath,
        kind: normalizeText(change.kind) || 'modify',
        diff: normalizeText(change.diff),
      } satisfies FileChange;
    })
    .filter((change): change is FileChange => Boolean(change));
}

function normalizeHistoryEntryFromItem(item: Record<string, unknown>): HistoryEntry | null {
  const itemType = normalizeText(item.type);
  const id = normalizeText(item.id);
  if (!itemType || !id) {
    return null;
  }

  switch (itemType) {
    case 'userMessage': {
      const text = Array.isArray(item.content)
        ? item.content
            .map((content) => (isRecord(content) && content.type === 'text' ? normalizeText(content.text) : ''))
            .filter(Boolean)
            .join('\n')
        : '';

      return {
        kind: 'user',
        id,
        text,
      };
    }
    case 'agentMessage':
      return {
        kind: 'assistant',
        id,
        text: normalizeText(item.text),
        phase: normalizeText(item.phase) || null,
      };
    case 'reasoning':
      return {
        kind: 'reasoning',
        id,
        summary: normalizeStringArray(item.summary).join('\n'),
        text: normalizeStringArray(item.content).join('\n'),
      };
    case 'commandExecution':
      return {
        kind: 'command',
        id,
        command: normalizeText(item.command),
        cwd: normalizeText(item.cwd),
        output: normalizeText(item.aggregatedOutput),
        status: normalizeText(item.status),
        exitCode: typeof item.exitCode === 'number' ? item.exitCode : null,
        toolName: normalizeText(item.toolName) || null,
        toolInput: typeof item.toolInput === 'string' ? item.toolInput : null,
      };
    case 'fileChange':
      return {
        kind: 'fileChange',
        id,
        status: normalizeText(item.status),
        output: normalizeText(item.output),
        changes: normalizeFileChanges(item.changes),
      };
    case 'mcpToolCall':
      return {
        kind: 'tool',
        id,
        source: 'mcp',
        server: normalizeText(item.server) || null,
        tool: normalizeText(item.tool),
        status: normalizeText(item.status),
        input: stringifyCompact(item.arguments),
        message: null,
        result: stringifyCompact(item.result),
        error: stringifyCompact(item.error),
      };
    case 'dynamicToolCall':
      return {
        kind: 'tool',
        id,
        source: 'dynamic',
        server: null,
        tool: normalizeText(item.tool),
        status: normalizeText(item.status),
        input: stringifyCompact(item.arguments),
        message: null,
        result: stringifyCompact(item.contentItems),
        error:
          item.success === false && item.contentItems == null ? 'Tool call failed.' : null,
      };
    case 'webSearch':
      return {
        kind: 'tool',
        id,
        source: 'web_search',
        server: null,
        tool: 'web_search',
        status: 'completed',
        input: normalizeText(item.query),
        message: stringifyCompact(item.action),
        result: null,
        error: null,
      };
    case 'plan':
      return {
        kind: 'plan',
        id,
        text: normalizeText(item.text),
      };
    default:
      return null;
  }
}

function mergeHistoryEntry(existing: HistoryEntry | undefined, next: HistoryEntry): HistoryEntry {
  if (!existing || existing.kind !== next.kind) {
    return next;
  }

  switch (next.kind) {
    case 'user': {
      const previous = existing as Extract<HistoryEntry, { kind: 'user' }>;
      return {
        ...next,
        text: next.text || previous.text,
      };
    }
    case 'assistant': {
      const previous = existing as Extract<HistoryEntry, { kind: 'assistant' }>;
      return {
        ...next,
        text: next.text || previous.text,
        phase: next.phase ?? previous.phase,
      };
    }
    case 'reasoning': {
      const previous = existing as Extract<HistoryEntry, { kind: 'reasoning' }>;
      return {
        ...next,
        summary: next.summary || previous.summary,
        text: next.text || previous.text,
      };
    }
    case 'command': {
      const previous = existing as Extract<HistoryEntry, { kind: 'command' }>;
      return {
        ...next,
        output: next.output || previous.output,
        status: next.status || previous.status,
        exitCode: next.exitCode ?? previous.exitCode,
        toolName: next.toolName ?? previous.toolName,
        toolInput: next.toolInput ?? previous.toolInput,
      };
    }
    case 'tool': {
      const previous = existing as Extract<HistoryEntry, { kind: 'tool' }>;
      return {
        ...next,
        source: next.source || previous.source,
        server: next.server ?? previous.server,
        status: next.status || previous.status,
        input: next.input ?? previous.input,
        message: next.message ?? previous.message,
        result: next.result ?? previous.result,
        error: next.error ?? previous.error,
      };
    }
    case 'fileChange': {
      const previous = existing as Extract<HistoryEntry, { kind: 'fileChange' }>;
      return {
        ...next,
        status: next.status || previous.status,
        output: next.output || previous.output,
        changes: next.changes.length > 0 ? next.changes : previous.changes,
      };
    }
    case 'plan': {
      const previous = existing as Extract<HistoryEntry, { kind: 'plan' }>;
      return {
        ...next,
        text: next.text || previous.text,
      };
    }
  }
}

function upsertHistoryEntry(record: AgentSessionRecord, entry: HistoryEntry) {
  const existing = record.historyById.get(entry.id);
  ensureOrder(record, entry.id);
  record.historyById.set(entry.id, mergeHistoryEntry(existing, entry));
}

function upsertUserMessage(record: AgentSessionRecord, text: string) {
  const entry: HistoryEntry = {
    kind: 'user',
    id: `user-${randomUUID()}`,
    text,
  };
  upsertHistoryEntry(record, entry);
}

function appendAssistantDelta(record: AgentSessionRecord, id: string, delta: string) {
  const existing = record.historyById.get(id);
  upsertHistoryEntry(record, {
    kind: 'assistant',
    id,
    text: existing && existing.kind === 'assistant' ? existing.text + delta : delta,
    phase: existing && existing.kind === 'assistant' ? existing.phase : null,
  });
}

function appendReasoningDelta(
  record: AgentSessionRecord,
  id: string,
  delta: string,
  field: 'summary' | 'text',
) {
  const existing = record.historyById.get(id);
  const previousSummary = existing && existing.kind === 'reasoning' ? existing.summary : '';
  const previousText = existing && existing.kind === 'reasoning' ? existing.text : '';
  upsertHistoryEntry(record, {
    kind: 'reasoning',
    id,
    summary: field === 'summary' ? previousSummary + delta : previousSummary,
    text: field === 'text' ? previousText + delta : previousText,
  });
}

function appendCommandSeed(
  record: AgentSessionRecord,
  event: Extract<ChatStreamEvent, { type: 'command_seed' }>,
) {
  const existing = record.historyById.get(event.itemId);
  upsertHistoryEntry(record, {
    kind: 'command',
    id: event.itemId,
    command: event.command,
    cwd: event.cwd,
    output: existing && existing.kind === 'command' ? existing.output : '',
    status: existing && existing.kind === 'command' ? existing.status : 'pending',
    exitCode: existing && existing.kind === 'command' ? existing.exitCode : null,
    toolName: event.toolName,
    toolInput: event.toolInput,
  });
}

function appendCommandOutput(
  record: AgentSessionRecord,
  event: Extract<ChatStreamEvent, { type: 'command_output_delta' }>,
) {
  const existing = record.historyById.get(event.itemId);
  upsertHistoryEntry(record, {
    kind: 'command',
    id: event.itemId,
    command: existing && existing.kind === 'command' ? existing.command : '',
    cwd: existing && existing.kind === 'command' ? existing.cwd : '',
    output: existing && existing.kind === 'command' ? existing.output + event.delta : event.delta,
    status: existing && existing.kind === 'command' ? existing.status : 'running',
    exitCode: existing && existing.kind === 'command' ? existing.exitCode : null,
    toolName: existing && existing.kind === 'command' ? existing.toolName : null,
    toolInput: existing && existing.kind === 'command' ? existing.toolInput : null,
  });
}

function appendFileChangeDelta(
  record: AgentSessionRecord,
  event: Extract<ChatStreamEvent, { type: 'file_change_delta' }>,
) {
  const existing = record.historyById.get(event.itemId);
  upsertHistoryEntry(record, {
    kind: 'fileChange',
    id: event.itemId,
    status: existing && existing.kind === 'fileChange' ? existing.status : 'running',
    output: existing && existing.kind === 'fileChange' ? existing.output + event.delta : event.delta,
    changes: existing && existing.kind === 'fileChange' ? existing.changes : [],
  });
}

function applyItemEvent(
  record: AgentSessionRecord,
  event: Extract<ChatStreamEvent, { type: 'item_started' | 'item_completed' }>,
) {
  const normalized = normalizeHistoryEntryFromItem(event.item);
  if (!normalized) {
    return;
  }

  upsertHistoryEntry(record, normalized);
}

function applyToolProgress(
  record: AgentSessionRecord,
  event: Extract<ChatStreamEvent, { type: 'tool_progress' }>,
) {
  upsertHistoryEntry(record, {
    kind: 'tool',
    id: event.itemId,
    source: event.source,
    server: event.server,
    tool: event.tool,
    status: event.status,
    input: event.input,
    message: event.message,
    result: event.result,
    error: event.error,
  });
}

function applyPlanUpdate(
  record: AgentSessionRecord,
  event: Extract<ChatStreamEvent, { type: 'plan_updated' }>,
) {
  upsertHistoryEntry(record, {
    kind: 'plan',
    id: `plan-${event.turnId}`,
    text: event.steps.map((step) => `${step.status.toUpperCase()} ${step.title}`).join('\n'),
  });
}

function applyEventToRecord(record: AgentSessionRecord, event: ChatStreamEvent) {
  appendEvent(record.snapshot, event);
  record.snapshot.lastActivityAt = new Date().toISOString();

  switch (event.type) {
    case 'thread_ready':
      record.snapshot.threadId = event.threadId;
      return;
    case 'turn_started':
      return;
    case 'item_started':
    case 'item_completed':
      applyItemEvent(record, event);
      return;
    case 'agent_message_delta':
      appendAssistantDelta(record, event.itemId, event.delta);
      return;
    case 'reasoning_delta':
      appendReasoningDelta(record, event.itemId, event.delta, 'text');
      return;
    case 'reasoning_summary_delta':
      appendReasoningDelta(record, event.itemId, event.delta, 'summary');
      return;
    case 'command_seed':
      appendCommandSeed(record, event);
      return;
    case 'command_output_delta':
      appendCommandOutput(record, event);
      return;
    case 'file_change_delta':
      appendFileChangeDelta(record, event);
      return;
    case 'plan_updated':
      applyPlanUpdate(record, event);
      return;
    case 'tool_progress':
      applyToolProgress(record, event);
      return;
    case 'turn_completed':
      if (record.snapshot.runState === 'cancelled') {
        record.snapshot.completedAt = new Date().toISOString();
        return;
      }

      if (event.error) {
        record.snapshot.runState = 'error';
        record.snapshot.lastError = event.error;
      } else if (/cancel/i.test(event.status)) {
        record.snapshot.runState = 'cancelled';
        record.snapshot.lastError = 'Request cancelled.';
      } else {
        record.snapshot.runState = 'completed';
        record.snapshot.lastError = null;
      }

      record.snapshot.completedAt = new Date().toISOString();
      return;
    case 'error':
      record.snapshot.runState = 'error';
      record.snapshot.lastError = event.message;
      record.snapshot.completedAt = new Date().toISOString();
      return;
  }
}

function emitSnapshot(record: AgentSessionRecord) {
  const message: AgentSocketMessage = {
    type: 'snapshot',
    session: toView(record),
  };

  for (const subscriber of record.subscribers) {
    subscriber(message);
  }
}

function emitEvent(record: AgentSessionRecord, event: ChatStreamEvent) {
  const message: AgentSocketMessage = {
    type: 'event',
    sessionId: record.snapshot.sessionId,
    snapshot: {
      ...record.snapshot,
      events: [...record.snapshot.events],
    },
    event,
  };

  for (const subscriber of record.subscribers) {
    subscriber(message);
  }
}

function requireSessionRecord(sessionId: string) {
  const record = globalRecords().get(sessionId);
  if (!record) {
    throw new Error(`Agent session ${sessionId} is not registered.`);
  }

  return record;
}

function updateSnapshotFromRegistration(record: AgentSessionRecord, input: AgentSessionRegistration) {
  record.snapshot.provider = input.provider;
  record.snapshot.workspacePath = input.workspacePath;

  if (input.threadId !== undefined) {
    record.snapshot.threadId = input.threadId ?? null;
  }

  if (input.model !== undefined) {
    record.snapshot.model = input.model ?? null;
  }

  if (input.reasoningEffort !== undefined) {
    record.snapshot.reasoningEffort = normalizeProviderReasoningEffort(
      record.snapshot.provider,
      input.reasoningEffort,
    ) ?? null;
  }

  if (input.runState) {
    record.snapshot.runState = input.runState;
  }

  if (input.lastError !== undefined) {
    record.snapshot.lastError = input.lastError ?? null;
  }

  if (input.lastActivityAt !== undefined) {
    record.snapshot.lastActivityAt = input.lastActivityAt ?? null;
  }

  if (input.startedAt !== undefined) {
    record.snapshot.startedAt = input.startedAt ?? null;
  }

  if (input.completedAt !== undefined) {
    record.snapshot.completedAt = input.completedAt ?? null;
  }

  if (input.events) {
    record.snapshot.events = [...input.events].slice(-MAX_SESSION_EVENTS);
  }
}

export function registerAgentSession(input: AgentSessionRegistration): AgentSessionView {
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    throw new Error('sessionId is required');
  }

  const records = globalRecords();
  const existing = records.get(sessionId);
  if (existing) {
    updateSnapshotFromRegistration(existing, input);
    if (input.history) {
      replaceHistory(existing, input.history);
    }
    emitSnapshot(existing);
    return toView(existing);
  }

  const record: AgentSessionRecord = {
    snapshot: defaultSnapshot(input),
    historyById: new Map(),
    historyOrder: [],
    historyHydrated: false,
    subscribers: new Set(),
    activeRun: null,
  };

  updateSnapshotFromRegistration(record, input);
  if (input.history) {
    replaceHistory(record, input.history);
  }

  records.set(sessionId, record);
  return toView(record);
}

export function getAgentSessionView(sessionId: string): AgentSessionView | null {
  const record = globalRecords().get(sessionId.trim());
  return record ? toView(record) : null;
}

export async function hydrateAgentSessionHistory(sessionId: string, options: { force?: boolean } = {}) {
  const record = requireSessionRecord(sessionId.trim());
  if (!record.snapshot.threadId) {
    return toView(record);
  }

  if (!options.force && (record.historyHydrated || record.activeRun)) {
    return toView(record);
  }

  const adapter = getAgentAdapter(record.snapshot.provider);
  const history = await adapter.readThreadHistory({
    threadId: record.snapshot.threadId,
    workspacePath: record.snapshot.workspacePath,
    model: record.snapshot.model,
    reasoningEffort: record.snapshot.reasoningEffort,
  });

  replaceHistory(record, history.entries);
  record.snapshot.threadId = history.threadId;
  record.snapshot.lastActivityAt = new Date().toISOString();
  emitSnapshot(record);
  return toView(record);
}

export function subscribeToAgentSession(
  sessionId: string,
  subscriber: (message: AgentSocketMessage) => void,
) {
  const record = requireSessionRecord(sessionId.trim());
  record.subscribers.add(subscriber);
  subscriber({
    type: 'snapshot',
    session: toView(record),
  });

  return () => {
    record.subscribers.delete(subscriber);
  };
}

export async function startAgentSessionTurn(input: StartAgentSessionTurnInput) {
  const message = input.message.trim();
  if (!message) {
    throw new Error('message is required');
  }

  const view = registerAgentSession(input);
  const record = requireSessionRecord(view.snapshot.sessionId);

  if (record.activeRun) {
    throw new Error(`Agent session ${view.snapshot.sessionId} already has an active turn.`);
  }

  upsertUserMessage(record, message);
  record.historyHydrated = true;
  record.snapshot.runState = 'running';
  record.snapshot.lastError = null;
  record.snapshot.startedAt = new Date().toISOString();
  record.snapshot.completedAt = null;
  record.snapshot.lastActivityAt = record.snapshot.startedAt;
  emitSnapshot(record);

  const abortController = new AbortController();
  const adapter = getAgentAdapter(record.snapshot.provider);
  const chatInput: AgentChatInput = {
    workspacePath: record.snapshot.workspacePath,
    threadId: record.snapshot.threadId,
    message,
    model: record.snapshot.model,
    reasoningEffort: record.snapshot.reasoningEffort,
  };

  const runPromise = (async () => {
    try {
      await adapter.streamChat(
        chatInput,
        (event) => {
          applyEventToRecord(record, event);
          emitEvent(record, event);
        },
        abortController.signal,
      );

      if (record.snapshot.runState === 'running') {
        record.snapshot.runState = 'completed';
        record.snapshot.completedAt = new Date().toISOString();
        record.snapshot.lastError = null;
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        record.snapshot.runState = 'cancelled';
        record.snapshot.lastError = 'Request cancelled.';
      } else {
        const message = error instanceof Error ? error.message : 'Agent run failed.';
        record.snapshot.runState = 'error';
        record.snapshot.lastError = message;
        const event: ChatStreamEvent = {
          type: 'error',
          message,
        };
        appendEvent(record.snapshot, event);
        emitEvent(record, event);
      }

      record.snapshot.completedAt = new Date().toISOString();
      record.snapshot.lastActivityAt = record.snapshot.completedAt;
      emitSnapshot(record);
      if (!abortController.signal.aborted) {
        throw error;
      }
    } finally {
      record.activeRun = null;
      emitSnapshot(record);
    }
  })();

  record.activeRun = {
    abortController,
    promise: runPromise,
  };

  void runPromise.catch(() => {
    // Snapshot state is already updated for callers; avoid unhandled rejections.
  });

  return toView(record);
}

export async function cancelAgentSessionTurn(sessionId: string) {
  const record = requireSessionRecord(sessionId.trim());
  if (!record.activeRun) {
    return toView(record);
  }

  const activeRun = record.activeRun;
  record.snapshot.runState = 'cancelled';
  record.snapshot.lastError = 'Request cancelled.';
  record.snapshot.lastActivityAt = new Date().toISOString();
  activeRun.abortController.abort();
  emitSnapshot(record);

  try {
    await activeRun.promise;
  } catch {
    // Cancellation state is already reflected in the snapshot.
  }

  return toView(record);
}

export function listActiveAgentSessions() {
  return Array.from(globalRecords().values()).map((record) => toView(record));
}
