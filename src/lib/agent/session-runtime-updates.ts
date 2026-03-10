import type { AgentProvider, AppStatus, ChatStreamEvent, SessionAgentRunState } from '../types.ts';

export type SessionRuntimeUpdate = {
  threadId?: string | null;
  activeTurnId?: string | null;
  runState?: SessionAgentRunState | null;
  lastError?: string | null;
  lastActivityAt?: string | null;
};

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

function providerLoginLabel(provider: AgentProvider): string {
  switch (provider) {
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'cursor':
      return 'Cursor';
    default:
      return 'the agent';
  }
}

export async function resolveSessionRuntimeUpdate(params: {
  outcome:
    | {
        kind: 'event';
        event: ChatStreamEvent;
      }
    | {
        kind: 'failure';
        provider: AgentProvider;
        aborted: boolean;
        message: string;
      };
  timestamp: string;
  loadStatus?: (provider: AgentProvider) => Promise<AppStatus>;
}): Promise<SessionRuntimeUpdate> {
  const { outcome, timestamp } = params;
  const loadStatusForProvider = params.loadStatus;

  if (outcome.kind === 'event') {
    switch (outcome.event.type) {
      case 'thread_ready':
        return {
          threadId: outcome.event.threadId,
          lastActivityAt: timestamp,
        };
      case 'turn_started':
        return {
          activeTurnId: outcome.event.turnId,
          runState: 'running',
          lastError: null,
          lastActivityAt: timestamp,
        };
      case 'turn_completed':
        return {
          threadId: outcome.event.threadId,
          activeTurnId: null,
          runState: runtimeStateForCompletion(outcome.event),
          lastError: outcome.event.error,
          lastActivityAt: timestamp,
        };
      case 'error':
        return {
          runState: 'error',
          activeTurnId: null,
          lastError: outcome.event.message,
          lastActivityAt: timestamp,
        };
      default:
        return {
          lastActivityAt: timestamp,
        };
    }
  }

  if (outcome.aborted) {
    return {
      activeTurnId: null,
      runState: 'cancelled',
      lastError: 'Request cancelled.',
      lastActivityAt: timestamp,
    };
  }

  try {
    if (loadStatusForProvider) {
      const status = await loadStatusForProvider(outcome.provider);
      if (!status.loggedIn) {
        return {
          activeTurnId: null,
          runState: 'needs_auth',
          lastError: `Sign in to ${providerLoginLabel(status.provider)} to continue this session.`,
          lastActivityAt: timestamp,
        };
      }
    }
  } catch {
    // Fall back to a generic terminal error when provider status probing fails.
  }

  return {
    activeTurnId: null,
    runState: 'error',
    lastError: outcome.message,
    lastActivityAt: timestamp,
  };
}
