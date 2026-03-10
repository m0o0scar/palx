import { ChevronRight, FolderGit2, Settings, X, GitBranch as GitBranchIcon } from 'lucide-react';
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { getBaseName } from '@/lib/path';
import { getStableRepoCardGradient } from '@/lib/repo-card-gradient';

export type HomeRepoCardProps = {
  project: string;
  projectDisplayName?: string;
  isDarkThemeActive: boolean;
  runningSessionCount: number;
  draftCount: number;
  projectIconPath: string | null;
  showProjectIcon: boolean;
  projectGitRepos?: string[];
  isDiscoveringProjectGitRepos: boolean;
  onSelectProject: (project: string) => void | Promise<boolean>;
  onOpenGitWorkspace: (project: string, repoPath?: string) => void;
  onOpenProjectSettings: (event: ReactMouseEvent, project: string) => void | Promise<void>;
  onRemoveRecent: (event: ReactMouseEvent, project: string) => void;
  onProjectIconError: (project: string) => void;
  onMouseMove: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onMouseLeave: (event: ReactMouseEvent<HTMLDivElement>) => void;
};

function normalizePathForComparison(pathValue: string): string {
  return pathValue.replace(/\\/g, '/').replace(/\/+$/, '');
}

function toProjectRelativeRepoPath(projectPath: string, repoPath: string): string {
  const normalizedProjectPath = normalizePathForComparison(projectPath);
  const normalizedRepoPath = normalizePathForComparison(repoPath);

  if (!normalizedProjectPath || !normalizedRepoPath) return repoPath;
  if (normalizedRepoPath === normalizedProjectPath) return '.';

  const projectPrefix = `${normalizedProjectPath}/`;
  if (normalizedRepoPath.startsWith(projectPrefix)) {
    return normalizedRepoPath.slice(projectPrefix.length);
  }

  return repoPath;
}

export function HomeRepoCard({
  project,
  projectDisplayName,
  isDarkThemeActive,
  runningSessionCount,
  draftCount,
  projectIconPath,
  showProjectIcon,
  projectGitRepos,
  isDiscoveringProjectGitRepos,
  onSelectProject,
  onOpenGitWorkspace,
  onOpenProjectSettings,
  onRemoveRecent,
  onProjectIconError,
  onMouseMove,
  onMouseLeave,
}: HomeRepoCardProps) {
  const projectName = projectDisplayName || getBaseName(project);
  const cardGradient = getStableRepoCardGradient(normalizePathForComparison(project));
  const [isGitRepoMenuOpen, setIsGitRepoMenuOpen] = useState(false);
  const gitRepoMenuRef = useRef<HTMLDivElement | null>(null);
  const projectIconUrl = projectIconPath
    ? `/api/file-thumbnail?path=${encodeURIComponent(projectIconPath)}`
    : null;
  const discoveredProjectGitRepos = projectGitRepos ?? [];
  const hasDiscoveredGitRepos = Array.isArray(projectGitRepos);
  const hasGitRepos = discoveredProjectGitRepos.length > 0;
  const hasMultipleGitRepos = discoveredProjectGitRepos.length > 1;

  useEffect(() => {
    if (!isGitRepoMenuOpen) return;
    const handleDocumentClick = (event: globalThis.MouseEvent) => {
      if (gitRepoMenuRef.current?.contains(event.target as Node)) return;
      setIsGitRepoMenuOpen(false);
    };
    document.addEventListener('mousedown', handleDocumentClick);
    return () => {
      document.removeEventListener('mousedown', handleDocumentClick);
    };
  }, [isGitRepoMenuOpen]);

  return (
    <div
      onClick={() => void onSelectProject(project)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          void onSelectProject(project);
        }
      }}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      role="button"
      tabIndex={0}
      className="repo-card-tilt-wrapper group relative h-[248px] cursor-pointer text-left transition-transform duration-200"
    >
      <div
        className="repo-card-tilt relative h-full overflow-hidden rounded-2xl border border-white/50 bg-white/30 backdrop-blur-xl backdrop-saturate-150 dark:border-white/10 dark:bg-white/5 dark:backdrop-saturate-125 dark:hover:border-white/20"
        style={isDarkThemeActive ? undefined : cardGradient}
      >
        <div className="absolute inset-0 bg-white/20 dark:bg-slate-900/20" />
        <div className="repo-card-tilt-content relative flex h-full flex-col justify-between p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="relative flex items-center">
              <div className="repo-card-tilt-icon flex h-10 w-10 items-center justify-center rounded-xl bg-white/60 text-slate-700 shadow-sm backdrop-blur-sm dark:border dark:border-white/15 dark:bg-white/10 dark:text-slate-200">
                {showProjectIcon && projectIconUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={projectIconUrl}
                    alt={`${projectName} icon`}
                    className="h-6 w-6 rounded-md object-cover"
                    onError={() => onProjectIconError(project)}
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
              <div className="relative" ref={gitRepoMenuRef}>
                <button
                  onClick={(event) => {
                    event.stopPropagation();
                    if (isDiscoveringProjectGitRepos) return;
                    if (hasDiscoveredGitRepos && !hasGitRepos) return;
                    if (!hasMultipleGitRepos) {
                      onOpenGitWorkspace(project);
                      return;
                    }
                    setIsGitRepoMenuOpen((previous) => !previous);
                  }}
                  className="btn btn-circle btn-xs border-0 bg-white/50 text-slate-600 opacity-0 shadow-none backdrop-blur-sm transition-opacity hover:bg-white/80 hover:text-slate-900 group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-80 disabled:hover:bg-white/50 dark:bg-white/10 dark:text-slate-300 dark:hover:bg-white/20 dark:hover:text-white dark:disabled:hover:bg-white/10"
                  title={isDiscoveringProjectGitRepos
                    ? 'Discovering repositories...'
                    : hasDiscoveredGitRepos && !hasGitRepos
                      ? 'No Git repositories found in this project'
                    : hasMultipleGitRepos
                        ? 'Select a repository'
                        : 'Open Git Workspace'}
                  disabled={isDiscoveringProjectGitRepos || (hasDiscoveredGitRepos && !hasGitRepos)}
                >
                  <GitBranchIcon className="h-3.5 w-3.5" />
                </button>
                {hasMultipleGitRepos && isGitRepoMenuOpen && (
                  <div className="absolute right-0 top-8 z-30 max-h-56 w-52 overflow-auto rounded-lg border border-slate-200 bg-white p-1 shadow-xl dark:border-[#30363d] dark:bg-[#161b22]">
                    {discoveredProjectGitRepos.map((repoPath) => {
                      const relativeRepoPath = toProjectRelativeRepoPath(project, repoPath);
                      return (
                        <button
                          key={repoPath}
                          type="button"
                          className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-[#30363d]/70"
                          title={repoPath}
                          onClick={(event) => {
                            event.stopPropagation();
                            setIsGitRepoMenuOpen(false);
                            onOpenGitWorkspace(project, repoPath);
                          }}
                        >
                          <span className="truncate">{relativeRepoPath}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <button
                onClick={(event) => {
                  void onOpenProjectSettings(event, project);
                }}
                className="btn btn-circle btn-xs border-0 bg-white/50 text-slate-600 opacity-0 shadow-none backdrop-blur-sm transition-opacity hover:bg-white/80 hover:text-slate-900 group-hover:opacity-100 dark:bg-white/10 dark:text-slate-300 dark:hover:bg-white/20 dark:hover:text-white"
                title="Project settings"
              >
                <Settings className="h-3.5 w-3.5" />
              </button>
              <button
                onClick={(event) => onRemoveRecent(event, project)}
                className="btn btn-circle btn-xs border-0 bg-white/50 text-slate-500 opacity-0 shadow-none backdrop-blur-sm transition-opacity hover:bg-white/80 hover:text-rose-600 group-hover:opacity-100 dark:bg-white/10 dark:text-slate-400 dark:hover:bg-white/20 dark:hover:text-rose-300"
                title="Remove from history"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="truncate text-lg font-bold text-slate-900 dark:text-white">
              {projectName}
            </h3>
            <p className="truncate font-mono text-xs text-slate-600 dark:text-slate-300">{project}</p>
          </div>

          <div className="flex items-center justify-between text-sm font-semibold text-slate-700 dark:text-slate-200">
            <span>Open project</span>
            <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </div>
        </div>
      </div>
    </div>
  );
}
