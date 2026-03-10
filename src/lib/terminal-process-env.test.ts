import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildTerminalProcessEnv } from './terminal-process-env.ts';

describe('buildTerminalProcessEnv', () => {
  it('removes NODE_ENV while preserving unrelated variables', () => {
    const env = buildTerminalProcessEnv({
      PATH: '/usr/bin',
      HOME: '/Users/tester',
      NODE_ENV: 'staging',
      PORT: '3000',
      TURBOPACK: '1',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '1',
      CLICOLOR: '1',
      CLICOLOR_FORCE: '1',
      CUSTOM_FLAG: 'enabled',
    });

    assert.strictEqual(env.NODE_ENV, undefined);
    assert.strictEqual(env.PORT, undefined);
    assert.strictEqual(env.TURBOPACK, undefined);
    assert.strictEqual(env.COLORTERM, undefined);
    assert.strictEqual(env.PATH, '/usr/bin');
    assert.strictEqual(env.HOME, '/Users/tester');
    assert.strictEqual(env.CUSTOM_FLAG, 'enabled');
    assert.strictEqual(env.TERM, 'xterm');
    assert.strictEqual(env.NO_COLOR, '1');
    assert.strictEqual(env.CLICOLOR, '0');
    assert.strictEqual(env.CLICOLOR_FORCE, '0');
    assert.strictEqual(env.FORCE_COLOR, '0');
  });
});
