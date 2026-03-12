'use client';

import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
// import { useRouter } from 'next/navigation';
import {
    createSessionBaseBranch,
    deleteSessionInBackground,
    getSessionDivergence,
    listSessionBaseBranches,
    mergeSessionToBase,
    prepareSessionDevServerTerminalRun,
    rebaseSessionOntoBase,
    updateSessionBaseBranch,
} from '@/app/actions/session';
import {
    startTtydProcess,
    setTmuxSessionMouseMode,
    setTmuxSessionStatusVisibility,
    terminateTmuxSessionRole,
} from '@/app/actions/git';
import { getConfig, updateConfig } from '@/app/actions/config';
import { Trash2, ExternalLink, Play, GitMerge, GitPullRequestArrow, GitBranch, ArrowUp, ArrowDown, FolderOpen, ChevronLeft, Grip, ChevronDown, Plus, RotateCw, ScrollText, TextCursorInput, X, Info } from 'lucide-react';
import AgentSessionPane, { type AgentSessionHeaderMeta, type AgentSessionPaneHandle } from './AgentSessionPane';
import SessionFileBrowser from './SessionFileBrowser';
import { SessionRepoViewer, type SessionRepoViewerOption } from './SessionRepoViewer';
import { getBaseName } from '@/lib/path';
import { notifySessionsUpdated } from '@/lib/session-updates';
import {
    buildTtydTerminalSrc,
    parseTerminalSessionEnvironmentsFromSrc,
    parseTerminalWorkingDirectoryFromSrc,
    type TerminalSessionEnvironment,
    type TerminalShellKind,
} from '@/lib/terminal-session';
import { normalizePreviewUrl } from '@/lib/url';
import { sanitizeBranchName } from '@/lib/utils';
import { useTerminalLink, type TerminalWindow } from '@/hooks/useTerminalLink';
import { inferPreviewUrlFromTerminalText, terminalTranscriptContainsCommand } from '@/lib/dev-server-terminal';
import { buildShellExportEnvironmentCommand, buildShellSetDirectoryCommand } from '@/lib/shell';
import { SESSION_MOBILE_VIEWPORT_QUERY } from '@/lib/responsive';
import {
    applyThemeToTerminalIframe,
    applyThemeToTerminalWindow,
    readThemeModeFromStorage,
    THEME_MODE_STORAGE_KEY,
    THEME_REFRESH_EVENT,
} from '@/lib/ttyd-theme';
import type { SessionAgentRunState, SessionGitRepoContext, SessionWorkspaceMode } from '@/lib/types';

const SUPPORTED_IDES = [
    { id: 'vscode', name: 'VS Code', protocol: 'vscode' },
    { id: 'cursor', name: 'Cursor', protocol: 'cursor' },
    { id: 'windsurf', name: 'Windsurf', protocol: 'windsurf' },
    { id: 'antigravity', name: 'Antigravity', protocol: 'antigravity' },
];

let configuredIdeCache: string | null = null;
let configuredIdePromise: Promise<string | null> | null = null;


type CleanupPhase = 'idle' | 'error';
type SessionDevServerState = {
    running: boolean;
    previewUrl: string | null;
};

type PreviewNavigationAction = 'back' | 'forward' | 'reload';
type TerminalBootstrapSlot = string;
type TerminalBootstrapState = 'idle' | 'in_progress' | 'done';
type TerminalBootstrapRegistry = Record<string, TerminalBootstrapState>;
type TerminalInteractionMode = 'scroll' | 'select';
type TerminalOnWriteParsedDisposable = { dispose?: () => void };
type TerminalWithOnWriteParsed = NonNullable<TerminalWindow['term']> & {
    onWriteParsed?: (callback: () => void) => TerminalOnWriteParsedDisposable | void;
};
type CleanupRef = { current: (() => void) | null };

const TERMINAL_SIZE_STORAGE_KEY = 'viba-terminal-size';
const SPLIT_RATIO_STORAGE_KEY = 'viba-agent-preview-split-ratio';
const RIGHT_PANEL_COLLAPSED_STORAGE_KEY = 'viba-right-panel-collapsed';
const PREVIEW_TARGET_STORAGE_KEY_PREFIX = 'viba-session-preview-target-url:';
const DEV_SERVER_TERMINAL_MARKER_STORAGE_KEY_PREFIX = 'viba-session-dev-server-terminal:';
const DEFAULT_AGENT_PANE_RATIO = 0.5;
const TERMINAL_HEADER_HEIGHT = 36;
const TERMINAL_BOOTSTRAP_STORAGE_PREFIX = 'viba:terminal-bootstrap:';
const TERMINAL_BOOTSTRAP_RUNTIME_KEY = '__vibaTerminalBootstrapRegistry';
const SHELL_PROMPT_PATTERN = /(?:\$|%|#|>) $/;
const TERMINAL_LOADING_OVERLAY_CLASS = 'pointer-events-none absolute inset-0 z-10 flex items-center justify-center';
const FOLDER_MODE_GIT_DISABLED_REASON = 'Git controls are unavailable in folder mode because no repository context is active.';
const MAIN_TERMINAL_TAB_ID = 'terminal';

const getFloatingTerminalBootstrapSlot = (tabId: string): TerminalBootstrapSlot => {
    if (tabId === MAIN_TERMINAL_TAB_ID) return MAIN_TERMINAL_TAB_ID;
    return `terminal:${tabId}`;
};

const getFloatingTerminalTabIdFromSlot = (slot: TerminalBootstrapSlot): string | null => {
    if (slot === MAIN_TERMINAL_TAB_ID) return MAIN_TERMINAL_TAB_ID;
    if (!slot.startsWith('terminal:')) return null;
    const tabId = slot.slice('terminal:'.length).trim();
    return tabId || MAIN_TERMINAL_TAB_ID;
};

const clampAgentPaneRatio = (value: number): number => Math.max(0.2, Math.min(0.8, value));

const getPreviewTargetStorageKey = (sessionName: string): string => (
    `${PREVIEW_TARGET_STORAGE_KEY_PREFIX}${sessionName}`
);

const getDevServerTerminalMarkerStorageKey = (sessionName: string): string => (
    `${DEV_SERVER_TERMINAL_MARKER_STORAGE_KEY_PREFIX}${sessionName}`
);

const formatAgentRunState = (runState: SessionAgentRunState | 'idle' | null | undefined): string => {
    if (!runState) return 'idle';
    return runState.replace(/_/g, ' ');
};

const agentRunStateTone = (runState: SessionAgentRunState | 'idle' | null | undefined): string => {
    switch (runState) {
        case 'running':
            return 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-200';
        case 'queued':
            return 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200';
        case 'completed':
            return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200';
        case 'cancelled':
            return 'border-slate-200 bg-slate-50 text-slate-700 dark:border-slate-500/30 dark:bg-slate-500/10 dark:text-slate-200';
        case 'error':
            return 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200';
        case 'needs_auth':
            return 'border-violet-200 bg-violet-50 text-violet-700 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-200';
        default:
            return 'border-slate-200 bg-slate-50 text-slate-700 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-300';
    }
};

const buildExportEnvironmentCommand = (
    environments: TerminalSessionEnvironment[],
    shellKind: TerminalShellKind,
): string => {
    if (environments.length === 0) return '';
    return buildShellExportEnvironmentCommand(environments, shellKind);
};

const loadConfiguredIde = async (): Promise<string | null> => {
    if (configuredIdeCache && SUPPORTED_IDES.some((ide) => ide.id === configuredIdeCache)) {
        return configuredIdeCache;
    }
    if (!configuredIdePromise) {
        configuredIdePromise = (async () => {
            const config = await getConfig();
            const selectedIde = config.selectedIde?.trim() || null;
            if (selectedIde && SUPPORTED_IDES.some((ide) => ide.id === selectedIde)) {
                configuredIdeCache = selectedIde;
                return selectedIde;
            }
            configuredIdeCache = null;
            return null;
        })().finally(() => {
            configuredIdePromise = null;
        });
    }
    return configuredIdePromise;
};

export interface SessionViewProps {
    repo: string;
    repoDisplayName?: string;
    worktree: string;
    branch: string;
    baseBranch?: string;
    workspaceMode?: SessionWorkspaceMode;
    activeRepoPath?: string;
    gitRepos?: SessionGitRepoContext[];
    sessionName: string;
    agent?: string;
    devServerScript?: string;
    initialMessage?: string;
    attachmentPaths?: string[];
    attachmentNames?: string[];
    projectGitRepoRelativePaths?: string[];
    title?: string;
    sessionMode?: 'fast' | 'plan';
    onExit: (force?: boolean) => void;
    isResume?: boolean;
    terminalPersistenceMode?: 'tmux' | 'shell';
    terminalShellKind?: TerminalShellKind;
    agentTerminalSrc?: string;
    floatingTerminalSrc?: string;
}

export function SessionView({
    repo: legacyRepo,
    repoDisplayName,
    worktree: legacyWorktree,
    branch: legacyBranch,
    baseBranch: legacyBaseBranch,
    workspaceMode = 'single_worktree',
    activeRepoPath,
    gitRepos = [],
    sessionName,
    devServerScript,
    onExit,
    isResume,
    terminalPersistenceMode: initialTerminalPersistenceMode = 'shell',
    terminalShellKind: initialTerminalShellKind = 'posix',
    floatingTerminalSrc: floatingTerminalSrcOverride,
}: SessionViewProps) {
    const headerButtonLabelClass = 'hidden min-[1900px]:inline';
    const normalizedGitRepos = useMemo<SessionGitRepoContext[]>(() => {
        if (gitRepos.length > 0) {
            return gitRepos;
        }
        if (
            workspaceMode !== 'folder'
            && legacyRepo
            && legacyWorktree
            && legacyBranch
        ) {
            return [{
                sourceRepoPath: legacyRepo,
                relativeRepoPath: '',
                worktreePath: legacyWorktree,
                branchName: legacyBranch,
                baseBranch: legacyBaseBranch,
            }];
        }
        return [];
    }, [gitRepos, legacyBaseBranch, legacyBranch, legacyRepo, legacyWorktree, workspaceMode]);
    const [activeSessionRepoPath, setActiveSessionRepoPath] = useState<string>(
        activeRepoPath || normalizedGitRepos[0]?.sourceRepoPath || legacyRepo,
    );
    const activeGitRepo = useMemo(() => {
        if (normalizedGitRepos.length === 0) return null;
        return normalizedGitRepos.find((context) => context.sourceRepoPath === activeSessionRepoPath)
            || normalizedGitRepos[0];
    }, [activeSessionRepoPath, normalizedGitRepos]);
    const repo = activeGitRepo?.sourceRepoPath || legacyRepo;
    const worktree = activeGitRepo?.worktreePath || legacyWorktree;
    const branch = activeGitRepo?.branchName || legacyBranch;
    const baseBranch = activeGitRepo?.baseBranch || legacyBaseBranch;
    const sessionWorkspaceRootPath = (legacyWorktree || legacyRepo || worktree || repo || '').trim();
    const isFolderMode = workspaceMode === 'folder' || normalizedGitRepos.length === 0;
    const repoViewerOptions = useMemo<SessionRepoViewerOption[]>(() => {
        if (normalizedGitRepos.length <= 1) return [];

        const options: SessionRepoViewerOption[] = [];
        const seenPaths = new Set<string>();
        for (const context of normalizedGitRepos) {
            const optionPath = (context.worktreePath || context.sourceRepoPath || '').trim();
            if (!optionPath || seenPaths.has(optionPath)) continue;
            seenPaths.add(optionPath);

            const relativeRepoPath = context.relativeRepoPath?.trim();
            const label = relativeRepoPath && relativeRepoPath !== '.'
                ? relativeRepoPath
                : (getBaseName(context.sourceRepoPath) || context.sourceRepoPath);
            options.push({
                path: optionPath,
                label,
                branchHint: context.branchName?.trim() || undefined,
                baseBranchHint: context.baseBranch?.trim() || undefined,
            });
        }

        return options;
    }, [normalizedGitRepos]);

    const agentPaneRef = useRef<AgentSessionPaneHandle>(null);
    const terminalFramesRef = useRef<Record<string, HTMLIFrameElement | null>>({});
    const previewIframeRef = useRef<HTMLIFrameElement>(null);
    const previewAddressInputRef = useRef<HTMLInputElement>(null);
    const splitContainerRef = useRef<HTMLDivElement>(null);
    const splitResizeRef = useRef({ startX: 0, startRatio: DEFAULT_AGENT_PANE_RATIO });
    const recentTerminalBlurRef = useRef<{ slot: TerminalBootstrapSlot; at: number } | null>(null);
    const agentFrameLinkCleanupRef = useRef<(() => void) | null>(null);
    const terminalFrameLinkCleanupRefs = useRef<Record<string, CleanupRef>>({});
    const terminalProcessMonitorCleanupRef = useRef<(() => void) | null>(null);
    const terminalAutoScrollCleanupRef = useRef<Record<string, (() => void) | null>>({});
    const iframeBeforeUnloadCleanupRef = useRef<Record<string, (() => void) | null>>({});
    const [terminalPersistenceMode, setTerminalPersistenceMode] = useState<'tmux' | 'shell'>(initialTerminalPersistenceMode);
    const [terminalShellKind, setTerminalShellKind] = useState<TerminalShellKind>(initialTerminalShellKind);
    const [isTerminalServiceReady, setIsTerminalServiceReady] = useState(false);
    const [isTerminalServiceStarting, setIsTerminalServiceStarting] = useState(false);
    const floatingTerminalSrc = useMemo(
        () => floatingTerminalSrcOverride || buildTtydTerminalSrc(sessionName, MAIN_TERMINAL_TAB_ID, null, {
            persistenceMode: terminalPersistenceMode,
            shellKind: terminalShellKind,
            workingDirectory: sessionWorkspaceRootPath,
        }),
        [floatingTerminalSrcOverride, sessionName, sessionWorkspaceRootPath, terminalPersistenceMode, terminalShellKind],
    );
    const shellBootstrapEnvironmentCommand = useMemo(() => {
        if (terminalPersistenceMode !== 'shell') return '';
        const environments = parseTerminalSessionEnvironmentsFromSrc(floatingTerminalSrc);
        const workingDirectory = parseTerminalWorkingDirectoryFromSrc(floatingTerminalSrc);
        const exportCommand = buildExportEnvironmentCommand(environments, terminalShellKind);
        const directoryCommand = workingDirectory
            ? buildShellSetDirectoryCommand(workingDirectory, terminalShellKind)
            : '';
        return [exportCommand, directoryCommand]
            .filter(Boolean)
            .join(terminalShellKind === 'powershell' ? '; ' : ' && ');
    }, [floatingTerminalSrc, terminalPersistenceMode, terminalShellKind]);

    const terminalBootstrapStateRef = useRef<Record<string, TerminalBootstrapState>>({
        agent: 'idle',
        [MAIN_TERMINAL_TAB_ID]: 'idle',
    });
    const tmuxStatusAppliedRef = useRef<Record<string, boolean>>({
        agent: false,
        [MAIN_TERMINAL_TAB_ID]: false,
    });
    const tmuxStatusRequestInFlightRef = useRef<Record<string, boolean>>({
        agent: false,
        [MAIN_TERMINAL_TAB_ID]: false,
    });
    const tmuxSilentScrollRequestKeyRef = useRef<string | null>(null);
    const tmuxSilentScrollAppliedKeyRef = useRef<string | null>(null);

    const getTerminalLinkCleanupRef = useCallback((slot: TerminalBootstrapSlot): CleanupRef => {
        const existing = terminalFrameLinkCleanupRefs.current[slot];
        if (existing) return existing;
        const created: CleanupRef = { current: null };
        terminalFrameLinkCleanupRefs.current[slot] = created;
        return created;
    }, []);

    const cleanupTerminalLinkHandler = useCallback((slot: TerminalBootstrapSlot): void => {
        if (slot === 'agent') {
            agentFrameLinkCleanupRef.current?.();
            agentFrameLinkCleanupRef.current = null;
            return;
        }

        const cleanupRef = terminalFrameLinkCleanupRefs.current[slot];
        cleanupRef?.current?.();
        if (cleanupRef) {
            cleanupRef.current = null;
            delete terminalFrameLinkCleanupRefs.current[slot];
        }
    }, []);

    const cleanupTerminalAutoScroll = useCallback((slot: TerminalBootstrapSlot): void => {
        const cleanup = terminalAutoScrollCleanupRef.current[slot];
        if (cleanup) {
            cleanup();
            delete terminalAutoScrollCleanupRef.current[slot];
        }
    }, []);

    const cleanupBeforeUnloadGuard = useCallback((slot: TerminalBootstrapSlot): void => {
        const cleanup = iframeBeforeUnloadCleanupRef.current[slot];
        if (cleanup) {
            cleanup();
            delete iframeBeforeUnloadCleanupRef.current[slot];
        }
    }, []);

    const installBeforeUnloadGuard = useCallback((slot: TerminalBootstrapSlot, iframe: HTMLIFrameElement): void => {
        cleanupBeforeUnloadGuard(slot);

        const frameWindow = iframe.contentWindow;
        if (!frameWindow) return;

        try {
            frameWindow.onbeforeunload = null;
        } catch {
            // Ignore cross-context edge cases.
        }

        const handleBeforeUnload = (event: Event) => {
            event.stopImmediatePropagation();
        };

        frameWindow.addEventListener('beforeunload', handleBeforeUnload, true);
        iframeBeforeUnloadCleanupRef.current[slot] = () => {
            try {
                frameWindow.removeEventListener('beforeunload', handleBeforeUnload, true);
            } catch {
                // Ignore detached frame cleanup failures.
            }
        };
    }, [cleanupBeforeUnloadGuard]);

    const installTerminalAutoScroll = useCallback((
        slot: TerminalBootstrapSlot,
        iframe: HTMLIFrameElement,
        term: NonNullable<TerminalWindow['term']>
    ): void => {
        cleanupTerminalAutoScroll(slot);

        try {
            const xterm = term as TerminalWithOnWriteParsed;
            const scrollHandler = () => {
                const activeBuffer = xterm.buffer?.active as ({ baseY?: number; viewportY?: number } | undefined);
                const baseY = typeof activeBuffer?.baseY === 'number' ? activeBuffer.baseY : 0;
                const viewportY = typeof activeBuffer?.viewportY === 'number' ? activeBuffer.viewportY : baseY;

                if (activeBuffer && (baseY - viewportY < 10)) {
                    xterm.scrollToBottom?.();
                } else {
                    xterm.scrollToBottom?.();
                }
            };

            let writeDisposable: TerminalOnWriteParsedDisposable | null = null;
            let mutationObserver: MutationObserver | null = null;

            if (typeof xterm.onWriteParsed === 'function') {
                writeDisposable = xterm.onWriteParsed(scrollHandler) || null;
            } else {
                const screen = iframe.contentDocument?.querySelector('.xterm-screen') || iframe.contentDocument?.body;
                if (screen) {
                    mutationObserver = new MutationObserver(scrollHandler);
                    mutationObserver.observe(screen, { childList: true, subtree: true, characterData: true });
                }
            }

            terminalAutoScrollCleanupRef.current[slot] = () => {
                if (writeDisposable && typeof writeDisposable.dispose === 'function') {
                    writeDisposable.dispose();
                }
                mutationObserver?.disconnect();
            };
        } catch (error) {
            console.error('Failed to setup auto-scroll:', error);
        }
    }, [cleanupTerminalAutoScroll]);

    const cleanupAllIframeResources = useCallback((): void => {
        cleanupTerminalLinkHandler('agent');
        cleanupBeforeUnloadGuard('agent');

        for (const slot of Object.keys(terminalFrameLinkCleanupRefs.current)) {
            cleanupTerminalLinkHandler(slot);
        }
        for (const slot of Object.keys(terminalAutoScrollCleanupRef.current)) {
            cleanupTerminalAutoScroll(slot);
        }
        for (const slot of Object.keys(iframeBeforeUnloadCleanupRef.current)) {
            cleanupBeforeUnloadGuard(slot);
        }
    }, [cleanupBeforeUnloadGuard, cleanupTerminalAutoScroll, cleanupTerminalLinkHandler]);

    useEffect(() => {
        terminalBootstrapStateRef.current = {
            agent: 'idle',
            [MAIN_TERMINAL_TAB_ID]: 'idle',
        };
        tmuxStatusAppliedRef.current = {
            agent: false,
            [MAIN_TERMINAL_TAB_ID]: false,
        };
        tmuxStatusRequestInFlightRef.current = {
            agent: false,
            [MAIN_TERMINAL_TAB_ID]: false,
        };
        tmuxSilentScrollRequestKeyRef.current = null;
        tmuxSilentScrollAppliedKeyRef.current = null;
    }, [sessionName]);

    useEffect(() => {
        setActiveSessionRepoPath(activeRepoPath || normalizedGitRepos[0]?.sourceRepoPath || legacyRepo);
    }, [activeRepoPath, legacyRepo, normalizedGitRepos, sessionName]);

    useEffect(() => {
        cleanupAllIframeResources();
        return () => {
            cleanupAllIframeResources();
        };
    }, [cleanupAllIframeResources, sessionName]);

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

    const clearTerminalBootstrapState = useCallback((slot: TerminalBootstrapSlot): void => {
        delete terminalBootstrapStateRef.current[slot];
        const registry = getRuntimeBootstrapRegistry();
        if (registry) {
            delete registry[getRuntimeBootstrapKey(slot)];
        }
        try {
            window.sessionStorage.removeItem(getTerminalBootstrapKey(slot));
        } catch {
            // Ignore storage failures (private mode / disabled storage).
        }
    }, [getRuntimeBootstrapKey, getRuntimeBootstrapRegistry, getTerminalBootstrapKey]);

    const hasTerminalBootstrapped = useCallback((slot: TerminalBootstrapSlot): boolean => {
        if (terminalPersistenceMode !== 'tmux') {
            return false;
        }
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
    }, [getRuntimeBootstrapState, getTerminalBootstrapKey, terminalPersistenceMode]);

    const beginTerminalBootstrap = useCallback((slot: TerminalBootstrapSlot): boolean => {
        const current = terminalBootstrapStateRef.current[slot] || 'idle';
        if (terminalPersistenceMode !== 'tmux') {
            if (current === 'in_progress') {
                return false;
            }
            terminalBootstrapStateRef.current[slot] = 'in_progress';
            return true;
        }
        const runtimeState = getRuntimeBootstrapState(slot);
        if (current === 'done' || current === 'in_progress' || runtimeState === 'done' || runtimeState === 'in_progress') {
            return false;
        }
        terminalBootstrapStateRef.current[slot] = 'in_progress';
        setRuntimeBootstrapState(slot, 'in_progress');
        return true;
    }, [getRuntimeBootstrapState, setRuntimeBootstrapState, terminalPersistenceMode]);

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
        if (terminalPersistenceMode !== 'tmux') {
            return;
        }
        setRuntimeBootstrapState(slot, 'done');
        try {
            window.sessionStorage.setItem(getTerminalBootstrapKey(slot), '1');
        } catch {
            // Ignore storage failures (private mode / disabled storage).
        }
    }, [getTerminalBootstrapKey, setRuntimeBootstrapState, terminalPersistenceMode]);

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

    const [feedback, setFeedback] = useState<string>('Initializing...');
    const [agentHeaderMeta, setAgentHeaderMeta] = useState<AgentSessionHeaderMeta | null>(null);
    const [cleanupPhase, setCleanupPhase] = useState<CleanupPhase>('idle');
    const [cleanupError, setCleanupError] = useState<string | null>(null);
    const [isStartingDevServer, setIsStartingDevServer] = useState(false);
    const [isStoppingDevServer, setIsStoppingDevServer] = useState(false);
    const [isAwaitingDevServerPreview, setIsAwaitingDevServerPreview] = useState(false);
    const [devServerState, setDevServerState] = useState<SessionDevServerState>({ running: false, previewUrl: null });
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
    const [loadedPreviewTargetUrl, setLoadedPreviewTargetUrl] = useState('');
    const [isRepoViewActive, setIsRepoViewActive] = useState(false);
    const [agentPaneRatio, setAgentPaneRatio] = useState(DEFAULT_AGENT_PANE_RATIO);
    const [isSplitResizing, setIsSplitResizing] = useState(false);
    const [isRightPanelCollapsed, setIsRightPanelCollapsed] = useState(true);
    const [isMobileViewport, setIsMobileViewport] = useState(false);
    const [floatingTerminalThemeReadyByTab, setFloatingTerminalThemeReadyByTab] = useState<Record<string, boolean>>({
        [MAIN_TERMINAL_TAB_ID]: false,
    });

    const [isTerminalMinimized, setIsTerminalMinimized] = useState(true);
    const [terminalTabIds, setTerminalTabIds] = useState<string[]>([MAIN_TERMINAL_TAB_ID]);
    const [activeTerminalTabId, setActiveTerminalTabId] = useState<string>(MAIN_TERMINAL_TAB_ID);
    const activeTerminalTabIdRef = useRef(activeTerminalTabId);
    const pendingDevServerPreviewLoadRef = useRef(false);
    const attemptedPreviewRestoreRef = useRef(false);
    const floatingTerminalEnvironments = useMemo(
        () => parseTerminalSessionEnvironmentsFromSrc(floatingTerminalSrc),
        [floatingTerminalSrc],
    );
    const terminalTabSources = useMemo<Record<string, string>>(() => {
        const nextSources: Record<string, string> = {};
        for (const tabId of terminalTabIds) {
            nextSources[tabId] = buildTtydTerminalSrc(sessionName, tabId, floatingTerminalEnvironments, {
                persistenceMode: terminalPersistenceMode,
                shellKind: terminalShellKind,
                workingDirectory: sessionWorkspaceRootPath,
            });
        }
        return nextSources;
    }, [floatingTerminalEnvironments, sessionName, sessionWorkspaceRootPath, terminalPersistenceMode, terminalShellKind, terminalTabIds]);
    const activeFloatingTerminalBootstrapSlot = useMemo(
        () => getFloatingTerminalBootstrapSlot(activeTerminalTabId),
        [activeTerminalTabId],
    );
    const isFloatingTerminalThemeReady = Boolean(floatingTerminalThemeReadyByTab[activeTerminalTabId]);
    const setFloatingTerminalThemeReadyForTab = useCallback((tabId: string, isReady: boolean) => {
        setFloatingTerminalThemeReadyByTab((previous) => {
            if (previous[tabId] === isReady) return previous;
            return {
                ...previous,
                [tabId]: isReady,
            };
        });
    }, []);

    useEffect(() => {
        setTerminalTabIds([MAIN_TERMINAL_TAB_ID]);
        setActiveTerminalTabId(MAIN_TERMINAL_TAB_ID);
        setFloatingTerminalThemeReadyByTab({ [MAIN_TERMINAL_TAB_ID]: false });
        setIsTerminalServiceReady(false);
        setIsTerminalServiceStarting(false);
        setTerminalPersistenceMode(initialTerminalPersistenceMode);
        setTerminalShellKind(initialTerminalShellKind);
        terminalFramesRef.current = {};
    }, [initialTerminalPersistenceMode, initialTerminalShellKind, sessionName]);

    useEffect(() => {
        attemptedPreviewRestoreRef.current = false;
    }, [sessionName]);

    useEffect(() => {
        activeTerminalTabIdRef.current = activeTerminalTabId;
    }, [activeTerminalTabId]);

    const ensureTerminalService = useCallback(async (): Promise<boolean> => {
        if (isTerminalServiceReady) {
            return true;
        }
        if (isTerminalServiceStarting) {
            return false;
        }

        setIsTerminalServiceStarting(true);
        try {
            const result = await startTtydProcess();
            if (!result.success) {
                setFeedback(result.error || 'Failed to start terminal service');
                return false;
            }

            setTerminalPersistenceMode(result.persistenceMode === 'tmux' ? 'tmux' : 'shell');
            setTerminalShellKind(result.shellKind === 'powershell' ? 'powershell' : 'posix');
            setIsTerminalServiceReady(true);
            return true;
        } catch (error) {
            console.error('Failed to start terminal service:', error);
            setFeedback(error instanceof Error ? error.message : 'Failed to start terminal service');
            return false;
        } finally {
            setIsTerminalServiceStarting(false);
        }
    }, [isTerminalServiceReady, isTerminalServiceStarting]);

    useEffect(() => {
        if (isRightPanelCollapsed || isRepoViewActive) {
            return;
        }

        void ensureTerminalService();
    }, [ensureTerminalService, isRepoViewActive, isRightPanelCollapsed]);

    const setDevServerTerminalMarker = useCallback((active: boolean) => {
        try {
            const storageKey = getDevServerTerminalMarkerStorageKey(sessionName);
            if (active) {
                window.sessionStorage.setItem(storageKey, '1');
            } else {
                window.sessionStorage.removeItem(storageKey);
            }
        } catch {
            // Ignore storage failures.
        }
    }, [sessionName]);

    const hasDevServerTerminalMarker = useCallback((): boolean => {
        try {
            return window.sessionStorage.getItem(getDevServerTerminalMarkerStorageKey(sessionName)) === '1';
        } catch {
            return false;
        }
    }, [sessionName]);

    const revealDevServerTerminal = useCallback(() => {
        setIsRepoViewActive(false);
        setIsRightPanelCollapsed(false);
        setIsPreviewVisible(true);
        setIsTerminalMinimized(false);
        setActiveTerminalTabId(MAIN_TERMINAL_TAB_ID);
    }, []);

    const getFloatingTerminalSession = useCallback((tabId = MAIN_TERMINAL_TAB_ID) => {
        const iframe = terminalFramesRef.current[tabId] || null;
        if (!iframe) return null;
        try {
            const win = iframe.contentWindow as TerminalWindow | null;
            if (!win?.term) return null;
            return {
                iframe,
                win,
                term: win.term,
            };
        } catch {
            return null;
        }
    }, []);

    const focusFloatingTerminalSession = useCallback((tabId = MAIN_TERMINAL_TAB_ID): boolean => {
        const terminalSession = getFloatingTerminalSession(tabId);
        if (!terminalSession) return false;
        try {
            terminalSession.win.focus();
            const textarea = terminalSession.iframe.contentDocument?.querySelector('textarea.xterm-helper-textarea') as HTMLElement | null;
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
    }, [getFloatingTerminalSession]);

    const readTerminalTranscript = useCallback((term: NonNullable<TerminalWindow['term']>, maxLines = 160): string => {
        const activeBuffer = term?.buffer?.active;
        if (!activeBuffer || typeof activeBuffer.getLine !== 'function') {
            return '';
        }

        const cursorLine = activeBuffer.baseY + activeBuffer.cursorY;
        const lines: string[] = [];
        for (let offset = maxLines - 1; offset >= 0; offset -= 1) {
            const line = activeBuffer.getLine(cursorLine - offset);
            const text = line?.translateToString(true) ?? '';
            if (!text) continue;
            lines.push(text);
        }
        return lines.join('\n');
    }, []);

    const sendTerminalInput = useCallback((term: NonNullable<TerminalWindow['term']>, text: string): boolean => {
        if (typeof term.paste === 'function') {
            term.paste(text);
            return true;
        }

        const triggerDataEvent = term._core?.coreService?.triggerDataEvent;
        if (typeof triggerDataEvent === 'function') {
            triggerDataEvent(text, true);
            return true;
        }

        return false;
    }, []);

    const sendFloatingTerminalEnter = useCallback((tabId = MAIN_TERMINAL_TAB_ID): boolean => {
        const terminalSession = getFloatingTerminalSession(tabId);
        if (!terminalSession) return false;

        try {
            const textarea = terminalSession.iframe.contentDocument?.querySelector('textarea.xterm-helper-textarea');
            const terminalWindow = terminalSession.win as Window & typeof globalThis;
            const TerminalKeyboardEvent = terminalWindow.KeyboardEvent || KeyboardEvent;
            if (textarea && typeof textarea.dispatchEvent === 'function') {
                const eventInit = {
                    bubbles: true,
                    cancelable: true,
                    code: 'Enter',
                    charCode: 13,
                    keyCode: 13,
                    key: 'Enter',
                    which: 13,
                    view: terminalWindow,
                };
                textarea.dispatchEvent(new TerminalKeyboardEvent('keydown', eventInit));
                textarea.dispatchEvent(new TerminalKeyboardEvent('keypress', eventInit));
                textarea.dispatchEvent(new TerminalKeyboardEvent('keyup', eventInit));
                return true;
            }
        } catch {
            // Fall back to direct terminal input when the helper textarea is unavailable.
        }

        return sendTerminalInput(terminalSession.term, '\r');
    }, [getFloatingTerminalSession, sendTerminalInput]);

    const waitForFloatingTerminalSession = useCallback(async (
        tabId = MAIN_TERMINAL_TAB_ID,
        options?: { requireShellPrompt?: boolean; timeoutMs?: number },
    ) => {
        const requireShellPrompt = Boolean(options?.requireShellPrompt);
        const timeoutMs = options?.timeoutMs ?? 8000;
        const startedAt = Date.now();

        while (Date.now() - startedAt < timeoutMs) {
            const terminalSession = getFloatingTerminalSession(tabId);
            if (terminalSession && (!requireShellPrompt || isShellPromptReady(terminalSession.term))) {
                return terminalSession;
            }
            await new Promise((resolve) => window.setTimeout(resolve, 150));
        }

        return null;
    }, [getFloatingTerminalSession, isShellPromptReady]);

    const focusTerminalInputForSlot = useCallback((slot: TerminalBootstrapSlot): boolean => {
        if (slot === 'agent') {
            agentPaneRef.current?.focusComposer();
            return true;
        }

        const iframe = (() => {
            const floatingTabId = getFloatingTerminalTabIdFromSlot(slot);
            if (!floatingTabId) return null;
            return terminalFramesRef.current[floatingTabId] || null;
        })();
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
                const fallbackSlot = preferredSlot === 'agent'
                    ? activeFloatingTerminalBootstrapSlot
                    : 'agent';
                focusTerminalInputForSlot(fallbackSlot);
            }
            recentTerminalBlurRef.current = null;
        }, 0);
    }, [activeFloatingTerminalBootstrapSlot, focusTerminalInputForSlot]);

    const applyThemeToTerminalFrames = useCallback(() => {
        const themedTabs = new Set<string>();
        for (const tabId of terminalTabIds) {
            if (applyThemeToTerminalIframe(terminalFramesRef.current[tabId])) {
                themedTabs.add(tabId);
            }
        }
        if (themedTabs.size > 0) {
            setFloatingTerminalThemeReadyByTab((previous) => {
                let changed = false;
                const next = { ...previous };
                for (const tabId of themedTabs) {
                    if (!next[tabId]) {
                        next[tabId] = true;
                        changed = true;
                    }
                }
                return changed ? next : previous;
            });
        }

        maybeRestoreRecentTerminalFocusAfterThemeChange();
    }, [maybeRestoreRecentTerminalFocusAfterThemeChange, terminalTabIds]);

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

    const handleAddTerminalTab = useCallback(() => {
        let index = 2;
        while (terminalTabIds.includes(`terminal-${index}`)) {
            index += 1;
        }
        const nextTabId = `terminal-${index}`;
        setTerminalTabIds((previous) => (
            previous.includes(nextTabId) ? previous : [...previous, nextTabId]
        ));
        setActiveTerminalTabId(nextTabId);
        setFloatingTerminalThemeReadyByTab((previous) => ({
            ...previous,
            [nextTabId]: false,
        }));
    }, [terminalTabIds]);

    const handleCloseTerminalTab = useCallback((tabId: string) => {
        if (tabId === MAIN_TERMINAL_TAB_ID) return;
        const bootstrapSlot = getFloatingTerminalBootstrapSlot(tabId);
        setTerminalTabIds((previous) => {
            const next = previous.filter((id) => id !== tabId);
            return next.length > 0 ? next : [MAIN_TERMINAL_TAB_ID];
        });
        setActiveTerminalTabId((previousActive) => {
            if (previousActive !== tabId) return previousActive;
            const fallback = terminalTabIds.find((id) => id !== tabId);
            return fallback || MAIN_TERMINAL_TAB_ID;
        });
        setFloatingTerminalThemeReadyByTab((previous) => {
            const next = { ...previous };
            delete next[tabId];
            return next;
        });
        delete terminalFramesRef.current[tabId];
        delete tmuxStatusAppliedRef.current[tabId];
        cleanupTerminalLinkHandler(bootstrapSlot);
        cleanupBeforeUnloadGuard(bootstrapSlot);
        cleanupTerminalAutoScroll(bootstrapSlot);
        clearTerminalBootstrapState(bootstrapSlot);
        void (async () => {
            const result = await terminateTmuxSessionRole(sessionName, tabId);
            if (!result.success) {
                console.error(`Failed to terminate closed terminal tab session "${tabId}":`, result.error);
            }
        })();
    }, [
        cleanupBeforeUnloadGuard,
        cleanupTerminalAutoScroll,
        cleanupTerminalLinkHandler,
        clearTerminalBootstrapState,
        sessionName,
        terminalTabIds,
    ]);

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

    useEffect(() => {
        if (isRightPanelCollapsed || isRepoViewActive) {
            attemptedPreviewRestoreRef.current = false;
        }
    }, [isRepoViewActive, isRightPanelCollapsed]);

    useEffect(() => {
        const mediaQuery = window.matchMedia(SESSION_MOBILE_VIEWPORT_QUERY);
        const applyViewportMode = () => {
            setIsMobileViewport(mediaQuery.matches);
        };

        applyViewportMode();

        if (typeof mediaQuery.addEventListener === 'function') {
            mediaQuery.addEventListener('change', applyViewportMode);
        } else {
            mediaQuery.addListener(applyViewportMode);
        }

        return () => {
            if (typeof mediaQuery.removeEventListener === 'function') {
                mediaQuery.removeEventListener('change', applyViewportMode);
            } else {
                mediaQuery.removeListener(applyViewportMode);
            }
        };
    }, []);

    useEffect(() => {
        if (!isMobileViewport) return;
        setIsSplitResizing(false);
    }, [isMobileViewport]);

    const startSplitResize = (e: React.MouseEvent<HTMLDivElement>) => {
        if (isRightPanelCollapsed || isMobileViewport) return;
        e.preventDefault();
        setIsSplitResizing(true);
        splitResizeRef.current = {
            startX: e.clientX,
            startRatio: agentPaneRatio,
        };
    };

    const handlePreviewButtonClick = useCallback(() => {
        if (isRightPanelCollapsed) {
            setIsRepoViewActive(false);
            setIsRightPanelCollapsed(false);
            return;
        }

        if (!isRepoViewActive) {
            setIsRightPanelCollapsed(true);
            return;
        }

        setIsRepoViewActive(false);
    }, [isRepoViewActive, isRightPanelCollapsed]);

    const handleChangesButtonClick = useCallback(() => {
        if (isFolderMode) {
            setFeedback(FOLDER_MODE_GIT_DISABLED_REASON);
            return;
        }

        if (isRightPanelCollapsed) {
            setIsRepoViewActive(true);
            setIsRightPanelCollapsed(false);
            return;
        }

        if (isRepoViewActive) {
            setIsRightPanelCollapsed(true);
            return;
        }

        setIsRepoViewActive(true);
    }, [isFolderMode, isRepoViewActive, isRightPanelCollapsed]);

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
        const iframe = terminalFramesRef.current[activeTerminalTabId];
        if (!iframe) {
            stopTerminalProcessMonitor();
            setIsTerminalForegroundProcessRunning(false);
            return;
        }
        try {
            const win = iframe.contentWindow as TerminalWindow | null;
            if (win?.term) {
                startTerminalProcessMonitor(iframe, win.term);
                return;
            }
        } catch {
            // Ignore transient iframe access errors.
        }
        stopTerminalProcessMonitor();
        setIsTerminalForegroundProcessRunning(false);
    }, [activeTerminalTabId, startTerminalProcessMonitor, stopTerminalProcessMonitor]);

    useEffect(() => {
        if (!isTerminalMinimized) {
            const iframe = terminalFramesRef.current[activeTerminalTabId];
            if (!iframe) return;
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
    }, [activeTerminalTabId, isTerminalMinimized]);

    // IDE Selection
    const [selectedIde, setSelectedIde] = useState<string>('vscode');


    useEffect(() => {
        let cancelled = false;

        const loadConfig = async () => {
            const configuredIde = await loadConfiguredIde();
            if (!cancelled && configuredIde) {
                setSelectedIde(configuredIde);
            }
        };
        void loadConfig();

        return () => {
            cancelled = true;
        };
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
        configuredIdeCache = value;
        await updateConfig({ selectedIde: value });
    };

    const handleOpenIde = () => {
        if (!worktree) return;
        const ide = SUPPORTED_IDES.find(i => i.id === selectedIde);
        if (!ide) return;

        const uri = `${ide.protocol}://file/${encodeURI(worktree)}`;
        window.open(uri, '_blank');
    };

    const handleOpenAgentDetails = useCallback(() => {
        agentPaneRef.current?.openAgentDetails();
    }, []);

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
        const roles = Array.from(new Set(terminalTabIds));
        const results = await Promise.all(
            roles.map((role) => setTmuxSessionMouseMode(sessionName, role, mouseEnabled)),
        );

        if (requestId !== terminalInteractionRequestIdRef.current) {
            return false;
        }

        if (!options?.silent) {
            setIsUpdatingTerminalInteractionMode(false);
        }

        const failed = results.find((result) => !result.success);
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
    }, [sessionName, terminalPersistenceMode, terminalTabIds]);

    const ensureTmuxStatusBarHidden = useCallback((role: string) => {
        if (terminalPersistenceMode !== 'tmux') return;
        if (tmuxStatusAppliedRef.current[role]) return;
        if (tmuxStatusRequestInFlightRef.current[role]) return;

        tmuxStatusRequestInFlightRef.current[role] = true;

        void (async () => {
            let applied = false;
            const result = await setTmuxSessionStatusVisibility(sessionName, role, false);
            if (result.success && result.applied) {
                tmuxStatusAppliedRef.current[role] = true;
                applied = true;
            } else if (!result.success) {
                console.error(`Failed to hide tmux status bar for ${role}:`, result.error);
            }
            if (!applied) {
                tmuxStatusRequestInFlightRef.current[role] = false;
                return;
            }
            tmuxStatusRequestInFlightRef.current[role] = false;
        })();
    }, [sessionName, terminalPersistenceMode]);

    useEffect(() => {
        if (terminalPersistenceMode !== 'tmux') return;
        const roles = Array.from(new Set(terminalTabIds)).sort();
        const requestKey = `${sessionName}:scroll:${roles.join(',')}`;
        if (
            tmuxSilentScrollAppliedKeyRef.current === requestKey
            || tmuxSilentScrollRequestKeyRef.current === requestKey
        ) {
            return;
        }

        tmuxSilentScrollRequestKeyRef.current = requestKey;
        void (async () => {
            const success = await applyTerminalInteractionMode('scroll', { silent: true });
            if (tmuxSilentScrollRequestKeyRef.current === requestKey) {
                tmuxSilentScrollRequestKeyRef.current = null;
            }
            if (success) {
                tmuxSilentScrollAppliedKeyRef.current = requestKey;
            }
        })();
    }, [applyTerminalInteractionMode, sessionName, terminalPersistenceMode, terminalTabIds]);

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
        if (!legacyRepo || !sessionName) return;
        const nextUrl = `/new?project=${encodeURIComponent(legacyRepo)}&prefillFromSession=${encodeURIComponent(sessionName)}`;
        window.open(nextUrl, '_blank', 'noopener,noreferrer');
    };

    const runCleanup = async (requireConfirmation = true): Promise<boolean> => {
        if (!sessionName || !legacyRepo) return false;
        if (!isFolderMode && (!repo || !worktree || !branch)) return false;
        if (requireConfirmation) {
            const prompt = isFolderMode
                ? 'Are you sure you want to delete this session? This will remove session metadata.'
                : 'Are you sure you want to delete this session? This will remove the branch, worktree, and session metadata.';
            if (!confirm(prompt)) return false;
        }

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

    const insertIntoAgentComposer = useCallback((text: string): Promise<boolean> => {
        const inserted = agentPaneRef.current?.insertText(text) ?? false;
        if (inserted) {
            agentPaneRef.current?.focusComposer();
        }
        return Promise.resolve(inserted);
    }, []);

    const handleInsertFilePaths = useCallback(async (paths: string[]) => {
        if (paths.length === 0) return;

        setIsInsertingFilePaths(true);
        const textToInsert = `${paths.join(' ')} `;
        const inserted = await insertIntoAgentComposer(textToInsert);
        setFeedback(
            inserted
                ? `Inserted ${paths.length} file path${paths.length === 1 ? '' : 's'} into agent input`
                : 'Failed to insert file paths into agent input'
        );
        setIsInsertingFilePaths(false);
    }, [insertIntoAgentComposer]);

    const loadBaseBranchOptions = useCallback(async () => {
        if (!sessionName || isFolderMode || !repo) {
            setBaseBranchOptions([]);
            setCurrentBaseBranch('');
            setMainWorktreeBranch('');
            return;
        }
        if (isLoadingBaseBranchesRef.current) return;

        isLoadingBaseBranchesRef.current = true;
        setIsLoadingBaseBranches(true);

        try {
            const result = await listSessionBaseBranches(sessionName, repo);
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
    }, [isFolderMode, repo, sessionName]);

    useEffect(() => {
        if (!sessionName) return;
        void loadBaseBranchOptions();
    }, [loadBaseBranchOptions, sessionName]);

    const loadSessionDivergence = useCallback(async () => {
        if (!sessionName || isFolderMode || !repo) {
            setDivergence({ ahead: 0, behind: 0 });
            return;
        }

        try {
            const result = await getSessionDivergence(sessionName, repo);
            if (result.success && typeof result.ahead === 'number' && typeof result.behind === 'number') {
                setDivergence({ ahead: result.ahead, behind: result.behind });
            }
        } catch (e) {
            console.error('Failed to load branch divergence:', e);
        }
    }, [isFolderMode, repo, sessionName]);

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

    const runMerge = async (): Promise<boolean> => {
        if (!sessionName) return false;
        if (!currentBaseBranch) return false;

        setIsMerging(true);
        setFeedback('Merging session branch...');

        try {
            const result = await mergeSessionToBase(sessionName, repo);
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

    const handleRebaseSelect = useCallback(async (targetBranch: string) => {
        setIsRebaseDropdownOpen(false);
        if (!sessionName) return;

        const isNewBranch = targetBranch !== currentBaseBranch;

        setIsRebasing(true);
        setFeedback(isNewBranch ? `Updating base to ${targetBranch} and rebasing...` : 'Rebasing session branch...');

        try {
            if (isNewBranch) {
                setIsUpdatingBaseBranch(true);
                const updateResult = await updateSessionBaseBranch(sessionName, targetBranch, repo);
                if (!updateResult.success) {
                    setFeedback(`Failed to update base branch: ${updateResult.error}`);
                    setIsUpdatingBaseBranch(false);
                    setIsRebasing(false);
                    return;
                }
                setCurrentBaseBranch(updateResult.baseBranch!);
                await loadBaseBranchOptions();
                setIsUpdatingBaseBranch(false);
            }

            const result = await rebaseSessionOntoBase(sessionName, repo);
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
            setIsUpdatingBaseBranch(false);
            setIsRebasing(false);
        }
    }, [currentBaseBranch, loadBaseBranchOptions, loadSessionDivergence, repo, sessionName]);

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
            const result = await createSessionBaseBranch(sessionName, targetBranchName, sourceBranchName, repo);
            if (result.success && result.branchName && result.fromBranch) {
                setFeedback(`Created branch ${result.branchName} from ${result.fromBranch}. Setting as base and rebasing...`);
                setIsCreateBaseBranchDialogOpen(false);
                setNewBaseBranchName('');
                setNewBaseBranchFrom('');
                await handleRebaseSelect(result.branchName);
            } else {
                setFeedback(`Failed to create branch: ${result.error}`);
            }
        } catch (error) {
            console.error('Failed to create base branch:', error);
            setFeedback('Failed to create branch');
        } finally {
            setIsCreatingBaseBranch(false);
        }
    }, [handleRebaseSelect, newBaseBranchFrom, newBaseBranchName, repo, sessionName]);

    const persistPreviewTargetUrl = useCallback((targetUrl: string) => {
        try {
            window.localStorage.setItem(getPreviewTargetStorageKey(sessionName), targetUrl);
        } catch (error) {
            console.warn('Failed to persist preview target URL:', error);
        }
    }, [sessionName]);

    const loadPreview = useCallback(async (rawUrl: string, openPreview: boolean): Promise<boolean> => {
        const normalized = normalizePreviewUrl(rawUrl);
        if (!normalized) {
            setFeedback('Please enter a preview URL');
            return false;
        }

        setPreviewInputUrl(normalized);
        setFeedback(`Loading preview: ${normalized}`);

        try {
            const response = await fetch('/api/preview-proxy/start', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ target: normalized }),
            });

            const payload = await response.json().catch(() => null) as { error?: string; proxyUrl?: string } | null;
            if (!response.ok || !payload?.proxyUrl) {
                throw new Error(payload?.error || 'Failed to start preview proxy');
            }

            setPreviewUrl(payload.proxyUrl);
            setLoadedPreviewTargetUrl(normalized);
            persistPreviewTargetUrl(normalized);
            if (openPreview) {
                setIsPreviewVisible(true);
            }
            setFeedback(`Loaded preview: ${normalized}`);
            return true;
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Failed to load preview';
            console.error('Failed to load preview:', error);
            setFeedback(`Failed to load preview: ${message}`);
            return false;
        }
    }, [persistPreviewTargetUrl]);

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
        setFeedback('Preview unloaded');
    }, [previewUrl]);

    const { attachTerminalLinkHandler } = useTerminalLink({
        onLoadPreview: (url, openPreview) => loadPreview(url, openPreview)
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
                type?: string;
                url?: unknown;
            } | null;
            if (!payload || typeof payload !== 'object') return;

            if (payload.type === 'viba:preview-ready') {
                const previewWindow = previewIframeRef.current?.contentWindow;
                if (previewWindow) {
                    previewWindow.postMessage({ type: 'viba:preview-location-request' }, '*');
                }
                return;
            }

            if (payload.type === 'viba:preview-location-change') {
                if (typeof payload.url === 'string' && payload.url.trim().length > 0) {
                    const normalized = normalizePreviewUrl(payload.url);
                    if (!normalized) return;
                    setPreviewInputUrl(normalized);
                    setLoadedPreviewTargetUrl(normalized);
                    persistPreviewTargetUrl(normalized);
                }
            }
        };

        window.addEventListener('message', handlePreviewMessage);
        return () => {
            window.removeEventListener('message', handlePreviewMessage);
        };
    }, [persistPreviewTargetUrl]);

    useEffect(() => {
        if (isRightPanelCollapsed || isRepoViewActive || !isPreviewVisible || previewUrl) {
            return;
        }
        if (attemptedPreviewRestoreRef.current) {
            return;
        }

        const storedPreviewTarget = (() => {
            try {
                return window.localStorage.getItem(getPreviewTargetStorageKey(sessionName))?.trim() || '';
            } catch {
                return '';
            }
        })();

        const fallbackTarget = storedPreviewTarget || devServerState.previewUrl || '';
        if (!fallbackTarget) {
            return;
        }

        attemptedPreviewRestoreRef.current = true;
        void loadPreview(fallbackTarget, false);
    }, [devServerState.previewUrl, isPreviewVisible, isRepoViewActive, isRightPanelCollapsed, loadPreview, previewUrl, sessionName]);

    const handlePreviewSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void loadPreview(previewInputUrl, true);
    };

    const handlePreviewIframeLoad = useCallback(() => {
        postPreviewControlMessage({ type: 'viba:preview-location-request' });
    }, [postPreviewControlMessage]);

    const handleOpenPreviewInNewTab = useCallback(() => {
        const preferredTarget = loadedPreviewTargetUrl.trim() || previewInputUrl.trim();
        const normalizedTarget = normalizePreviewUrl(preferredTarget);

        if (!normalizedTarget) {
            setFeedback('Please enter a preview URL');
            return;
        }

        window.open(normalizedTarget, '_blank', 'noopener,noreferrer');
        setFeedback(`Opened preview in new tab: ${normalizedTarget}`);
    }, [loadedPreviewTargetUrl, previewInputUrl]);

    const syncDevServerStateFromTerminal = useCallback(async () => {
        const script = devServerScript?.trim();
        if (!script) {
            setDevServerState({ running: false, previewUrl: null });
            pendingDevServerPreviewLoadRef.current = false;
            setIsAwaitingDevServerPreview(false);
            setDevServerTerminalMarker(false);
            return null;
        }

        const terminalSession = getFloatingTerminalSession(MAIN_TERMINAL_TAB_ID);
        if (!terminalSession) {
            return null;
        }

        const transcript = readTerminalTranscript(terminalSession.term);
        const previewUrlFromTerminal = inferPreviewUrlFromTerminalText(transcript);
        const hasTerminalMarker = hasDevServerTerminalMarker();
        const commandVisibleInTranscript = terminalTranscriptContainsCommand(transcript, script);
        const startedByDevButton = hasTerminalMarker
            || (pendingDevServerPreviewLoadRef.current && commandVisibleInTranscript);
        const isRunning = !isShellPromptReady(terminalSession.term) && startedByDevButton;

        setDevServerState((current) => {
            const nextState = {
                running: isRunning,
                previewUrl: previewUrlFromTerminal || current.previewUrl,
            };
            if (current.running === nextState.running && current.previewUrl === nextState.previewUrl) {
                return current;
            }
            return nextState;
        });

        if (previewUrlFromTerminal && pendingDevServerPreviewLoadRef.current) {
            pendingDevServerPreviewLoadRef.current = false;
            setIsAwaitingDevServerPreview(false);
            void loadPreview(previewUrlFromTerminal, true);
        }

        if (!isRunning && hasTerminalMarker) {
            pendingDevServerPreviewLoadRef.current = false;
            setIsAwaitingDevServerPreview(false);
            setDevServerTerminalMarker(false);
        }

        return {
            running: isRunning,
            previewUrl: previewUrlFromTerminal,
        };
    }, [
        devServerScript,
        getFloatingTerminalSession,
        hasDevServerTerminalMarker,
        isShellPromptReady,
        loadPreview,
        readTerminalTranscript,
        setDevServerTerminalMarker,
    ]);

    useEffect(() => {
        if (!devServerScript?.trim()) {
            setDevServerState({ running: false, previewUrl: null });
            pendingDevServerPreviewLoadRef.current = false;
            setIsAwaitingDevServerPreview(false);
            setDevServerTerminalMarker(false);
            return;
        }

        let cancelled = false;
        const sync = async () => {
            if (cancelled) return;
            await syncDevServerStateFromTerminal();
        };

        void sync();
        const intervalId = window.setInterval(() => {
            void sync();
        }, 1500);

        return () => {
            cancelled = true;
            window.clearInterval(intervalId);
        };
    }, [devServerScript, setDevServerTerminalMarker, syncDevServerStateFromTerminal]);

    const handleStartDevServer = async () => {
        const script = devServerScript?.trim();
        if (!script) return;

        revealDevServerTerminal();
        setIsStartingDevServer(true);
        pendingDevServerPreviewLoadRef.current = true;
        setIsAwaitingDevServerPreview(true);
        setFeedback('Starting dev server in terminal...');

        try {
            await ensureTerminalService();

            const preparation = await prepareSessionDevServerTerminalRun(sessionName);
            if (!preparation.success) {
                pendingDevServerPreviewLoadRef.current = false;
                setIsAwaitingDevServerPreview(false);
                setFeedback(preparation.error || 'Failed to prepare dev server');
                return;
            }

            const terminalSession = await waitForFloatingTerminalSession(MAIN_TERMINAL_TAB_ID, {
                requireShellPrompt: true,
                timeoutMs: 10000,
            });
            if (!terminalSession) {
                pendingDevServerPreviewLoadRef.current = false;
                setIsAwaitingDevServerPreview(false);
                setFeedback('Terminal is busy or not ready yet');
                return;
            }

            focusFloatingTerminalSession(MAIN_TERMINAL_TAB_ID);
            const commandSent = sendTerminalInput(terminalSession.term, script);
            const enterSent = commandSent && sendFloatingTerminalEnter(MAIN_TERMINAL_TAB_ID);
            if (!enterSent) {
                pendingDevServerPreviewLoadRef.current = false;
                setIsAwaitingDevServerPreview(false);
                setFeedback('Failed to send dev server command to terminal');
                return;
            }

            setDevServerTerminalMarker(true);
            setDevServerState((current) => ({ ...current, running: true }));
            focusFloatingTerminalSession(MAIN_TERMINAL_TAB_ID);
            setFeedback(
                preparation.removedStaleLock
                    ? 'Removed stale Next.js dev lock and started dev server in terminal'
                    : 'Dev server started in terminal'
            );
        } catch (error) {
            pendingDevServerPreviewLoadRef.current = false;
            setIsAwaitingDevServerPreview(false);
            console.error('Failed to start dev server:', error);
            setFeedback(error instanceof Error ? error.message : 'Failed to start dev server');
        } finally {
            setIsStartingDevServer(false);
        }
    };

    const handleStopDevServer = useCallback(async () => {
        if (!devServerScript?.trim()) return;

        revealDevServerTerminal();
        setIsStoppingDevServer(true);
        pendingDevServerPreviewLoadRef.current = false;
        setIsAwaitingDevServerPreview(false);
        setFeedback('Stopping dev server in terminal...');

        try {
            await ensureTerminalService();
            const terminalSession = await waitForFloatingTerminalSession(MAIN_TERMINAL_TAB_ID, {
                timeoutMs: 5000,
            });
            if (!terminalSession) {
                setFeedback('Terminal is not ready yet');
                return;
            }

            focusFloatingTerminalSession(MAIN_TERMINAL_TAB_ID);
            const interruptSent = sendTerminalInput(terminalSession.term, '\u0003');
            if (!interruptSent) {
                setFeedback('Failed to send interrupt to terminal');
                return;
            }

            focusFloatingTerminalSession(MAIN_TERMINAL_TAB_ID);
            setFeedback('Sent interrupt to dev server terminal');
        } catch (error) {
            console.error('Failed to stop dev server:', error);
            setFeedback(error instanceof Error ? error.message : 'Failed to stop dev server');
        } finally {
            setIsStoppingDevServer(false);
        }
    }, [
        devServerScript,
        ensureTerminalService,
        focusFloatingTerminalSession,
        revealDevServerTerminal,
        sendTerminalInput,
        waitForFloatingTerminalSession,
    ]);
    const handleTerminalLoad = (iframeFromEvent?: HTMLIFrameElement | null, tabIdFromEvent?: string) => {
        const tabId = tabIdFromEvent || activeTerminalTabId;
        const iframe = iframeFromEvent
            || terminalFramesRef.current[tabId];
        if (!iframe) return;
        const tabSrc = terminalTabSources[tabId] || floatingTerminalSrc;
        const isActiveTerminalFrame = (): boolean => (
            tabId === activeTerminalTabIdRef.current && iframe === terminalFramesRef.current[tabId]
        );
        const bootstrapSlot = getFloatingTerminalBootstrapSlot(tabId);

        if (isActiveTerminalFrame()) {
            setFloatingTerminalThemeReadyForTab(tabId, false);
            stopTerminalProcessMonitor();
            setIsTerminalForegroundProcessRunning(false);
        }

        // Safety check
        try {
            void iframe.contentWindow;
        } catch {
            console.error("Secondary terminal: Cross-Origin access blocked.");
            return;
        }

        const linkCleanupRef = getTerminalLinkCleanupRef(bootstrapSlot);
        installBeforeUnloadGuard(bootstrapSlot, iframe);

        const checkAndInject = (attempts = 0) => {
            if (attempts > 30) {
                return;
            }

            try {
                const win = iframe.contentWindow as TerminalWindow | null;
                if (win && win.term) {
                    ensureTmuxStatusBarHidden(tabId);
                    const term = win.term;
                    attachTerminalLinkHandler(iframe, linkCleanupRef, {
                        onLinkActivated: () => setIsTerminalMinimized(true),
                        directOpenBehavior: 'preview',
                        modifierOpenBehavior: 'new_tab',
                    });

                    // Ensure terminal palette stays in sync with app/OS theme.
                    const themeApplied = applyThemeToTerminalWindow(win);
                    if (themeApplied) {
                        setFloatingTerminalThemeReadyForTab(tabId, true);
                    }

                    if (isActiveTerminalFrame()) {
                        startTerminalProcessMonitor(iframe, term);
                    }

                    installTerminalAutoScroll(bootstrapSlot, iframe, term);

                    const alreadyBootstrapped = hasTerminalBootstrapped(bootstrapSlot);
                    const shouldSkipResumeInjection = Boolean(isResume) && terminalPersistenceMode === 'tmux';
                    if (alreadyBootstrapped || shouldSkipResumeInjection) {
                        if (shouldSkipResumeInjection && !alreadyBootstrapped) {
                            markTerminalBootstrapped(bootstrapSlot);
                        }
                        if (isActiveTerminalFrame()) {
                            win.focus();
                            const textarea = iframe.contentDocument?.querySelector("textarea.xterm-helper-textarea");
                            if (textarea) (textarea as HTMLElement).focus();
                        }
                        return;
                    }

                    if (!isShellPromptReady(term) && attempts < 10) {
                        setTimeout(() => checkAndInject(attempts + 1), 200);
                        return;
                    }

                    if (!beginTerminalBootstrap(bootstrapSlot)) {
                        if (isActiveTerminalFrame()) {
                            win.focus();
                            const textarea = iframe.contentDocument?.querySelector("textarea.xterm-helper-textarea");
                            if (textarea) (textarea as HTMLElement).focus();
                        }
                        return;
                    }

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
                    if (shellBootstrapEnvironmentCommand) {
                        term.paste(shellBootstrapEnvironmentCommand);
                        pressEnter();
                    }
                    markTerminalBootstrapped(bootstrapSlot);

                    if (tabId !== MAIN_TERMINAL_TAB_ID) {
                        const targetPath = parseTerminalWorkingDirectoryFromSrc(tabSrc) || sessionWorkspaceRootPath || worktree || repo;
                        if (targetPath && !shellBootstrapEnvironmentCommand) {
                            term.paste(buildShellSetDirectoryCommand(targetPath, terminalShellKind));
                            pressEnter();
                        }
                    }

                    // Focus
                    if (isActiveTerminalFrame()) {
                        win.focus();
                        const textarea = iframe.contentDocument?.querySelector("textarea.xterm-helper-textarea");
                        if (textarea) (textarea as HTMLElement).focus();
                    }
                } else {
                    setTimeout(() => checkAndInject(attempts + 1), 500);
                }
            } catch (e) {
                if (isActiveTerminalFrame()) {
                    setIsTerminalForegroundProcessRunning(false);
                }
                resetTerminalBootstrap(bootstrapSlot);
                console.error("Secondary terminal injection error", e);
            }
        };

        setTimeout(() => checkAndInject(), 1000);
    };

    if (!repo) return <div className="p-4 text-error dark:bg-[#0d1117] dark:text-red-300">No project specified</div>;

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
    const rebaseButtonLabel = currentBaseBranch ? `Rebase onto ${currentBaseBranch}` : 'Rebase';
    const rebaseButtonTitle = currentBaseBranch
        ? `Select base branch and rebase onto ${currentBaseBranch}`
        : 'Select base branch and rebase';
    const gitControlsDisabled = isFolderMode;
    const gitControlsDisabledReason = FOLDER_MODE_GIT_DISABLED_REASON;
    const hasDevServerScript = Boolean(devServerScript?.trim());
    const isDevServerButtonLoading = isStartingDevServer || isStoppingDevServer || isAwaitingDevServerPreview;
    const isDevButtonDisabled = !hasDevServerScript || isDevServerButtonLoading;
    const devButtonTitle = !hasDevServerScript
        ? 'Set a dev server script to enable this button'
        : devServerState.running
            ? 'Interrupt dev server running in terminal'
            : isTerminalForegroundProcessRunning
                ? 'Run dev server in terminal (another foreground terminal process is visible)'
                : 'Run dev server in terminal';
    const isMobileRightPanelOverlay = isMobileViewport;
    const isMobileOverlayExpanded = isMobileRightPanelOverlay && !isRightPanelCollapsed;
    const isPreviewPanelActive = !isRightPanelCollapsed && !isRepoViewActive;
    const isChangesPanelActive = !isRightPanelCollapsed && isRepoViewActive;
    const renderedTerminalTabIds = terminalPersistenceMode === 'tmux'
        ? [activeTerminalTabId]
        : terminalTabIds;
    const showDesktopSplitHandle = !isRightPanelCollapsed && !isMobileRightPanelOverlay;
    const rightPanelWrapperClass = isMobileRightPanelOverlay
        ? `absolute inset-0 z-30 h-full transition-[opacity,transform] duration-300 ease-in-out ${isRightPanelCollapsed
            ? 'pointer-events-none translate-x-2 opacity-0'
            : 'pointer-events-auto translate-x-0 opacity-100'}`
        : `relative h-full transition-[width,min-width,flex-basis] duration-300 ease-in-out ${isRightPanelCollapsed
            ? 'w-0 min-w-0 flex-none'
            : 'min-w-[360px] flex-1'}`;
    const sessionHeaderClass = isMobileViewport
        ? 'z-20 flex items-center justify-between bg-white px-4 py-2 text-xs font-mono dark:bg-[#161b22] dark:text-slate-300'
        : 'z-20 flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2 text-xs font-mono shadow-sm dark:border-[#30363d] dark:bg-[#161b22] dark:text-slate-300';
    const agentPanelClass = isMobileViewport
        ? 'agent-activity-panel flex h-full min-w-0 flex-col overflow-hidden bg-white transition-[width] duration-300 ease-in-out dark:bg-[#161b22]'
        : 'agent-activity-panel flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition-[width] duration-300 ease-in-out dark:border-[#30363d] dark:bg-[#161b22]';
    const agentToolbarClass = isMobileViewport
        ? 'flex h-9 items-center justify-between gap-3 px-3 text-[11px] font-semibold text-slate-600 dark:bg-[#161b22] dark:text-slate-400'
        : 'flex h-9 items-center justify-between gap-3 border-b border-slate-200 px-3 text-[11px] font-semibold text-slate-600 dark:border-[#30363d] dark:bg-[#161b22] dark:text-slate-400';
    const rightPanelShellClass = isMobileRightPanelOverlay
        ? 'absolute inset-y-0 left-0 flex h-full w-full flex-col overflow-hidden bg-white dark:bg-[#161b22]'
        : 'absolute inset-y-0 left-0 flex h-full w-full flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-[#30363d] dark:bg-[#161b22]';

    return (
        <div className={`flex h-screen w-full flex-col overflow-hidden bg-[#f6f6f8] dark:bg-[#0d1117] ${(isResizing || isSplitResizing) ? 'select-none' : ''}`}>
            {(isResizing || isSplitResizing) && (
                <div className={`fixed inset-0 z-[9999] ${isResizing ? 'cursor-row-resize' : 'cursor-col-resize'}`} />
            )}
            <div className={sessionHeaderClass}>
                <div className="flex min-w-0 flex-1 items-center gap-4">
                    <button
                        className="btn btn-ghost btn-xs h-6 min-h-6 px-1 text-slate-600 hover:bg-base-content/10 dark:text-slate-300 dark:hover:bg-[#30363d]/60"
                        onClick={() => onExit()}
                        title="Back to Home"
                    >
                        <ChevronLeft className="h-4 w-4" />
                    </button>
                    <div className="flex min-w-0 flex-col">
                        <div className="flex min-w-0 items-center gap-2">
                            {!isMobileViewport && <span className="shrink-0 opacity-50">Project:</span>}
                            <span
                                className="min-w-0 max-w-[200px] truncate font-bold sm:max-w-[320px]"
                                title={repoDisplayName || getBaseName(legacyRepo)}
                            >
                                {repoDisplayName || getBaseName(legacyRepo)}
                            </span>
                        </div>
                        {sessionName && (
                            <div className="hidden min-[1200px]:flex min-w-0 items-center gap-2 text-[10px] opacity-70">
                                <span>Session:</span>
                                <span className="truncate max-w-[220px]" title={sessionName}>{sessionName}</span>
                            </div>
                        )}
                    </div>
                </div>

                <div className="ml-3 flex shrink-0 items-center gap-4">
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
                                disabled={gitControlsDisabled || isRebasing || isMerging || isUpdatingBaseBranch}
                                title={gitControlsDisabled ? gitControlsDisabledReason : rebaseButtonTitle}
                            >
                                {isRebasing ? <span className="loading loading-spinner loading-xs"></span> : <GitMerge className="w-3 h-3" />}
                                <span className={headerButtonLabelClass}>{rebaseButtonLabel}</span>
                                <ChevronDown className="w-3 h-3 opacity-50 ml-0.5" />
                            </button>
                            {isRebaseDropdownOpen && !gitControlsDisabled && (
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
                            disabled={gitControlsDisabled || isMerging || isRebasing || isUpdatingBaseBranch || !currentBaseBranch}
                            title={gitControlsDisabled
                                ? gitControlsDisabledReason
                                : currentBaseBranch
                                    ? `Merge current branch (${branch}) into target branch (${currentBaseBranch})`
                                    : 'Target branch unavailable for this session'}
                        >
                            {isMerging ? <span className="loading loading-spinner loading-xs"></span> : <GitPullRequestArrow className="w-3 h-3" />}
                            <span className={headerButtonLabelClass}>Merge</span>
                        </button>
                        <div className="h-4 w-[1px] bg-base-content/10 dark:bg-[#30363d]"></div>
                        <button
                            className="btn btn-ghost btn-error btn-xs h-6 min-h-6 rounded-none rounded-r border-none px-2 hover:border-transparent hover:bg-error/20 dark:text-red-300"
                            onClick={handleCleanup}
                            disabled={isMerging || isRebasing || (!isFolderMode && !worktree)}
                            title="Clean up and exit"
                        >
                            <Trash2 className="w-3 h-3" />
                            <span className={headerButtonLabelClass}>Delete</span>
                        </button>
                    </div>

                    <div className="flex items-center overflow-hidden rounded border border-base-content/20 bg-base-100 dark:border-[#30363d] dark:bg-[#0d1117]">
                        <button
                            type="button"
                            className={`btn btn-ghost btn-xs h-6 min-h-6 rounded-none border-none px-2 hover:bg-base-content/10 dark:hover:bg-[#30363d]/60 ${isPreviewPanelActive ? 'bg-slate-100 text-slate-900 dark:bg-[#30363d] dark:text-slate-100' : 'text-slate-700 dark:text-slate-300'}`}
                            onClick={handlePreviewButtonClick}
                            aria-pressed={isPreviewPanelActive}
                            title={isPreviewPanelActive
                                ? 'Hide preview and terminal panel'
                                : 'Show preview and terminal panel'}
                        >
                            <Play className="h-3 w-3" />
                            <span className={headerButtonLabelClass}>Preview</span>
                        </button>
                        <div className="h-4 w-[1px] bg-base-content/10 dark:bg-[#30363d]"></div>
                        <button
                            type="button"
                            className={`btn btn-ghost btn-xs h-6 min-h-6 rounded-none border-none px-2 hover:bg-base-content/10 dark:hover:bg-[#30363d]/60 ${isChangesPanelActive ? 'bg-slate-100 text-slate-900 dark:bg-[#30363d] dark:text-slate-100' : 'text-slate-700 dark:text-slate-300'}`}
                            onClick={handleChangesButtonClick}
                            disabled={isFolderMode}
                            aria-pressed={isChangesPanelActive}
                            title={isFolderMode
                                ? gitControlsDisabledReason
                                : isChangesPanelActive
                                    ? 'Hide repository viewer'
                                    : 'Show repository viewer'}
                        >
                            <GitBranch className="h-3 w-3" />
                            <span className={headerButtonLabelClass}>Changes</span>
                        </button>
                    </div>

                    {gitControlsDisabled && (
                        <div className="hidden max-w-[320px] text-[10px] opacity-70 min-[1300px]:block" title={gitControlsDisabledReason}>
                            {gitControlsDisabledReason}
                        </div>
                    )}

                    {currentBaseBranch && !gitControlsDisabled && !isMobileViewport && (
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
                            Create a new branch, set it as the base branch, and rebase this session branch onto it automatically.
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
                className={`relative flex min-h-0 flex-1 overflow-x-hidden bg-[#f6f6f8] dark:bg-[#0d1117] ${isMobileViewport || isMobileOverlayExpanded ? 'p-0' : 'p-3'} ${isRightPanelCollapsed || isMobileRightPanelOverlay || isMobileViewport ? 'gap-0' : 'gap-3'}`}
            >
                <div
                    className={agentPanelClass}
                    style={{ width: isRightPanelCollapsed || isMobileRightPanelOverlay ? '100%' : `${agentPaneRatio * 100}%` }}
                >
                    {!isMobileViewport && (
                        <div className={agentToolbarClass}>
                            <span className="flex shrink-0 items-center gap-2 uppercase tracking-wide">
                                <span className="h-2 w-2 rounded-full bg-blue-500"></span>
                                Agent Activity
                            </span>
                            <div className="flex min-w-0 items-center justify-end gap-2 overflow-x-auto py-1 text-xs font-medium normal-case">
                                {agentHeaderMeta ? (
                                    <div className="flex min-w-0 max-w-[440px] items-center gap-1.5 overflow-hidden whitespace-nowrap rounded border border-slate-200 bg-white px-2 py-0.5 dark:border-[#30363d] dark:bg-[#0d1117]">
                                        <span
                                            className="min-w-0 max-w-[140px] truncate text-slate-700 dark:text-slate-200"
                                            title={agentHeaderMeta.providerName || 'Agent'}
                                        >
                                            {agentHeaderMeta.providerName || 'Agent'}
                                        </span>
                                        <span className="shrink-0 text-slate-300 dark:text-slate-500">/</span>
                                        <span
                                            className="min-w-0 max-w-[180px] truncate text-slate-500 dark:text-slate-400"
                                            title={agentHeaderMeta.model || 'n/a'}
                                        >
                                            {agentHeaderMeta.model || 'n/a'}
                                        </span>
                                        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${agentRunStateTone(agentHeaderMeta.runState)}`}>
                                            {formatAgentRunState(agentHeaderMeta.runState)}
                                        </span>
                                    </div>
                                ) : null}
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
                                <button
                                    type="button"
                                    className="btn btn-ghost btn-xs h-6 min-h-6 w-6 shrink-0 border border-slate-200 bg-white p-0 text-slate-700 hover:bg-slate-100 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-300 dark:hover:bg-[#30363d]/60"
                                    onClick={handleOpenAgentDetails}
                                    title="Agent details"
                                    aria-label="Agent details"
                                >
                                    <Info className="h-3.5 w-3.5" />
                                </button>
                            </div>
                        </div>
                    )}
                    <div className="min-h-0 flex-1">
                        <AgentSessionPane
                            ref={agentPaneRef}
                            sessionId={sessionName}
                            workspacePath={sessionWorkspaceRootPath || worktree || repo}
                            onFeedback={setFeedback}
                            onHeaderMetaChange={setAgentHeaderMeta}
                        />
                    </div>
                </div>

                <div
                    className={`relative h-full shrink-0 rounded transition-all duration-300 ease-in-out ${showDesktopSplitHandle
                        ? 'w-2 cursor-col-resize bg-slate-200 opacity-100 hover:bg-primary/40 dark:bg-[#30363d] dark:hover:bg-primary/60'
                        : 'w-0 cursor-default opacity-0 pointer-events-none'
                        }`}
                    onMouseDown={startSplitResize}
                    role={showDesktopSplitHandle ? 'separator' : undefined}
                    aria-orientation={showDesktopSplitHandle ? 'vertical' : undefined}
                    aria-label={showDesktopSplitHandle ? 'Resize preview panel' : undefined}
                    aria-hidden={!showDesktopSplitHandle}
                    title={showDesktopSplitHandle ? 'Drag to resize preview panel' : undefined}
                >
                    {showDesktopSplitHandle && (
                        <div className="absolute left-1/2 top-1/2 h-12 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-slate-400 dark:bg-slate-500" />
                    )}
                </div>

                <div
                    className={rightPanelWrapperClass}
                >
                    {!isRightPanelCollapsed && (
                        <div className={rightPanelShellClass}>
                            {isRepoViewActive ? (
                                <SessionRepoViewer
                                    repoPath={worktree || repo}
                                    branchHint={branch}
                                    baseBranchHint={currentBaseBranch || baseBranch}
                                    repoOptions={repoViewerOptions}
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
                                                {devServerState.running
                                                    ? 'Dev server is running. Waiting for its preview URL, or enter one above.'
                                                    : 'Run the dev server, or enter a URL above to load a preview.'}
                                            </div>
                                        )}
                                    </div>

                                    {!isTerminalMinimized && (
                                        <div
                                            className="flex h-2 cursor-row-resize items-center justify-center border-y border-slate-200 bg-slate-100 dark:border-[#30363d] dark:bg-[#22272e]"
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
                                        <div className="flex h-9 items-center justify-between gap-3 border-t border-slate-200 px-3 text-xs font-semibold text-slate-700 dark:border-[#30363d] dark:text-slate-300">
                                            <div className="flex min-w-0 items-center gap-3">
                                                <span className="flex shrink-0 items-center gap-2 uppercase tracking-wide">
                                                    <span className="h-2 w-2 rounded-full bg-amber-500"></span>
                                                    Terminal
                                                </span>
                                                <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
                                                    {terminalTabIds.map((tabId, index) => (
                                                        <div
                                                            key={tabId}
                                                            className={`flex items-center rounded border px-1.5 py-0.5 ${activeTerminalTabId === tabId
                                                                ? 'border-slate-300 bg-white dark:border-[#3f4754] dark:bg-[#0d1117]'
                                                                : 'border-transparent bg-transparent hover:border-slate-200 hover:bg-slate-100 dark:hover:border-[#30363d] dark:hover:bg-[#0d1117]/60'}`}
                                                        >
                                                            <button
                                                                type="button"
                                                                className="truncate text-[10px]"
                                                                onClick={() => {
                                                                    if (tabId === activeTerminalTabId) return;
                                                                    setFloatingTerminalThemeReadyForTab(tabId, false);
                                                                    setActiveTerminalTabId(tabId);
                                                                }}
                                                                title={tabId}
                                                            >
                                                                {index === 0 ? 'Main' : `Tab ${index + 1}`}
                                                            </button>
                                                            {tabId !== 'terminal' && (
                                                                <button
                                                                    type="button"
                                                                    className="ml-1 text-[10px] opacity-70 hover:opacity-100"
                                                                    onClick={() => handleCloseTerminalTab(tabId)}
                                                                    title="Close terminal tab"
                                                                >
                                                                    <X className="h-3 w-3" />
                                                                </button>
                                                            )}
                                                        </div>
                                                    ))}
                                                    <button
                                                        type="button"
                                                        className="btn btn-ghost btn-xs h-6 min-h-6 w-6 border-none p-0 text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-[#30363d]/60"
                                                        onClick={handleAddTerminalTab}
                                                        title="Add terminal tab"
                                                    >
                                                        <Plus className="h-3.5 w-3.5" />
                                                    </button>
                                                </div>
                                            </div>

                                            <div className="flex shrink-0 items-center gap-2">
                                                <button
                                                    className={`btn btn-ghost btn-xs h-6 min-h-6 w-7 border-none p-0 text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-[#30363d]/60 ${terminalInteractionMode === 'select' ? 'text-warning' : ''}`}
                                                    onClick={handleToggleTerminalInteractionMode}
                                                    disabled={terminalPersistenceMode !== 'tmux' || isUpdatingTerminalInteractionMode}
                                                    title={terminalPersistenceMode === 'tmux'
                                                        ? (terminalInteractionMode === 'scroll'
                                                            ? 'Switch to text select mode for easier copy'
                                                            : 'Switch to scroll mode for wheel scrollback')
                                                        : 'Mode toggle is available only in tmux persistence mode'}
                                                    aria-label={terminalInteractionMode === 'scroll' ? 'Switch to text mode' : 'Switch to scroll mode'}
                                                    type="button"
                                                >
                                                    {isUpdatingTerminalInteractionMode ? (
                                                        <span className="loading loading-spinner loading-xs"></span>
                                                    ) : (
                                                        terminalInteractionMode === 'scroll'
                                                            ? <ScrollText className="h-3.5 w-3.5" />
                                                            : <TextCursorInput className="h-3.5 w-3.5" />
                                                    )}
                                                </button>
                                                <button
                                                    className="btn btn-ghost btn-xs h-6 min-h-6 border-none px-2 text-slate-700 hover:bg-slate-100 disabled:opacity-30 dark:text-slate-300 dark:hover:bg-[#30363d]/60"
                                                    onClick={() => {
                                                        if (devServerState.running) {
                                                            void handleStopDevServer();
                                                            return;
                                                        }
                                                        void handleStartDevServer();
                                                    }}
                                                    disabled={isDevButtonDisabled}
                                                    title={devButtonTitle}
                                                    type="button"
                                                >
                                                    {isDevServerButtonLoading
                                                        ? <span className="loading loading-spinner loading-xs"></span>
                                                        : (devServerState.running ? <X className="h-3 w-3" /> : <Play className="h-3 w-3" />)}
                                                    <span className="hidden min-[1700px]:inline">{devServerState.running ? 'Stop' : 'Dev'}</span>
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
                                        <div
                                            className={`relative ${isTerminalMinimized
                                                ? 'h-0 overflow-hidden'
                                                : 'min-h-0 flex-1 overflow-hidden border-t border-slate-200 bg-white dark:border-[#30363d] dark:bg-[#22272e]'}`}
                                        >
                                            {isTerminalServiceReady && !isFloatingTerminalThemeReady && (
                                                <div className={TERMINAL_LOADING_OVERLAY_CLASS}>
                                                    <span className="loading loading-spinner loading-md text-slate-400 dark:text-slate-500" />
                                                </div>
                                            )}
                                            {!isTerminalServiceReady ? (
                                                <div className="flex h-full items-center justify-center px-6 text-center text-xs text-slate-500 dark:text-slate-400">
                                                    {isTerminalServiceStarting
                                                        ? 'Starting terminal service...'
                                                        : 'Open this panel to start the auxiliary terminal.'}
                                                </div>
                                            ) : (
                                                renderedTerminalTabIds.map((tabId) => {
                                                    const isActiveTab = tabId === activeTerminalTabId;
                                                    const isTabThemeReady = Boolean(floatingTerminalThemeReadyByTab[tabId]);
                                                    const tabSrc = terminalTabSources[tabId] || floatingTerminalSrc;
                                                    const bootstrapSlot = getFloatingTerminalBootstrapSlot(tabId);
                                                    return (
                                                        <iframe
                                                            key={tabId}
                                                            ref={(node) => {
                                                                if (node) {
                                                                    terminalFramesRef.current[tabId] = node;
                                                                } else {
                                                                    cleanupTerminalLinkHandler(bootstrapSlot);
                                                                    cleanupBeforeUnloadGuard(bootstrapSlot);
                                                                    cleanupTerminalAutoScroll(bootstrapSlot);
                                                                    delete terminalFramesRef.current[tabId];
                                                                }
                                                            }}
                                                            src={tabSrc}
                                                            className={`absolute inset-0 h-full w-full border-none transition-opacity duration-200 ${isActiveTab
                                                                ? (isTabThemeReady ? 'opacity-100' : 'opacity-0 pointer-events-none')
                                                                : 'opacity-0 pointer-events-none'} ${(isResizing || isSplitResizing) ? 'pointer-events-none' : ''}`}
                                                            allow="clipboard-read; clipboard-write"
                                                            onFocus={() => {
                                                                recentTerminalBlurRef.current = null;
                                                            }}
                                                            onBlur={() => {
                                                                recentTerminalBlurRef.current = {
                                                                    slot: getFloatingTerminalBootstrapSlot(tabId),
                                                                    at: Date.now(),
                                                                };
                                                            }}
                                                            onLoad={(event) => handleTerminalLoad(event.currentTarget, tabId)}
                                                        />
                                                    );
                                                })
                                            )}
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
