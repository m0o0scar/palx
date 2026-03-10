import assert from 'node:assert';
import { describe, it } from 'node:test';

import { deriveSessionNotificationFromRuntime } from './session-agent-notifications.ts';
import type { ChatStreamEvent, SessionAgentRuntimeState } from './types.ts';

function createRuntimeState(
  overrides: Partial<SessionAgentRuntimeState> = {},
): SessionAgentRuntimeState {
  return {
    sessionName: 'session-1',
    agentProvider: 'codex',
    model: 'gpt-5',
    reasoningEffort: 'medium',
    threadId: 'thread-1',
    activeTurnId: null,
    runState: 'idle',
    lastError: null,
    lastActivityAt: '2026-03-09T00:00:00.000Z',
    ...overrides,
  };
}

function createTurnCompletedEvent(
  overrides: Partial<Extract<ChatStreamEvent, { type: 'turn_completed' }>> = {},
): Extract<ChatStreamEvent, { type: 'turn_completed' }> {
  return {
    type: 'turn_completed',
    threadId: 'thread-1',
    turnId: 'turn-1',
    status: 'completed',
    error: null,
    ...overrides,
  };
}

describe('deriveSessionNotificationFromRuntime', () => {
  it('emits a completion notification with the latest assistant preview', () => {
    const notification = deriveSessionNotificationFromRuntime({
      sessionId: 'session-1',
      snapshot: createRuntimeState({ agentProvider: 'codex', runState: 'completed' }),
      event: createTurnCompletedEvent(),
      latestAssistantText: 'Implemented the notification flow and updated tests.',
    });

    assert.deepStrictEqual(notification, {
      sessionId: 'session-1',
      title: 'Codex finished',
      description: 'Implemented the notification flow and updated tests.',
    });
  });

  it('falls back to a generic completion description when no assistant preview exists', () => {
    const notification = deriveSessionNotificationFromRuntime({
      sessionId: 'session-1',
      snapshot: createRuntimeState({ agentProvider: 'gemini', runState: 'completed' }),
      event: createTurnCompletedEvent(),
      latestAssistantText: '   ',
    });

    assert.deepStrictEqual(notification, {
      sessionId: 'session-1',
      title: 'Gemini finished',
      description: 'The agent finished its latest turn.',
    });
  });

  it('emits an attention notification for generic errors', () => {
    const notification = deriveSessionNotificationFromRuntime({
      sessionId: 'session-1',
      snapshot: createRuntimeState({
        agentProvider: 'cursor',
        runState: 'error',
        lastError: 'Tool call failed because the workspace is unavailable.',
      }),
      event: createTurnCompletedEvent({ status: 'error' }),
    });

    assert.deepStrictEqual(notification, {
      sessionId: 'session-1',
      title: 'Agent needs attention',
      description: 'Tool call failed because the workspace is unavailable.',
    });
  });

  it('emits a login-required notification when auth is needed', () => {
    const notification = deriveSessionNotificationFromRuntime({
      sessionId: 'session-1',
      snapshot: createRuntimeState({
        agentProvider: 'codex',
        runState: 'needs_auth',
        lastError: 'Sign in to Codex to continue this session.',
      }),
      event: {
        type: 'error',
        message: 'Authentication required.',
      },
    });

    assert.deepStrictEqual(notification, {
      sessionId: 'session-1',
      title: 'Login required',
      description: 'Codex needs you to sign in before it can continue.',
    });
  });

  it('does not emit notifications for cancelled turns', () => {
    const notification = deriveSessionNotificationFromRuntime({
      sessionId: 'session-1',
      snapshot: createRuntimeState({
        runState: 'cancelled',
        lastError: 'Request cancelled.',
      }),
      event: createTurnCompletedEvent({ status: 'cancelled', error: 'Request cancelled.' }),
    });

    assert.strictEqual(notification, null);
  });
});
