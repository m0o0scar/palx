import { KeyRound, LogOut, Plus, Search } from 'lucide-react';
import Image from 'next/image';
import type { ComponentType, MouseEvent } from 'react';
import { HomeRepoCard } from './HomeRepoCard';

export type HomeDashboardProps = {
  error: string | null;
  isLoaded: boolean;
  homeSearchQuery: string;
  showLogout: boolean;
  logoutEnabled: boolean;
  themeModeLabel: string;
  nextThemeModeLabel: string;
  ThemeModeIcon: ComponentType<{ className?: string }>;
  filteredRecentProjects: string[];
  isDarkThemeActive: boolean;
  runningSessionCountByProject: Map<string, number>;
  draftCountByProject: Map<string, number>;
  projectCardIconByPath: Record<string, string | null>;
  brokenProjectCardIcons: Record<string, boolean>;
  projectGitReposByPath: Record<string, string[]>;
  discoveringProjectGitRepos: Record<string, boolean>;
  getProjectDisplayName: (project: string) => string;
  onHomeSearchQueryChange: (value: string) => void;
  onOpenCredentials: () => void;
  onCycleThemeMode: () => void;
  onSelectProject: (project: string) => void | Promise<boolean>;
  onOpenGitWorkspace: (project: string, repoPath?: string) => void;
  onOpenProjectSettings: (event: MouseEvent, project: string) => void | Promise<void>;
  onRemoveRecent: (event: MouseEvent, project: string) => void;
  onProjectIconError: (project: string) => void;
  onRepoCardMouseMove: (event: MouseEvent<HTMLDivElement>) => void;
  onRepoCardMouseLeave: (event: MouseEvent<HTMLDivElement>) => void;
  onAddProject: () => void;
};

export function HomeDashboard({
  error,
  isLoaded,
  homeSearchQuery,
  showLogout,
  logoutEnabled,
  themeModeLabel,
  nextThemeModeLabel,
  ThemeModeIcon,
  filteredRecentProjects,
  isDarkThemeActive,
  runningSessionCountByProject,
  draftCountByProject,
  projectCardIconByPath,
  brokenProjectCardIcons,
  projectGitReposByPath,
  discoveringProjectGitRepos,
  getProjectDisplayName,
  onHomeSearchQueryChange,
  onOpenCredentials,
  onCycleThemeMode,
  onSelectProject,
  onOpenGitWorkspace,
  onOpenProjectSettings,
  onRemoveRecent,
  onProjectIconError,
  onRepoCardMouseMove,
  onRepoCardMouseLeave,
  onAddProject,
}: HomeDashboardProps) {
  return (
    <div className="w-full max-w-7xl">
      <header className="relative z-10 flex flex-col gap-4 rounded-xl border border-white/50 bg-white/40 px-4 py-4 shadow-[0_8px_32px_-8px_rgba(15,23,42,0.15)] backdrop-blur-xl backdrop-saturate-150 transition-colors md:flex-row md:items-center md:justify-between md:px-7 dark:border-white/10 dark:bg-slate-900/30 dark:shadow-[0_8px_32px_-8px_rgba(0,0,0,0.5)]">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/60 shadow-sm backdrop-blur-sm dark:border dark:border-white/10 dark:bg-white/10">
            <Image src="/palx-icon.png" alt="Palx" width={22} height={22} className="rounded-sm" />
          </div>
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-white">Palx</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">AI Coding Agent Dashboard</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="input input-sm flex w-full items-center gap-2 border-white/40 bg-white/50 text-slate-700 shadow-none backdrop-blur-sm transition-colors md:w-72 dark:border-white/10 dark:bg-white/10 dark:text-slate-200">
            <Search className="h-4 w-4 text-slate-400 dark:text-slate-500" />
            <input
              type="text"
              className="grow text-sm placeholder:text-slate-400 dark:placeholder:text-slate-500"
              placeholder="Search projects..."
              value={homeSearchQuery}
              onChange={(event) => onHomeSearchQueryChange(event.target.value)}
            />
          </label>
          <button
            className="btn btn-ghost btn-sm gap-2 text-slate-700 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
            onClick={onOpenCredentials}
            title="Manage GitHub/GitLab credentials"
          >
            <KeyRound className="h-4 w-4" />
            Credentials
          </button>
          {showLogout && (
            logoutEnabled ? (
              <a
                href="/auth/logout"
                className="btn btn-ghost btn-sm gap-2 text-slate-700 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
                title="Log out"
              >
                <LogOut className="h-4 w-4" />
                Logout
              </a>
            ) : (
              <button
                type="button"
                className="btn btn-ghost btn-sm gap-2 text-slate-500 dark:text-slate-400"
                title="Logout is unavailable because Auth0 is not configured"
                disabled
              >
                <LogOut className="h-4 w-4" />
                Logout
              </button>
            )
          )}
          <button
            className="btn btn-ghost btn-sm btn-square text-slate-700 dark:border dark:border-white/10 dark:bg-white/10 dark:text-slate-300 dark:hover:bg-white/20 dark:hover:text-white"
            onClick={onCycleThemeMode}
            title={`Theme mode: ${themeModeLabel}. Click to switch to ${nextThemeModeLabel}.`}
            aria-label={`Theme mode: ${themeModeLabel}. Click to switch to ${nextThemeModeLabel}.`}
          >
            <ThemeModeIcon className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="relative z-10 px-1 py-5 md:py-7">
        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/50 dark:bg-red-950/40 dark:text-red-200">
            {error}
          </div>
        )}

        {!isLoaded ? (
          <div className="flex h-56 items-center justify-center rounded-2xl border border-white/40 bg-white/25 backdrop-blur-lg dark:border-white/10 dark:bg-white/5">
            <span className="loading loading-spinner loading-md text-primary"></span>
          </div>
        ) : filteredRecentProjects.length === 0 ? (
          <div className="flex h-56 flex-col items-center justify-center rounded-2xl border border-white/40 bg-white/25 text-center backdrop-blur-lg dark:border-white/10 dark:bg-white/5">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {homeSearchQuery.trim() ? 'No projects match your search.' : 'No recent projects found.'}
            </p>
            {!homeSearchQuery.trim() && (
              <button className="btn btn-primary btn-sm mt-3 gap-2" onClick={onAddProject}>
                <Plus className="h-4 w-4" />
                Add your first project
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
            {filteredRecentProjects.map((project) => (
              <HomeRepoCard
                key={project}
                project={project}
                projectDisplayName={getProjectDisplayName(project)}
                isDarkThemeActive={isDarkThemeActive}
                runningSessionCount={runningSessionCountByProject.get(project) ?? 0}
                draftCount={draftCountByProject.get(project) ?? 0}
                projectIconPath={projectCardIconByPath[project] ?? null}
                showProjectIcon={!!projectCardIconByPath[project] && !brokenProjectCardIcons[project]}
                projectGitRepos={projectGitReposByPath[project]}
                isDiscoveringProjectGitRepos={!!discoveringProjectGitRepos[project]}
                onSelectProject={onSelectProject}
                onOpenGitWorkspace={onOpenGitWorkspace}
                onOpenProjectSettings={onOpenProjectSettings}
                onRemoveRecent={onRemoveRecent}
                onProjectIconError={onProjectIconError}
                onMouseMove={onRepoCardMouseMove}
                onMouseLeave={onRepoCardMouseLeave}
              />
            ))}

            <button
              onClick={onAddProject}
              className="group flex h-[248px] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-white/50 bg-white/25 text-slate-600 backdrop-blur-lg backdrop-saturate-150 transition-all duration-200 hover:-translate-y-1 hover:border-primary/50 hover:bg-white/45 dark:border-white/10 dark:bg-white/5 dark:text-slate-400 dark:hover:border-white/20 dark:hover:bg-white/10"
            >
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/70 shadow-sm backdrop-blur-sm transition-transform group-hover:scale-105 dark:border dark:border-white/10 dark:bg-white/10">
                <Plus className="h-7 w-7 text-slate-400 transition-colors group-hover:text-primary" />
              </span>
              <span className="text-lg font-semibold transition-colors group-hover:text-primary">
                Add Project
              </span>
              <span className="text-sm text-slate-400 dark:text-slate-500">Import from local folder or git URL</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
