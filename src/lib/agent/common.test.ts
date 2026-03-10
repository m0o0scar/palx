import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { defaultSpawnEnv, resolveExecutable } from './common.ts';

describe('defaultSpawnEnv', () => {
  it('merges extra env without dropping PATH handling', () => {
    const env = defaultSpawnEnv({
      GITHUB_TOKEN: 'ghu_test',
      GITLAB_HOST: 'gitlab.corp.example',
    });

    assert.strictEqual(env['GITHUB_TOKEN'], 'ghu_test');
    assert.strictEqual(env['GITLAB_HOST'], 'gitlab.corp.example');
    assert.ok(typeof env.PATH === 'string' && env.PATH.length > 0);
    assert.match(env.PATH, new RegExp(path.join(os.homedir(), '.local', 'bin').replace(/\\/g, '\\\\')));
  });
});

describe('resolveExecutable', () => {
  it('prefers a Windows .cmd shim when present on PATH', () => {
    const fakeBinDir = path.join(os.tmpdir(), 'viba-agent-common-test-bin');
    const env = {
      PATH: fakeBinDir,
    } as NodeJS.ProcessEnv;

    const originalExistsSync = require('node:fs').existsSync as (candidate: string) => boolean;
    const seenCandidates: string[] = [];

    require('node:fs').existsSync = ((candidate: string) => {
      seenCandidates.push(candidate);
      return candidate === path.join(fakeBinDir, 'codex.cmd');
    }) as typeof originalExistsSync;

    try {
      const resolved = resolveExecutable(['codex', 'codex.cmd'], env);
      assert.strictEqual(resolved, path.join(fakeBinDir, 'codex.cmd'));
      assert.ok(seenCandidates.includes(path.join(fakeBinDir, 'codex.cmd')));
    } finally {
      require('node:fs').existsSync = originalExistsSync;
    }
  });
});
