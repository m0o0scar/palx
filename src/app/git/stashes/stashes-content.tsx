'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useGitStashes, useGitAction, useStashFiles, useStashFileDiff } from '@/hooks/use-git';
import { cn, getChangedLineCountFromDiff, isFileBinary, isImageFile } from '@/lib/utils';
import { useTheme } from 'next-themes';
import { GroupedDiffViewer } from '@/components/git/grouped-diff-viewer';
import { ImageDiffView } from '@/components/git/image-diff-view';

function StashDiffView({ repoPath, stashIndex, filePath }: { repoPath: string; stashIndex: number; filePath: string }) {
    const { data, isLoading } = useStashFileDiff(repoPath, stashIndex, filePath);
    const { resolvedTheme } = useTheme();
    const storageKey = 'git-web:diff-view-split';

    const [splitView, setSplitView] = useState(() => {
        if (typeof window === 'undefined') return true;
        try {
            const stored = localStorage.getItem(storageKey);
            return stored !== null ? JSON.parse(stored) : true;
        } catch {
            return true;
        }
    });

    const [renderAnyway, setRenderAnyway] = useState(false);

    if (isLoading) {
        return <div className="flex items-center justify-center p-8 h-full"><span className="loading loading-spinner text-base-content/50"></span></div>;
    }

    if (!data) {
        return (
            <div className="flex items-center justify-center h-full opacity-50">
                No diff available
            </div>
        );
    }

    if (isImageFile(filePath)) {
        return (
            <div className="flex flex-col h-full bg-white dark:bg-[#161b22]">
                <div className="flex items-center justify-between px-4 h-[57px] border-b border-slate-200 dark:border-[#30363d] shrink-0 bg-white dark:bg-[#161b22]">
                    <span className="text-sm font-mono truncate max-w-[70%]" title={filePath}>{filePath}</span>
                </div>
                <div className="flex-1 overflow-auto">
                    <ImageDiffView filePath={filePath} imageDiff={data.imageDiff} />
                </div>
            </div>
        );
    }

    const isBinary = isFileBinary(filePath, data.left, data.right);

    if (isBinary) {
        return (
            <div className="flex flex-col h-full bg-white dark:bg-[#161b22]">
                <div className="flex items-center justify-between px-4 h-[57px] border-b border-slate-200 dark:border-[#30363d] shrink-0 bg-white dark:bg-[#161b22]">
                    <span className="text-sm font-mono truncate max-w-[70%]" title={filePath}>{filePath}</span>
                </div>
                <div className="flex-1 flex items-center justify-center opacity-50">
                    Binary file - diff not available
                </div>
            </div>
        );
    }

    const MAX_DIFF_SIZE = 100 * 1024;
    const MAX_DIFF_LINES = 3000;

    const diffContent = data.diff || '';
    const contentSize = diffContent.length;
    const lineCount = getChangedLineCountFromDiff(diffContent);

    const isLargeDiff = (contentSize > MAX_DIFF_SIZE || lineCount > MAX_DIFF_LINES);

    return (
        <div className="flex flex-col h-full bg-white dark:bg-[#161b22]">
            <div className="flex items-center justify-between px-4 h-[57px] border-b border-slate-200 dark:border-[#30363d] shrink-0 bg-white dark:bg-[#161b22]">
                <span className="text-sm font-mono truncate max-w-[70%]" title={filePath}>{filePath}</span>
                <div className="flex items-center gap-2">
                    <label htmlFor="split-view-stash" className="text-[10px] uppercase tracking-wider font-bold cursor-pointer opacity-70">Split View</label>
                    <input
                        type="checkbox"
                        id="split-view-stash"
                        checked={splitView}
                        onChange={(e) => {
                            setSplitView(e.target.checked);
                            try {
                                localStorage.setItem(storageKey, JSON.stringify(e.target.checked));
                            } catch { }
                        }}
                        className="toggle toggle-xs toggle-primary"
                    />
                </div>
            </div>
            <div className="flex-1 overflow-auto diff-viewer-wrapper">
                {isLargeDiff && !renderAnyway ? (
                    <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-4">
                        <i className="iconoir-warning-triangle text-[32px] text-warning" aria-hidden="true" />
                        <div className="space-y-2">
                            <h3 className="font-bold text-lg">Large Diff Detected</h3>
                            <p className="opacity-70">
                                This diff is large ({Math.round(contentSize / 1024)}KB, ~{lineCount} changed lines) and may freeze your browser if rendered.
                            </p>
                        </div>
                        <button className="btn btn-outline" onClick={() => setRenderAnyway(true)}>
                            Show Diff Anyway
                        </button>
                    </div>
                ) : (
                    <GroupedDiffViewer
                        oldValue={data.left || ''}
                        newValue={data.right || ''}
                        splitView={splitView}
                        useDarkTheme={resolvedTheme === 'dark'}
                    />
                )}
            </div>
        </div>
    );
}

function StashesContent() {
    const searchParams = useSearchParams();
    const repoPath = searchParams.get('path');
    const { data: stashes, isLoading, isError, error, refetch } = useGitStashes(repoPath);
    const action = useGitAction();
    const [selectedStashIndex, setSelectedStashIndex] = useState<number | null>(null);
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [expandedStashes, setExpandedStashes] = useState<Set<number>>(new Set());

    const { data: stashFiles, isLoading: filesLoading } = useStashFiles(repoPath, selectedStashIndex);

    if (!repoPath) {
        return <div className="p-8">No repository path specified.</div>;
    }

    if (isLoading) {
        return (
            <div className="flex items-center justify-center h-64">
                <span className="loading loading-spinner text-base-content/50"></span>
            </div>
        );
    }

    if (isError) {
        return (
            <div className="flex items-center justify-center h-64 flex-col gap-4">
                <p className="text-error font-medium">Error Loading Stashes</p>
                <p className="text-sm opacity-70">{(error as Error)?.message || 'An unknown error occurred'}</p>
                <button onClick={() => refetch()} className="btn btn-outline btn-sm">
                    <i className="iconoir-refresh-circle text-[16px] mr-1" aria-hidden="true" />
                    Try Again
                </button>
            </div>
        );
    }

    const handleApply = async (index: number) => {
        await action.mutateAsync({ repoPath, action: 'stash-apply', data: { index } });
        refetch();
    };

    const handlePop = async (index: number) => {
        await action.mutateAsync({ repoPath, action: 'stash-pop', data: { index } });
        setSelectedStashIndex(null);
        setSelectedFile(null);
        refetch();
    };

    const handleDrop = async (index: number) => {
        await action.mutateAsync({ repoPath, action: 'stash-drop', data: { index } });
        if (selectedStashIndex === index) {
            setSelectedStashIndex(null);
            setSelectedFile(null);
        }
        refetch();
    };

    const toggleStashExpanded = (index: number) => {
        const newExpanded = new Set(expandedStashes);
        if (newExpanded.has(index)) {
            newExpanded.delete(index);
        } else {
            newExpanded.add(index);
        }
        setExpandedStashes(newExpanded);
        setSelectedStashIndex(index);
        setSelectedFile(null);
    };

    const formatDate = (dateString: string) => {
        try {
            const date = new Date(dateString);
            const now = new Date();
            const diffMs = now.getTime() - date.getTime();
            const diffMins = Math.floor(diffMs / 60000);
            const diffHours = Math.floor(diffMs / 3600000);
            const diffDays = Math.floor(diffMs / 86400000);

            if (diffMins < 1) return 'just now';
            if (diffMins < 60) return `${diffMins} minute${diffMins === 1 ? '' : 's'} ago`;
            if (diffHours < 24) return `${diffHours} hour${diffHours === 1 ? '' : 's'} ago`;
            if (diffDays < 30) return `${diffDays} day${diffDays === 1 ? '' : 's'} ago`;
            return date.toLocaleDateString();
        } catch {
            return dateString;
        }
    };

    const getStatusColor = (status: string) => {
        switch (status) {
            case 'A': return 'text-success';
            case 'D': return 'text-error';
            case 'M': return 'text-warning';
            default: return 'opacity-50';
        }
    };

    const getStatusLabel = (status: string) => {
        switch (status) {
            case 'A': return 'Added';
            case 'D': return 'Deleted';
            case 'M': return 'Modified';
            default: return status;
        }
    };

    const headerActionButtonClass =
        "flex h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#30363d] dark:bg-[#161b22] dark:text-slate-300 dark:hover:bg-[#30363d]/60 dark:hover:text-slate-100";

    return (
        <div className="flex h-full overflow-hidden">
            <div className="flex flex-1 min-w-0 flex-col gap-2 overflow-hidden">
                <div className="flex min-h-[57px] shrink-0 items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 dark:border-[#30363d] dark:bg-[#161b22]">
                    <h1 className="font-bold text-lg text-slate-900 dark:text-slate-100">Stashes</h1>
                    <button className={headerActionButtonClass} onClick={() => refetch()} disabled={action.isPending} title="Refresh stashes">
                        {action.isPending ? <span className="loading loading-spinner loading-xs"></span> : <i className="iconoir-refresh-circle text-[16px]" aria-hidden="true" />}
                        Refresh
                    </button>
                </div>

                <div className="flex flex-1 overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-[#30363d] dark:bg-[#161b22]">
                    {/* Left Panel: Stash List */}
                    <div className="w-64 border-r border-slate-200 dark:border-[#30363d] flex flex-col bg-slate-50/70 dark:bg-[#161b22]/70">
                        <div className="flex-1 overflow-y-auto overflow-x-hidden">
                    {!stashes || stashes.length === 0 ? (
                        <div className="flex-1 flex flex-col items-center justify-center opacity-50 h-64">
                            <div className="p-8 rounded-full bg-slate-100 dark:bg-[#30363d]/60 mb-4 text-4xl">
                                📦
                            </div>
                            <p className="text-sm font-bold">No stashes</p>
                            <p className="text-xs mt-1">Stash changes from the Changes page</p>
                        </div>
                    ) : (
                        <div className="p-2">
                            {stashes.map((stash) => {
                                const isExpanded = expandedStashes.has(stash.index);
                                const isSelected = selectedStashIndex === stash.index;

                                return (
                                    <div key={stash.hash} className="mb-1">
                                        <div
                                            className={cn(
                                                "p-2 rounded-md cursor-pointer transition-colors",
                                                isSelected ? "bg-slate-100 dark:bg-[#30363d]/70" : "hover:bg-slate-100 dark:hover:bg-[#30363d]/60"
                                            )}
                                            onClick={() => toggleStashExpanded(stash.index)}
                                        >
                                            <div className="flex flex-col gap-1">
                                                {/* Row 1: ID and Buttons */}
                                                <div className="flex items-center justify-between">
                                                    <div className="flex items-center gap-2">
                                                        <div className="opacity-50 text-[10px]">
                                                            {isExpanded ? '▼' : '▶'}
                                                        </div>
                                                        <span className="text-[10px] font-mono bg-slate-200 dark:bg-[#30363d] px-1 py-0.5 rounded opacity-70">
                                                            stash@{'{' + stash.index + '}'}
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center gap-1 shrink-0">
                                                        <div className="tooltip tooltip-left before:whitespace-normal before:max-w-[120px]" data-tip="Apply stash (keep)">
                                                            <button
                                                                className="btn btn-ghost btn-xs btn-square"
                                                                onClick={(e) => { e.stopPropagation(); handleApply(stash.index); }}
                                                                disabled={action.isPending}
                                                            >
                                                                <i className="iconoir-play text-[16px]" aria-hidden="true" />
                                                            </button>
                                                        </div>
                                                        <div className="tooltip tooltip-left before:whitespace-normal before:max-w-[120px]" data-tip="Pop stash (apply and delete)">
                                                            <button
                                                                className="btn btn-ghost btn-xs btn-square"
                                                                onClick={(e) => { e.stopPropagation(); handlePop(stash.index); }}
                                                                disabled={action.isPending}
                                                            >
                                                                <i className="iconoir-u-turn-arrow-left text-[16px]" aria-hidden="true" />
                                                            </button>
                                                        </div>
                                                        <div className="tooltip tooltip-left before:whitespace-normal before:max-w-[120px]" data-tip="Delete stash">
                                                            <button
                                                                className="btn btn-ghost btn-xs btn-square text-error hover:bg-error/10"
                                                                onClick={(e) => { e.stopPropagation(); handleDrop(stash.index); }}
                                                                disabled={action.isPending}
                                                            >
                                                                <i className="iconoir-trash text-[16px]" aria-hidden="true" />
                                                            </button>
                                                        </div>
                                                    </div>
                                                </div>

                                                {/* Row 2: Message */}
                                                <div className="tooltip tooltip-bottom before:whitespace-normal before:max-w-[200px] w-full block text-left" data-tip={stash.message}>
                                                    <p className="text-xs font-bold truncate opacity-90 w-full">
                                                        {stash.message}
                                                    </p>
                                                </div>

                                                {/* Row 3: Metadata */}
                                                <div className="text-[10px] opacity-50">
                                                    {formatDate(stash.date)}
                                                </div>
                                            </div>
                                        </div>

                                        {/* Files list when expanded */}
                                        {isExpanded && isSelected && (
                                            <div className="ml-6 mt-1 space-y-0.5">
                                                {filesLoading ? (
                                                    <div className="flex items-center gap-2 px-2 py-1 text-xs opacity-50">
                                                        <span className="loading loading-spinner loading-xs"></span>
                                                        Loading files...
                                                    </div>
                                                ) : stashFiles && stashFiles.length > 0 ? (
                                                    stashFiles.map((file) => (
                                                        <div
                                                            key={file.path}
                                                            className={cn(
                                                                "flex items-center gap-2 px-2 py-1 rounded cursor-pointer transition-colors text-xs",
                                                                selectedFile === file.path ? "bg-primary/10 text-primary font-bold" : "hover:bg-slate-100 dark:hover:bg-[#30363d]/60"
                                                            )}
                                                            onClick={(e) => { e.stopPropagation(); setSelectedFile(file.path); }}
                                                        >
                                                            <i className="iconoir-page text-[14px] opacity-50" aria-hidden="true" />
                                                            <span className="font-mono truncate flex-1" title={file.path}>{file.path}</span>
                                                            <span className={cn("text-[10px] uppercase font-bold", getStatusColor(file.status))} title={getStatusLabel(file.status)}>
                                                                {file.status}
                                                            </span>
                                                        </div>
                                                    ))
                                                ) : (
                                                    <div className="px-2 py-1 text-xs opacity-50 italic">
                                                        No files in stash
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                        </div>
                    </div>

                    {/* Right Panel: Diff View */}
                    <div className="flex-1 flex flex-col bg-white dark:bg-[#161b22] overflow-hidden">
                        {selectedStashIndex !== null && selectedFile ? (
                            <StashDiffView
                                key={`${selectedStashIndex}:${selectedFile}`}
                                repoPath={repoPath}
                                stashIndex={selectedStashIndex}
                                filePath={selectedFile}
                            />
                        ) : (
                            <div className="flex-1 flex flex-col items-center justify-center opacity-50">
                                <div className="p-8 rounded-full bg-slate-100 dark:bg-[#30363d]/60 mb-4 text-4xl">
                                    📦
                                </div>
                                <p className="text-sm font-bold">
                                    {selectedStashIndex !== null ? 'Select a file to view changes' : 'Select a stash to view files'}
                                </p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function StashesContentWrapper() {
    return (
        <Suspense fallback={<div className="flex items-center justify-center h-full"><span className="loading loading-spinner"></span></div>}>
            <StashesContent />
        </Suspense>
    );
}
