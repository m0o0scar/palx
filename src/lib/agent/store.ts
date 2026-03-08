import { getLocalDb } from '@/lib/local-db';
import {
  normalizeNullableProviderReasoningEffort,
  normalizeProviderReasoningEffort,
} from '@/lib/agent/reasoning';
import type {
  AgentProvider,
  HistoryEntry,
  ReasoningEffort,
  SessionAgentHistoryInput,
  SessionAgentHistoryItem,
  SessionAgentRunState,
  SessionAgentRuntimeState,
} from '@/lib/types';

type SessionRuntimeRow = {
  session_name: string;
  agent: string;
  model: string;
  reasoning_effort: string | null;
  thread_id: string | null;
  active_turn_id: string | null;
  run_state: string | null;
  last_error: string | null;
  last_activity_at: string | null;
};

type SessionAgentHistoryRow = {
  session_name: string;
  item_id: string;
  thread_id: string | null;
  turn_id: string | null;
  ordinal: number | null;
  kind: string;
  status: string | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
};

type NormalizedHistoryWrite = {
  itemId: string;
  kind: HistoryEntry['kind'];
  payloadJson: string;
  threadIdProvided: boolean;
  threadId: string | null;
  turnIdProvided: boolean;
  turnId: string | null;
  ordinal: number;
  itemStatusProvided: boolean;
  itemStatus: string | null;
  createdAt: string;
  updatedAt: string;
};

function normalizeOptionalText(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function normalizeNullableText(value: string | null | undefined): string | null {
  return normalizeOptionalText(value) ?? null;
}

function toRuntimeState(row: SessionRuntimeRow): SessionAgentRuntimeState {
  return {
    sessionName: row.session_name,
    agentProvider: row.agent as AgentProvider,
    model: row.model,
    reasoningEffort: normalizeProviderReasoningEffort(row.agent, row.reasoning_effort),
    threadId: normalizeNullableText(row.thread_id),
    activeTurnId: normalizeNullableText(row.active_turn_id),
    runState: normalizeNullableText(row.run_state) as SessionAgentRunState | null,
    lastError: normalizeNullableText(row.last_error),
    lastActivityAt: normalizeNullableText(row.last_activity_at),
  };
}

function toHistoryItem(row: SessionAgentHistoryRow): SessionAgentHistoryItem | null {
  try {
    const parsed = JSON.parse(row.payload_json) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }

    const payload = parsed as Record<string, unknown>;
    if (payload.kind !== row.kind) {
      return null;
    }

    if (typeof payload.id !== 'string' || !payload.id.trim()) {
      payload.id = row.item_id;
    }

    return {
      ...(payload as HistoryEntry),
      sessionName: row.session_name,
      threadId: normalizeNullableText(row.thread_id),
      turnId: normalizeNullableText(row.turn_id),
      ordinal: row.ordinal ?? 0,
      itemStatus: normalizeNullableText(row.status),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch {
    return null;
  }
}

function normalizeHistoryWrite(input: SessionAgentHistoryInput): NormalizedHistoryWrite | null {
  const itemId = normalizeOptionalText(input.id);
  if (!itemId) {
    return null;
  }

  const {
    threadId,
    turnId,
    ordinal,
    itemStatus,
    createdAt,
    updatedAt,
    ...entry
  } = input;

  const normalizedEntry = { ...entry, id: itemId } as HistoryEntry;

  return {
    itemId,
    kind: normalizedEntry.kind,
    payloadJson: JSON.stringify(normalizedEntry),
    threadIdProvided: Object.prototype.hasOwnProperty.call(input, 'threadId'),
    threadId: normalizeNullableText(threadId),
    turnIdProvided: Object.prototype.hasOwnProperty.call(input, 'turnId'),
    turnId: normalizeNullableText(turnId),
    ordinal: typeof ordinal === 'number' && Number.isFinite(ordinal) ? Math.max(0, Math.floor(ordinal)) : 0,
    itemStatusProvided: Object.prototype.hasOwnProperty.call(input, 'itemStatus'),
    itemStatus: normalizeNullableText(itemStatus),
    createdAt: normalizeOptionalText(createdAt) ?? new Date().toISOString(),
    updatedAt: normalizeOptionalText(updatedAt) ?? new Date().toISOString(),
  };
}

export function readSessionRuntime(sessionName: string): SessionAgentRuntimeState | null {
  const db = getLocalDb();
  const row = db.prepare(`
    SELECT
      session_name, agent, model, reasoning_effort, thread_id, active_turn_id,
      run_state, last_error, last_activity_at
    FROM sessions
    WHERE session_name = ?
  `).get(sessionName) as SessionRuntimeRow | undefined;

  return row ? toRuntimeState(row) : null;
}

export function updateSessionRuntime(
  sessionName: string,
  updates: {
    agentProvider?: AgentProvider;
    model?: string;
    reasoningEffort?: ReasoningEffort | null;
    threadId?: string | null;
    activeTurnId?: string | null;
    runState?: SessionAgentRunState | null;
    lastError?: string | null;
    lastActivityAt?: string | null;
  },
): SessionAgentRuntimeState | null {
  const db = getLocalDb();
  const currentRuntime = readSessionRuntime(sessionName);
  const setters: string[] = [];
  const params: Record<string, string | null> = { sessionName };

  if (updates.agentProvider !== undefined) {
    const value = normalizeOptionalText(updates.agentProvider);
    if (value) {
      setters.push('agent = @agentProvider');
      params.agentProvider = value;
    }
  }

  if (updates.model !== undefined) {
    const value = normalizeOptionalText(updates.model);
    if (value) {
      setters.push('model = @model');
      params.model = value;
    }
  }

  if (updates.reasoningEffort !== undefined) {
    setters.push('reasoning_effort = @reasoningEffort');
    params.reasoningEffort = normalizeNullableProviderReasoningEffort(
      updates.agentProvider ?? currentRuntime?.agentProvider,
      updates.reasoningEffort,
    );
  }

  if (updates.threadId !== undefined) {
    setters.push('thread_id = @threadId');
    params.threadId = normalizeNullableText(updates.threadId);
  }

  if (updates.activeTurnId !== undefined) {
    setters.push('active_turn_id = @activeTurnId');
    params.activeTurnId = normalizeNullableText(updates.activeTurnId);
  }

  if (updates.runState !== undefined) {
    setters.push('run_state = @runState');
    params.runState = normalizeNullableText(updates.runState);
  }

  if (updates.lastError !== undefined) {
    setters.push('last_error = @lastError');
    params.lastError = normalizeNullableText(updates.lastError);
  }

  if (updates.lastActivityAt !== undefined) {
    setters.push('last_activity_at = @lastActivityAt');
    params.lastActivityAt = normalizeNullableText(updates.lastActivityAt);
  }

  if (setters.length === 0) {
    return readSessionRuntime(sessionName);
  }

  db.prepare(`
    UPDATE sessions
    SET ${setters.join(', ')}
    WHERE session_name = @sessionName
  `).run(params);

  return readSessionRuntime(sessionName);
}

export function listSessionHistory(sessionName: string): SessionAgentHistoryItem[] {
  const db = getLocalDb();
  const rows = db.prepare(`
    SELECT
      session_name, item_id, thread_id, turn_id, ordinal, kind, status,
      payload_json, created_at, updated_at
    FROM session_agent_history_items
    WHERE session_name = ?
    ORDER BY ordinal ASC, created_at ASC, item_id ASC
  `).all(sessionName) as SessionAgentHistoryRow[];

  return rows
    .map((row) => toHistoryItem(row))
    .filter((item): item is SessionAgentHistoryItem => Boolean(item));
}

export function getNextHistoryOrdinal(sessionName: string): number {
  const db = getLocalDb();
  const row = db.prepare(`
    SELECT COALESCE(MAX(ordinal), -1) AS max_ordinal
    FROM session_agent_history_items
    WHERE session_name = ?
  `).get(sessionName) as { max_ordinal: number } | undefined;

  return (row?.max_ordinal ?? -1) + 1;
}

export function upsertSessionHistoryEntries(sessionName: string, entries: SessionAgentHistoryInput[]) {
  const normalizedEntries = entries
    .map((entry) => normalizeHistoryWrite(entry))
    .filter((entry): entry is NormalizedHistoryWrite => Boolean(entry));

  if (normalizedEntries.length === 0) {
    return;
  }

  const db = getLocalDb();
  const selectExisting = db.prepare(`
    SELECT
      session_name, item_id, thread_id, turn_id, ordinal, kind, status,
      payload_json, created_at, updated_at
    FROM session_agent_history_items
    WHERE session_name = ? AND item_id = ?
  `);
  const insertOrReplace = db.prepare(`
    INSERT OR REPLACE INTO session_agent_history_items (
      session_name, item_id, thread_id, turn_id, ordinal, kind, status,
      payload_json, created_at, updated_at
    ) VALUES (
      @sessionName, @itemId, @threadId, @turnId, @ordinal, @kind, @status,
      @payloadJson, @createdAt, @updatedAt
    )
  `);

  const transaction = db.transaction((writes: NormalizedHistoryWrite[]) => {
    for (const write of writes) {
      const existing = selectExisting.get(sessionName, write.itemId) as SessionAgentHistoryRow | undefined;
      insertOrReplace.run({
        sessionName,
        itemId: write.itemId,
        threadId: write.threadIdProvided ? write.threadId : (existing?.thread_id ?? null),
        turnId: write.turnIdProvided ? write.turnId : (existing?.turn_id ?? null),
        ordinal: existing?.ordinal ?? write.ordinal,
        kind: write.kind,
        status: write.itemStatusProvided ? write.itemStatus : (existing?.status ?? null),
        payloadJson: write.payloadJson,
        createdAt: existing?.created_at ?? write.createdAt,
        updatedAt: write.updatedAt,
      });
    }
  });

  transaction(normalizedEntries);
}

export function clearSessionHistory(sessionName: string) {
  const db = getLocalDb();
  db.prepare(`DELETE FROM session_agent_history_items WHERE session_name = ?`).run(sessionName);
}
