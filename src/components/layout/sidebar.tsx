'use client';

import { cn, getRepoFolderName, getRepositoryDisplayName } from '@/lib/utils';
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useState, useEffect, useCallback } from 'react';
import { useGitStatus, useRepository, useUpdateSettings } from '@/hooks/use-git';

const SIDEBAR_COLLAPSED_KEY = 'workspace-sidebar-collapsed';
const SIDEBAR_WIDTH_EXPANDED = 256; // w-64
const SIDEBAR_WIDTH_COLLAPSED = 64; // w-16

type SidebarProps = React.HTMLAttributes<HTMLDivElement>;
type SidebarPropsWithInitialState = SidebarProps & {
  initialCollapsed?: boolean;
};

export function Sidebar({ className, initialCollapsed = false }: SidebarPropsWithInitialState) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const repoPath = searchParams.get('path') || '';
  const repository = useRepository(repoPath || null);
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed);
  const [enableTransition, setEnableTransition] = useState(false);

  const updateSettings = useUpdateSettings();

  // Fetch git status to get uncommitted changes count
  const { data: gitStatus } = useGitStatus(repoPath || null);
  const changesCount = gitStatus?.files?.length ?? 0;
  const currentBranch = gitStatus?.current?.trim();
  const repoDisplayName = repository
    ? getRepositoryDisplayName(repository)
    : (repoPath ? getRepoFolderName(repoPath) : '');

  // Enable transitions only after initial paint to avoid first-load animation.
  useEffect(() => {
    let frame2: number | null = null;
    const frame1 = requestAnimationFrame(() => {
      frame2 = requestAnimationFrame(() => {
        setEnableTransition(true);
      });
    });

    return () => {
      cancelAnimationFrame(frame1);
      if (frame2 !== null) {
        cancelAnimationFrame(frame2);
      }
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(isCollapsed));
  }, [isCollapsed]);

  // Save collapsed state to global settings and localStorage
  const toggleCollapsed = useCallback(() => {
    const newValue = !isCollapsed;
    setIsCollapsed(newValue);

    updateSettings.mutate({ sidebarCollapsed: newValue });
  }, [isCollapsed, updateSettings]);

  const getHref = (subPath: string = '') => {
    const p = new URLSearchParams(searchParams.toString());
    // Clean up tab if it exists from previous version, though we are moving away from it.
    p.delete('tab');
    if (repoPath && currentBranch) {
      p.set('branch', currentBranch);
    } else if (!repoPath) {
      p.delete('branch');
    }
    return `/git${subPath}?${p.toString()}`;
  };

  const isActive = (view: 'status' | 'history' | 'custom-scripts' | 'stashes') => {
    if (view === 'status') return pathname === '/git/changes';
    if (view === 'history') return pathname === '/git' || pathname.startsWith('/git/history');
    if (view === 'custom-scripts') return pathname.startsWith('/git/custom-scripts');
    if (view === 'stashes') return pathname.startsWith('/git/stashes');
    return false;
  };

  // Calculate width
  const sidebarWidth = isCollapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED;

  return (
    <div
      style={{
        width: sidebarWidth
      }}
      className={cn(
        "pb-12 border-r border-gray-200 dark:border-[#30363d] min-h-screen bg-gray-50 dark:bg-[#22272e] relative",
        enableTransition && "transition-all duration-300",
        className
      )}
    >
      <div className="space-y-4 py-4">
        <div className={cn("px-3 py-2", isCollapsed && "px-2")}>
          <div className={cn("mb-6 flex items-center", isCollapsed ? "flex-col gap-2 px-0" : "justify-between")}>
            {!isCollapsed && (
              <div className="flex min-w-0 items-center gap-2 text-gray-900 dark:text-gray-100">
                <Link
                  href="/"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-200 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100 transition-colors"
                  title={repoDisplayName ? `${repoDisplayName} - Go to Home` : "Go to Home"}
                  aria-label="Go to Home"
                >
                  <i className="iconoir-arrow-left text-[16px]" aria-hidden="true" />
                </Link>
                <h2 className="text-lg font-bold tracking-tight truncate" title={repoDisplayName || "Trident"}>
                  {repoDisplayName || "Trident"}
                </h2>
              </div>
            )}
            {isCollapsed && (
              <Link
                href="/"
                className="flex items-center justify-center h-8 min-w-0 px-1 hover:opacity-80 transition-opacity cursor-pointer text-gray-900 dark:text-gray-100"
                title={repoDisplayName ? `${repoDisplayName} - Go to Home` : "Go to Home"}
              >
                <span className="text-sm font-semibold truncate">
                  {(repoDisplayName || "T").charAt(0).toUpperCase()}
                </span>
              </Link>
            )}
            <div className={cn("flex items-center gap-1", isCollapsed && "flex-col")}>
              <button
                className="flex h-8 w-8 items-center justify-center rounded-md text-gray-500 hover:bg-gray-200 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100 transition-colors"
                onClick={toggleCollapsed}
                title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              >
                {isCollapsed ? <i className="iconoir-fast-arrow-right text-[16px]" aria-hidden="true" /> : <i className="iconoir-fast-arrow-left text-[16px]" aria-hidden="true" />}
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <Link
              href={getHref()}
              className={cn(
                "flex items-center w-full rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isCollapsed ? "justify-center px-0 py-3" : "justify-start",
                isActive('history')
                  ? "bg-gray-200 text-gray-900 dark:bg-[#2d333b] dark:text-white"
                  : "text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-[#2d333b]/70 dark:hover:text-white"
              )}
              title={isCollapsed ? "History" : undefined}
            >
              <i className={cn("iconoir-git-fork text-[20px]", !isCollapsed && "mr-2")} aria-hidden="true" />
              {!isCollapsed && "History"}
            </Link>

            <Link
              href={getHref('/changes')}
              className={cn(
                "flex items-center w-full rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isCollapsed ? "justify-center px-0 py-3" : "justify-start",
                isActive('status')
                  ? "bg-gray-200 text-gray-900 dark:bg-[#2d333b] dark:text-white"
                  : "text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-[#2d333b]/70 dark:hover:text-white"
              )}
              title={isCollapsed ? `Changes${changesCount > 0 ? ` (${changesCount})` : ''}` : undefined}
            >
              <div className={cn("relative flex items-center", !isCollapsed && "mr-2")}>
                <i className="iconoir-clock text-[20px]" aria-hidden="true" />
                {isCollapsed && changesCount > 0 && (
                  <span className="absolute -top-1 -right-1 badge badge-primary badge-xs scale-75">
                    {changesCount > 99 ? '99+' : changesCount}
                  </span>
                )}
              </div>
              {!isCollapsed && (
                <span className="flex-1 flex justify-between items-center">
                  Changes
                  {changesCount > 0 && <span className="inline-flex items-center justify-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">{changesCount}</span>}
                </span>
              )}
            </Link>

            <Link
              href={getHref('/stashes')}
              className={cn(
                "flex items-center w-full rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isCollapsed ? "justify-center px-0 py-3" : "justify-start",
                isActive('stashes')
                  ? "bg-gray-200 text-gray-900 dark:bg-[#2d333b] dark:text-white"
                  : "text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-[#2d333b]/70 dark:hover:text-white"
              )}
              title={isCollapsed ? "Stashes" : undefined}
            >
              <i className={cn("iconoir-download-square text-[20px]", !isCollapsed && "mr-2")} aria-hidden="true" />
              {!isCollapsed && "Stashes"}
            </Link>

            <Link
              href={getHref('/custom-scripts')}
              className={cn(
                "flex items-center w-full rounded-md px-3 py-2 text-sm font-medium transition-colors",
                isCollapsed ? "justify-center px-0 py-3" : "justify-start",
                isActive('custom-scripts')
                  ? "bg-gray-200 text-gray-900 dark:bg-[#2d333b] dark:text-white"
                  : "text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-[#2d333b]/70 dark:hover:text-white"
              )}
              title={isCollapsed ? "Custom scripts" : undefined}
            >
              <i className={cn("iconoir-terminal text-[20px]", !isCollapsed && "mr-2")} aria-hidden="true" />
              {!isCollapsed && "Custom scripts"}
            </Link>
          </div>
        </div>
      </div>

    </div>
  );
}
