import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getInstallStrategies, getBrowserOpenCommand, resolveStartupPort, shouldAutoOpenBrowser } from '../../bin/viba.mjs';

describe('getInstallStrategies', () => {
  const originalPlatform = process.platform;

  // Restore platform after all tests
  after(() => {
    Object.defineProperty(process, 'platform', {
      value: originalPlatform
    });
  });

  it('returns Homebrew and MacPorts strategies on Darwin', () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin'
    });

    const strategies = getInstallStrategies('ttyd');
    assert.strictEqual(strategies.length, 2);
    assert.strictEqual(strategies[0].label, 'Homebrew');
    assert.deepStrictEqual(strategies[0].requiredCommands, ['brew']);
    assert.strictEqual(strategies[0].command, 'brew');
    assert.deepStrictEqual(strategies[0].args, ['install', 'ttyd']);

    assert.strictEqual(strategies[1].label, 'MacPorts');
    assert.deepStrictEqual(strategies[1].requiredCommands, ['sudo', 'port']);
    assert.strictEqual(strategies[1].command, 'sudo');
    assert.deepStrictEqual(strategies[1].args, ['port', 'install', 'ttyd']);
  });

  it('returns Linux strategies on Linux', () => {
    Object.defineProperty(process, 'platform', {
      value: 'linux'
    });

    const strategies = getInstallStrategies('ttyd');
    // There are 10 strategies for Linux
    assert.strictEqual(strategies.length, 10);

    const labels = strategies.map((s) => s.label);
    assert.ok(labels.includes('apt-get'));
    assert.ok(labels.includes('sudo apt-get'));
    assert.ok(labels.includes('dnf'));
    assert.ok(labels.includes('sudo dnf'));
    assert.ok(labels.includes('yum'));
    assert.ok(labels.includes('sudo yum'));
    assert.ok(labels.includes('pacman'));
    assert.ok(labels.includes('sudo pacman'));
    assert.ok(labels.includes('zypper'));
    assert.ok(labels.includes('sudo zypper'));
  });

  it('returns Windows strategies on Windows', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32'
    });

    const strategies = getInstallStrategies('ttyd');
    assert.strictEqual(strategies.length, 2);
    assert.strictEqual(strategies[0].label, 'winget');
    assert.strictEqual(strategies[1].label, 'scoop');
  });

  it('returns empty array on unknown platform', () => {
    Object.defineProperty(process, 'platform', {
      value: 'aix' // AIX is a valid platform string but not handled
    });

    const strategies = getInstallStrategies('ttyd');
    assert.strictEqual(strategies.length, 0);
  });

  it('runs when invoked via a symlinked bin path', () => {
    const thisFile = fileURLToPath(import.meta.url);
    const repoRoot = path.resolve(path.dirname(thisFile), '../..');
    const sourceBin = path.join(repoRoot, 'bin', 'viba.mjs');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-pal-bin-'));
    const symlinkBin = path.join(tempDir, 'vibe-pal');

    try {
      try {
        fs.symlinkSync(sourceBin, symlinkBin);
      } catch (error) {
        if (originalPlatform === 'win32' && error && error.code === 'EPERM') {
          return;
        }
        throw error;
      }
      const result = spawnSync(process.execPath, [symlinkBin, '--help'], {
        encoding: 'utf8',
      });

      assert.strictEqual(result.status, 0);
      assert.match(result.stdout, /Usage: vibe-pal \[options\]/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('getBrowserOpenCommand', () => {
  it('returns macOS open command', () => {
    assert.deepStrictEqual(getBrowserOpenCommand('http://localhost:3200', 'darwin'), {
      command: 'open',
      args: ['http://localhost:3200'],
    });
  });

  it('returns Linux xdg-open command', () => {
    assert.deepStrictEqual(getBrowserOpenCommand('http://localhost:3200', 'linux'), {
      command: 'xdg-open',
      args: ['http://localhost:3200'],
    });
  });

  it('returns Windows start command', () => {
    assert.deepStrictEqual(getBrowserOpenCommand('http://localhost:3200', 'win32'), {
      command: 'cmd.exe',
      args: ['/c', 'start', '', 'http://localhost:3200'],
    });
  });

  it('returns null for unsupported platform', () => {
    assert.strictEqual(getBrowserOpenCommand('http://localhost:3200', 'aix'), null);
  });
});

describe('shouldAutoOpenBrowser', () => {
  it('defaults to enabled', () => {
    assert.strictEqual(shouldAutoOpenBrowser({}), true);
  });

  it('disables in dev mode by default', () => {
    assert.strictEqual(shouldAutoOpenBrowser({}, 'dev'), false);
  });

  it('disables when BROWSER is none', () => {
    assert.strictEqual(shouldAutoOpenBrowser({ BROWSER: 'none' }), false);
  });

  it('disables when BROWSER is falsey string', () => {
    assert.strictEqual(shouldAutoOpenBrowser({ BROWSER: 'false' }), false);
    assert.strictEqual(shouldAutoOpenBrowser({ BROWSER: '0' }), false);
  });
});

describe('resolveStartupPort', () => {
  it('uses the probe fallback for dev mode when the port is not explicit', async () => {
    let fallbackBase = null;

    const result = await resolveStartupPort(
      { mode: 'dev' },
      {
        findAvailablePortImpl: async (port) => {
          fallbackBase = port;
          return port + 3;
        },
      },
    );

    assert.strictEqual(fallbackBase, 3200);
    assert.deepStrictEqual(result, { preferredPort: 3200, port: 3203 });
  });

  it('uses the probe fallback outside dev mode when the port is not explicit', async () => {
    let fallbackBase = null;

    const result = await resolveStartupPort(
      { mode: 'start' },
      {
        findAvailablePortImpl: async (port) => {
          fallbackBase = port;
          return port + 1;
        },
      },
    );

    assert.strictEqual(fallbackBase, 3200);
    assert.deepStrictEqual(result, { preferredPort: 3200, port: 3201 });
  });

  it('honors an explicit CLI port without allocating a different one', async () => {
    let allocatorCalled = false;

    const result = await resolveStartupPort(
      { mode: 'dev', port: 4100, portExplicit: true },
      {
        findAvailablePortImpl: async () => {
          allocatorCalled = true;
          return 0;
        },
      },
    );

    assert.strictEqual(allocatorCalled, false);
    assert.deepStrictEqual(result, { preferredPort: 4100, port: 4100 });
  });

  it('honors PORT from the environment without reallocating it', async () => {
    let allocatorCalled = false;

    const result = await resolveStartupPort(
      { mode: 'dev', env: { PORT: '4300' } },
      {
        findAvailablePortImpl: async () => {
          allocatorCalled = true;
          return 0;
        },
      },
    );

    assert.strictEqual(allocatorCalled, false);
    assert.deepStrictEqual(result, { preferredPort: 4300, port: 4300 });
  });
});
