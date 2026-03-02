import assert from 'node:assert';
import { describe, it } from 'node:test';
import { buildPullAllPlan, buildPullAllToastPayload, parseTrackingUpstream } from './pull-all-utils.ts';

describe('pull-all-utils', () => {
  it('parses valid upstream refs', () => {
    assert.deepStrictEqual(parseTrackingUpstream('origin/main'), { remote: 'origin', branch: 'main' });
    assert.deepStrictEqual(parseTrackingUpstream('upstream/feature/login'), { remote: 'upstream', branch: 'feature/login' });
  });

  it('returns null for invalid upstream refs', () => {
    assert.strictEqual(parseTrackingUpstream(''), null);
    assert.strictEqual(parseTrackingUpstream('origin'), null);
    assert.strictEqual(parseTrackingUpstream('/main'), null);
    assert.strictEqual(parseTrackingUpstream('origin/'), null);
  });

  it('builds pull-all targets and skips branches without valid tracking', () => {
    const plan = buildPullAllPlan(
      ['main', 'feature', 'local-only', 'broken-upstream'],
      {
        main: { upstream: 'origin/main', ahead: 0, behind: 0 },
        feature: { upstream: 'upstream/feature', ahead: 1, behind: 2 },
        'broken-upstream': { upstream: 'origin', ahead: 0, behind: 0 },
      },
    );

    assert.deepStrictEqual(plan.targets, [
      { localBranch: 'main', remote: 'origin', remoteBranch: 'main' },
      { localBranch: 'feature', remote: 'upstream', remoteBranch: 'feature' },
    ]);
    assert.deepStrictEqual(plan.skippedBranches, ['local-only', 'broken-upstream']);
  });

  it('creates a warning payload when some tracked branches fail', () => {
    const payload = buildPullAllToastPayload({
      pulledBranches: ['main'],
      failedBranches: [{ localBranch: 'feature', message: 'rebase conflict' }],
      skippedBranches: ['local-only'],
    });

    assert.strictEqual(payload.type, 'warning');
    assert.strictEqual(payload.title, 'Pull All Completed with Warnings');
    assert.match(payload.description, /Pulled 1 tracked branch/);
    assert.match(payload.description, /Failed to pull 1 tracked branch/);
    assert.match(payload.description, /feature: rebase conflict/);
    assert.match(payload.description, /Skipped 1 branch without tracking remote branches/);
    assert.strictEqual(payload.duration, 12000);
  });
});
