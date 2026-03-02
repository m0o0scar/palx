import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getInstallStrategies, getBrowserOpenCommand, shouldAutoOpenBrowser } from '../../bin/viba.mjs';

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

  it('returns Windows strategies on Win32', () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32'
    });

    const strategies = getInstallStrategies('ttyd');
    assert.strictEqual(strategies.length, 2);
    assert.strictEqual(strategies[0].label, 'winget');
    assert.deepStrictEqual(strategies[0].requiredCommands, ['winget']);
    assert.strictEqual(strategies[0].command, 'winget');
    assert.deepStrictEqual(strategies[0].args, ['install', 'tsl0922.ttyd']);

    assert.strictEqual(strategies[1].label, 'scoop');
    assert.deepStrictEqual(strategies[1].requiredCommands, ['scoop']);
    assert.strictEqual(strategies[1].command, 'scoop');
    assert.deepStrictEqual(strategies[1].args, ['install', 'ttyd']);
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
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'viba-cli-bin-'));
    const symlinkBin = path.join(tempDir, 'viba-cli');

    try {
      fs.symlinkSync(sourceBin, symlinkBin);
      const result = spawnSync(process.execPath, [symlinkBin, '--help'], {
        encoding: 'utf8',
      });

      assert.strictEqual(result.status, 0);
      assert.match(result.stdout, /Usage: viba-cli \[options\]/);
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

  it('returns Windows start command via cmd', () => {
    assert.deepStrictEqual(getBrowserOpenCommand('http://localhost:3200', 'win32'), {
      command: 'cmd',
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
