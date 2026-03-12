import assert from 'node:assert';
import { describe, it } from 'node:test';

import type { ChatStreamEvent, SessionAgentHistoryItem } from '../types.ts';
import { projectSessionHistoryEvent } from './session-history-events.ts';

const BASE_TIME = '2026-03-12T00:00:00.000Z';

function createItem(overrides: Partial<SessionAgentHistoryItem>): SessionAgentHistoryItem {
  const kind = overrides.kind ?? 'assistant';
  const defaultPayload = kind === 'assistant'
    ? { text: 'assistant', phase: null }
    : kind === 'tool'
      ? {
          source: 'function' as const,
          server: null,
          tool: 'exec_command',
          status: 'completed',
          input: '{}',
          message: null,
          result: '{}',
          error: null,
        }
      : kind === 'command'
        ? {
            command: 'echo test',
            cwd: '.',
            output: '',
            status: 'completed',
            exitCode: 0,
            toolName: null,
            toolInput: null,
          }
        : kind === 'user'
          ? { text: 'hello' }
          : kind === 'plan'
            ? { text: 'step' }
            : kind === 'reasoning'
              ? { summary: 's', text: 't' }
              : {
                  status: 'completed',
                  output: '',
                  changes: [],
                };

  return {
    sessionName: 'session-1',
    id: overrides.id ?? `${kind}-id`,
    kind,
    threadId: overrides.threadId ?? 'thread-1',
    turnId: overrides.turnId ?? 'turn-1',
    ordinal: overrides.ordinal ?? 0,
    itemStatus: overrides.itemStatus ?? null,
    createdAt: overrides.createdAt ?? BASE_TIME,
    updatedAt: overrides.updatedAt ?? BASE_TIME,
    ...(defaultPayload as Record<string, unknown>),
    ...(overrides as Record<string, unknown>),
  } as SessionAgentHistoryItem;
}

describe('projectSessionHistoryEvent', () => {
  it('appends assistant deltas without refetching the whole history', () => {
    const existing = createItem({
      id: 'assistant-1',
      kind: 'assistant',
      text: 'Hello',
    });

    const event: ChatStreamEvent = {
      type: 'agent_message_delta',
      itemId: 'assistant-1',
      delta: ' world',
      threadId: 'thread-1',
      turnId: 'turn-1',
    };

    const result = projectSessionHistoryEvent([existing], 'session-1', event, '2026-03-12T00:00:01.000Z');
    assert.equal(result.handled, true);
    assert.equal(result.changed, true);
    assert.equal(result.history[0]?.kind, 'assistant');
    assert.equal(result.history[0]?.text, 'Hello world');
    assert.equal(result.history[0]?.updatedAt, '2026-03-12T00:00:01.000Z');
  });

  it('creates command entries from seeds and output deltas', () => {
    const seed: ChatStreamEvent = {
      type: 'command_seed',
      itemId: 'command-1',
      threadId: 'thread-1',
      turnId: 'turn-1',
      command: 'npm test',
      cwd: '/repo',
      toolName: 'exec_command',
      toolInput: '{"cmd":"npm test"}',
    };
    const seeded = projectSessionHistoryEvent([], 'session-1', seed, '2026-03-12T00:00:01.000Z');

    assert.equal(seeded.history[0]?.kind, 'command');
    assert.equal(seeded.history[0]?.command, 'npm test');

    const output: ChatStreamEvent = {
      type: 'command_output_delta',
      itemId: 'command-1',
      delta: 'ok\n',
      threadId: 'thread-1',
      turnId: 'turn-1',
    };
    const updated = projectSessionHistoryEvent(seeded.history, 'session-1', output, '2026-03-12T00:00:02.000Z');

    assert.equal(updated.history[0]?.kind, 'command');
    assert.equal(updated.history[0]?.output, 'ok\n');
    assert.equal(updated.history[0]?.ordinal, seeded.history[0]?.ordinal);
  });

  it('normalizes completed item payloads into timeline items', () => {
    const event: ChatStreamEvent = {
      type: 'item_completed',
      item: {
        id: 'tool-1',
        type: 'mcpToolCall',
        server: 'filesystem',
        tool: 'read_file',
        status: 'completed',
        arguments: { path: '/tmp/demo.txt' },
        result: { ok: true },
        error: null,
      },
      threadId: 'thread-1',
      turnId: 'turn-1',
    };

    const result = projectSessionHistoryEvent([], 'session-1', event, '2026-03-12T00:00:01.000Z');

    assert.equal(result.history[0]?.kind, 'tool');
    assert.equal(result.history[0]?.tool, 'read_file');
    assert.equal(result.history[0]?.server, 'filesystem');
    assert.equal(result.history[0]?.status, 'completed');
  });

  it('ignores provider user message lifecycle items when a local user entry already exists', () => {
    const existing = createItem({
      id: 'local-user-1',
      kind: 'user',
      threadId: null,
      turnId: null,
      text: 'approve',
    });

    const event: ChatStreamEvent = {
      type: 'item_started',
      item: {
        id: 'provider-user-1',
        type: 'userMessage',
        content: [
          {
            type: 'text',
            text: 'approve',
          },
        ],
      },
      threadId: 'thread-1',
      turnId: 'turn-1',
    };

    const result = projectSessionHistoryEvent([existing], 'session-1', event, '2026-03-12T00:00:01.000Z');
    assert.equal(result.handled, false);
    assert.equal(result.changed, false);
    assert.deepStrictEqual(result.history, [existing]);
  });

  it('leaves history untouched for turn lifecycle events', () => {
    const existing = createItem({
      id: 'assistant-1',
      kind: 'assistant',
      text: 'done',
    });

    const event: ChatStreamEvent = {
      type: 'turn_completed',
      threadId: 'thread-1',
      turnId: 'turn-1',
      status: 'completed',
      error: null,
    };

    const result = projectSessionHistoryEvent([existing], 'session-1', event, '2026-03-12T00:00:01.000Z');
    assert.equal(result.handled, true);
    assert.equal(result.changed, false);
    assert.deepStrictEqual(result.history, [existing]);
  });
});
