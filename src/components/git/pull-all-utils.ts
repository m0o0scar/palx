import type { BranchTrackingInfo } from '../../lib/types';

export type PullAllTarget = {
  localBranch: string;
  remote: string;
  remoteBranch: string;
};

export type PullAllFailure = {
  localBranch: string;
  message: string;
};

export type PullAllPlan = {
  targets: PullAllTarget[];
  skippedBranches: string[];
};

export type PullAllToastPayload = {
  type: 'success' | 'warning';
  title: string;
  description: string;
  duration?: number;
};

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 'es'}`;
}

export function parseTrackingUpstream(upstream: string): { remote: string; branch: string } | null {
  const slashIndex = upstream.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= upstream.length - 1) return null;
  return {
    remote: upstream.slice(0, slashIndex),
    branch: upstream.slice(slashIndex + 1),
  };
}

export function buildPullAllPlan(
  branches: string[] | undefined,
  trackingInfoByBranch: Record<string, BranchTrackingInfo> | undefined,
): PullAllPlan {
  const targets: PullAllTarget[] = [];
  const skippedBranches: string[] = [];

  for (const localBranch of branches ?? []) {
    const upstream = trackingInfoByBranch?.[localBranch]?.upstream;
    if (!upstream) {
      skippedBranches.push(localBranch);
      continue;
    }

    const parsed = parseTrackingUpstream(upstream);
    if (!parsed) {
      skippedBranches.push(localBranch);
      continue;
    }

    targets.push({
      localBranch,
      remote: parsed.remote,
      remoteBranch: parsed.branch,
    });
  }

  return { targets, skippedBranches };
}

export function buildPullAllToastPayload(params: {
  pulledBranches: string[];
  failedBranches: PullAllFailure[];
  skippedBranches: string[];
}): PullAllToastPayload {
  const { pulledBranches, failedBranches, skippedBranches } = params;
  const skippedSummary = skippedBranches.length > 0
    ? ` Skipped ${pluralize(skippedBranches.length, 'branch')} without tracking remote branches.`
    : '';

  if (failedBranches.length > 0) {
    const shownFailures = failedBranches.slice(0, 3).map((failure) => `${failure.localBranch}: ${failure.message}`);
    const remainingFailureCount = failedBranches.length - shownFailures.length;
    const remainingSuffix = remainingFailureCount > 0 ? ` (+${remainingFailureCount} more)` : '';

    return {
      type: 'warning',
      title: 'Pull All Completed with Warnings',
      description: `Pulled ${pluralize(pulledBranches.length, 'tracked branch')}. Failed to pull ${pluralize(failedBranches.length, 'tracked branch')}: ${shownFailures.join('; ')}${remainingSuffix}.${skippedSummary}`,
      duration: 12000,
    };
  }

  return {
    type: 'success',
    title: pulledBranches.length === 1 ? 'Pulled 1 Branch' : `Pulled ${pulledBranches.length} Branches`,
    description: `Updated all local branches that have tracking remote branches.${skippedSummary}`,
  };
}
