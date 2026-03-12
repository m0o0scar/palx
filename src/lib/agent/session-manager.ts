import { randomUUID } from 'node:crypto';

import {
  discoverProjectGitRepos,
} from '@/app/actions/project';
import {
  getSessionAgentSnapshot,
  getSessionMetadata,
  markSessionInitialized,
  readSessionLaunchContext,
} from '@/app/actions/session';
import { getAgentAdapter } from '@/lib/agent/providers';
import { readCommandOutput } from '@/lib/agent/common';
import {
  collectDescendantProcesses,
  parsePsProcessTable,
  type RuntimeProcessEntry,
} from '@/lib/agent/process-tree';
import { resolveGitSessionEnvironments } from '@/lib/git-session-auth';
import {
  listSessionHistory,
  readSessionRuntime,
  updateSessionRuntime,
  upsertSessionHistoryEntries,
} from '@/lib/agent/store';
import { resolveSessionRuntimeUpdate } from '@/lib/agent/session-runtime-updates';
import { resolveSessionTerminalRepoPaths } from '@/lib/session-terminal-repos';
import { deriveSessionNotificationFromRuntime } from '@/lib/session-agent-notifications';
import {
  publishSessionAgentEvent,
  publishSessionListUpdated,
  publishSessionNotification,
} from '@/lib/sessionNotificationServer';
import { terminateProcessGracefully } from '@/lib/session-processes';
import type {
  AgentProvider,
  ChatStreamEvent,
  FileChange,
  HistoryEntry,
  SessionAgentHistoryInput,
  SessionAgentHistoryItem,
  SessionAgentRunState,
  SessionAgentTurnDiagnosticUpdate,
  SessionAgentTurnDiagnostics,
  SessionAgentRuntimeState,
} from '@/lib/types';

type ActiveRun = {
  abortController: AbortController;
  promise: Promise<void>;
  diagnostics: SessionAgentTurnDiagnostics;
  runtimePid: number | null;
};

type ManagerState = {
  runs: Map<string, ActiveRun>;
  lastDiagnostics: Map<string, SessionAgentTurnDiagnostics>;
};

type StartTurnInput = {
  sessionId: string;
  message: string;
  displayMessage?: string | null;
  attachmentPaths?: string[];
  markInitialized?: boolean;
};

export type SessionAgentRuntimeSubprocess = {
  pid: number;
  ppid: number;
  state: string;
  command: string;
};

declare global {
  var __palxAgentSessionManagerState: ManagerState | undefined;
}

function getManagerState(): ManagerState {
  if (!globalThis.__palxAgentSessionManagerState) {
    globalThis.__palxAgentSessionManagerState = {
      runs: new Map(),
      lastDiagnostics: new Map(),
    };
  }

  return globalThis.__palxAgentSessionManagerState;
}

function normalizeText(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : '';
}

function normalizeAttachmentPaths(value: string[] | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((entry) => normalizeText(entry)).filter(Boolean)));
}

function appendAttachmentPathsToMessage(message: string, attachmentPaths: string[]): string {
  if (attachmentPaths.length === 0) {
    return message;
  }

  const attachmentSection = [
    'Attachments:',
    ...attachmentPaths.map((attachmentPath) => `- ${attachmentPath}`),
  ].join('\n');

  return message ? `${message}\n\n${attachmentSection}` : attachmentSection;
}

function buildAttachmentOnlyDisplayMessage(attachmentPaths: string[]): string {
  if (attachmentPaths.length === 0) {
    return '';
  }
  return `Attached ${attachmentPaths.length} file${attachmentPaths.length === 1 ? '' : 's'}.`;
}

function cloneTurnDiagnostics(
  diagnostics: SessionAgentTurnDiagnostics,
): SessionAgentTurnDiagnostics {
  return {
    ...diagnostics,
    steps: diagnostics.steps.map((step) => ({ ...step })),
  };
}

function createTurnDiagnostics(provider: AgentProvider, queuedAt: string): SessionAgentTurnDiagnostics {
  return {
    transport: provider === 'codex' ? 'codex-app-server' : 'acp',
    runState: 'queued',
    queuedAt,
    updatedAt: queuedAt,
    startedAt: null,
    completedAt: null,
    timeToTurnStartMs: null,
    currentStepKey: null,
    steps: [],
  };
}

async function readRuntimeProcessTable(): Promise<RuntimeProcessEntry[]> {
  if (process.platform === 'win32') {
    return [];
  }

  const result = await readCommandOutput('ps', ['-axo', 'pid=,ppid=,state=,command=']);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'Failed to read runtime process table.');
  }

  return parsePsProcessTable(result.stdout);
}

async function terminateRuntimeDescendants(runtimePid: number | null): Promise<void> {
  if (runtimePid === null || !Number.isInteger(runtimePid) || runtimePid <= 0) {
    return;
  }

  try {
    const processTable = await readRuntimeProcessTable();
    const descendants = collectDescendantProcesses(processTable, runtimePid).sort((left, right) => right.pid - left.pid);
    for (const entry of descendants) {
      try {
        await terminateProcessGracefully({ pid: entry.pid });
      } catch (error) {
        console.warn(`Failed to terminate lingering runtime subprocess ${entry.pid}:`, error);
      }
    }
  } catch (error) {
    console.warn(`Failed to inspect lingering subprocesses for runtime ${runtimePid}:`, error);
  }
}

function toRuntimeSubprocess(entry: RuntimeProcessEntry): SessionAgentRuntimeSubprocess {
  return {
    pid: entry.pid,
    ppid: entry.ppid,
    state: entry.state,
    command: entry.command,
  };
}

function getSessionTurnDiagnosticsSnapshot(sessionId: string): SessionAgentTurnDiagnostics | null {
  const state = getManagerState();
  const diagnostics = state.runs.get(sessionId)?.diagnostics ?? state.lastDiagnostics.get(sessionId) ?? null;
  return diagnostics ? cloneTurnDiagnostics(diagnostics) : null;
}

export function enrichSessionRuntimeWithDiagnostics(
  sessionId: string,
  runtime: SessionAgentRuntimeState | null,
): SessionAgentRuntimeState | null {
  if (!runtime) {
    return null;
  }

  const diagnostics = getSessionTurnDiagnosticsSnapshot(sessionId);
  if (!diagnostics) {
    return runtime;
  }

  return {
    ...runtime,
    turnDiagnostics: diagnostics,
  };
}

function updateRunDiagnostics(
  sessionId: string,
  updater: (diagnostics: SessionAgentTurnDiagnostics) => void,
): SessionAgentTurnDiagnostics | null {
  const state = getManagerState();
  const activeRun = state.runs.get(sessionId);
  if (!activeRun) {
    return null;
  }

  updater(activeRun.diagnostics);
  state.lastDiagnostics.set(sessionId, cloneTurnDiagnostics(activeRun.diagnostics));
  return cloneTurnDiagnostics(activeRun.diagnostics);
}

function applyRunDiagnosticUpdate(
  sessionId: string,
  update: SessionAgentTurnDiagnosticUpdate,
): SessionAgentTurnDiagnostics | null {
  const now = new Date().toISOString();
  return updateRunDiagnostics(sessionId, (diagnostics) => {
    diagnostics.updatedAt = now;
    diagnostics.currentStepKey = update.status === 'running' ? update.key : diagnostics.currentStepKey;

    const existingStep = diagnostics.steps.find((step) => step.key === update.key);
    if (existingStep) {
      existingStep.label = update.label;
      existingStep.status = update.status;
      existingStep.detail = update.detail ?? existingStep.detail ?? null;
      if (!existingStep.startedAt) {
        existingStep.startedAt = now;
      }
      if (update.status === 'completed' || update.status === 'failed') {
        existingStep.completedAt = now;
        existingStep.durationMs = Math.max(
          0,
          new Date(now).getTime() - new Date(existingStep.startedAt).getTime(),
        );
        if (diagnostics.currentStepKey === update.key) {
          diagnostics.currentStepKey = null;
        }
      }
      return;
    }

    diagnostics.steps.push({
      key: update.key,
      label: update.label,
      status: update.status,
      startedAt: now,
      completedAt: update.status === 'completed' || update.status === 'failed' ? now : null,
      durationMs: update.status === 'completed' || update.status === 'failed' ? 0 : null,
      detail: update.detail ?? null,
    });
    if (update.status !== 'running') {
      diagnostics.currentStepKey = null;
    }
  });
}

function updateRunDiagnosticsForRuntimeState(
  sessionId: string,
  runState: SessionAgentRunState,
  timestamp: string,
): SessionAgentTurnDiagnostics | null {
  return updateRunDiagnostics(sessionId, (diagnostics) => {
    diagnostics.runState = runState;
    diagnostics.updatedAt = timestamp;

    if (runState === 'running') {
      diagnostics.startedAt = timestamp;
      diagnostics.completedAt = null;
      diagnostics.timeToTurnStartMs = Math.max(
        0,
        new Date(timestamp).getTime() - new Date(diagnostics.queuedAt).getTime(),
      );
      diagnostics.currentStepKey = null;
      return;
    }

    if (runState === 'completed' || runState === 'cancelled' || runState === 'error') {
      diagnostics.completedAt = timestamp;
      diagnostics.currentStepKey = null;
    }
  });
}

async function resolveSessionGitAuthEnv(metadata: NonNullable<Awaited<ReturnType<typeof getSessionMetadata>>>): Promise<Record<string, string>> {
  const launchContextResult = await readSessionLaunchContext(metadata.sessionName).catch(() => null);
  const launchContextRepoPaths = (launchContextResult?.success ? (launchContextResult.context?.projectRepoPaths ?? []) : [])
    .map((entry) => entry.trim())
    .filter(Boolean);
  const discoveryResult = launchContextRepoPaths.length > 0
    ? null
    : await discoverProjectGitRepos(metadata.projectPath).catch(() => null);
  const repoPaths = resolveSessionTerminalRepoPaths({
    sessionRepoPaths: metadata.gitRepos.map((repo) => repo.sourceRepoPath),
    discoveredProjectRepoPaths: launchContextRepoPaths.length > 0
      ? launchContextRepoPaths
      : (discoveryResult?.repos.map((repo) => repo.repoPath) ?? null),
    activeRepoPath: metadata.activeRepoPath,
    projectPath: metadata.projectPath,
  });
  const environments = await resolveGitSessionEnvironments(repoPaths);

  return Object.fromEntries(environments.map((entry) => [entry.name, entry.value]));
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

    if (itemType === 'userMessage') {
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

  getLatestAssistantText() {
    let latestAssistant: SessionAgentHistoryItem | null = null;

    for (const entry of this.entries.values()) {
      if (entry.kind !== 'assistant') {
        continue;
      }

      if (!latestAssistant || entry.ordinal >= latestAssistant.ordinal) {
        latestAssistant = entry;
      }
    }

    return latestAssistant?.text ?? null;
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
  const snapshot = enrichSessionRuntimeWithDiagnostics(sessionId, readSessionRuntime(sessionId));
  if (!snapshot) {
    return;
  }

  await publishSessionAgentEvent({
    sessionId,
    snapshot,
    event,
  });
}

async function publishDiagnosticEvent(
  sessionId: string,
  update: SessionAgentTurnDiagnosticUpdate,
) {
  const snapshot = enrichSessionRuntimeWithDiagnostics(sessionId, readSessionRuntime(sessionId));
  if (!snapshot) {
    return;
  }

  await publishSessionAgentEvent({
    sessionId,
    snapshot,
    event: {
      type: 'turn_diagnostic',
      ...update,
    },
  });
}

async function publishDerivedNotification(
  sessionId: string,
  event: ChatStreamEvent,
  latestAssistantText?: string | null,
) {
  const snapshot = readSessionRuntime(sessionId);
  if (!snapshot) {
    return;
  }

  const notification = deriveSessionNotificationFromRuntime({
    sessionId,
    snapshot,
    event,
    latestAssistantText,
  });
  if (!notification) {
    return;
  }

  await publishSessionNotification(notification);
}

export function isSessionTurnRunning(sessionId: string) {
  return getManagerState().runs.has(sessionId);
}

export async function listSessionTurnSubprocesses(sessionId: string): Promise<{
  success: boolean;
  runtimePid?: number | null;
  subprocesses?: SessionAgentRuntimeSubprocess[];
  error?: string;
}> {
  const normalizedSessionId = normalizeText(sessionId);
  if (!normalizedSessionId) {
    return { success: false, error: 'sessionId is required.' };
  }

  const activeRun = getManagerState().runs.get(normalizedSessionId);
  if (!activeRun || !activeRun.runtimePid) {
    return {
      success: true,
      runtimePid: activeRun?.runtimePid ?? null,
      subprocesses: [],
    };
  }

  try {
    const processTable = await readRuntimeProcessTable();
    const descendants = collectDescendantProcesses(processTable, activeRun.runtimePid)
      .map(toRuntimeSubprocess);

    return {
      success: true,
      runtimePid: activeRun.runtimePid,
      subprocesses: descendants,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list runtime subprocesses.',
    };
  }
}

export async function terminateSessionTurnSubprocess(
  sessionId: string,
  pid: number,
): Promise<{
  success: boolean;
  terminated?: boolean;
  error?: string;
}> {
  const normalizedSessionId = normalizeText(sessionId);
  if (!normalizedSessionId) {
    return { success: false, error: 'sessionId is required.' };
  }

  if (!Number.isInteger(pid) || pid <= 0) {
    return { success: false, error: 'pid must be a positive integer.' };
  }

  const activeRun = getManagerState().runs.get(normalizedSessionId);
  if (!activeRun || !activeRun.runtimePid) {
    return { success: false, error: 'No active runtime process is available for this session.' };
  }

  try {
    const processTable = await readRuntimeProcessTable();
    const descendants = collectDescendantProcesses(processTable, activeRun.runtimePid);
    const allowedPids = new Set(descendants.map((entry) => entry.pid));
    if (!allowedPids.has(pid)) {
      return {
        success: false,
        error: 'Refusing to terminate a process outside this active agent runtime.',
      };
    }

    const terminated = await terminateProcessGracefully({ pid });
    if (!terminated) {
      return {
        success: false,
        error: `Failed to terminate subprocess ${pid}.`,
      };
    }

    return {
      success: true,
      terminated: true,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to terminate runtime subprocess.',
    };
  }
}

export async function startSessionTurn(input: StartTurnInput): Promise<{
  success: boolean;
  runtime?: SessionAgentRuntimeState | null;
  error?: string;
}> {
  const sessionId = normalizeText(input.sessionId);
  const attachmentPaths = normalizeAttachmentPaths(input.attachmentPaths);
  const userMessage = normalizeText(input.message);
  const message = appendAttachmentPathsToMessage(userMessage, attachmentPaths);
  const displayMessageInput = normalizeText(input.displayMessage ?? input.message);
  const displayMessage = displayMessageInput || buildAttachmentOnlyDisplayMessage(attachmentPaths);

  if (!sessionId) {
    return { success: false, error: 'sessionId is required.' };
  }

  if (!message) {
    return { success: false, error: 'message or attachmentPaths is required.' };
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
  const extraEnv = await resolveSessionGitAuthEnv(metadata);

  const adapter = getAgentAdapter(provider as AgentProvider);
  const existingHistory = listSessionHistory(sessionId);
  const projector = new HistoryProjector(sessionId, existingHistory);
  projector.addUserMessage(displayMessage || message);

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
  const diagnostics = createTurnDiagnostics(provider as AgentProvider, startedAt);
  state.lastDiagnostics.set(sessionId, cloneTurnDiagnostics(diagnostics));
  await publishSessionListUpdated();

  const abortController = new AbortController();
  const activeRun: ActiveRun = {
    abortController,
    promise: Promise.resolve(),
    diagnostics,
    runtimePid: null,
  };
  state.runs.set(sessionId, activeRun);
  const promise = (async () => {
    try {
      await adapter.streamChat({
        workspacePath: metadata.workspacePath,
        threadId: metadata.threadId ?? null,
        message,
        model: metadata.model || null,
        reasoningEffort: metadata.reasoningEffort ?? null,
        extraEnv,
      }, async (event) => {
        projector.applyEvent(event as ChatStreamEvent);

        const now = new Date().toISOString();
        updateSessionRuntime(sessionId, await resolveSessionRuntimeUpdate({
          outcome: {
            kind: 'event',
            event: event as ChatStreamEvent,
          },
          timestamp: now,
          loadStatus: async (providerId) => await getAgentAdapter(providerId).getStatus(),
        }));
        if (event.type === 'turn_started') {
          updateRunDiagnosticsForRuntimeState(sessionId, 'running', now);
        } else if (event.type === 'turn_completed') {
          const completionState = event.error
            ? (event.error === 'Request cancelled.' ? 'cancelled' : 'error')
            : (event.status === 'cancelled'
                ? 'cancelled'
                : (event.status === 'failed' || event.status === 'error' ? 'error' : 'completed'));
          updateRunDiagnosticsForRuntimeState(sessionId, completionState, now);
        }

        await publishRuntimeEvent(sessionId, event as ChatStreamEvent);
        await publishDerivedNotification(sessionId, event as ChatStreamEvent, projector.getLatestAssistantText());
      }, abortController.signal, (update) => {
        applyRunDiagnosticUpdate(sessionId, update);
        void publishDiagnosticEvent(sessionId, update);
      }, (runtimeUpdate) => {
        const runtimePid = runtimeUpdate.runtimePid;
        if (runtimePid === null || !Number.isInteger(runtimePid) || runtimePid <= 0) {
          return;
        }
        activeRun.runtimePid = runtimePid;
      });
    } catch (error) {
      const messageText = error instanceof Error ? error.message : 'Agent turn failed.';
      const failureTimestamp = new Date().toISOString();
      const failureEvent: ChatStreamEvent = {
        type: 'error',
        message: abortController.signal.aborted ? 'Request cancelled.' : messageText,
      };
      const runtime = updateSessionRuntime(sessionId, await resolveSessionRuntimeUpdate({
        outcome: {
          kind: 'failure',
          provider,
          aborted: abortController.signal.aborted,
          message: messageText,
        },
        timestamp: failureTimestamp,
        loadStatus: async (providerId) => await getAgentAdapter(providerId).getStatus(),
      }));
      updateRunDiagnosticsForRuntimeState(
        sessionId,
        abortController.signal.aborted ? 'cancelled' : 'error',
        failureTimestamp,
      );

      if (runtime) {
        await publishSessionAgentEvent({
          sessionId,
          snapshot: enrichSessionRuntimeWithDiagnostics(sessionId, runtime) ?? runtime,
          event: failureEvent,
        });
        await publishDerivedNotification(sessionId, failureEvent, projector.getLatestAssistantText());
      }
    } finally {
      await terminateRuntimeDescendants(activeRun.runtimePid);
      state.runs.delete(sessionId);
      await publishSessionListUpdated();
    }
  })();
  activeRun.promise = promise;

  void promise.catch(() => {});

  return {
    success: true,
    runtime: enrichSessionRuntimeWithDiagnostics(sessionId, initialRuntime),
  };
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
      runtime: enrichSessionRuntimeWithDiagnostics(normalizedSessionId, readSessionRuntime(normalizedSessionId)),
    };
  }

  active.abortController.abort();
  const cancelledAt = new Date().toISOString();
  const runtime = updateSessionRuntime(normalizedSessionId, {
    activeTurnId: null,
    runState: 'cancelled',
    lastError: 'Request cancelled.',
    lastActivityAt: cancelledAt,
  });
  updateRunDiagnosticsForRuntimeState(normalizedSessionId, 'cancelled', cancelledAt);

  if (runtime) {
    await publishSessionAgentEvent({
      sessionId: normalizedSessionId,
      snapshot: enrichSessionRuntimeWithDiagnostics(normalizedSessionId, runtime) ?? runtime,
      event: {
        type: 'error',
        message: 'Request cancelled.',
      },
    });
  }

  return {
    success: true,
    runtime: enrichSessionRuntimeWithDiagnostics(normalizedSessionId, runtime) ?? runtime,
  };
}

export async function getAgentSessionSnapshot(sessionId: string) {
  const result = await getSessionAgentSnapshot(sessionId);
  if (!result.success || !result.snapshot) {
    return result;
  }

  return {
    ...result,
    snapshot: {
      ...result.snapshot,
      runtime: enrichSessionRuntimeWithDiagnostics(sessionId, result.snapshot.runtime) ?? result.snapshot.runtime,
    },
  };
}
