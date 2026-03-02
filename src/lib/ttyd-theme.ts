export type ThemeMode = 'auto' | 'light' | 'dark';
export type TerminalTheme = Record<string, string>;

export const THEME_MODE_STORAGE_KEY = 'viba:theme-mode';
export const THEME_REFRESH_EVENT = 'viba:theme-refresh';

export const TERMINAL_THEME_LIGHT: TerminalTheme = {
  background: '#ffffff',
  foreground: '#0f172a',
  cursor: '#0f172a',
  selectionBackground: 'rgba(59, 130, 246, 0.4)',
  black: '#000000',
  red: '#cd3131',
  green: '#00BC00',
  yellow: '#949800',
  blue: '#0451a5',
  magenta: '#bc05bc',
  cyan: '#0598bc',
  white: '#555555',
  brightBlack: '#666666',
  brightRed: '#cd3131',
  brightGreen: '#14CE14',
  brightYellow: '#b5ba00',
  brightBlue: '#0451a5',
  brightMagenta: '#bc05bc',
  brightCyan: '#0598bc',
  brightWhite: '#a5a5a5',
};

export const TERMINAL_THEME_DARK: TerminalTheme = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#e6edf3',
  selectionBackground: 'rgba(59, 130, 246, 0.4)',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#ffffff',
};

type StorageLike = Pick<Storage, 'getItem'>;
type StyleTarget = {
  style?: {
    backgroundColor?: string;
    color?: string;
    [key: string]: string | undefined;
  };
};
type TerminalDocumentLike = {
  documentElement?: StyleTarget | null;
  body?: StyleTarget | null;
  activeElement?: unknown;
  hasFocus?: () => boolean;
  querySelector?: (selector: string) => unknown;
  querySelectorAll?: (selector: string) => ArrayLike<StyleTarget>;
};
type TtydWindow = Window & {
  document?: TerminalDocumentLike;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  term?: {
    options?: {
      theme?: TerminalTheme;
      [key: string]: unknown;
    };
    _core?: {
      coreService?: {
        decPrivateModes?: {
          sendFocus?: boolean;
        };
        triggerDataEvent?: (data: string, wasUserInput?: boolean) => void;
      };
    };
    rows?: number;
    refresh?: (start: number, end: number) => void;
    clearTextureAtlas?: () => void;
  };
};

const TERMINAL_BACKGROUND_SELECTORS = [
  '.xterm',
  '.xterm-screen',
  '.xterm-viewport',
  '.xterm-rows',
];
const TERMINAL_FOCUS_GAINED_SEQUENCE = '\x1b[I';

type FocusableTerminalElement = {
  blur?: () => void;
  focus?: ((options?: { preventScroll?: boolean }) => void) | (() => void);
};

function applyElementBackgroundColor(
  element: StyleTarget | null | undefined,
  theme: TerminalTheme,
): void {
  if (!element?.style) return;
  if (theme.background) {
    element.style.backgroundColor = theme.background;
  }
}

function applyElementForegroundColor(
  element: StyleTarget | null | undefined,
  theme: TerminalTheme,
): void {
  if (!element?.style) return;
  if (theme.foreground) {
    element.style.color = theme.foreground;
  }
}

function applyThemeToTerminalDocument(
  terminalDocument: TerminalDocumentLike | null | undefined,
  theme: TerminalTheme,
): void {
  if (!terminalDocument) return;

  applyElementBackgroundColor(terminalDocument.documentElement, theme);
  applyElementForegroundColor(terminalDocument.documentElement, theme);
  applyElementBackgroundColor(terminalDocument.body, theme);
  applyElementForegroundColor(terminalDocument.body, theme);

  if (typeof terminalDocument.querySelectorAll !== 'function') return;
  for (const selector of TERMINAL_BACKGROUND_SELECTORS) {
    const elements = terminalDocument.querySelectorAll(selector);
    for (const element of Array.from(elements)) {
      applyElementBackgroundColor(element, theme);
      if (selector === '.xterm' || selector === '.xterm-screen') {
        applyElementForegroundColor(element, theme);
      }
    }
  }
}

function refreshTerminalSafely(
  term: NonNullable<TtydWindow['term']>,
): boolean {
  const rowCount = typeof term.rows === 'number' ? term.rows : 0;
  if (rowCount <= 0) return false;

  try {
    term.clearTextureAtlas?.();
  } catch {
    // Ignore renderer-specific refresh failures.
  }
  try {
    term.refresh?.(0, rowCount - 1);
  } catch {
    // Ignore renderer-specific refresh failures.
  }
  return true;
}

function scheduleTerminalRefresh(
  term: NonNullable<TtydWindow['term']>,
  requestAnimationFrame: TtydWindow['requestAnimationFrame'],
  attempts = 0,
): void {
  if (refreshTerminalSafely(term)) return;
  if (attempts >= 8 || typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => {
    scheduleTerminalRefresh(term, requestAnimationFrame, attempts + 1);
  });
}

function notifyFocusReportingTerminalProcess(
  term: NonNullable<TtydWindow['term']>,
): void {
  const coreService = term._core?.coreService;
  if (!coreService?.decPrivateModes?.sendFocus) return;
  if (typeof coreService.triggerDataEvent !== 'function') return;

  try {
    coreService.triggerDataEvent(TERMINAL_FOCUS_GAINED_SEQUENCE, true);
  } catch {
    // Ignore xterm internal API differences.
  }
}

function nudgeFocusedTerminalInput(
  terminalDocument: TerminalDocumentLike | null | undefined,
): boolean {
  if (!terminalDocument || typeof terminalDocument.querySelector !== 'function') return false;

  const inputElement = terminalDocument.querySelector('textarea.xterm-helper-textarea') as FocusableTerminalElement | null;
  if (!inputElement || typeof inputElement.focus !== 'function') return false;

  const activeElement = terminalDocument.activeElement;
  const isInputFocused = activeElement === inputElement;
  const documentHasFocus = typeof terminalDocument.hasFocus === 'function'
    ? terminalDocument.hasFocus()
    : isInputFocused;
  if (!documentHasFocus || !isInputFocused) return false;

  try {
    inputElement.blur?.();
  } catch {
    // Ignore focus lifecycle edge-cases from embedded browsers.
  }

  try {
    inputElement.focus({ preventScroll: true });
  } catch {
    try {
      inputElement.focus();
    } catch {
      return false;
    }
  }

  return true;
}

export function normalizeThemeMode(value: string | null | undefined): ThemeMode {
  if (value === 'light' || value === 'dark' || value === 'auto') {
    return value;
  }
  return 'auto';
}

export function readThemeModeFromStorage(storage: StorageLike | null | undefined): ThemeMode {
  if (!storage) return 'auto';
  try {
    return normalizeThemeMode(storage.getItem(THEME_MODE_STORAGE_KEY));
  } catch {
    return 'auto';
  }
}

export function resolveShouldUseDarkTheme(themeMode: ThemeMode, prefersDark: boolean): boolean {
  return themeMode === 'dark' || (themeMode === 'auto' && prefersDark);
}

export function resolveTerminalTheme(themeMode: ThemeMode, prefersDark: boolean): TerminalTheme {
  return resolveShouldUseDarkTheme(themeMode, prefersDark) ? TERMINAL_THEME_DARK : TERMINAL_THEME_LIGHT;
}

export function resolveTerminalThemeFromBrowser(): TerminalTheme {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return TERMINAL_THEME_LIGHT;
  }
  const mode = readThemeModeFromStorage(window.localStorage);
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  return resolveTerminalTheme(mode, prefersDark);
}

export function applyThemeToTerminalWindow(
  terminalWindow: Window | null | undefined,
  theme: TerminalTheme = resolveTerminalThemeFromBrowser(),
): boolean {
  const ttydWindow = terminalWindow as TtydWindow | null | undefined;
  const term = ttydWindow?.term;
  if (!term?.options) return false;

  term.options.theme = {
    ...(term.options.theme || {}),
    ...theme,
  };

  applyThemeToTerminalDocument(ttydWindow.document, theme);
  scheduleTerminalRefresh(term, ttydWindow.requestAnimationFrame?.bind(ttydWindow));
  const nudgedWithRealFocusEvent = nudgeFocusedTerminalInput(ttydWindow.document);
  if (!nudgedWithRealFocusEvent) {
    notifyFocusReportingTerminalProcess(term);
  }

  return true;
}

export function applyThemeToTerminalIframe(
  iframe: HTMLIFrameElement | null | undefined,
  theme: TerminalTheme = resolveTerminalThemeFromBrowser(),
): boolean {
  if (!iframe) return false;
  try {
    return applyThemeToTerminalWindow(iframe.contentWindow, theme);
  } catch {
    return false;
  }
}
