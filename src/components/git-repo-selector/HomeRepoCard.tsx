import { ChevronRight, FolderGit2, Settings, X, GitBranch as GitBranchIcon } from 'lucide-react';
import Image from 'next/image';
import type { MouseEvent } from 'react';
import { getBaseName } from '@/lib/path';
import { getStableRepoCardGradient } from '@/lib/repo-card-gradient';

export type HomeRepoCardProps = {
  repo: string;
  isDarkThemeActive: boolean;
  credentialLabel: string;
  runningSessionCount: number;
  draftCount: number;
  repoIconPath: string | null;
  showRepoIcon: boolean;
  onSelectRepo: (repo: string) => void | Promise<boolean>;
  onOpenGitWorkspace: (repo: string) => void;
  onOpenRepoSettings: (event: MouseEvent, repo: string) => void | Promise<void>;
  onRemoveRecent: (event: MouseEvent, repo: string) => void;
  onRepoIconError: (repo: string) => void;
  onMouseMove: (event: MouseEvent<HTMLDivElement>) => void;
  onMouseLeave: (event: MouseEvent<HTMLDivElement>) => void;
};

export function HomeRepoCard({
  repo,
  isDarkThemeActive,
  credentialLabel,
  runningSessionCount,
  draftCount,
  repoIconPath,
  showRepoIcon,
  onSelectRepo,
  onOpenGitWorkspace,
  onOpenRepoSettings,
  onRemoveRecent,
  onRepoIconError,
  onMouseMove,
  onMouseLeave,
}: HomeRepoCardProps) {
  const repoName = getBaseName(repo);
  const cardGradient = getStableRepoCardGradient(repoName);
  const repoIconUrl = repoIconPath
    ? `/api/file-thumbnail?path=${encodeURIComponent(repoIconPath)}`
    : null;

  return (
    <div
      onClick={() => void onSelectRepo(repo)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void onSelectRepo(repo);
        }
      }}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      role="button"
      tabIndex={0}
      className="repo-card-tilt-wrapper group relative h-[248px] cursor-pointer text-left transition-transform duration-200"
    >
      <div
        className="repo-card-tilt relative h-full overflow-hidden rounded-2xl border border-white/70 bg-white/55 dark:border-slate-700/40 dark:bg-[#141a25]/64 dark:hover:border-slate-600/55"
        style={isDarkThemeActive ? undefined : cardGradient}
      >
        <div className="absolute inset-0 bg-white/38 dark:bg-[#141a25]/58" />
        <div className="repo-card-tilt-content relative flex h-full flex-col justify-between p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="relative flex items-center">
              <div className="repo-card-tilt-icon flex h-10 w-10 items-center justify-center rounded-xl bg-white/90 text-slate-700 shadow-sm dark:border dark:border-white/10 dark:bg-[#1e2532] dark:text-slate-200">
                {showRepoIcon && repoIconUrl ? (
                  <Image
                    src={repoIconUrl}
                    alt={`${repoName} icon`}
                    width={24}
                    height={24}
                    className="h-6 w-6 rounded-md object-cover"
                    unoptimized
                    onError={() => onRepoIconError(repo)}
                  />
                ) : (
                  <FolderGit2 className="h-5 w-5" />
                )}
              </div>
              <div className="absolute -top-2 -right-4 z-10 flex gap-1">
                {draftCount > 0 && (
                  <span
                    className="inline-flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-white bg-blue-500 px-1.5 text-[11px] font-bold text-white shadow-sm dark:border-[#141a25]"
                    title={`${draftCount} draft${draftCount === 1 ? '' : 's'}`}
                  >
                    {draftCount}
                  </span>
                )}
                {runningSessionCount > 0 && (
                  <span
                    className="inline-flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-white bg-emerald-500 px-1.5 text-[11px] font-bold text-white shadow-sm dark:border-[#141a25]"
                    title={`${runningSessionCount} running session${runningSessionCount === 1 ? '' : 's'}`}
                    style={draftCount > 0 ? { marginLeft: '-0.5rem' } : {}}
                  >
                    {runningSessionCount}
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenGitWorkspace(repo);
                }}
                className="btn btn-circle btn-xs border-0 bg-white/70 text-slate-600 opacity-0 shadow-none transition-opacity hover:bg-white hover:text-slate-900 group-hover:opacity-100 dark:bg-[#1e2532]/90 dark:text-slate-300 dark:hover:bg-[#252d3d] dark:hover:text-white"
                title="Open Git Workspace"
              >
                <GitBranchIcon className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={(event) => {
                  void onOpenRepoSettings(event, repo);
                }}
                className="btn btn-circle btn-xs border-0 bg-white/70 text-slate-600 opacity-0 shadow-none transition-opacity hover:bg-white hover:text-slate-900 group-hover:opacity-100 dark:bg-[#1e2532]/90 dark:text-slate-300 dark:hover:bg-[#252d3d] dark:hover:text-white"
                title="Repository settings"
              >
                <Settings className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={(event) => onRemoveRecent(event, repo)}
                className="btn btn-circle btn-xs border-0 bg-white/70 text-slate-500 opacity-0 shadow-none transition-opacity hover:bg-white hover:text-rose-600 group-hover:opacity-100 dark:bg-[#1e2532]/90 dark:text-slate-400 dark:hover:bg-[#252d3d] dark:hover:text-rose-300"
                title="Remove from history"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="truncate text-lg font-bold text-slate-900 dark:text-white">
              {repoName}
            </h3>
            <p className="truncate font-mono text-xs text-slate-600 dark:text-slate-300">{repo}</p>
            <p className="truncate text-[11px] font-medium text-slate-500 dark:text-slate-400">
              Credential: {credentialLabel}
            </p>
          </div>

          <div className="flex items-center justify-between text-sm font-semibold text-slate-700 dark:text-slate-200">
            <span>Open repository</span>
            <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </div>
        </div>
      </div>
    </div>
  );
}
