import assert from 'node:assert';
import { describe, it, mock } from 'node:test';

import { resolveSessionRuntimeUpdate } from './session-runtime-updates.ts';
import type { AppStatus, ChatStreamEvent } from '../types.ts';

function createCompletedEvent(): Extract<ChatStreamEvent, { type: 'turn_completed' }> {
  return {
    type: 'turn_completed',
    threadId: 'thread-1',
    turnId: 'turn-1',
    status: 'completed',
    error: null,
  };
}

function createStatus(overrides: Partial<AppStatus> = {}): AppStatus {
  return {
    provider: 'codex',
    installed: true,
    version: '1.0.0',
    loggedIn: true,
    account: null,
    installCommand: 'codex install',
    models: [],
    defaultModel: null,
    ...overrides,
  };
}

describe('resolveSessionRuntimeUpdate', () => {
  it('does not probe auth status for normal completion events', async () => {
    const loadStatus = mock.fn(async () => createStatus());

    const result = await resolveSessionRuntimeUpdate({
      outcome: {
        kind: 'event',
        event: createCompletedEvent(),
      },
      timestamp: '2026-03-09T00:00:00.000Z',
      loadStatus,
    });

    assert.deepStrictEqual(result, {
      threadId: 'thread-1',
      activeTurnId: null,
      runState: 'completed',
      lastError: null,
      lastActivityAt: '2026-03-09T00:00:00.000Z',
    });
    assert.strictEqual(loadStatus.mock.callCount(), 0);
  });

  it('probes auth status once for terminal stream failures', async () => {
    const loadStatus = mock.fn(async () => createStatus({
      provider: 'gemini',
      loggedIn: false,
    }));

    const result = await resolveSessionRuntimeUpdate({
      outcome: {
        kind: 'failure',
        provider: 'gemini',
        aborted: false,
        message: 'Authentication required.',
      },
      timestamp: '2026-03-09T00:00:00.000Z',
      loadStatus,
    });

    assert.deepStrictEqual(result, {
      activeTurnId: null,
      runState: 'needs_auth',
      lastError: 'Sign in to Gemini to continue this session.',
      lastActivityAt: '2026-03-09T00:00:00.000Z',
    });
    assert.strictEqual(loadStatus.mock.callCount(), 1);
  });
});
