import type { SessionAgentHistoryItem } from '@/lib/types';

function turnScopedHistoryPriority(kind: SessionAgentHistoryItem['kind']): number {
  switch (kind) {
    case 'reasoning':
      return 10;
    case 'plan':
      return 20;
    case 'command':
    case 'tool':
    case 'fileChange':
      return 30;
    case 'assistant':
      return 40;
    default:
      return 25;
  }
}

function compareIsoTimestamps(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function sortSessionHistoryForTimeline(items: SessionAgentHistoryItem[]): SessionAgentHistoryItem[] {
  return [...items].sort((left, right) => {
    const leftTurnId = left.turnId?.trim() ?? '';
    const rightTurnId = right.turnId?.trim() ?? '';

    if (leftTurnId && leftTurnId === rightTurnId) {
      const leftPriority = turnScopedHistoryPriority(left.kind);
      const rightPriority = turnScopedHistoryPriority(right.kind);
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
    }

    if (left.ordinal !== right.ordinal) {
      return left.ordinal - right.ordinal;
    }

    const createdAtComparison = compareIsoTimestamps(left.createdAt, right.createdAt);
    if (createdAtComparison !== 0) {
      return createdAtComparison;
    }

    const updatedAtComparison = compareIsoTimestamps(left.updatedAt, right.updatedAt);
    if (updatedAtComparison !== 0) {
      return updatedAtComparison;
    }

    return left.id.localeCompare(right.id);
  });
}
