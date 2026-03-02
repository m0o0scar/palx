import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  applyThemeToTerminalWindow,
  normalizeThemeMode,
  readThemeModeFromStorage,
  resolveShouldUseDarkTheme,
  resolveTerminalTheme,
  TERMINAL_THEME_DARK,
  TERMINAL_THEME_LIGHT,
} from './ttyd-theme.ts';

describe('normalizeThemeMode', () => {
  it('returns auto for missing or invalid values', () => {
    assert.strictEqual(normalizeThemeMode(undefined), 'auto');
    assert.strictEqual(normalizeThemeMode(null), 'auto');
    assert.strictEqual(normalizeThemeMode('invalid'), 'auto');
  });

  it('returns known values as-is', () => {
    assert.strictEqual(normalizeThemeMode('auto'), 'auto');
    assert.strictEqual(normalizeThemeMode('light'), 'light');
    assert.strictEqual(normalizeThemeMode('dark'), 'dark');
  });
});

describe('readThemeModeFromStorage', () => {
  it('reads valid mode values from storage', () => {
    const storage = {
      getItem: () => 'dark',
    };
    assert.strictEqual(readThemeModeFromStorage(storage), 'dark');
  });

  it('falls back to auto when storage throws', () => {
    const storage = {
      getItem: () => {
        throw new Error('unavailable');
      },
    };
    assert.strictEqual(readThemeModeFromStorage(storage), 'auto');
  });
});

describe('resolveShouldUseDarkTheme', () => {
  it('always honors explicit modes', () => {
    assert.strictEqual(resolveShouldUseDarkTheme('dark', false), true);
    assert.strictEqual(resolveShouldUseDarkTheme('light', true), false);
  });

  it('follows prefers-color-scheme in auto mode', () => {
    assert.strictEqual(resolveShouldUseDarkTheme('auto', true), true);
    assert.strictEqual(resolveShouldUseDarkTheme('auto', false), false);
  });
});

describe('resolveTerminalTheme', () => {
  it('returns dark or light palette from resolved mode', () => {
    assert.strictEqual(resolveTerminalTheme('auto', true), TERMINAL_THEME_DARK);
    assert.strictEqual(resolveTerminalTheme('auto', false), TERMINAL_THEME_LIGHT);
  });

  it('keeps monochrome ANSI mapping while switching only fg/bg between modes', () => {
    assert.notStrictEqual(TERMINAL_THEME_LIGHT.background, TERMINAL_THEME_DARK.background);
    assert.notStrictEqual(TERMINAL_THEME_LIGHT.foreground, TERMINAL_THEME_DARK.foreground);

    assert.strictEqual(TERMINAL_THEME_LIGHT.red, TERMINAL_THEME_LIGHT.foreground);
    assert.strictEqual(TERMINAL_THEME_LIGHT.brightBlue, TERMINAL_THEME_LIGHT.foreground);
    assert.strictEqual(TERMINAL_THEME_DARK.red, TERMINAL_THEME_DARK.foreground);
    assert.strictEqual(TERMINAL_THEME_DARK.brightBlue, TERMINAL_THEME_DARK.foreground);
  });
});

describe('applyThemeToTerminalWindow', () => {
  it('returns false when window has no terminal instance', () => {
    assert.strictEqual(applyThemeToTerminalWindow({} as Window, TERMINAL_THEME_DARK), false);
  });

  it('applies theme, refreshes terminal, and syncs container colors', () => {
    let cleared = 0;
    const refreshCalls: Array<[number, number]> = [];

    const root = { style: {} as Record<string, string> };
    const body = { style: {} as Record<string, string> };
    const xterm = { style: {} as Record<string, string> };
    const viewport = { style: {} as Record<string, string> };

    const terminalWindow = {
      document: {
        documentElement: root,
        body,
        querySelectorAll: (selector: string) => {
          if (selector === '.xterm') return [xterm];
          if (selector === '.xterm-viewport') return [viewport];
          return [];
        },
      },
      term: {
        options: {
          theme: { background: '#fff' },
        },
        rows: 20,
        clearTextureAtlas: () => {
          cleared += 1;
        },
        refresh: (start: number, end: number) => {
          refreshCalls.push([start, end]);
        },
      },
    } as unknown as Window;

    const applied = applyThemeToTerminalWindow(terminalWindow, TERMINAL_THEME_DARK);

    assert.strictEqual(applied, true);
    assert.strictEqual(cleared, 1);
    assert.deepStrictEqual(refreshCalls, [[0, 19]]);
    assert.strictEqual(root.style.backgroundColor, TERMINAL_THEME_DARK.background);
    assert.strictEqual(body.style.backgroundColor, TERMINAL_THEME_DARK.background);
    assert.strictEqual(xterm.style.backgroundColor, TERMINAL_THEME_DARK.background);
    assert.strictEqual(viewport.style.backgroundColor, TERMINAL_THEME_DARK.background);
    assert.strictEqual(viewport.style.overflow, 'hidden');
    assert.strictEqual(xterm.style.color, TERMINAL_THEME_DARK.foreground);
  });

  it('does not throw if refresh helpers are unavailable', () => {
    const terminalWindow = {
      term: {
        options: {
          theme: {},
        },
      },
    } as unknown as Window;

    assert.strictEqual(applyThemeToTerminalWindow(terminalWindow, TERMINAL_THEME_LIGHT), true);
  });

  it('installs a one-time ANSI write filter that strips only background styles', () => {
    const writes: string[] = [];
    const resizeCalls: Array<[number, number]> = [];

    const terminalWindow = {
      term: {
        options: {
          theme: {},
        },
        cols: 120,
        rows: 30,
        resize: (cols: number, rows: number) => {
          resizeCalls.push([cols, rows]);
        },
        write: (data: string) => {
          writes.push(data);
        },
      },
    } as unknown as Window;

    assert.strictEqual(applyThemeToTerminalWindow(terminalWindow, TERMINAL_THEME_DARK), true);
    assert.strictEqual(applyThemeToTerminalWindow(terminalWindow, TERMINAL_THEME_LIGHT), true);
    assert.deepStrictEqual(writes, ['\x1b[0m']);
    assert.deepStrictEqual(resizeCalls, [[120, 29], [120, 30]]);

    const term = (terminalWindow as unknown as { term: { write: (data: string) => void } }).term;
    term.write('\x1b[31;47mhello\x1b[0m');
    assert.strictEqual(writes[1], '\x1b[31mhello\x1b[0m');

    term.write('\x1b[48;2;10;20;30mBG\x1b[38;2;1;2;3mFG');
    assert.strictEqual(writes[2], 'BG\x1b[38;2;1;2;3mFG');

    term.write('\x1b]11;#ffffff\x07plain');
    assert.strictEqual(writes[3], 'plain');

    term.write('\x1b[31;47');
    term.write('mX');
    assert.strictEqual(writes[4], '\x1b[31mX');

    term.write(Uint8Array.from([
      0x1b, 0x5b, 0x33, 0x31, 0x3b, 0x34, 0x37, 0x6d, // ESC[31;47m
      0x42, 0x59, 0x54, 0x45, 0x53, // BYTES
      0x1b, 0x5b, 0x30, 0x6d, // ESC[0m
    ]) as unknown as string);
    assert.strictEqual(writes[5], '\x1b[31mBYTES\x1b[0m');
  });

  it('defers repaint until rows are ready to avoid blank initial render', () => {
    let cleared = 0;
    const refreshCalls: Array<[number, number]> = [];
    const frameCallbacks: Array<() => void> = [];

    const term = {
      options: {
        theme: {},
      },
      rows: 0,
      clearTextureAtlas: () => {
        cleared += 1;
      },
      refresh: (start: number, end: number) => {
        refreshCalls.push([start, end]);
      },
    };

    const terminalWindow = {
      term,
      requestAnimationFrame: (callback: () => void) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
    } as unknown as Window;

    assert.strictEqual(applyThemeToTerminalWindow(terminalWindow, TERMINAL_THEME_DARK), true);
    assert.strictEqual(cleared, 0);
    assert.deepStrictEqual(refreshCalls, []);
    assert.strictEqual(frameCallbacks.length, 1);

    term.rows = 3;
    const callback = frameCallbacks.shift();
    callback?.();

    assert.strictEqual(cleared, 1);
    assert.deepStrictEqual(refreshCalls, [[0, 2]]);
  });

  it('emits focus-gained sequence when focus reporting is enabled', () => {
    const triggerCalls: Array<[string, boolean | undefined]> = [];
    const terminalWindow = {
      term: {
        options: {
          theme: {},
        },
        _core: {
          coreService: {
            decPrivateModes: {
              sendFocus: true,
            },
            triggerDataEvent: (data: string, wasUserInput?: boolean) => {
              triggerCalls.push([data, wasUserInput]);
            },
          },
        },
      },
    } as unknown as Window;

    assert.strictEqual(applyThemeToTerminalWindow(terminalWindow, TERMINAL_THEME_DARK), true);
    assert.deepStrictEqual(triggerCalls, [['\x1b[I', true]]);
  });

  it('does not emit focus-gained sequence when focus reporting is disabled', () => {
    const triggerCalls: Array<[string, boolean | undefined]> = [];
    const terminalWindow = {
      term: {
        options: {
          theme: {},
        },
        _core: {
          coreService: {
            decPrivateModes: {
              sendFocus: false,
            },
            triggerDataEvent: (data: string, wasUserInput?: boolean) => {
              triggerCalls.push([data, wasUserInput]);
            },
          },
        },
      },
    } as unknown as Window;

    assert.strictEqual(applyThemeToTerminalWindow(terminalWindow, TERMINAL_THEME_LIGHT), true);
    assert.deepStrictEqual(triggerCalls, []);
  });

  it('nudges focused xterm input to force a real focus lifecycle refresh', () => {
    let blurCalls = 0;
    let focusCalls = 0;
    const triggerCalls: Array<[string, boolean | undefined]> = [];

    const textarea = {
      blur: () => {
        blurCalls += 1;
      },
      focus: () => {
        focusCalls += 1;
      },
    };

    const terminalWindow = {
      document: {
        activeElement: textarea,
        hasFocus: () => true,
        querySelector: (selector: string) => {
          if (selector === 'textarea.xterm-helper-textarea') return textarea;
          return null;
        },
      },
      term: {
        options: {
          theme: {},
        },
        _core: {
          coreService: {
            decPrivateModes: {
              sendFocus: true,
            },
            triggerDataEvent: (data: string, wasUserInput?: boolean) => {
              triggerCalls.push([data, wasUserInput]);
            },
          },
        },
      },
    } as unknown as Window;

    assert.strictEqual(applyThemeToTerminalWindow(terminalWindow, TERMINAL_THEME_DARK), true);
    assert.strictEqual(blurCalls, 1);
    assert.strictEqual(focusCalls, 1);
    assert.deepStrictEqual(triggerCalls, []);
  });
});
