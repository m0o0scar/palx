import type { SessionAgentHistoryItem } from '@/lib/types';

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function compareTimestamps(a: string, b: string): number {
  const aMs = parseTimestamp(a);
  const bMs = parseTimestamp(b);

  if (Number.isFinite(aMs) && Number.isFinite(bMs) && aMs !== bMs) {
    return aMs - bMs;
  }

  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function sortSessionHistoryForTimeline(items: SessionAgentHistoryItem[]): SessionAgentHistoryItem[] {
  return [...items].sort((left, right) => {
    const createdAtComparison = compareTimestamps(left.createdAt, right.createdAt);
    if (createdAtComparison !== 0) {
      return createdAtComparison;
    }

    const updatedAtComparison = compareTimestamps(left.updatedAt, right.updatedAt);
    if (updatedAtComparison !== 0) {
      return updatedAtComparison;
    }

    if (left.ordinal !== right.ordinal) {
      return left.ordinal - right.ordinal;
    }

    return left.id.localeCompare(right.id);
  });
}
