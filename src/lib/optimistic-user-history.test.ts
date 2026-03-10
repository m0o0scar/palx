import assert from 'node:assert';
import { describe, it } from 'node:test';
import type { SessionAgentHistoryItem } from './types.ts';
import { reconcileOptimisticUserMessages } from './optimistic-user-history.ts';

function userMessage(text: string, createdAt: string, id = text): SessionAgentHistoryItem {
  return {
    kind: 'user',
    id,
    text,
    sessionName: 'session',
    ordinal: 0,
    createdAt,
    updatedAt: createdAt,
  };
}

describe('reconcileOptimisticUserMessages', () => {
  it('removes optimistic messages once matching server history arrives', () => {
    const optimisticMessages = [
      { id: 'optimistic-1', text: 'Ship it', createdAt: '2026-03-10T10:00:00.000Z' },
    ];

    const history = [
      userMessage('Earlier', '2026-03-10T09:58:00.000Z', 'server-1'),
      userMessage('Ship it', '2026-03-10T10:00:01.000Z', 'server-2'),
    ];

    assert.deepStrictEqual(reconcileOptimisticUserMessages(history, optimisticMessages), []);
  });

  it('keeps the newest optimistic duplicate when only one server match exists', () => {
    const optimisticMessages = [
      { id: 'optimistic-1', text: 'Continue', createdAt: '2026-03-10T10:00:00.000Z' },
      { id: 'optimistic-2', text: 'Continue', createdAt: '2026-03-10T10:00:05.000Z' },
    ];

    const history = [
      userMessage('Continue', '2026-03-10T10:00:01.000Z', 'server-1'),
    ];

    assert.deepStrictEqual(reconcileOptimisticUserMessages(history, optimisticMessages), [
      optimisticMessages[1],
    ]);
  });

  it('ignores older history outside the optimistic match window', () => {
    const optimisticMessages = [
      { id: 'optimistic-1', text: 'Continue', createdAt: '2026-03-10T10:00:00.000Z' },
    ];

    const history = [
      userMessage('Continue', '2026-03-10T09:00:00.000Z', 'server-1'),
    ];

    assert.deepStrictEqual(reconcileOptimisticUserMessages(history, optimisticMessages), optimisticMessages);
  });
});
