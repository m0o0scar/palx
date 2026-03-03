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
  filteredRecentRepos: string[];
  isDarkThemeActive: boolean;
  runningSessionCountByRepo: Map<string, number>;
  draftCountByRepo: Map<string, number>;
  repoCardIconByRepo: Record<string, string | null>;
  brokenRepoCardIcons: Record<string, boolean>;
  getRepoCredentialLabel: (repo: string) => string;
  onHomeSearchQueryChange: (value: string) => void;
  onOpenCredentials: () => void;
  onCycleThemeMode: () => void;
  onSelectRepo: (repo: string) => void | Promise<boolean>;
  onOpenGitWorkspace: (repo: string) => void;
  onOpenRepoSettings: (event: MouseEvent, repo: string) => void | Promise<void>;
  onRemoveRecent: (event: MouseEvent, repo: string) => void;
  onRepoIconError: (repo: string) => void;
  onRepoCardMouseMove: (event: MouseEvent<HTMLDivElement>) => void;
  onRepoCardMouseLeave: (event: MouseEvent<HTMLDivElement>) => void;
  onAddRepository: () => void;
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
  filteredRecentRepos,
  isDarkThemeActive,
  runningSessionCountByRepo,
  draftCountByRepo,
  repoCardIconByRepo,
  brokenRepoCardIcons,
  getRepoCredentialLabel,
  onHomeSearchQueryChange,
  onOpenCredentials,
  onCycleThemeMode,
  onSelectRepo,
  onOpenGitWorkspace,
  onOpenRepoSettings,
  onRemoveRecent,
  onRepoIconError,
  onRepoCardMouseMove,
  onRepoCardMouseLeave,
  onAddRepository,
}: HomeDashboardProps) {
  return (
    <div className="w-full max-w-7xl">
      <header className="relative z-10 flex flex-col gap-4 rounded-xl border border-slate-200/80 bg-white/82 px-4 py-4 shadow-[0_14px_36px_-24px_rgba(15,23,42,0.4)] backdrop-blur-md transition-colors md:flex-row md:items-center md:justify-between md:px-7 dark:border-slate-700/75 dark:bg-[#131b2b]/72 dark:shadow-[0_18px_44px_-30px_rgba(0,0,0,0.75)]">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100/90 shadow-sm dark:border dark:border-white/5 dark:bg-[#1e2532]">
            <Image src="/palx-icon.png" alt="Palx" width={22} height={22} className="rounded-sm" />
          </div>
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-slate-900 dark:text-white">Palx</h2>
            <p className="text-xs text-slate-500 dark:text-slate-400">AI Coding Agent Dashboard</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="input input-sm flex h-10 w-full items-center gap-2 border-slate-200 bg-slate-100/90 text-slate-700 shadow-none transition-colors md:w-72 dark:border-slate-700/70 dark:bg-[#1e2532] dark:text-slate-200">
            <Search className="h-4 w-4 text-slate-400 dark:text-slate-500" />
            <input
              type="text"
              className="grow text-sm placeholder:text-slate-400 dark:placeholder:text-slate-500"
              placeholder="Search repositories..."
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
            className="btn btn-ghost btn-sm btn-square text-slate-700 dark:border dark:border-slate-700/60 dark:bg-[#1e2532] dark:text-slate-300 dark:hover:bg-[#252d3d] dark:hover:text-white"
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
          <div className="flex h-56 items-center justify-center rounded-2xl border border-slate-200 bg-white/70 dark:border-slate-700/55 dark:bg-[#141d2e]/70">
            <span className="loading loading-spinner loading-md text-primary"></span>
          </div>
        ) : filteredRecentRepos.length === 0 ? (
          <div className="flex h-56 flex-col items-center justify-center rounded-2xl border border-slate-200 bg-white/70 text-center dark:border-slate-700/55 dark:bg-[#141d2e]/70">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {homeSearchQuery.trim() ? 'No repositories match your search.' : 'No recent repositories found.'}
            </p>
            {!homeSearchQuery.trim() && (
              <button className="btn btn-primary btn-sm mt-3 gap-2" onClick={onAddRepository}>
                <Plus className="h-4 w-4" />
                Add your first repository
              </button>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
            {filteredRecentRepos.map((repo) => (
              <HomeRepoCard
                key={repo}
                repo={repo}
                isDarkThemeActive={isDarkThemeActive}
                credentialLabel={getRepoCredentialLabel(repo)}
                runningSessionCount={runningSessionCountByRepo.get(repo) ?? 0}
                draftCount={draftCountByRepo.get(repo) ?? 0}
                repoIconPath={repoCardIconByRepo[repo] ?? null}
                showRepoIcon={!!repoCardIconByRepo[repo] && !brokenRepoCardIcons[repo]}
                onSelectRepo={onSelectRepo}
                onOpenGitWorkspace={onOpenGitWorkspace}
                onOpenRepoSettings={onOpenRepoSettings}
                onRemoveRecent={onRemoveRecent}
                onRepoIconError={onRepoIconError}
                onMouseMove={onRepoCardMouseMove}
                onMouseLeave={onRepoCardMouseLeave}
              />
            ))}

            <button
              onClick={onAddRepository}
              className="group flex h-[248px] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50/70 text-slate-600 transition-all duration-200 hover:-translate-y-1 hover:border-primary/50 hover:bg-white dark:border-slate-700/35 dark:bg-[#131b2a] dark:text-slate-400 dark:hover:border-slate-600/50 dark:hover:bg-[#1d2638]"
            >
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white shadow-sm transition-transform group-hover:scale-105 dark:border dark:border-slate-700/40 dark:bg-[#1e2532]">
                <Plus className="h-7 w-7 text-slate-400 transition-colors group-hover:text-primary" />
              </span>
              <span className="text-lg font-semibold transition-colors group-hover:text-primary">
                Add Repository
              </span>
              <span className="text-sm text-slate-400 dark:text-slate-500">Import from local or git URL</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
