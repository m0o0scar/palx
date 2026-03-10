import assert from 'node:assert';
import { describe, it } from 'node:test';

import { buildAcpSpawnEnv, buildCodexAppServerEnv } from '../spawn-env.ts';

describe('provider spawn env helpers', () => {
  it('includes session git auth env for Codex app-server spawns', () => {
    const env = buildCodexAppServerEnv({
      GITHUB_TOKEN: 'ghu_test',
      GITLAB_TOKEN: 'glpat_test',
    });

    assert.strictEqual(env['GITHUB_TOKEN'], 'ghu_test');
    assert.strictEqual(env['GITLAB_TOKEN'], 'glpat_test');
  });

  it('includes session git auth env for ACP provider spawns', () => {
    const env = buildAcpSpawnEnv({
      GITLAB_TOKEN: 'glpat_test',
      GITLAB_HOST: 'gitlab.corp.example',
    });

    assert.strictEqual(env['GITLAB_TOKEN'], 'glpat_test');
    assert.strictEqual(env['GITLAB_HOST'], 'gitlab.corp.example');
  });
});
