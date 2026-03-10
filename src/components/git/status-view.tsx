'use client';

import { useGitStatus, useGitAction, useGitBranches } from '@/hooks/use-git';
import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { cn, sanitizeBranchName } from '@/lib/utils';
import { DiffView } from './diff-view';
import { useEscapeDismiss } from '@/hooks/use-escape-dismiss';
import { useTheme } from 'next-themes';
import type { TerminalWindow } from '@/hooks/useTerminalLink';
import { startTtydProcess } from '@/app/actions/git';
import { buildTtydTerminalSrc, type TerminalShellKind } from '@/lib/terminal-session';
import { buildShellSetDirectoryCommand, joinShellStatements, quoteShellArg } from '@/lib/shell';
import {
    applyThemeToTerminalWindow,
    resolveShouldUseDarkTheme,
    TERMINAL_THEME_DARK,
    TERMINAL_THEME_LIGHT,
} from '@/lib/ttyd-theme';
import type { AppStatus, ModelOption } from '@/lib/types';

const EMPTY_FILES: Array<{ path: string; index: string; working_dir: string }> = [];
const AUTO_COMMIT_SETTINGS_STORAGE_KEY = 'git-web:auto-commit-agent-settings:v1';
const AUTO_COMMIT_CODEX_FLAGS = '-c approval_policy="never" exec --color never --sandbox danger-full-access --skip-git-repo-check -';
const AUTO_COMMIT_PROVIDER_LABELS: Record<string, string> = {
    codex: 'Codex CLI',
    gemini: 'Gemini CLI',
    cursor: 'Cursor Agent CLI',
};

type AutoCommitProvider = 'codex' | 'gemini' | 'cursor';
type AutoCommitSettings = {
    provider: AutoCommitProvider;
    model: string;
};

type AgentStatusResponse = {
    status: AppStatus | null;
    error?: string;
};

const DEFAULT_AUTO_COMMIT_SETTINGS: AutoCommitSettings = {
    provider: 'codex',
    model: 'auto',
};
const FALLBACK_AUTO_MODEL_OPTION: ModelOption = {
    id: 'auto',
    label: 'Auto',
    description: 'Let the selected provider decide.',
};

function buildCommitMessage(subject: string, body: string): string {
    const trimmedSubject = subject.trim();
    const normalizedBody = body.replace(/\r\n/g, '\n');
    return normalizedBody.trim() ? `${trimmedSubject}\n\n${normalizedBody}` : trimmedSubject;
}

function parseAutoCommitSettings(raw: string | null): AutoCommitSettings {
    if (!raw) return DEFAULT_AUTO_COMMIT_SETTINGS;
    try {
        const parsed = JSON.parse(raw) as Partial<AutoCommitSettings>;
        const provider = parsed.provider;
        const normalizedProvider: AutoCommitProvider = provider === 'gemini' || provider === 'cursor' || provider === 'codex'
            ? provider
            : DEFAULT_AUTO_COMMIT_SETTINGS.provider;
        const model = typeof parsed.model === 'string' && parsed.model.trim()
            ? parsed.model.trim()
            : DEFAULT_AUTO_COMMIT_SETTINGS.model;
        return { provider: normalizedProvider, model };
    } catch {
        return DEFAULT_AUTO_COMMIT_SETTINGS;
    }
}

function buildAutoCommitAgentPrompt(isFirstCommit: boolean, initialBranch?: string): string {
    const lines = [
        'Run in this git repository and create a commit for the currently staged changes.',
        'If you changed files inside a Git repository and the work for that repository is complete, commit that repository without confirmation.',
        'Use a commit message with a clear title and a detailed body explaining what changed and why.',
        'Do not push, do not open pull requests, and do not modify unstaged files.',
        'Requirements:',
        '1. Inspect only staged changes before writing the commit message.',
        '2. Keep the commit focused on the staged changes only.',
        '3. Create the commit and then run git status.',
        '4. Print the created commit hash and subject in the terminal output.',
    ];

    if (isFirstCommit && initialBranch?.trim()) {
        lines.push(`5. This repository has no commits yet. Ensure the first commit is on branch "${initialBranch.trim()}".`);
    }

    return lines.join('\n');
}

function buildAutoCommitAgentCommand(
    repoPath: string,
    shellKind: TerminalShellKind,
    settings: AutoCommitSettings,
    prompt: string,
): string {
    const normalizedModel = settings.model.trim();
    const useAutoModel = normalizedModel.length === 0 || normalizedModel.toLowerCase() === 'auto';
    const promptArg = quoteShellArg(prompt, shellKind);

    const codexCommand = useAutoModel
        ? `NO_COLOR=1 FORCE_COLOR=0 TERM=xterm codex ${AUTO_COMMIT_CODEX_FLAGS}`
        : `NO_COLOR=1 FORCE_COLOR=0 TERM=xterm codex -c approval_policy="never" exec --color never --sandbox danger-full-access --skip-git-repo-check --model ${quoteShellArg(normalizedModel, shellKind)} -`;
    const codexRun = shellKind === 'powershell'
        ? `$inputPrompt = ${promptArg}; $inputPrompt | ${codexCommand}`
        : `printf '%s\\n' ${promptArg} | ${codexCommand}`;

    const geminiCommand = useAutoModel
        ? `gemini --yolo -p ${promptArg}`
        : `gemini --yolo --model ${quoteShellArg(normalizedModel, shellKind)} -p ${promptArg}`;
    const cursorCommand = useAutoModel
        ? `cursor-agent -f -p ${promptArg}`
        : `cursor-agent -f --model ${quoteShellArg(normalizedModel, shellKind)} -p ${promptArg}`;

    const providerCommand = settings.provider === 'gemini'
        ? geminiCommand
        : (settings.provider === 'cursor' ? cursorCommand : codexRun);

    const codexLoginCommand = shellKind === 'powershell'
        ? "if ($env:OPENAI_API_KEY) { $env:OPENAI_API_KEY | codex login --with-api-key | Out-Null }"
        : 'if [ -n "$OPENAI_API_KEY" ]; then printenv OPENAI_API_KEY | codex login --with-api-key >/dev/null 2>&1 || true; fi';

    return joinShellStatements([
        buildShellSetDirectoryCommand(repoPath, shellKind),
        settings.provider === 'codex' ? codexLoginCommand : null,
        providerCommand,
    ], shellKind);
}

interface StatusFileTreeNode {
    name: string;
    path: string;
    filePath?: string;
    children: Map<string, StatusFileTreeNode>;
}

function buildStatusFileTree(paths: string[]): StatusFileTreeNode {
    const root: StatusFileTreeNode = {
        name: '',
        path: '',
        children: new Map(),
    };

    for (const filePath of paths) {
        const parts = filePath.split('/').filter(Boolean);
        let current = root;
        let currentPath = '';

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            currentPath = currentPath ? `${currentPath}/${part}` : part;

            if (!current.children.has(part)) {
                current.children.set(part, {
                    name: part,
                    path: currentPath,
                    children: new Map(),
                });
            }

            current = current.children.get(part)!;

            if (i === parts.length - 1) {
                current.filePath = filePath;
            }
        }
    }

    return root;
}

function collectFolderPaths(node: StatusFileTreeNode): string[] {
    const paths: string[] = [];
    const children = Array.from(node.children.values());

    children.forEach((child) => {
        if (child.children.size > 0) {
            paths.push(child.path);
            paths.push(...collectFolderPaths(child));
        }
    });

    return paths;
}

function getParentPaths(filePath: string): string[] {
    const parts = filePath.split('/').filter(Boolean);
    const parentPaths: string[] = [];

    for (let i = 1; i < parts.length; i++) {
        parentPaths.push(parts.slice(0, i).join('/'));
    }

    return parentPaths;
}

function collectFilePaths(node: StatusFileTreeNode): string[] {
    const filePaths: string[] = [];

    node.children.forEach((child) => {
        if (child.filePath) {
            filePaths.push(child.filePath);
        }

        if (child.children.size > 0) {
            filePaths.push(...collectFilePaths(child));
        }
    });

    return filePaths;
}

function StatusFileTreeItem({
    node,
    selectedFile,
    expandedFolders,
    onToggleFolder,
    onSelectFile,
    onActionPaths,
    actionType,
    actionPending,
    depth = 0,
}: {
    node: StatusFileTreeNode;
    selectedFile: string | null;
    expandedFolders: Set<string>;
    onToggleFolder: (path: string) => void;
    onSelectFile: (path: string) => void;
    onActionPaths: (paths: string[]) => Promise<void>;
    actionType: 'stage' | 'unstage';
    actionPending: boolean;
    depth?: number;
}) {
    const children = Array.from(node.children.values()).sort((a, b) => {
        const aIsFolder = a.children.size > 0;
        const bIsFolder = b.children.size > 0;

        if (aIsFolder && !bIsFolder) return -1;
        if (!aIsFolder && bIsFolder) return 1;
        return a.name.localeCompare(b.name);
    });

    return (
        <>
            {children.map((child) => {
                const isFolder = child.children.size > 0;

                if (isFolder) {
                    const isExpanded = expandedFolders.has(child.path);
                    const filePaths = collectFilePaths(child);

                    return (
                        <div key={child.path} className="group">
                            <div
                                className="flex items-center gap-1 px-2 py-1.5 text-xs rounded cursor-pointer text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-[#30363d]/70 transition-colors"
                                style={{ paddingLeft: `${depth * 12 + 8}px` }}
                                onClick={() => onToggleFolder(child.path)}
                                title={child.path}
                            >
                                <span className="text-[10px] opacity-70">{isExpanded ? '▼' : '▶'}</span>
                                <i className="iconoir-folder text-[14px] opacity-70" aria-hidden="true" />
                                <span className="truncate flex-1">{child.name}</span>
                                <button
                                    className={cn(
                                        'btn btn-ghost btn-xs btn-square opacity-0 group-hover:opacity-100 transition-opacity',
                                        actionType === 'stage'
                                            ? 'text-success hover:bg-success/10'
                                            : 'text-error hover:bg-error/10'
                                    )}
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        void onActionPaths(filePaths);
                                    }}
                                    disabled={actionPending || filePaths.length === 0}
                                    title={actionType === 'stage' ? `Stage all in ${child.path}` : `Unstage all in ${child.path}`}
                                >
                                    <i
                                        className={cn(
                                            'text-[14px]',
                                            actionType === 'stage' ? 'iconoir-plus-circle' : 'iconoir-minus-circle'
                                        )}
                                        aria-hidden="true"
                                    />
                                </button>
                            </div>
                            {isExpanded && (
                                <StatusFileTreeItem
                                    node={child}
                                    selectedFile={selectedFile}
                                    expandedFolders={expandedFolders}
                                    onToggleFolder={onToggleFolder}
                                    onSelectFile={onSelectFile}
                                    onActionPaths={onActionPaths}
                                    actionType={actionType}
                                    actionPending={actionPending}
                                    depth={depth + 1}
                                />
                            )}
                        </div>
                    );
                }

                const filePath = child.filePath;
                if (!filePath) return null;

                return (
                    <div
                        key={filePath}
                        className={cn(
                            'flex items-center justify-between gap-2 px-2 py-1.5 rounded-md cursor-pointer group hover:bg-slate-100 dark:hover:bg-[#30363d]/70 transition-colors text-sm',
                            selectedFile === filePath && 'bg-slate-100 dark:bg-[#30363d]/70 font-medium text-primary'
                        )}
                        style={{ paddingLeft: `${depth * 12 + 8}px` }}
                        onClick={() => onSelectFile(filePath)}
                        title={filePath}
                    >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                            <i className="iconoir-page text-[14px] opacity-70 shrink-0" aria-hidden="true" />
                            <span className="truncate flex-1 font-mono text-xs">{child.name}</span>
                        </div>
                        <button
                            className={cn(
                                'btn btn-ghost btn-xs btn-square opacity-0 group-hover:opacity-100 transition-opacity',
                                actionType === 'stage'
                                    ? 'text-success hover:bg-success/10'
                                    : 'text-error hover:bg-error/10'
                            )}
                            onClick={(e) => {
                                e.stopPropagation();
                                void onActionPaths([filePath]);
                            }}
                            disabled={actionPending}
                        >
                            <i
                                className={cn(
                                    'text-[14px]',
                                    actionType === 'stage' ? 'iconoir-plus-circle' : 'iconoir-minus-circle'
                                )}
                                aria-hidden="true"
                            />
                        </button>
                    </div>
                );
            })}
        </>
    );
}

export function StatusView({ repoPath }: { repoPath: string }) {
    const { resolvedTheme } = useTheme();
    const { data: status, isLoading, isError, error, refetch } = useGitStatus(repoPath);
    const { data: branches, refetch: refetchBranches } = useGitBranches(repoPath);
    const action = useGitAction();
    const [subject, setSubject] = useState('');
    const [body, setBody] = useState('');
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [stashDialogOpen, setStashDialogOpen] = useState(false);
    const [stashMessage, setStashMessage] = useState('');
    const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
    const [firstCommitDialogOpen, setFirstCommitDialogOpen] = useState(false);
    const [initialBranchName, setInitialBranchName] = useState('main');
    const [autoCommitSettingsDialogOpen, setAutoCommitSettingsDialogOpen] = useState(false);
    const [autoCommitSettingsDraft, setAutoCommitSettingsDraft] = useState<AutoCommitSettings>(DEFAULT_AUTO_COMMIT_SETTINGS);
    const [autoCommitSettings, setAutoCommitSettings] = useState<AutoCommitSettings>(DEFAULT_AUTO_COMMIT_SETTINGS);
    const [autoCommitAgentStatus, setAutoCommitAgentStatus] = useState<AppStatus | null>(null);
    const [isLoadingAutoCommitAgentStatus, setIsLoadingAutoCommitAgentStatus] = useState(false);
    const [autoCommitModalOpen, setAutoCommitModalOpen] = useState(false);
    const [autoCommitModalError, setAutoCommitModalError] = useState<string | null>(null);
    const [isPreparingAutoCommitAgent, setIsPreparingAutoCommitAgent] = useState(false);
    const [autoCommitTerminalSrc, setAutoCommitTerminalSrc] = useState('/terminal');
    const [autoCommitCommand, setAutoCommitCommand] = useState('');
    const [isAutoCommitCommandInjected, setIsAutoCommitCommandInjected] = useState(false);
    const [autoCommitIsFirstCommit, setAutoCommitIsFirstCommit] = useState(false);
    const autoCommitTerminalRef = useRef<HTMLIFrameElement>(null);
    const [collapsedChangeFolders, setCollapsedChangeFolders] = useState<Set<string>>(new Set());
    const [collapsedStagedFolders, setCollapsedStagedFolders] = useState<Set<string>>(new Set());
    
    // Resize logic for commit box
    const [commitBoxHeight, setCommitBoxHeight] = useState(250);
    const [isResizing, setIsResizing] = useState(false);
    const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isResizing || !resizeRef.current) return;
            const delta = resizeRef.current.startY - e.clientY;
            const newHeight = Math.max(150, Math.min(800, resizeRef.current.startHeight + delta));
            setCommitBoxHeight(newHeight);
        };

        const handleMouseUp = () => {
            setIsResizing(false);
            resizeRef.current = null;
            document.body.style.cursor = 'default';
            document.body.style.userSelect = 'auto';
        };

        if (isResizing) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';
        }

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'default';
            document.body.style.userSelect = 'auto';
        };
    }, [isResizing]);

    const handleResizeStart = (e: React.MouseEvent) => {
        e.preventDefault();
        setIsResizing(true);
        resizeRef.current = { startY: e.clientY, startHeight: commitBoxHeight };
    };

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const parsed = parseAutoCommitSettings(window.localStorage.getItem(AUTO_COMMIT_SETTINGS_STORAGE_KEY));
        setAutoCommitSettings(parsed);
        setAutoCommitSettingsDraft(parsed);
    }, []);

    const fetchAutoCommitAgentStatus = useCallback(async (
        provider: AutoCommitProvider,
        options?: { silent?: boolean },
    ): Promise<AppStatus | null> => {
        if (!options?.silent) {
            setIsLoadingAutoCommitAgentStatus(true);
        }

        try {
            const response = await fetch(`/api/agent/status?provider=${encodeURIComponent(provider)}`, {
                cache: 'no-store',
            });
            const payload = await response.json().catch(() => null) as AgentStatusResponse | null;
            if (!payload) {
                throw new Error('Failed to load agent runtime status.');
            }
            setAutoCommitAgentStatus(payload.status);
            return payload.status;
        } catch (statusError) {
            console.error('Failed to load auto-commit agent status:', statusError);
            setAutoCommitAgentStatus(null);
            return null;
        } finally {
            if (!options?.silent) {
                setIsLoadingAutoCommitAgentStatus(false);
            }
        }
    }, []);

    useEffect(() => {
        if (!autoCommitSettingsDialogOpen) return;
        void fetchAutoCommitAgentStatus(autoCommitSettingsDraft.provider);
    }, [autoCommitSettingsDialogOpen, autoCommitSettingsDraft.provider, fetchAutoCommitAgentStatus]);

    const autoCommitModelOptions = useMemo(() => {
        const models = autoCommitAgentStatus?.models ?? [];
        if (models.some((model) => model.id === FALLBACK_AUTO_MODEL_OPTION.id)) {
            return models;
        }
        return [FALLBACK_AUTO_MODEL_OPTION, ...models];
    }, [autoCommitAgentStatus]);

    useEffect(() => {
        if (!autoCommitSettingsDialogOpen) return;
        const nextModel = autoCommitModelOptions.find((model) => model.id === autoCommitSettingsDraft.model)?.id
            || autoCommitAgentStatus?.defaultModel
            || autoCommitModelOptions[0]?.id
            || 'auto';
        if (nextModel !== autoCommitSettingsDraft.model) {
            setAutoCommitSettingsDraft((prev) => ({ ...prev, model: nextModel }));
        }
    }, [
        autoCommitAgentStatus?.defaultModel,
        autoCommitModelOptions,
        autoCommitSettingsDialogOpen,
        autoCommitSettingsDraft.model,
    ]);

    const openAutoCommitModal = useCallback(async (isFirst: boolean, firstCommitBranchName?: string) => {
        setIsPreparingAutoCommitAgent(true);
        setAutoCommitModalError(null);
        setIsAutoCommitCommandInjected(false);
        setAutoCommitIsFirstCommit(isFirst);

        try {
            const ttydResult = await startTtydProcess();
            if (!ttydResult.success) {
                throw new Error(ttydResult.error || 'Failed to start ttyd.');
            }

            const shellKind = ttydResult.shellKind === 'powershell' ? 'powershell' : 'posix';
            const persistenceMode = ttydResult.persistenceMode === 'tmux' ? 'tmux' : 'shell';
            const prompt = buildAutoCommitAgentPrompt(isFirst, firstCommitBranchName);
            const command = buildAutoCommitAgentCommand(repoPath, shellKind, autoCommitSettings, prompt);
            const sessionName = `git-auto-commit-${Date.now()}`;
            setAutoCommitTerminalSrc(buildTtydTerminalSrc(sessionName, 'terminal', undefined, {
                persistenceMode,
                shellKind,
                workingDirectory: repoPath,
            }));
            setAutoCommitCommand(command);
            setAutoCommitModalOpen(true);
        } catch (commitError) {
            setAutoCommitModalOpen(true);
            setAutoCommitModalError(commitError instanceof Error ? commitError.message : 'Failed to initialize auto-commit agent.');
        } finally {
            setIsPreparingAutoCommitAgent(false);
        }
    }, [autoCommitSettings, repoPath]);

    const closeAutoCommitModal = useCallback(() => {
        setAutoCommitModalOpen(false);
        setAutoCommitModalError(null);
        setAutoCommitCommand('');
        setAutoCommitIsFirstCommit(false);
        setIsAutoCommitCommandInjected(false);
        setSelectedFile(null);
        void Promise.all([refetch(), refetchBranches()]);
    }, [refetch, refetchBranches]);

    const handleAutoCommitTerminalLoad = useCallback(() => {
        if (!autoCommitModalOpen || !autoCommitCommand || !autoCommitTerminalRef.current || isAutoCommitCommandInjected) {
            return;
        }

        const iframe = autoCommitTerminalRef.current;
        const checkAndInject = (attempts = 0) => {
            if (attempts > 40) {
                setAutoCommitModalError('Timed out while waiting for terminal to initialize.');
                return;
            }

            try {
                const win = iframe.contentWindow as TerminalWindow | null;
                if (win?.term) {
                    const shouldUseDark = resolveShouldUseDarkTheme(
                        resolvedTheme === 'light' || resolvedTheme === 'dark' ? resolvedTheme : 'auto',
                        window.matchMedia('(prefers-color-scheme: dark)').matches,
                    );
                    applyThemeToTerminalWindow(
                        win,
                        shouldUseDark ? TERMINAL_THEME_DARK : TERMINAL_THEME_LIGHT,
                    );
                    win.term.paste(`${autoCommitCommand}\r`);
                    setIsAutoCommitCommandInjected(true);
                    setAutoCommitModalError(null);
                    win.focus();
                    return;
                }

                setTimeout(() => checkAndInject(attempts + 1), 300);
            } catch (injectError) {
                console.error('Failed to inject auto-commit command into terminal iframe:', injectError);
                setAutoCommitModalError('Could not access ttyd terminal. Ensure ttyd is running and try again.');
            }
        };

        setTimeout(() => checkAndInject(), 500);
    }, [autoCommitCommand, autoCommitModalOpen, isAutoCommitCommandInjected, resolvedTheme]);

    const files = status?.files ?? EMPTY_FILES;
    const isFirstCommit = !!branches && branches.branches.length === 0;

    // Group files
    const { staged, changes } = useMemo(() => {
        const stagedFiles: string[] = [];
        const changedFiles: string[] = [];

        files.forEach((file) => {
            if (file.index !== ' ' && file.index !== '?') {
                stagedFiles.push(file.path);
            }
            if (file.working_dir !== ' ' || file.index === '?') {
                changedFiles.push(file.path);
            }
        });

        return {
            staged: stagedFiles,
            changes: changedFiles,
        };
    }, [files]);

    const changesTree = useMemo(() => buildStatusFileTree(changes), [changes]);
    const stagedTree = useMemo(() => buildStatusFileTree(staged), [staged]);
    const allChangeFolderPaths = useMemo(() => collectFolderPaths(changesTree), [changesTree]);
    const allStagedFolderPaths = useMemo(() => collectFolderPaths(stagedTree), [stagedTree]);

    const expandedChangeFolders = useMemo(() => {
        const expanded = new Set<string>();

        allChangeFolderPaths.forEach((path) => {
            if (!collapsedChangeFolders.has(path)) {
                expanded.add(path);
            }
        });

        if (selectedFile) {
            getParentPaths(selectedFile).forEach((path) => expanded.add(path));
        }

        return expanded;
    }, [allChangeFolderPaths, collapsedChangeFolders, selectedFile]);

    const expandedStagedFolders = useMemo(() => {
        const expanded = new Set<string>();

        allStagedFolderPaths.forEach((path) => {
            if (!collapsedStagedFolders.has(path)) {
                expanded.add(path);
            }
        });

        if (selectedFile) {
            getParentPaths(selectedFile).forEach((path) => expanded.add(path));
        }

        return expanded;
    }, [allStagedFolderPaths, collapsedStagedFolders, selectedFile]);

    const handleToggleChangeFolder = useCallback((path: string) => {
        setCollapsedChangeFolders((prev) => {
            const next = new Set(prev);
            if (next.has(path)) {
                next.delete(path);
            } else {
                next.add(path);
            }
            return next;
        });
    }, []);

    const handleToggleStagedFolder = useCallback((path: string) => {
        setCollapsedStagedFolders((prev) => {
            const next = new Set(prev);
            if (next.has(path)) {
                next.delete(path);
            } else {
                next.add(path);
            }
            return next;
        });
    }, []);

    const handleStagePaths = async (paths: string[]) => {
        if (paths.length === 0) return;
        await action.mutateAsync({ repoPath, action: 'stage', data: { files: paths } });
    };

    const handleUnstagePaths = async (paths: string[]) => {
        if (paths.length === 0) return;
        await action.mutateAsync({ repoPath, action: 'unstage', data: { files: paths } });
    };

    const handleStageAll = async () => {
        await action.mutateAsync({ repoPath, action: 'stage', data: { files: ['.'] } });
    }

    const handleUnstageAll = async () => {
        await action.mutateAsync({ repoPath, action: 'unstage', data: { files: staged } });
    }

    const handleStash = async () => {
        await action.mutateAsync({ repoPath, action: 'stash', data: { message: stashMessage || undefined } });
        setStashDialogOpen(false);
        setStashMessage('');
        setSelectedFile(null);
    }

    const handleDiscard = async () => {
        await action.mutateAsync({ repoPath, action: 'discard', data: { includeUntracked: true } });
        setDiscardDialogOpen(false);
        setSelectedFile(null);
    }

    const handleCommit = async () => {
        const trimmedSubject = subject.trim();

        if (isFirstCommit) {
            setFirstCommitDialogOpen(true);
            return;
        }

        if (!trimmedSubject) {
            await openAutoCommitModal(false);
            return;
        }

        const commitData = { message: buildCommitMessage(trimmedSubject, body) };

        await action.mutateAsync({
            repoPath,
            action: 'commit',
            data: commitData,
        });
        setSubject('');
        setBody('');
        setSelectedFile(null);
    };

    const handleFirstCommitConfirm = async () => {
        const trimmedSubject = subject.trim();
        const trimmedBranchName = initialBranchName.trim();
        if (!trimmedBranchName) return;

        if (!trimmedSubject) {
            setFirstCommitDialogOpen(false);
            await openAutoCommitModal(true, trimmedBranchName);
            return;
        }

        const commitData = { message: buildCommitMessage(trimmedSubject, body), initialBranch: trimmedBranchName };

        await action.mutateAsync({
            repoPath,
            action: 'commit',
            data: commitData,
        });

        setSubject('');
        setBody('');
        setSelectedFile(null);
        setFirstCommitDialogOpen(false);
    };

    useEscapeDismiss(stashDialogOpen, () => setStashDialogOpen(false), () => {
        if (action.isPending) {
            return;
        }
        void handleStash();
    });
    useEscapeDismiss(discardDialogOpen, () => setDiscardDialogOpen(false), () => {
        if (action.isPending) {
            return;
        }
        void handleDiscard();
    });
    useEscapeDismiss(firstCommitDialogOpen, () => setFirstCommitDialogOpen(false), () => {
        if (action.isPending || !initialBranchName.trim()) {
            return;
        }
        void handleFirstCommitConfirm();
    });
    useEscapeDismiss(autoCommitSettingsDialogOpen, () => setAutoCommitSettingsDialogOpen(false));
    useEscapeDismiss(autoCommitModalOpen, closeAutoCommitModal);

    const handleCommitShortcut = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            if (staged.length > 0 && !action.isPending) {
                handleCommit();
            }
        }
    };

    if (isLoading) {
        return <div className="flex items-center justify-center h-64"><span className="loading loading-spinner text-base-content/50"></span></div>;
    }

    if (isError) {
        return (
            <div className="flex items-center justify-center h-64 flex-col gap-4">
                <p className="text-error font-bold">Error Loading Status</p>
                <p className="text-sm opacity-70">{(error as Error)?.message || 'An unknown error occurred'}</p>
                <button onClick={() => refetch()} className="btn btn-outline btn-sm">
                    <i className="iconoir-refresh-circle text-[16px] mr-1" aria-hidden="true" />
                    Try Again
                </button>
            </div>
        );
    }

    if (!status) return <div className="flex items-center justify-center h-64 opacity-70">No status data available</div>;

    const headerActionButtonClass =
        "flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#30363d] dark:bg-[#161b22] dark:text-slate-300 dark:hover:bg-[#30363d]/60 dark:hover:text-slate-100";

    return (
        <div className="flex h-full overflow-hidden">
            <div className="flex flex-1 min-w-0 flex-col gap-2 overflow-hidden">
                <div className="flex min-h-[57px] shrink-0 items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 dark:border-[#30363d] dark:bg-[#161b22]">
                    <h1 className="font-bold text-lg text-slate-900 dark:text-slate-100">Changes</h1>
                    <div className="flex items-center gap-2">
                        <button
                            className={headerActionButtonClass}
                            onClick={() => {
                                setAutoCommitSettingsDraft(autoCommitSettings);
                                setAutoCommitSettingsDialogOpen(true);
                            }}
                            disabled={action.isPending}
                            title="Auto-commit agent settings"
                        >
                            <i className="iconoir-settings text-[16px]" aria-hidden="true" />
                            Settings
                        </button>
                        <button className={headerActionButtonClass} onClick={() => refetch()} disabled={action.isPending} title="Refresh status">
                            {action.isPending ? <span className="loading loading-spinner loading-xs"></span> : <i className="iconoir-refresh-circle text-[16px]" aria-hidden="true" />}
                            Refresh
                        </button>
                    </div>
                </div>

                <div className="flex flex-1 overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-[#30363d] dark:bg-[#161b22]">
                    {/* Left Panel: File List */}
                    <div className="w-64 border-r border-slate-200 dark:border-[#30363d] flex flex-col bg-slate-50/70 dark:bg-[#161b22]/70">
                        <div className="flex-1 overflow-y-auto">
                            {/* Unstaged Changes */}
                            <div className="p-2">
                                <div className="flex items-center justify-between px-2 py-2 mb-1">
                                    <h3 className="text-xs font-bold uppercase tracking-wider opacity-70">Changes ({changes.length})</h3>
                                    <div className="flex items-center gap-0.5">
                                        {changes.length === 0 && staged.length > 0 ? (
                                            <button className="btn btn-ghost btn-xs btn-square" onClick={handleUnstageAll} title="Unstage All">
                                                <i className="iconoir-arrow-up text-[16px]" aria-hidden="true" />
                                            </button>
                                        ) : (
                                            <button className="btn btn-ghost btn-xs btn-square" onClick={handleStageAll} disabled={changes.length === 0} title="Stage All">
                                                <i className="iconoir-arrow-down text-[16px]" aria-hidden="true" />
                                            </button>
                                        )}
                                        <button className="btn btn-ghost btn-xs btn-square" onClick={() => setStashDialogOpen(true)} disabled={changes.length === 0 && staged.length === 0} title="Stash">
                                            <i className="iconoir-download-square text-[16px]" aria-hidden="true" />
                                        </button>
                                        <button className="btn btn-ghost btn-xs btn-square text-error hover:bg-error/10" onClick={() => setDiscardDialogOpen(true)} disabled={changes.length === 0} title="Discard All">
                                            <i className="iconoir-trash text-[16px]" aria-hidden="true" />
                                        </button>
                                    </div>
                                </div>
                                <div className="space-y-0.5">
                                    {changes.length === 0 && <p className="px-2 py-2 text-xs opacity-50 italic">No changes</p>}
                                    {changes.length > 0 && (
                                        <StatusFileTreeItem
                                            node={changesTree}
                                            selectedFile={selectedFile}
                                            expandedFolders={expandedChangeFolders}
                                            onToggleFolder={handleToggleChangeFolder}
                                            onSelectFile={setSelectedFile}
                                            onActionPaths={handleStagePaths}
                                            actionType="stage"
                                            actionPending={action.isPending}
                                        />
                                    )}
                                </div>
                            </div>

                            <div className="h-px bg-slate-200 dark:bg-[#30363d] mx-4 my-2" />

                            {/* Staged Changes */}
                            <div className="p-2">
                                <div className="flex items-center justify-between px-2 py-2 mb-1">
                                    <h3 className="text-xs font-bold uppercase tracking-wider opacity-70">Staged ({staged.length})</h3>
                                </div>
                                <div className="space-y-0.5">
                                    {staged.length === 0 && <p className="px-2 py-2 text-xs opacity-50 italic">No staged changes</p>}
                                    {staged.length > 0 && (
                                        <StatusFileTreeItem
                                            node={stagedTree}
                                            selectedFile={selectedFile}
                                            expandedFolders={expandedStagedFolders}
                                            onToggleFolder={handleToggleStagedFolder}
                                            onSelectFile={setSelectedFile}
                                            onActionPaths={handleUnstagePaths}
                                            actionType="unstage"
                                            actionPending={action.isPending}
                                        />
                                    )}
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Right Panel: Diff View & Commit Box */}
                    <div className="flex-1 flex flex-col bg-white dark:bg-[#161b22] overflow-hidden">
                        {/* Diff View Area */}
                        <div className="flex-1 overflow-hidden flex flex-col min-h-0">
                            {selectedFile ? (
                                <div className="h-full flex flex-col">
                                    <DiffView repoPath={repoPath} filePath={selectedFile} />
                                </div>
                            ) : (
                                <div className="flex-1 flex flex-col items-center justify-center opacity-50">
                                    <div className="p-8 rounded-full bg-slate-100 dark:bg-[#30363d]/60 mb-4 text-4xl">
                                        <i className="iconoir-refresh-circle text-[32px]" aria-hidden="true" />
                                    </div>
                                    <p className="text-sm font-bold">Select a file to view changes</p>
                                </div>
                            )}
                        </div>

                        {/* Resize Handle */}
                        <div
                            className="h-1.5 cursor-ns-resize flex items-center justify-center hover:bg-slate-100 dark:hover:bg-[#30363d]/60 transition-colors group shrink-0 border-t border-slate-200 dark:border-[#30363d]"
                            onMouseDown={handleResizeStart}
                        >
                            <div className="w-8 h-1 rounded-full bg-base-300 group-hover:bg-base-content/20 transition-colors" />
                        </div>

                        {/* Commit Box */}
                        <div
                            className="flex flex-col border-t border-slate-200 dark:border-[#30363d] bg-white dark:bg-[#161b22] shrink-0"
                            style={{ height: commitBoxHeight }}
                        >
                            <div className="flex-1 p-4 overflow-y-auto">
                                <input
                                    type="text"
                                    placeholder="Commit subject (optional)..."
                                    value={subject}
                                    onChange={e => setSubject(e.target.value)}
                                    onKeyDown={handleCommitShortcut}
                                    className="input input-bordered w-full text-sm mb-2 font-sans"
                                />
                                <textarea
                                    placeholder="Commit message body (optional)..."
                                    value={body}
                                    onChange={e => setBody(e.target.value)}
                                    onKeyDown={handleCommitShortcut}
                                    className="textarea textarea-bordered w-full text-sm resize-none mb-3 font-sans flex-1"
                                    style={{ minHeight: '80px', height: 'calc(100% - 90px)' }}
                                />
                                <button className="btn btn-primary w-full btn-sm" onClick={handleCommit} disabled={staged.length === 0 || action.isPending}>
                                    {action.isPending ? <span className="loading loading-spinner loading-xs mr-2"></span> : <span className="mr-2">✅</span>}
                                    Commit Changes
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Stash Dialog */}
            {stashDialogOpen && (
                <dialog className="modal modal-open">
                    <div className="modal-box">
                        <h3 className="font-bold text-lg">Stash Changes</h3>
                        <p className="py-4 opacity-70">Save your local modifications to a new stash entry.</p>
                        <div className="py-2">
                            <input
                                type="text"
                                placeholder="Stash message (optional)"
                                value={stashMessage}
                                onChange={(e) => setStashMessage(e.target.value)}
                                autoFocus
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        handleStash();
                                    }
                                }}
                                className="input input-bordered w-full"
                            />
                        </div>
                        <div className="modal-action">
                            <button className="btn" onClick={() => setStashDialogOpen(false)}>Cancel</button>
                            <button className="btn btn-primary" onClick={handleStash} disabled={action.isPending}>
                                {action.isPending && <span className="loading loading-spinner loading-xs"></span>}
                                Stash
                            </button>
                        </div>
                    </div>
                    <form method="dialog" className="modal-backdrop">
                        <button onClick={() => setStashDialogOpen(false)}>close</button>
                    </form>
                </dialog>
            )}

            {/* Discard Dialog */}
            {discardDialogOpen && (
                <dialog className="modal modal-open">
                    <div className="modal-box">
                        <h3 className="font-bold text-lg">Discard Changes</h3>
                        <p className="py-4">
                            Are you sure you want to discard all unstaged changes and new files? This action cannot be undone.
                        </p>
                        <div className="modal-action">
                            <button className="btn" onClick={() => setDiscardDialogOpen(false)}>Cancel</button>
                            <button className="btn btn-error" onClick={handleDiscard} disabled={action.isPending}>
                                {action.isPending && <span className="loading loading-spinner loading-xs"></span>}
                                Discard
                            </button>
                        </div>
                    </div>
                    <form method="dialog" className="modal-backdrop">
                        <button onClick={() => setDiscardDialogOpen(false)}>close</button>
                    </form>
                </dialog>
            )}

            {firstCommitDialogOpen && (
                <dialog className="modal modal-open">
                    <div className="modal-box">
                        <h3 className="font-bold text-lg">First Commit Branch</h3>
                        <p className="py-4 opacity-70">
                            This repository has no commits yet. Choose the branch name for the first commit.
                        </p>
                        <div className="py-2">
                            <input
                                type="text"
                                placeholder="Branch name"
                                value={initialBranchName}
                                onChange={(e) => setInitialBranchName(sanitizeBranchName(e.target.value))}
                                autoFocus
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        handleFirstCommitConfirm();
                                    }
                                }}
                                className="input input-bordered w-full"
                            />
                        </div>
                        <div className="modal-action">
                            <button className="btn" onClick={() => setFirstCommitDialogOpen(false)}>
                                Cancel
                            </button>
                            <button className="btn btn-primary" onClick={handleFirstCommitConfirm} disabled={!initialBranchName.trim() || action.isPending}>
                                {action.isPending && <span className="loading loading-spinner loading-xs"></span>}
                                Commit to Branch
                            </button>
                        </div>
                    </div>
                    <form method="dialog" className="modal-backdrop">
                        <button onClick={() => setFirstCommitDialogOpen(false)}>close</button>
                    </form>
                </dialog>
            )}

            {autoCommitSettingsDialogOpen && (
                <dialog className="modal modal-open">
                    <div className="modal-box">
                        <h3 className="font-bold text-lg">Auto Commit Agent Settings</h3>
                        <p className="py-3 opacity-70">
                            Configure a global provider and model used when committing without a subject.
                        </p>
                        <div className="space-y-3">
                            <div>
                                <label className="label py-1">
                                    <span className="label-text text-xs uppercase tracking-wide opacity-70">Provider</span>
                                </label>
                                <select
                                    className="select select-bordered w-full"
                                    value={autoCommitSettingsDraft.provider}
                                    onChange={(event) => {
                                        const value = event.target.value as AutoCommitProvider;
                                        setAutoCommitAgentStatus(null);
                                        setAutoCommitSettingsDraft((prev) => ({
                                            ...prev,
                                            provider: value === 'gemini' || value === 'cursor' ? value : 'codex',
                                            model: 'auto',
                                        }));
                                    }}
                                >
                                    <option value="codex">{AUTO_COMMIT_PROVIDER_LABELS.codex}</option>
                                    <option value="gemini">{AUTO_COMMIT_PROVIDER_LABELS.gemini}</option>
                                    <option value="cursor">{AUTO_COMMIT_PROVIDER_LABELS.cursor}</option>
                                </select>
                            </div>
                            <div>
                                <label className="label py-1">
                                    <span className="label-text text-xs uppercase tracking-wide opacity-70">Model</span>
                                </label>
                                <select
                                    className="select select-bordered w-full"
                                    value={autoCommitSettingsDraft.model}
                                    onChange={(event) => {
                                        setAutoCommitSettingsDraft((prev) => ({
                                            ...prev,
                                            model: event.target.value,
                                        }));
                                    }}
                                    disabled={isLoadingAutoCommitAgentStatus}
                                >
                                    {autoCommitModelOptions.map((model) => (
                                        <option key={model.id} value={model.id}>
                                            {model.label}
                                        </option>
                                    ))}
                                </select>
                                <p className="mt-1 text-xs opacity-60">
                                    {isLoadingAutoCommitAgentStatus
                                        ? 'Loading available models...'
                                        : (autoCommitModelOptions.find((model) => model.id === autoCommitSettingsDraft.model)?.description
                                            || 'Use `auto` to let the selected provider decide.')}
                                </p>
                            </div>
                        </div>
                        <div className="modal-action">
                            <button className="btn" onClick={() => setAutoCommitSettingsDialogOpen(false)}>
                                Cancel
                            </button>
                            <button
                                className="btn btn-primary"
                                onClick={() => {
                                    const normalized: AutoCommitSettings = {
                                        provider: autoCommitSettingsDraft.provider,
                                        model: autoCommitSettingsDraft.model || 'auto',
                                    };
                                    setAutoCommitSettings(normalized);
                                    if (typeof window !== 'undefined') {
                                        window.localStorage.setItem(AUTO_COMMIT_SETTINGS_STORAGE_KEY, JSON.stringify(normalized));
                                    }
                                    setAutoCommitSettingsDialogOpen(false);
                                }}
                            >
                                Save
                            </button>
                        </div>
                    </div>
                    <form method="dialog" className="modal-backdrop">
                        <button onClick={() => setAutoCommitSettingsDialogOpen(false)}>close</button>
                    </form>
                </dialog>
            )}

            {autoCommitModalOpen && (
                <dialog className="modal modal-open">
                    <div className="modal-box max-w-5xl p-0 overflow-hidden">
                        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-[#30363d]">
                            <div>
                                <h3 className="font-bold text-base">
                                    Auto Commit with {AUTO_COMMIT_PROVIDER_LABELS[autoCommitSettings.provider] || autoCommitSettings.provider}
                                </h3>
                                <p className="text-xs opacity-70">
                                    Model: {autoCommitSettings.model || 'auto'}
                                    {autoCommitIsFirstCommit ? ' • First commit flow' : ''}
                                </p>
                            </div>
                            <button
                                type="button"
                                className="btn btn-ghost btn-xs"
                                onClick={closeAutoCommitModal}
                            >
                                Close
                            </button>
                        </div>
                        <div className="p-4">
                            {autoCommitModalError ? (
                                <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200">
                                    {autoCommitModalError}
                                </div>
                            ) : null}
                            {isPreparingAutoCommitAgent ? (
                                <div className="flex h-96 items-center justify-center">
                                    <span className="loading loading-spinner loading-md text-base-content/60"></span>
                                </div>
                            ) : (
                                <iframe
                                    ref={autoCommitTerminalRef}
                                    src={autoCommitTerminalSrc}
                                    className="h-[70vh] w-full rounded-md border border-slate-200 bg-black dark:border-[#30363d]"
                                    onLoad={handleAutoCommitTerminalLoad}
                                    title="Auto Commit Agent Terminal"
                                />
                            )}
                        </div>
                    </div>
                    <form method="dialog" className="modal-backdrop">
                        <button onClick={closeAutoCommitModal}>close</button>
                    </form>
                </dialog>
            )}
        </div>
    );
}
