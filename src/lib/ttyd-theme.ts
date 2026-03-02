export type ThemeMode = 'auto' | 'light' | 'dark';
export type TerminalTheme = Record<string, string>;

export const THEME_MODE_STORAGE_KEY = 'viba:theme-mode';
export const THEME_REFRESH_EVENT = 'viba:theme-refresh';

function buildMonochromeTheme(
  background: string,
  foreground: string,
  selectionBackground: string,
): TerminalTheme {
  return {
    background,
    foreground,
    cursor: foreground,
    selectionBackground,
    black: foreground,
    red: foreground,
    green: foreground,
    yellow: foreground,
    blue: foreground,
    magenta: foreground,
    cyan: foreground,
    white: foreground,
    brightBlack: foreground,
    brightRed: foreground,
    brightGreen: foreground,
    brightYellow: foreground,
    brightBlue: foreground,
    brightMagenta: foreground,
    brightCyan: foreground,
    brightWhite: foreground,
  };
}

export const TERMINAL_THEME_LIGHT: TerminalTheme = buildMonochromeTheme(
  '#ffffff',
  '#0f172a',
  'rgba(15, 23, 42, 0.2)',
);

export const TERMINAL_THEME_DARK: TerminalTheme = buildMonochromeTheme(
  '#0b0f14',
  '#dce3ea',
  'rgba(148, 163, 184, 0.35)',
);

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
type TerminalWithMonochromeFilterState = {
  write?: (data: unknown, callback?: () => void) => void;
  __vibaMonochromeFilterInstalled?: boolean;
  __vibaMonochromeFilterCarry?: string;
  __vibaMonochromeFilterOriginalWrite?: (data: unknown, callback?: () => void) => void;
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
    cols?: number;
    resize?: (cols: number, rows: number) => void;
    refresh?: (start: number, end: number) => void;
    clearTextureAtlas?: () => void;
    write?: (data: unknown, callback?: () => void) => void;
    __vibaMonochromeFilterInstalled?: boolean;
    __vibaMonochromeFilterCarry?: string;
    __vibaMonochromeFilterOriginalWrite?: (data: unknown, callback?: () => void) => void;
  };
};

const TERMINAL_BACKGROUND_SELECTORS = [
  '.xterm',
  '.xterm-screen',
  '.xterm-viewport',
  '.xterm-rows',
];
const TERMINAL_FOCUS_GAINED_SEQUENCE = '\x1b[I';
const BACKGROUND_OSC_STYLE_IDS = new Set([11, 17, 111, 117]);

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
      if (selector === '.xterm-viewport' && element?.style) {
        element.style.overflow = 'hidden';
      }
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

const UTF8_DECODER = typeof TextDecoder === 'function'
  ? new TextDecoder()
  : null;

function decodeUint8Bytes(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';
  if (UTF8_DECODER) {
    return UTF8_DECODER.decode(bytes);
  }
  let output = '';
  for (const byte of bytes) {
    output += String.fromCharCode(byte);
  }
  return output;
}

function normalizeTerminalWriteChunk(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (chunk === null || chunk === undefined) return '';

  if (chunk instanceof Uint8Array) {
    return decodeUint8Bytes(chunk);
  }

  if (typeof ArrayBuffer !== 'undefined' && chunk instanceof ArrayBuffer) {
    return decodeUint8Bytes(new Uint8Array(chunk));
  }

  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(chunk)) {
    const typedView = chunk as ArrayBufferView;
    return decodeUint8Bytes(new Uint8Array(typedView.buffer, typedView.byteOffset, typedView.byteLength));
  }

  if (Array.isArray(chunk) && chunk.every((entry) => typeof entry === 'number')) {
    return decodeUint8Bytes(Uint8Array.from(chunk));
  }

  return String(chunk);
}

function isCsiFinalByte(character: string): boolean {
  const charCode = character.charCodeAt(0);
  return charCode >= 0x40 && charCode <= 0x7e;
}

function findCsiFinalByteIndex(input: string, startIndex: number): number {
  for (let index = startIndex; index < input.length; index += 1) {
    if (isCsiFinalByte(input[index])) {
      return index;
    }
  }
  return -1;
}

type OscTerminator = {
  contentEndIndex: number;
  sequenceEndIndex: number;
};

function findOscTerminator(
  input: string,
  startIndex: number,
): OscTerminator | null {
  for (let index = startIndex; index < input.length; index += 1) {
    if (input[index] === '\x07') {
      return {
        contentEndIndex: index,
        sequenceEndIndex: index + 1,
      };
    }
    if (input[index] === '\x1b' && input[index + 1] === '\\') {
      return {
        contentEndIndex: index,
        sequenceEndIndex: index + 2,
      };
    }
  }
  return null;
}

function parseOscIdentifier(oscContent: string): number | null {
  const separatorIndex = oscContent.indexOf(';');
  const identifierText = (separatorIndex >= 0 ? oscContent.slice(0, separatorIndex) : oscContent).trim();
  if (!identifierText || !/^\d+$/.test(identifierText)) return null;
  const identifier = Number.parseInt(identifierText, 10);
  return Number.isNaN(identifier) ? null : identifier;
}

type SanitizedSgrParameters = {
  changed: boolean;
  parameters: string;
};

function sanitizeSgrParameters(parameterText: string): SanitizedSgrParameters {
  if (parameterText.length === 0) {
    return { changed: false, parameters: parameterText };
  }

  const sourceParameters = parameterText.split(';');
  const sanitizedParameters: string[] = [];
  let changed = false;

  for (let index = 0; index < sourceParameters.length; index += 1) {
    const token = sourceParameters[index];
    const parsed = token.length === 0 ? 0 : Number.parseInt(token, 10);
    if (token.length !== 0 && Number.isNaN(parsed)) {
      sanitizedParameters.push(token);
      continue;
    }

    // Strip reverse-video toggles to avoid foreground/background swapping.
    if (parsed === 7) {
      changed = true;
      continue;
    }

    // Strip 8/16-color and default background controls.
    if (
      parsed === 49
      || (parsed >= 40 && parsed <= 47)
      || (parsed >= 100 && parsed <= 107)
    ) {
      changed = true;
      continue;
    }

    // Strip extended background color controls.
    if (parsed === 48) {
      changed = true;
      const modeToken = sourceParameters[index + 1];
      const mode = modeToken === undefined || modeToken.length === 0
        ? Number.NaN
        : Number.parseInt(modeToken, 10);
      if (mode === 5) {
        index += 2;
      } else if (mode === 2) {
        index += 4;
      } else if (modeToken !== undefined) {
        index += 1;
      }
      continue;
    }

    sanitizedParameters.push(token);
  }

  if (!changed) {
    return { changed: false, parameters: parameterText };
  }

  return {
    changed: true,
    parameters: sanitizedParameters.join(';'),
  };
}

type SanitizedAnsiChunk = {
  output: string;
  carry: string;
};

function sanitizeAnsiBackgroundSequences(chunk: string): SanitizedAnsiChunk {
  if (chunk.length === 0) {
    return { output: '', carry: '' };
  }

  let output = '';
  let index = 0;

  while (index < chunk.length) {
    const character = chunk[index];
    if (character !== '\x1b') {
      output += character;
      index += 1;
      continue;
    }

    const nextCharacter = chunk[index + 1];
    if (!nextCharacter) {
      return { output, carry: chunk.slice(index) };
    }

    if (nextCharacter === '[') {
      const finalIndex = findCsiFinalByteIndex(chunk, index + 2);
      if (finalIndex < 0) {
        return { output, carry: chunk.slice(index) };
      }

      const finalCharacter = chunk[finalIndex];
      if (finalCharacter === 'm') {
        const rawParameters = chunk.slice(index + 2, finalIndex);
        const sanitizedParameters = sanitizeSgrParameters(rawParameters);
        if (!sanitizedParameters.changed) {
          output += chunk.slice(index, finalIndex + 1);
        } else if (sanitizedParameters.parameters.length > 0) {
          output += `\x1b[${sanitizedParameters.parameters}m`;
        }
      } else {
        output += chunk.slice(index, finalIndex + 1);
      }

      index = finalIndex + 1;
      continue;
    }

    if (nextCharacter === ']') {
      const terminator = findOscTerminator(chunk, index + 2);
      if (!terminator) {
        return { output, carry: chunk.slice(index) };
      }

      const oscContent = chunk.slice(index + 2, terminator.contentEndIndex);
      const oscIdentifier = parseOscIdentifier(oscContent);
      if (oscIdentifier === null || !BACKGROUND_OSC_STYLE_IDS.has(oscIdentifier)) {
        output += chunk.slice(index, terminator.sequenceEndIndex);
      }

      index = terminator.sequenceEndIndex;
      continue;
    }

    output += character;
    index += 1;
  }

  return { output, carry: '' };
}

function installMonochromeAnsiFilter(
  term: NonNullable<TtydWindow['term']>,
): void {
  const terminal = term as NonNullable<TtydWindow['term']> & TerminalWithMonochromeFilterState;
  if (terminal.__vibaMonochromeFilterInstalled) return;
  if (typeof terminal.write !== 'function') return;
  terminal.__vibaMonochromeFilterInstalled = true;
  const originalWrite = terminal.write.bind(terminal);
  terminal.__vibaMonochromeFilterOriginalWrite = originalWrite;
  terminal.__vibaMonochromeFilterCarry = '';

  // Clear any active style state so subsequent plain text starts from defaults.
  try {
    originalWrite('\x1b[0m');
  } catch {
    // Ignore write failures from renderer/setup races.
  }

  terminal.write = (chunk: unknown, callback?: () => void): void => {
    const normalizedChunk = normalizeTerminalWriteChunk(chunk);
    const nextChunk = terminal.__vibaMonochromeFilterCarry
      ? `${terminal.__vibaMonochromeFilterCarry}${normalizedChunk}`
      : normalizedChunk;
    const sanitized = sanitizeAnsiBackgroundSequences(nextChunk);
    terminal.__vibaMonochromeFilterCarry = sanitized.carry;
    if (sanitized.output.length > 0) {
      originalWrite(sanitized.output, callback);
      return;
    }
    callback?.();
  };

  // Trigger a repaint from the running TUI so existing colored blocks are redrawn without backgrounds.
  if (typeof terminal.resize === 'function') {
    const cols = typeof terminal.cols === 'number' ? terminal.cols : 0;
    const rows = typeof terminal.rows === 'number' ? terminal.rows : 0;
    if (cols > 0 && rows > 0) {
      const nudgedRows = rows > 2 ? rows - 1 : rows + 1;
      if (nudgedRows > 0 && nudgedRows !== rows) {
        try {
          terminal.resize(cols, nudgedRows);
          terminal.resize(cols, rows);
        } catch {
          // Ignore resize races while ttyd is still syncing dimensions.
        }
      }
    }
  }
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
  if (!ttydWindow || !term?.options) return false;

  term.options.theme = {
    ...(term.options.theme || {}),
    ...theme,
  };
  installMonochromeAnsiFilter(term);

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
