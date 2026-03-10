'use client';

import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { getHomeDirectory, listPathEntries, saveAttachments } from '@/app/actions/git';
import { getConfig, updateConfig } from '@/app/actions/config';
import { ArrowLeft, Clipboard, FileText, Folder, Grid2x2, House, List, Pin, PinOff } from 'lucide-react';
import { getBaseName, getDirName } from '@/lib/path';
import { useDialogKeyboardShortcuts } from '@/hooks/useDialogKeyboardShortcuts';

const DEFAULT_VIEW_MODE_STORAGE_KEY = 'viba:session-file-browser:view-mode';

type FileSystemItem = {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo: boolean;
};

type GridFileTileProps = {
  item: FileSystemItem;
  isSelected: boolean;
  isImage: boolean;
  isSelectable: boolean;
  isPinned: boolean;
  isThumbnailBroken: boolean;
  onItemClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onPinClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onThumbnailError: () => void;
};

const ThumbnailPreview = memo(function ThumbnailPreview({
  item,
  isImage,
  isThumbnailBroken,
  onThumbnailError,
}: Pick<GridFileTileProps, 'item' | 'isImage' | 'isThumbnailBroken' | 'onThumbnailError'>) {
  const [hasLoaded, setHasLoaded] = useState(false);

  useEffect(() => {
    setHasLoaded(false);
  }, [item.path]);

  if (isImage && !isThumbnailBroken) {
    return (
      <>
        <FileText className={`w-10 h-10 opacity-40 transition-opacity ${hasLoaded ? 'opacity-0' : 'opacity-40'}`} />
        {/* Keep the image absolutely bounded to the tile and hidden until it has loaded to avoid full-size first paint. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={`/api/file-thumbnail?path=${encodeURIComponent(item.path)}`}
          alt={item.name}
          loading="lazy"
          decoding="async"
          className={`absolute inset-0 h-full w-full object-contain p-2 transition-opacity ${hasLoaded ? 'opacity-100' : 'opacity-0'}`}
          onLoad={() => setHasLoaded(true)}
          onError={onThumbnailError}
        />
      </>
    );
  }

  if (item.isDirectory) {
    return <Folder className="w-10 h-10 opacity-80" />;
  }

  return <FileText className="w-10 h-10 opacity-80" />;
}, (prev, next) =>
  prev.item.path === next.item.path
  && prev.item.name === next.item.name
  && prev.item.isDirectory === next.item.isDirectory
  && prev.isImage === next.isImage
  && prev.isThumbnailBroken === next.isThumbnailBroken
);

const GridFileTile = memo(function GridFileTile({
  item,
  isSelected,
  isImage,
  isSelectable,
  isPinned,
  isThumbnailBroken,
  onItemClick,
  onPinClick,
  onThumbnailError,
}: GridFileTileProps) {
  return (
    <button
      type="button"
      className={`rounded-lg border text-left overflow-hidden transition-colors ${isSelected
        ? 'border-primary bg-primary/15'
        : 'border-base-300 hover:bg-base-100'
        } ${!isSelectable ? 'opacity-50' : ''}`}
      onClick={onItemClick}
      title={item.path}
    >
      <div className="aspect-[4/3] bg-base-300 flex items-center justify-center overflow-hidden relative p-2">
        <ThumbnailPreview
          item={item}
          isImage={isImage}
          isThumbnailBroken={isThumbnailBroken}
          onThumbnailError={onThumbnailError}
        />
        {item.isDirectory && (
          <button
            type="button"
            className={`absolute top-1 right-1 btn btn-xs btn-circle ${isPinned ? 'btn-primary' : 'btn-ghost bg-base-100/70'}`}
            onClick={onPinClick}
            title={isPinned ? 'Unpin folder' : 'Pin folder'}
          >
            <Pin className={`w-3 h-3 ${isPinned ? 'fill-current' : ''}`} />
          </button>
        )}
      </div>
      <div className="px-2 py-2">
        <div className="truncate text-sm font-medium" title={item.name}>{item.name}</div>
        <div className="text-[10px] opacity-70">
          {item.isDirectory ? 'folder' : !isSelectable ? 'unsupported' : isImage ? 'image' : 'file'}
        </div>
      </div>
    </button>
  );
}, (prev, next) =>
  prev.item.path === next.item.path
  && prev.item.name === next.item.name
  && prev.item.isDirectory === next.item.isDirectory
  && prev.isSelected === next.isSelected
  && prev.isImage === next.isImage
  && prev.isSelectable === next.isSelectable
  && prev.isPinned === next.isPinned
  && prev.isThumbnailBroken === next.isThumbnailBroken
);

interface SessionFileBrowserProps {
  initialPath?: string;
  worktreePath?: string;
  onConfirm: (paths: string[]) => void | Promise<void>;
  onCancel: () => void;
  onPathChange?: (path: string) => void;
  title?: string;
  confirmLabel?: string;
  defaultViewMode?: 'list' | 'grid';
  viewModeStorageKey?: string | null;
  selectionMode?: 'single' | 'multiple';
  allowedFileExtensions?: string[];
  zIndexClassName?: string;
}

export default function SessionFileBrowser({
  initialPath,
  worktreePath,
  onConfirm,
  onCancel,
  onPathChange,
  title = 'Browse Files',
  confirmLabel,
  defaultViewMode = 'list',
  viewModeStorageKey = DEFAULT_VIEW_MODE_STORAGE_KEY,
  selectionMode = 'multiple',
  allowedFileExtensions,
  zIndexClassName = 'z-50',
}: SessionFileBrowserProps) {
  const imageExtensions = useMemo(
    () => new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.ico', '.avif']),
    []
  );
  const [currentPath, setCurrentPath] = useState('');
  const [items, setItems] = useState<FileSystemItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [homePath, setHomePath] = useState('');
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [anchorIndex, setAnchorIndex] = useState<number | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>(defaultViewMode);
  const [hasLoadedViewMode, setHasLoadedViewMode] = useState(false);
  const [brokenThumbnails, setBrokenThumbnails] = useState<Record<string, boolean>>({});
  const [pinnedFolderShortcuts, setPinnedFolderShortcuts] = useState<string[]>([]);
  const normalizedAllowedFileExtensions = useMemo(
    () =>
      new Set(
        (allowedFileExtensions ?? [])
          .map((extension) => extension.trim().toLowerCase())
          .filter(Boolean)
          .map((extension) => (extension.startsWith('.') ? extension : `.${extension}`))
      ),
    [allowedFileExtensions]
  );

  useEffect(() => {
    let isMounted = true;

    const init = async () => {
      try {
        const home = await getHomeDirectory();
        if (!isMounted) return;
        setHomePath(home);
        if (!initialPath) {
          setCurrentPath(home);
        }
      } catch (err) {
        console.error('Failed to resolve home directory:', err);
      }

      if (initialPath && isMounted) {
        setCurrentPath(initialPath);
      }
    };

    void init();

    return () => {
      isMounted = false;
    };
  }, [initialPath]);

  useEffect(() => {
    let isMounted = true;

    const loadPinnedFolderShortcuts = async () => {
      try {
        const config = await getConfig();
        if (!isMounted) return;
        const pinned = Array.isArray(config.pinnedFolderShortcuts)
          ? config.pinnedFolderShortcuts.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          : [];
        setPinnedFolderShortcuts(Array.from(new Set(pinned)));
      } catch (err) {
        console.error('Failed to load pinned folder shortcuts:', err);
      }
    };

    void loadPinnedFolderShortcuts();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    setViewMode(defaultViewMode);
    try {
      if (viewModeStorageKey) {
        const savedViewMode = localStorage.getItem(viewModeStorageKey);
        if (savedViewMode === 'list' || savedViewMode === 'grid') {
          setViewMode(savedViewMode);
        }
      }
    } catch {
      // Ignore localStorage failures.
    } finally {
      setHasLoadedViewMode(true);
    }
  }, [defaultViewMode, viewModeStorageKey]);

  useEffect(() => {
    if (!hasLoadedViewMode) return;
    try {
      if (viewModeStorageKey) {
        localStorage.setItem(viewModeStorageKey, viewMode);
      }
    } catch {
      // Ignore localStorage failures.
    }
  }, [hasLoadedViewMode, viewMode, viewModeStorageKey]);

  useEffect(() => {
    if (!currentPath) return;

    const fetchItems = async () => {
      setLoading(true);
      setError(null);
      try {
        const entries = await listPathEntries(currentPath);
        setItems(entries);
      } catch (err) {
        console.error('Failed to list files:', err);
        setError('Failed to load directory contents');
      } finally {
        setLoading(false);
      }
    };

    void fetchItems();
  }, [currentPath]);

  useEffect(() => {
    if (!currentPath) return;
    onPathChange?.(currentPath);
  }, [currentPath, onPathChange]);

  useEffect(() => {
    setSelectedPaths([]);
    setAnchorIndex(null);
    setBrokenThumbnails({});
  }, [currentPath]);

  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);
  const isImageFile = (fileName: string) => {
    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex === -1) return false;
    return imageExtensions.has(fileName.slice(dotIndex).toLowerCase());
  };
  const isAllowedFileType = useCallback((fileName: string) => {
    if (normalizedAllowedFileExtensions.size === 0) return true;
    const dotIndex = fileName.lastIndexOf('.');
    if (dotIndex === -1) return false;
    return normalizedAllowedFileExtensions.has(fileName.slice(dotIndex).toLowerCase());
  }, [normalizedAllowedFileExtensions]);
  const confirmationLabel = confirmLabel ?? (selectionMode === 'single' ? 'Use Selected File' : 'Insert');
  const selectionInstruction = selectionMode === 'single'
    ? 'Click a file to select it. Click a folder to open it.'
    : 'Click: single select. Cmd/Ctrl+Click: multi-select. Shift+Click: range select. Click a folder to open it.';
  const shouldShowPasteAction = Boolean(worktreePath);

  const handleGoUp = () => {
    const parent = getDirName(currentPath);
    if (parent && parent !== currentPath) {
      setCurrentPath(parent);
    }
  };

  const handleGoHome = () => {
    if (!homePath || currentPath === homePath) return;
    setCurrentPath(homePath);
  };

  const handleItemClick = (item: FileSystemItem, index: number, e: React.MouseEvent<HTMLElement>) => {
    if (item.isDirectory) {
      setCurrentPath(item.path);
      return;
    }

    if (!isAllowedFileType(item.name)) {
      setError(`Only ${Array.from(normalizedAllowedFileExtensions).join(', ')} files can be selected.`);
      return;
    }

    if (selectionMode === 'single') {
      setSelectedPaths([item.path]);
      setAnchorIndex(index);
      return;
    }

    const isMetaMulti = e.metaKey || e.ctrlKey;

    if (e.shiftKey && anchorIndex !== null) {
      const start = Math.min(anchorIndex, index);
      const end = Math.max(anchorIndex, index);
      const range = items
        .slice(start, end + 1)
        .filter((entry) => !entry.isDirectory)
        .map((entry) => entry.path);
      setSelectedPaths(range);
      return;
    }

    if (isMetaMulti) {
      setSelectedPaths((prev) =>
        prev.includes(item.path)
          ? prev.filter((path) => path !== item.path)
          : [...prev, item.path]
      );
      setAnchorIndex(index);
      return;
    }

    setSelectedPaths([item.path]);
    setAnchorIndex(index);
  };

  const handlePaste = async () => {
    setError(null);
    if (!worktreePath) {
      setError("Cannot paste: Session worktree path is missing.");
      return;
    }

    try {
      setLoading(true);
      
      if (!navigator.clipboard || !navigator.clipboard.read) {
        throw new Error("Clipboard API not supported in this browser");
      }

      // Request clipboard access
      const clipboardItems = await navigator.clipboard.read();
      const formData = new FormData();
      let hasFiles = false;

      for (const item of clipboardItems) {
        // Look for image types or other file types
        // We iterate through available types in the item
        for (const type of item.types) {
          // Prioritize images
          if (type.startsWith('image/')) {
            const blob = await item.getType(type);
            const ext = type.split('/')[1] || 'png';
            const filename = `pasted-image-${Date.now()}.${ext}`;
            const file = new File([blob], filename, { type });
            formData.append(filename, file); // Use filename as key
            hasFiles = true;
            break; // Found an image representation, stop checking other types for this item
          } else if (type === 'text/plain') {
             // For now, ignore plain text unless we want to save it as a text file.
             // If user copies text, they can paste directly into terminal. 
             // This feature is "pasting file".
          }
        }
      }

      if (hasFiles) {
        const savedPaths = await saveAttachments(worktreePath, formData);
        if (savedPaths && savedPaths.length > 0) {
          // Determine what to do with saved paths.
          // Option 1: auto-insert them (call onConfirm).
          // Option 2: select them in the browser (might be hard if they are in a different dir).
          // Option 3: just call onConfirm because the user clicked "Paste" to insert.
          await onConfirm(savedPaths);
          return;
        } else {
            setError("Failed to save pasted files.");
        }
      } else {
        // No files found, maybe check for text path?
        try {
            const text = await navigator.clipboard.readText();
            if (text && text.trim().startsWith('/')) {
                 // Check if it's a valid path? 
                 // Maybe just suggest it?
                 // For now, let's just error if no files found.
                 setError("No file content found in clipboard. Copy an image or file first.");
            } else {
                 setError("No file content found in clipboard.");
            }
        } catch {
             setError("No file content found in clipboard.");
        }
      }

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Paste error:', err);
      setError(`Failed to read from clipboard: ${message}`);
    } finally {
      setLoading(false);
    }
  };

  const savePinnedFolderShortcuts = async (nextShortcuts: string[]) => {
    setPinnedFolderShortcuts(nextShortcuts);
    try {
      await updateConfig({ pinnedFolderShortcuts: nextShortcuts });
    } catch (err) {
      console.error('Failed to save pinned folder shortcuts:', err);
      setError('Failed to save pinned shortcuts');
    }
  };

  const handleTogglePinFolder = async (folderPath: string) => {
    setError(null);
    const alreadyPinned = pinnedFolderShortcuts.includes(folderPath);
    if (alreadyPinned) {
      await savePinnedFolderShortcuts(pinnedFolderShortcuts.filter((path) => path !== folderPath));
      return;
    }
    await savePinnedFolderShortcuts([...pinnedFolderShortcuts, folderPath]);
  };

  const handleThumbnailError = useCallback((filePath: string) => {
    setBrokenThumbnails((prev) => (prev[filePath] ? prev : { ...prev, [filePath]: true }));
  }, []);

  const handleConfirm = useCallback(async () => {
    if (selectedPaths.length === 0) return;
    await onConfirm(selectedPaths);
  }, [onConfirm, selectedPaths]);

  useDialogKeyboardShortcuts({
    onConfirm: handleConfirm,
    onDismiss: onCancel,
    canConfirm: selectedPaths.length > 0,
  });

  return (
    <div className={`fixed inset-0 ${zIndexClassName} flex items-center justify-center bg-black/50 backdrop-blur-sm p-4`}>
      <div className="bg-base-200 rounded-lg shadow-xl w-full max-w-5xl h-[82vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-base-300">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Folder className="w-5 h-5" />
            {title}
          </h2>
          <button onClick={onCancel} className="btn btn-sm btn-ghost btn-circle" title="Close file browser">
            ✕
          </button>
        </div>

        <div className="flex items-center gap-2 p-3 bg-base-300">
          <button
            onClick={handleGoUp}
            className="btn btn-sm btn-square btn-ghost"
            title="Go Up"
            disabled={!currentPath || getDirName(currentPath) === currentPath}
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <button
            onClick={handleGoHome}
            className="btn btn-sm btn-ghost gap-1"
            title={homePath ? `Go to Home Folder (${homePath})` : 'Go to Home Folder'}
            disabled={!homePath || currentPath === homePath}
          >
            <House className="w-4 h-4" />
            Home
          </button>
          <div className="flex-1 overflow-x-auto whitespace-nowrap px-2 font-mono text-sm">
            {currentPath}
          </div>
          <div className="join">
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={`btn btn-sm join-item ${viewMode === 'list' ? 'btn-active' : 'btn-ghost'}`}
              title="List view"
            >
              <List className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              className={`btn btn-sm join-item ${viewMode === 'grid' ? 'btn-active' : 'btn-ghost'}`}
              title="Grid view"
            >
              <Grid2x2 className="w-4 h-4" />
            </button>
          </div>
          <button
            onClick={handleConfirm}
            className="btn btn-sm btn-primary gap-2"
            disabled={selectedPaths.length === 0}
            title={confirmationLabel}
          >
            {confirmationLabel} ({selectedPaths.length})
          </button>
          
          {shouldShowPasteAction && (
            <>
              <div className="w-[1px] h-6 bg-base-content/10 mx-1"></div>

              <button
                onClick={handlePaste}
                className="btn btn-sm btn-ghost gap-2"
                title="Paste file/image from clipboard"
              >
                <Clipboard className="w-4 h-4" />
                Paste
              </button>
            </>
          )}
        </div>
        {pinnedFolderShortcuts.length > 0 && (
          <div className="px-3 py-2 border-b border-base-300 bg-base-200/50">
            <div className="flex items-center gap-2 overflow-x-auto">
              {pinnedFolderShortcuts.map((folderPath) => {
                const isCurrent = folderPath === currentPath;
                const label = getBaseName(folderPath) || folderPath;
                return (
                  <div key={folderPath} className="join shrink-0">
                    <button
                      type="button"
                      className={`btn btn-xs join-item ${isCurrent ? 'btn-primary' : 'btn-ghost'}`}
                      onClick={() => setCurrentPath(folderPath)}
                      title={folderPath}
                    >
                      <Folder className="w-3 h-3" />
                      {label}
                    </button>
                    <button
                      type="button"
                      className="btn btn-xs btn-ghost join-item"
                      onClick={() => void handleTogglePinFolder(folderPath)}
                      title={`Unpin ${folderPath}`}
                    >
                      <PinOff className="w-3 h-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex justify-center items-center h-full">
              <span className="loading loading-spinner loading-lg"></span>
            </div>
          ) : error ? (
            <div className="alert alert-error">{error}</div>
          ) : items.length === 0 ? (
            <div className="text-center text-base-content/50 mt-10">Empty directory</div>
          ) : viewMode === 'list' ? (
            <div className="grid grid-cols-1 gap-1">
              {items.map((item, index) => {
                const isSelected = selectedSet.has(item.path);
                const isSelectable = item.isDirectory || isAllowedFileType(item.name);
                return (
                  <div
                    key={item.path}
                    className={`flex items-center justify-between p-2 rounded-md cursor-pointer transition-colors border ${isSelected
                      ? 'bg-primary text-primary-content border-primary'
                      : 'hover:bg-base-100 border-transparent'
                      } ${!isSelectable ? 'opacity-50' : ''}`}
                    onClick={(e) => handleItemClick(item, index, e)}
                    title={item.path}
                  >
                    <div className="flex items-center gap-3 overflow-hidden">
                      {item.isDirectory ? (
                        <Folder className="w-5 h-5 shrink-0" />
                      ) : (
                        <FileText className="w-5 h-5 shrink-0" />
                      )}
                      <span className="truncate">{item.name}</span>
                    </div>
                    <span className="text-[10px] opacity-70 shrink-0">
                      {item.isDirectory ? (
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs h-6 min-h-6"
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleTogglePinFolder(item.path);
                          }}
                          title={pinnedFolderShortcuts.includes(item.path) ? 'Unpin folder' : 'Pin folder'}
                        >
                          <Pin className={`w-3 h-3 ${pinnedFolderShortcuts.includes(item.path) ? 'fill-current' : ''}`} />
                        </button>
                      ) : isSelectable ? 'file' : 'unsupported'}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-4">
              {items.map((item, index) => {
                const isSelected = selectedSet.has(item.path);
                const isImage = !item.isDirectory && isImageFile(item.name);
                const isSelectable = item.isDirectory || isAllowedFileType(item.name);
                const isPinned = pinnedFolderShortcuts.includes(item.path);
                const isThumbnailBroken = Boolean(brokenThumbnails[item.path]);

                return (
                  <GridFileTile
                    key={item.path}
                    item={item}
                    isSelected={isSelected}
                    isImage={isImage}
                    isSelectable={isSelectable}
                    isPinned={isPinned}
                    isThumbnailBroken={isThumbnailBroken}
                    onItemClick={(e) => handleItemClick(item, index, e)}
                    onPinClick={(e) => {
                      e.stopPropagation();
                      void handleTogglePinFolder(item.path);
                    }}
                    onThumbnailError={() => handleThumbnailError(item.path)}
                  />
                );
              })}
            </div>
          )}
        </div>

        <div className="p-3 border-t border-base-300 text-xs text-base-content/60 text-center">
          {selectionInstruction}
        </div>
      </div>
    </div>
  );
}
