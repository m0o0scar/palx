'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { checkDirectoryAccessible, listDirectories, getHomeDirectory } from '@/app/actions/git';
import { Folder, ArrowLeft, Check } from 'lucide-react';
import { getDirName } from '@/lib/path';
import { useDialogKeyboardShortcuts } from '@/hooks/useDialogKeyboardShortcuts';

interface FileSystemItem {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo: boolean;
}

interface FileBrowserProps {
  title?: string;
  initialPath?: string;
  onSelect: (path: string) => void | Promise<unknown>;
  onCancel: () => void;
  checkRepo?: (path: string) => Promise<boolean>;
}

export default function FileBrowser({ title, initialPath, onSelect, onCancel, checkRepo }: FileBrowserProps) {
  const [currentPath, setCurrentPath] = useState<string>('');
  const [homePath, setHomePath] = useState<string>('');
  const [items, setItems] = useState<FileSystemItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const init = async () => {
      try {
        const home = await getHomeDirectory();
        if (!isMounted) return;

        setHomePath(home);
        setCurrentPath(initialPath || home);
      } catch (err) {
        console.error('Failed to resolve home directory:', err);
        if (!isMounted) return;
        setError('Failed to access your home directory.');
        setCurrentPath(initialPath || '/');
      }
    };

    void init();

    return () => {
      isMounted = false;
    };
  }, [initialPath]);

  useEffect(() => {
    if (!currentPath) return;

    let isMounted = true;

    const fetchItems = async () => {
      setLoading(true);
      setError(null);
      try {
        const dirs = await listDirectories(currentPath);
        if (!isMounted) return;

        if (dirs.length === 0 && homePath && currentPath !== homePath) {
          const accessible = await checkDirectoryAccessible(currentPath);
          if (!isMounted) return;

          if (!accessible) {
            setError(`Could not access "${currentPath}". Showing home directory.`);
            setCurrentPath(homePath);
            return;
          }
        }

        const mapped: FileSystemItem[] = dirs.map(d => ({
          name: d.name,
          path: d.path,
          isDirectory: d.isDirectory,
          isGitRepo: d.isGitRepo
        }));
        setItems(mapped);
      } catch (err) {
        console.error(err);
        if (!isMounted) return;

        if (homePath && currentPath !== homePath) {
          setError(`Could not access "${currentPath}". Showing home directory.`);
          setCurrentPath(homePath);
          return;
        }

        setItems([]);
        setError('Failed to load directory contents');
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    };

    void fetchItems();

    return () => {
      isMounted = false;
    };
  }, [currentPath, homePath]);

  const handleSelectPath = useCallback(async (path: string) => {
    if (checkRepo) {
      const isValid = await checkRepo(path);
      if (!isValid) {
        setError("Selected directory is not a valid git repository.");
        // Clear error after 3 seconds
        setTimeout(() => setError(null), 3000);
        return;
      }
    }
    await onSelect(path);
  }, [checkRepo, onSelect]);

  const handleSelect = useCallback(async () => {
    await handleSelectPath(currentPath);
  }, [currentPath, handleSelectPath]);

  useDialogKeyboardShortcuts({
    onConfirm: handleSelect,
    onDismiss: onCancel,
    canConfirm: Boolean(currentPath),
  });

  const handleNavigate = (path: string) => {
    setCurrentPath(path);
  };

  const handleGoUp = () => {
    // Navigate up one directory
    // Use getDirName to extract the parent directory from the current path.
    const parent = getDirName(currentPath);
    if (parent && parent !== currentPath) {
      setCurrentPath(parent);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-base-200 rounded-lg shadow-xl w-full max-w-3xl h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-base-300">
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Folder className="w-5 h-5" />
            {title || "Browse Local Folder"}
          </h2>
          <button onClick={onCancel} className="btn btn-sm btn-ghost btn-circle">
            ✕
          </button>
        </div>

        {/* Current Path Bar */}
        <div className="flex items-center gap-2 p-3 bg-base-300">
          <button
            onClick={handleGoUp}
            className="btn btn-sm btn-square btn-ghost"
            title="Go Up"
            disabled={!currentPath || getDirName(currentPath) === currentPath}
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="flex-1 overflow-x-auto whitespace-nowrap px-2 font-mono text-sm">
            {currentPath}
          </div>
          <button
            onClick={handleSelect}
            className="btn btn-sm btn-primary"
          >
            Select Current Folder
          </button>
        </div>

        {/* List Content */}
        <div className="flex-1 overflow-y-auto p-2">
          {loading ? (
            <div className="flex justify-center items-center h-full">
              <span className="loading loading-spinner loading-lg"></span>
            </div>
          ) : error ? (
            <div className="alert alert-error">{error}</div>
          ) : items.length === 0 ? (
            <div className="text-center text-base-content/50 mt-10">Empty directory</div>
          ) : (
            <div className="grid grid-cols-1 gap-1">
              {items.map((item) => (
                <div
                  key={item.path}
                  className="group flex items-center justify-between p-2 hover:bg-base-100 rounded-md cursor-pointer transition-colors"
                  onClick={() => handleNavigate(item.path)}
                >
                  <div className="flex items-center gap-3 overflow-hidden">
                    <Folder className={`w-5 h-5 ${item.isGitRepo ? 'text-primary' : 'text-base-content/70'}`} />
                    <span className="truncate">{item.name}</span>
                    {item.isGitRepo && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-200 text-slate-600 border border-slate-300 uppercase tracking-wide">
                        GIT
                      </span>
                    )}
                  </div>
                  <button
                    className="flex items-center justify-center p-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary hover:text-white transition-colors"
                    onClick={(e) => {
                      e.stopPropagation();
                      void handleSelectPath(item.path);
                    }}
                    title={`Select ${item.name}`}
                  >
                    <Check className="h-[18px] w-[18px]" />
                    <span className="sr-only">Select</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Footer info */}
        <div className="p-3 border-t border-base-300 text-xs text-base-content/50 text-center">
          Navigate to a folder and click &quot;Select Current Folder&quot; to choose it.
        </div>
      </div>
    </div>
  );
}
