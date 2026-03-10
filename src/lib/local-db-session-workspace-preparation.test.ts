import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

type LocalDbModule = typeof import('./local-db.ts');

let tempHome = '';
let previousHome = '';
let previousUserProfile = '';
let localDbModule: LocalDbModule;

before(async () => {
  tempHome = await mkdtemp(path.join(os.tmpdir(), 'palx-local-db-preparation-test-'));
  previousHome = process.env.HOME || '';
  previousUserProfile = process.env.USERPROFILE || '';
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  localDbModule = await import('./local-db.ts');
});

after(async () => {
  process.env.HOME = previousHome;
  process.env.USERPROFILE = previousUserProfile;
  if (tempHome) {
    await rm(tempHome, { recursive: true, force: true });
  }
});

describe('local DB session workspace preparation schema', () => {
  it('creates session_workspace_preparations with expected columns', () => {
    const db = localDbModule.getLocalDb();
    const columns = db.prepare('PRAGMA table_info(session_workspace_preparations)').all() as Array<{
      name: string;
    }>;
    const columnNames = new Set(columns.map((column) => column.name));

    for (const requiredColumn of [
      'preparation_id',
      'project_path',
      'context_fingerprint',
      'session_name',
      'payload_json',
      'status',
      'cancel_requested',
      'created_at',
      'updated_at',
      'expires_at',
      'consumed_at',
      'released_at',
    ]) {
      assert.equal(
        columnNames.has(requiredColumn),
        true,
        `expected session_workspace_preparations.${requiredColumn} to exist`,
      );
    }
  });

  it('adds launch-context repo snapshot columns and preparation indexes', () => {
    const db = localDbModule.getLocalDb();
    const launchColumns = db.prepare('PRAGMA table_info(session_launch_contexts)').all() as Array<{
      name: string;
    }>;
    const launchColumnNames = new Set(launchColumns.map((column) => column.name));

    assert.equal(launchColumnNames.has('project_repo_paths_json'), true);
    assert.equal(launchColumnNames.has('project_repo_relative_paths_json'), true);

    const indexes = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND tbl_name = 'session_workspace_preparations'
    `).all() as Array<{ name: string }>;
    const indexNames = new Set(indexes.map((index) => index.name));

    assert.equal(indexNames.has('session_workspace_preparations_status_idx'), true);
    assert.equal(indexNames.has('session_workspace_preparations_expires_idx'), true);
    assert.equal(indexNames.has('session_workspace_preparations_fingerprint_idx'), true);
  });
});
