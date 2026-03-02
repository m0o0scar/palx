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
