import { sortSessionHistoryForTimeline } from './history-order.ts';
import type {
  ChatStreamEvent,
  FileChange,
  HistoryEntry,
  SessionAgentHistoryItem,
} from '../types.ts';

type HistoryUpdateDraft = HistoryEntry & {
  threadId?: string | null;
  turnId?: string | null;
  itemStatus?: string | null;
};

export type SessionHistoryEventProjection = {
  history: SessionAgentHistoryItem[];
  handled: boolean;
  changed: boolean;
};

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizeNullableText(value: unknown): string | null {
  const normalized = normalizeText(value).trim();
  return normalized ? normalized : null;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item === 'string') {
      const normalized = item.trim();
      return normalized ? [normalized] : [];
    }

    if (item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string') {
      const normalized = ((item as { text: string }).text).trim();
      return normalized ? [normalized] : [];
    }

    return [];
  });
}

function stringifyCompact(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function normalizeFileChanges(value: unknown): FileChange[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => ({
      path: typeof entry.path === 'string' ? entry.path : '',
      kind: typeof entry.kind === 'string' ? entry.kind : 'modify',
      diff: typeof entry.diff === 'string' ? entry.diff : '',
    }))
    .filter((entry) => Boolean(entry.path));
}

function resolveItemStatus(entry: HistoryUpdateDraft | SessionAgentHistoryItem | undefined): string | null {
  if (!entry) {
    return null;
  }

  if (Object.prototype.hasOwnProperty.call(entry, 'itemStatus')) {
    return entry.itemStatus ?? null;
  }

  if ('status' in entry && typeof entry.status === 'string') {
    return entry.status;
  }

  return null;
}

function findEntry(history: SessionAgentHistoryItem[], itemId: string) {
  return history.find((entry) => entry.id === itemId) ?? null;
}

function nextOrdinal(history: SessionAgentHistoryItem[]) {
  if (history.length === 0) {
    return 0;
  }

  return Math.max(...history.map((entry) => entry.ordinal)) + 1;
}

function upsertHistoryEntry(
  history: SessionAgentHistoryItem[],
  sessionName: string,
  draft: HistoryUpdateDraft,
  timestamp: string,
): SessionHistoryEventProjection {
  const existing = findEntry(history, draft.id);
  const nextEntry: SessionAgentHistoryItem = {
    ...draft,
    sessionName: existing?.sessionName ?? sessionName,
    threadId: draft.threadId ?? existing?.threadId ?? null,
    turnId: draft.turnId ?? existing?.turnId ?? null,
    ordinal: existing?.ordinal ?? nextOrdinal(history),
    itemStatus: resolveItemStatus(draft) ?? resolveItemStatus(existing ?? undefined),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };

  const nextHistory = existing
    ? history.map((entry) => (entry.id === nextEntry.id ? nextEntry : entry))
    : [...history, nextEntry];

  return {
    history: sortSessionHistoryForTimeline(nextHistory),
    handled: true,
    changed: true,
  };
}

function buildNormalizedItemDraft(
  item: Record<string, unknown>,
  event: Extract<ChatStreamEvent, { type: 'item_started' | 'item_completed' }>,
  existing: SessionAgentHistoryItem | null,
): HistoryUpdateDraft | null {
  const itemId = normalizeText(item.id).trim();
  const itemType = normalizeText(item.type).trim();
  if (!itemId || !itemType) {
    return null;
  }

  switch (itemType) {
    case 'userMessage': {
      return null;
    }
    case 'agentMessage':
      return {
        kind: 'assistant',
        id: itemId,
        text: typeof item.text === 'string' ? item.text : (existing?.kind === 'assistant' ? existing.text : ''),
        phase: typeof item.phase === 'string'
          ? item.phase
          : (existing?.kind === 'assistant' ? existing.phase : null),
        threadId: event.threadId,
        turnId: event.turnId,
        itemStatus: existing?.itemStatus ?? null,
      };
    case 'reasoning':
      return {
        kind: 'reasoning',
        id: itemId,
        summary: Array.isArray(item.summary)
          ? normalizeStringArray(item.summary).join('\n')
          : (existing?.kind === 'reasoning' ? existing.summary : ''),
        text: Array.isArray(item.content)
          ? normalizeStringArray(item.content).join('\n')
          : (existing?.kind === 'reasoning' ? existing.text : ''),
        threadId: event.threadId,
        turnId: event.turnId,
        itemStatus: existing?.itemStatus ?? null,
      };
    case 'commandExecution':
      return {
        kind: 'command',
        id: itemId,
        command: typeof item.command === 'string'
          ? item.command
          : (existing?.kind === 'command' ? existing.command : 'Command'),
        cwd: typeof item.cwd === 'string'
          ? item.cwd
          : (existing?.kind === 'command' ? existing.cwd : '.'),
        output: typeof item.aggregatedOutput === 'string'
          ? item.aggregatedOutput
          : (existing?.kind === 'command' ? existing.output : ''),
        status: typeof item.status === 'string'
          ? item.status
          : (existing?.kind === 'command' ? existing.status : 'in_progress'),
        exitCode: typeof item.exitCode === 'number'
          ? item.exitCode
          : (existing?.kind === 'command' ? existing.exitCode : null),
        toolName: existing?.kind === 'command' ? existing.toolName : null,
        toolInput: existing?.kind === 'command' ? existing.toolInput : null,
        threadId: event.threadId,
        turnId: event.turnId,
        itemStatus: typeof item.status === 'string'
          ? item.status
          : (existing?.itemStatus ?? null),
      };
    case 'fileChange':
      return {
        kind: 'fileChange',
        id: itemId,
        status: typeof item.status === 'string'
          ? item.status
          : (existing?.kind === 'fileChange' ? existing.status : 'in_progress'),
        output: existing?.kind === 'fileChange' ? existing.output : '',
        changes: normalizeFileChanges(item.changes).length > 0
          ? normalizeFileChanges(item.changes)
          : (existing?.kind === 'fileChange' ? existing.changes : []),
        threadId: event.threadId,
        turnId: event.turnId,
        itemStatus: typeof item.status === 'string'
          ? item.status
          : (existing?.itemStatus ?? null),
      };
    case 'mcpToolCall':
      return {
        kind: 'tool',
        id: itemId,
        source: 'mcp',
        server: normalizeNullableText(item.server),
        tool: normalizeText(item.tool),
        status: normalizeText(item.status) || (existing?.kind === 'tool' ? existing.status : 'running'),
        input: stringifyCompact(item.arguments),
        message: null,
        result: stringifyCompact(item.result),
        error: stringifyCompact(item.error),
        threadId: event.threadId,
        turnId: event.turnId,
        itemStatus: normalizeText(item.status) || (existing?.itemStatus ?? null),
      };
    case 'dynamicToolCall':
      return {
        kind: 'tool',
        id: itemId,
        source: 'dynamic',
        server: null,
        tool: normalizeText(item.tool),
        status: normalizeText(item.status) || (existing?.kind === 'tool' ? existing.status : 'running'),
        input: stringifyCompact(item.arguments),
        message: null,
        result: stringifyCompact(item.contentItems),
        error: item.success === false && item.contentItems == null ? 'Tool call failed.' : null,
        threadId: event.threadId,
        turnId: event.turnId,
        itemStatus: normalizeText(item.status) || (existing?.itemStatus ?? null),
      };
    case 'webSearch':
      return {
        kind: 'tool',
        id: itemId,
        source: 'web_search',
        server: null,
        tool: 'web_search',
        status: 'completed',
        input: normalizeText(item.query),
        message: stringifyCompact(item.action),
        result: null,
        error: null,
        threadId: event.threadId,
        turnId: event.turnId,
        itemStatus: 'completed',
      };
    case 'plan':
      return {
        kind: 'plan',
        id: itemId,
        text: normalizeText(item.text),
        threadId: event.threadId,
        turnId: event.turnId,
        itemStatus: existing?.itemStatus ?? null,
      };
    default:
      return null;
  }
}

export function projectSessionHistoryEvent(
  history: SessionAgentHistoryItem[],
  sessionName: string,
  event: ChatStreamEvent,
  timestamp = new Date().toISOString(),
): SessionHistoryEventProjection {
  switch (event.type) {
    case 'thread_ready':
    case 'turn_started':
    case 'turn_completed':
    case 'error':
    case 'turn_diagnostic':
      return {
        history,
        handled: true,
        changed: false,
      };
    case 'agent_message_delta': {
      const existing = findEntry(history, event.itemId);
      return upsertHistoryEntry(history, sessionName, {
        kind: 'assistant',
        id: event.itemId,
        text: `${existing?.kind === 'assistant' ? existing.text : ''}${event.delta}`,
        phase: existing?.kind === 'assistant' ? existing.phase : null,
        threadId: event.threadId,
        turnId: event.turnId,
        itemStatus: existing?.itemStatus ?? null,
      }, timestamp);
    }
    case 'reasoning_delta': {
      const existing = findEntry(history, event.itemId);
      return upsertHistoryEntry(history, sessionName, {
        kind: 'reasoning',
        id: event.itemId,
        summary: existing?.kind === 'reasoning' ? existing.summary : '',
        text: `${existing?.kind === 'reasoning' ? existing.text : ''}${event.delta}`,
        threadId: event.threadId,
        turnId: event.turnId,
        itemStatus: existing?.itemStatus ?? null,
      }, timestamp);
    }
    case 'reasoning_summary_delta': {
      const existing = findEntry(history, event.itemId);
      return upsertHistoryEntry(history, sessionName, {
        kind: 'reasoning',
        id: event.itemId,
        summary: `${existing?.kind === 'reasoning' ? existing.summary : ''}${event.delta}`,
        text: existing?.kind === 'reasoning' ? existing.text : '',
        threadId: event.threadId,
        turnId: event.turnId,
        itemStatus: existing?.itemStatus ?? null,
      }, timestamp);
    }
    case 'command_seed': {
      const existing = findEntry(history, event.itemId);
      return upsertHistoryEntry(history, sessionName, {
        kind: 'command',
        id: event.itemId,
        command: event.command,
        cwd: event.cwd,
        output: existing?.kind === 'command' ? existing.output : '',
        status: existing?.kind === 'command' ? existing.status : 'in_progress',
        exitCode: existing?.kind === 'command' ? existing.exitCode : null,
        toolName: event.toolName,
        toolInput: event.toolInput,
        threadId: event.threadId,
        turnId: event.turnId,
        itemStatus: existing?.kind === 'command' ? existing.status : 'in_progress',
      }, timestamp);
    }
    case 'command_output_delta': {
      const existing = findEntry(history, event.itemId);
      return upsertHistoryEntry(history, sessionName, {
        kind: 'command',
        id: event.itemId,
        command: existing?.kind === 'command' ? existing.command : 'Command',
        cwd: existing?.kind === 'command' ? existing.cwd : '.',
        output: `${existing?.kind === 'command' ? existing.output : ''}${event.delta}`,
        status: existing?.kind === 'command' ? existing.status : 'running',
        exitCode: existing?.kind === 'command' ? existing.exitCode : null,
        toolName: existing?.kind === 'command' ? existing.toolName : null,
        toolInput: existing?.kind === 'command' ? existing.toolInput : null,
        threadId: event.threadId,
        turnId: event.turnId,
        itemStatus: existing?.kind === 'command' ? existing.status : 'running',
      }, timestamp);
    }
    case 'file_change_delta': {
      const existing = findEntry(history, event.itemId);
      return upsertHistoryEntry(history, sessionName, {
        kind: 'fileChange',
        id: event.itemId,
        status: existing?.kind === 'fileChange' ? existing.status : 'in_progress',
        output: `${existing?.kind === 'fileChange' ? existing.output : ''}${event.delta}`,
        changes: existing?.kind === 'fileChange' ? existing.changes : [],
        threadId: event.threadId,
        turnId: event.turnId,
        itemStatus: existing?.kind === 'fileChange' ? existing.status : 'in_progress',
      }, timestamp);
    }
    case 'tool_progress':
      return upsertHistoryEntry(history, sessionName, {
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
        threadId: event.threadId,
        turnId: event.turnId,
        itemStatus: event.status,
      }, timestamp);
    case 'plan_updated':
      return upsertHistoryEntry(history, sessionName, {
        kind: 'plan',
        id: `plan-${event.turnId}`,
        text: event.steps.map((step) => `${step.status.toUpperCase()} ${step.title}`).join('\n'),
        threadId: event.threadId,
        turnId: event.turnId,
        itemStatus: null,
      }, timestamp);
    case 'item_started':
    case 'item_completed': {
      const existing = findEntry(history, normalizeText(event.item.id).trim());
      const draft = buildNormalizedItemDraft(event.item, event, existing);
      if (!draft) {
        return {
          history,
          handled: false,
          changed: false,
        };
      }
      return upsertHistoryEntry(history, sessionName, draft, timestamp);
    }
  }
}
