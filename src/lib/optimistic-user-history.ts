import type { SessionAgentHistoryItem } from './types.ts';

export type OptimisticUserMessage = {
  id: string;
  text: string;
  createdAt: string;
};

const OPTIMISTIC_HISTORY_MATCH_WINDOW_MS = 30_000;

function parseTimestamp(value: string) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function createOptimisticUserMessage(text: string): OptimisticUserMessage {
  const createdAt = new Date().toISOString();
  return {
    id: `optimistic-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    createdAt,
  };
}

export function reconcileOptimisticUserMessages(
  history: SessionAgentHistoryItem[],
  optimisticMessages: OptimisticUserMessage[],
) {
  if (optimisticMessages.length === 0) {
    return optimisticMessages;
  }

  const optimisticTimestamps = optimisticMessages
    .map((message) => parseTimestamp(message.createdAt))
    .filter((value): value is number => value !== null);
  const oldestOptimisticTimestamp = optimisticTimestamps.length > 0
    ? Math.min(...optimisticTimestamps)
    : null;

  const recentServerMessages = history
    .filter((item): item is SessionAgentHistoryItem & { kind: 'user' } => {
      if (item.kind !== 'user') return false;
      if (oldestOptimisticTimestamp === null) return true;

      const createdAt = parseTimestamp(item.createdAt);
      return createdAt === null || createdAt >= oldestOptimisticTimestamp - OPTIMISTIC_HISTORY_MATCH_WINDOW_MS;
    })
    .map((item) => item.text);

  if (recentServerMessages.length === 0) {
    return optimisticMessages;
  }

  const matchedIndices = new Set<number>();
  let serverIndex = 0;

  for (let optimisticIndex = 0; optimisticIndex < optimisticMessages.length; optimisticIndex += 1) {
    const optimisticText = optimisticMessages[optimisticIndex]?.text;
    while (serverIndex < recentServerMessages.length && recentServerMessages[serverIndex] !== optimisticText) {
      serverIndex += 1;
    }

    if (serverIndex < recentServerMessages.length) {
      matchedIndices.add(optimisticIndex);
      serverIndex += 1;
    }
  }

  if (matchedIndices.size === 0) {
    return optimisticMessages;
  }

  return optimisticMessages.filter((_, index) => !matchedIndices.has(index));
}
