import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useTheme } from 'next-themes';
import { useCommitDiff, useCommitFileDiff, useGitStatus } from '@/hooks/use-git';
import { cn, isFileBinary, isImageFile, getChangedLineCountFromDiff } from '@/lib/utils';
import { GroupedDiffViewer } from './grouped-diff-viewer';
import { ImageDiffView } from './image-diff-view';
import { useEscapeDismiss } from '@/hooks/use-escape-dismiss';
import { CommitFileTreeItem, buildCommitFileTree, collectCommitFolderPaths, getParentPaths } from './commit-file-tree';
import { DiffView } from './diff-view';
import { SESSION_MOBILE_VIEWPORT_QUERY } from '@/lib/responsive';

const MAX_SELECTION_STATE_ENTRIES = 40;

function pruneSelectionStateMap<T>(state: Record<string, T>, currentKey: string): Record<string, T> {
  const entries = Object.entries(state);
  if (entries.length <= MAX_SELECTION_STATE_ENTRIES) {
    return state;
  }

  const nextEntries = entries
    .filter(([key]) => key !== currentKey)
    .slice(-(MAX_SELECTION_STATE_ENTRIES - 1));

  if (currentKey in state) {
    nextEntries.push([currentKey, state[currentKey]]);
  }

  return Object.fromEntries(nextEntries);
}

// Component to show commit file diff
export function CommitFileDiffView({
  repoPath,
  commitHash,
  fromCommitHash,
  toCommitHash,
  filePath,
  splitView,
  containerClassName = 'overflow-auto h-full',
}: {
  repoPath: string;
  commitHash: string | null;
  fromCommitHash: string | null;
  toCommitHash: string | null;
  filePath: string;
  splitView: boolean;
  containerClassName?: string;
}) {
  const { data, isLoading } = useCommitFileDiff(repoPath, filePath, {
    commitHash,
    fromCommitHash,
    toCommitHash,
  });
  const { resolvedTheme } = useTheme();
  const diffSelectionKey = `${commitHash ?? ''}:${fromCommitHash ?? ''}:${toCommitHash ?? ''}:${filePath}`;
  const [renderAnywayDiffKey, setRenderAnywayDiffKey] = useState<string | null>(null);
  const renderAnyway = renderAnywayDiffKey === diffSelectionKey;
  const diffScrollContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      diffScrollContainerRef.current?.scrollTo({ top: 0, left: 0 });
    });

    return () => cancelAnimationFrame(frame);
  }, [filePath, commitHash, fromCommitHash, toCommitHash, isLoading]);

  if (isLoading) {
    return <div className="flex items-center justify-center p-8"><span className="loading loading-spinner text-base-content/50"></span></div>;
  }

  if (!data) {
    return <div className="flex items-center justify-center p-8 opacity-50">No diff available</div>;
  }

  if (isImageFile(filePath)) {
    return <ImageDiffView filePath={filePath} imageDiff={data.imageDiff} />;
  }

  // Check if file is binary (first by extension, then by content if unknown)
  const isBinary = isFileBinary(filePath, data.left, data.right);

  if (isBinary) {
    return <div className="flex items-center justify-center p-8 opacity-50">Binary file - diff not available</div>;
  }

  // Large file protection
  const MAX_DIFF_SIZE = 100 * 1024; // 100KB
  const MAX_DIFF_LINES = 3000;

  const diffContent = data.diff || '';
  const contentSize = diffContent.length;
  const lineCount = getChangedLineCountFromDiff(diffContent);

  const isLargeDiff = (contentSize > MAX_DIFF_SIZE || lineCount > MAX_DIFF_LINES);

  if (isLargeDiff && !renderAnyway) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-center p-8">
        <i className="iconoir-warning-triangle text-[32px] text-warning" aria-hidden="true" />
        <div className="space-y-2">
          <h3 className="font-bold text-lg">Large Diff Detected</h3>
          <p className="opacity-70">
            This diff is large ({Math.round(contentSize / 1024)}KB, ~{lineCount} changed lines) and may freeze your browser if rendered.
          </p>
        </div>
        <button className="btn btn-outline" onClick={() => setRenderAnywayDiffKey(diffSelectionKey)}>
          Show Diff Anyway
        </button>
      </div>
    );
  }

  return (
    <div ref={diffScrollContainerRef} className={containerClassName}>
      <GroupedDiffViewer
        oldValue={data.left || ''}
        newValue={data.right || ''}
        splitView={splitView}
        useDarkTheme={resolvedTheme === 'dark'}
      />
    </div>
  );
}

// Component to show commit changes
export function CommitChangesView({
  repoPath,
  commitHash = null,
  fromCommitHash = null,
  toCommitHash = null,
  showWorkingTreeWhenNoCommit = false,
  fileListWidthClass = 'w-64',
}: {
  repoPath: string;
  commitHash?: string | null;
  fromCommitHash?: string | null;
  toCommitHash?: string | null;
  showWorkingTreeWhenNoCommit?: boolean;
  fileListWidthClass?: string;
}) {
  const isCommitRangeSelection = !!fromCommitHash && !!toCommitHash;
  const isWorkingTreeSelection = showWorkingTreeWhenNoCommit && !commitHash && !fromCommitHash && !toCommitHash;
  const selectionKey = isWorkingTreeSelection
    ? 'working-tree'
    : (isCommitRangeSelection ? `${fromCommitHash}..${toCommitHash}` : (commitHash ?? 'none'));
  const { data, isLoading } = useCommitDiff(repoPath, {
    commitHash,
    fromCommitHash,
    toCommitHash,
  });
  const { data: statusData, isLoading: isStatusLoading } = useGitStatus(repoPath);
  const statusFiles = statusData?.files;
  const [selectedFileBySelection, setSelectedFileBySelection] = useState<Record<string, string | null>>({});
  const [isFullPageDiff, setIsFullPageDiff] = useState(false);
  const [collapsedFoldersByCommit, setCollapsedFoldersByCommit] = useState<Record<string, Set<string>>>({});
  const [isMobileViewport, setIsMobileViewport] = useState(false);
  const workingTreeFiles = useMemo(() => {
    if (!statusFiles || statusFiles.length === 0) return [];

    const filesByPath = new Map<string, { path: string; additions: number; deletions: number; status: string }>();
    for (const file of statusFiles) {
      const indexStatus = (file.index || '').trim();
      const workingStatus = (file.working_dir || '').trim();
      const normalizedStatus = [indexStatus, workingStatus].find((value) => ['A', 'D', 'R', 'M'].includes(value)) || 'M';
      filesByPath.set(file.path, {
        path: file.path,
        additions: 0,
        deletions: 0,
        status: normalizedStatus,
      });
    }

    return Array.from(filesByPath.values());
  }, [statusFiles]);
  const files = useMemo(
    () => (isWorkingTreeSelection ? workingTreeFiles : (data?.files ?? [])),
    [isWorkingTreeSelection, workingTreeFiles, data?.files]
  );
  const fileTree = useMemo(() => buildCommitFileTree(files), [files]);
  const allFolderPaths = useMemo(() => collectCommitFolderPaths(fileTree), [fileTree]);
  const collapsedFolders = useMemo(
    () => collapsedFoldersByCommit[selectionKey] ?? new Set<string>(),
    [collapsedFoldersByCommit, selectionKey]
  );
  
  // Storage key for split view preference - same as in DiffView
  const storageKey = 'git-web:diff-view-split';
  
  const [splitView, setSplitView] = useState(() => {
    if (typeof window === 'undefined') return true;
    try {
      const stored = localStorage.getItem(storageKey);
      return stored !== null ? JSON.parse(stored) : true;
    } catch (e) {
      console.error('Failed to load split view preference:', e);
      return true;
    }
  });
  const diffViewportRef = useRef<HTMLDivElement>(null);
  const selectedFile = useMemo(() => {
    if (files.length === 0) return null;

    const savedSelection = selectedFileBySelection[selectionKey] ?? null;
    if (savedSelection && files.some((file) => file.path === savedSelection)) {
      return savedSelection;
    }

    return files[0].path;
  }, [files, selectedFileBySelection, selectionKey]);
  const handleSelectFile = useCallback((path: string) => {
    setSelectedFileBySelection((previous) => {
      if ((previous[selectionKey] ?? null) === path) {
        return previous;
      }

      return pruneSelectionStateMap({
        ...previous,
        [selectionKey]: path,
      }, selectionKey);
    });
  }, [selectionKey]);

  // Save split view preference when it changes
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(splitView));
    } catch (e) {
      console.error('Failed to save split view preference:', e);
    }
  }, [splitView]);

  useEffect(() => {
    if (!selectedFile) return;

    const frame = requestAnimationFrame(() => {
      diffViewportRef.current?.scrollTo({ top: 0, left: 0 });
    });

    return () => cancelAnimationFrame(frame);
  }, [selectedFile, selectionKey]);

  useEscapeDismiss(isFullPageDiff, () => setIsFullPageDiff(false));

  useEffect(() => {
    if (!isFullPageDiff) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [isFullPageDiff]);

  const expandedFolders = useMemo(() => {
    const expanded = new Set<string>();

    allFolderPaths.forEach((path) => {
      if (!collapsedFolders.has(path)) {
        expanded.add(path);
      }
    });

    if (selectedFile) {
      getParentPaths(selectedFile).forEach((path) => expanded.add(path));
    }

    return expanded;
  }, [allFolderPaths, collapsedFolders, selectedFile]);

  const handleToggleFolder = useCallback((path: string) => {
    setCollapsedFoldersByCommit((prev) => {
      const current = prev[selectionKey] ?? new Set<string>();
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return pruneSelectionStateMap({
        ...prev,
        [selectionKey]: next,
      }, selectionKey);
    });
  }, [selectionKey]);

  const isLoadingCurrentSelection = isWorkingTreeSelection ? isStatusLoading : isLoading;

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const mediaQuery = window.matchMedia(SESSION_MOBILE_VIEWPORT_QUERY);
    const updateViewport = () => setIsMobileViewport(mediaQuery.matches);
    updateViewport();

    mediaQuery.addEventListener('change', updateViewport);
    return () => mediaQuery.removeEventListener('change', updateViewport);
  }, []);

  if (isLoadingCurrentSelection) {
    return <div className="flex items-center justify-center p-8 h-full"><span className="loading loading-spinner text-base-content/50"></span></div>;
  }

  if (files.length === 0) {
    return (
      <div className="flex items-center justify-center p-8 h-full opacity-50">
        {isWorkingTreeSelection
          ? 'No uncommitted local changes'
          : (isCommitRangeSelection ? 'No changes in selected commit range' : 'No changes in this commit')}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex h-full min-w-0',
        isFullPageDiff && 'fixed inset-0 z-[80] h-auto bg-base-100 shadow-2xl'
      )}
    >
      {/* File list */}
      {!isMobileViewport && (
        <div className={cn(fileListWidthClass, 'border-r border-base-300 flex flex-col bg-base-200/30 shrink-0')}>
          <div className="h-9 flex items-center shrink-0 px-3 text-xs font-bold opacity-70 border-b border-base-300 bg-base-100">
            {files.length} file{files.length !== 1 ? 's' : ''} changed
          </div>
          <div className="flex-1 overflow-y-auto min-h-0">
            <div className="p-1">
              <CommitFileTreeItem
                node={fileTree}
                selectedFile={selectedFile}
                expandedFolders={expandedFolders}
                onToggleFolder={handleToggleFolder}
                onSelectFile={handleSelectFile}
              />
            </div>
          </div>
        </div>
      )}

      {/* Diff view */}
      <div className="flex-1 min-w-0 overflow-hidden">
        {isMobileViewport ? (
          <div className="h-full flex flex-col">
            <div className="h-9 flex items-center justify-between shrink-0 px-4 text-xs font-mono opacity-70 border-b border-base-300 bg-base-100 truncate">
              <span className="truncate">{files.length} file{files.length !== 1 ? 's' : ''} changed</span>
              <div className="flex items-center gap-2 shrink-0 ml-4">
                <label htmlFor="commit-diff-split-view" className="text-[10px] uppercase tracking-wider font-bold cursor-pointer opacity-70">Split View</label>
                <input
                  type="checkbox"
                  id="commit-diff-split-view"
                  checked={splitView}
                  onChange={(e) => setSplitView(e.target.checked)}
                  className="toggle toggle-xs toggle-primary"
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-xs btn-square"
                  onClick={() => setIsFullPageDiff((prev) => !prev)}
                  aria-label={isFullPageDiff ? 'Exit full-page diff view' : 'Expand diff viewer to full page'}
                  title={isFullPageDiff ? 'Exit full-page diff view' : 'Expand diff viewer to full page'}
                >
                  <i
                    className={cn(
                      isFullPageDiff ? 'iconoir-collapse' : 'iconoir-maximize',
                      'text-[14px]'
                    )}
                    aria-hidden="true"
                  />
                </button>
              </div>
            </div>
            <div ref={diffViewportRef} className="flex-1 overflow-auto diff-viewer-wrapper">
              <div className="space-y-4 p-3">
                {files.map((file) => (
                  <section
                    key={`${selectionKey}:${file.path}`}
                    className="overflow-hidden rounded-lg border border-base-300 bg-base-100"
                  >
                    <div className="border-b border-base-300 px-4 py-2 text-xs font-mono opacity-70">
                      <span className="block truncate" title={file.path}>{file.path}</span>
                    </div>
                    <div className="max-w-full overflow-hidden">
                      {isWorkingTreeSelection ? (
                        <DiffView
                          repoPath={repoPath}
                          filePath={file.path}
                          splitView={splitView}
                          onSplitViewChange={setSplitView}
                          showHeader={false}
                        />
                      ) : (
                        <CommitFileDiffView
                          key={`${selectionKey}:${file.path}`}
                          repoPath={repoPath}
                          commitHash={commitHash}
                          fromCommitHash={fromCommitHash}
                          toCommitHash={toCommitHash}
                          filePath={file.path}
                          splitView={splitView}
                          containerClassName="overflow-auto"
                        />
                      )}
                    </div>
                  </section>
                ))}
              </div>
            </div>
          </div>
        ) : selectedFile ? (
          <div className="h-full flex flex-col">
            <div className="h-9 flex items-center justify-between shrink-0 px-4 text-xs font-mono opacity-70 border-b border-base-300 bg-base-100 truncate">
              <span className="truncate">{selectedFile}</span>
              <div className="flex items-center gap-2 shrink-0 ml-4">
                <label htmlFor="commit-diff-split-view" className="text-[10px] uppercase tracking-wider font-bold cursor-pointer opacity-70">Split View</label>
                <input
                  type="checkbox"
                  id="commit-diff-split-view"
                  checked={splitView}
                  onChange={(e) => setSplitView(e.target.checked)}
                  className="toggle toggle-xs toggle-primary"
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-xs btn-square"
                  onClick={() => setIsFullPageDiff((prev) => !prev)}
                  aria-label={isFullPageDiff ? 'Exit full-page diff view' : 'Expand diff viewer to full page'}
                  title={isFullPageDiff ? 'Exit full-page diff view' : 'Expand diff viewer to full page'}
                >
                  <i
                    className={cn(
                      isFullPageDiff ? 'iconoir-collapse' : 'iconoir-maximize',
                      'text-[14px]'
                    )}
                    aria-hidden="true"
                  />
                </button>
              </div>
            </div>
            <div ref={diffViewportRef} className="flex-1 overflow-auto diff-viewer-wrapper">
              {isWorkingTreeSelection ? (
                <DiffView
                  repoPath={repoPath}
                  filePath={selectedFile}
                  splitView={splitView}
                  onSplitViewChange={setSplitView}
                  showHeader={false}
                />
              ) : (
                <CommitFileDiffView
                  key={`${selectionKey}:${selectedFile}`}
                  repoPath={repoPath}
                  commitHash={commitHash}
                  fromCommitHash={fromCommitHash}
                  toCommitHash={toCommitHash}
                  filePath={selectedFile}
                  splitView={splitView}
                />
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full opacity-70 text-sm">
            Select a file to view changes
          </div>
        )}
      </div>
    </div>
  );
}
