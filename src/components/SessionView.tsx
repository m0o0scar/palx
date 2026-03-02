'use client';

import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
// import { useRouter } from 'next/navigation';
import {
    createSessionBaseBranch,
    deleteSessionInBackground,
    getSessionDivergence,
    listSessionBaseBranches,
    mergeSessionToBase,
    rebaseSessionOntoBase,
    updateSessionBaseBranch,
    writeSessionPromptFile
} from '@/app/actions/session';
import { setTmuxSessionMouseMode, setTmuxSessionStatusVisibility } from '@/app/actions/git';
import { getConfig, updateConfig } from '@/app/actions/config';
import { Trash2, ExternalLink, Play, GitMerge, GitPullRequestArrow, GitBranch, ArrowUp, ArrowDown, FolderOpen, ChevronLeft, ChevronRight, Grip, ChevronDown, Plus, MousePointer2, ArrowLeft, ArrowRight, RotateCw, ScrollText, TextCursorInput, X } from 'lucide-react';
import SessionFileBrowser from './SessionFileBrowser';
import { SessionRepoViewer } from './SessionRepoViewer';
import { getBaseName, isWindowsAbsolutePath } from '@/lib/path';
import { notifySessionsUpdated } from '@/lib/session-updates';
import { buildTtydTerminalSrc } from '@/lib/terminal-session';
import { normalizePreviewUrl } from '@/lib/url';
import { sanitizeBranchName } from '@/lib/utils';
import { useTerminalLink, type TerminalWindow } from '@/hooks/useTerminalLink';
import { quoteShellArg } from '@/lib/shell';
import {
    applyThemeToTerminalIframe,
    applyThemeToTerminalWindow,
    readThemeModeFromStorage,
    THEME_MODE_STORAGE_KEY,
    THEME_REFRESH_EVENT,
} from '@/lib/ttyd-theme';

const SUPPORTED_IDES = [
    { id: 'vscode', name: 'VS Code', protocol: 'vscode' },
    { id: 'cursor', name: 'Cursor', protocol: 'cursor' },
    { id: 'windsurf', name: 'Windsurf', protocol: 'windsurf' },
    { id: 'antigravity', name: 'Antigravity', protocol: 'antigravity' },
];


type CleanupPhase = 'idle' | 'error';

type PreviewNavigationAction = 'back' | 'forward' | 'reload';
type TerminalBootstrapSlot = 'agent' | 'terminal';
type TerminalBootstrapState = 'idle' | 'in_progress' | 'done';
type TerminalBootstrapRegistry = Record<string, TerminalBootstrapState>;
type TerminalInteractionMode = 'scroll' | 'select';
type TerminalOnWriteParsedDisposable = { dispose?: () => void };
type TerminalWithOnWriteParsed = NonNullable<TerminalWindow['term']> & {
    onWriteParsed?: (callback: () => void) => TerminalOnWriteParsedDisposable | void;
};
type TerminalWithClearLineShortcutState = NonNullable<TerminalWindow['term']> & {
    __vibaClearLineShortcutInstalled?: boolean;
};

const TERMINAL_SIZE_STORAGE_KEY = 'viba-terminal-size';
const SPLIT_RATIO_STORAGE_KEY = 'viba-agent-preview-split-ratio';
const RIGHT_PANEL_COLLAPSED_STORAGE_KEY = 'viba-right-panel-collapsed';
const DEFAULT_AGENT_PANE_RATIO = 0.5;
const TERMINAL_HEADER_HEIGHT = 36;
const TERMINAL_BOOTSTRAP_STORAGE_PREFIX = 'viba:terminal-bootstrap:';
const TERMINAL_BOOTSTRAP_RUNTIME_KEY = '__vibaTerminalBootstrapRegistry';
const SHELL_PROMPT_PATTERN = /(?:\$|%|#|>) $/;
const CODEX_PLAIN_THEME_FLAG = '-c tui.theme="ansi"';
const CODEX_MONOCHROME_ENV_PREFIX = 'NO_COLOR=1 CLICOLOR=0 CLICOLOR_FORCE=0 FORCE_COLOR=0 COLORTERM= TERM=xterm';

const PLAN_MODE_STARTUP_INSTRUCTION =
    'Plan mode: inspect the relevant code first, present a concrete implementation plan, and wait for explicit user approval before any file edits or write commands.';
const AUTO_COMMIT_INSTRUCTION =
    'After each round, if work is complete and files changed, commit all changes without confirmation. Use a commit message with a clear title and a detailed body explaining what changed and why. If GITHUB_TOKEN or GITLAB_TOKEN is set, push the current branch after committed rounds and create (or update) a pull/merge request with an appropriate title and description; include the pull/merge request link in the first push reply.';
const AGENT_BROWSER_SKILL_INSTRUCTION =
    'For visual web tasks, use the `agent-browser` skill (https://skills.sh/vercel-labs/agent-browser/agent-browser).';
const SYSTEMATIC_DEBUGGING_SKILL_INSTRUCTION =
    'For bugfix/debugging tasks, use the `systematic-debugging` skill (https://github.com/obra/superpowers).';
const VISUAL_EVIDENCE_INSTRUCTION =
    'When working on a visual-related feature or bugfix in a web project, after coding is complete, use `agent-browser` or equivalent Chrome MCP tooling to load the relevant page, take screenshot(s), and include them as evidence in the pull/merge request.';
const NOTIFICATION_INSTRUCTION =
    'When your task is completed or you need user attention (for plan approval, permissions, or blockers), send a notification to the matching Palx session.';

const clampAgentPaneRatio = (value: number): number => Math.max(0.2, Math.min(0.8, value));

type PreviewComponentStackEntry = {
    name?: unknown;
    source?: {
        fileName?: unknown;
    } | null;
};

const normalizePickerSourceFileName = (value: string): string => {
    let normalized = value.trim();
    if (!normalized) return '';

    normalized = normalized.replace(/[#?].*$/, '');

    if (/^file:\/\//i.test(normalized)) {
        try {
            const asUrl = new URL(normalized);
            normalized = decodeURIComponent(asUrl.pathname);
        } catch {
            // Keep original value when URL parsing fails
        }
    } else if (/^https?:\/\//i.test(normalized)) {
        try {
            const asUrl = new URL(normalized);
            normalized = decodeURIComponent(asUrl.pathname);
        } catch {
            // Keep original value when URL parsing fails
        }
    }

    normalized = normalized
        .replace(/^webpack(?:-internal)?:\/\/\/?/, '')
        .replace(/^rsc:\/\//, '')
        .replace(/^\(.*?\)\//, '')
        .replace(/^\/\.\//, '/')
        .replace(/^\.\//, '')
        .replace(/\\/g, '/');

    return normalized.trim();
};

const joinPath = (base: string, relative: string): string => {
    const normalizedBase = base.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedRelative = relative.replace(/\\/g, '/').replace(/^\/+/, '');
    return `${normalizedBase}/${normalizedRelative}`;
};

const resolveComponentSourcePath = (rawSourceFileName: string, workspaceRoot: string): string | null => {
    const normalizedWorkspaceRoot = workspaceRoot.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!normalizedWorkspaceRoot) return null;

    const normalizedSource = normalizePickerSourceFileName(rawSourceFileName);
    if (!normalizedSource) return null;

    if (normalizedSource.startsWith('/') || isWindowsAbsolutePath(normalizedSource)) {
        return normalizedSource;
    }

    const relativeCandidates = new Set<string>();
    relativeCandidates.add(normalizedSource.replace(/^\.\/+/, ''));

    const srcIndex = normalizedSource.indexOf('/src/');
    if (srcIndex >= 0) {
        relativeCandidates.add(normalizedSource.slice(srcIndex + 1));
    }

    if (normalizedSource.startsWith('src/')) {
        relativeCandidates.add(normalizedSource);
    }

    for (const relative of relativeCandidates) {
        if (!relative) continue;
        return joinPath(normalizedWorkspaceRoot, relative);
    }

    return null;
};

const buildComponentReferenceText = (reactStack: unknown[], workspaceRoot: string): string | null => {
    for (const entry of reactStack) {
        if (!entry || typeof entry !== 'object') continue;

        const componentEntry = entry as PreviewComponentStackEntry;
        const componentName = typeof componentEntry.name === 'string' ? componentEntry.name.trim() : '';
        if (!componentName) continue;

        const sourceFileName = typeof componentEntry.source?.fileName === 'string'
            ? componentEntry.source.fileName.trim()
            : '';
        const sourcePath = sourceFileName ? resolveComponentSourcePath(sourceFileName, workspaceRoot) : null;

        if (sourcePath) {
            return `${componentName} (${sourcePath})`;
        }
    }

    return null;
};

const normalizeComponentLookupName = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return '';

    const match = trimmed.match(/[A-Za-z_$][\w$]*/);
    return match ? match[0] : '';
};

export interface SessionViewProps {
    repo: string;
    worktree: string;
    branch: string;
    baseBranch?: string;
    sessionName: string;
    agent?: string;
    startupScript?: string;
    devServerScript?: string;
    initialMessage?: string;
    attachmentPaths?: string[];
    attachmentNames?: string[];
    title?: string;
    sessionMode?: 'fast' | 'plan';
    onExit: (force?: boolean) => void;
    isResume?: boolean;
    terminalPersistenceMode?: 'tmux' | 'shell';
    onSessionStart?: () => void;
    agentTerminalSrc?: string;
    floatingTerminalSrc?: string;
}

export function SessionView({
    repo,
    worktree,
    branch,
    baseBranch,
    sessionName,
    agent,
    startupScript,
    devServerScript,
    initialMessage,
    attachmentPaths,
    attachmentNames,
    title,
    sessionMode = 'fast',
    onExit,
    isResume,
    terminalPersistenceMode = 'shell',
    onSessionStart,
    agentTerminalSrc: agentTerminalSrcOverride,
    floatingTerminalSrc: floatingTerminalSrcOverride,
}: SessionViewProps) {
    const headerButtonLabelClass = 'hidden min-[1900px]:inline';

    const iframeRef = useRef<HTMLIFrameElement>(null);
    const terminalRef = useRef<HTMLIFrameElement>(null);
    const terminalBootstrapRef = useRef<HTMLIFrameElement>(null);
    const previewIframeRef = useRef<HTMLIFrameElement>(null);
    const previewAddressInputRef = useRef<HTMLInputElement>(null);
    const splitContainerRef = useRef<HTMLDivElement>(null);
    const splitResizeRef = useRef({ startX: 0, startRatio: DEFAULT_AGENT_PANE_RATIO });
    const recentTerminalBlurRef = useRef<{ slot: TerminalBootstrapSlot; at: number } | null>(null);
    const agentFrameLinkCleanupRef = useRef<(() => void) | null>(null);
    const terminalFrameLinkCleanupRef = useRef<(() => void) | null>(null);
    const terminalProcessMonitorCleanupRef = useRef<(() => void) | null>(null);
    const terminalStartupScriptStateRef = useRef<{ injected: boolean; timer: number | null }>({
        injected: false,
        timer: null,
    });
    const agentTerminalSrc = useMemo(
        () => agentTerminalSrcOverride || buildTtydTerminalSrc(sessionName, 'agent'),
        [agentTerminalSrcOverride, sessionName],
    );
    const floatingTerminalSrc = useMemo(
        () => floatingTerminalSrcOverride || buildTtydTerminalSrc(sessionName, 'terminal'),
        [floatingTerminalSrcOverride, sessionName],
    );

    const terminalBootstrapStateRef = useRef<Record<TerminalBootstrapSlot, TerminalBootstrapState>>({
        agent: 'idle',
        terminal: 'idle',
    });
    const tmuxStatusAppliedRef = useRef<Record<TerminalBootstrapSlot, boolean>>({
        agent: false,
        terminal: false,
    });

    useEffect(() => {
        terminalBootstrapStateRef.current = {
            agent: 'idle',
            terminal: 'idle',
        };
        tmuxStatusAppliedRef.current = {
            agent: false,
            terminal: false,
        };
        if (terminalStartupScriptStateRef.current.timer !== null) {
            window.clearTimeout(terminalStartupScriptStateRef.current.timer);
        }
        terminalStartupScriptStateRef.current = {
            injected: false,
            timer: null,
        };
    }, [sessionName]);

    useEffect(() => {
        return () => {
            if (terminalStartupScriptStateRef.current.timer !== null) {
                window.clearTimeout(terminalStartupScriptStateRef.current.timer);
                terminalStartupScriptStateRef.current.timer = null;
            }
        };
    }, []);

    const getTerminalBootstrapKey = useCallback((slot: TerminalBootstrapSlot) => {
        return `${TERMINAL_BOOTSTRAP_STORAGE_PREFIX}${sessionName}:${slot}`;
    }, [sessionName]);

    const getRuntimeBootstrapKey = useCallback((slot: TerminalBootstrapSlot) => {
        return `${sessionName}:${slot}`;
    }, [sessionName]);

    const getRuntimeBootstrapRegistry = useCallback((): TerminalBootstrapRegistry | null => {
        if (typeof window === 'undefined') return null;
        const runtimeWindow = window as Window & {
            __vibaTerminalBootstrapRegistry?: TerminalBootstrapRegistry;
        };
        if (!runtimeWindow[TERMINAL_BOOTSTRAP_RUNTIME_KEY]) {
            runtimeWindow[TERMINAL_BOOTSTRAP_RUNTIME_KEY] = {};
        }
        return runtimeWindow[TERMINAL_BOOTSTRAP_RUNTIME_KEY] || null;
    }, []);

    const getRuntimeBootstrapState = useCallback((slot: TerminalBootstrapSlot): TerminalBootstrapState => {
        const registry = getRuntimeBootstrapRegistry();
        if (!registry) return 'idle';
        return registry[getRuntimeBootstrapKey(slot)] || 'idle';
    }, [getRuntimeBootstrapRegistry, getRuntimeBootstrapKey]);

    const setRuntimeBootstrapState = useCallback((slot: TerminalBootstrapSlot, state: TerminalBootstrapState): void => {
        const registry = getRuntimeBootstrapRegistry();
        if (!registry) return;
        registry[getRuntimeBootstrapKey(slot)] = state;
    }, [getRuntimeBootstrapRegistry, getRuntimeBootstrapKey]);

    const hasTerminalBootstrapped = useCallback((slot: TerminalBootstrapSlot): boolean => {
        if (terminalBootstrapStateRef.current[slot] === 'done') {
            return true;
        }
        if (getRuntimeBootstrapState(slot) === 'done') {
            return true;
        }
        try {
            return window.sessionStorage.getItem(getTerminalBootstrapKey(slot)) === '1';
        } catch {
            return false;
        }
    }, [getRuntimeBootstrapState, getTerminalBootstrapKey]);

    const beginTerminalBootstrap = useCallback((slot: TerminalBootstrapSlot): boolean => {
        const current = terminalBootstrapStateRef.current[slot];
        const runtimeState = getRuntimeBootstrapState(slot);
        if (current === 'done' || current === 'in_progress' || runtimeState === 'done' || runtimeState === 'in_progress') {
            return false;
        }
        terminalBootstrapStateRef.current[slot] = 'in_progress';
        setRuntimeBootstrapState(slot, 'in_progress');
        return true;
    }, [getRuntimeBootstrapState, setRuntimeBootstrapState]);

    const resetTerminalBootstrap = useCallback((slot: TerminalBootstrapSlot): void => {
        if (terminalBootstrapStateRef.current[slot] !== 'done') {
            terminalBootstrapStateRef.current[slot] = 'idle';
        }
        if (getRuntimeBootstrapState(slot) !== 'done') {
            setRuntimeBootstrapState(slot, 'idle');
        }
    }, [getRuntimeBootstrapState, setRuntimeBootstrapState]);

    const markTerminalBootstrapped = useCallback((slot: TerminalBootstrapSlot): void => {
        terminalBootstrapStateRef.current[slot] = 'done';
        setRuntimeBootstrapState(slot, 'done');
        try {
            window.sessionStorage.setItem(getTerminalBootstrapKey(slot), '1');
        } catch {
            // Ignore storage failures (private mode / disabled storage).
        }
    }, [getTerminalBootstrapKey, setRuntimeBootstrapState]);

    const isShellPromptReady = useCallback((term: TerminalWindow['term']): boolean => {
        const activeBuffer = term?.buffer?.active;
        if (!activeBuffer || typeof activeBuffer.getLine !== 'function') {
            // Fall back to ready when xterm internals are unavailable.
            return true;
        }

        const cursorLine = activeBuffer.baseY + activeBuffer.cursorY;
        for (let offset = 0; offset < 6; offset += 1) {
            const line = activeBuffer.getLine(cursorLine - offset);
            const text = line?.translateToString(true) ?? '';
            if (!text.trim()) continue;
            return SHELL_PROMPT_PATTERN.test(text);
        }
        return false;
    }, []);

    const stopTerminalProcessMonitor = useCallback(() => {
        if (terminalProcessMonitorCleanupRef.current) {
            terminalProcessMonitorCleanupRef.current();
            terminalProcessMonitorCleanupRef.current = null;
        }
    }, []);

    const startTerminalProcessMonitor = useCallback((
        iframe: HTMLIFrameElement,
        term: NonNullable<TerminalWindow['term']>
    ) => {
        stopTerminalProcessMonitor();

        let disposed = false;
        let writeDisposable: { dispose?: () => void } | null = null;
        let mutationObserver: MutationObserver | null = null;
        let intervalId: number | null = null;

        const updateProcessState = () => {
            if (disposed) return;
            const isRunning = !isShellPromptReady(term);
            setIsTerminalForegroundProcessRunning((current) => (current === isRunning ? current : isRunning));
        };

        updateProcessState();
        intervalId = window.setInterval(updateProcessState, 1000);

        try {
            const xterm = term as TerminalWithOnWriteParsed;
            if (typeof xterm.onWriteParsed === 'function') {
                writeDisposable = xterm.onWriteParsed(updateProcessState) || null;
            } else {
                const screen = iframe.contentDocument?.querySelector('.xterm-screen') || iframe.contentDocument?.body;
                if (screen) {
                    mutationObserver = new MutationObserver(updateProcessState);
                    mutationObserver.observe(screen, { childList: true, subtree: true, characterData: true });
                }
            }
        } catch (error) {
            console.error('Failed to setup terminal process monitor:', error);
        }

        terminalProcessMonitorCleanupRef.current = () => {
            disposed = true;
            if (intervalId !== null) {
                window.clearInterval(intervalId);
                intervalId = null;
            }
            if (writeDisposable && typeof writeDisposable.dispose === 'function') {
                writeDisposable.dispose();
            }
            mutationObserver?.disconnect();
        };
    }, [isShellPromptReady, stopTerminalProcessMonitor]);

    useEffect(() => {
        return () => {
            stopTerminalProcessMonitor();
        };
    }, [stopTerminalProcessMonitor]);

    useEffect(() => {
        setIsTerminalForegroundProcessRunning(false);
        stopTerminalProcessMonitor();
    }, [sessionName, stopTerminalProcessMonitor]);

    const injectTerminalStartupScript = useCallback((
        iframe: HTMLIFrameElement,
        win: TerminalWindow,
        term: NonNullable<TerminalWindow['term']>
    ): boolean => {
        if (isResume) return false;

        const script = startupScript?.trim();
        if (!script || terminalStartupScriptStateRef.current.injected) return false;

        const pressEnter = () => {
            const textarea = iframe.contentDocument?.querySelector("textarea.xterm-helper-textarea");
            if (textarea) {
                textarea.dispatchEvent(new KeyboardEvent('keypress', {
                    bubbles: true,
                    cancelable: true,
                    charCode: 13,
                    keyCode: 13,
                    key: 'Enter',
                    view: win
                }));
            } else {
                term.paste('\r');
            }
        };

        terminalStartupScriptStateRef.current.injected = true;
        if (terminalStartupScriptStateRef.current.timer !== null) {
            window.clearTimeout(terminalStartupScriptStateRef.current.timer);
        }
        terminalStartupScriptStateRef.current.timer = window.setTimeout(() => {
            terminalStartupScriptStateRef.current.timer = null;
            try {
                term.paste(script);
                pressEnter();
            } catch (error) {
                terminalStartupScriptStateRef.current.injected = false;
                console.error('Failed to inject startup script into terminal iframe:', error);
            }
        }, 500);

        return true;
    }, [isResume, startupScript]);

    useEffect(() => {
        if (isResume) return;
        if (!startupScript?.trim()) return;
        if (terminalStartupScriptStateRef.current.injected) return;

        let cancelled = false;

        const attemptInjection = (attempts = 0) => {
            if (cancelled || terminalStartupScriptStateRef.current.injected) return;
            if (attempts > 30) return;

            if (!hasTerminalBootstrapped('terminal')) {
                window.setTimeout(() => attemptInjection(attempts + 1), 200);
                return;
            }

            const iframe = terminalRef.current || terminalBootstrapRef.current;
            if (!iframe) return;

            try {
                const win = iframe.contentWindow as TerminalWindow | null;
                if (win?.term) {
                    injectTerminalStartupScript(iframe, win, win.term);
                    return;
                }
            } catch {
                // Ignore transient iframe access errors and retry.
            }

            window.setTimeout(() => attemptInjection(attempts + 1), 200);
        };

        attemptInjection();
        return () => {
            cancelled = true;
        };
    }, [hasTerminalBootstrapped, injectTerminalStartupScript, isResume, startupScript]);

    const [feedback, setFeedback] = useState<string>('Initializing...');
    const [cleanupPhase, setCleanupPhase] = useState<CleanupPhase>('idle');
    const [cleanupError, setCleanupError] = useState<string | null>(null);
    const [isStartingDevServer, setIsStartingDevServer] = useState(false);
    const [isTerminalForegroundProcessRunning, setIsTerminalForegroundProcessRunning] = useState(false);
    const [isMerging, setIsMerging] = useState(false);
    const [isRebasing, setIsRebasing] = useState(false);
    const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false);
    const [lastFileBrowserPath, setLastFileBrowserPath] = useState(worktree || repo);
    const [isInsertingFilePaths, setIsInsertingFilePaths] = useState(false);
    const [currentBaseBranch, setCurrentBaseBranch] = useState(baseBranch?.trim() || '');
    const [mainWorktreeBranch, setMainWorktreeBranch] = useState('');
    const [baseBranchOptions, setBaseBranchOptions] = useState<string[]>([]);
    const [isLoadingBaseBranches, setIsLoadingBaseBranches] = useState(false);
    const isLoadingBaseBranchesRef = useRef(false);
    const [isUpdatingBaseBranch, setIsUpdatingBaseBranch] = useState(false);
    const [isCreateBaseBranchDialogOpen, setIsCreateBaseBranchDialogOpen] = useState(false);
    const [newBaseBranchName, setNewBaseBranchName] = useState('');
    const [newBaseBranchFrom, setNewBaseBranchFrom] = useState('');
    const [isCreatingBaseBranch, setIsCreatingBaseBranch] = useState(false);
    const [divergence, setDivergence] = useState({ ahead: 0, behind: 0 });
    const [isPreviewVisible, setIsPreviewVisible] = useState(true);
    const [previewInputUrl, setPreviewInputUrl] = useState('');
    const [previewUrl, setPreviewUrl] = useState('');
    const [isPreviewPickerActive, setIsPreviewPickerActive] = useState(false);
    const [isResolvingElement, setIsResolvingElement] = useState(false);
    const [isRepoViewActive, setIsRepoViewActive] = useState(false);
    const [agentPaneRatio, setAgentPaneRatio] = useState(DEFAULT_AGENT_PANE_RATIO);
    const [isSplitResizing, setIsSplitResizing] = useState(false);
    const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(true);
    const [isAgentTerminalThemeReady, setIsAgentTerminalThemeReady] = useState(false);
    const [isFloatingTerminalThemeReady, setIsFloatingTerminalThemeReady] = useState(false);

    const [isTerminalMinimized, setIsTerminalMinimized] = useState(false);

    useEffect(() => {
        setIsAgentTerminalThemeReady(false);
        setIsFloatingTerminalThemeReady(false);
    }, [agentTerminalSrc, floatingTerminalSrc, sessionName]);

    const focusTerminalInputForSlot = useCallback((slot: TerminalBootstrapSlot): boolean => {
        const iframe = slot === 'agent' ? iframeRef.current : terminalRef.current;
        if (!iframe) return false;
        try {
            const frameWindow = iframe.contentWindow;
            const textarea = iframe.contentDocument?.querySelector('textarea.xterm-helper-textarea') as HTMLElement | null;
            frameWindow?.focus();
            if (!textarea || typeof textarea.focus !== 'function') return false;
            try {
                textarea.focus({ preventScroll: true });
            } catch {
                textarea.focus();
            }
            return true;
        } catch {
            return false;
        }
    }, []);

    const maybeRestoreRecentTerminalFocusAfterThemeChange = useCallback(() => {
        const recentBlur = recentTerminalBlurRef.current;
        if (!recentBlur) return;
        if (Date.now() - recentBlur.at > 1500) return;

        const preferredSlot = recentBlur.slot;
        window.setTimeout(() => {
            const restored = focusTerminalInputForSlot(preferredSlot);
            if (!restored) {
                focusTerminalInputForSlot(preferredSlot === 'agent' ? 'terminal' : 'agent');
            }
            recentTerminalBlurRef.current = null;
        }, 0);
    }, [focusTerminalInputForSlot]);

    const applyThemeToTerminalFrames = useCallback(() => {
        const agentThemeApplied = applyThemeToTerminalIframe(iframeRef.current);
        if (agentThemeApplied) {
            setIsAgentTerminalThemeReady(true);
        }

        const terminalThemeApplied = applyThemeToTerminalIframe(terminalRef.current);
        if (terminalThemeApplied) {
            setIsFloatingTerminalThemeReady(true);
        }

        maybeRestoreRecentTerminalFocusAfterThemeChange();
    }, [maybeRestoreRecentTerminalFocusAfterThemeChange]);

    useEffect(() => {
        const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const applyTheme = () => {
            applyThemeToTerminalFrames();
        };
        const handleMediaChange = () => {
            if (readThemeModeFromStorage(window.localStorage) === 'auto') {
                applyTheme();
            }
        };
        const handleStorageChange = (event: StorageEvent) => {
            if (!event.key || event.key === THEME_MODE_STORAGE_KEY) {
                applyTheme();
            }
        };
        const handleThemeRefresh = () => {
            applyTheme();
        };

        applyTheme();
        window.addEventListener('storage', handleStorageChange);
        window.addEventListener(THEME_REFRESH_EVENT, handleThemeRefresh);

        if (typeof mediaQuery.addEventListener === 'function') {
            mediaQuery.addEventListener('change', handleMediaChange);
        } else {
            mediaQuery.addListener(handleMediaChange);
        }

        return () => {
            window.removeEventListener('storage', handleStorageChange);
            window.removeEventListener(THEME_REFRESH_EVENT, handleThemeRefresh);

            if (typeof mediaQuery.removeEventListener === 'function') {
                mediaQuery.removeEventListener('change', handleMediaChange);
            } else {
                mediaQuery.removeListener(handleMediaChange);
            }
        };
    }, [applyThemeToTerminalFrames]);

    // Terminal resize state
    const [terminalSize, setTerminalSize] = useState({ width: 460, height: 320 });
    const [isResizing, setIsResizing] = useState(false);
    const [isLoaded, setIsLoaded] = useState(false);
    const resizeRef = useRef({ startX: 0, startY: 0, startWidth: 0, startHeight: 0 });
    const [terminalInteractionMode, setTerminalInteractionMode] = useState<TerminalInteractionMode>('scroll');
    const [isUpdatingTerminalInteractionMode, setIsUpdatingTerminalInteractionMode] = useState(false);
    const terminalInteractionRequestIdRef = useRef(0);

    useEffect(() => {
        setLastFileBrowserPath(worktree || repo);
    }, [repo, worktree]);

    useEffect(() => {
        const saved = localStorage.getItem(TERMINAL_SIZE_STORAGE_KEY);
        if (saved) {
            try {
                setTerminalSize(JSON.parse(saved));
            } catch (e) {
                console.error('Failed to parse saved terminal size', e);
            }
        }

        const savedSplitRatio = localStorage.getItem(SPLIT_RATIO_STORAGE_KEY);
        if (savedSplitRatio) {
            const parsed = Number.parseFloat(savedSplitRatio);
            if (!Number.isNaN(parsed)) {
                setAgentPaneRatio(clampAgentPaneRatio(parsed));
            }
        }

        // Start with the right panel hidden on each session load.
        setIsRightPanelCollapsed(true);
        setIsLoaded(true);
    }, []);

    const startResize = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsResizing(true);
        resizeRef.current = {
            startX: e.clientX,
            startY: e.clientY,
            startWidth: terminalSize.width,
            startHeight: terminalSize.height
        };
    };

    useEffect(() => {
        if (!isResizing) return;

        const handleMouseMove = (e: MouseEvent) => {
            const deltaX = resizeRef.current.startX - e.clientX; // Dragging left increases width
            const deltaY = resizeRef.current.startY - e.clientY; // Dragging up increases height

            setTerminalSize({
                width: Math.max(300, Math.min(window.innerWidth - 32, resizeRef.current.startWidth + deltaX)),
                height: Math.max(100, Math.min(window.innerHeight - 32, resizeRef.current.startHeight + deltaY))
            });
        };

        const handleMouseUp = () => {
            setIsResizing(false);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isResizing]);

    useEffect(() => {
        if (isLoaded && !isResizing) {
            localStorage.setItem(TERMINAL_SIZE_STORAGE_KEY, JSON.stringify(terminalSize));
        }
    }, [isLoaded, isResizing, terminalSize]);

    useEffect(() => {
        if (isLoaded && !isSplitResizing) {
            localStorage.setItem(SPLIT_RATIO_STORAGE_KEY, String(agentPaneRatio));
        }
    }, [agentPaneRatio, isLoaded, isSplitResizing]);

    useEffect(() => {
        if (!isLoaded) return;
        localStorage.setItem(RIGHT_PANEL_COLLAPSED_STORAGE_KEY, isRightPanelCollapsed ? '1' : '0');
    }, [isLoaded, isRightPanelCollapsed]);

    useEffect(() => {
        if (!isRightPanelCollapsed) return;
        setIsSplitResizing(false);
    }, [isRightPanelCollapsed]);

    const startSplitResize = (e: React.MouseEvent<HTMLDivElement>) => {
        if (isRightPanelCollapsed) return;
        e.preventDefault();
        setIsSplitResizing(true);
        splitResizeRef.current = {
            startX: e.clientX,
            startRatio: agentPaneRatio,
        };
    };

    const handleToggleRightPanelCollapse = useCallback(() => {
        setIsRightPanelCollapsed((previous) => !previous);
    }, []);

    const handleRepoButtonClick = useCallback(() => {
        if (isRightPanelCollapsed) {
            setIsRightPanelCollapsed(false);
        }
        setIsRepoViewActive((previous) => !previous);
    }, [isRightPanelCollapsed]);

    useEffect(() => {
        if (!isSplitResizing) return;

        const handleMouseMove = (e: MouseEvent) => {
            const container = splitContainerRef.current;
            if (!container) return;

            const rect = container.getBoundingClientRect();
            if (rect.width <= 0) return;

            const delta = e.clientX - splitResizeRef.current.startX;
            const nextLeftWidth = splitResizeRef.current.startRatio * rect.width + delta;
            setAgentPaneRatio(clampAgentPaneRatio(nextLeftWidth / rect.width));
        };

        const handleMouseUp = () => {
            setIsSplitResizing(false);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };
    }, [isSplitResizing]);

    // Auto-scroll and focus terminal when restored from minimized state
    useEffect(() => {
        if (!isTerminalMinimized && terminalRef.current) {
            const iframe = terminalRef.current;
            // Small delay to allow layout to update and iframe to render
            setTimeout(() => {
                try {
                    const win = iframe.contentWindow as TerminalWindow | null;
                    if (win && win.term) {
                        win.term.scrollToBottom?.();
                        win.focus();
                        const textarea = iframe.contentDocument?.querySelector("textarea.xterm-helper-textarea");
                        if (textarea) (textarea as HTMLElement).focus();
                    }
                } catch (e) {
                    console.error('Failed to focus/scroll terminal on restore:', e);
                }
            }, 100);
        }
    }, [isTerminalMinimized]);

    // IDE Selection
    const [selectedIde, setSelectedIde] = useState<string>('vscode');

    useEffect(() => {
        const trimmedTitle = title?.trim();
        if (trimmedTitle) {
            document.title = `${trimmedTitle} | Palx`;
            return () => {
                document.title = 'Palx';
            };
        }

        document.title = 'Palx';
        return undefined;
    }, [title]);

    useEffect(() => {
        const loadConfig = async () => {
            const config = await getConfig();
            if (config.selectedIde && SUPPORTED_IDES.some(ide => ide.id === config.selectedIde)) {
                setSelectedIde(config.selectedIde);
            }
        };
        loadConfig();
    }, []);

    useEffect(() => {
        setCurrentBaseBranch(baseBranch?.trim() || '');
        setBaseBranchOptions([]);
    }, [baseBranch, sessionName]);

    useEffect(() => {
        setTerminalInteractionMode('scroll');
        setIsUpdatingTerminalInteractionMode(false);
        terminalInteractionRequestIdRef.current += 1;
    }, [sessionName]);

    const handleIdeChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
        const value = e.target.value;
        setSelectedIde(value);
        await updateConfig({ selectedIde: value });
    };

    const handleOpenIde = () => {
        if (!worktree) return;
        const ide = SUPPORTED_IDES.find(i => i.id === selectedIde);
        if (!ide) return;

        const uri = `${ide.protocol}://file/${encodeURI(worktree)}`;
        window.open(uri, '_blank');
    };

    const applyTerminalInteractionMode = useCallback(async (
        mode: TerminalInteractionMode,
        options?: { silent?: boolean }
    ): Promise<boolean> => {
        if (terminalPersistenceMode !== 'tmux') return true;

        const requestId = ++terminalInteractionRequestIdRef.current;
        if (!options?.silent) {
            setIsUpdatingTerminalInteractionMode(true);
        }

        const mouseEnabled = mode === 'scroll';
        const [agentResult, terminalResult] = await Promise.all([
            setTmuxSessionMouseMode(sessionName, 'agent', mouseEnabled),
            setTmuxSessionMouseMode(sessionName, 'terminal', mouseEnabled),
        ]);

        if (requestId !== terminalInteractionRequestIdRef.current) {
            return false;
        }

        if (!options?.silent) {
            setIsUpdatingTerminalInteractionMode(false);
        }

        const failed = [agentResult, terminalResult].find((result) => !result.success);
        if (failed) {
            if (!options?.silent) {
                setFeedback(`Failed to switch to ${mode === 'scroll' ? 'scroll mode' : 'text select mode'}`);
            }
            return false;
        }

        if (!options?.silent) {
            setFeedback(mode === 'scroll' ? 'Terminal mode: Scroll' : 'Terminal mode: Text Select');
        }
        return true;
    }, [sessionName, terminalPersistenceMode]);

    const ensureTmuxStatusBarHidden = useCallback((slot: TerminalBootstrapSlot) => {
        if (terminalPersistenceMode !== 'tmux') return;
        if (tmuxStatusAppliedRef.current[slot]) return;

        void (async () => {
            const result = await setTmuxSessionStatusVisibility(sessionName, slot, false);
            if (result.success && result.applied) {
                tmuxStatusAppliedRef.current[slot] = true;
            } else if (!result.success) {
                console.error(`Failed to hide tmux status bar for ${slot}:`, result.error);
            }
        })();
    }, [sessionName, terminalPersistenceMode]);

    useEffect(() => {
        if (terminalPersistenceMode !== 'tmux') return;
        void applyTerminalInteractionMode('scroll', { silent: true });
    }, [applyTerminalInteractionMode, terminalPersistenceMode]);

    const handleToggleTerminalInteractionMode = useCallback(() => {
        if (terminalPersistenceMode !== 'tmux' || isUpdatingTerminalInteractionMode) return;

        const previousMode = terminalInteractionMode;
        const nextMode: TerminalInteractionMode = previousMode === 'scroll' ? 'select' : 'scroll';
        setTerminalInteractionMode(nextMode);

        void (async () => {
            const success = await applyTerminalInteractionMode(nextMode);
            if (!success) {
                setTerminalInteractionMode(previousMode);
            }
        })();
    }, [applyTerminalInteractionMode, isUpdatingTerminalInteractionMode, terminalInteractionMode, terminalPersistenceMode]);

    const handleNewAttempt = () => {
        if (!repo || !sessionName) return;
        const nextUrl = `/new?repo=${encodeURIComponent(repo)}&prefillFromSession=${encodeURIComponent(sessionName)}`;
        window.open(nextUrl, '_blank', 'noopener,noreferrer');
    };

    const runCleanup = async (requireConfirmation = true): Promise<boolean> => {
        if (!repo || !worktree || !branch) return false;
        if (requireConfirmation && !confirm('Are you sure you want to delete this session? This will remove the branch and worktree.')) return false;

        setCleanupError(null);
        setCleanupPhase('idle');
        setFeedback('Purging session...');

        try {
            const result = await deleteSessionInBackground(sessionName);
            if (!result.success) {
                console.error('Cleanup failed:', result.error || 'Unknown error');
                setCleanupPhase('error');
                setCleanupError(result.error || 'Failed to delete session');
                return false;
            }

            notifySessionsUpdated();
        } catch (error) {
            console.error('Cleanup request failed:', error);
            setCleanupPhase('error');
            setCleanupError(error instanceof Error ? error.message : 'Unknown error');
            return false;
        }

        // Use forced navigation here because App Router transitions can be
        // interrupted by iframe/server-action teardown in production builds.
        onExit(true);
        return true;
    };

    const handleCleanup = async () => {
        await runCleanup(true);
    };

    const pasteIntoAgentIframe = useCallback((text: string): Promise<boolean> => {
        return new Promise((resolve) => {
            const iframe = iframeRef.current;
            if (!iframe) {
                resolve(false);
                return;
            }

            const checkAndPaste = (attempts = 0) => {
                if (attempts > 30) {
                    resolve(false);
                    return;
                }

                try {
                    const win = iframe.contentWindow as TerminalWindow | null;
                    if (!win || !win.term) {
                        setTimeout(() => checkAndPaste(attempts + 1), 300);
                        return;
                    }

                    win.term.paste(text);

                    const textarea = iframe.contentDocument?.querySelector("textarea.xterm-helper-textarea");
                    if (textarea) {
                        (textarea as HTMLElement).focus();
                    }
                    win.focus();
                    resolve(true);
                } catch (e) {
                    console.error('Failed to paste into agent iframe:', e);
                    setTimeout(() => checkAndPaste(attempts + 1), 300);
                }
            };

            checkAndPaste();
        });
    }, []);

    const handleInsertFilePaths = useCallback(async (paths: string[]) => {
        if (paths.length === 0) return;

        setIsInsertingFilePaths(true);
        const textToInsert = `${paths.join(' ')} `;
        const inserted = await pasteIntoAgentIframe(textToInsert);
        setFeedback(
            inserted
                ? `Inserted ${paths.length} file path${paths.length === 1 ? '' : 's'} into agent input`
                : 'Failed to insert file paths into agent input'
        );
        setIsInsertingFilePaths(false);
    }, [pasteIntoAgentIframe]);

    const resolveComponentSourcePathByNames = useCallback(async (componentNames: string[]): Promise<{ resolvedName: string; sourcePath: string } | null> => {
        const normalizedNames = componentNames.map(normalizeComponentLookupName).filter(Boolean);
        if (normalizedNames.length === 0) return null;

        const roots = Array.from(
            new Set(
                [repo, worktree]
                    .map((root) => (root || '').trim())
                    .filter(Boolean)
            )
        );
        if (roots.length === 0) return null;

        for (const workspaceRoot of roots) {
            try {
                const response = await fetch('/api/component-source/resolve', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        componentNames: normalizedNames,
                        workspaceRoot,
                    }),
                });

                const payload = await response.json().catch(() => null) as { resolvedName?: string; sourcePath?: string; error?: string } | null;
                if (!response.ok) {
                    console.warn('Component source resolve miss', {
                        componentNames: normalizedNames,
                        workspaceRoot,
                        error: payload?.error || response.statusText,
                    });
                    continue;
                }

                const sourcePath = typeof payload?.sourcePath === 'string' ? payload.sourcePath.trim() : '';
                const resolvedName = typeof payload?.resolvedName === 'string' ? payload.resolvedName.trim() : '';

                if (sourcePath && resolvedName) return { sourcePath, resolvedName };
            } catch (error) {
                console.error('Failed to resolve component source path:', error);
            }
        }

        return null;
    }, [repo, worktree]);

    const loadBaseBranchOptions = useCallback(async () => {
        if (!sessionName) return;
        if (isLoadingBaseBranchesRef.current) return;

        isLoadingBaseBranchesRef.current = true;
        setIsLoadingBaseBranches(true);

        try {
            const result = await listSessionBaseBranches(sessionName);
            if (result.success) {
                setBaseBranchOptions(result.branches ?? []);
                setCurrentBaseBranch(result.baseBranch?.trim() || '');
                setMainWorktreeBranch(result.mainWorktreeBranch?.trim() || '');
            } else if (result.error) {
                setFeedback(`Failed to load branches: ${result.error}`);
            }
        } catch (e) {
            console.error('Failed to load base branches:', e);
        } finally {
            isLoadingBaseBranchesRef.current = false;
            setIsLoadingBaseBranches(false);
        }
    }, [sessionName]);

    useEffect(() => {
        if (!sessionName) return;
        void loadBaseBranchOptions();
    }, [loadBaseBranchOptions, sessionName]);

    const loadSessionDivergence = useCallback(async () => {
        if (!sessionName) return;

        try {
            const result = await getSessionDivergence(sessionName);
            if (result.success && typeof result.ahead === 'number' && typeof result.behind === 'number') {
                setDivergence({ ahead: result.ahead, behind: result.behind });
            }
        } catch (e) {
            console.error('Failed to load branch divergence:', e);
        }
    }, [sessionName]);

    useEffect(() => {
        if (!sessionName || !currentBaseBranch) {
            setDivergence({ ahead: 0, behind: 0 });
            return;
        }

        void loadSessionDivergence();
        const timer = window.setInterval(() => {
            void loadSessionDivergence();
        }, 60000);

        return () => window.clearInterval(timer);
    }, [currentBaseBranch, loadSessionDivergence, sessionName]);

    const handleBaseBranchChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
        if (!sessionName) return;

        const nextBaseBranch = e.target.value.trim();
        if (!nextBaseBranch || nextBaseBranch === currentBaseBranch) return;

        setIsUpdatingBaseBranch(true);
        setFeedback(`Updating base branch to ${nextBaseBranch}...`);

        try {
            const result = await updateSessionBaseBranch(sessionName, nextBaseBranch);
            if (result.success && result.baseBranch) {
                setCurrentBaseBranch(result.baseBranch);
                setFeedback(`Base branch updated to ${result.baseBranch}`);
                await loadBaseBranchOptions();
                await loadSessionDivergence();
            } else {
                setFeedback(`Failed to update base branch: ${result.error}`);
            }
        } catch (error) {
            console.error('Failed to update base branch:', error);
            setFeedback('Failed to update base branch');
        } finally {
            setIsUpdatingBaseBranch(false);
        }
    };

    const runMerge = async (): Promise<boolean> => {
        if (!sessionName) return false;
        if (!currentBaseBranch) return false;

        setIsMerging(true);
        setFeedback('Merging session branch...');

        try {
            const result = await mergeSessionToBase(sessionName);
            if (result.success) {
                setFeedback(`Merged ${result.branchName} into ${result.baseBranch}`);
                void loadSessionDivergence();
                return true;
            } else {
                setFeedback(`Merge failed: ${result.error}`);
                return false;
            }
        } catch (e) {
            console.error('Merge request failed:', e);
            setFeedback('Merge failed');
            return false;
        } finally {
            setIsMerging(false);
        }
    };

    const handleMerge = async () => {
        await runMerge();
    };

    const [isRebaseDropdownOpen, setIsRebaseDropdownOpen] = useState(false);
    const rebaseDropdownRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (rebaseDropdownRef.current && !rebaseDropdownRef.current.contains(event.target as Node)) {
                setIsRebaseDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const handleRebaseSelect = async (targetBranch: string) => {
        setIsRebaseDropdownOpen(false);
        if (!sessionName) return;

        const isNewBranch = targetBranch !== currentBaseBranch;

        setIsRebasing(true);
        setFeedback(isNewBranch ? `Updating base to ${targetBranch} and rebasing...` : 'Rebasing session branch...');

        try {
            if (isNewBranch) {
                const updateResult = await updateSessionBaseBranch(sessionName, targetBranch);
                if (!updateResult.success) {
                    setFeedback(`Failed to update base branch: ${updateResult.error}`);
                    setIsRebasing(false);
                    return;
                }
                setCurrentBaseBranch(updateResult.baseBranch!);
                await loadBaseBranchOptions();
            }

            const result = await rebaseSessionOntoBase(sessionName);
            if (result.success) {
                setFeedback(`Rebased ${result.branchName} onto ${result.baseBranch}`);
                void loadSessionDivergence();
            } else {
                setFeedback(`Rebase failed: ${result.error}`);
            }
        } catch (e) {
            console.error('Rebase request failed:', e);
            setFeedback('Rebase failed');
        } finally {
            setIsRebasing(false);
        }
    };

    const handleRebase = () => {
        setIsRebaseDropdownOpen(!isRebaseDropdownOpen);
    };

    const createBranchFromOptions = useMemo(() => {
        const candidates = [
            mainWorktreeBranch,
            currentBaseBranch,
            ...baseBranchOptions,
        ]
            .map((value) => value.trim())
            .filter(Boolean);

        return Array.from(new Set(candidates)).sort((a, b) => a.localeCompare(b));
    }, [baseBranchOptions, currentBaseBranch, mainWorktreeBranch]);

    const closeCreateBaseBranchDialog = useCallback(() => {
        if (isCreatingBaseBranch) return;
        setIsCreateBaseBranchDialogOpen(false);
        setNewBaseBranchName('');
        setNewBaseBranchFrom('');
    }, [isCreatingBaseBranch]);

    const openCreateBaseBranchDialog = useCallback(() => {
        const defaultFromBranch = mainWorktreeBranch.trim()
            || currentBaseBranch.trim()
            || createBranchFromOptions[0]
            || '';
        setIsRebaseDropdownOpen(false);
        setNewBaseBranchName('');
        setNewBaseBranchFrom(defaultFromBranch);
        setIsCreateBaseBranchDialogOpen(true);
    }, [createBranchFromOptions, currentBaseBranch, mainWorktreeBranch]);

    const handleCreateBaseBranch = useCallback(async () => {
        if (!sessionName) return;

        const targetBranchName = newBaseBranchName.trim();
        const sourceBranchName = newBaseBranchFrom.trim();
        if (!targetBranchName || !sourceBranchName) return;

        setIsCreatingBaseBranch(true);
        setFeedback(`Creating branch ${targetBranchName} from ${sourceBranchName}...`);

        try {
            const result = await createSessionBaseBranch(sessionName, targetBranchName, sourceBranchName);
            if (result.success && result.branchName && result.fromBranch) {
                setFeedback(`Created branch ${result.branchName} from ${result.fromBranch}`);
                setIsCreateBaseBranchDialogOpen(false);
                setNewBaseBranchName('');
                setNewBaseBranchFrom('');
                await loadBaseBranchOptions();
            } else {
                setFeedback(`Failed to create branch: ${result.error}`);
            }
        } catch (error) {
            console.error('Failed to create base branch:', error);
            setFeedback('Failed to create branch');
        } finally {
            setIsCreatingBaseBranch(false);
        }
    }, [loadBaseBranchOptions, newBaseBranchFrom, newBaseBranchName, sessionName]);

    const loadPreviewViaProxy = useCallback(async (rawUrl: string, openPreview: boolean): Promise<boolean> => {
        const normalized = normalizePreviewUrl(rawUrl);
        if (!normalized) {
            setFeedback('Please enter a preview URL');
            return false;
        }

        setPreviewInputUrl(normalized);
        setIsPreviewPickerActive(false);
        setFeedback(`Loading preview: ${normalized}`);

        try {
            const response = await fetch('/api/preview-proxy/start', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    target: normalized,
                }),
            });

            const payload = await response.json().catch(() => null) as { error?: string; proxyUrl?: string } | null;
            if (!response.ok || !payload?.proxyUrl) {
                throw new Error(payload?.error || 'Failed to start preview proxy');
            }

            setPreviewUrl(payload.proxyUrl);
            if (openPreview) {
                setIsPreviewVisible(true);
            }
            setFeedback(`Loaded preview: ${normalized}`);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to load preview';
            console.error('Failed to load preview via proxy:', error);
            setFeedback(`Failed to load preview: ${message}`);
            return false;
        }
    }, []);

    const handleTogglePreviewPicker = useCallback(() => {
        if (!previewUrl) {
            setFeedback('Load a preview before picking elements');
            return;
        }

        const previewWindow = previewIframeRef.current?.contentWindow;
        if (!previewWindow) {
            setFeedback('Preview is not ready yet');
            return;
        }

        const nextState = !isPreviewPickerActive;
        previewWindow.postMessage({
            type: 'viba:preview-picker-toggle',
            active: nextState,
        }, '*');

        setIsPreviewPickerActive(nextState);
        setFeedback(nextState ? 'Picker enabled: click an element in the preview' : 'Picker disabled');
    }, [isPreviewPickerActive, previewUrl]);

    const postPreviewControlMessage = useCallback((payload: { action?: PreviewNavigationAction; type: string }) => {
        const previewWindow = previewIframeRef.current?.contentWindow;
        if (!previewWindow) {
            setFeedback('Preview is not ready yet');
            return false;
        }

        previewWindow.postMessage(payload, '*');
        return true;
    }, []);

    const handlePreviewNavigate = useCallback((action: PreviewNavigationAction) => {
        if (!previewUrl) {
            setFeedback('Load a preview before using navigation controls');
            return;
        }

        if (!postPreviewControlMessage({ type: 'viba:preview-navigation', action })) {
            return;
        }

        if (action === 'reload') {
            setFeedback('Reloading preview...');
        }
    }, [postPreviewControlMessage, previewUrl]);

    const handleUnloadPreview = useCallback(() => {
        if (!previewUrl) {
            setFeedback('Preview is already unloaded');
            return;
        }

        setPreviewUrl('');
        setIsPreviewPickerActive(false);
        setFeedback('Preview unloaded');
    }, [previewUrl]);

    const handlePreviewIframeLoad = useCallback(() => {
        postPreviewControlMessage({ type: 'viba:preview-location-request' });
    }, [postPreviewControlMessage]);

    const { attachTerminalLinkHandler } = useTerminalLink({
        onLoadPreview: loadPreviewViaProxy
    });

    useEffect(() => {
        if (!isPreviewVisible) return;
        if (previewInputUrl.trim()) return;

        const timer = window.setTimeout(() => {
            previewAddressInputRef.current?.focus();
        }, 0);

        return () => {
            window.clearTimeout(timer);
        };
    }, [isPreviewVisible, previewInputUrl]);

    useEffect(() => {
        const handlePreviewMessage = (event: MessageEvent) => {
            if (!previewIframeRef.current || event.source !== previewIframeRef.current.contentWindow) return;

            const payload = event.data as {
                active?: boolean;
                element?: unknown;
                type?: string;
                url?: unknown;
            } | null;
            if (!payload || typeof payload !== 'object') return;

            if (payload.type === 'viba:preview-picker-state') {
                setIsPreviewPickerActive(Boolean(payload.active));
                return;
            }

            if (payload.type === 'viba:preview-picker-ready') {
                const previewWindow = previewIframeRef.current?.contentWindow;
                if (previewWindow) {
                    previewWindow.postMessage({ type: 'viba:preview-location-request' }, '*');
                }
                return;
            }

            if (payload.type === 'viba:preview-link-open') {
                if (typeof payload.url === 'string' && payload.url.trim().length > 0) {
                    window.open(payload.url, '_blank', 'noopener,noreferrer');
                }
                return;
            }

            if (payload.type === 'viba:preview-location-change') {
                if (typeof payload.url === 'string' && payload.url.trim().length > 0) {
                    setPreviewInputUrl(payload.url);
                }
                return;
            }

            if (payload.type === 'viba:preview-element-selected') {
                const selectedElement = (payload.element && typeof payload.element === 'object')
                    ? payload.element as { reactComponentStack?: unknown[]; selector?: string | null }
                    : null;
                const reactStack = Array.isArray(selectedElement?.reactComponentStack)
                    ? selectedElement.reactComponentStack
                    : [];
                const componentReference = buildComponentReferenceText(reactStack, worktree || repo);
                const firstReactComponent = reactStack[0] && typeof reactStack[0] === 'object'
                    ? (reactStack[0] as { name?: unknown }).name
                    : undefined;
                const fallbackName = typeof firstReactComponent === 'string' && firstReactComponent.trim().length > 0
                    ? firstReactComponent.trim()
                    : '';
                const builtInComponents = new Set([
                    'Suspense', 'ErrorBoundary', 'Router', 'AppRouter', 'LayoutRouter',
                    'RenderFromTemplateContext', 'ScrollAndFocusHandler', 'InnerLayoutRouter',
                    'RedirectErrorBoundary', 'NotFoundBoundary', 'LoadingBoundary',
                    'ReactDevOverlay', 'HotReload', 'AppContainer', 'Route', 'Link', 'Image',
                    'OuterLayoutRouter', 'Head', 'StringRefs', 'Fragment', 'Profiler',
                    'StrictMode', 'SuspenseList', 'Script', 'Page', '__next_root_layout_boundary__'
                ]);

                const stackComponentNames = Array.from(
                    new Set(
                        reactStack
                            .map((entry) => {
                                if (!entry || typeof entry !== 'object') return '';
                                const name = (entry as { name?: unknown }).name;
                                return typeof name === 'string' ? name.trim() : '';
                            })
                            .filter((name) => {
                                if (!name) return false;
                                if (builtInComponents.has(name)) return false;
                                if (name.startsWith('styled.') || name.startsWith('Styled(')) return false;
                                return true;
                            })
                    )
                );

                console.log('Filtered stack component names:', stackComponentNames);

                const identifier = componentReference
                    || fallbackName
                    || (typeof selectedElement?.selector === 'string' ? selectedElement.selector : '');

                console.log('Preview selected element:', selectedElement);
                console.log('Preview selected reactComponentStack:', reactStack);
                console.log('Preview selected identifier:', identifier);
                setIsPreviewPickerActive(false);

                if (!identifier) {
                    setFeedback('Element selected. No identifier was resolved.');
                    return;
                }

                void (async () => {
                    let finalIdentifier = componentReference || '';

                    if (!finalIdentifier && stackComponentNames.length > 0) {
                        setIsResolvingElement(true);
                        try {
                            const result = await resolveComponentSourcePathByNames(stackComponentNames);
                            if (result?.resolvedName && result?.sourcePath) {
                                finalIdentifier = `${result.resolvedName} (${result.sourcePath})`;
                            }
                        } finally {
                            setIsResolvingElement(false);
                        }
                    }

                    if (!finalIdentifier) {
                        if (stackComponentNames.length > 0) {
                            setFeedback('Element selected, but source file path could not be resolved for the component');
                            return;
                        }
                        finalIdentifier = identifier;
                    }

                    console.log('Final resolved component identifier:', finalIdentifier);

                    const inserted = await pasteIntoAgentIframe(`${finalIdentifier} `);
                    setFeedback(
                        inserted
                            ? `Element identifier sent to agent: ${finalIdentifier}`
                            : 'Element selected, but failed to send identifier to agent input'
                    );
                })();
            }
        };

        window.addEventListener('message', handlePreviewMessage);
        return () => {
            window.removeEventListener('message', handlePreviewMessage);
        };
    }, [pasteIntoAgentIframe, repo, resolveComponentSourcePathByNames, worktree]);

    useEffect(() => {
        setIsPreviewPickerActive(false);
    }, [previewUrl]);

    const handlePreviewSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void loadPreviewViaProxy(previewInputUrl, true);
    };

    const handleOpenPreviewInNewTab = useCallback(() => {
        const preferredTarget = previewInputUrl.trim() || previewUrl;
        const normalizedTarget = normalizePreviewUrl(preferredTarget);

        if (!normalizedTarget) {
            setFeedback('Please enter a preview URL');
            return;
        }

        window.open(normalizedTarget, '_blank', 'noopener,noreferrer');
        setFeedback(`Opened preview in new tab: ${normalizedTarget}`);
    }, [previewInputUrl, previewUrl]);

    const handleStartDevServer = () => {
        const script = devServerScript?.trim();
        if (!script || !terminalRef.current || isTerminalForegroundProcessRunning) return;

        // Auto-show terminal if minimized
        setIsTerminalMinimized(false);

        const iframe = terminalRef.current;
        setIsStartingDevServer(true);
        setFeedback('Starting dev server...');

        const checkAndInject = (attempts = 0) => {
            if (attempts > 30) {
                setFeedback('Failed to start dev server: terminal is not ready');
                setIsStartingDevServer(false);
                return;
            }

            try {
                const win = iframe.contentWindow as TerminalWindow | null;
                if (win && win.term) {
                    win.term.paste(script);

                    const textarea = iframe.contentDocument?.querySelector("textarea.xterm-helper-textarea");
                    if (textarea) {
                        textarea.dispatchEvent(new KeyboardEvent('keypress', {
                            bubbles: true,
                            cancelable: true,
                            charCode: 13,
                            keyCode: 13,
                            key: 'Enter',
                            view: win
                        }));
                    } else {
                        win.term.paste('\r');
                    }

                    win.focus();
                    if (textarea) (textarea as HTMLElement).focus();

                    setFeedback('Dev server start command sent');
                    setIsStartingDevServer(false);
                } else {
                    setTimeout(() => checkAndInject(attempts + 1), 300);
                }
            } catch (e) {
                console.error('Dev server injection error', e);
                setFeedback('Failed to start dev server');
                setIsStartingDevServer(false);
            }
        };

        checkAndInject();
    };

    const handleIframeLoad = () => {
        if (!iframeRef.current) return;
        const iframe = iframeRef.current;
        setIsAgentTerminalThemeReady(false);

        // Safety check for Same-Origin to avoid errors if proxy isn't working
        try {
            // Just accessing contentWindow to see if it throws
            const _ = iframe.contentWindow;
        } catch (e) {
            setFeedback("Error: Cross-Origin access blocked. Ensure proxy is working.");
            return;
        }

        if (iframe.contentWindow) {
            // Attempt to nullify the internal ttyd handler
            iframe.contentWindow.onbeforeunload = null;

            // Or add a high-priority listener that stops the popup
            iframe.contentWindow.addEventListener('beforeunload', (event) => {
                event.stopImmediatePropagation();
            }, true);
        }

        setFeedback('Connecting to terminal...');

        const checkAndInject = (attempts = 0) => {
            if (attempts > 30) {
                setFeedback('Timeout waiting for terminal to be ready');
                return;
            }

            try {
                const win = iframe.contentWindow as TerminalWindow | null;
                if (win && win.term) {
                    ensureTmuxStatusBarHidden('agent');
                    const term = win.term;
                    attachTerminalLinkHandler(iframe, agentFrameLinkCleanupRef, {
                        directOpenBehavior: 'new_tab',
                        modifierOpenBehavior: 'new_tab',
                    });

                    // Clear current input line on Cmd+Backspace/Cmd+Delete.
                    const terminalWithShortcutState = term as TerminalWithClearLineShortcutState;
                    if (!terminalWithShortcutState.__vibaClearLineShortcutInstalled && typeof term.attachCustomKeyEventHandler === 'function') {
                        const existingCustomKeyEventHandler = term.customKeyEventHandler;
                        term.attachCustomKeyEventHandler((event: KeyboardEvent) => {
                            if (event.type === 'keydown' && event.metaKey && (event.key === 'Backspace' || event.key === 'Delete')) {
                                const coreService = term._core?.coreService;
                                if (coreService && typeof coreService.triggerDataEvent === 'function') {
                                    coreService.triggerDataEvent('\x15', true);
                                } else {
                                    const textarea = iframe.contentDocument?.querySelector("textarea.xterm-helper-textarea");
                                    if (textarea) {
                                        textarea.dispatchEvent(new KeyboardEvent('keydown', {
                                            bubbles: true,
                                            cancelable: true,
                                            key: 'u',
                                            keyCode: 85,
                                            ctrlKey: true,
                                            view: win
                                        }));
                                    } else {
                                        term.paste('\x15');
                                    }
                                }
                                return false;
                            }

                            if (typeof existingCustomKeyEventHandler === 'function') {
                                try {
                                    return existingCustomKeyEventHandler.call(term, event) !== false;
                                } catch (error) {
                                    console.error('Existing terminal key handler failed:', error);
                                }
                            }
                            return true;
                        });
                        terminalWithShortcutState.__vibaClearLineShortcutInstalled = true;
                    }

                    // Ensure terminal palette stays in sync with app/OS theme.
                    const themeApplied = applyThemeToTerminalWindow(win);
                    if (themeApplied) {
                        setIsAgentTerminalThemeReady(true);
                    }

                    const alreadyBootstrapped = hasTerminalBootstrapped('agent');
                    const shouldSkipResumeInjection = Boolean(isResume) && terminalPersistenceMode === 'tmux';
                    if (alreadyBootstrapped || shouldSkipResumeInjection) {
                        if (shouldSkipResumeInjection && !alreadyBootstrapped) {
                            markTerminalBootstrapped('agent');
                            setFeedback('Attached to persisted terminal');
                        } else {
                            setFeedback('Reconnected to terminal');
                        }
                        win.focus();
                        const textarea = iframe.contentDocument?.querySelector("textarea.xterm-helper-textarea");
                        if (textarea) (textarea as HTMLElement).focus();
                        return;
                    }

                    if (!isShellPromptReady(term) && attempts < 10) {
                        setTimeout(() => checkAndInject(attempts + 1), 200);
                        return;
                    }

                    if (!beginTerminalBootstrap('agent')) {
                        setFeedback('Reconnected to terminal');
                        win.focus();
                        const textarea = iframe.contentDocument?.querySelector("textarea.xterm-helper-textarea");
                        if (textarea) (textarea as HTMLElement).focus();
                        return;
                    }

                    // Attempt injection

                    // User instructions:
                    // 1. paste cd command
                    // 2. dispatch keypress 13

                    const targetPath = worktree || repo; // Fallback to repo if no worktree
                    const cmd = `cd ${quoteShellArg(targetPath)}`;
                    // Send cd command
                    term.paste(cmd);

                    // Helper to press enter
                    const pressEnter = () => {
                        const textarea = iframe.contentDocument?.querySelector("textarea.xterm-helper-textarea");
                        if (textarea) {
                            textarea.dispatchEvent(new KeyboardEvent('keypress', {
                                bubbles: true,
                                cancelable: true,
                                charCode: 13,
                                keyCode: 13,
                                key: 'Enter',
                                view: win
                            }));
                        } else {
                            term.paste('\r');
                        }
                    };

                    pressEnter();
                    markTerminalBootstrapped('agent');

                    // Inject agent command if present
                    if (agent) {
                        const startAgentProcess = async () => {
                            let agentCmd = '';
                            const withCodexMonochromeEnv = (command: string): string => {
                                return `${CODEX_MONOCHROME_ENV_PREFIX} ${command}`;
                            };
                            const withCodexApiKeyLogin = (command: string): string => {
                                return `if [ -n "$OPENAI_API_KEY" ]; then printenv OPENAI_API_KEY | codex login --with-api-key || exit 1; fi; ${command}`;
                            };

                            if (isResume) {
                                const resumeCmd = withCodexMonochromeEnv(`codex resume --last ${CODEX_PLAIN_THEME_FLAG} --sandbox danger-full-access --ask-for-approval on-request --search`);
                                agentCmd = withCodexApiKeyLogin(resumeCmd);
                            } else {
                                const trimmedInitialMessage = initialMessage?.trim() || '';
                                const taskContent = trimmedInitialMessage;
                                const normalizedAttachmentPaths = (
                                    attachmentPaths && attachmentPaths.length > 0
                                        ? attachmentPaths
                                        : (attachmentNames || [])
                                            .map((name) => `${worktree || repo}-attachments/${name}`)
                                )
                                    .map((entry) => entry.trim())
                                    .filter(Boolean);
                                const resolvedAttachmentPaths = Array.from(new Set(normalizedAttachmentPaths));
                                const taskSections: string[] = [];
                                if (taskContent) taskSections.push(taskContent);
                                if (resolvedAttachmentPaths.length > 0) {
                                    taskSections.push([
                                        'Attachments:',
                                        ...resolvedAttachmentPaths.map((attachmentPath) => `- ${attachmentPath}`),
                                    ].join('\n'));
                                }
                                const fullTaskContent = taskSections.join('\n\n');
                                let safeMessage = '';

                                // Send startup prompt when user provided a task or attachments.
                                if (fullTaskContent) {
                                    const instructionLines: string[] = [];
                                    if (sessionMode === 'plan') {
                                        instructionLines.push(PLAN_MODE_STARTUP_INSTRUCTION);
                                    }
                                    instructionLines.push(AUTO_COMMIT_INSTRUCTION);
                                    instructionLines.push(AGENT_BROWSER_SKILL_INSTRUCTION);
                                    instructionLines.push(SYSTEMATIC_DEBUGGING_SKILL_INSTRUCTION);
                                    instructionLines.push(VISUAL_EVIDENCE_INSTRUCTION);
                                    instructionLines.push(NOTIFICATION_INSTRUCTION);
                                    const notificationApiUrl = `${window.location.origin}/api/notifications`;
                                    instructionLines.push(
                                        `Notification API endpoint: ${notificationApiUrl} (POST JSON with sessionId, title, and description).`
                                    );
                                    instructionLines.push(
                                        `Notification payload template: {"sessionId":"${sessionName}","title":"<short title>","description":"<clear detail about completion or required attention>"}.`
                                    );

                                    const fullMessage = [
                                        '# Instructions',
                                        '',
                                        instructionLines.map((line) => `- ${line}`).join('\n'),
                                        '',
                                        '# Task',
                                        '',
                                        fullTaskContent,
                                    ].join('\n');

                                    try {
                                        const result = await writeSessionPromptFile(sessionName, fullMessage);
                                        if (result.success && result.filePath) {
                                            safeMessage = ` "$(cat ${quoteShellArg(result.filePath)})"`;
                                        } else {
                                            console.error('Failed to write prompt file, falling back to inline prompt', result.error);
                                            safeMessage = ` ${quoteShellArg(fullMessage)}`;
                                        }
                                    } catch (err) {
                                        console.error('Exception writing prompt file', err);
                                        safeMessage = ` ${quoteShellArg(fullMessage)}`;
                                    }
                                }

                                const startCmd = withCodexMonochromeEnv(`codex ${CODEX_PLAIN_THEME_FLAG} --sandbox danger-full-access --ask-for-approval on-request --search${safeMessage}`);
                                agentCmd = withCodexApiKeyLogin(startCmd);
                            }

                            if (agentCmd) {
                                term.paste(agentCmd);
                                pressEnter();
                                setFeedback(isResume ? 'Resumed session with codex' : 'Session started with codex');

                                if (!isResume && onSessionStart) {
                                    onSessionStart();
                                }
                            }
                        };

                        setTimeout(() => startAgentProcess(), 500); // Wait a bit for cd to finish
                    } else {
                        setFeedback(`Session started ${worktree ? '(Worktree)' : ''}`);
                        if (!isResume && onSessionStart) {
                            onSessionStart();
                        }
                    }

                    // Focus the iframe
                    win.focus();
                    const textarea = iframe.contentDocument?.querySelector("textarea.xterm-helper-textarea");
                    if (textarea) (textarea as HTMLElement).focus();

                } else {
                    // Not ready yet
                    setTimeout(() => checkAndInject(attempts + 1), 500);
                }
            } catch (e) {
                resetTerminalBootstrap('agent');
                console.error("Access error during injection:", e);
                setFeedback('Error accessing terminal: ' + String(e));
            }
        };

        // Small delay to allow scripts to run
        setTimeout(() => checkAndInject(), 1000);
    };

    const handleTerminalLoad = (iframeFromEvent?: HTMLIFrameElement | null) => {
        const iframe = iframeFromEvent || terminalRef.current || terminalBootstrapRef.current;
        if (!iframe) return;
        const isVisibleTerminalFrame = iframe === terminalRef.current;
        if (isVisibleTerminalFrame) {
            setIsFloatingTerminalThemeReady(false);
        }
        stopTerminalProcessMonitor();
        setIsTerminalForegroundProcessRunning(false);

        // Safety check
        try {
            const _ = iframe.contentWindow;
        } catch (e) {
            console.error("Secondary terminal: Cross-Origin access blocked.");
            return;
        }

        if (iframe.contentWindow) {
            // Attempt to nullify the internal ttyd handler
            iframe.contentWindow.onbeforeunload = null;

            // Or add a high-priority listener that stops the popup
            iframe.contentWindow.addEventListener('beforeunload', (event) => {
                event.stopImmediatePropagation();
            }, true);
        }

        const checkAndInject = (attempts = 0) => {
            if (attempts > 30) {
                return;
            }

            try {
                const win = iframe.contentWindow as TerminalWindow | null;
                if (win && win.term) {
                    ensureTmuxStatusBarHidden('terminal');
                    const term = win.term;
                    attachTerminalLinkHandler(iframe, terminalFrameLinkCleanupRef, {
                        onLinkActivated: () => setIsTerminalMinimized(true),
                        directOpenBehavior: 'preview',
                        modifierOpenBehavior: 'new_tab',
                    });

                    // Ensure terminal palette stays in sync with app/OS theme.
                    const themeApplied = applyThemeToTerminalWindow(win);
                    if (themeApplied && isVisibleTerminalFrame) {
                        setIsFloatingTerminalThemeReady(true);
                    }

                    startTerminalProcessMonitor(iframe, term);

                    // Enable auto-scroll to bottom on output
                    try {
                        const xterm = term as TerminalWithOnWriteParsed;
                        const scrollHandler = () => {
                            const activeBuffer = xterm.buffer?.active as ({ baseY?: number; viewportY?: number } | undefined);
                            const baseY = typeof activeBuffer?.baseY === 'number' ? activeBuffer.baseY : 0;
                            const viewportY = typeof activeBuffer?.viewportY === 'number' ? activeBuffer.viewportY : baseY;

                            // Only scroll if we are close to the bottom to allow reviewing history
                            if (activeBuffer && (baseY - viewportY < 10)) {
                                xterm.scrollToBottom?.();
                            } else {
                                // Fallback if buffer access fails or simple mode
                                xterm.scrollToBottom?.();
                            }
                        };

                        if (typeof xterm.onWriteParsed === 'function') {
                            xterm.onWriteParsed(scrollHandler);
                        } else {
                            // Fallback for older xterm or different setups
                            const screen = iframe.contentDocument?.querySelector('.xterm-screen') || iframe.contentDocument?.body;
                            if (screen) {
                                const observer = new MutationObserver(scrollHandler);
                                observer.observe(screen, { childList: true, subtree: true, characterData: true });
                            }
                        }
                    } catch (e) {
                        console.error('Failed to setup auto-scroll:', e);
                    }

                    const alreadyBootstrapped = hasTerminalBootstrapped('terminal');
                    const shouldSkipResumeInjection = Boolean(isResume) && terminalPersistenceMode === 'tmux';
                    if (alreadyBootstrapped || shouldSkipResumeInjection) {
                        if (shouldSkipResumeInjection && !alreadyBootstrapped) {
                            markTerminalBootstrapped('terminal');
                        }
                        if (alreadyBootstrapped) {
                            injectTerminalStartupScript(iframe, win, term);
                        }
                        win.focus();
                        const textarea = iframe.contentDocument?.querySelector("textarea.xterm-helper-textarea");
                        if (textarea) (textarea as HTMLElement).focus();
                        return;
                    }

                    if (!isShellPromptReady(term) && attempts < 10) {
                        setTimeout(() => checkAndInject(attempts + 1), 200);
                        return;
                    }

                    if (!beginTerminalBootstrap('terminal')) {
                        win.focus();
                        const textarea = iframe.contentDocument?.querySelector("textarea.xterm-helper-textarea");
                        if (textarea) (textarea as HTMLElement).focus();
                        return;
                    }

                    const targetPath = worktree || repo;
                    const cmd = `cd ${quoteShellArg(targetPath)}`;
                    term.paste(cmd);

                    const pressEnter = () => {
                        const textarea = iframe.contentDocument?.querySelector("textarea.xterm-helper-textarea");
                        if (textarea) {
                            textarea.dispatchEvent(new KeyboardEvent('keypress', {
                                bubbles: true,
                                cancelable: true,
                                charCode: 13,
                                keyCode: 13,
                                key: 'Enter',
                                view: win
                            }));
                        } else {
                            term.paste('\r');
                        }
                    };
                    pressEnter();
                    markTerminalBootstrapped('terminal');
                    injectTerminalStartupScript(iframe, win, term);

                    // Focus
                    win.focus();
                    const textarea = iframe.contentDocument?.querySelector("textarea.xterm-helper-textarea");
                    if (textarea) (textarea as HTMLElement).focus();
                } else {
                    setTimeout(() => checkAndInject(attempts + 1), 500);
                }
            } catch (e) {
                setIsTerminalForegroundProcessRunning(false);
                resetTerminalBootstrap('terminal');
                console.error("Secondary terminal injection error", e);
            }
        };

        setTimeout(() => checkAndInject(), 1000);
    };

    if (!repo) return <div className="p-4 text-error dark:bg-[#0d1117] dark:text-red-300">No repository specified</div>;

    if (cleanupPhase === 'error') {
        return (
            <div className="flex h-screen w-full items-center justify-center bg-[#f6f6f8] dark:bg-[#0d1117]">
                <div className="card w-96 border border-slate-200 bg-white shadow-xl dark:border-[#30363d] dark:bg-[#161b22]">
                    <div className="card-body items-center text-center">
                        <h2 className="card-title text-error dark:text-red-300">Cleanup failed</h2>
                        <p className="text-slate-700 dark:text-slate-300">{cleanupError || 'An unknown error occurred while cleaning up this session.'}</p>
                        <div className="card-actions justify-end">
                            <button className="btn btn-primary" onClick={() => onExit()}>Back to Home</button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    const selectableBaseBranches = Array.from(new Set([
        ...(currentBaseBranch ? [currentBaseBranch] : []),
        ...baseBranchOptions
    ])).filter((branchOption) => branchOption !== branch || branchOption === currentBaseBranch);
    const hasDevServerScript = Boolean(devServerScript?.trim());
    const isDevButtonDisabled = !hasDevServerScript || isStartingDevServer || isTerminalForegroundProcessRunning;
    const devButtonTitle = !hasDevServerScript
        ? 'Set a dev server script to enable this button'
        : isTerminalForegroundProcessRunning
            ? 'A process is already running in the terminal'
            : 'Run dev server script in terminal';

    return (
        <div className={`flex h-screen w-full flex-col overflow-hidden bg-[#f6f6f8] dark:bg-[#0d1117] ${(isResizing || isSplitResizing) ? 'select-none' : ''}`}>
            {isRightPanelCollapsed && (
                <iframe
                    ref={terminalBootstrapRef}
                    src={floatingTerminalSrc}
                    className="pointer-events-none absolute left-0 top-0 h-0 w-0 border-none opacity-0"
                    allow="clipboard-read; clipboard-write"
                    onLoad={(event) => handleTerminalLoad(event.currentTarget)}
                    aria-hidden="true"
                    tabIndex={-1}
                />
            )}
            {(isResizing || isSplitResizing) && (
                <div className={`fixed inset-0 z-[9999] ${isResizing ? 'cursor-row-resize' : 'cursor-col-resize'}`} />
            )}
            <div className="z-20 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 text-xs font-mono shadow-sm dark:border-[#30363d] dark:bg-[#161b22] dark:text-slate-300">
                <div className="flex items-center gap-4">
                    <button
                        className="btn btn-ghost btn-xs h-6 min-h-6 px-1 text-slate-600 hover:bg-base-content/10 dark:text-slate-300 dark:hover:bg-[#30363d]/60"
                        onClick={() => onExit()}
                        title="Back to Home"
                    >
                        <ChevronLeft className="w-4 h-4" />
                    </button>
                    <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                            <span className="opacity-50">Repo:</span>
                            <span className="font-bold">{getBaseName(repo)}</span>
                        </div>
                        {sessionName && (
                            <div className="hidden min-[1200px]:flex min-w-0 items-center gap-2 text-[10px] opacity-70">
                                <span>Session:</span>
                                <span className="truncate max-w-[220px]" title={sessionName}>{sessionName}</span>
                            </div>
                        )}
                    </div>
                </div>

                <div className="flex items-center gap-4">
                    <div className="flex items-center overflow-hidden rounded border border-base-content/20 bg-base-100 dark:border-[#30363d] dark:bg-[#0d1117]">
                        <button
                            className="btn btn-ghost btn-xs h-6 min-h-6 rounded-none border-none px-2 text-slate-700 hover:bg-base-content/10 dark:text-slate-300 dark:hover:bg-[#30363d]/60"
                            onClick={handleNewAttempt}
                            title="Start a new attempt in a new tab with this session context"
                        >
                            <Plus className="w-3 h-3" />
                            <span className={headerButtonLabelClass}>New Attempt</span>
                        </button>
                    </div>

                    <div className="relative flex items-center rounded border border-base-content/20 bg-base-100 dark:border-[#30363d] dark:bg-[#0d1117]" ref={rebaseDropdownRef}>
                        <div className="relative">
                            <button
                                className="btn btn-ghost btn-xs h-6 min-h-6 rounded-none rounded-l border-none px-2 text-slate-700 hover:bg-base-content/10 dark:text-slate-300 dark:hover:bg-[#30363d]/60"
                                onClick={handleRebase}
                                disabled={isRebasing || isMerging || isUpdatingBaseBranch}
                                title="Select base branch and rebase"
                            >
                                {isRebasing ? <span className="loading loading-spinner loading-xs"></span> : <GitMerge className="w-3 h-3" />}
                                <span className={headerButtonLabelClass}>Rebase</span>
                                <ChevronDown className="w-3 h-3 opacity-50 ml-0.5" />
                            </button>
                            {isRebaseDropdownOpen && (
                                <div className="dropdown-content absolute left-0 top-full z-50 mt-1 flex max-h-80 w-64 flex-col overflow-hidden rounded-box border border-base-content/20 bg-base-200 p-0 shadow-xl dark:border-[#30363d] dark:bg-[#161b22] dark:text-slate-300">
                                    <div className="flex shrink-0 items-center justify-between border-b border-base-content/10 bg-base-200 px-4 py-2 text-[10px] font-bold uppercase tracking-wider opacity-50 dark:border-[#30363d] dark:bg-[#161b22]">
                                        <span>Select Base Branch</span>
                                        {(isLoadingBaseBranches || isUpdatingBaseBranch) && <span className="loading loading-spinner loading-xs"></span>}
                                    </div>
                                    <ul className="menu custom-scrollbar w-full flex-nowrap overflow-y-auto overflow-x-hidden p-0">
                                        {selectableBaseBranches.length > 0 ? (
                                            selectableBaseBranches.map((branchOption) => (
                                                <li key={branchOption}>
                                                    <button
                                                        onClick={() => handleRebaseSelect(branchOption)}
                                                        className={`flex max-w-full items-center justify-between truncate rounded-none py-2 text-xs hover:bg-base-content/10 dark:hover:bg-[#30363d]/60 ${branchOption === currentBaseBranch ? 'active font-bold' : ''}`}
                                                        title={branchOption}
                                                    >
                                                        <span className="truncate">{branchOption}</span>
                                                        {branchOption === currentBaseBranch && <span className="opacity-70 text-[10px] ml-2 shrink-0">(Current)</span>}
                                                    </button>
                                                </li>
                                            ))
                                        ) : (
                                            <li className="text-xs px-4 py-2 opacity-50 italic text-center">No other branches found</li>
                                        )}
                                        <div className="divider my-1 opacity-50 dark:before:bg-[#30363d] dark:after:bg-[#30363d]"></div>
                                        <li>
                                            <button onClick={openCreateBaseBranchDialog} className="text-[10px] justify-center opacity-70 hover:opacity-100">
                                                Create New Branch...
                                            </button>
                                        </li>
                                        <li>
                                            <button onClick={() => void loadBaseBranchOptions()} className="text-[10px] justify-center opacity-70 hover:opacity-100">
                                                Refresh Branches
                                            </button>
                                        </li>
                                    </ul>
                                </div>
                            )}
                        </div>
                        <div className="h-4 w-[1px] bg-base-content/10 dark:bg-[#30363d]"></div>
                        <button
                            className="btn btn-ghost btn-xs btn-success h-6 min-h-6 rounded-none border-none px-2 hover:border-transparent hover:bg-success/20 dark:text-emerald-300"
                            onClick={handleMerge}
                            disabled={isMerging || isRebasing || isUpdatingBaseBranch || !currentBaseBranch}
                            title={currentBaseBranch ? `Merge current branch (${branch}) into target branch (${currentBaseBranch})` : 'Target branch unavailable for this session'}
                        >
                            {isMerging ? <span className="loading loading-spinner loading-xs"></span> : <GitPullRequestArrow className="w-3 h-3" />}
                            <span className={headerButtonLabelClass}>Merge</span>
                        </button>
                        <div className="h-4 w-[1px] bg-base-content/10 dark:bg-[#30363d]"></div>
                        <button
                            className="btn btn-ghost btn-error btn-xs h-6 min-h-6 rounded-none rounded-r border-none px-2 hover:border-transparent hover:bg-error/20 dark:text-red-300"
                            onClick={handleCleanup}
                            disabled={isMerging || isRebasing || !worktree}
                            title="Clean up and exit"
                        >
                            <Trash2 className="w-3 h-3" />
                            <span className={headerButtonLabelClass}>Delete</span>
                        </button>
                    </div>

                    <div className="flex items-center overflow-hidden rounded border border-base-content/20 bg-base-100 dark:border-[#30363d] dark:bg-[#0d1117]">
                        <button
                            type="button"
                            className={`btn btn-ghost btn-xs h-6 min-h-6 rounded-none border-none px-2 hover:bg-base-content/10 dark:hover:bg-[#30363d]/60 ${isRepoViewActive ? 'bg-slate-100 text-slate-900 dark:bg-[#30363d] dark:text-slate-100' : 'text-slate-700 dark:text-slate-300'}`}
                            onClick={handleRepoButtonClick}
                            aria-pressed={isRepoViewActive}
                            title={isRepoViewActive ? 'Show preview and terminal panel' : 'Show repository viewer'}
                        >
                            <GitBranch className="h-3 w-3" />
                            <span className={headerButtonLabelClass}>Repo</span>
                        </button>
                    </div>

                    {currentBaseBranch && (
                        <div className="flex items-center gap-2 text-xs opacity-80" title={`Divergence against ${currentBaseBranch}`}>
                            <span className="inline-flex items-center gap-1">
                                <ArrowUp className="w-3 h-3" />
                                {divergence.ahead}
                            </span>
                            <span className="inline-flex items-center gap-1">
                                <ArrowDown className="w-3 h-3" />
                                {divergence.behind}
                            </span>
                        </div>
                    )}

                    <div className="mx-2 hidden h-4 w-[1px] bg-base-content/20 dark:bg-[#30363d] min-[1200px]:block"></div>

                    <div className="hidden min-[1200px]:flex min-w-0 max-w-[280px] items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${feedback.includes('Error') || feedback.includes('failed') ? 'bg-error' : feedback.includes('started') || feedback.includes('Merged') || feedback.includes('Rebased') || feedback.includes('sent') ? 'bg-success' : 'bg-warning'}`}></span>
                        <span className="truncate" title={feedback}>{feedback}</span>
                    </div>

                </div>
            </div>

            {isCreateBaseBranchDialogOpen && (
                <dialog className="modal modal-open">
                    <div className="modal-box max-w-lg">
                        <h3 className="font-bold text-lg">Create New Branch</h3>
                        <p className="py-2 text-sm opacity-70">
                            Create a new branch and refresh the branch list for merge/rebase actions.
                        </p>

                        <div className="space-y-4 pt-2">
                            <div className="form-control">
                                <label className="label">
                                    <span className="label-text">Branch Name</span>
                                </label>
                                <input
                                    type="text"
                                    className="input input-bordered w-full"
                                    value={newBaseBranchName}
                                    onChange={(e) => setNewBaseBranchName(sanitizeBranchName(e.target.value))}
                                    placeholder="feature/my-new-branch"
                                    disabled={isCreatingBaseBranch}
                                    autoFocus
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && newBaseBranchName.trim() && newBaseBranchFrom.trim() && !isCreatingBaseBranch) {
                                            e.preventDefault();
                                            void handleCreateBaseBranch();
                                        }
                                    }}
                                />
                            </div>

                            <div className="form-control">
                                <label className="label">
                                    <span className="label-text">Base Branch</span>
                                </label>
                                <select
                                    className="select select-bordered w-full"
                                    value={newBaseBranchFrom}
                                    onChange={(e) => setNewBaseBranchFrom(e.target.value)}
                                    disabled={isCreatingBaseBranch || createBranchFromOptions.length === 0}
                                >
                                    {createBranchFromOptions.map((branchOption) => (
                                        <option key={branchOption} value={branchOption}>
                                            {branchOption}
                                            {branchOption === mainWorktreeBranch ? ' (Checked Out)' : ''}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        </div>

                        <div className="modal-action">
                            <button className="btn" onClick={closeCreateBaseBranchDialog} disabled={isCreatingBaseBranch}>Cancel</button>
                            <button
                                className="btn btn-primary"
                                onClick={() => void handleCreateBaseBranch()}
                                disabled={!newBaseBranchName.trim() || !newBaseBranchFrom.trim() || isCreatingBaseBranch}
                            >
                                {isCreatingBaseBranch && <span className="loading loading-spinner loading-xs"></span>}
                                Create Branch
                            </button>
                        </div>
                    </div>
                    <form method="dialog" className="modal-backdrop">
                        <button onClick={closeCreateBaseBranchDialog}>close</button>
                    </form>
                </dialog>
            )}

            <div
                ref={splitContainerRef}
                className={`relative flex min-h-0 flex-1 overflow-x-hidden bg-[#f6f6f8] p-3 dark:bg-[#0d1117] ${isRightPanelCollapsed ? 'gap-0' : 'gap-3'}`}
            >
                <div
                    className="agent-activity-panel flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-[width] duration-300 ease-in-out dark:border-[#30363d] dark:bg-[#161b22]"
                    style={{ width: isRightPanelCollapsed ? '100%' : `${agentPaneRatio * 100}%` }}
                >
                    <div className="flex h-9 items-center justify-between gap-3 border-b border-slate-200 px-3 text-[11px] font-semibold text-slate-600 dark:border-[#30363d] dark:bg-[#161b22] dark:text-slate-400">
                        <span className="flex shrink-0 items-center gap-2 uppercase tracking-wide">
                            <span className="h-2 w-2 rounded-full bg-blue-500"></span>
                            Agent Activity
                        </span>
                        <div className="flex min-w-0 items-center justify-end gap-2 overflow-x-auto py-1 text-xs font-medium normal-case">
                            <div className="flex shrink-0 items-center overflow-hidden rounded border border-slate-200 bg-white dark:border-[#30363d] dark:bg-[#0d1117]">
                                <select
                                    className="select select-xs h-6 min-h-6 rounded-none border-none bg-slate-100 pr-7 text-slate-700 focus:outline-none dark:bg-[#161b22] dark:text-slate-300"
                                    value={selectedIde}
                                    onChange={handleIdeChange}
                                >
                                    {SUPPORTED_IDES.map(ide => (
                                        <option key={ide.id} value={ide.id}>{ide.name}</option>
                                    ))}
                                </select>
                                <div className="h-4 w-[1px] bg-slate-200 dark:bg-[#30363d]"></div>
                                <button
                                    className="btn btn-ghost btn-xs h-6 min-h-6 rounded-none border-none px-2 text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-[#30363d]/60"
                                    onClick={handleOpenIde}
                                    title={`Open in ${SUPPORTED_IDES.find(i => i.id === selectedIde)?.name}`}
                                    aria-label="Open in IDE"
                                >
                                    <ExternalLink className="h-3 w-3" />
                                    <span className="agent-activity-action-label">Open in IDE</span>
                                </button>
                            </div>
                            <div className="flex shrink-0 items-center overflow-hidden rounded border border-slate-200 bg-white dark:border-[#30363d] dark:bg-[#0d1117]">
                                <button
                                    className="btn btn-ghost btn-xs h-6 min-h-6 rounded-none border-none px-2 text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-[#30363d]/60"
                                    onClick={() => setIsFileBrowserOpen(true)}
                                    disabled={isInsertingFilePaths}
                                    title="Browse files and insert absolute paths into the agent input"
                                    aria-label="Add files"
                                >
                                    {isInsertingFilePaths ? <span className="loading loading-spinner loading-xs"></span> : <FolderOpen className="h-3 w-3" />}
                                    <span className="agent-activity-action-label">Add Files</span>
                                </button>
                            </div>
                            <div className="flex shrink-0 items-center overflow-hidden rounded border border-slate-200 bg-white dark:border-[#30363d] dark:bg-[#0d1117]">
                                <button
                                    className={`btn btn-ghost btn-xs h-6 min-h-6 w-7 rounded-none border-none p-0 text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-[#30363d]/60 ${terminalInteractionMode === 'select' ? 'text-warning' : ''}`}
                                    onClick={handleToggleTerminalInteractionMode}
                                    disabled={terminalPersistenceMode !== 'tmux' || isUpdatingTerminalInteractionMode}
                                    title={terminalPersistenceMode === 'tmux'
                                        ? (terminalInteractionMode === 'scroll'
                                            ? 'Switch to text select mode for easier copy'
                                            : 'Switch to scroll mode for wheel scrollback')
                                        : 'Mode toggle is available only in tmux persistence mode'}
                                    aria-label={terminalInteractionMode === 'scroll' ? 'Switch to text mode' : 'Switch to scroll mode'}
                                >
                                    {isUpdatingTerminalInteractionMode ? (
                                        <span className="loading loading-spinner loading-xs"></span>
                                    ) : (
                                        terminalInteractionMode === 'scroll'
                                            ? <ScrollText className="h-3.5 w-3.5" />
                                            : <TextCursorInput className="h-3.5 w-3.5" />
                                    )}
                                </button>
                            </div>
                        </div>
                    </div>
                    <iframe
                        ref={iframeRef}
                        src={agentTerminalSrc}
                        className={`h-full w-full border-none transition-opacity duration-200 ${isAgentTerminalThemeReady ? 'opacity-100' : 'opacity-0 pointer-events-none'} ${(isResizing || isSplitResizing) ? 'pointer-events-none' : ''}`}
                        allow="clipboard-read; clipboard-write"
                        onFocus={() => {
                            recentTerminalBlurRef.current = null;
                        }}
                        onBlur={() => {
                            recentTerminalBlurRef.current = { slot: 'agent', at: Date.now() };
                        }}
                        onLoad={handleIframeLoad}
                    />
                </div>

                <div
                    className={`relative h-full shrink-0 rounded transition-all duration-300 ease-in-out ${isRightPanelCollapsed
                        ? 'w-0 cursor-default opacity-0 pointer-events-none'
                        : 'w-2 cursor-col-resize bg-slate-200 opacity-100 hover:bg-primary/40 dark:bg-[#30363d] dark:hover:bg-primary/60'
                        }`}
                    onMouseDown={startSplitResize}
                    role={isRightPanelCollapsed ? undefined : 'separator'}
                    aria-orientation={isRightPanelCollapsed ? undefined : 'vertical'}
                    aria-label={isRightPanelCollapsed ? undefined : 'Resize preview panel'}
                    aria-hidden={isRightPanelCollapsed}
                    title={isRightPanelCollapsed ? undefined : 'Drag to resize preview panel'}
                >
                    {!isRightPanelCollapsed && (
                        <div className="absolute left-1/2 top-1/2 h-12 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-400 dark:bg-slate-500" />
                    )}
                </div>

                <div
                    className={`relative h-full transition-[width,min-width,flex-basis] duration-300 ease-in-out ${isRightPanelCollapsed ? 'w-0 min-w-0 flex-none' : 'min-w-[360px] flex-1'}`}
                >
                    <button
                        className="btn btn-ghost btn-xs absolute left-0 top-3 z-20 h-7 w-7 min-h-7 -translate-x-1/2 rounded-full border border-slate-200 bg-white/95 p-0 text-slate-600 shadow-sm hover:bg-slate-100 dark:border-[#30363d] dark:bg-[#161b22]/95 dark:text-slate-300 dark:hover:bg-[#30363d]/80"
                        onClick={handleToggleRightPanelCollapse}
                        type="button"
                        title={isRightPanelCollapsed ? 'Expand right panel' : 'Collapse right panel'}
                        aria-label={isRightPanelCollapsed ? 'Expand right panel' : 'Collapse right panel'}
                        aria-pressed={isRightPanelCollapsed}
                    >
                        {isRightPanelCollapsed ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>

                    {!isRightPanelCollapsed && (
                        <div className="absolute inset-y-0 left-0 flex h-full w-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-[#30363d] dark:bg-[#161b22]">
                            {isRepoViewActive ? (
                                <SessionRepoViewer
                                    repoPath={worktree || repo}
                                    branchHint={branch}
                                    baseBranchHint={currentBaseBranch || baseBranch}
                                />
                            ) : (
                                <>
                                    <div className="min-h-0 flex flex-1 flex-col">
                                        <form
                                            className="flex h-9 items-center gap-2 border-b border-slate-200 bg-white px-3 dark:border-[#30363d] dark:bg-[#161b22]"
                                            onSubmit={handlePreviewSubmit}
                                        >
                                        <div className="mr-1 flex gap-1.5">
                                            <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
                                            <span className="h-2.5 w-2.5 rounded-full bg-yellow-400" />
                                            <span className="h-2.5 w-2.5 rounded-full bg-green-400" />
                                        </div>
                                        <button
                                            className="btn btn-ghost btn-xs h-7 min-h-7 w-7 p-0 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-[#30363d]/60"
                                            type="button"
                                            onClick={() => handlePreviewNavigate('back')}
                                            disabled={!previewUrl}
                                            title="Go back"
                                            aria-label="Go back"
                                        >
                                            <ArrowLeft className="h-3.5 w-3.5" />
                                        </button>
                                        <button
                                            className="btn btn-ghost btn-xs h-7 min-h-7 w-7 p-0 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-[#30363d]/60"
                                            type="button"
                                            onClick={() => handlePreviewNavigate('forward')}
                                            disabled={!previewUrl}
                                            title="Go forward"
                                            aria-label="Go forward"
                                        >
                                            <ArrowRight className="h-3.5 w-3.5" />
                                        </button>
                                        <button
                                            className="btn btn-ghost btn-xs h-7 min-h-7 w-7 p-0 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-[#30363d]/60"
                                            type="button"
                                            onClick={() => handlePreviewNavigate('reload')}
                                            disabled={!previewUrl}
                                            title="Reload preview"
                                            aria-label="Reload preview"
                                        >
                                            <RotateCw className="h-3.5 w-3.5" />
                                        </button>
                                        <button
                                            className="btn btn-ghost btn-xs h-7 min-h-7 w-7 p-0 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-[#30363d]/60"
                                            type="button"
                                            onClick={handleUnloadPreview}
                                            disabled={!previewUrl}
                                            title="Unload preview"
                                            aria-label="Unload preview"
                                        >
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                        <input
                                            ref={previewAddressInputRef}
                                            type="text"
                                            className="input input-xs h-7 min-h-7 w-full border-slate-200 bg-slate-100 font-mono text-slate-700 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-300 dark:placeholder:text-slate-500"
                                            value={previewInputUrl}
                                            onChange={(event) => setPreviewInputUrl(event.target.value)}
                                            placeholder="http://127.0.0.1:3000"
                                            spellCheck={false}
                                        />
                                        <button
                                            className={`btn btn-ghost btn-xs h-7 min-h-7 w-7 p-0 ${isPreviewPickerActive ? 'text-success' : 'text-slate-500 dark:text-slate-400'} hover:bg-slate-100 dark:hover:bg-[#30363d]/60`}
                                            type="button"
                                            onClick={handleTogglePreviewPicker}
                                            disabled={!previewUrl || isResolvingElement}
                                            title={isPreviewPickerActive ? 'Disable picker' : 'Pick element from preview'}
                                        >
                                            {isResolvingElement ? (
                                                <span className="loading loading-spinner loading-xs w-3 h-3"></span>
                                            ) : (
                                                <MousePointer2 className="h-3 w-3" />
                                            )}
                                        </button>
                                        <button
                                            className="btn btn-ghost btn-xs h-7 min-h-7 w-7 p-0 text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-[#30363d]/60"
                                            type="button"
                                            onClick={handleOpenPreviewInNewTab}
                                            title="Open preview in new tab"
                                            aria-label="Open preview in new tab"
                                        >
                                            <ExternalLink className="h-3.5 w-3.5" />
                                        </button>
                                    </form>
                                    <div className="min-h-0 flex-1 bg-slate-50 dark:bg-[#0d1117]">
                                        {!isPreviewVisible ? (
                                            <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-xs text-slate-500 dark:text-slate-400">
                                                <p>Preview is hidden. Use the header Preview button to show it.</p>
                                                <button
                                                    type="button"
                                                    className="btn btn-xs border-slate-200 bg-white text-slate-700 hover:bg-slate-50 dark:border-[#30363d] dark:bg-[#161b22] dark:text-slate-300 dark:hover:bg-[#30363d]/60"
                                                    onClick={() => setIsPreviewVisible(true)}
                                                >
                                                    Show Preview
                                                </button>
                                            </div>
                                        ) : previewUrl ? (
                                            <iframe
                                                ref={previewIframeRef}
                                                src={previewUrl}
                                                className={`h-full w-full border-none ${(isResizing || isSplitResizing) ? 'pointer-events-none' : ''}`}
                                                title="Dev server preview"
                                                onLoad={handlePreviewIframeLoad}
                                                sandbox="allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts allow-downloads"
                                            />
                                        ) : (
                                            <div className="flex h-full items-center justify-center px-6 text-center text-xs text-slate-500 dark:text-slate-400">
                                                Run the dev server, or enter a URL above to load a preview.
                                            </div>
                                        )}
                                    </div>

                                    {!isTerminalMinimized && (
                                        <div
                                            className="flex h-2 cursor-row-resize items-center justify-center border-y border-slate-200 bg-slate-100 dark:border-[#30363d] dark:bg-[#0d1117]"
                                            onMouseDown={startResize}
                                            role="separator"
                                            aria-orientation="horizontal"
                                            aria-label="Resize build output panel"
                                            title="Drag to resize build output panel"
                                        >
                                            <Grip className="h-3 w-3 text-slate-400 dark:text-slate-500" />
                                        </div>
                                    )}

                                    <div
                                        className={`${isTerminalMinimized ? 'h-9' : 'min-h-[160px]'} flex shrink-0 flex-col bg-slate-50 dark:bg-[#161b22]`}
                                        style={{ height: isTerminalMinimized ? TERMINAL_HEADER_HEIGHT : terminalSize.height }}
                                    >
                                        <div className="flex h-9 items-center justify-between border-t border-slate-200 px-3 text-xs font-semibold text-slate-700 dark:border-[#30363d] dark:text-slate-300">
                                            <span className="flex items-center gap-2 uppercase tracking-wide">
                                                <span className="h-2 w-2 rounded-full bg-amber-500"></span>
                                                Terminal
                                            </span>
                                            <div className="flex items-center gap-2">
                                                <button
                                                    className="btn btn-ghost btn-xs h-6 min-h-6 border-none px-2 text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-[#30363d]/60"
                                                    onClick={handleStartDevServer}
                                                    disabled={isDevButtonDisabled}
                                                    title={devButtonTitle}
                                                    type="button"
                                                >
                                                    {isStartingDevServer ? <span className="loading loading-spinner loading-xs"></span> : <Play className="h-3 w-3" />}
                                                    <span className="hidden min-[1700px]:inline">Dev</span>
                                                </button>
                                                <button
                                                    className="btn btn-ghost btn-xs h-6 min-h-6 w-7 border-none p-0 text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-[#30363d]/60"
                                                    onClick={() => setIsTerminalMinimized((prev) => !prev)}
                                                    title={isTerminalMinimized ? 'Expand terminal' : 'Collapse terminal'}
                                                    aria-label={isTerminalMinimized ? 'Expand terminal' : 'Collapse terminal'}
                                                    type="button"
                                                >
                                                    <ChevronDown className={`h-4 w-4 transition-transform ${isTerminalMinimized ? 'rotate-180' : ''}`} />
                                                </button>
                                            </div>
                                        </div>
                                        <div className={`${isTerminalMinimized ? 'h-0 overflow-hidden' : 'min-h-0 flex-1 overflow-hidden border-t border-slate-200 bg-white dark:border-[#30363d] dark:bg-[#0d1117]'}`}>
                                            <iframe
                                                ref={terminalRef}
                                                src={floatingTerminalSrc}
                                                className={`h-full w-full border-none transition-opacity duration-200 ${isFloatingTerminalThemeReady ? 'opacity-100' : 'opacity-0 pointer-events-none'} ${(isResizing || isSplitResizing) ? 'pointer-events-none' : ''}`}
                                                allow="clipboard-read; clipboard-write"
                                                onFocus={() => {
                                                    recentTerminalBlurRef.current = null;
                                                }}
                                                onBlur={() => {
                                                    recentTerminalBlurRef.current = { slot: 'terminal', at: Date.now() };
                                                }}
                                                onLoad={(event) => handleTerminalLoad(event.currentTarget)}
                                            />
                                        </div>
                                    </div>
                                </div>
                                </>
                            )}
                        </div>
                    )}
                </div>
            </div>

            {isFileBrowserOpen && (
                <SessionFileBrowser
                    initialPath={lastFileBrowserPath}
                    worktreePath={worktree}
                    onPathChange={setLastFileBrowserPath}
                    onConfirm={(paths) => {
                        setIsFileBrowserOpen(false);
                        void handleInsertFilePaths(paths);
                    }}
                    onCancel={() => setIsFileBrowserOpen(false)}
                />
            )}
        </div>
    );
}
