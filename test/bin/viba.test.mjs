import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { getInstallStrategies } from '../../bin/viba.mjs';

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
});
