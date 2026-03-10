import { describe, it, after, mock } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import { getAppDataDir } from './platform-utils.ts';

describe('getAppDataDir', () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };
  const mockHomeDir = '/home/user';

  const homedirMock = mock.method(os, 'homedir', () => mockHomeDir);

  after(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env = originalEnv;
    homedirMock.mock.restore();
  });

  it('should return correct path for macOS', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });

    const expected = path.join(mockHomeDir, 'Library', 'Application Support', 'trident');
    assert.strictEqual(getAppDataDir(), expected);
  });

  it('should return correct path for Linux', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    delete process.env.XDG_CONFIG_HOME;

    const expected = path.join(mockHomeDir, '.config', 'trident');
    assert.strictEqual(getAppDataDir(), expected);
  });

  it('should use XDG_CONFIG_HOME for Linux if set', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.XDG_CONFIG_HOME = '/custom/config';

    const expected = path.join('/custom/config', 'trident');
    assert.strictEqual(getAppDataDir(), expected);
  });

  it('should return correct path for Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env.APPDATA = 'C:\\Users\\user\\AppData\\Roaming';

    const expected = path.join('C:\\Users\\user\\AppData\\Roaming', 'trident');
    assert.strictEqual(getAppDataDir(), expected);
  });
});
