'use client';

import React, { useRef, useState, useEffect, useCallback } from 'react';
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
import { getConfig, updateConfig } from '@/app/actions/config';
import { Trash2, ExternalLink, Play, GitCommitHorizontal, GitMerge, GitPullRequestArrow, ArrowUp, ArrowDown, FolderOpen, ChevronLeft, Grip, ChevronDown, Plus, Globe, MousePointer2, ArrowLeft, ArrowRight, RotateCw } from 'lucide-react';
import SessionFileBrowser from './SessionFileBrowser';
import { getBaseName } from '@/lib/path';
import { notifySessionsUpdated } from '@/lib/session-updates';

const SUPPORTED_IDES = [
    { id: 'vscode', name: 'VS Code', protocol: 'vscode' },
    { id: 'cursor', name: 'Cursor', protocol: 'cursor' },
    { id: 'windsurf', name: 'Windsurf', protocol: 'windsurf' },
    { id: 'antigravity', name: 'Antigravity', protocol: 'antigravity' },
];

type TerminalWindow = Window & {
    term?: {
        paste: (text: string) => void;
        options: {
            linkHandler?: TerminalLinkHandler | null;
            theme?: Record<string, string>;
            [key: string]: unknown;
        };
        _core?: {
            _linkProviderService?: {
                linkProviders?: Map<number, TerminalLinkProvider>;
            };
        };
    };
};

type CleanupPhase = 'idle' | 'error';
type TerminalLinkProvider = {
    _handler?: (event: MouseEvent | undefined, url: string) => void;
    provideLinks?: (line: number, callback: (links: TerminalLink[] | undefined) => void) => void;
};

type TerminalLink = {
    text: string;
    activate?: (event: MouseEvent | undefined, text: string) => void;
    [key: string]: unknown;
};

type TerminalLinkHandler = {
    allowNonHttpProtocols?: boolean;
    activate?: (event: MouseEvent | undefined, url: string, range?: unknown) => void;
    hover?: (event: MouseEvent | undefined, url: string, range?: unknown) => void;
    leave?: (event: MouseEvent | undefined, url: string, range?: unknown) => void;
};

type TerminalLinkHandlerOptions = {
    onLinkActivated?: () => void;
};

type PreviewNavigationAction = 'back' | 'forward' | 'reload';

const quoteShellArg = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const TERMINAL_SIZE_STORAGE_KEY = 'viba-terminal-size';
const SPLIT_RATIO_STORAGE_KEY = 'viba-agent-preview-split-ratio';
const DEFAULT_AGENT_PANE_RATIO = 0.5;
const TERMINAL_HEADER_HEIGHT = 40;
const TERMINAL_PANEL_RIGHT_GAP = 16;
const TERMINAL_MINIMIZED_VISIBLE_WIDTH = 40;

const clampAgentPaneRatio = (value: number): number => Math.max(0.2, Math.min(0.8, value));

const normalizePreviewUrl = (rawValue: string): string | null => {
    const trimmed = rawValue.trim();
    if (!trimmed) return null;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
    return `http://${trimmed}`;
};

type PreviewComponentStackEntry = {
    name?: unknown;
    source?: {
        fileName?: unknown;
    } | null;
};

type ResolveComponentSourceResponse = {
    sourcePath?: string;
    error?: string;
};

const isWindowsAbsolutePath = (value: string): boolean => /^[a-zA-Z]:[\\/]/.test(value);

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
    rawInitialMessage?: string;
    title?: string;
    attachmentNames?: string[];
    onExit: (force?: boolean) => void;
    isResume?: boolean;
    onSessionStart?: () => void;
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
    rawInitialMessage,
    title,
    attachmentNames,
    onExit,
    isResume,
    onSessionStart
}: SessionViewProps) {
    const headerButtonLabelClass = 'hidden min-[1600px]:inline';

    const iframeRef = useRef<HTMLIFrameElement>(null);
    const terminalRef = useRef<HTMLIFrameElement>(null);
    const previewIframeRef = useRef<HTMLIFrameElement>(null);
    const previewAddressInputRef = useRef<HTMLInputElement>(null);
    const splitContainerRef = useRef<HTMLDivElement>(null);
    const splitResizeRef = useRef({ startX: 0, startRatio: DEFAULT_AGENT_PANE_RATIO });
    const agentFrameLinkCleanupRef = useRef<(() => void) | null>(null);
    const terminalFrameLinkCleanupRef = useRef<(() => void) | null>(null);

    const [feedback, setFeedback] = useState<string>('Initializing...');
    const [cleanupPhase, setCleanupPhase] = useState<CleanupPhase>('idle');
    const [cleanupError, setCleanupError] = useState<string | null>(null);
    const [isStartingDevServer, setIsStartingDevServer] = useState(false);
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
    const [agentPaneRatio, setAgentPaneRatio] = useState(DEFAULT_AGENT_PANE_RATIO);
    const [isSplitResizing, setIsSplitResizing] = useState(false);

    const [isTerminalMinimized, setIsTerminalMinimized] = useState(true);

    // Terminal resize state
    const [terminalSize, setTerminalSize] = useState({ width: 460, height: 320 });
    const [isResizing, setIsResizing] = useState(false);
    const [isLoaded, setIsLoaded] = useState(false);
    const resizeRef = useRef({ startX: 0, startY: 0, startWidth: 0, startHeight: 0 });

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
                    const win = iframe.contentWindow as any;
                    if (win && win.term) {
                        win.term.scrollToBottom();
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
        setFeedback('Purging session in background...');

        const purgePromise = deleteSessionInBackground(sessionName)
            .then((result) => {
                if (!result.success) {
                    console.error('Background cleanup failed:', result.error || 'Unknown error');
                    return;
                }

                notifySessionsUpdated();
            })
            .catch((error) => {
                console.error('Background cleanup request failed:', error);
            });

        onExit();
        void purgePromise;
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

    const resolveComponentSourcePathByName = useCallback(async (componentName: string): Promise<string | null> => {
        const normalizedName = normalizeComponentLookupName(componentName);
        if (!normalizedName) return null;

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
                        componentName: normalizedName,
                        workspaceRoot,
                    }),
                });

                const payload = await response.json().catch(() => null) as ResolveComponentSourceResponse | null;
                if (!response.ok) {
                    console.warn('Component source resolve miss', {
                        componentName: normalizedName,
                        workspaceRoot,
                        error: payload?.error || response.statusText,
                    });
                    continue;
                }

                const sourcePath = typeof payload?.sourcePath === 'string' ? payload.sourcePath.trim() : '';
                if (sourcePath) return sourcePath;
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

    const runMerge = async (requireConfirmation = true): Promise<boolean> => {
        if (!sessionName) return false;
        if (!currentBaseBranch) return false;
        if (requireConfirmation && !confirm(`Merge ${branch} into ${currentBaseBranch}?`)) return false;

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
        await runMerge(true);
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

        // Ask for confirmation
        if (!confirm(`Rebase ${branch} onto ${targetBranch}?`)) return;

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

    const handleMergeAndPurge = async () => {
        if (!worktree) return;
        if (!currentBaseBranch) return;
        if (!confirm(`Merge ${branch} into ${currentBaseBranch}, then clean up and exit?`)) return;

        const merged = await runMerge(false);
        if (!merged) return;

        await runCleanup(false);
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

    const handleTerminalLinkOpen = useCallback((rawUrl: string, openInNewTab: boolean): boolean => {
        const normalized = normalizePreviewUrl(rawUrl);
        if (!normalized) return false;

        if (openInNewTab) {
            window.open(normalized, '_blank', 'noopener,noreferrer');
            return true;
        }

        void loadPreviewViaProxy(normalized, true);
        return true;
    }, [loadPreviewViaProxy]);

    const attachTerminalLinkHandler = useCallback((
        iframe: HTMLIFrameElement,
        cleanupRef: React.MutableRefObject<(() => void) | null>,
        options?: TerminalLinkHandlerOptions
    ) => {
        cleanupRef.current?.();
        const frameWindow = iframe.contentWindow as TerminalWindow | null;
        const terminal = frameWindow?.term;
        if (!frameWindow || !terminal) return;
        const notifyLinkActivated = options?.onLinkActivated;

        const restorers: Array<() => void> = [];

        const frameDocument = iframe.contentDocument;
        let lastModifierState = {
            metaKey: false,
            ctrlKey: false,
            at: 0,
        };

        if (frameDocument) {
            const recordModifierState = (event: MouseEvent) => {
                lastModifierState = {
                    metaKey: event.metaKey,
                    ctrlKey: event.ctrlKey,
                    at: Date.now(),
                };
            };

            frameDocument.addEventListener('mousedown', recordModifierState, true);
            frameDocument.addEventListener('click', recordModifierState, true);
            restorers.push(() => {
                frameDocument.removeEventListener('mousedown', recordModifierState, true);
                frameDocument.removeEventListener('click', recordModifierState, true);
            });
        }

        const originalOpen = frameWindow.open.bind(frameWindow);
        const patchedOpen: Window['open'] = (...args) => {
            const openWithModifier = Date.now() - lastModifierState.at < 1000;
            const shouldOpenInNewTab = openWithModifier && (lastModifierState.metaKey || lastModifierState.ctrlKey);

            if (typeof args[0] === 'string' && args[0].trim()) {
                notifyLinkActivated?.();
                const handled = handleTerminalLinkOpen(args[0], shouldOpenInNewTab);
                if (handled) {
                    return null;
                }
                return originalOpen(...args);
            }

            if (args.length === 0) {
                let fallbackWindow: Window | null = null;
                const syntheticWindow = {
                    opener: null,
                    location: {
                        set href(url: string) {
                            notifyLinkActivated?.();
                            const handled = handleTerminalLinkOpen(url, shouldOpenInNewTab);

                            if (!handled) {
                                fallbackWindow = originalOpen();
                                if (fallbackWindow) {
                                    try {
                                        fallbackWindow.opener = null;
                                    } catch {
                                        // Ignore opener assignment failures
                                    }
                                    fallbackWindow.location.href = url;
                                }
                            }
                        },
                        get href() {
                            return '';
                        },
                    },
                } as unknown as Window;

                return syntheticWindow;
            }

            return originalOpen(...args);
        };

        frameWindow.open = patchedOpen;
        restorers.push(() => {
            frameWindow.open = originalOpen;
        });

        const providers = terminal._core?._linkProviderService?.linkProviders;

        if (providers instanceof Map) {
            for (const provider of providers.values()) {
                if (!provider || typeof provider !== 'object') continue;

                if (typeof provider._handler === 'function') {
                    const originalHandler = provider._handler;
                    provider._handler = (event: MouseEvent | undefined, url: string) => {
                        notifyLinkActivated?.();
                        const shouldOpenInNewTab = Boolean(event?.metaKey || event?.ctrlKey);
                        const handled = handleTerminalLinkOpen(url, shouldOpenInNewTab);
                        if (!handled) {
                            originalHandler(event, url);
                        }
                    };

                    restorers.push(() => {
                        provider._handler = originalHandler;
                    });
                }

                if (typeof provider.provideLinks === 'function') {
                    const originalProvideLinks = provider.provideLinks.bind(provider);
                    provider.provideLinks = (line: number, callback: (links: TerminalLink[] | undefined) => void) => {
                        originalProvideLinks(line, (links: TerminalLink[] | undefined) => {
                            if (Array.isArray(links)) {
                                for (const link of links) {
                                    if (!link || typeof link !== 'object') continue;
                                    if (typeof link.activate !== 'function') continue;

                                    const originalActivate = link.activate.bind(link);
                                    link.activate = (event: MouseEvent | undefined, text: string) => {
                                        notifyLinkActivated?.();
                                        const shouldOpenInNewTab = Boolean(event?.metaKey || event?.ctrlKey);
                                        const handled = handleTerminalLinkOpen(text, shouldOpenInNewTab);
                                        if (!handled) {
                                            originalActivate(event, text);
                                        }
                                    };
                                }
                            }
                            callback(links);
                        });
                    };

                    restorers.push(() => {
                        provider.provideLinks = originalProvideLinks;
                    });
                }
            }
        }

        const existingLinkHandler = terminal.options.linkHandler;
        const nextLinkHandler: TerminalLinkHandler = {
            allowNonHttpProtocols: existingLinkHandler?.allowNonHttpProtocols ?? false,
            activate: (event, url, range) => {
                notifyLinkActivated?.();
                const shouldOpenInNewTab = Boolean(event?.metaKey || event?.ctrlKey);
                const handled = handleTerminalLinkOpen(url, shouldOpenInNewTab);
                if (!handled) {
                    existingLinkHandler?.activate?.(event, url, range);
                }
            },
            hover: (event, url, range) => {
                existingLinkHandler?.hover?.(event, url, range);
            },
            leave: (event, url, range) => {
                existingLinkHandler?.leave?.(event, url, range);
            },
        };

        terminal.options.linkHandler = nextLinkHandler;
        restorers.push(() => {
            terminal.options.linkHandler = existingLinkHandler ?? null;
        });

        cleanupRef.current = () => {
            for (const restore of restorers) {
                restore();
            }
            cleanupRef.current = null;
        };
    }, [handleTerminalLinkOpen]);

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
                const stackComponentNames = Array.from(
                    new Set(
                        reactStack
                            .map((entry) => {
                                if (!entry || typeof entry !== 'object') return '';
                                const name = (entry as { name?: unknown }).name;
                                return typeof name === 'string' ? name.trim() : '';
                            })
                            .filter(Boolean)
                    )
                );
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

                    // Fallback: when React stack has no source metadata, resolve the file path by component name(s).
                    if (!finalIdentifier && stackComponentNames.length > 0) {
                        for (const componentName of stackComponentNames) {
                            const resolvedPath = await resolveComponentSourcePathByName(componentName);
                            if (resolvedPath) {
                                finalIdentifier = `${componentName} (${resolvedPath})`;
                                break;
                            }
                        }
                    }

                    if (!finalIdentifier) {
                        if (stackComponentNames.length > 0) {
                            setFeedback('Element selected, but source file path could not be resolved for the component');
                            return;
                        }
                        finalIdentifier = identifier;
                    }

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
    }, [pasteIntoAgentIframe, repo, resolveComponentSourcePathByName, worktree]);

    useEffect(() => {
        setIsPreviewPickerActive(false);
    }, [previewUrl]);

    const handlePreviewSubmit = (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void loadPreviewViaProxy(previewInputUrl, true);
    };

    const handleStartDevServer = () => {
        const script = devServerScript?.trim();
        if (!script || !terminalRef.current) return;

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
                    const term = win.term;
                    attachTerminalLinkHandler(iframe, agentFrameLinkCleanupRef);

                    // Set selection highlight color via xterm.js 5 theme API (canvas renderer)
                    try {
                        term.options.theme = {
                            ...(term.options.theme || {}),
                            selectionBackground: 'rgba(59, 130, 246, 0.4)',
                        };
                    } catch { /* ignore if API unavailable */ }

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
                                const parts = [];
                                if (safeTitle) parts.push(safeTitle);
                                if (initialMessage) parts.push(initialMessage);
                                let fullMessage = parts.join('\n\n');
                                if (attachmentNames && attachmentNames.length > 0) {
                                    const attachmentBasePath = `${worktree || repo}-attachments`;
                                    const attachmentSection = [
                                        'Attachments:',
                                        ...attachmentNames.map(name => `- ${attachmentBasePath}/${name}`)
                                    ].join('\n');
                                    fullMessage = fullMessage ? `${fullMessage}\n\n${attachmentSection}` : attachmentSection;
                                }
                                
                                let safeMessage = '';
                                if (fullMessage) {
                                    if ((rawInitialMessage && rawInitialMessage.trim().length > 0) || (attachmentNames && attachmentNames.length > 0)) {
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
                                    } else {
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
                    const term = win.term;
                    attachTerminalLinkHandler(iframe, terminalFrameLinkCleanupRef, {
                        onLinkActivated: () => setIsTerminalMinimized(true),
                    });

                    // Set selection highlight color via xterm.js 5 theme API (canvas renderer)
                    try {
                        term.options.theme = {
                            ...(term.options.theme || {}),
                            selectionBackground: 'rgba(59, 130, 246, 0.4)',
                        };
                    } catch { /* ignore if API unavailable */ }

                    // Enable auto-scroll to bottom on output
                    try {
                        const xterm = term as any;
                        const scrollHandler = () => {
                            // Only scroll if we are close to the bottom to allow reviewing history
                            if (xterm.buffer?.active && (xterm.buffer.active.baseY - xterm.buffer.active.viewportY < 10)) {
                                xterm.scrollToBottom();
                            } else {
                                // Fallback if buffer access fails or simple mode
                                xterm.scrollToBottom();
                            }
                        };

                        if (xterm.onWriteParsed) {
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

                    // Check for startup script
                    if (startupScript && !isResume) {
                        setTimeout(() => {
                            term.paste(startupScript);
                            pressEnter();
                        }, 500);
                    }

                    // Focus
                    win.focus();
                    const textarea = iframe.contentDocument?.querySelector("textarea.xterm-helper-textarea");
                    if (textarea) (textarea as HTMLElement).focus();
                } else {
                    setTimeout(() => checkAndInject(attempts + 1), 500);
                }
            } catch (e) {
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

                    <button
                        className="btn btn-ghost btn-xs gap-1 h-6 min-h-6"
                        onClick={() => setIsFileBrowserOpen(true)}
                        disabled={isInsertingFilePaths}
                        title="Browse files and insert absolute paths into the agent input"
                    >
                        {isInsertingFilePaths ? <span className="loading loading-spinner loading-xs"></span> : <FolderOpen className="w-3 h-3" />}
                        <span className={headerButtonLabelClass}>Insert Files</span>
                    </button>

                    <button
                        className="btn btn-ghost btn-xs gap-1 h-6 min-h-6"
                        onClick={handleNewAttempt}
                        title="Start a new attempt in a new tab with this session context"
                    >
                        <Plus className="w-3 h-3" />
                        <span className={headerButtonLabelClass}>New Attempt</span>
                    </button>

                    {devServerScript?.trim() && (
                        <button
                            className="btn btn-ghost btn-xs gap-1 h-6 min-h-6"
                            onClick={handleStartDevServer}
                            disabled={isStartingDevServer}
                            title="Run dev server script in terminal"
                        >
                            {isStartingDevServer ? <span className="loading loading-spinner loading-xs"></span> : <Play className="w-3 h-3" />}
                            <span className={headerButtonLabelClass}>Start Dev Server</span>
                        </button>
                    )}

                    <button
                        className="btn btn-ghost btn-xs gap-1 h-6 min-h-6"
                        onClick={() => setIsPreviewVisible((previous) => !previous)}
                        title={isPreviewVisible ? 'Hide preview panel' : 'Show preview panel'}
                    >
                        <Globe className="w-3 h-3" />
                        <span className={headerButtonLabelClass}>{isPreviewVisible ? 'Close Preview' : 'Show Preview'}</span>
                    </button>

                    <button
                        className="btn btn-ghost btn-xs gap-1 h-6 min-h-6"
                        onClick={handleCommit}
                        disabled={isRequestingCommit}
                        title="Ask agent to create a commit with current changes"
                    >
                        {isRequestingCommit ? <span className="loading loading-spinner loading-xs"></span> : <GitCommitHorizontal className="w-3 h-3" />}
                        <span className={headerButtonLabelClass}>Commit ({uncommittedFileCount})</span>
                    </button>



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
                            className="btn btn-ghost btn-xs btn-warning rounded-none h-6 min-h-6 border-none px-2 hover:bg-warning/20 hover:border-transparent"
                            onClick={handleMergeAndPurge}
                            disabled={isMerging || isRebasing || isUpdatingBaseBranch || !currentBaseBranch || !worktree}
                            title={currentBaseBranch ? `Merge current branch (${branch}) into target branch (${currentBaseBranch}), then clean up and exit` : 'Target branch unavailable for this session'}
                        >
                            {isMerging ? <span className="loading loading-spinner loading-xs"></span> : <GitMerge className="w-3 h-3" />}
                            <span className={headerButtonLabelClass}>Merge & Purge</span>
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
                        src="/terminal"
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
                                    disabled={!previewUrl}
                                    title={isPreviewPickerActive ? 'Disable picker' : 'Pick element from preview'}
                                >
                                    <MousePointer2 className="h-3 w-3" />
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
                        src="/terminal"
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
