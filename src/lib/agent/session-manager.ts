import { randomUUID } from 'node:crypto';

import {
  getSessionAgentSnapshot,
  getSessionMetadata,
  markSessionInitialized,
} from '@/app/actions/session';
import { getAgentAdapter } from '@/lib/agent/providers';
import {
  listSessionHistory,
  readSessionRuntime,
  updateSessionRuntime,
  upsertSessionHistoryEntries,
} from '@/lib/agent/store';
import { publishSessionAgentEvent, publishSessionListUpdated } from '@/lib/sessionNotificationServer';
import type {
  AgentProvider,
  ChatStreamEvent,
  FileChange,
  HistoryEntry,
  SessionAgentHistoryInput,
  SessionAgentHistoryItem,
  SessionAgentRunState,
  SessionAgentRuntimeState,
} from '@/lib/types';

type ActiveRun = {
  abortController: AbortController;
  promise: Promise<void>;
};

type ManagerState = {
  runs: Map<string, ActiveRun>;
};

type StartTurnInput = {
  sessionId: string;
  message: string;
  displayMessage?: string | null;
  markInitialized?: boolean;
};

declare global {
  var __palxAgentSessionManagerState: ManagerState | undefined;
}

function getManagerState(): ManagerState {
  if (!globalThis.__palxAgentSessionManagerState) {
    globalThis.__palxAgentSessionManagerState = {
      runs: new Map(),
    };
  }

  return globalThis.__palxAgentSessionManagerState;
}

function normalizeText(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : '';
}

function resolveItemStatus(
  entry: SessionAgentHistoryInput | SessionAgentHistoryItem | undefined,
): string | null {
  if (!entry) {
    return null;
  }

  if ('itemStatus' in entry) {
    return entry.itemStatus ?? null;
  }

  if ('status' in entry && typeof entry.status === 'string') {
    return entry.status;
  }

  return null;
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

function runtimeStateForCompletion(event: Extract<ChatStreamEvent, { type: 'turn_completed' }>): SessionAgentRunState {
  if (event.error) {
    return event.error === 'Request cancelled.' ? 'cancelled' : 'error';
  }

  if (event.status === 'cancelled') {
    return 'cancelled';
  }

  if (event.status === 'failed' || event.status === 'error') {
    return 'error';
  }

  return 'completed';
}

class HistoryProjector {
  private readonly entries = new Map<string, SessionAgentHistoryItem>();
  private nextOrdinal: number;

  constructor(
    private readonly sessionId: string,
    existingHistory: SessionAgentHistoryItem[],
  ) {
    for (const entry of existingHistory) {
      this.entries.set(entry.id, entry);
    }
    this.nextOrdinal = existingHistory.length > 0
      ? Math.max(...existingHistory.map((entry) => entry.ordinal)) + 1
      : 0;
  }

  addUserMessage(text: string) {
    const trimmed = normalizeText(text);
    if (!trimmed) {
      return;
    }

    this.persist({
      kind: 'user',
      id: `user-${randomUUID()}`,
      text: trimmed,
    });
  }

  applyEvent(event: ChatStreamEvent) {
    switch (event.type) {
      case 'agent_message_delta':
        this.appendAssistant(event.itemId, event.delta, event.threadId, event.turnId);
        return;
      case 'reasoning_delta':
        this.appendReasoningText(event.itemId, event.delta, event.threadId, event.turnId);
        return;
      case 'reasoning_summary_delta':
        this.appendReasoningSummary(event.itemId, event.delta, event.threadId, event.turnId);
        return;
      case 'command_seed':
        this.persist({
          kind: 'command',
          id: event.itemId,
          command: event.command,
          cwd: event.cwd,
          output: this.getCommand(event.itemId)?.output ?? '',
          status: this.getCommand(event.itemId)?.status ?? 'in_progress',
          exitCode: this.getCommand(event.itemId)?.exitCode ?? null,
          toolName: event.toolName,
          toolInput: event.toolInput,
          threadId: event.threadId,
          turnId: event.turnId,
        });
        return;
      case 'command_output_delta': {
        const existing = this.getCommand(event.itemId);
        this.persist({
          kind: 'command',
          id: event.itemId,
          command: existing?.command ?? 'Command',
          cwd: existing?.cwd ?? '.',
          output: `${existing?.output ?? ''}${event.delta}`,
          status: existing?.status ?? 'in_progress',
          exitCode: existing?.exitCode ?? null,
          toolName: existing?.toolName ?? null,
          toolInput: existing?.toolInput ?? null,
          threadId: event.threadId,
          turnId: event.turnId,
        });
        return;
      }
      case 'file_change_delta': {
        const existing = this.getFileChange(event.itemId);
        this.persist({
          kind: 'fileChange',
          id: event.itemId,
          status: existing?.status ?? 'in_progress',
          output: `${existing?.output ?? ''}${event.delta}`,
          changes: existing?.changes ?? [],
          threadId: event.threadId,
          turnId: event.turnId,
        });
        return;
      }
      case 'tool_progress':
        this.persist({
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
        });
        return;
      case 'plan_updated':
        this.persist({
          kind: 'plan',
          id: `plan-${event.turnId}`,
          text: event.steps.map((step) => `${step.status.toUpperCase()} ${step.title}`).join('\n'),
          threadId: event.threadId,
          turnId: event.turnId,
        });
        return;
      case 'item_started':
      case 'item_completed':
        this.applyItemEvent(event);
        return;
      default:
        return;
    }
  }

  private applyItemEvent(event: Extract<ChatStreamEvent, { type: 'item_started' | 'item_completed' }>) {
    const item = event.item;
    const itemId = typeof item.id === 'string' ? item.id : null;
    const itemType = typeof item.type === 'string' ? item.type : null;

    if (!itemId || !itemType) {
      return;
    }

    if (itemType === 'agentMessage') {
      const existing = this.getAssistant(itemId);
      this.persist({
        kind: 'assistant',
        id: itemId,
        text: typeof item.text === 'string' ? item.text : (existing?.text ?? ''),
        phase: typeof item.phase === 'string' ? item.phase : (existing?.phase ?? null),
        threadId: event.threadId,
        turnId: event.turnId,
      });
      return;
    }

    if (itemType === 'reasoning') {
      const existing = this.getReasoning(itemId);
      const summary = Array.isArray(item.summary)
        ? item.summary.filter((value): value is string => typeof value === 'string').join('\n')
        : (existing?.summary ?? '');
      const text = Array.isArray(item.content)
        ? item.content.filter((value): value is string => typeof value === 'string').join('\n')
        : (existing?.text ?? '');
      this.persist({
        kind: 'reasoning',
        id: itemId,
        summary,
        text,
        threadId: event.threadId,
        turnId: event.turnId,
      });
      return;
    }

    if (itemType === 'commandExecution') {
      const existing = this.getCommand(itemId);
      this.persist({
        kind: 'command',
        id: itemId,
        command: typeof item.command === 'string' ? item.command : (existing?.command ?? 'Command'),
        cwd: typeof item.cwd === 'string' ? item.cwd : (existing?.cwd ?? '.'),
        output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : (existing?.output ?? ''),
        status: typeof item.status === 'string' ? item.status : (existing?.status ?? 'in_progress'),
        exitCode: typeof item.exitCode === 'number' ? item.exitCode : (existing?.exitCode ?? null),
        toolName: existing?.toolName ?? null,
        toolInput: existing?.toolInput ?? null,
        threadId: event.threadId,
        turnId: event.turnId,
      });
      return;
    }

    if (itemType === 'fileChange') {
      const existing = this.getFileChange(itemId);
      this.persist({
        kind: 'fileChange',
        id: itemId,
        status: typeof item.status === 'string' ? item.status : (existing?.status ?? 'in_progress'),
        output: existing?.output ?? '',
        changes: normalizeFileChanges(item.changes).length > 0 ? normalizeFileChanges(item.changes) : (existing?.changes ?? []),
        threadId: event.threadId,
        turnId: event.turnId,
      });
    }
  }

  private getAssistant(itemId: string) {
    const entry = this.entries.get(itemId);
    return entry?.kind === 'assistant' ? entry : null;
  }

  private getReasoning(itemId: string) {
    const entry = this.entries.get(itemId);
    return entry?.kind === 'reasoning' ? entry : null;
  }

  private getCommand(itemId: string) {
    const entry = this.entries.get(itemId);
    return entry?.kind === 'command' ? entry : null;
  }

  private getFileChange(itemId: string) {
    const entry = this.entries.get(itemId);
    return entry?.kind === 'fileChange' ? entry : null;
  }

  private appendAssistant(itemId: string, delta: string, threadId: string, turnId: string) {
    const existing = this.getAssistant(itemId);
    this.persist({
      kind: 'assistant',
      id: itemId,
      text: `${existing?.text ?? ''}${delta}`,
      phase: existing?.phase ?? null,
      threadId,
      turnId,
    });
  }

  private appendReasoningText(itemId: string, delta: string, threadId: string, turnId: string) {
    const existing = this.getReasoning(itemId);
    this.persist({
      kind: 'reasoning',
      id: itemId,
      summary: existing?.summary ?? '',
      text: `${existing?.text ?? ''}${delta}`,
      threadId,
      turnId,
    });
  }

  private appendReasoningSummary(itemId: string, delta: string, threadId: string, turnId: string) {
    const existing = this.getReasoning(itemId);
    this.persist({
      kind: 'reasoning',
      id: itemId,
      summary: `${existing?.summary ?? ''}${delta}`,
      text: existing?.text ?? '',
      threadId,
      turnId,
    });
  }

  private persist(entry: SessionAgentHistoryInput) {
    const existing = this.entries.get(entry.id);
    const createdAt = existing?.createdAt ?? new Date().toISOString();
    const persisted: SessionAgentHistoryInput = {
      ...entry,
      ordinal: existing?.ordinal ?? this.nextOrdinal++,
      createdAt,
      updatedAt: new Date().toISOString(),
      itemStatus: resolveItemStatus(entry) ?? resolveItemStatus(existing),
    };

    upsertSessionHistoryEntries(this.sessionId, [persisted]);

    this.entries.set(entry.id, {
      ...(entry as HistoryEntry),
      sessionName: this.sessionId,
      threadId: 'threadId' in persisted ? (persisted.threadId ?? null) : (existing?.threadId ?? null),
      turnId: 'turnId' in persisted ? (persisted.turnId ?? null) : (existing?.turnId ?? null),
      ordinal: persisted.ordinal ?? existing?.ordinal ?? 0,
      itemStatus: resolveItemStatus(persisted) ?? resolveItemStatus(existing),
      createdAt,
      updatedAt: persisted.updatedAt ?? createdAt,
    });
  }
}

async function publishRuntimeEvent(sessionId: string, event: ChatStreamEvent) {
  const snapshot = readSessionRuntime(sessionId);
  if (!snapshot) {
    return;
  }

  await publishSessionAgentEvent({
    sessionId,
    snapshot,
    event,
  });
}

export function isSessionTurnRunning(sessionId: string) {
  return getManagerState().runs.has(sessionId);
}

export async function startSessionTurn(input: StartTurnInput): Promise<{
  success: boolean;
  runtime?: SessionAgentRuntimeState | null;
  error?: string;
}> {
  const sessionId = normalizeText(input.sessionId);
  const message = normalizeText(input.message);
  const displayMessage = normalizeText(input.displayMessage ?? input.message);

  if (!sessionId) {
    return { success: false, error: 'sessionId is required.' };
  }

  if (!message) {
    return { success: false, error: 'message is required.' };
  }

  const state = getManagerState();
  if (state.runs.has(sessionId)) {
    return { success: false, error: 'A turn is already running for this session.' };
  }

  const metadata = await getSessionMetadata(sessionId);
  if (!metadata) {
    return { success: false, error: 'Session not found.' };
  }

  const provider = metadata.agentProvider ?? metadata.agent;
  if (!provider) {
    return { success: false, error: 'Session agent provider is missing.' };
  }

  const adapter = getAgentAdapter(provider as AgentProvider);
  const existingHistory = listSessionHistory(sessionId);
  const projector = new HistoryProjector(sessionId, existingHistory);
  projector.addUserMessage(displayMessage);

  if (input.markInitialized) {
    await markSessionInitialized(sessionId);
  }

  const startedAt = new Date().toISOString();
  const initialRuntime = updateSessionRuntime(sessionId, {
    runState: 'queued',
    activeTurnId: null,
    lastError: null,
    lastActivityAt: startedAt,
  });
  await publishSessionListUpdated();

  const abortController = new AbortController();
  const promise = (async () => {
    try {
      await adapter.streamChat({
        workspacePath: metadata.workspacePath,
        threadId: metadata.threadId ?? null,
        message,
        model: metadata.model || null,
        reasoningEffort: metadata.reasoningEffort ?? null,
      }, async (event) => {
        projector.applyEvent(event as ChatStreamEvent);

        const now = new Date().toISOString();
        switch (event.type) {
          case 'thread_ready':
            updateSessionRuntime(sessionId, {
              threadId: event.threadId,
              lastActivityAt: now,
            });
            break;
          case 'turn_started':
            updateSessionRuntime(sessionId, {
              activeTurnId: event.turnId,
              runState: 'running',
              lastError: null,
              lastActivityAt: now,
            });
            break;
          case 'turn_completed':
            updateSessionRuntime(sessionId, {
              threadId: event.threadId,
              activeTurnId: null,
              runState: runtimeStateForCompletion(event),
              lastError: event.error,
              lastActivityAt: now,
            });
            break;
          case 'error':
            updateSessionRuntime(sessionId, {
              runState: 'error',
              activeTurnId: null,
              lastError: event.message,
              lastActivityAt: now,
            });
            break;
          default:
            updateSessionRuntime(sessionId, {
              lastActivityAt: now,
            });
            break;
        }

        await publishRuntimeEvent(sessionId, event as ChatStreamEvent);
      }, abortController.signal);
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Agent turn failed.';
      const runtime = updateSessionRuntime(sessionId, {
        activeTurnId: null,
        runState: abortController.signal.aborted ? 'cancelled' : 'error',
        lastError: abortController.signal.aborted ? 'Request cancelled.' : messageText,
        lastActivityAt: new Date().toISOString(),
      });

      if (runtime) {
        await publishSessionAgentEvent({
          sessionId,
          snapshot: runtime,
          event: {
            type: 'error',
            message: abortController.signal.aborted ? 'Request cancelled.' : messageText,
          },
        });
      }
    } finally {
      state.runs.delete(sessionId);
      await publishSessionListUpdated();
    }
  })();

  state.runs.set(sessionId, {
    abortController,
    promise,
  });

  void promise.catch(() => {});

  return { success: true, runtime: initialRuntime };
}

export async function cancelSessionTurn(sessionId: string): Promise<{
  success: boolean;
  runtime?: SessionAgentRuntimeState | null;
  error?: string;
}> {
  const normalizedSessionId = normalizeText(sessionId);
  if (!normalizedSessionId) {
    return { success: false, error: 'sessionId is required.' };
  }

  const active = getManagerState().runs.get(normalizedSessionId);
  if (!active) {
    return {
      success: true,
      runtime: readSessionRuntime(normalizedSessionId),
    };
  }

  active.abortController.abort();
  const runtime = updateSessionRuntime(normalizedSessionId, {
    activeTurnId: null,
    runState: 'cancelled',
    lastError: 'Request cancelled.',
    lastActivityAt: new Date().toISOString(),
  });

  if (runtime) {
    await publishSessionAgentEvent({
      sessionId: normalizedSessionId,
      snapshot: runtime,
      event: {
        type: 'error',
        message: 'Request cancelled.',
      },
    });
  }

  return { success: true, runtime };
}

export async function getAgentSessionSnapshot(sessionId: string) {
  return await getSessionAgentSnapshot(sessionId);
}
