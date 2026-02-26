'use client';

import React, { useRef, useState, useEffect, useCallback, useMemo } from 'react';
// import { useRouter } from 'next/navigation';
import {
    deleteSessionInBackground,
    getSessionDivergence,
    getSessionUncommittedFileCount,
    listSessionBaseBranches,
    mergeSessionToBase,
    rebaseSessionOntoBase,
    updateSessionBaseBranch,
    writeSessionPromptFile
} from '@/app/actions/session';
import { setTmuxSessionMouseMode, setTmuxSessionStatusVisibility } from '@/app/actions/git';
import { getConfig, updateConfig } from '@/app/actions/config';
import { Trash2, ExternalLink, Play, GitCommitHorizontal, GitMerge, GitPullRequestArrow, GitBranch, ArrowUp, ArrowDown, FolderOpen, ChevronLeft, Grip, ChevronDown, Plus, Globe, MousePointer2, ArrowLeft, ArrowRight, RotateCw } from 'lucide-react';
import SessionFileBrowser from './SessionFileBrowser';
import { getBaseName, isWindowsAbsolutePath } from '@/lib/path';
import { notifySessionsUpdated } from '@/lib/session-updates';
import { buildTtydTerminalSrc } from '@/lib/terminal-session';
import { normalizePreviewUrl } from '@/lib/url';
import { useTerminalLink, type TerminalWindow } from '@/hooks/useTerminalLink';
import { quoteShellArg } from '@/lib/shell';

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

const TERMINAL_SIZE_STORAGE_KEY = 'viba-terminal-size';
const SPLIT_RATIO_STORAGE_KEY = 'viba-agent-preview-split-ratio';
const DEFAULT_AGENT_PANE_RATIO = 0.5;
const TERMINAL_HEADER_HEIGHT = 40;
const TERMINAL_PANEL_RIGHT_GAP = 16;
const TERMINAL_MINIMIZED_VISIBLE_WIDTH = 40;
const TRIDENT_WORKSPACE_URL = 'http://localhost:3100/workspace';
const TERMINAL_BOOTSTRAP_STORAGE_PREFIX = 'viba:terminal-bootstrap:';
const TERMINAL_BOOTSTRAP_RUNTIME_KEY = '__vibaTerminalBootstrapRegistry';
const SHELL_PROMPT_PATTERN = /(?:\$|%|#|>) $/;
const PLAN_MODE_STARTUP_INSTRUCTION =
    'Plan mode: inspect the relevant code first, present a concrete implementation plan, and wait for explicit user approval before any file edits or write commands.';
const AUTO_COMMIT_INSTRUCTION =
    'After each round, if work is complete and files changed, commit all changes without confirmation. Use a commit message with a clear title and a detailed body explaining what changed and why. If GITHUB_TOKEN or GITLAB_TOKEN is set, push the current branch after committed rounds and create (or update) a pull/merge request with an appropriate title and description; include the pull/merge request link in the first push reply.';
const AGENT_BROWSER_SKILL_INSTRUCTION =
    'For visual web tasks, use the `agent-browser` skill (https://skills.sh/vercel-labs/agent-browser/agent-browser) when your coding agent CLI supports skills.';
const VISUAL_EVIDENCE_INSTRUCTION =
    'When working on a visual-related feature or bugfix in a web project, after coding is complete, use `agent-browser` or equivalent Chrome MCP tooling to load the relevant page, take screenshot(s), and include them as evidence in the pull/merge request.';

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
    model?: string;
    startupScript?: string;
    devServerScript?: string;
    initialMessage?: string;
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
    model,
    startupScript,
    devServerScript,
    initialMessage,
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
    const previewIframeRef = useRef<HTMLIFrameElement>(null);
    const previewAddressInputRef = useRef<HTMLInputElement>(null);
    const splitContainerRef = useRef<HTMLDivElement>(null);
    const splitResizeRef = useRef({ startX: 0, startRatio: DEFAULT_AGENT_PANE_RATIO });
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

            const iframe = terminalRef.current;
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
    const [isRequestingCommit, setIsRequestingCommit] = useState(false);
    const [isMerging, setIsMerging] = useState(false);
    const [isRebasing, setIsRebasing] = useState(false);
    const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false);
    const [lastFileBrowserPath, setLastFileBrowserPath] = useState(worktree || repo);
    const [isInsertingFilePaths, setIsInsertingFilePaths] = useState(false);
    const [currentBaseBranch, setCurrentBaseBranch] = useState(baseBranch?.trim() || '');
    const [baseBranchOptions, setBaseBranchOptions] = useState<string[]>([]);
    const [isLoadingBaseBranches, setIsLoadingBaseBranches] = useState(false);
    const isLoadingBaseBranchesRef = useRef(false);
    const [isUpdatingBaseBranch, setIsUpdatingBaseBranch] = useState(false);
    const [divergence, setDivergence] = useState({ ahead: 0, behind: 0 });
    const [uncommittedFileCount, setUncommittedFileCount] = useState(0);
    const [isPreviewVisible, setIsPreviewVisible] = useState(false);
    const [previewInputUrl, setPreviewInputUrl] = useState('');
    const [previewUrl, setPreviewUrl] = useState('');
    const [isPreviewPickerActive, setIsPreviewPickerActive] = useState(false);
    const [isResolvingElement, setIsResolvingElement] = useState(false);
    const [agentPaneRatio, setAgentPaneRatio] = useState(DEFAULT_AGENT_PANE_RATIO);
    const [isSplitResizing, setIsSplitResizing] = useState(false);

    const [isTerminalMinimized, setIsTerminalMinimized] = useState(true);

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

    const startSplitResize = (e: React.MouseEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsSplitResizing(true);
        splitResizeRef.current = {
            startX: e.clientX,
            startRatio: agentPaneRatio,
        };
    };

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
            document.title = `${trimmedTitle} | Viba`;
            return () => {
                document.title = 'Viba';
            };
        }

        document.title = 'Viba';
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

    const handleShowDiffWithTrident = () => {
        if (!worktree || !branch) return;

        const params = new URLSearchParams({
            path: worktree,
            branch,
        });
        window.open(`${TRIDENT_WORKSPACE_URL}?${params.toString()}`, '_blank', 'noopener,noreferrer');
    };

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

    const sendPromptToAgentIframe = useCallback((prompt: string, action: string): Promise<boolean> => {
        return new Promise((resolve) => {
            const iframe = iframeRef.current;
            if (!iframe) {
                resolve(false);
                return;
            }

            const checkAndSend = (attempts = 0) => {
                if (attempts > 30) {
                    resolve(false);
                    return;
                }

                try {
                    const win = iframe.contentWindow as TerminalWindow | null;
                    if (!win) {
                        setTimeout(() => checkAndSend(attempts + 1), 300);
                        return;
                    }

                    win.postMessage(
                        {
                            type: 'viba:agent-request',
                            action,
                            prompt,
                            sessionName,
                            branch,
                            baseBranch: currentBaseBranch || undefined,
                            timestamp: Date.now(),
                        },
                        '*'
                    );

                    if (!win.term) {
                        setTimeout(() => checkAndSend(attempts + 1), 300);
                        return;
                    }

                    win.term.paste(prompt);

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
                        (textarea as HTMLElement).focus();
                    } else {
                        win.term.paste('\r');
                    }

                    win.focus();
                    resolve(true);
                } catch (e) {
                    console.error('Failed to send prompt to agent iframe:', e);
                    setTimeout(() => checkAndSend(attempts + 1), 300);
                }
            };

            checkAndSend();
        });
    }, [branch, currentBaseBranch, sessionName]);

    const handleCommit = async () => {
        setIsRequestingCommit(true);
        setFeedback('Requesting commit from agent...');

        const prompt = 'Please create a git commit with the current changes in this worktree.';
        const sent = await sendPromptToAgentIframe(prompt, 'commit');

        setFeedback(sent ? 'Commit request sent to agent' : 'Failed to send commit request to agent');
        setIsRequestingCommit(false);
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

    const loadUncommittedFileCount = useCallback(async () => {
        if (!sessionName) return;

        try {
            const result = await getSessionUncommittedFileCount(sessionName);
            if (result.success && typeof result.count === 'number') {
                setUncommittedFileCount(result.count);
            }
        } catch (e) {
            console.error('Failed to load uncommitted file count:', e);
        }
    }, [sessionName]);

    useEffect(() => {
        if (!sessionName) return;

        void loadUncommittedFileCount();
        const timer = window.setInterval(() => {
            void loadUncommittedFileCount();
        }, 10000);

        return () => window.clearInterval(timer);
    }, [loadUncommittedFileCount, sessionName]);

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

                    // Set selection highlight color via xterm.js 5 theme API (canvas renderer)
                    try {
                        term.options.theme = {
                            ...(term.options.theme || {}),
                            selectionBackground: 'rgba(59, 130, 246, 0.4)',
                        };
                    } catch { /* ignore if API unavailable */ }

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

                            if (isResume) {
                                // Resume logic (keep startup runtime flags but do not override model)
                                if (agent.toLowerCase().includes('gemini')) {
                                    agentCmd = `gemini --resume latest --yolo`;
                                } else if (agent.toLowerCase().includes('codex')) {
                                    agentCmd = `codex resume --last --sandbox danger-full-access --ask-for-approval on-request --search`;
                                } else if (agent.toLowerCase() === 'agent' || agent.toLowerCase().includes('cursor')) {
                                    agentCmd = `agent resume`;
                                } else {
                                    // Generic fallback: <agent> resume
                                    agentCmd = `${quoteShellArg(agent)} resume`;
                                }
                            } else {
                                const safeTitle = title?.trim() || '';
                                const trimmedInitialMessage = initialMessage?.trim() || '';
                                const taskParts: string[] = [];
                                if (safeTitle) taskParts.push(safeTitle);
                                if (trimmedInitialMessage) taskParts.push(trimmedInitialMessage);
                                const taskContent = taskParts.join('\n\n');
                                const attachmentPaths = (attachmentNames || [])
                                    .map((name) => name.trim())
                                    .filter(Boolean)
                                    .map((name) => `${worktree || repo}-attachments/${name}`);
                                const taskSections: string[] = [];
                                if (taskContent) taskSections.push(taskContent);
                                if (attachmentPaths.length > 0) {
                                    taskSections.push([
                                        'Attachments:',
                                        ...attachmentPaths.map((attachmentPath) => `- ${attachmentPath}`),
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
                                    instructionLines.push(VISUAL_EVIDENCE_INSTRUCTION);

                                    const fullMessage = [
                                        '# Instructions',
                                        '',
                                        instructionLines.join('\n'),
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

                                const modelArg = (model && model.toLowerCase() !== 'auto') ? ` --model ${quoteShellArg(model)}` : '';

                                if (agent.toLowerCase().includes('codex')) {
                                    // Codex: codex --model gpt-5.3-codex --sandbox danger-full-access --ask-for-approval on-request --search
                                    agentCmd = `codex${modelArg} --sandbox danger-full-access --ask-for-approval on-request --search${safeMessage}`;
                                } else if (agent.toLowerCase().includes('gemini')) {
                                    // Gemini: gemini --model gemini-3-pro-preview --yolo
                                    agentCmd = `gemini${modelArg} --yolo${safeMessage}`;
                                } else if (agent.toLowerCase() === 'agent' || agent.toLowerCase().includes('cursor')) {
                                    // Cursor: agent --model opus-4.6-thinking
                                    agentCmd = `agent${modelArg}${safeMessage}`;
                                } else {
                                    // Generic fallback: <agent> --model <model>
                                    agentCmd = `${quoteShellArg(agent)}${modelArg}${safeMessage}`;
                                }
                            }

                            if (agentCmd) {
                                term.paste(agentCmd);
                                pressEnter();
                                setFeedback(isResume ? `Resumed session with ${agent}` : `Session started with ${agent}`);

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

    const handleTerminalLoad = () => {
        if (!terminalRef.current) return;
        const iframe = terminalRef.current;
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

                    // Set selection highlight color via xterm.js 5 theme API (canvas renderer)
                    try {
                        term.options.theme = {
                            ...(term.options.theme || {}),
                            selectionBackground: 'rgba(59, 130, 246, 0.4)',
                        };
                    } catch { /* ignore if API unavailable */ }

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

    if (!repo) return <div className="p-4 text-error">No repository specified</div>;

    if (cleanupPhase === 'error') {
        return (
            <div className="flex h-screen w-full items-center justify-center bg-base-100">
                <div className="card w-96 bg-base-200 shadow-xl">
                    <div className="card-body items-center text-center">
                        <h2 className="card-title text-error">Cleanup failed</h2>
                        <p>{cleanupError || 'An unknown error occurred while cleaning up this session.'}</p>
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
    const terminalPanelRight = isTerminalMinimized
        ? `calc(${TERMINAL_MINIMIZED_VISIBLE_WIDTH}px - min(${terminalSize.width}px, calc(100vw - 2rem)))`
        : TERMINAL_PANEL_RIGHT_GAP;
    const hasDevServerScript = Boolean(devServerScript?.trim());
    const isDevButtonDisabled = !hasDevServerScript || isStartingDevServer || isTerminalForegroundProcessRunning;
    const devButtonTitle = !hasDevServerScript
        ? 'Set a dev server script to enable this button'
        : isTerminalForegroundProcessRunning
            ? 'A process is already running in the terminal'
            : 'Run dev server script in terminal';

    return (
        <div className={`flex flex-col h-screen w-full overflow-hidden bg-base-100 ${(isResizing || isSplitResizing) ? 'select-none' : ''}`}>
            {(isResizing || isSplitResizing) && (
                <div className={`fixed inset-0 z-[9999] ${isResizing ? 'cursor-nwse-resize' : 'cursor-col-resize'}`} />
            )}
            <div className="z-20 bg-base-300/95 p-2 text-xs flex justify-between px-4 font-mono select-none items-center shadow-md backdrop-blur-sm border-b border-base-content/10">
                <div className="flex items-center gap-4">
                    <button
                        className="btn btn-ghost btn-xs h-6 min-h-6 px-1 hover:bg-base-content/10"
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
                    <div className="flex items-center border border-base-content/20 rounded overflow-hidden">
                        <select
                            className="select select-xs h-6 min-h-6 bg-base-200 border-none focus:outline-none rounded-none pr-7"
                            value={selectedIde}
                            onChange={handleIdeChange}
                        >
                            {SUPPORTED_IDES.map(ide => (
                                <option key={ide.id} value={ide.id}>{ide.name}</option>
                            ))}
                        </select>
                        <div className="w-[1px] h-4 bg-base-content/20"></div>
                        <button
                            className="btn btn-ghost btn-xs rounded-none h-6 min-h-6 border-none hover:bg-base-content/10"
                            onClick={handleOpenIde}
                            title={`Open in ${SUPPORTED_IDES.find(i => i.id === selectedIde)?.name}`}
                        >
                            <ExternalLink className="w-3 h-3" />
                            <span className={headerButtonLabelClass}>Open</span>
                        </button>
                    </div>

                    <div className="flex items-center border border-base-content/20 rounded overflow-hidden bg-base-100">
                        <button
                            className="btn btn-ghost btn-xs rounded-none h-6 min-h-6 border-none px-2 hover:bg-base-content/10"
                            onClick={handleShowDiffWithTrident}
                            disabled={!worktree || !branch}
                            title="Open this worktree and branch in Trident"
                        >
                            <GitBranch className="w-3 h-3" />
                            <span className={headerButtonLabelClass}>Diff</span>
                        </button>
                        <div className="w-[1px] h-4 bg-base-content/10"></div>
                        <button
                            className="btn btn-ghost btn-xs rounded-none h-6 min-h-6 border-none px-2 hover:bg-base-content/10"
                            onClick={handleCommit}
                            disabled={isRequestingCommit}
                            title="Ask agent to create a commit with current changes"
                        >
                            {isRequestingCommit ? <span className="loading loading-spinner loading-xs"></span> : <GitCommitHorizontal className="w-3 h-3" />}
                            <span className={headerButtonLabelClass}>Commit ({uncommittedFileCount})</span>
                        </button>
                    </div>

                    <div className="flex items-center border border-base-content/20 rounded overflow-hidden bg-base-100">
                        <button
                            className="btn btn-ghost btn-xs rounded-none h-6 min-h-6 border-none px-2 hover:bg-base-content/10"
                            onClick={() => setIsFileBrowserOpen(true)}
                            disabled={isInsertingFilePaths}
                            title="Browse files and insert absolute paths into the agent input"
                        >
                            {isInsertingFilePaths ? <span className="loading loading-spinner loading-xs"></span> : <FolderOpen className="w-3 h-3" />}
                            <span className={headerButtonLabelClass}>Add Files</span>
                        </button>
                        <div className="w-[1px] h-4 bg-base-content/10"></div>
                        <button
                            className="btn btn-ghost btn-xs rounded-none h-6 min-h-6 border-none px-2 hover:bg-base-content/10"
                            onClick={handleNewAttempt}
                            title="Start a new attempt in a new tab with this session context"
                        >
                            <Plus className="w-3 h-3" />
                            <span className={headerButtonLabelClass}>New Attempt</span>
                        </button>
                    </div>

                    <div className="flex items-center border border-base-content/20 rounded overflow-hidden bg-base-100">
                        <button
                            className="btn btn-ghost btn-xs rounded-none h-6 min-h-6 border-none px-2 hover:bg-base-content/10"
                            onClick={handleStartDevServer}
                            disabled={isDevButtonDisabled}
                            title={devButtonTitle}
                        >
                            {isStartingDevServer ? <span className="loading loading-spinner loading-xs"></span> : <Play className="w-3 h-3" />}
                            <span className={headerButtonLabelClass}>Dev</span>
                        </button>
                        <div className="w-[1px] h-4 bg-base-content/10"></div>
                        <button
                            className="btn btn-ghost btn-xs rounded-none h-6 min-h-6 border-none px-2 hover:bg-base-content/10"
                            onClick={() => setIsPreviewVisible((previous) => !previous)}
                            title={isPreviewVisible ? 'Hide preview panel' : 'Show preview panel'}
                        >
                            <Globe className="w-3 h-3" />
                            <span className={headerButtonLabelClass}>{isPreviewVisible ? 'Close' : 'Preview'}</span>
                        </button>
                    </div>

                    <div className="flex items-center border border-base-content/20 rounded overflow-hidden bg-base-100">
                        <button
                            className={`btn btn-ghost btn-xs rounded-none h-6 min-h-6 border-none px-2 hover:bg-base-content/10 ${terminalInteractionMode === 'select' ? 'text-warning' : ''}`}
                            onClick={handleToggleTerminalInteractionMode}
                            disabled={terminalPersistenceMode !== 'tmux' || isUpdatingTerminalInteractionMode}
                            title={terminalPersistenceMode === 'tmux'
                                ? (terminalInteractionMode === 'scroll'
                                    ? 'Switch to text select mode for easier copy'
                                    : 'Switch to scroll mode for wheel scrollback')
                                : 'Mode toggle is available only in tmux persistence mode'}
                        >
                            {isUpdatingTerminalInteractionMode ? (
                                <span className="loading loading-spinner loading-xs"></span>
                            ) : (
                                <MousePointer2 className="w-3 h-3" />
                            )}
                            <span>{terminalInteractionMode === 'scroll' ? 'Scroll Mode' : 'Text Select'}</span>
                        </button>
                    </div>



                    <div className="flex items-center border border-base-content/20 rounded relative bg-base-100" ref={rebaseDropdownRef}>
                        <div className="relative">
                            <button
                                className="btn btn-ghost btn-xs rounded-none rounded-l h-6 min-h-6 border-none px-2 hover:bg-base-content/10"
                                onClick={handleRebase}
                                disabled={isRebasing || isMerging || isUpdatingBaseBranch}
                                title="Select base branch and rebase"
                            >
                                {isRebasing ? <span className="loading loading-spinner loading-xs"></span> : <GitPullRequestArrow className="w-3 h-3" />}
                                <span className={headerButtonLabelClass}>Rebase</span>
                                <ChevronDown className="w-3 h-3 opacity-50 ml-0.5" />
                            </button>
                            {isRebaseDropdownOpen && (
                                <div className="absolute top-full left-0 z-50 mt-1 w-64 p-0 shadow-xl dropdown-content bg-base-200 rounded-box border border-base-content/20 flex flex-col max-h-80 overflow-hidden">
                                    <div className="px-4 py-2 text-[10px] uppercase font-bold tracking-wider opacity-50 border-b border-base-content/10 bg-base-200 flex justify-between items-center shrink-0">
                                        <span>Select Base Branch</span>
                                        {(isLoadingBaseBranches || isUpdatingBaseBranch) && <span className="loading loading-spinner loading-xs"></span>}
                                    </div>
                                    <ul className="menu p-0 overflow-y-auto flex-nowrap custom-scrollbar overflow-x-hidden w-full">
                                        {selectableBaseBranches.length > 0 ? (
                                            selectableBaseBranches.map((branchOption) => (
                                                <li key={branchOption}>
                                                    <button
                                                        onClick={() => handleRebaseSelect(branchOption)}
                                                        className={`flex justify-between items-center text-xs py-2 truncate max-w-full rounded-none ${branchOption === currentBaseBranch ? 'active font-bold' : ''}`}
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
                                        <div className="divider my-1 opacity-50"></div>
                                        <li>
                                            <button onClick={() => void loadBaseBranchOptions()} className="text-[10px] justify-center opacity-70 hover:opacity-100">
                                                Refresh Branches
                                            </button>
                                        </li>
                                    </ul>
                                </div>
                            )}
                        </div>
                        <div className="w-[1px] h-4 bg-base-content/10"></div>
                        <button
                            className="btn btn-ghost btn-xs btn-success rounded-none h-6 min-h-6 border-none px-2 hover:bg-success/20 hover:border-transparent"
                            onClick={handleMerge}
                            disabled={isMerging || isRebasing || isUpdatingBaseBranch || !currentBaseBranch}
                            title={currentBaseBranch ? `Merge current branch (${branch}) into target branch (${currentBaseBranch})` : 'Target branch unavailable for this session'}
                        >
                            {isMerging ? <span className="loading loading-spinner loading-xs"></span> : <GitMerge className="w-3 h-3" />}
                            <span className={headerButtonLabelClass}>Merge</span>
                        </button>
                        <div className="w-[1px] h-4 bg-base-content/10"></div>
                        <button
                            className="btn btn-ghost btn-error btn-xs rounded-none rounded-r h-6 min-h-6 border-none px-2 hover:bg-error/20 hover:border-transparent"
                            onClick={handleCleanup}
                            disabled={isMerging || isRebasing || !worktree}
                            title="Clean up and exit"
                        >
                            <Trash2 className="w-3 h-3" />
                            <span className={headerButtonLabelClass}>Purge</span>
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

                    <div className="hidden min-[1200px]:block w-[1px] h-4 bg-base-content/20 mx-2"></div>

                    <div className="hidden min-[1200px]:flex min-w-0 max-w-[280px] items-center gap-2">
                        <span className={`w-2 h-2 rounded-full ${feedback.includes('Error') || feedback.includes('failed') ? 'bg-error' : feedback.includes('started') || feedback.includes('Merged') || feedback.includes('Rebased') || feedback.includes('sent') ? 'bg-success' : 'bg-warning'}`}></span>
                        <span className="truncate" title={feedback}>{feedback}</span>
                    </div>

                </div>
            </div>

            <div ref={splitContainerRef} className="flex min-h-0 flex-1 w-full">
                <div
                    className="h-full min-w-0"
                    style={{ width: isPreviewVisible ? `${agentPaneRatio * 100}%` : '100%' }}
                >
                    <iframe
                        ref={iframeRef}
                        src={agentTerminalSrc}
                        className={`h-full w-full border-none dark:invert dark:brightness-90 ${(isResizing || isSplitResizing) ? 'pointer-events-none' : ''}`}
                        allow="clipboard-read; clipboard-write"
                        onLoad={handleIframeLoad}
                    />
                </div>

                {isPreviewVisible && (
                    <>
                        <div
                            className="relative h-full w-2 shrink-0 cursor-col-resize bg-base-300/40 hover:bg-base-content/20"
                            onMouseDown={startSplitResize}
                            role="separator"
                            aria-orientation="vertical"
                            aria-label="Resize preview panel"
                            title="Drag to resize preview panel"
                        >
                            <div className="absolute left-1/2 top-1/2 h-12 w-[2px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-base-content/30" />
                        </div>
                        <div className="flex h-full min-w-0 flex-1 flex-col border-l border-base-content/10 bg-base-200/50">
                            <form
                                className="flex items-center gap-2 border-b border-base-content/10 bg-base-200 px-3 py-2"
                                onSubmit={handlePreviewSubmit}
                            >
                                <button
                                    className="btn btn-ghost btn-xs h-7 min-h-7 w-7 p-0"
                                    type="button"
                                    onClick={() => handlePreviewNavigate('back')}
                                    disabled={!previewUrl}
                                    title="Go back"
                                    aria-label="Go back"
                                >
                                    <ArrowLeft className="h-3.5 w-3.5" />
                                </button>
                                <button
                                    className="btn btn-ghost btn-xs h-7 min-h-7 w-7 p-0"
                                    type="button"
                                    onClick={() => handlePreviewNavigate('forward')}
                                    disabled={!previewUrl}
                                    title="Go forward"
                                    aria-label="Go forward"
                                >
                                    <ArrowRight className="h-3.5 w-3.5" />
                                </button>
                                <button
                                    className="btn btn-ghost btn-xs h-7 min-h-7 w-7 p-0"
                                    type="button"
                                    onClick={() => handlePreviewNavigate('reload')}
                                    disabled={!previewUrl}
                                    title="Reload preview"
                                    aria-label="Reload preview"
                                >
                                    <RotateCw className="h-3.5 w-3.5" />
                                </button>
                                <input
                                    ref={previewAddressInputRef}
                                    type="text"
                                    className="input input-xs input-bordered w-full font-mono"
                                    value={previewInputUrl}
                                    onChange={(event) => setPreviewInputUrl(event.target.value)}
                                    placeholder="http://127.0.0.1:3000"
                                    spellCheck={false}
                                />
                                <button
                                    className={`btn btn-ghost btn-xs ${isPreviewPickerActive ? 'btn-active text-success' : ''}`}
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
                                <button className="btn btn-xs" type="submit">
                                    Go
                                </button>
                            </form>
                            <div className="min-h-0 flex-1">
                                {previewUrl ? (
                                    <iframe
                                        ref={previewIframeRef}
                                        src={previewUrl}
                                        className={`h-full w-full border-none ${(isResizing || isSplitResizing) ? 'pointer-events-none' : ''}`}
                                        title="Dev server preview"
                                        onLoad={handlePreviewIframeLoad}
                                        sandbox="allow-forms allow-modals allow-pointer-lock allow-popups allow-same-origin allow-scripts allow-downloads"
                                    />
                                ) : (
                                    <div className="flex h-full items-center justify-center px-6 text-center text-xs opacity-70">
                                        Run the dev server, or enter a URL above to load a preview.
                                    </div>
                                )}
                            </div>
                        </div>
                    </>
                )}
            </div>

            {/* floating terminal panel */}
            <div
                className={`absolute z-30 overflow-hidden rounded-lg border border-base-content/20 bg-base-200/95 shadow-2xl backdrop-blur-sm ${(isResizing || isSplitResizing) ? '' : 'transition-all'}`}
                style={{
                    bottom: 80,
                    right: terminalPanelRight,
                    width: terminalSize.width,
                    height: isTerminalMinimized ? TERMINAL_HEADER_HEIGHT : terminalSize.height,
                    maxWidth: 'calc(100vw - 2rem)',
                    maxHeight: 'calc(100vh - 2rem)'
                }}
            >
                <button
                    className={`absolute left-0 top-0 z-50 flex h-10 w-10 items-center justify-center text-base-content/30 hover:text-base-content/60 ${isTerminalMinimized ? 'cursor-pointer' : 'cursor-nwse-resize'}`}
                    onMouseDown={!isTerminalMinimized ? startResize : undefined}
                    onClick={isTerminalMinimized ? () => setIsTerminalMinimized(false) : undefined}
                    title={isTerminalMinimized ? 'Expand terminal' : "Drag to resize"}
                    type="button"
                >
                    <Grip size={14} />
                </button>
                {!isTerminalMinimized && (
                    <button
                        className="flex h-10 w-full items-center justify-between px-3 pl-10 text-xs font-mono hover:bg-base-content/10"
                        onClick={() => setIsTerminalMinimized((prev) => !prev)}
                        title="Minimize terminal"
                        type="button"
                    >
                        <span>Terminal</span>
                        <span className="opacity-70">Hide</span>
                    </button>
                )}
                <div className={isTerminalMinimized ? 'h-0 overflow-hidden' : 'h-[calc(100%-2.5rem)]'}>
                    <iframe
                        ref={terminalRef}
                        src={floatingTerminalSrc}
                        className={`h-full w-full border-none dark:invert dark:brightness-90 ${(isResizing || isSplitResizing) ? 'pointer-events-none' : ''}`}
                        allow="clipboard-read; clipboard-write"
                        onLoad={handleTerminalLoad}
                    />
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
