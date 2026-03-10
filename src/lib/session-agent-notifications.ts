import type { SessionNotificationPayload } from '@/lib/sessionNotificationServer';
import type {
  AgentProvider,
  ChatStreamEvent,
  SessionAgentRunState,
  SessionAgentRuntimeState,
} from '@/lib/types';

const COMPLETION_DESCRIPTION_FALLBACK = 'The agent finished its latest turn.';
const ATTENTION_DESCRIPTION_FALLBACK = 'The agent needs your attention.';
const LOGIN_REQUIRED_TITLE = 'Login required';
const AGENT_ATTENTION_TITLE = 'Agent needs attention';
const MAX_DESCRIPTION_LENGTH = 220;

function providerDisplayName(provider: AgentProvider | null | undefined): string {
  switch (provider) {
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'cursor':
      return 'Cursor';
    default: {
      const value = provider?.trim();
      if (!value) return 'Agent';
      return value.charAt(0).toUpperCase() + value.slice(1);
    }
  }
}

function normalizeNotificationText(value: string | null | undefined): string {
  const collapsed = value?.replace(/\s+/g, ' ').trim() ?? '';
  return collapsed;
}

function truncateText(value: string, maxLength = MAX_DESCRIPTION_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function completionDescription(latestAssistantText?: string | null): string {
  const normalized = normalizeNotificationText(latestAssistantText);
  if (!normalized) {
    return COMPLETION_DESCRIPTION_FALLBACK;
  }

  return truncateText(normalized);
}

function attentionDescription(
  runState: SessionAgentRunState | null | undefined,
  snapshot: SessionAgentRuntimeState,
): string {
  if (runState === 'needs_auth') {
    return `${providerDisplayName(snapshot.agentProvider)} needs you to sign in before it can continue.`;
  }

  const message = normalizeNotificationText(snapshot.lastError);
  if (message) {
    return truncateText(message);
  }

  return ATTENTION_DESCRIPTION_FALLBACK;
}

export function deriveSessionNotificationFromRuntime(params: {
  sessionId: string;
  snapshot: SessionAgentRuntimeState;
  event: ChatStreamEvent;
  latestAssistantText?: string | null;
}): Omit<SessionNotificationPayload, 'type' | 'timestamp'> | null {
  const sessionId = params.sessionId.trim();
  if (!sessionId) {
    return null;
  }

  const runState = params.snapshot.runState ?? null;
  const providerName = providerDisplayName(params.snapshot.agentProvider);

  if (params.event.type === 'turn_completed') {
    if (runState === 'completed') {
      return {
        sessionId,
        title: `${providerName} finished`,
        description: completionDescription(params.latestAssistantText),
      };
    }

    if (runState === 'needs_auth' || runState === 'error') {
      return {
        sessionId,
        title: runState === 'needs_auth' ? LOGIN_REQUIRED_TITLE : AGENT_ATTENTION_TITLE,
        description: attentionDescription(runState, params.snapshot),
      };
    }

    return null;
  }

  if (params.event.type !== 'error') {
    return null;
  }

  if (runState === 'needs_auth' || runState === 'error') {
    return {
      sessionId,
      title: runState === 'needs_auth' ? LOGIN_REQUIRED_TITLE : AGENT_ATTENTION_TITLE,
      description: attentionDescription(runState, params.snapshot),
    };
  }

  return null;
}
