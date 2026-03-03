'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { FolderGit2, Plus, X, ChevronRight, ChevronDown, FolderCog, Bot, Trash2, KeyRound, Settings, ExternalLink, CloudDownload, Search, Monitor, Sun, Moon, LogOut, GitBranch as GitBranchIcon } from 'lucide-react';
import FileBrowser from './FileBrowser';
import {
  checkIsGitRepo,
  getBranches,
  checkoutBranch,
  GitBranch,
  startTtydProcess,
  getStartupScript,
  getDefaultDevServerScript,
  listRepoFiles,
  checkAgentCliInstalled,
  installAgentCli,
  SupportedAgentCli,
  resolveRepoCardIcon,
} from '@/app/actions/git';
import { cloneRemoteRepository, resolveRepositoryByName } from '@/app/actions/repository';
import { createSession, deleteSession, getSessionPrefillContext, listSessions, saveSessionLaunchContext, SessionMetadata } from '@/app/actions/session';
import { deleteDraft, listDrafts, saveDraft, DraftMetadata } from '@/app/actions/draft';
import { getConfig, updateConfig, updateRepoSettings, Config } from '@/app/actions/config';
import { listAgentApiCredentials, listCredentials } from '@/app/actions/credentials';
import type { Credential } from '@/lib/credentials';
import { useRouter } from 'next/navigation';
import { getBaseName } from '@/lib/path';
import { getStableRepoCardGradient } from '@/lib/repo-card-gradient';
import { notifySessionsUpdated, subscribeToSessionsUpdated } from '@/lib/session-updates';
import { consumePendingSessionNavigationRetry, recordPendingSessionNavigation } from '@/lib/session-navigation';
import {
  applyThemeToTerminalIframe,
  applyThemeToTerminalWindow,
  resolveShouldUseDarkTheme,
  TERMINAL_THEME_DARK,
  TERMINAL_THEME_LIGHT,
  THEME_MODE_STORAGE_KEY,
  THEME_REFRESH_EVENT,
} from '@/lib/ttyd-theme';
import Image from 'next/image';
import { useDialogKeyboardShortcuts } from '@/hooks/useDialogKeyboardShortcuts';
import SessionFileBrowser from './SessionFileBrowser';

type SessionMode = 'fast' | 'plan';
type RepoCredentialSelection = 'auto' | string;
type ThemeMode = 'auto' | 'light' | 'dark';
const DEFAULT_REPO_STARTUP_COMMAND = 'npm install';
const DEFAULT_REPO_DEV_SERVER_COMMAND = 'npm run dev';
const THEME_MODE_SEQUENCE: ThemeMode[] = ['auto', 'light', 'dark'];

function getCredentialOptionLabel(credential: Credential): string {
  if (credential.type === 'github') {
    return `GitHub - ${credential.username}`;
  }

  let host = credential.serverUrl;
  try {
    host = new URL(credential.serverUrl).host;
  } catch {
    // Keep raw server URL if parsing fails.
  }

  return `GitLab - ${credential.username} @ ${host}`;
}

const SESSION_MODE_STORAGE_KEY = 'viba:new-session-mode';
const SESSION_TITLE_MAX_LENGTH = 120;
const AGENT_LOGIN_COMMANDS: Record<SupportedAgentCli, string> = {
  codex: 'codex',
};
const AGENT_CLI_LABELS: Record<SupportedAgentCli, string> = {
  codex: 'Codex CLI',
};

type TerminalWindow = Window & {
  term?: {
    paste: (text: string) => void;
  };
};

type PredefinedPrompt = {
  id: string;
  label: string;
  content: string;
};

type GitRepoSelectorProps = {
  mode?: 'home' | 'new';
  repoPath?: string | null;
  fromRepoName?: string | null;
  prefillFromSession?: string | null;
  predefinedPrompts?: PredefinedPrompt[];
  showLogout?: boolean;
  logoutEnabled?: boolean;
};

function deriveSessionTitleFromTaskDescription(taskDescription: string): string | undefined {
  const firstNonEmptyLine = taskDescription
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstNonEmptyLine) return undefined;
  return firstNonEmptyLine.slice(0, SESSION_TITLE_MAX_LENGTH);
}

type HomeRepoCardProps = {
  repo: string;
  isDarkThemeActive: boolean;
  credentialLabel: string;
  runningSessionCount: number;
  draftCount: number;
  repoIconPath: string | null;
  showRepoIcon: boolean;
  onSelectRepo: (repo: string) => void | Promise<boolean>;
  onOpenGitWorkspace: (repo: string) => void;
  onOpenRepoSettings: (event: React.MouseEvent, repo: string) => void;
  onRemoveRecent: (event: React.MouseEvent, repo: string) => void;
  onRepoIconError: (repo: string) => void;
  onMouseMove: (event: React.MouseEvent<HTMLDivElement>) => void;
  onMouseLeave: (event: React.MouseEvent<HTMLDivElement>) => void;
};

function HomeRepoCard({
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

type HomeDashboardProps = {
  error: string | null;
  isLoaded: boolean;
  homeSearchQuery: string;
  showLogout: boolean;
  logoutEnabled: boolean;
  themeModeLabel: string;
  nextThemeModeLabel: string;
  ThemeModeIcon: React.ComponentType<{ className?: string }>;
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
  onOpenRepoSettings: (event: React.MouseEvent, repo: string) => void;
  onRemoveRecent: (event: React.MouseEvent, repo: string) => void;
  onRepoIconError: (repo: string) => void;
  onRepoCardMouseMove: (event: React.MouseEvent<HTMLDivElement>) => void;
  onRepoCardMouseLeave: (event: React.MouseEvent<HTMLDivElement>) => void;
  onAddRepository: () => void;
};

function HomeDashboard({
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

type RepoSettingsDialogProps = {
  isOpen: boolean;
  repoForSettings: string | null;
  repoCredentialSelection: RepoCredentialSelection;
  repoStartupCommand: string;
  repoDevServerCommand: string;
  credentialOptions: Credential[];
  isSavingRepoSettings: boolean;
  isLoadingCredentialOptions: boolean;
  repoSettingsError: string | null;
  onCredentialChange: (value: RepoCredentialSelection) => void;
  onStartupCommandChange: (value: string) => void;
  onDevServerCommandChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
};

function RepoSettingsDialog({
  isOpen,
  repoForSettings,
  repoCredentialSelection,
  repoStartupCommand,
  repoDevServerCommand,
  credentialOptions,
  isSavingRepoSettings,
  isLoadingCredentialOptions,
  repoSettingsError,
  onCredentialChange,
  onStartupCommandChange,
  onDevServerCommandChange,
  onClose,
  onSave,
}: RepoSettingsDialogProps) {
  if (!isOpen || !repoForSettings) return null;

  return (
    <div className="fixed inset-0 z-[1002] flex items-center justify-center bg-slate-900/35 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#151b26]">
        <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/70 px-5 py-4 md:px-6 dark:border-white/10 dark:bg-[#1e2532]/75">
          <h3 className="text-lg font-bold text-slate-900 dark:text-white">Repository Settings</h3>
          <button
            className="btn btn-circle btn-ghost btn-sm text-slate-500 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
            onClick={onClose}
            disabled={isSavingRepoSettings}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5 md:p-6">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Choose which credential this repository should use for authenticated Git operations.
          </p>

          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Repository</label>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 break-all font-mono text-xs text-slate-700 dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-200">
              {repoForSettings}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Credential</label>
            <select
              className="select w-full border-slate-200 bg-slate-50 text-slate-700 focus:border-primary focus:outline-none dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-200"
              value={repoCredentialSelection}
              onChange={(event) => onCredentialChange(event.target.value)}
              disabled={isSavingRepoSettings}
            >
              <option value="auto">Auto (match repository remote)</option>
              {credentialOptions.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {getCredentialOptionLabel(credential)}
                </option>
              ))}
            </select>
            {credentialOptions.length === 0 && !isLoadingCredentialOptions && (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                No credentials found. Add credentials from the Credentials page.
              </div>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Start Up Command</label>
            <input
              className="input w-full border-slate-200 bg-slate-50 font-mono text-sm text-slate-800 focus:border-primary focus:outline-none dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-200"
              value={repoStartupCommand}
              onChange={(event) => onStartupCommandChange(event.target.value)}
              placeholder={DEFAULT_REPO_STARTUP_COMMAND}
              disabled={isSavingRepoSettings}
            />
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Default: <span className="font-mono">{DEFAULT_REPO_STARTUP_COMMAND}</span>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Dev Server Command</label>
            <input
              className="input w-full border-slate-200 bg-slate-50 font-mono text-sm text-slate-800 focus:border-primary focus:outline-none dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-200"
              value={repoDevServerCommand}
              onChange={(event) => onDevServerCommandChange(event.target.value)}
              placeholder={DEFAULT_REPO_DEV_SERVER_COMMAND}
              disabled={isSavingRepoSettings}
            />
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Default: <span className="font-mono">{DEFAULT_REPO_DEV_SERVER_COMMAND}</span>
            </div>
          </div>

          {isLoadingCredentialOptions && (
            <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              <span className="loading loading-spinner loading-xs"></span>
              Loading credentials...
            </div>
          )}

          {repoSettingsError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {repoSettingsError}
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-white/10">
            <button
              className="btn btn-ghost text-slate-700 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
              onClick={onClose}
              disabled={isSavingRepoSettings}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={onSave}
              disabled={isSavingRepoSettings || isLoadingCredentialOptions}
            >
              {isSavingRepoSettings ? <span className="loading loading-spinner loading-xs"></span> : null}
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

type CloneRemoteDialogProps = {
  isOpen: boolean;
  defaultRoot: string | null | undefined;
  remoteRepoUrl: string;
  cloneCredentialSelection: RepoCredentialSelection;
  credentialOptions: Credential[];
  isCloningRemote: boolean;
  isLoadingCloneCredentialOptions: boolean;
  cloneRemoteError: string | null;
  onClose: () => void;
  onRemoteRepoUrlChange: (value: string) => void;
  onCloneCredentialSelectionChange: (value: RepoCredentialSelection) => void;
  onBrowseLocalRepository: () => void;
  onSetDefaultFolder: () => void;
  onCloneRepository: () => void;
};

function CloneRemoteDialog({
  isOpen,
  defaultRoot,
  remoteRepoUrl,
  cloneCredentialSelection,
  credentialOptions,
  isCloningRemote,
  isLoadingCloneCredentialOptions,
  cloneRemoteError,
  onClose,
  onRemoteRepoUrlChange,
  onCloneCredentialSelectionChange,
  onBrowseLocalRepository,
  onSetDefaultFolder,
  onCloneRepository,
}: CloneRemoteDialogProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[1002] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#151b26]">
        <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-5 py-4 md:px-6 dark:border-white/10 dark:bg-[#1e2532]/75">
          <div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-white">Add New Repository</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">Connect a local folder or clone from URL</p>
          </div>
          <button className="btn btn-circle btn-ghost btn-sm text-slate-500 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white" onClick={onClose} disabled={isCloningRemote}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-1 flex-col overflow-y-auto md:flex-row">
          <div className="flex-1 space-y-4 border-b border-slate-100 p-5 md:border-r md:border-b-0 md:p-6 dark:border-white/10">
            <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Browse Local</h4>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Select an existing Git repository folder from your local machine.
            </p>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-300">
              Default root: <span className="font-mono">{defaultRoot || '~'}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="btn btn-primary btn-sm gap-2"
                onClick={onBrowseLocalRepository}
              >
                <FolderGit2 className="h-4 w-4" />
                Browse Local Repository
              </button>
              <button
                className="btn btn-ghost btn-sm gap-2 text-slate-700 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
                onClick={onSetDefaultFolder}
              >
                <FolderCog className="h-4 w-4" />
                Set Default Folder
              </button>
            </div>
          </div>

          <div className="w-full space-y-4 bg-slate-50/35 p-5 md:w-[420px] md:p-6 dark:bg-[#111722]">
            <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Clone Remote</h4>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Clone into <span className="font-mono">~/.viba/repos</span> and open it immediately.
            </p>

            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Repository URL</label>
              <input
                className="input w-full border-slate-200 bg-white font-mono text-sm text-slate-800 focus:border-primary focus:outline-none dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-200"
                placeholder="https://github.com/org/repo.git"
                value={remoteRepoUrl}
                onChange={(event) => onRemoteRepoUrlChange(event.target.value)}
                disabled={isCloningRemote}
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Credential</label>
              <select
                className="select w-full border-slate-200 bg-white text-slate-700 focus:border-primary focus:outline-none dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-200"
                value={cloneCredentialSelection}
                onChange={(event) => onCloneCredentialSelectionChange(event.target.value)}
                disabled={isCloningRemote || isLoadingCloneCredentialOptions}
              >
                <option value="auto">Auto (match repository remote)</option>
                {credentialOptions.map((credential) => (
                  <option key={credential.id} value={credential.id}>
                    {getCredentialOptionLabel(credential)}
                  </option>
                ))}
              </select>
              {credentialOptions.length === 0 && !isLoadingCloneCredentialOptions && (
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  No credentials found. Clone uses anonymous access unless remote auth is configured.
                </div>
              )}
            </div>

            {isLoadingCloneCredentialOptions && (
              <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                <span className="loading loading-spinner loading-xs"></span>
                Loading credentials...
              </div>
            )}

            {isCloningRemote && (
              <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-300">
                <span className="loading loading-spinner loading-xs"></span>
                Cloning repository...
              </div>
            )}

            {cloneRemoteError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {cloneRemoteError}
              </div>
            )}

            <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-white/10">
              <button
                className="btn btn-ghost text-slate-700 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
                onClick={onClose}
                disabled={isCloningRemote}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary gap-2"
                onClick={onCloneRepository}
                disabled={isCloningRemote || !remoteRepoUrl.trim() || isLoadingCloneCredentialOptions}
              >
                {isCloningRemote ? <span className="loading loading-spinner loading-xs"></span> : <CloudDownload className="h-4 w-4" />}
                Clone Repository
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function GitRepoSelector({
  mode = 'home',
  repoPath = null,
  fromRepoName = null,
  prefillFromSession = null,
  predefinedPrompts = [],
  showLogout = false,
  logoutEnabled = true,
}: GitRepoSelectorProps) {
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [isSelectingRoot, setIsSelectingRoot] = useState(false);
  const [isRepoSettingsDialogOpen, setIsRepoSettingsDialogOpen] = useState(false);
  const [isCloneRemoteDialogOpen, setIsCloneRemoteDialogOpen] = useState(false);
  const [remoteRepoUrl, setRemoteRepoUrl] = useState('');
  const [cloneCredentialSelection, setCloneCredentialSelection] = useState<RepoCredentialSelection>('auto');
  const [cloneRemoteError, setCloneRemoteError] = useState<string | null>(null);
  const [isCloningRemote, setIsCloningRemote] = useState(false);
  const [isLoadingCloneCredentialOptions, setIsLoadingCloneCredentialOptions] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>('auto');
  const [isDarkThemeActive, setIsDarkThemeActive] = useState(false);

  const [config, setConfig] = useState<Config | null>(null);

  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [repoForSettings, setRepoForSettings] = useState<string | null>(null);
  const [repoCredentialSelection, setRepoCredentialSelection] = useState<RepoCredentialSelection>('auto');
  const [repoStartupCommand, setRepoStartupCommand] = useState<string>(DEFAULT_REPO_STARTUP_COMMAND);
  const [repoDevServerCommand, setRepoDevServerCommand] = useState<string>(DEFAULT_REPO_DEV_SERVER_COMMAND);
  const [credentialOptions, setCredentialOptions] = useState<Credential[]>([]);

  const router = useRouter();

  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [currentBranchName, setCurrentBranchName] = useState<string>('');
  const [existingSessions, setExistingSessions] = useState<SessionMetadata[]>([]);
  const [allSessions, setAllSessions] = useState<SessionMetadata[]>([]);
  const [existingDrafts, setExistingDrafts] = useState<DraftMetadata[]>([]);
  const [allDrafts, setAllDrafts] = useState<DraftMetadata[]>([]);

  const [startupScript, setStartupScript] = useState<string>('');
  const [devServerScript, setDevServerScript] = useState<string>('');
  const [showSessionAdvanced, setShowSessionAdvanced] = useState(false);
  const [initialMessage, setInitialMessage] = useState<string>('');
  const [sessionMode, setSessionMode] = useState<SessionMode>('fast');
  const [attachments, setAttachments] = useState<string[]>([]);
  const [isAttachmentBrowserOpen, setIsAttachmentBrowserOpen] = useState(false);
  const [lastAttachmentBrowserPath, setLastAttachmentBrowserPath] = useState<string>('');
  const [prefilledAttachmentPaths, setPrefilledAttachmentPaths] = useState<string[]>([]);
  const [hasAppliedPrefill, setHasAppliedPrefill] = useState(false);

  const [loading, setLoading] = useState(false);
  const [deletingSessionName, setDeletingSessionName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isResolvingRepoFromName, setIsResolvingRepoFromName] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isInstallingAgentCli, setIsInstallingAgentCli] = useState(false);
  const [installingAgentCli, setInstallingAgentCli] = useState<SupportedAgentCli | null>(null);
  const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);
  const [loginAgentCli, setLoginAgentCli] = useState<SupportedAgentCli | null>(null);
  const [loginCommand, setLoginCommand] = useState('');
  const [homeSearchQuery, setHomeSearchQuery] = useState('');
  const [loginCommandInjected, setLoginCommandInjected] = useState(false);
  const [loginModalError, setLoginModalError] = useState<string | null>(null);
  const [repoSettingsError, setRepoSettingsError] = useState<string | null>(null);
  const [isLoadingCredentialOptions, setIsLoadingCredentialOptions] = useState(false);
  const [isSavingRepoSettings, setIsSavingRepoSettings] = useState(false);
  const [repoCardIconByRepo, setRepoCardIconByRepo] = useState<Record<string, string | null>>({});
  const [brokenRepoCardIcons, setBrokenRepoCardIcons] = useState<Record<string, boolean>>({});
  const repoCardIconResolutionsInFlightRef = useRef<Set<string>>(new Set());
  const loginTerminalRef = useRef<HTMLIFrameElement>(null);

  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const sessionNavigationCommittedRef = useRef(false);

  const collapsedSessionSetupLabel = 'Show Session Setup';

  const notifySessionsChanged = useCallback(() => {
    notifySessionsUpdated();
  }, []);

  const navigateToSession = useCallback((sessionName: string) => {
    sessionNavigationCommittedRef.current = true;
    recordPendingSessionNavigation(sessionName);
    window.location.assign(`/session/${encodeURIComponent(sessionName)}`);
  }, []);

  const refreshSessionData = useCallback(async (repo: string | null = selectedRepo) => {
    try {
      const [allSess, repoSess, allD, repoD] = await Promise.all([
        listSessions(),
        repo ? listSessions(repo) : Promise.resolve([] as SessionMetadata[]),
        listDrafts(),
        repo ? listDrafts(repo) : Promise.resolve([] as DraftMetadata[]),
      ]);
      setAllSessions(allSess);
      setAllDrafts(allD);
      if (repo) {
        setExistingSessions(repoSess);
        setExistingDrafts(repoD);
      }
    } catch (e) {
      console.error('Failed to refresh sessions and drafts', e);
    }
  }, [selectedRepo]);

  const resolveRepoCredentialSelection = useCallback((repo: string, credentials: Credential[] = credentialOptions): RepoCredentialSelection => {
    const repoSettings = config?.repoSettings?.[repo];
    if (!repoSettings) return 'auto';

    if (repoSettings.credentialId) {
      return repoSettings.credentialId;
    }

    const legacyPreference = repoSettings.credentialPreference;
    if (legacyPreference === 'github' || legacyPreference === 'gitlab') {
      const matched = credentials.find((credential) => credential.type === legacyPreference);
      if (matched) return matched.id;
    }

    return 'auto';
  }, [config, credentialOptions]);

  const getRepoCredentialLabel = useCallback((repo: string): string => {
    const repoSettings = config?.repoSettings?.[repo];
    if (!repoSettings) return 'Auto';

    if (repoSettings.credentialId) {
      const matched = credentialOptions.find((credential) => credential.id === repoSettings.credentialId);
      return matched ? getCredentialOptionLabel(matched) : 'Selected credential';
    }

    if (repoSettings.credentialPreference === 'github') return 'GitHub (legacy)';
    if (repoSettings.credentialPreference === 'gitlab') return 'GitLab (legacy)';

    return 'Auto';
  }, [config, credentialOptions]);

  const dismissRepoSettingsDialog = useCallback(() => {
    if (isSavingRepoSettings) return;
    setIsRepoSettingsDialogOpen(false);
    setRepoForSettings(null);
    setRepoCredentialSelection('auto');
    setRepoStartupCommand(DEFAULT_REPO_STARTUP_COMMAND);
    setRepoDevServerCommand(DEFAULT_REPO_DEV_SERVER_COMMAND);
    setRepoSettingsError(null);
    setIsLoadingCredentialOptions(false);
  }, [isSavingRepoSettings]);

  const openCloneRemoteDialog = useCallback(() => {
    setIsCloneRemoteDialogOpen(true);
    setRemoteRepoUrl('');
    setCloneCredentialSelection('auto');
    setCloneRemoteError(null);
    setIsLoadingCloneCredentialOptions(true);

    void (async () => {
      try {
        const result = await listCredentials();
        if (!result.success) {
          setCloneRemoteError(result.error);
          return;
        }

        setCredentialOptions(result.credentials);
      } catch (error) {
        console.error(error);
        setCloneRemoteError('Failed to load credentials.');
      } finally {
        setIsLoadingCloneCredentialOptions(false);
      }
    })();
  }, []);

  const dismissCloneRemoteDialog = useCallback(() => {
    if (isCloningRemote) return;
    setIsCloneRemoteDialogOpen(false);
    setRemoteRepoUrl('');
    setCloneCredentialSelection('auto');
    setCloneRemoteError(null);
    setIsLoadingCloneCredentialOptions(false);
  }, [isCloningRemote]);

  // Load config and all sessions on mount
  useEffect(() => {
    const loadData = async () => {
      try {
        const [cfg, sessions, drafts, credentialsResult] = await Promise.all([
          getConfig(),
          listSessions(),
          listDrafts(),
          listCredentials(),
        ]);
        setConfig(cfg);
        setAllSessions(sessions);
        setAllDrafts(drafts);
        if (credentialsResult.success) {
          setCredentialOptions(credentialsResult.credentials);
        }
      } catch (e) {
        console.error('Failed to load data', e);
      } finally {
        setIsLoaded(true);
      }
    };
    loadData();
  }, []);

  useEffect(() => {
    try {
      const storedMode = window.localStorage.getItem(THEME_MODE_STORAGE_KEY);
      if (storedMode === 'light' || storedMode === 'dark' || storedMode === 'auto') {
        setThemeMode(storedMode);
        return;
      }
    } catch {
      // Ignore localStorage errors and keep default theme mode.
    }
    setThemeMode('auto');
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const applyThemeMode = () => {
      const shouldUseDark = resolveShouldUseDarkTheme(themeMode, mediaQuery.matches);
      const terminalTheme = shouldUseDark ? TERMINAL_THEME_DARK : TERMINAL_THEME_LIGHT;
      document.documentElement.classList.toggle('dark', shouldUseDark);
      document.documentElement.dataset.themeMode = themeMode;
      setIsDarkThemeActive(shouldUseDark);
      applyThemeToTerminalIframe(loginTerminalRef.current, terminalTheme);
    };

    applyThemeMode();

    try {
      window.localStorage.setItem(THEME_MODE_STORAGE_KEY, themeMode);
    } catch {
      // Ignore localStorage errors.
    }
    window.dispatchEvent(new Event(THEME_REFRESH_EVENT));

    if (themeMode !== 'auto') {
      return;
    }

    const handleThemeChange = () => {
      applyThemeMode();
    };

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', handleThemeChange);
      return () => {
        mediaQuery.removeEventListener('change', handleThemeChange);
      };
    }

    mediaQuery.addListener(handleThemeChange);
    return () => {
      mediaQuery.removeListener(handleThemeChange);
    };
  }, [themeMode]);

  useEffect(() => {
    if (mode !== 'new') return;

    try {
      const storedMode = window.localStorage.getItem(SESSION_MODE_STORAGE_KEY);
      if (storedMode === 'fast' || storedMode === 'plan') {
        setSessionMode(storedMode);
      }
    } catch {
      // Ignore localStorage errors.
    }
  }, [mode]);

  useEffect(() => {
    const refresh = () => {
      const repoForList = mode === 'new' ? selectedRepo : null;
      void refreshSessionData(repoForList);
    };

    const handleFocus = () => {
      refresh();
    };

    const unsubscribeSessionsUpdated = subscribeToSessionsUpdated(refresh);
    window.addEventListener('focus', handleFocus);

    return () => {
      window.removeEventListener('focus', handleFocus);
      unsubscribeSessionsUpdated();
    };
  }, [mode, refreshSessionData, selectedRepo]);

  const loadSelectedRepoData = async (path: string) => {
    setSelectedRepo(path);
    setRepoFilesCache([]);

    // Load saved session scripts
    await loadSavedAgentSettings(path);

    // Load branches
    await loadBranches(path);

    await refreshSessionData(path);
  };

  const handleSelectRepo = async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const isValid = await checkIsGitRepo(path);
      if (!isValid) {
        setError('Selected directory is not a valid git repository.');
        return false;
      }

      const currentConfig = config || await getConfig();
      let newRecent = [...currentConfig.recentRepos];
      if (!newRecent.includes(path)) {
        newRecent.unshift(path);
      } else {
        // Move to top
        newRecent = [path, ...newRecent.filter(r => r !== path)];
      }

      // Update config
      const newConfig = await updateConfig({ recentRepos: newRecent });
      setConfig(newConfig);

      setIsBrowsing(false);

      if (mode === 'home') {
        router.push(`/new?repo=${encodeURIComponent(path)}`);
        return true;
      }

      await loadSelectedRepoData(path);
      return true;
    } catch (err) {
      console.error(err);
      setError('Failed to open repository.');
      return false;
    } finally {
      setLoading(false);
    }
  };

  const handleCloneRemoteRepo = async () => {
    if (isCloningRemote) return;

    const trimmedRemoteUrl = remoteRepoUrl.trim();
    if (!trimmedRemoteUrl) {
      setCloneRemoteError('Please enter a remote repository URL.');
      return;
    }

    setIsCloningRemote(true);
    setCloneRemoteError(null);
    setError(null);

    try {
      const result = await cloneRemoteRepository(
        trimmedRemoteUrl,
        cloneCredentialSelection === 'auto' ? null : cloneCredentialSelection,
      );

      if (!result.success || !result.repoPath) {
        setCloneRemoteError(result.error || 'Failed to clone repository.');
        return;
      }

      const opened = await handleSelectRepo(result.repoPath);
      if (!opened) {
        setCloneRemoteError('Repository was cloned, but failed to open it.');
        return;
      }

      setIsCloneRemoteDialogOpen(false);
      setRemoteRepoUrl('');
      setCloneCredentialSelection('auto');
      setCloneRemoteError(null);
    } catch (error) {
      console.error(error);
      setCloneRemoteError('Failed to clone repository.');
    } finally {
      setIsCloningRemote(false);
    }
  };

  const handleCurrentRepoChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (mode !== 'new') return;

    const nextRepo = e.target.value;
    if (!nextRepo || nextRepo === selectedRepo) return;

    const changed = await handleSelectRepo(nextRepo);
    if (!changed) return;
    if (sessionNavigationCommittedRef.current) return;

    const params = new URLSearchParams();
    params.set('repo', nextRepo);
    if (prefillFromSession) {
      params.set('prefillFromSession', prefillFromSession);
    }

    router.replace(`/new?${params.toString()}`);
  };

  useEffect(() => {
    if (mode !== 'new') return;

    const retrySessionName = consumePendingSessionNavigationRetry();
    if (!retrySessionName) return;
    if (sessionNavigationCommittedRef.current) return;

    sessionNavigationCommittedRef.current = true;
    window.location.replace(`/session/${encodeURIComponent(retrySessionName)}`);
  }, [mode]);

  useEffect(() => {
    if (mode !== 'new') return;

    if (!repoPath) {
      setSelectedRepo(null);
      setExistingSessions([]);
      setBranches([]);
      setCurrentBranchName('');
      return;
    }

    if (repoPath === selectedRepo) return;
    void handleSelectRepo(repoPath);
    // `handleSelectRepo` is intentionally excluded to avoid retriggering from function identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, repoPath, selectedRepo]);

  useEffect(() => {
    if (mode !== 'new' || !selectedRepo) return;
    setLastAttachmentBrowserPath((prev) => prev || selectedRepo);
  }, [mode, selectedRepo]);

  useEffect(() => {
    if (mode !== 'new') return;
    if (repoPath) {
      setIsResolvingRepoFromName(false);
      return;
    }

    const trimmedFromRepoName = fromRepoName?.trim() ?? '';
    if (!trimmedFromRepoName) {
      setIsResolvingRepoFromName(false);
      return;
    }

    let isCancelled = false;

    const resolveFromRepoName = async () => {
      setError(null);
      setIsResolvingRepoFromName(true);

      const result = await resolveRepositoryByName(trimmedFromRepoName);
      if (isCancelled) return;

      if (!result.success) {
        setError(result.error || 'Failed to search repositories.');
        setIsResolvingRepoFromName(false);
        return;
      }

      if (!result.repoPath) {
        setError(`Could not find a matching repository for "${trimmedFromRepoName}".`);
        setIsResolvingRepoFromName(false);
        return;
      }

      const params = new URLSearchParams();
      params.set('repo', result.repoPath);
      if (prefillFromSession) {
        params.set('prefillFromSession', prefillFromSession);
      }
      if (sessionNavigationCommittedRef.current) {
        return;
      }
      router.replace(`/new?${params.toString()}`);
    };

    void resolveFromRepoName();

    return () => {
      isCancelled = true;
    };
  }, [fromRepoName, mode, prefillFromSession, repoPath, router]);

  useEffect(() => {
    setHasAppliedPrefill(false);
    setPrefilledAttachmentPaths([]);
  }, [prefillFromSession]);

  useEffect(() => {
    if (mode !== 'new' || !selectedRepo || !prefillFromSession || hasAppliedPrefill) {
      return;
    }

    let isCancelled = false;

    const loadPrefill = async () => {
      const prefillResult = await getSessionPrefillContext(prefillFromSession);
      if (isCancelled) return;

      if (!prefillResult.success || !prefillResult.context) {
        if (prefillResult.error) {
          setError(prefillResult.error);
        }
        setHasAppliedPrefill(true);
        return;
      }

      const context = prefillResult.context;
      if (context.repoPath !== selectedRepo) {
        setHasAppliedPrefill(true);
        return;
      }

      setInitialMessage(context.initialMessage || '');
      setPrefilledAttachmentPaths(context.attachmentPaths || []);
      setShowSessionAdvanced(true);
      setHasAppliedPrefill(true);
    };

    void loadPrefill();

    return () => {
      isCancelled = true;
    };
  }, [hasAppliedPrefill, mode, prefillFromSession, selectedRepo]);

  const loadSavedAgentSettings = async (repoPath: string) => {
    // Refresh config to ensure we have latest settings?
    // We can just rely on current config state if we assume single user or minimal concurrency.
    // Or we can refetch.
    const currentConfig = config || await getConfig();
    if (!config) setConfig(currentConfig);

    const settings = currentConfig.repoSettings[repoPath] || {};

    const savedStartupScript = settings.startupScript;
    const savedDevServerScript = settings.devServerScript;

    if (savedStartupScript !== undefined && savedStartupScript !== null) {
      setStartupScript(savedStartupScript);
    } else {
      // Determine default based on repo content
      const defaultScript = await getStartupScript(repoPath);
      setStartupScript(defaultScript);
    }

    if (savedDevServerScript !== undefined && savedDevServerScript !== null) {
      setDevServerScript(savedDevServerScript);
    } else {
      const defaultDevServerScript = await getDefaultDevServerScript(repoPath);
      setDevServerScript(defaultDevServerScript);
    }
  };

  const handleSetDefaultRoot = async (path: string) => {
    const newConfig = await updateConfig({ defaultRoot: path });
    setConfig(newConfig);
    setIsSelectingRoot(false);
  };

  const loadBranches = async (repoPath: string) => {
    try {
      const data = await getBranches(repoPath);
      setBranches(data);

      const currentConfig = config || await getConfig();
      const settings = currentConfig.repoSettings[repoPath] || {};
      const lastPicked = settings.lastBranch;

      // Check current checked out branch
      const currentCheckedOut = data.find(b => b.current)?.name;

      if (lastPicked && data.some(b => b.name === lastPicked)) {
        setCurrentBranchName(lastPicked);
        if (lastPicked !== currentCheckedOut) {
          try {
            await checkoutBranch(repoPath, lastPicked);
            const updatedData = await getBranches(repoPath);
            setBranches(updatedData);
          } catch (e) {
            console.warn("Could not auto-checkout to remembered branch", e);
            if (currentCheckedOut) setCurrentBranchName(currentCheckedOut);
          }
        }
      } else {
        if (currentCheckedOut) setCurrentBranchName(currentCheckedOut);
      }
    } catch (e) {
      console.error("Failed to load branches", e);
      setError("Failed to load branches.");
    }
  };

  const handleBranchChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newBranch = e.target.value;
    if (!selectedRepo) return;

    setLoading(true);
    try {
      await checkoutBranch(selectedRepo, newBranch);
      setCurrentBranchName(newBranch);

      const newConfig = await updateRepoSettings(selectedRepo, { lastBranch: newBranch });
      setConfig(newConfig);

      const data = await getBranches(selectedRepo);
      setBranches(data);
    } catch {
      setError(`Failed to checkout branch ${newBranch}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSessionModeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const nextMode = e.target.value === 'plan' ? 'plan' : 'fast';
    setSessionMode(nextMode);

    try {
      window.localStorage.setItem(SESSION_MODE_STORAGE_KEY, nextMode);
    } catch {
      // Ignore localStorage errors.
    }
  };

  const handleStartupScriptChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const script = e.target.value;
    setStartupScript(script);
    // Debounce saving? Or just save on blur/change?
    // For simplicity, I'll save on change but it triggers server action every keystroke which is bad.
    // Better to save on blur or debounce.
    // Or just save when starting session?
    // The previous code saved on every change to localStorage.
    // Let's rely on saving when starting session? No, we want to persist even if not started.
    // I'll save on blur for now, or just save here and accept the cost.
    // Given the "async" nature, let's just save. But it might be laggy.
    // Actually, let's just update local state here, and use `onBlur` to save.
  };

  const saveStartupScript = async () => {
    if (selectedRepo) {
      const newConfig = await updateRepoSettings(selectedRepo, { startupScript });
      setConfig(newConfig);
    }
  }

  const handleDevServerScriptChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setDevServerScript(e.target.value);
  };

  const saveDevServerScriptValue = async (script: string) => {
    if (selectedRepo) {
      const newConfig = await updateRepoSettings(selectedRepo, { devServerScript: script });
      setConfig(newConfig);
    }
  };

  const saveDevServerScript = async () => {
    await saveDevServerScriptValue(devServerScript);
  };

  const appendAttachmentPaths = useCallback((incomingPaths: string[]) => {
    if (incomingPaths.length === 0) return;

    setAttachments((prev) => {
      const normalized = incomingPaths.map((entry) => entry.trim()).filter(Boolean);
      return Array.from(new Set([...prev, ...normalized]));
    });
  }, []);

  // Suggestion state
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestionList, setSuggestionList] = useState<string[]>([]);
  const [, setSuggestionQuery] = useState('');
  const [cursorPosition, setCursorPosition] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Cache filtered files
  const [repoFilesCache, setRepoFilesCache] = useState<string[]>([]);
  const selectedAttachmentNames = useMemo(
    () => attachments.map((attachmentPath) => getBaseName(attachmentPath)),
    [attachments],
  );
  const prefilledAttachmentNames = useMemo(
    () => prefilledAttachmentPaths.map((attachmentPath) => getBaseName(attachmentPath)),
    [prefilledAttachmentPaths],
  );
  const hasPredefinedPrompts = mode === 'new' && predefinedPrompts.length > 0;

  const handleApplyPredefinedPrompt = useCallback((promptContent: string) => {
    setInitialMessage(promptContent);
    setCursorPosition(promptContent.length);
    setShowSuggestions(false);
  }, []);

  const updateSuggestions = (query: string, files: string[], currentAttachments: string[], carriedAttachments: string[]) => {
    const lowerQ = query.toLowerCase();

    const attachmentNames = [...currentAttachments, ...carriedAttachments];
    // prioritize attachments
    const matchedAttachments = attachmentNames.filter(n => n.toLowerCase().includes(lowerQ));
    const matchedFiles = files.filter(f => f.toLowerCase().includes(lowerQ)).slice(0, 20);

    const newList = [...matchedAttachments, ...matchedFiles];
    setSuggestionList(newList);
    setSelectedIndex(0); // Reset selection
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd+Enter to submit
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleStartSession();
      return;
    }

    if (showSuggestions && suggestionList.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : suggestionList.length - 1)); // Wrap around
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex(prev => (prev < suggestionList.length - 1 ? prev + 1 : 0)); // Wrap around
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        handleSelectSuggestion(suggestionList[selectedIndex]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setShowSuggestions(false);
      }
    }
  };

  const handleMessageChange = async (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const pos = e.target.selectionStart;
    setInitialMessage(val);
    setCursorPosition(pos);

    // Check for @ mention
    const textBeforeCursor = val.substring(0, pos);
    const lastAt = textBeforeCursor.lastIndexOf('@');

    if (lastAt !== -1) {
      const query = textBeforeCursor.substring(lastAt + 1);
      if (!/\s/.test(query)) {
        setSuggestionQuery(query);
        setShowSuggestions(true);

        if (selectedRepo) {
          let files = repoFilesCache;
          if (repoFilesCache.length === 0) {
            files = await listRepoFiles(selectedRepo);
            setRepoFilesCache(files);
          }
          updateSuggestions(query, files, selectedAttachmentNames, prefilledAttachmentNames);
        }
        return;
      }
    }

    setShowSuggestions(false);
  };

  const handleSelectSuggestion = (suggestion: string) => {
    const textBeforeCursor = initialMessage.substring(0, cursorPosition);
    const lastAt = textBeforeCursor.lastIndexOf('@');

    if (lastAt !== -1) {
      const prefix = initialMessage.substring(0, lastAt);
      const suffix = initialMessage.substring(cursorPosition);

      const newValue = `${prefix}@${suggestion} ${suffix}`;
      setInitialMessage(newValue);
      setShowSuggestions(false);
    }
  };

  const removeAttachment = (idx: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  const removePrefilledAttachment = (idx: number) => {
    setPrefilledAttachmentPaths(prev => prev.filter((_, i) => i !== idx));
  };


  const handleRemoveRecent = async (e: React.MouseEvent, repo: string) => {
    e.stopPropagation();
    if (config) {
      const newRecent = config.recentRepos.filter(r => r !== repo);
      const newConfig = await updateConfig({ recentRepos: newRecent });
      setConfig(newConfig);
    }
  };

  const handleOpenRepoSettings = async (e: React.MouseEvent, repo: string) => {
    e.stopPropagation();

    const settings = config?.repoSettings?.[repo];
    setRepoForSettings(repo);
    setRepoCredentialSelection(resolveRepoCredentialSelection(repo));
    setRepoStartupCommand(settings?.startupScript?.trim() ? settings.startupScript : DEFAULT_REPO_STARTUP_COMMAND);
    setRepoDevServerCommand(settings?.devServerScript?.trim() ? settings.devServerScript : DEFAULT_REPO_DEV_SERVER_COMMAND);
    setRepoSettingsError(null);
    setIsRepoSettingsDialogOpen(true);
    setIsLoadingCredentialOptions(true);

    try {
      const result = await listCredentials();
      if (!result.success) {
        setRepoSettingsError(result.error);
        setCredentialOptions([]);
      } else {
        setCredentialOptions(result.credentials);
        setRepoCredentialSelection(resolveRepoCredentialSelection(repo, result.credentials));
      }
    } catch (err) {
      console.error(err);
      setRepoSettingsError('Failed to load credentials.');
      setCredentialOptions([]);
    } finally {
      setIsLoadingCredentialOptions(false);
    }
  };

  const handleSaveRepoSettings = async () => {
    if (!repoForSettings) return;
    const credentialId = repoCredentialSelection === 'auto' ? null : repoCredentialSelection;
    const startupCommandToSave = repoStartupCommand.trim() || DEFAULT_REPO_STARTUP_COMMAND;
    const devServerCommandToSave = repoDevServerCommand.trim() || DEFAULT_REPO_DEV_SERVER_COMMAND;

    if (credentialId && !credentialOptions.some((credential) => credential.id === credentialId)) {
      setRepoSettingsError('Selected credential no longer exists. Please choose another credential.');
      return;
    }

    setIsSavingRepoSettings(true);
    setRepoSettingsError(null);
    try {
      const newConfig = await updateRepoSettings(repoForSettings, {
        credentialId,
        startupScript: startupCommandToSave,
        devServerScript: devServerCommandToSave,
        credentialPreference: undefined,
      });
      setConfig(newConfig);
      dismissRepoSettingsDialog();
    } catch (err) {
      console.error(err);
      setRepoSettingsError('Failed to save repository settings.');
    } finally {
      setIsSavingRepoSettings(false);
    }
  };

  const handleLoginTerminalLoad = useCallback(() => {
    if (!isLoginModalOpen || !loginCommand || !loginTerminalRef.current) {
      return;
    }

    const iframe = loginTerminalRef.current;
    const checkAndInject = (attempts = 0) => {
      if (attempts > 40) {
        setLoginModalError('Timed out while waiting for terminal to initialize.');
        return;
      }

      try {
        const win = iframe.contentWindow as TerminalWindow | null;
        if (win?.term) {
          const shouldUseDark = resolveShouldUseDarkTheme(
            themeMode,
            window.matchMedia('(prefers-color-scheme: dark)').matches,
          );
          applyThemeToTerminalWindow(
            win,
            shouldUseDark ? TERMINAL_THEME_DARK : TERMINAL_THEME_LIGHT,
          );
          win.term.paste(`${loginCommand}\r`);
          setLoginCommandInjected(true);
          setLoginModalError(null);
          win.focus();
          return;
        }

        setTimeout(() => checkAndInject(attempts + 1), 300);
      } catch (e) {
        console.error('Failed to inject login command into terminal iframe:', e);
        setLoginModalError('Could not access ttyd terminal. Ensure ttyd is running and try again.');
      }
    };

    setTimeout(() => checkAndInject(), 500);
  }, [isLoginModalOpen, loginCommand, themeMode]);

  const hasConfiguredAgentApiCredential = useCallback(async (agentCli: SupportedAgentCli): Promise<boolean> => {
    try {
      const result = await listAgentApiCredentials();
      if (!result.success) return false;
      return result.credentials.some((credential) => credential.agent === agentCli);
    } catch {
      return false;
    }
  }, []);

  const ensureAgentCliReady = useCallback(async (): Promise<boolean> => {
    const agentCli: SupportedAgentCli = 'codex';

    const checkResult = await checkAgentCliInstalled(agentCli);
    if (!checkResult.success) {
      setError(checkResult.error || `Failed to verify ${AGENT_CLI_LABELS[agentCli]} installation status.`);
      return false;
    }

    if (checkResult.installed) {
      return true;
    }

    setIsInstallingAgentCli(true);
    setInstallingAgentCli(agentCli);
    setError(null);

    const installResult = await installAgentCli(agentCli);
    setIsInstallingAgentCli(false);
    setInstallingAgentCli(null);

    if (!installResult.success) {
      setError(installResult.error || `Failed to install ${AGENT_CLI_LABELS[agentCli]}.`);
      return false;
    }

    const ttydResult = await startTtydProcess();
    if (!ttydResult.success) {
      setError(ttydResult.error || 'Failed to start ttyd');
      return false;
    }

    const hasAgentApiCredential = await hasConfiguredAgentApiCredential(agentCli);
    if (hasAgentApiCredential) {
      return true;
    }

    setLoginAgentCli(agentCli);
    setLoginCommand(AGENT_LOGIN_COMMANDS[agentCli]);
    setLoginCommandInjected(false);
    setLoginModalError(null);
    setIsLoginModalOpen(true);
    return false;
  }, [hasConfiguredAgentApiCredential]);

  const startSession = async (options: { skipAgentSetup?: boolean } = {}) => {
    if (!selectedRepo) return;
    setLoading(true);
    setError(null);

    try {
      if (!options.skipAgentSetup) {
        const isAgentCliReady = await ensureAgentCliReady();
        if (!isAgentCliReady) {
          setLoading(false);
          return;
        }
      }

      const trimmedDevServerScript = devServerScript.trim();
      let resolvedDevServerScript = trimmedDevServerScript;

      if (!resolvedDevServerScript) {
        resolvedDevServerScript = await getDefaultDevServerScript(selectedRepo);
        if (resolvedDevServerScript) {
          setDevServerScript(resolvedDevServerScript);
        }
      }

      // Also save startup script if changed
      await saveStartupScript();
      await saveDevServerScriptValue(resolvedDevServerScript);

      // 1. Start TTYD if needed
      const ttydResult = await startTtydProcess();
      if (!ttydResult.success) {
        setError(ttydResult.error || "Failed to start ttyd");
        setLoading(false);
        return;
      }

      // 2. Create Session Worktree
      // Use current selected branch as base
      const baseBranch = currentBranchName || 'main'; // Fallback to main if empty, though shouldn't happen
      const derivedTitle = deriveSessionTitleFromTaskDescription(initialMessage);

      const wtResult = await createSession(selectedRepo, baseBranch, {
        agent: 'codex',
        model: '',
        title: derivedTitle,
        devServerScript: resolvedDevServerScript || undefined
      });

      if (wtResult.success && wtResult.sessionName && wtResult.worktreePath && wtResult.branchName) {
        const allAttachmentPaths = Array.from(
          new Set(
            [...attachments, ...prefilledAttachmentPaths]
              .map((entry) => entry.trim())
              .filter(Boolean)
          )
        );
        const attachmentPathByName = new Map<string, string>();
        for (const attachmentPath of allAttachmentPaths) {
          const baseName = getBaseName(attachmentPath).trim();
          if (!baseName) continue;
          if (!attachmentPathByName.has(baseName)) {
            attachmentPathByName.set(baseName, attachmentPath);
          }
        }
        const allAttachmentNames = Array.from(attachmentPathByName.keys());

        // Process initial message mentions
        const trimmedInitialMessage = initialMessage.trim();
        let processedMessage = trimmedInitialMessage;

        // Helper to match replacement
        processedMessage = processedMessage.replace(/@(\S+)/g, (match, name) => {
          const attachmentPath = attachmentPathByName.get(name);
          if (attachmentPath) {
            return attachmentPath;
          }
          // Assume repo file - keep relative path as we run in worktree root
          return name;
        });

        // 3. Persist launch context for the new session
        const launchContextResult = await saveSessionLaunchContext(wtResult.sessionName, {
          title: derivedTitle,
          initialMessage: processedMessage || undefined,
          rawInitialMessage: trimmedInitialMessage || undefined,
          startupScript: startupScript || undefined,
          attachmentPaths: allAttachmentPaths,
          attachmentNames: allAttachmentNames,
          agentProvider: 'codex',
          model: '',
          sessionMode,
        });

        if (!launchContextResult.success) {
          setError(launchContextResult.error || 'Failed to save session context');
          setLoading(false);
          return;
        }

        // 4. Navigate to session page by path only
        notifySessionsChanged();
        navigateToSession(wtResult.sessionName);
        return;

        // No need to refresh sessions as we are navigating away
      } else {
        setError(wtResult.error || "Failed to create session worktree");
        setLoading(false);
      }

    } catch (e) {
      console.error(e);
      setError("Failed to start session");
      setLoading(false);
    }
  };

  const handleStartSession = () => {
    void startSession();
  };

  const handleSaveDraft = async () => {
    if (!selectedRepo) return;
    setIsSavingDraft(true);
    setError(null);
    try {
      const draftId = Date.now().toString();
      const messageTitle = initialMessage.split('\n')[0].trim() || 'Untitled Draft';
      const draft: DraftMetadata = {
        id: draftId,
        repoPath: selectedRepo,
        branchName: currentBranchName,
        message: initialMessage,
        attachmentPaths: [...attachments, ...prefilledAttachmentPaths],
        agentProvider: 'codex',
        model: '',
        timestamp: new Date().toISOString(),
        title: messageTitle,
        startupScript: startupScript,
        devServerScript: devServerScript,
        sessionMode: sessionMode,
      };

      const result = await saveDraft(draft);
      if (result.success) {
        await refreshSessionData(selectedRepo);
      } else {
        setError(result.error || 'Failed to save draft');
      }
    } catch (e) {
      console.error(e);
      setError('Failed to save draft');
    } finally {
      setIsSavingDraft(false);
    }
  };

  const handleOpenDraft = async (draft: DraftMetadata) => {
    setInitialMessage(draft.message);
    setAttachments(draft.attachmentPaths);
    setPrefilledAttachmentPaths([]);
    setCurrentBranchName(draft.branchName);
    setStartupScript(draft.startupScript || '');
    setDevServerScript(draft.devServerScript || '');
    setSessionMode(draft.sessionMode || 'fast');

    // delete draft after opening
    await handleDeleteDraft(draft.id);
  };

  const handleDeleteDraft = async (draftId: string) => {
    try {
      await deleteDraft(draftId);
      await refreshSessionData(selectedRepo);
    } catch (e) {
      console.error(e);
    }
  };

  const dismissLoginModal = useCallback(() => {
    setIsLoginModalOpen(false);
    setLoginAgentCli(null);
    setLoginCommand('');
    setLoginCommandInjected(false);
    setLoginModalError(null);
  }, []);

  const handleLoginDone = async () => {
    dismissLoginModal();
    await startSession({ skipAgentSetup: true });
  };

  useDialogKeyboardShortcuts({
    enabled: mode === 'new' && isLoginModalOpen && !!loginAgentCli,
    onConfirm: handleLoginDone,
    onDismiss: dismissLoginModal,
    canConfirm: !loading,
  });

  useDialogKeyboardShortcuts({
    enabled: mode === 'home' && isRepoSettingsDialogOpen && !!repoForSettings,
    onConfirm: handleSaveRepoSettings,
    onDismiss: dismissRepoSettingsDialog,
    canConfirm: !isSavingRepoSettings,
  });

  useDialogKeyboardShortcuts({
    enabled: mode === 'home' && isCloneRemoteDialogOpen,
    onConfirm: handleCloneRemoteRepo,
    onDismiss: dismissCloneRemoteDialog,
    canConfirm: !isCloningRemote && remoteRepoUrl.trim().length > 0 && !isLoadingCloneCredentialOptions,
  });

  const handleResumeSession = async (session: SessionMetadata) => {
    if (!selectedRepo) return;
    setLoading(true);

    try {
      // 1. Start TTYD
      const ttydResult = await startTtydProcess();
      if (!ttydResult.success) {
        setError(ttydResult.error || "Failed to start ttyd");
        setLoading(false);
        return;
      }

      // 2. Navigate — session already has initialized=true so SessionPageClient will resume
      navigateToSession(session.sessionName);
      return;

    } catch (e) {
      console.error(e);
      setError("Failed to resume session");
      setLoading(false);
    }
  };

  const handleNewAttemptFromSession = (session: SessionMetadata) => {
    if (!selectedRepo) return;
    const nextUrl = `/new?repo=${encodeURIComponent(selectedRepo)}&prefillFromSession=${encodeURIComponent(session.sessionName)}`;
    router.push(nextUrl);
  };

  const handleDeleteSession = async (session: SessionMetadata) => {
    if (!selectedRepo) return;

    const confirmed = confirm(
      `Delete session "${session.sessionName}"?\n\nThis will remove the worktree, branch, and session metadata.`
    );
    if (!confirmed) return;

    setDeletingSessionName(session.sessionName);
    setError(null);

    try {
      const result = await deleteSession(session.sessionName);
      if (!result.success) {
        setError(result.error || 'Failed to delete session');
        return;
      }

      const sessions = await listSessions(selectedRepo);
      setExistingSessions(sessions);

      // Also refresh all sessions
      const allSess = await listSessions();
      setAllSessions(allSess);
      notifySessionsChanged();
    } catch (e) {
      console.error(e);
      setError('Failed to delete session');
    } finally {
      setDeletingSessionName(null);
    }
  };

  const runningSessionCountByRepo = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of allSessions) {
      counts.set(session.repoPath, (counts.get(session.repoPath) ?? 0) + 1);
    }
    return counts;
  }, [allSessions]);

  const draftCountByRepo = useMemo(() => {
    const counts = new Map<string, number>();
    for (const draft of allDrafts) {
      counts.set(draft.repoPath, (counts.get(draft.repoPath) ?? 0) + 1);
    }
    return counts;
  }, [allDrafts]);

  const recentRepos = useMemo(() => config?.recentRepos ?? [], [config?.recentRepos]);
  const filteredRecentRepos = useMemo(() => {
    const normalizedQuery = homeSearchQuery.trim().toLowerCase();
    if (!normalizedQuery) return recentRepos;

    return recentRepos.filter((repo) => {
      const baseName = getBaseName(repo).toLowerCase();
      return baseName.includes(normalizedQuery) || repo.toLowerCase().includes(normalizedQuery);
    });
  }, [homeSearchQuery, recentRepos]);
  const selectableRepos = selectedRepo
    ? (recentRepos.includes(selectedRepo) ? recentRepos : [selectedRepo, ...recentRepos])
    : recentRepos;

  useEffect(() => {
    const inFlightResolutions = repoCardIconResolutionsInFlightRef.current;
    const reposToResolve = recentRepos.filter((repo) => (
      !(repo in repoCardIconByRepo)
      && !inFlightResolutions.has(repo)
    ));

    if (reposToResolve.length === 0) return;

    let cancelled = false;
    reposToResolve.forEach((repo) => {
      inFlightResolutions.add(repo);
    });

    void (async () => {
      const resolutionEntries = await Promise.all(reposToResolve.map(async (repo) => {
        try {
          const result = await resolveRepoCardIcon(repo);
          return [repo, result.success ? result.iconPath : null] as const;
        } catch (error) {
          console.error('Failed to resolve repository icon:', error);
          return [repo, null] as const;
        }
      }));

      if (!cancelled) {
        setRepoCardIconByRepo((previous) => {
          const next = { ...previous };
          for (const [repo, iconPath] of resolutionEntries) {
            next[repo] = iconPath;
          }
          return next;
        });
      }

      reposToResolve.forEach((repo) => {
        inFlightResolutions.delete(repo);
      });
    })();

    return () => {
      cancelled = true;
      reposToResolve.forEach((repo) => {
        inFlightResolutions.delete(repo);
      });
    };
  }, [recentRepos, repoCardIconByRepo]);

  const currentThemeModeIndex = THEME_MODE_SEQUENCE.indexOf(themeMode);
  const nextThemeMode = THEME_MODE_SEQUENCE[(currentThemeModeIndex + 1) % THEME_MODE_SEQUENCE.length];
  const themeModeLabel = themeMode === 'auto' ? 'Auto' : (themeMode === 'light' ? 'Bright' : 'Dark');
  const nextThemeModeLabel = nextThemeMode === 'auto' ? 'Auto' : (nextThemeMode === 'light' ? 'Bright' : 'Dark');
  const ThemeModeIcon = themeMode === 'auto' ? Monitor : (themeMode === 'light' ? Sun : Moon);
  const handleCycleThemeMode = () => {
    setThemeMode(nextThemeMode);
  };
  const handleRepoCardMouseMove = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const wrapper = event.currentTarget;
    const card = wrapper.querySelector<HTMLElement>('.repo-card-tilt');
    if (!card) return;

    const rect = wrapper.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    if (centerX <= 0 || centerY <= 0) return;

    const rotateX = ((y - centerY) / centerY) * -12;
    const rotateY = ((x - centerX) / centerX) * 12;
    const bgPosX = 50 + (((x - centerX) / centerX) * 40);
    const bgPosY = 50 + (((y - centerY) / centerY) * 40);

    card.style.setProperty('--tilt-mouse-x', `${x}px`);
    card.style.setProperty('--tilt-mouse-y', `${y}px`);
    card.style.setProperty('--tilt-bg-pos-x', `${bgPosX}%`);
    card.style.setProperty('--tilt-bg-pos-y', `${bgPosY}%`);
    card.style.setProperty('--tilt-rotate-x', `${rotateX.toFixed(2)}deg`);
    card.style.setProperty('--tilt-rotate-y', `${rotateY.toFixed(2)}deg`);
    card.style.setProperty('--tilt-scale', '1.02');
  }, []);
  const handleRepoCardMouseLeave = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const card = event.currentTarget.querySelector<HTMLElement>('.repo-card-tilt');
    if (!card) return;

    card.style.setProperty('--tilt-rotate-x', '0deg');
    card.style.setProperty('--tilt-rotate-y', '0deg');
    card.style.setProperty('--tilt-scale', '1');
    card.style.setProperty('--tilt-bg-pos-x', '50%');
    card.style.setProperty('--tilt-bg-pos-y', '50%');
  }, []);
  const handleRepoIconError = useCallback((repo: string) => {
    setBrokenRepoCardIcons((previous) => {
      if (previous[repo]) return previous;
      return { ...previous, [repo]: true };
    });
  }, []);

  return (
    <>
      {mode === 'home' && (
        <HomeDashboard
          error={error}
          isLoaded={isLoaded}
          homeSearchQuery={homeSearchQuery}
          showLogout={showLogout}
          logoutEnabled={logoutEnabled}
          themeModeLabel={themeModeLabel}
          nextThemeModeLabel={nextThemeModeLabel}
          ThemeModeIcon={ThemeModeIcon}
          filteredRecentRepos={filteredRecentRepos}
          isDarkThemeActive={isDarkThemeActive}
          runningSessionCountByRepo={runningSessionCountByRepo}
          draftCountByRepo={draftCountByRepo}
          repoCardIconByRepo={repoCardIconByRepo}
          brokenRepoCardIcons={brokenRepoCardIcons}
          getRepoCredentialLabel={getRepoCredentialLabel}
          onHomeSearchQueryChange={setHomeSearchQuery}
          onOpenCredentials={() => router.push('/credentials')}
          onCycleThemeMode={handleCycleThemeMode}
          onSelectRepo={handleSelectRepo}
          onOpenGitWorkspace={(repo) => {
            router.push(`/git?path=${encodeURIComponent(repo)}`);
          }}
          onOpenRepoSettings={handleOpenRepoSettings}
          onRemoveRecent={handleRemoveRecent}
          onRepoIconError={handleRepoIconError}
          onRepoCardMouseMove={handleRepoCardMouseMove}
          onRepoCardMouseLeave={handleRepoCardMouseLeave}
          onAddRepository={openCloneRemoteDialog}
        />
      )}

      {mode === 'home' && (
        <RepoSettingsDialog
          isOpen={isRepoSettingsDialogOpen}
          repoForSettings={repoForSettings}
          repoCredentialSelection={repoCredentialSelection}
          repoStartupCommand={repoStartupCommand}
          repoDevServerCommand={repoDevServerCommand}
          credentialOptions={credentialOptions}
          isSavingRepoSettings={isSavingRepoSettings}
          isLoadingCredentialOptions={isLoadingCredentialOptions}
          repoSettingsError={repoSettingsError}
          onCredentialChange={setRepoCredentialSelection}
          onStartupCommandChange={setRepoStartupCommand}
          onDevServerCommandChange={setRepoDevServerCommand}
          onClose={dismissRepoSettingsDialog}
          onSave={() => {
            void handleSaveRepoSettings();
          }}
        />
      )}

      {mode === 'home' && (
        <CloneRemoteDialog
          isOpen={isCloneRemoteDialogOpen}
          defaultRoot={config?.defaultRoot}
          remoteRepoUrl={remoteRepoUrl}
          cloneCredentialSelection={cloneCredentialSelection}
          credentialOptions={credentialOptions}
          isCloningRemote={isCloningRemote}
          isLoadingCloneCredentialOptions={isLoadingCloneCredentialOptions}
          cloneRemoteError={cloneRemoteError}
          onClose={dismissCloneRemoteDialog}
          onRemoteRepoUrlChange={setRemoteRepoUrl}
          onCloneCredentialSelectionChange={setCloneCredentialSelection}
          onBrowseLocalRepository={() => {
            dismissCloneRemoteDialog();
            setIsBrowsing(true);
          }}
          onSetDefaultFolder={() => {
            dismissCloneRemoteDialog();
            setIsSelectingRoot(true);
          }}
          onCloneRepository={() => {
            void handleCloneRemoteRepo();
          }}
        />
      )}
      {mode === 'new' && selectedRepo && (
        <div className="w-full max-w-[1240px]">
          {error && (
            <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700 dark:border-red-500/40 dark:bg-red-900/30 dark:text-red-200">
              {error}
            </div>
          )}

          <div className="mb-8">
            <div className="mb-2 flex items-center gap-4">
              <button
                type="button"
                className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-white hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white"
                onClick={() => router.push('/')}
                aria-label="Back to home"
              >
                <ChevronRight className="h-6 w-6 rotate-180" />
              </button>
              <h1 className="text-3xl font-black tracking-[-0.02em] text-slate-900 md:text-4xl dark:text-white">Assign New Task</h1>
            </div>
            <p className="ml-14 text-sm text-slate-500 md:text-base dark:text-slate-400">
              Configure the environment and describe the work required for your AI agent.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            <div className="space-y-6 lg:col-span-4">
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-[#30363d] dark:bg-[#161b22] dark:shadow-[0_16px_36px_-24px_rgba(2,6,23,0.95)]">
                <h3 className="mb-5 flex items-center gap-2 text-lg font-bold text-slate-900 dark:text-white">
                  <FolderGit2 className="h-5 w-5 text-primary" />
                  Context Setup
                </h3>

                <div className="space-y-4">
                  <label className="flex flex-col gap-2">
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Select Repository</span>
                    <div className="relative">
                      <select
                        className="h-12 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-10 font-mono text-sm text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-100"
                        value={selectedRepo}
                        onChange={(event) => {
                          void handleCurrentRepoChange(event);
                        }}
                        disabled={loading || selectableRepos.length === 0}
                      >
                        {selectableRepos.map((repo) => (
                          <option key={repo} value={repo}>
                            {getBaseName(repo)}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 dark:text-slate-500" />
                    </div>
                    <span className="truncate font-mono text-[11px] text-slate-500 dark:text-slate-400" title={selectedRepo}>
                      {selectedRepo}
                    </span>
                  </label>

                  <label className="flex flex-col gap-2">
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Base Branch</span>
                    <div className="relative">
                      <select
                        className="h-12 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-10 font-mono text-sm text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-100"
                        value={currentBranchName}
                        onChange={handleBranchChange}
                        disabled={loading}
                      >
                        {branches.map((branch) => (
                          <option key={branch.name} value={branch.name}>
                            {branch.name}
                            {branch.current ? ' (checked out)' : ''}
                          </option>
                        ))}
                      </select>
                      {loading
                        ? <span className="loading loading-spinner loading-xs absolute right-3 top-1/2 -translate-y-1/2"></span>
                        : <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 dark:text-slate-500" />}
                    </div>
                  </label>

                  <button
                    type="button"
                    className="inline-flex items-center gap-2 text-sm font-medium text-slate-600 transition-colors hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
                    onClick={() => setShowSessionAdvanced((prev) => !prev)}
                  >
                    <ChevronRight className={`h-4 w-4 transition-transform ${showSessionAdvanced ? 'rotate-90' : ''}`} />
                    {showSessionAdvanced ? 'Hide Advanced Setup' : collapsedSessionSetupLabel}
                  </button>

                  {showSessionAdvanced && (
                    <div className="space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-[#30363d] dark:bg-[#0d1117]/55">
                      <label className="flex flex-col gap-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Start Up Command</span>
                        <input
                          type="text"
                          className="h-10 rounded-lg border border-slate-300 bg-white px-3 font-mono text-sm text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-100"
                          placeholder="npm install"
                          value={startupScript}
                          onChange={handleStartupScriptChange}
                          onBlur={saveStartupScript}
                          onKeyDown={(event) => {
                            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                              event.preventDefault();
                              handleStartSession();
                            }
                          }}
                          disabled={loading}
                        />
                      </label>

                      <label className="flex flex-col gap-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Dev Server Command</span>
                        <input
                          type="text"
                          className="h-10 rounded-lg border border-slate-300 bg-white px-3 font-mono text-sm text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-100"
                          placeholder="npm run dev"
                          value={devServerScript}
                          onChange={handleDevServerScriptChange}
                          onBlur={saveDevServerScript}
                          onKeyDown={(event) => {
                            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                              event.preventDefault();
                              handleStartSession();
                            }
                          }}
                          disabled={loading}
                        />
                      </label>

                      <label className="flex flex-col gap-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Session Mode</span>
                        <select
                          className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-100"
                          value={sessionMode}
                          onChange={handleSessionModeChange}
                          disabled={loading}
                        >
                          <option value="fast">Fast Mode (default)</option>
                          <option value="plan">Plan Mode</option>
                        </select>
                      </label>

                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-[#30363d] dark:bg-[#161b22] dark:shadow-[0_16px_36px_-24px_rgba(2,6,23,0.95)]">
                <h3 className="mb-4 text-lg font-bold text-slate-900 dark:text-white">Drafts</h3>
                <div className="space-y-2">
                  {existingDrafts.length === 0 && (
                    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-sm text-slate-500 dark:border-[#30363d] dark:bg-[#0d1117]/45 dark:text-slate-400">
                      No drafts for this repository.
                    </div>
                  )}

                  {existingDrafts.map((draft) => (
                    <div
                      key={draft.id}
                      className="group flex items-center gap-3 rounded-lg border border-transparent px-3 py-3 transition-colors hover:border-slate-100 hover:bg-slate-50 dark:hover:border-slate-700/70 dark:hover:bg-slate-800/50"
                    >
                      <div
                        className={`h-2 w-2 flex-shrink-0 rounded-full bg-blue-500`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-900 dark:text-white">{draft.title}</p>
                        <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {getBaseName(draft.repoPath)} • {draft.agentProvider}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                        <button
                          type="button"
                          className="rounded p-1 text-slate-400 transition-colors hover:text-primary dark:text-slate-400 dark:hover:text-primary"
                          title="Open Draft"
                          onClick={() => handleOpenDraft(draft)}
                          disabled={loading || isSavingDraft}
                        >
                          <ExternalLink className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          className="rounded p-1 text-slate-400 transition-colors hover:text-red-500 dark:text-slate-400 dark:hover:text-red-400"
                          title="Delete Draft"
                          onClick={() => handleDeleteDraft(draft.id)}
                          disabled={loading || isSavingDraft}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-[#30363d] dark:bg-[#161b22] dark:shadow-[0_16px_36px_-24px_rgba(2,6,23,0.95)]">
                <h3 className="mb-4 text-lg font-bold text-slate-900 dark:text-white">Ongoing Tasks</h3>
                <div className="space-y-2">
                  {existingSessions.length === 0 && (
                    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-sm text-slate-500 dark:border-[#30363d] dark:bg-[#0d1117]/45 dark:text-slate-400">
                      No ongoing sessions for this repository.
                    </div>
                  )}

                  {existingSessions.map((session) => (
                    <div
                      key={session.sessionName}
                      className="group flex items-center gap-3 rounded-lg border border-transparent px-3 py-3 transition-colors hover:border-slate-100 hover:bg-slate-50 dark:hover:border-slate-700/70 dark:hover:bg-slate-800/50"
                    >
                      <div
                        className={`h-2 w-2 flex-shrink-0 rounded-full ${deletingSessionName === session.sessionName ? 'animate-pulse bg-amber-400' : 'bg-emerald-500'
                          }`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-900 dark:text-white">{session.title || session.sessionName}</p>
                        <p className="truncate text-xs text-slate-500 dark:text-slate-400">
                          {getBaseName(session.repoPath)} • {session.agent}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100">
                        <button
                          type="button"
                          className="rounded p-1 text-slate-400 transition-colors hover:text-primary dark:text-slate-400 dark:hover:text-primary"
                          title="Open"
                          onClick={() => handleResumeSession(session)}
                          disabled={loading || deletingSessionName === session.sessionName}
                        >
                          <ExternalLink className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          className="rounded p-1 text-slate-400 transition-colors hover:text-amber-500 dark:text-slate-400 dark:hover:text-amber-400"
                          title="New Attempt"
                          onClick={() => handleNewAttemptFromSession(session)}
                          disabled={loading || deletingSessionName === session.sessionName}
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          className="rounded p-1 text-slate-400 transition-colors hover:text-red-500 dark:text-slate-400 dark:hover:text-red-400"
                          title={deletingSessionName === session.sessionName ? 'Deleting...' : 'Delete'}
                          onClick={() => handleDeleteSession(session)}
                          disabled={loading || deletingSessionName === session.sessionName}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex flex-col lg:col-span-8">
              <div className="flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-[#30363d] dark:bg-[#161b22] dark:shadow-[0_16px_36px_-24px_rgba(2,6,23,0.95)]">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-lg font-bold text-slate-900 dark:text-white" htmlFor="task-description">
                    <Bot className="h-5 w-5 text-primary" />
                    Task Description
                  </label>
                  {hasPredefinedPrompts && (
                    <div className="flex flex-wrap items-center gap-2">
                      {predefinedPrompts.map((prompt) => {
                        const isActivePrompt = initialMessage === prompt.content;
                        return (
                          <button
                            key={prompt.id}
                            type="button"
                            className={`rounded-full border px-3 py-1 text-xs font-semibold transition-colors ${isActivePrompt
                                ? 'border-primary bg-primary/10 text-primary dark:border-primary dark:bg-primary/20 dark:text-blue-300'
                                : 'border-slate-300 bg-white text-slate-700 hover:border-primary hover:text-primary dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:border-primary dark:hover:text-blue-300'
                              }`}
                            onClick={() => handleApplyPredefinedPrompt(prompt.content)}
                            disabled={loading}
                            aria-label={`Fill task description with ${prompt.label} prompt`}
                          >
                            {prompt.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="group relative mb-4 flex h-[360px] flex-grow flex-col md:h-[420px]">
                  <textarea
                    id="task-description"
                    className="h-full w-full resize-none rounded-xl border border-slate-200 bg-slate-50 p-5 font-mono text-sm leading-relaxed text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-100 dark:placeholder:text-slate-500"
                    placeholder={`Describe the task for the AI agent...\nExample:\n1. Create a new component for the user profile card.\n2. Ensure it fetches data from the /api/user endpoint.\n3. Add error handling for failed requests.\n\nTip: Type @ to mention files.`}
                    value={initialMessage}
                    onChange={handleMessageChange}
                    onKeyDown={handleKeyDown}
                    onClick={(event) => {
                      setCursorPosition(event.currentTarget.selectionStart);
                      setShowSuggestions(false);
                    }}
                    onKeyUp={(event) => setCursorPosition(event.currentTarget.selectionStart)}
                    disabled={loading}
                  />

                  {showSuggestions && suggestionList.length > 0 && (
                    <div className="absolute left-3 right-3 top-[calc(100%-8rem)] z-50 max-h-48 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg dark:border-[#30363d] dark:bg-[#161b22]">
                      {suggestionList.map((suggestion, idx) => (
                        <button
                          key={suggestion}
                          className={`w-full truncate border-b border-slate-100 px-3 py-2 text-left text-xs last:border-0 ${idx === selectedIndex
                              ? 'bg-primary text-white'
                              : 'text-slate-700 hover:bg-slate-50 dark:border-slate-700/60 dark:text-slate-300 dark:hover:bg-slate-800/60'
                            }`}
                          onMouseDown={(event) => {
                            event.preventDefault();
                            handleSelectSuggestion(suggestion);
                          }}
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border-t border-slate-100 pt-4 dark:border-slate-700/70">
                  <div className="mb-3 flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
                    <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300">Attachments</h4>
                    <button
                      type="button"
                      className="inline-flex items-center gap-2 text-sm font-medium text-primary transition-colors hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                      onClick={() => setIsAttachmentBrowserOpen(true)}
                      disabled={loading || !selectedRepo}
                    >
                      <CloudDownload className="h-4 w-4" />
                      Select Attachments
                    </button>
                  </div>

                  <div className="min-h-[88px] rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/70 p-3 dark:border-slate-700 dark:bg-[#0d1117]/40">
                    <div className="flex flex-wrap gap-2">
                      {attachments.map((attachmentPath, idx) => (
                        <span
                          key={`upload-${attachmentPath}-${idx}`}
                          className="inline-flex max-w-full items-center gap-2 rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                          title={attachmentPath}
                        >
                          <span className="truncate">{getBaseName(attachmentPath)}</span>
                          <button
                            type="button"
                            className="rounded text-slate-500 transition hover:text-red-500 dark:text-slate-400 dark:hover:text-red-400"
                            onClick={() => removeAttachment(idx)}
                            title="Remove attachment"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}

                      {prefilledAttachmentPaths.map((attachmentPath, idx) => (
                        <span
                          key={`prefill-${attachmentPath}-${idx}`}
                          className="inline-flex max-w-full items-center gap-2 rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
                          title={attachmentPath}
                        >
                          <span className="truncate">{getBaseName(attachmentPath)}</span>
                          <button
                            type="button"
                            className="rounded text-slate-500 transition hover:text-red-500 dark:text-slate-400 dark:hover:text-red-400"
                            onClick={() => removePrefilledAttachment(idx)}
                            title="Remove carried attachment"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}

                      {(attachments.length === 0 && prefilledAttachmentPaths.length === 0) && (
                        <span className="text-xs text-slate-500 dark:text-slate-400">No attachments selected.</span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="mt-6 flex items-center justify-end gap-3 border-t border-slate-100 pt-5 dark:border-slate-700/70">
                  <span className="mr-auto hidden text-xs text-slate-400 dark:text-slate-500 sm:block">
                    Press <kbd className="rounded border border-slate-200 bg-slate-100 px-2 py-1 font-sans text-[11px] dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">Ctrl + Enter</kbd> to submit
                  </span>
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 rounded-lg bg-slate-200 px-5 py-2 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-300 dark:bg-slate-700 dark:text-white dark:hover:bg-slate-600 disabled:cursor-not-allowed disabled:opacity-70"
                    onClick={handleSaveDraft}
                    disabled={loading || isSavingDraft}
                  >
                    {isSavingDraft ? <span className="loading loading-spinner loading-xs"></span> : 'Save Draft'}
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-white shadow-md shadow-primary/20 transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-70"
                    onClick={handleStartSession}
                    disabled={loading || isSavingDraft}
                  >
                    {loading ? <span className="loading loading-spinner loading-xs"></span> : 'Create New Task'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {mode === 'new' && !selectedRepo && !!repoPath && !error && (
        <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm dark:border-[#30363d] dark:bg-[#161b22] dark:shadow-[0_16px_36px_-24px_rgba(2,6,23,0.95)]">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="loading loading-spinner loading-lg text-primary"></span>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Loading repository...</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">Preparing your task workspace.</p>
          </div>
        </div>
      )}

      {mode === 'new' && isInstallingAgentCli && installingAgentCli && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-base-content/45 px-4">
          <div className="w-full max-w-md rounded-xl border border-base-300 bg-base-100 p-6 shadow-2xl">
            <div className="flex items-center gap-4">
              <span className="loading loading-spinner loading-lg text-primary"></span>
              <div className="space-y-1">
                <h3 className="text-lg font-semibold">Installing {AGENT_CLI_LABELS[installingAgentCli]}</h3>
                <p className="text-sm opacity-70">
                  Please wait while we install the coding agent CLI.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {mode === 'new' && isLoginModalOpen && loginAgentCli && (
        <div className="fixed inset-0 z-[1001] flex items-center justify-center bg-base-content/60 p-4">
          <div className="w-full max-w-5xl rounded-xl border border-base-300 bg-base-100 shadow-2xl">
            <div className="space-y-4 p-5 md:p-6">
              <h3 className="text-xl font-semibold">Login Required</h3>
              <p className="text-sm opacity-80">
                {AGENT_CLI_LABELS[loginAgentCli]} has been installed. Complete login in the terminal below, then click Done to continue.
              </p>
              <p className="text-xs opacity-60">
                Command: <span className="font-mono">{loginCommand}</span>
              </p>

              <div className="h-[420px] overflow-hidden rounded-lg border border-base-300 bg-base-200">
                <iframe
                  ref={loginTerminalRef}
                  src="/terminal"
                  className="h-full w-full border-none"
                  allow="clipboard-read; clipboard-write"
                  onLoad={handleLoginTerminalLoad}
                />
              </div>

              {loginModalError && (
                <div className="alert alert-error text-sm py-2">
                  {loginModalError}
                </div>
              )}

              {!loginModalError && (
                <div className="text-xs opacity-70">
                  {loginCommandInjected
                    ? 'Login command was sent to the terminal automatically.'
                    : 'Waiting for terminal to initialize...'}
                </div>
              )}

              <div className="flex justify-end">
                <button
                  className="btn btn-primary"
                  onClick={() => void handleLoginDone()}
                  disabled={loading}
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {mode === 'new' && !selectedRepo && (!repoPath || !!error) && (
        <div className="card w-full max-w-2xl bg-base-200 shadow-xl">
          <div className="card-body">
            <h2 className="card-title flex items-center gap-2">
              <FolderGit2 className="w-6 h-6 text-primary" />
              Git Repository Selector
            </h2>
            {isResolvingRepoFromName ? (
              <div className="alert text-sm py-2 px-3 mt-2 flex items-center gap-2">
                <span className="loading loading-spinner loading-sm"></span>
                {fromRepoName
                  ? `Searching for repository "${fromRepoName}"...`
                  : 'Searching for repository...'}
              </div>
            ) : error ? (
              <div className="alert alert-error text-sm py-2 px-3 mt-2">{error}</div>
            ) : (
              <div className="text-sm opacity-70 mt-2">No repository specified.</div>
            )}
            <div className="mt-4">
              <button className="btn btn-primary btn-sm" onClick={() => router.push('/')}>
                Choose Repository
              </button>
            </div>
          </div>
        </div>
      )}


      {mode === 'new' && selectedRepo && isAttachmentBrowserOpen && (
        <SessionFileBrowser
          initialPath={lastAttachmentBrowserPath || selectedRepo}
          onPathChange={setLastAttachmentBrowserPath}
          onConfirm={async (paths) => {
            appendAttachmentPaths(paths);
            setIsAttachmentBrowserOpen(false);
          }}
          onCancel={() => setIsAttachmentBrowserOpen(false)}
        />
      )}

      {mode === 'home' && isBrowsing && (
        <FileBrowser
          initialPath={config?.defaultRoot || undefined}
          onSelect={handleSelectRepo}
          onCancel={() => setIsBrowsing(false)}
          checkRepo={checkIsGitRepo}
        />
      )}

      {mode === 'home' && isSelectingRoot && (
        <FileBrowser
          title="Default Root Folder"
          initialPath={config?.defaultRoot || undefined}
          onSelect={handleSetDefaultRoot}
          onCancel={() => setIsSelectingRoot(false)}
        />
      )}
    </>
  );
}
