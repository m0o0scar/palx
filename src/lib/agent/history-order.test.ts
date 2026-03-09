import assert from 'node:assert';
import { describe, it } from 'node:test';

import type { SessionAgentHistoryItem } from '../types.ts';
import { sortSessionHistoryForTimeline } from './history-order.ts';

const BASE_TIME = '2026-03-09T00:00:00.000Z';

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

describe('sortSessionHistoryForTimeline', () => {
  it('moves tool activity ahead of assistant messages inside the same turn', () => {
    const assistant = createItem({
      id: 'assistant-1',
      kind: 'assistant',
      turnId: 'turn-42',
      ordinal: 1,
      text: 'Here is the result.',
    });
    const tool = createItem({
      id: 'tool-1',
      kind: 'tool',
      turnId: 'turn-42',
      ordinal: 2,
      tool: 'exec_command',
    });

    const ordered = sortSessionHistoryForTimeline([assistant, tool]);
    assert.deepStrictEqual(ordered.map((item) => item.id), ['tool-1', 'assistant-1']);
  });

  it('keeps chronological ordering across different turns', () => {
    const olderAssistant = createItem({
      id: 'assistant-old',
      kind: 'assistant',
      turnId: 'turn-old',
      ordinal: 1,
      text: 'older',
    });
    const newerTool = createItem({
      id: 'tool-new',
      kind: 'tool',
      turnId: 'turn-new',
      ordinal: 2,
      tool: 'exec_command',
    });

    const ordered = sortSessionHistoryForTimeline([newerTool, olderAssistant]);
    assert.deepStrictEqual(ordered.map((item) => item.id), ['assistant-old', 'tool-new']);
  });
});
