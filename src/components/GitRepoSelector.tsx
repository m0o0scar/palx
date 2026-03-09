'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { FolderGit2, Plus, X, ChevronRight, ChevronDown, Bot, Trash2, ExternalLink, CloudDownload, Monitor, Sun, Moon } from 'lucide-react';
import FileBrowser from './FileBrowser';
import {
  GitBranch,
  listRepoFiles,
  resolveRepoCardIcon,
} from '@/app/actions/git';
import {
  cloneRemoteProject,
  discoverProjectGitRepos,
  discoverProjectGitReposWithBranches,
  getProjectActivity,
  resolveProjectByName,
} from '@/app/actions/project';
import { createSession, deleteSession, getSessionPrefillContext, listSessions, saveSessionLaunchContext, SessionMetadata } from '@/app/actions/session';
import { deleteDraft, listDrafts, saveDraft, DraftMetadata } from '@/app/actions/draft';
import { getConfig, updateConfig, updateProjectSettings, Config } from '@/app/actions/config';
import { listCredentials } from '@/app/actions/credentials';
import type { Credential } from '@/lib/credentials';
import { useRouter } from 'next/navigation';
import { getBaseName } from '@/lib/path';
import { buildRepoMentionSuggestions } from '@/lib/repo-mention-suggestions';
import { doesSessionPrefillMatchProject } from '@/lib/session-prefill';
import { notifySessionsUpdated, subscribeToSessionsUpdated } from '@/lib/session-updates';
import { consumePendingSessionNavigationRetry, recordPendingSessionNavigation } from '@/lib/session-navigation';
import { buildAgentStartupPrompt, hasStartupTaskDescription } from '@/lib/agent-startup-prompt';
import { normalizeProviderReasoningEffort } from '@/lib/agent/reasoning';
import {
  resolveShouldUseDarkTheme,
  THEME_MODE_STORAGE_KEY,
  THEME_REFRESH_EVENT,
} from '@/lib/ttyd-theme';
import { useDialogKeyboardShortcuts } from '@/hooks/useDialogKeyboardShortcuts';
import SessionFileBrowser from './SessionFileBrowser';
import { HomeDashboard } from './git-repo-selector/HomeDashboard';
import { RepoSettingsDialog } from './git-repo-selector/RepoSettingsDialog';
import { CloneRemoteDialog } from './git-repo-selector/CloneRemoteDialog';
import { type RepoCredentialSelection } from './git-repo-selector/types';
import type {
  AgentProvider,
  AppStatus,
  ModelOption,
  ProviderCatalogEntry,
  ReasoningEffort,
} from '@/lib/types';

type SessionMode = 'fast' | 'plan';
type ThemeMode = 'auto' | 'light' | 'dark';
const DEFAULT_PROJECT_STARTUP_COMMAND = '';
const DEFAULT_PROJECT_DEV_SERVER_COMMAND = '';
const THEME_MODE_SEQUENCE: ThemeMode[] = ['auto', 'light', 'dark'];
const HOME_REPO_DISCOVERY_IDLE_TIMEOUT_MS = 1500;
const HOME_REPO_DISCOVERY_MAX_AUTOSTART = 6;

const SESSION_MODE_STORAGE_KEY = 'viba:new-session-mode';
const SESSION_TITLE_MAX_LENGTH = 120;
const SUPPORTED_AGENT_PROVIDERS = ['codex', 'gemini', 'cursor'] as const;
const AGENT_PROVIDER_FALLBACK_LABELS: Record<string, string> = {
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  cursor: 'Cursor Agent CLI',
};

type PredefinedPrompt = {
  id: string;
  group: string;
  label: string;
  content: string;
};

type GitRepoSelectorProps = {
  mode?: 'home' | 'new';
  projectPath?: string | null;
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

function arePathListsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

type AgentStatusResponse = {
  providers: ProviderCatalogEntry[];
  defaultProvider: AgentProvider;
  status: AppStatus | null;
  error?: string;
};

type AgentLoginResponse =
  | {
      kind: 'browser';
      authUrl: string;
      loginId?: string | null;
      message?: string | null;
    }
  | {
      kind: 'pending';
      loginId?: string | null;
      message: string;
    };

function normalizeAgentProvider(value: string | null | undefined): AgentProvider {
  return value === 'codex' || value === 'gemini' || value === 'cursor' ? value : 'codex';
}

function agentProviderLabel(provider: string, providers: ProviderCatalogEntry[] = []): string {
  return providers.find((entry) => entry.id === provider)?.label
    || AGENT_PROVIDER_FALLBACK_LABELS[provider]
    || provider;
}

function normalizeReasoningSelection(value: string): ReasoningEffort | undefined {
  const normalized = value.trim();
  return normalized ? normalized as ReasoningEffort : undefined;
}

function normalizeProviderReasoningSelection(
  provider: AgentProvider,
  value: string,
): ReasoningEffort | undefined {
  return normalizeProviderReasoningEffort(provider, normalizeReasoningSelection(value));
}

export default function GitRepoSelector({
  mode = 'home',
  projectPath = null,
  repoPath: legacyRepoPath = null,
  fromRepoName = null,
  prefillFromSession = null,
  predefinedPrompts = [],
  showLogout = false,
  logoutEnabled = true,
}: GitRepoSelectorProps) {
  const repoPath = projectPath ?? legacyRepoPath;
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
  const [repoAlias, setRepoAlias] = useState<string>('');
  const [repoStartupCommand, setRepoStartupCommand] = useState<string>(DEFAULT_PROJECT_STARTUP_COMMAND);
  const [repoDevServerCommand, setRepoDevServerCommand] = useState<string>(DEFAULT_PROJECT_DEV_SERVER_COMMAND);
  const [projectIconPathForSettings, setProjectIconPathForSettings] = useState<string | null>(null);
  const [credentialOptions, setCredentialOptions] = useState<Credential[]>([]);

  const router = useRouter();

  const [currentBranchName, setCurrentBranchName] = useState<string>('');
  const [projectGitRepos, setProjectGitRepos] = useState<string[]>([]);
  const [branchesByRepo, setBranchesByRepo] = useState<Record<string, GitBranch[]>>({});
  const [baseBranchByRepo, setBaseBranchByRepo] = useState<Record<string, string>>({});
  const [isLoadingProjectGitRepos, setIsLoadingProjectGitRepos] = useState(false);
  const [isProjectGitReposTruncated, setIsProjectGitReposTruncated] = useState(false);
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
  const [agentProviders, setAgentProviders] = useState<ProviderCatalogEntry[]>([]);
  const [selectedAgentProvider, setSelectedAgentProvider] = useState<AgentProvider>('codex');
  const [selectedAgentModel, setSelectedAgentModel] = useState('');
  const [selectedReasoningEffort, setSelectedReasoningEffort] = useState<ReasoningEffort | ''>('');
  const [agentStatus, setAgentStatus] = useState<AppStatus | null>(null);
  const [isLoadingAgentStatus, setIsLoadingAgentStatus] = useState(false);
  const [isInstallingAgentProvider, setIsInstallingAgentProvider] = useState(false);
  const [installingAgentProvider, setInstallingAgentProvider] = useState<AgentProvider | null>(null);
  const [installLogs, setInstallLogs] = useState<string[]>([]);
  const [agentSetupMessage, setAgentSetupMessage] = useState<string | null>(null);
  const [isWaitingForLogin, setIsWaitingForLogin] = useState(false);
  const [waitingForLoginProvider, setWaitingForLoginProvider] = useState<AgentProvider | null>(null);
  const [homeSearchQuery, setHomeSearchQuery] = useState('');
  const [repoSettingsError, setRepoSettingsError] = useState<string | null>(null);
  const [isUploadingProjectIcon, setIsUploadingProjectIcon] = useState(false);
  const [isSavingRepoSettings, setIsSavingRepoSettings] = useState(false);
  const [repoCardIconByRepo, setRepoCardIconByRepo] = useState<Record<string, string | null>>({});
  const [brokenRepoCardIcons, setBrokenRepoCardIcons] = useState<Record<string, boolean>>({});
  const [projectGitReposByPath, setProjectGitReposByPath] = useState<Record<string, string[]>>({});
  const [discoveringHomeProjectGitRepos, setDiscoveringHomeProjectGitRepos] = useState<Record<string, boolean>>({});
  const [homeProjectGitSelector, setHomeProjectGitSelector] = useState<{
    projectPath: string;
    repos: string[];
  } | null>(null);
  const repoCardIconResolutionsInFlightRef = useRef<Set<string>>(new Set());
  const selectedProjectLoadRequestRef = useRef(0);
  const pendingProjectRouteSyncRef = useRef<string | null>(null);

  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const sessionNavigationCommittedRef = useRef(false);
  const agentRuntimeSettingsRequestRef = useRef(0);

  const collapsedSessionSetupLabel = 'Show Session Setup';

  const notifySessionsChanged = useCallback(() => {
    notifySessionsUpdated();
  }, []);

  const isActiveSelectedProjectLoad = useCallback((requestId: number) => {
    return selectedProjectLoadRequestRef.current === requestId;
  }, []);

  const resetSelectedProjectState = useCallback((projectPath: string) => {
    setSelectedRepo(projectPath);
    setRepoFilesCache([]);
    setProjectGitRepos([]);
    setBranchesByRepo({});
    setBaseBranchByRepo({});
    setCurrentBranchName('');
    setIsProjectGitReposTruncated(false);
    setExistingSessions([]);
    setExistingDrafts([]);
    setStartupScript('');
    setDevServerScript('');
  }, []);

  const beginSelectedProjectLoad = useCallback((projectPath: string) => {
    const requestId = selectedProjectLoadRequestRef.current + 1;
    selectedProjectLoadRequestRef.current = requestId;
    resetSelectedProjectState(projectPath);
    return requestId;
  }, [resetSelectedProjectState]);

  const navigateToSession = useCallback((sessionName: string, options?: { fresh?: boolean }) => {
    const targetPath = options?.fresh
      ? `/session/${encodeURIComponent(sessionName)}?fresh=1`
      : `/session/${encodeURIComponent(sessionName)}`;
    sessionNavigationCommittedRef.current = true;
    recordPendingSessionNavigation(sessionName);
    // Use a hard navigation here. App Router transitions out of /new can be interrupted
    // by pending server actions and iframe teardown, which can briefly land on /session
    // and then snap back to /new. A full replace avoids that rollback path.
    window.location.replace(targetPath);
  }, []);

  const refreshSessionData = useCallback(async (
    repo: string | null = selectedRepo,
    options?: { includeGlobal?: boolean },
    selectedProjectRequestId?: number,
  ) => {
    const includeGlobal = options?.includeGlobal ?? mode === 'home';

    try {
      if (!includeGlobal && repo) {
        const activity = await getProjectActivity(repo);
        if (
          selectedProjectRequestId !== undefined
          && !isActiveSelectedProjectLoad(selectedProjectRequestId)
        ) {
          return;
        }
        setExistingSessions(activity.sessions);
        setExistingDrafts(activity.drafts);
        return;
      }

      const [allSess, repoSess, allD, repoD] = await Promise.all([
        includeGlobal ? listSessions() : Promise.resolve(null),
        repo ? listSessions(repo) : Promise.resolve([] as SessionMetadata[]),
        includeGlobal ? listDrafts() : Promise.resolve(null),
        repo ? listDrafts(repo) : Promise.resolve([] as DraftMetadata[]),
      ]);

      if (allSess) {
        setAllSessions(allSess);
      }
      if (allD) {
        setAllDrafts(allD);
      }
      if (repo) {
        if (
          selectedProjectRequestId !== undefined
          && !isActiveSelectedProjectLoad(selectedProjectRequestId)
        ) {
          return;
        }
        setExistingSessions(repoSess);
        setExistingDrafts(repoD);
      }
    } catch (e) {
      console.error('Failed to refresh sessions and drafts', e);
    }
  }, [isActiveSelectedProjectLoad, mode, selectedRepo]);

  const dismissRepoSettingsDialog = useCallback(() => {
    if (isSavingRepoSettings) return;
    setIsRepoSettingsDialogOpen(false);
    setRepoForSettings(null);
    setRepoStartupCommand(DEFAULT_PROJECT_STARTUP_COMMAND);
    setRepoDevServerCommand(DEFAULT_PROJECT_DEV_SERVER_COMMAND);
    setProjectIconPathForSettings(null);
    setRepoSettingsError(null);
    setIsUploadingProjectIcon(false);
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

  // Load home dashboard data on mount. The /new route loads project-specific data lazily.
  useEffect(() => {
    if (mode !== 'home') {
      setIsLoaded(true);
      return;
    }

    let cancelled = false;

    const loadData = async () => {
      try {
        const [cfg, sessions, drafts] = await Promise.all([
          getConfig(),
          listSessions(),
          listDrafts(),
        ]);
        if (cancelled) return;
        setConfig(cfg);
        setAllSessions(sessions);
        setAllDrafts(drafts);
      } catch (e) {
        console.error('Failed to load data', e);
      } finally {
        if (!cancelled) {
          setIsLoaded(true);
        }
      }
    };
    void loadData();

    return () => {
      cancelled = true;
    };
  }, [mode]);

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
      document.documentElement.classList.toggle('dark', shouldUseDark);
      document.documentElement.dataset.themeMode = themeMode;
      setIsDarkThemeActive(shouldUseDark);
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
    if (mode === 'new' && !selectedRepo) {
      return;
    }

    const refresh = () => {
      const repoForList = mode === 'new' ? selectedRepo : null;
      void refreshSessionData(repoForList, { includeGlobal: mode === 'home' });
    };

    const unsubscribeSessionsUpdated = subscribeToSessionsUpdated(refresh);
    if (mode === 'home') {
      refresh();
    }

    return () => {
      unsubscribeSessionsUpdated();
    };
  }, [mode, refreshSessionData, selectedRepo]);

  const loadProjectGitRepos = async (projectPath: string, selectedProjectRequestId?: number) => {
    setIsLoadingProjectGitRepos(true);
    try {
      const discovery = await discoverProjectGitReposWithBranches(projectPath);
      if (
        selectedProjectRequestId !== undefined
        && !isActiveSelectedProjectLoad(selectedProjectRequestId)
      ) {
        return;
      }
      const repoPaths = discovery.repos.map((repo) => repo.repoPath);
      setProjectGitRepos(repoPaths);
      setIsProjectGitReposTruncated(discovery.truncated);

      const nextBranchesByRepo: Record<string, GitBranch[]> = {};
      const nextBaseBranchByRepo: Record<string, string> = {};
      for (const repoPath of repoPaths) {
        const repoBranches = discovery.branchesByRepo[repoPath] ?? [];
        nextBranchesByRepo[repoPath] = repoBranches;
        const currentBranch = repoBranches.find((branch) => branch.current)?.name;
        if (currentBranch) {
          nextBaseBranchByRepo[repoPath] = currentBranch;
        } else if (repoBranches[0]?.name) {
          nextBaseBranchByRepo[repoPath] = repoBranches[0].name;
        }
      }

      setBranchesByRepo(nextBranchesByRepo);
      setBaseBranchByRepo(nextBaseBranchByRepo);

      const primaryRepo = repoPaths[0] || '';
      setCurrentBranchName(primaryRepo ? (nextBaseBranchByRepo[primaryRepo] || '') : '');
    } catch (loadError) {
      if (
        selectedProjectRequestId !== undefined
        && !isActiveSelectedProjectLoad(selectedProjectRequestId)
      ) {
        return;
      }
      console.error('Failed to discover project git repositories:', loadError);
      setProjectGitRepos([]);
      setBranchesByRepo({});
      setBaseBranchByRepo({});
      setCurrentBranchName('');
      setIsProjectGitReposTruncated(false);
    } finally {
      if (
        selectedProjectRequestId === undefined
        || isActiveSelectedProjectLoad(selectedProjectRequestId)
      ) {
        setIsLoadingProjectGitRepos(false);
      }
    }
  };

  const loadSelectedRepoData = async (
    path: string,
    resolvedConfig?: Config,
    selectedProjectRequestId?: number,
  ) => {
    // Load saved session scripts
    await loadSavedAgentSettings(path, resolvedConfig, selectedProjectRequestId);
    if (
      selectedProjectRequestId !== undefined
      && !isActiveSelectedProjectLoad(selectedProjectRequestId)
    ) {
      return;
    }

    await Promise.all([
      loadProjectGitRepos(path, selectedProjectRequestId),
      refreshSessionData(path, { includeGlobal: false }, selectedProjectRequestId),
    ]);
  };

  const getRepoDisplayPath = useCallback((repoPath: string, totalRepos: number): string => {
    if (!selectedRepo) return repoPath;
    if (totalRepos === 1) {
      return getBaseName(selectedRepo) || selectedRepo;
    }
    return toProjectRelativeRepoPath(selectedRepo, repoPath);
  }, [selectedRepo]);

  const ensureProjectRegistered = useCallback(async (projectPath: string) => {
    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: projectPath, name: getBaseName(projectPath) }),
      });

      if (response.ok) return;

      const payload = await response.json().catch(() => null) as { error?: unknown } | null;
      const errorMessage = typeof payload?.error === 'string' ? payload.error : '';
      if (/already exists/i.test(errorMessage)) return;
      if (response.status === 500 && !errorMessage) return;

      console.warn('Failed to ensure project registration:', errorMessage || response.statusText);
    } catch (error) {
      console.warn('Failed to ensure project registration:', error);
    }
  }, []);

  const handleSelectRepo = async (
    path: string,
    options?: { navigateToNewInHome?: boolean },
  ) => {
    setLoading(true);
    setError(null);
    const selectedProjectRequestId = mode === 'new'
      ? beginSelectedProjectLoad(path)
      : undefined;
    try {
      await ensureProjectRegistered(path);

      const currentConfig = config || await getConfig();
      if (
        selectedProjectRequestId !== undefined
        && !isActiveSelectedProjectLoad(selectedProjectRequestId)
      ) {
        return false;
      }
      if (!config) {
        setConfig(currentConfig);
      }
      let newRecent = [...currentConfig.recentProjects];
      if (!newRecent.includes(path)) {
        newRecent.unshift(path);
      } else {
        // Move to top
        newRecent = [path, ...newRecent.filter(r => r !== path)];
      }

      const nextConfig = arePathListsEqual(newRecent, currentConfig.recentProjects)
        ? currentConfig
        : await updateConfig({ recentProjects: newRecent });
      if (
        selectedProjectRequestId !== undefined
        && !isActiveSelectedProjectLoad(selectedProjectRequestId)
      ) {
        return false;
      }
      setConfig(nextConfig);

      setIsBrowsing(false);

      if (mode === 'home' && options?.navigateToNewInHome !== false) {
        router.push(`/new?project=${encodeURIComponent(path)}`);
        return true;
      }

      if (mode === 'home') {
        return true;
      }

      await loadSelectedRepoData(path, nextConfig, selectedProjectRequestId);
      if (
        selectedProjectRequestId !== undefined
        && !isActiveSelectedProjectLoad(selectedProjectRequestId)
      ) {
        return false;
      }
      return true;
    } catch (err) {
      console.error(err);
      if (
        selectedProjectRequestId === undefined
        || isActiveSelectedProjectLoad(selectedProjectRequestId)
      ) {
        setError('Failed to open project.');
      }
      return false;
    } finally {
      if (
        selectedProjectRequestId === undefined
        || isActiveSelectedProjectLoad(selectedProjectRequestId)
      ) {
        setLoading(false);
      }
    }
  };

  const handleCloneRemoteRepo = async () => {
    if (isCloningRemote) return;

    const trimmedRemoteUrl = remoteRepoUrl.trim();
    if (!trimmedRemoteUrl) {
      setCloneRemoteError('Please enter a remote project URL.');
      return;
    }

    setIsCloningRemote(true);
    setCloneRemoteError(null);
    setError(null);

    try {
      const result = await cloneRemoteProject(
        trimmedRemoteUrl,
        cloneCredentialSelection === 'auto' ? null : cloneCredentialSelection,
      );

      if (!result.success || !result.projectPath) {
        setCloneRemoteError(result.error || 'Failed to clone project.');
        return;
      }

      const opened = await handleSelectRepo(result.projectPath, { navigateToNewInHome: false });
      if (!opened) {
        setCloneRemoteError('Project was cloned, but failed to open it.');
        return;
      }

      setIsCloneRemoteDialogOpen(false);
      setRemoteRepoUrl('');
      setCloneCredentialSelection('auto');
      setCloneRemoteError(null);
    } catch (error) {
      console.error(error);
      setCloneRemoteError('Failed to clone project.');
    } finally {
      setIsCloningRemote(false);
    }
  };

  const handleCurrentRepoChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (mode !== 'new') return;

    const nextRepo = e.target.value;
    if (!nextRepo || nextRepo === selectedRepo) return;

    pendingProjectRouteSyncRef.current = nextRepo;
    const changed = await handleSelectRepo(nextRepo);
    if (!changed) {
      pendingProjectRouteSyncRef.current = null;
      return;
    }
    if (sessionNavigationCommittedRef.current) {
      pendingProjectRouteSyncRef.current = null;
      return;
    }

    const params = new URLSearchParams();
    params.set('project', nextRepo);
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
    router.replace(`/session/${encodeURIComponent(retrySessionName)}`);
  }, [mode, router]);

  useEffect(() => {
    if (mode !== 'new') return;

    if (!repoPath) {
      pendingProjectRouteSyncRef.current = null;
      setSelectedRepo(null);
      setExistingSessions([]);
      setCurrentBranchName('');
      return;
    }

    const pendingProjectRouteSync = pendingProjectRouteSyncRef.current;
    if (pendingProjectRouteSync) {
      if (repoPath !== pendingProjectRouteSync) {
        return;
      }
      pendingProjectRouteSyncRef.current = null;
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

      const result = await resolveProjectByName(trimmedFromRepoName);
      if (isCancelled) return;

      if (!result.success) {
        setError(result.error || 'Failed to search repositories.');
        setIsResolvingRepoFromName(false);
        return;
      }

      if (!result.projectPath) {
        setError(`Could not find a matching project for "${trimmedFromRepoName}".`);
        setIsResolvingRepoFromName(false);
        return;
      }

      const params = new URLSearchParams();
      params.set('project', result.projectPath);
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
      if (!doesSessionPrefillMatchProject(context, selectedRepo)) {
        setHasAppliedPrefill(true);
        return;
      }

      setInitialMessage(context.initialMessage || '');
      setPrefilledAttachmentPaths(context.attachmentPaths || []);
      const resolvedProvider = normalizeAgentProvider(context.agentProvider);
      setSelectedAgentProvider(resolvedProvider);
      setSelectedAgentModel(context.model || '');
      setSelectedReasoningEffort(
        normalizeProviderReasoningEffort(resolvedProvider, context.reasoningEffort) || '',
      );
      setShowSessionAdvanced(true);
      setHasAppliedPrefill(true);
    };

    void loadPrefill();

    return () => {
      isCancelled = true;
    };
  }, [hasAppliedPrefill, mode, prefillFromSession, selectedRepo]);

  const loadSavedAgentSettings = async (
    repoPath: string,
    resolvedConfig?: Config,
    selectedProjectRequestId?: number,
  ) => {
    // Refresh config to ensure we have latest settings?
    // We can just rely on current config state if we assume single user or minimal concurrency.
    // Or we can refetch.
    const currentConfig = resolvedConfig || config || await getConfig();
    if (
      selectedProjectRequestId !== undefined
      && !isActiveSelectedProjectLoad(selectedProjectRequestId)
    ) {
      return;
    }
    if (!config && currentConfig) setConfig(currentConfig);

    const settings = currentConfig.projectSettings[repoPath] || {};
    const resolvedProvider = normalizeAgentProvider(settings.agentProvider);
    setSelectedAgentProvider(resolvedProvider);
    setSelectedAgentModel(settings.agentModel || '');
    setSelectedReasoningEffort(
      normalizeProviderReasoningEffort(resolvedProvider, settings.agentReasoningEffort) || '',
    );

    const savedStartupScript = settings.startupScript;
    const savedDevServerScript = settings.devServerScript;

    if (savedStartupScript !== undefined && savedStartupScript !== null) {
      setStartupScript(savedStartupScript);
    } else {
      setStartupScript('');
    }

    if (savedDevServerScript !== undefined && savedDevServerScript !== null) {
      setDevServerScript(savedDevServerScript);
    } else {
      setDevServerScript('');
    }
  };

  const handleSetDefaultRoot = async (path: string) => {
    const newConfig = await updateConfig({ defaultRoot: path });
    setConfig(newConfig);
    setIsSelectingRoot(false);
  };

  const handleBranchChange = (repoPath: string, newBranch: string) => {
    if (!repoPath) return;
    setBaseBranchByRepo((previous) => ({ ...previous, [repoPath]: newBranch }));

    const primaryRepo = projectGitRepos[0];
    if (primaryRepo === repoPath) {
      setCurrentBranchName(newBranch);
    }
  };

  const handleAgentProviderChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const nextProvider = normalizeAgentProvider(event.target.value);
    setSelectedAgentProvider(nextProvider);
    setSelectedAgentModel('');
    setSelectedReasoningEffort('');
    setAgentStatus(null);
    setAgentSetupMessage(null);
    setIsWaitingForLogin(false);
    setWaitingForLoginProvider(null);
  };

  const handleAgentModelChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedAgentModel(event.target.value);
  };

  const handleReasoningEffortChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedReasoningEffort(event.target.value as ReasoningEffort | '');
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

  const handleStartupScriptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
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
      const newConfig = await updateProjectSettings(selectedRepo, { startupScript });
      setConfig(newConfig);
    }
  }

  const handleDevServerScriptChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDevServerScript(e.target.value);
  };

  const saveDevServerScriptValue = async (script: string) => {
    if (selectedRepo) {
      const newConfig = await updateProjectSettings(selectedRepo, { devServerScript: script });
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

  // Cache repo entries for @ mention suggestions.
  const [repoFilesCache, setRepoFilesCache] = useState<string[]>([]);
  const selectedAttachmentNames = useMemo(
    () => attachments.map((attachmentPath) => getBaseName(attachmentPath)),
    [attachments],
  );
  const prefilledAttachmentNames = useMemo(
    () => prefilledAttachmentPaths.map((attachmentPath) => getBaseName(attachmentPath)),
    [prefilledAttachmentPaths],
  );
  const predefinedPromptGroups = useMemo(() => {
    const groupedPrompts = new Map<string, PredefinedPrompt[]>();
    for (const prompt of predefinedPrompts) {
      const existingGroup = groupedPrompts.get(prompt.group) ?? [];
      existingGroup.push(prompt);
      groupedPrompts.set(prompt.group, existingGroup);
    }
    return Array.from(groupedPrompts.entries()).map(([group, prompts]) => ({
      group,
      prompts,
    }));
  }, [predefinedPrompts]);
  const predefinedPromptById = useMemo(
    () => new Map(predefinedPrompts.map((prompt) => [prompt.id, prompt])),
    [predefinedPrompts],
  );
  const activePredefinedPrompt = useMemo(
    () => predefinedPrompts.find((prompt) => prompt.content === initialMessage) ?? null,
    [predefinedPrompts, initialMessage],
  );
  const hasPredefinedPrompts = mode === 'new' && predefinedPromptGroups.length > 0;

  const handleApplyPredefinedPrompt = useCallback((promptContent: string) => {
    setInitialMessage(promptContent);
    setCursorPosition(promptContent.length);
    setShowSuggestions(false);
  }, []);
  const handleSelectPredefinedPrompt = useCallback((promptId: string) => {
    if (!promptId) return;
    const prompt = predefinedPromptById.get(promptId);
    if (!prompt) return;
    handleApplyPredefinedPrompt(prompt.content);
  }, [handleApplyPredefinedPrompt, predefinedPromptById]);

  const updateSuggestions = (query: string, files: string[], currentAttachments: string[], carriedAttachments: string[]) => {
    const newList = buildRepoMentionSuggestions({
      query,
      repoEntries: files,
      currentAttachments,
      carriedAttachments,
    });
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
      const newRecent = config.recentProjects.filter((project) => project !== repo);
      const newConfig = await updateConfig({ recentProjects: newRecent });
      setConfig(newConfig);
    }
  };

  const handleOpenRepoSettings = async (e: React.MouseEvent, repo: string) => {
    e.stopPropagation();
    await ensureProjectRegistered(repo);

    const settings = config?.projectSettings?.[repo];
    setRepoForSettings(repo);
    setRepoAlias(settings?.alias?.trim() || '');
    setRepoStartupCommand(settings?.startupScript ?? DEFAULT_PROJECT_STARTUP_COMMAND);
    setRepoDevServerCommand(settings?.devServerScript ?? DEFAULT_PROJECT_DEV_SERVER_COMMAND);
    setProjectIconPathForSettings(repoCardIconByRepo[repo] ?? null);
    setRepoSettingsError(null);
    setIsRepoSettingsDialogOpen(true);
  };

  const handleSaveRepoSettings = async () => {
    if (!repoForSettings) return;
    const startupCommandToSave = repoStartupCommand.trim() || DEFAULT_PROJECT_STARTUP_COMMAND;
    const devServerCommandToSave = repoDevServerCommand.trim() || DEFAULT_PROJECT_DEV_SERVER_COMMAND;

    setIsSavingRepoSettings(true);
    setRepoSettingsError(null);
    try {
      const aliasToSave = repoAlias.trim() || null;
      const newConfig = await updateProjectSettings(repoForSettings, {
        startupScript: startupCommandToSave,
        devServerScript: devServerCommandToSave,
        alias: aliasToSave,
      });
      setConfig(newConfig);

      try {
        await fetch('/api/projects', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: repoForSettings, updates: { displayName: aliasToSave } }),
        });
      } catch {
        // Non-critical if project is temporarily unavailable.
      }

      dismissRepoSettingsDialog();
    } catch (err) {
      console.error(err);
      setRepoSettingsError('Failed to save project settings.');
    } finally {
      setIsSavingRepoSettings(false);
    }
  };

  const handleUploadProjectIcon = async (iconPath: string) => {
    if (!repoForSettings || isUploadingProjectIcon) return;
    setRepoSettingsError(null);
    setIsUploadingProjectIcon(true);

    try {
      const response = await fetch('/api/projects/icon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectPath: repoForSettings,
          iconPath,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to upload project icon.');
      }

      const uploadedIconPath = typeof payload?.iconPath === 'string' ? payload.iconPath : null;
      setProjectIconPathForSettings(uploadedIconPath);
      setRepoCardIconByRepo((previous) => ({ ...previous, [repoForSettings]: uploadedIconPath }));
      setBrokenRepoCardIcons((previous) => ({ ...previous, [repoForSettings]: false }));
    } catch (error) {
      console.error(error);
      setRepoSettingsError(error instanceof Error ? error.message : 'Failed to upload project icon.');
    } finally {
      setIsUploadingProjectIcon(false);
    }
  };

  const handleRemoveProjectIcon = async () => {
    if (!repoForSettings || isUploadingProjectIcon) return;
    setRepoSettingsError(null);
    setIsUploadingProjectIcon(true);

    try {
      const response = await fetch('/api/projects/icon', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectPath: repoForSettings }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error || 'Failed to remove project icon.');
      }

      setProjectIconPathForSettings(null);
      setRepoCardIconByRepo((previous) => ({ ...previous, [repoForSettings]: null }));
      setBrokenRepoCardIcons((previous) => ({ ...previous, [repoForSettings]: false }));
    } catch (error) {
      console.error(error);
      setRepoSettingsError(error instanceof Error ? error.message : 'Failed to remove project icon.');
    } finally {
      setIsUploadingProjectIcon(false);
    }
  };
  const fetchAgentStatus = useCallback(async (
    provider: AgentProvider,
    options?: { silent?: boolean },
  ): Promise<AgentStatusResponse | null> => {
    if (!options?.silent) {
      setIsLoadingAgentStatus(true);
    }

    try {
      const response = await fetch(`/api/agent/status?provider=${encodeURIComponent(provider)}`, {
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => null) as AgentStatusResponse | null;
      if (!payload) {
        throw new Error('Failed to load agent runtime status.');
      }

      const supportedProviders = payload.providers.filter((entry) => (
        entry.available
        && (entry.id === 'codex' || entry.id === 'gemini' || entry.id === 'cursor')
      ));

      setAgentProviders(supportedProviders);
      if (provider === selectedAgentProvider) {
        setAgentStatus(payload.status);
        if (payload.error) {
          setAgentSetupMessage(payload.error);
        }
      }

      return payload;
    } catch (statusError) {
      const message = statusError instanceof Error ? statusError.message : 'Failed to load agent runtime status.';
      if (provider === selectedAgentProvider) {
        setAgentStatus(null);
        setAgentSetupMessage(message);
      }
      return null;
    } finally {
      if (!options?.silent) {
        setIsLoadingAgentStatus(false);
      }
    }
  }, [selectedAgentProvider]);

  const handleInstallAgentProvider = useCallback(async (provider: AgentProvider) => {
    setIsInstallingAgentProvider(true);
    setInstallingAgentProvider(provider);
    setInstallLogs([]);
    setAgentSetupMessage(null);
    setError(null);

    try {
      const response = await fetch('/api/agent/install', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider }),
      });

      if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(payload?.error || 'Failed to start provider installation.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffered += decoder.decode(value, { stream: true });
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;

          const event = JSON.parse(line) as
            | { type: 'install_started'; command: string }
            | { type: 'install_log'; stream: 'stdout' | 'stderr'; text: string }
            | { type: 'install_completed'; status: AppStatus }
            | { type: 'error'; message: string };

          if (event.type === 'install_started') {
            setInstallLogs((previous) => [...previous, `$ ${event.command}`].slice(-200));
            continue;
          }

          if (event.type === 'install_log') {
            const trimmedText = event.text.trimEnd();
            if (trimmedText) {
              setInstallLogs((previous) => [...previous, trimmedText].slice(-200));
            }
            continue;
          }

          if (event.type === 'install_completed') {
            if (provider === selectedAgentProvider) {
              setAgentStatus(event.status);
            }
            setAgentSetupMessage(`${agentProviderLabel(provider, agentProviders)} installed.`);
            continue;
          }

          if (event.type === 'error') {
            throw new Error(event.message);
          }
        }
      }

      await fetchAgentStatus(provider, { silent: true });
    } catch (installError) {
      const message = installError instanceof Error ? installError.message : 'Failed to install provider.';
      setAgentSetupMessage(message);
      setError(message);
    } finally {
      setIsInstallingAgentProvider(false);
      setInstallingAgentProvider(null);
    }
  }, [agentProviders, fetchAgentStatus, selectedAgentProvider]);

  const handleAgentLogin = useCallback(async (provider: AgentProvider) => {
    setAgentSetupMessage(null);
    setError(null);

    try {
      const response = await fetch('/api/agent/login/start', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider }),
      });
      const payload = await response.json().catch(() => null) as (AgentLoginResponse & { error?: string }) | null;
      if (!response.ok || !payload) {
        throw new Error(payload?.error || 'Failed to start provider login.');
      }

      const providerLabel = agentProviderLabel(provider, agentProviders);
      if (payload.kind === 'browser') {
        window.open(payload.authUrl, '_blank', 'noopener,noreferrer');
        setAgentSetupMessage(payload.message || `Finish the ${providerLabel} login in the browser, then return here.`);
      } else {
        setAgentSetupMessage(payload.message || `Finish the ${providerLabel} login flow, then return here.`);
      }

      setIsWaitingForLogin(true);
      setWaitingForLoginProvider(provider);
    } catch (loginError) {
      const message = loginError instanceof Error ? loginError.message : 'Failed to start provider login.';
      setAgentSetupMessage(message);
      setError(message);
    }
  }, [agentProviders]);

  const saveAgentRuntimeSettings = useCallback(async (
    projectPath: string,
    updates: {
      agentProvider: AgentProvider;
      agentModel?: string;
      agentReasoningEffort?: ReasoningEffort;
    },
  ): Promise<Config> => {
    const response = await fetch('/api/projects/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        projectPath,
        updates,
      }),
    });
    const payload = await response.json().catch(() => null) as { config?: Config; error?: string } | null;

    if (!response.ok || !payload?.config) {
      throw new Error(payload?.error || 'Failed to persist agent runtime settings.');
    }

    return payload.config;
  }, []);

  const ensureSelectedProviderReady = useCallback(async (): Promise<{ ready: boolean; status: AppStatus | null }> => {
    const payload = await fetchAgentStatus(selectedAgentProvider);
    const status = payload?.status ?? null;
    if (!status) {
      setError(agentSetupMessage || 'Failed to load agent runtime status.');
      return { ready: false, status: null };
    }

    if (!status.installed) {
      setError(`Install ${agentProviderLabel(selectedAgentProvider, agentProviders)} before creating a task.`);
      return { ready: false, status };
    }

    if (!status.loggedIn) {
      setError(`Log in to ${agentProviderLabel(selectedAgentProvider, agentProviders)} before creating a task.`);
      return { ready: false, status };
    }

    return { ready: true, status };
  }, [agentProviders, agentSetupMessage, fetchAgentStatus, selectedAgentProvider]);

  useEffect(() => {
    if (mode !== 'new') return;
    void fetchAgentStatus(selectedAgentProvider);
  }, [fetchAgentStatus, mode, selectedAgentProvider]);

  useEffect(() => {
    if (!agentStatus || agentStatus.provider !== selectedAgentProvider) {
      return;
    }

    const validModels = agentStatus.models;
    const nextModel = validModels.find((model) => model.id === selectedAgentModel)?.id
      || agentStatus.defaultModel
      || validModels[0]?.id
      || '';

    if (nextModel !== selectedAgentModel) {
      setSelectedAgentModel(nextModel);
    }
  }, [agentStatus, selectedAgentModel, selectedAgentProvider]);

  const selectedModelOption = useMemo<ModelOption | null>(() => {
    return agentStatus?.models.find((model) => model.id === selectedAgentModel) || null;
  }, [agentStatus, selectedAgentModel]);

  const reasoningEffortOptions = useMemo(() => {
    if (selectedAgentProvider !== 'codex') return [];
    return selectedModelOption?.reasoningEfforts || [];
  }, [selectedAgentProvider, selectedModelOption]);

  useEffect(() => {
    if (selectedAgentProvider !== 'codex') {
      if (selectedReasoningEffort) {
        setSelectedReasoningEffort('');
      }
      return;
    }

    const nextReasoning = reasoningEffortOptions.find((effort) => effort === selectedReasoningEffort)
      || reasoningEffortOptions[0]
      || '';

    if (nextReasoning !== selectedReasoningEffort) {
      setSelectedReasoningEffort(nextReasoning);
    }
  }, [reasoningEffortOptions, selectedAgentProvider, selectedReasoningEffort]);

  useEffect(() => {
    if (mode !== 'new' || !selectedRepo || !config) return;

    const currentSettings = config.projectSettings[selectedRepo] || {};
    const nextReasoning = selectedAgentProvider === 'codex'
      ? normalizeProviderReasoningSelection(selectedAgentProvider, selectedReasoningEffort)
      : undefined;

    if (
      normalizeAgentProvider(currentSettings.agentProvider) === selectedAgentProvider
      && (currentSettings.agentModel || '') === selectedAgentModel
      && (currentSettings.agentReasoningEffort || '') === (nextReasoning || '')
    ) {
      return;
    }

    const requestId = agentRuntimeSettingsRequestRef.current + 1;
    agentRuntimeSettingsRequestRef.current = requestId;

    void saveAgentRuntimeSettings(selectedRepo, {
      agentProvider: selectedAgentProvider,
      agentModel: selectedAgentModel || undefined,
      agentReasoningEffort: nextReasoning,
    }).then((nextConfig) => {
      if (agentRuntimeSettingsRequestRef.current === requestId) {
        setConfig(nextConfig);
      }
    }).catch((settingsError) => {
      console.error('Failed to persist agent runtime settings:', settingsError);
    });
  }, [config, mode, saveAgentRuntimeSettings, selectedAgentModel, selectedAgentProvider, selectedReasoningEffort, selectedRepo]);

  useEffect(() => {
    if (!isWaitingForLogin || !waitingForLoginProvider) {
      return;
    }

    let cancelled = false;
    let timer: number | null = null;

    const pollStatus = async () => {
      const payload = await fetchAgentStatus(waitingForLoginProvider, { silent: true });
      if (cancelled) return;

      if (payload?.status?.loggedIn) {
        setIsWaitingForLogin(false);
        setWaitingForLoginProvider(null);
        setAgentSetupMessage(`${agentProviderLabel(waitingForLoginProvider, agentProviders)} is ready.`);
        return;
      }

      timer = window.setTimeout(() => {
        void pollStatus();
      }, 2000);
    };

    timer = window.setTimeout(() => {
      void pollStatus();
    }, 2000);

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, [agentProviders, fetchAgentStatus, isWaitingForLogin, waitingForLoginProvider]);

  const startSession = async () => {
    if (!selectedRepo) return;
    setLoading(true);
    setError(null);

    try {
      const readiness = await ensureSelectedProviderReady();
      if (!readiness.ready || !readiness.status) {
        setLoading(false);
        return;
      }

      const resolvedDevServerScript = devServerScript.trim();
      const resolvedProvider = normalizeAgentProvider(selectedAgentProvider);
      const resolvedModel = selectedAgentModel.trim()
        || readiness.status.defaultModel
        || readiness.status.models[0]?.id
        || '';
      const resolvedReasoningEffort = resolvedProvider === 'codex'
        ? normalizeProviderReasoningSelection(resolvedProvider, selectedReasoningEffort)
        : undefined;

      // Also save startup script if changed
      await saveStartupScript();
      await saveDevServerScriptValue(resolvedDevServerScript);
      const nextConfig = await updateProjectSettings(selectedRepo, {
        agentProvider: resolvedProvider,
        agentModel: resolvedModel || undefined,
        agentReasoningEffort: resolvedReasoningEffort,
      });
      setConfig(nextConfig);

      // 2. Create session workspace (single/multi/folder mode decided by server runtime discovery).
      const derivedTitle = deriveSessionTitleFromTaskDescription(initialMessage);
      const gitContexts = projectGitRepos.map((repoPath) => ({
        repoPath,
        baseBranch: baseBranchByRepo[repoPath]?.trim() || undefined,
      }));

      const wtResult = await createSession(selectedRepo, gitContexts, {
        agent: resolvedProvider,
        agentProvider: resolvedProvider,
        model: resolvedModel,
        reasoningEffort: resolvedReasoningEffort,
        title: derivedTitle,
        devServerScript: resolvedDevServerScript || undefined
      });

      if (wtResult.success && wtResult.sessionName && wtResult.workspacePath) {
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
        const hasTaskDescription = hasStartupTaskDescription(trimmedInitialMessage);
        let processedMessage = trimmedInitialMessage;

        if (hasTaskDescription) {
          // Helper to match replacement
          processedMessage = processedMessage.replace(/@(\S+)/g, (match, name) => {
            const attachmentPath = attachmentPathByName.get(name);
            if (attachmentPath) {
              return attachmentPath;
            }
            // Assume repo file - keep relative path as we run in worktree root
            return name;
          });
        }

        const launchInitialMessage = hasTaskDescription ? processedMessage : '';

        // 3. Persist launch context for the new session
        const launchContextResult = await saveSessionLaunchContext(wtResult.sessionName, {
          title: derivedTitle,
          initialMessage: launchInitialMessage || undefined,
          rawInitialMessage: hasTaskDescription ? trimmedInitialMessage : undefined,
          startupScript: startupScript || undefined,
          attachmentPaths: allAttachmentPaths,
          attachmentNames: allAttachmentNames,
          agentProvider: resolvedProvider,
          model: resolvedModel,
          reasoningEffort: resolvedReasoningEffort,
          sessionMode,
        });

        if (!launchContextResult.success) {
          setError(launchContextResult.error || 'Failed to save session context');
          setLoading(false);
          return;
        }

        const initialAgentPrompt = buildAgentStartupPrompt({
          taskDescription: launchInitialMessage || undefined,
          attachmentPaths: allAttachmentPaths,
          sessionMode,
          workspaceMode: wtResult.workspaceMode || 'folder',
          gitRepos: wtResult.gitRepos,
          discoveredRepoRelativePaths: projectGitRepos.map((repoPath) => toProjectRelativeRepoPath(selectedRepo, repoPath)),
        });

        if (initialAgentPrompt) {
          const messageResponse = await fetch('/api/agent/message', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              sessionId: wtResult.sessionName,
              message: initialAgentPrompt,
              displayMessage: initialAgentPrompt,
              markInitialized: true,
            }),
          });
          const messagePayload = await messageResponse.json().catch(() => null) as { error?: string } | null;
          if (!messageResponse.ok) {
            setError(messagePayload?.error || 'Failed to queue initial agent turn');
            notifySessionsChanged();
            setLoading(false);
            return;
          }
        }

        // 4. Navigate to session page by path only
        notifySessionsChanged();
        navigateToSession(wtResult.sessionName, { fresh: true });
        return;

        // No need to refresh sessions as we are navigating away
      } else {
        setError(wtResult.error || "Failed to create session workspace");
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
      const resolvedProvider = normalizeAgentProvider(selectedAgentProvider);
      const resolvedModel = selectedAgentModel.trim()
        || agentStatus?.defaultModel
        || agentStatus?.models[0]?.id
        || '';
      const draftGitContexts = projectGitRepos.map((repoPath) => {
        const fallbackBranch = branchesByRepo[repoPath]?.find((branch) => branch.current)?.name
          || branchesByRepo[repoPath]?.[0]?.name
          || '';
        const baseBranch = baseBranchByRepo[repoPath]?.trim() || fallbackBranch;
        return {
          sourceRepoPath: repoPath,
          relativeRepoPath: '',
          worktreePath: '',
          branchName: baseBranch,
          baseBranch: baseBranch || undefined,
        };
      }).filter((context) => context.branchName.trim().length > 0);
      const firstGitContext = draftGitContexts[0];
      const draft: DraftMetadata = {
        id: draftId,
        projectPath: selectedRepo,
        gitContexts: draftGitContexts,
        repoPath: selectedRepo,
        branchName: firstGitContext?.branchName || currentBranchName || undefined,
        message: initialMessage,
        attachmentPaths: [...attachments, ...prefilledAttachmentPaths],
        agentProvider: resolvedProvider,
        model: resolvedModel,
        reasoningEffort: resolvedProvider === 'codex'
          ? normalizeProviderReasoningSelection(resolvedProvider, selectedReasoningEffort)
          : undefined,
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
    if (draft.gitContexts.length > 0) {
      const nextBaseBranchByRepo: Record<string, string> = {};
      draft.gitContexts.forEach((context) => {
        const resolvedBaseBranch = context.baseBranch?.trim() || context.branchName.trim();
        if (resolvedBaseBranch) {
          nextBaseBranchByRepo[context.sourceRepoPath] = resolvedBaseBranch;
        }
      });
      setProjectGitRepos(draft.gitContexts.map((context) => context.sourceRepoPath));
      setBaseBranchByRepo((previous) => ({ ...previous, ...nextBaseBranchByRepo }));
      const firstContext = draft.gitContexts[0];
      setCurrentBranchName(nextBaseBranchByRepo[firstContext.sourceRepoPath] || firstContext.branchName || '');
    } else {
      setCurrentBranchName(draft.branchName || '');
    }
    setStartupScript(draft.startupScript || '');
    setDevServerScript(draft.devServerScript || '');
    setSessionMode(draft.sessionMode || 'fast');
    const resolvedProvider = normalizeAgentProvider(draft.agentProvider);
    setSelectedAgentProvider(resolvedProvider);
    setSelectedAgentModel(draft.model || '');
    setSelectedReasoningEffort(
      normalizeProviderReasoningEffort(resolvedProvider, draft.reasoningEffort) || '',
    );

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
      // Session runtime is server-managed; reopening the page only reconnects the UI.
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
    const nextUrl = `/new?project=${encodeURIComponent(selectedRepo)}&prefillFromSession=${encodeURIComponent(session.sessionName)}`;
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

      setExistingSessions((previous) => previous.filter((item) => item.sessionName !== session.sessionName));
      setAllSessions((previous) => previous.filter((item) => item.sessionName !== session.sessionName));
    } catch (e) {
      console.error(e);
      setError('Failed to delete session');
    } finally {
      setDeletingSessionName(null);
    }
  };

  const runningSessionCountByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const session of allSessions) {
      const projectKey = session.projectPath || session.repoPath;
      if (!projectKey) continue;
      counts.set(projectKey, (counts.get(projectKey) ?? 0) + 1);
    }
    return counts;
  }, [allSessions]);

  const draftCountByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const draft of allDrafts) {
      const projectKey = draft.projectPath || draft.repoPath;
      if (!projectKey) continue;
      counts.set(projectKey, (counts.get(projectKey) ?? 0) + 1);
    }
    return counts;
  }, [allDrafts]);

  const recentProjects = useMemo(() => config?.recentProjects ?? [], [config?.recentProjects]);

  const getProjectDisplayName = useCallback((projectPath: string): string => {
    const alias = config?.projectSettings?.[projectPath]?.alias?.trim();
    return alias || getBaseName(projectPath);
  }, [config?.projectSettings]);

  const filteredRecentProjects = useMemo(() => {
    const normalizedQuery = homeSearchQuery.trim().toLowerCase();
    if (!normalizedQuery) return recentProjects;

    return recentProjects.filter((projectPath) => {
      const displayName = getProjectDisplayName(projectPath).toLowerCase();
      return displayName.includes(normalizedQuery) || projectPath.toLowerCase().includes(normalizedQuery);
    });
  }, [homeSearchQuery, recentProjects, getProjectDisplayName]);

  const selectableProjects = selectedRepo
    ? (recentProjects.includes(selectedRepo) ? recentProjects : [selectedRepo, ...recentProjects])
    : recentProjects;

  const discoverHomeProjectRepos = useCallback(async (
    projectPath: string,
    options: { force?: boolean } = {},
  ): Promise<string[]> => {
    const cached = projectGitReposByPath[projectPath];
    if (cached && !options.force) {
      return cached;
    }

    setDiscoveringHomeProjectGitRepos((previous) => ({ ...previous, [projectPath]: true }));
    try {
      const discovery = await discoverProjectGitRepos(projectPath);
      const repos = discovery.repos.map((entry) => entry.repoPath);
      setProjectGitReposByPath((previous) => ({ ...previous, [projectPath]: repos }));
      return repos;
    } catch (discoverError) {
      console.error('Failed to discover project git repos:', discoverError);
      setProjectGitReposByPath((previous) => ({ ...previous, [projectPath]: [] }));
      return [];
    } finally {
      setDiscoveringHomeProjectGitRepos((previous) => ({ ...previous, [projectPath]: false }));
    }
  }, [projectGitReposByPath]);

  const handleOpenProjectGitWorkspace = useCallback(async (projectPath: string, sourceRepoPath?: string) => {
    if (sourceRepoPath?.trim()) {
      router.push(`/git?path=${encodeURIComponent(sourceRepoPath)}`);
      return;
    }

    const repos = await discoverHomeProjectRepos(projectPath);
    if (repos.length === 0) {
      setError('No Git repositories were found in this project.');
      return;
    }
    if (repos.length === 1) {
      router.push(`/git?path=${encodeURIComponent(repos[0])}`);
      return;
    }
    setHomeProjectGitSelector({ projectPath, repos });
  }, [discoverHomeProjectRepos, router]);

  useEffect(() => {
    if (mode !== 'home' || recentProjects.length === 0) return;
    const runtimeWindow = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const projectsToDiscover = recentProjects.filter((projectPath) => !(projectPath in projectGitReposByPath));
    if (projectsToDiscover.length === 0) return;

    let cancelled = false;
    let fallbackTimer: number | null = null;
    let idleHandle: number | null = null;
    const queuedProjects = projectsToDiscover.slice(0, HOME_REPO_DISCOVERY_MAX_AUTOSTART);

    const clearScheduledWork = () => {
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      if (idleHandle !== null && typeof runtimeWindow.cancelIdleCallback === 'function') {
        runtimeWindow.cancelIdleCallback(idleHandle);
        idleHandle = null;
      }
    };

    const scheduleNext = (index: number) => {
      if (cancelled || index >= queuedProjects.length) return;

      const run = () => {
        if (cancelled) return;
        void discoverHomeProjectRepos(queuedProjects[index]).finally(() => {
          scheduleNext(index + 1);
        });
      };

      if (typeof runtimeWindow.requestIdleCallback === 'function') {
        idleHandle = runtimeWindow.requestIdleCallback(() => {
          idleHandle = null;
          run();
        }, { timeout: HOME_REPO_DISCOVERY_IDLE_TIMEOUT_MS });
        return;
      }

      fallbackTimer = window.setTimeout(() => {
        fallbackTimer = null;
        run();
      }, HOME_REPO_DISCOVERY_IDLE_TIMEOUT_MS);
    };

    scheduleNext(0);

    return () => {
      cancelled = true;
      clearScheduledWork();
    };
  }, [discoverHomeProjectRepos, mode, projectGitReposByPath, recentProjects]);

  useEffect(() => {
    if (mode !== 'home') return;

    const inFlightResolutions = repoCardIconResolutionsInFlightRef.current;
    const reposToResolve = recentProjects.filter((repo) => (
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
          console.error('Failed to resolve project icon:', error);
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
  }, [mode, recentProjects, repoCardIconByRepo]);

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
          filteredRecentProjects={filteredRecentProjects}
          isDarkThemeActive={isDarkThemeActive}
          runningSessionCountByProject={runningSessionCountByProject}
          draftCountByProject={draftCountByProject}
          projectCardIconByPath={repoCardIconByRepo}
          brokenProjectCardIcons={brokenRepoCardIcons}
          getProjectDisplayName={getProjectDisplayName}
          projectGitReposByPath={projectGitReposByPath}
          discoveringProjectGitRepos={discoveringHomeProjectGitRepos}
          onHomeSearchQueryChange={setHomeSearchQuery}
          onOpenCredentials={() => router.push('/credentials')}
          onCycleThemeMode={handleCycleThemeMode}
          onSelectProject={handleSelectRepo}
          onOpenGitWorkspace={handleOpenProjectGitWorkspace}
          onOpenProjectSettings={handleOpenRepoSettings}
          onRemoveRecent={handleRemoveRecent}
          onProjectIconError={handleRepoIconError}
          onRepoCardMouseMove={handleRepoCardMouseMove}
          onRepoCardMouseLeave={handleRepoCardMouseLeave}
          onAddProject={openCloneRemoteDialog}
        />
      )}

      {mode === 'home' && (
        <RepoSettingsDialog
          key={`${repoForSettings ?? 'none'}:${isRepoSettingsDialogOpen ? 'open' : 'closed'}`}
          isOpen={isRepoSettingsDialogOpen}
          projectForSettings={repoForSettings}
          projectAlias={repoAlias}
          projectStartupCommand={repoStartupCommand}
          projectDevServerCommand={repoDevServerCommand}
          defaultProjectStartupCommand={DEFAULT_PROJECT_STARTUP_COMMAND}
          defaultProjectDevServerCommand={DEFAULT_PROJECT_DEV_SERVER_COMMAND}
          projectIconPath={projectIconPathForSettings}
          isSavingProjectSettings={isSavingRepoSettings}
          isUploadingProjectIcon={isUploadingProjectIcon}
          projectSettingsError={repoSettingsError}
          onAliasChange={setRepoAlias}
          onStartupCommandChange={setRepoStartupCommand}
          onDevServerCommandChange={setRepoDevServerCommand}
          onUploadIcon={(iconPath) => {
            void handleUploadProjectIcon(iconPath);
          }}
          onRemoveIcon={() => {
            void handleRemoveProjectIcon();
          }}
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
          onBrowseLocalFolder={() => {
            dismissCloneRemoteDialog();
            setIsBrowsing(true);
          }}
          onSetDefaultFolder={() => {
            dismissCloneRemoteDialog();
            setIsSelectingRoot(true);
          }}
          onCloneProject={() => {
            void handleCloneRemoteRepo();
          }}
        />
      )}

      {mode === 'home' && homeProjectGitSelector && (
        <div className="fixed inset-0 z-[1003] flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-sm">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#151b26]">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4 dark:border-white/10">
              <h3 className="text-lg font-bold text-slate-900 dark:text-white">Select Git Repository</h3>
              <button
                className="btn btn-circle btn-ghost btn-sm"
                onClick={() => setHomeProjectGitSelector(null)}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-3 p-5">
              <p className="break-all font-mono text-xs text-slate-600 dark:text-slate-300">
                {homeProjectGitSelector.projectPath}
              </p>
              <div className="max-h-80 space-y-2 overflow-y-auto">
                {homeProjectGitSelector.repos.map((repoPath) => (
                  <button
                    key={repoPath}
                    type="button"
                    className="w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-50 dark:border-[#30363d] dark:text-slate-200 dark:hover:bg-[#30363d]/60"
                    onClick={() => {
                      setHomeProjectGitSelector(null);
                      router.push(`/git?path=${encodeURIComponent(repoPath)}`);
                    }}
                    title={repoPath}
                  >
                    <span className="block truncate font-mono text-xs">{repoPath}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
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

          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
            <div className="self-start space-y-6 lg:col-span-4">
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-[#30363d] dark:bg-[#161b22] dark:shadow-[0_16px_36px_-24px_rgba(2,6,23,0.95)]">
                <h3 className="mb-5 flex items-center gap-2 text-lg font-bold text-slate-900 dark:text-white">
                  <FolderGit2 className="h-5 w-5 text-primary" />
                  Context Setup
                </h3>

                <div className="space-y-4">
                  <label className="flex flex-col gap-2">
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Select Project</span>
                    <div className="relative">
                      <select
                        className="h-12 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-10 font-mono text-sm text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-100"
                        value={selectedRepo}
                        onChange={(event) => {
                          void handleCurrentRepoChange(event);
                        }}
                        disabled={loading || selectableProjects.length === 0}
                      >
                        {selectableProjects.map((projectPath) => (
                          <option key={projectPath} value={projectPath}>
                            {getProjectDisplayName(projectPath)}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 dark:text-slate-500" />
                    </div>
                    <span className="truncate font-mono text-[11px] text-slate-500 dark:text-slate-400" title={selectedRepo || ''}>
                      {selectedRepo}
                    </span>
                  </label>

                  <div className="flex flex-col gap-2">
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300">Git Repositories</span>
                    {isLoadingProjectGitRepos ? (
                      <div className="flex h-12 items-center rounded-lg border border-slate-200 bg-slate-50 px-3 text-sm text-slate-500 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-400">
                        <span className="loading loading-spinner loading-xs mr-2"></span>
                        Discovering repositories...
                      </div>
                    ) : projectGitRepos.length === 0 ? (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-400/40 dark:bg-amber-900/30 dark:text-amber-200">
                        No Git repositories found. This session will run in folder mode.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {projectGitRepos.map((repoPath) => {
                          const repoBranches = branchesByRepo[repoPath] ?? [];
                          const selectedBaseBranch = baseBranchByRepo[repoPath] || '';
                          const displayRepoPath = getRepoDisplayPath(repoPath, projectGitRepos.length);
                          return (
                            <div key={repoPath} className="rounded-lg border border-slate-200 bg-slate-50 p-2 dark:border-[#30363d] dark:bg-[#0d1117]/70">
                              <div className="truncate font-mono text-[11px] text-slate-600 dark:text-slate-300" title={repoPath}>
                                {displayRepoPath}
                              </div>
                              <div className="relative mt-2">
                                <select
                                  className="h-10 w-full appearance-none rounded-md border border-slate-300 bg-white px-2 pr-8 font-mono text-xs text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-100"
                                  value={selectedBaseBranch}
                                  onChange={(event) => handleBranchChange(repoPath, event.target.value)}
                                  disabled={loading || repoBranches.length === 0}
                                >
                                  {repoBranches.length === 0 ? (
                                    <option value="">No local branches</option>
                                  ) : repoBranches.map((branch) => (
                                    <option key={branch.name} value={branch.name}>
                                      {branch.name}
                                      {branch.current ? ' (checked out)' : ''}
                                    </option>
                                  ))}
                                </select>
                                <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500 dark:text-slate-500" />
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                    {isProjectGitReposTruncated && (
                      <div className="text-[11px] text-amber-700 dark:text-amber-300">
                        Repository discovery was truncated due to scan limits.
                      </div>
                    )}
                  </div>

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
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Agent Runtime</span>
                        <div className="relative">
                          <select
                            className="h-10 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-10 text-sm text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-100"
                            value={selectedAgentProvider}
                            onChange={handleAgentProviderChange}
                            disabled={loading}
                          >
                            {(agentProviders.length > 0 ? agentProviders : SUPPORTED_AGENT_PROVIDERS.map((providerId) => ({
                              id: providerId,
                              label: agentProviderLabel(providerId),
                              description: '',
                              available: true,
                            }))).map((provider) => (
                              <option key={provider.id} value={provider.id}>
                                {provider.label}
                              </option>
                            ))}
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 dark:text-slate-500" />
                        </div>
                      </label>

                      <div className="space-y-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-[#30363d] dark:bg-[#111827]">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="space-y-1">
                            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                              {agentProviderLabel(selectedAgentProvider, agentProviders)}
                            </div>
                            <div className="text-xs text-slate-500 dark:text-slate-400">
                              {isLoadingAgentStatus
                                ? 'Checking runtime status...'
                                : agentStatus
                                  ? [
                                      agentStatus.installed ? 'Installed' : 'Not installed',
                                      agentStatus.loggedIn ? 'Logged in' : 'Login required',
                                      agentStatus.version ? `v${agentStatus.version}` : null,
                                    ].filter(Boolean).join(' • ')
                                  : 'Runtime status unavailable'}
                            </div>
                            {agentStatus?.account?.email ? (
                              <div className="text-xs text-slate-500 dark:text-slate-400">
                                {agentStatus.account.email}
                                {agentStatus.account.planType ? ` • ${agentStatus.account.planType}` : ''}
                              </div>
                            ) : null}
                          </div>
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-200 dark:hover:bg-[#161b22]"
                              onClick={() => void fetchAgentStatus(selectedAgentProvider)}
                              disabled={loading || isLoadingAgentStatus}
                            >
                              Refresh
                            </button>
                            {!agentStatus?.installed && (
                              <button
                                type="button"
                                className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
                                onClick={() => void handleInstallAgentProvider(selectedAgentProvider)}
                                disabled={loading || isInstallingAgentProvider}
                              >
                                {isInstallingAgentProvider && installingAgentProvider === selectedAgentProvider
                                  ? 'Installing...'
                                  : 'Install'}
                              </button>
                            )}
                            {agentStatus?.installed && !agentStatus.loggedIn && (
                              <button
                                type="button"
                                className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-60"
                                onClick={() => void handleAgentLogin(selectedAgentProvider)}
                                disabled={loading || isWaitingForLogin}
                              >
                                {isWaitingForLogin && waitingForLoginProvider === selectedAgentProvider
                                  ? 'Waiting for login...'
                                  : 'Log In'}
                              </button>
                            )}
                          </div>
                        </div>

                        {agentSetupMessage && (
                          <div className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:border-blue-400/30 dark:bg-blue-950/40 dark:text-blue-200">
                            {agentSetupMessage}
                          </div>
                        )}

                        {installLogs.length > 0 && isInstallingAgentProvider && installingAgentProvider === selectedAgentProvider && (
                          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-950 px-3 py-2 font-mono text-[11px] text-slate-100">
                            {installLogs.join('\n')}
                          </pre>
                        )}
                      </div>

                      <label className="flex flex-col gap-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Model</span>
                        <div className="relative">
                          <select
                            className="h-10 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-10 text-sm text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-100"
                            value={selectedAgentModel}
                            onChange={handleAgentModelChange}
                            disabled={loading || isLoadingAgentStatus || (agentStatus?.models.length || 0) === 0}
                          >
                            {(agentStatus?.models.length ? agentStatus.models : [{
                              id: selectedAgentModel || '',
                              label: selectedAgentModel || 'Default model',
                              description: '',
                            }]).map((model) => (
                              <option key={model.id || 'default-model'} value={model.id}>
                                {model.label}
                              </option>
                            ))}
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 dark:text-slate-500" />
                        </div>
                        {selectedModelOption?.description && (
                          <span className="text-[11px] text-slate-500 dark:text-slate-400">
                            {selectedModelOption.description}
                          </span>
                        )}
                      </label>

                      {selectedAgentProvider === 'codex' && reasoningEffortOptions.length > 0 && (
                        <label className="flex flex-col gap-2">
                          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Reasoning Effort</span>
                          <div className="relative">
                            <select
                              className="h-10 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-10 text-sm text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-100"
                              value={selectedReasoningEffort}
                              onChange={handleReasoningEffortChange}
                              disabled={loading}
                            >
                              {reasoningEffortOptions.map((effort) => (
                                <option key={effort} value={effort}>
                                  {effort}
                                </option>
                              ))}
                            </select>
                            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 dark:text-slate-500" />
                          </div>
                        </label>
                      )}

                      <label className="flex flex-col gap-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Start Up Command</span>
                        <textarea
                          className="min-h-[86px] rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-100"
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
                        <textarea
                          className="min-h-[86px] rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-100"
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
                        <div className="relative">
                          <select
                            className="h-10 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-10 text-sm text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-100"
                            value={sessionMode}
                            onChange={handleSessionModeChange}
                            disabled={loading}
                          >
                            <option value="fast">Fast Mode (default)</option>
                            <option value="plan">Plan Mode</option>
                          </select>
                          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 dark:text-slate-500" />
                        </div>
                      </label>

                    </div>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-[#30363d] dark:bg-[#161b22] dark:shadow-[0_16px_36px_-24px_rgba(2,6,23,0.95)]">
                <h3 className="mb-4 text-lg font-bold text-slate-900 dark:text-white">Ongoing Tasks</h3>
                <div className="space-y-2">
                  {existingSessions.length === 0 && (
                    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-sm text-slate-500 dark:border-[#30363d] dark:bg-[#0d1117]/45 dark:text-slate-400">
                      No ongoing sessions for this project.
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
                          {getProjectDisplayName(session.projectPath || session.repoPath || '')}
                          {' • '}
                          {agentProviderLabel(session.agentProvider || session.agent, agentProviders)}
                          {session.model ? ` • ${session.model}` : ''}
                          {session.runState ? ` • ${session.runState}` : ''}
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

              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-[#30363d] dark:bg-[#161b22] dark:shadow-[0_16px_36px_-24px_rgba(2,6,23,0.95)]">
                <h3 className="mb-4 text-lg font-bold text-slate-900 dark:text-white">Drafts</h3>
                <div className="space-y-2">
                  {existingDrafts.length === 0 && (
                    <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 px-3 py-4 text-sm text-slate-500 dark:border-[#30363d] dark:bg-[#0d1117]/45 dark:text-slate-400">
                      No drafts for this project.
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
                          {getProjectDisplayName(draft.projectPath || draft.repoPath || '')}
                          {' • '}
                          {agentProviderLabel(draft.agentProvider, agentProviders)}
                          {draft.model ? ` • ${draft.model}` : ''}
                          {draft.reasoningEffort ? ` • ${draft.reasoningEffort}` : ''}
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
            </div>

            <div className="self-start lg:col-span-8">
              <div className="flex h-full flex-col rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-[#30363d] dark:bg-[#161b22] dark:shadow-[0_16px_36px_-24px_rgba(2,6,23,0.95)]">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <label className="flex items-center gap-2 text-lg font-bold text-slate-900 dark:text-white" htmlFor="task-description">
                    <Bot className="h-5 w-5 text-primary" />
                    Task Description
                  </label>
                  {hasPredefinedPrompts && (
                    <div className="ml-auto w-full sm:w-[340px]">
                      <div className="relative">
                        <select
                          className="h-12 w-full appearance-none rounded-lg border border-slate-300 bg-white px-3 pr-10 font-mono text-sm text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-100"
                          value={activePredefinedPrompt?.id ?? ''}
                          onChange={(event) => handleSelectPredefinedPrompt(event.target.value)}
                          disabled={loading}
                          aria-label="Select predefined prompt"
                        >
                          <option value="">Select Prompt</option>
                          {predefinedPromptGroups.map(({ group, prompts }) => (
                            <optgroup key={group} label={group}>
                              {prompts.map((prompt) => (
                                <option key={prompt.id} value={prompt.id}>
                                  {prompt.label}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500 dark:text-slate-500" />
                      </div>
                    </div>
                  )}
                </div>

                <div className="group relative mb-4 flex h-[360px] flex-grow flex-col md:h-[420px]">
                  <textarea
                    id="task-description"
                    className="h-full w-full resize-none rounded-xl border border-slate-200 bg-slate-50 p-5 font-mono text-sm leading-relaxed text-slate-900 outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/30 dark:border-[#30363d] dark:bg-[#0d1117] dark:text-slate-100 dark:placeholder:text-slate-500"
                    placeholder={`Describe the task for the AI agent...\nExample:\n1. Create a new component for the user profile card.\n2. Ensure it fetches data from the /api/user endpoint.\n3. Add error handling for failed requests.\n\nTip: Type @ to mention files or folders.`}
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
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Loading project...</h2>
            <p className="text-sm text-slate-500 dark:text-slate-400">Preparing your task workspace.</p>
          </div>
        </div>
      )}

      {mode === 'new' && isInstallingAgentProvider && installingAgentProvider && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-base-content/45 px-4">
          <div className="w-full max-w-3xl rounded-xl border border-base-300 bg-base-100 p-6 shadow-2xl">
            <div className="flex items-start gap-4">
              <span className="loading loading-spinner loading-lg text-primary"></span>
              <div className="min-w-0 flex-1 space-y-4">
                <div className="space-y-1">
                  <h3 className="text-lg font-semibold">
                    Installing {agentProviderLabel(installingAgentProvider, agentProviders)}
                  </h3>
                  <p className="text-sm opacity-70">
                    The runtime is being installed in the background. You can close this dialog after it completes.
                  </p>
                </div>
                <pre className="max-h-[360px] overflow-y-auto whitespace-pre-wrap rounded-lg bg-slate-950 px-4 py-3 font-mono text-[11px] text-slate-100">
                  {installLogs.join('\n') || 'Waiting for install output...'}
                </pre>
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
              Project Selector
            </h2>
            {isResolvingRepoFromName ? (
              <div className="alert text-sm py-2 px-3 mt-2 flex items-center gap-2">
                <span className="loading loading-spinner loading-sm"></span>
                {fromRepoName
                  ? `Searching for project "${fromRepoName}"...`
                  : 'Searching for project...'}
              </div>
            ) : error ? (
              <div className="alert alert-error text-sm py-2 px-3 mt-2">{error}</div>
            ) : (
              <div className="text-sm opacity-70 mt-2">No project specified.</div>
            )}
            <div className="mt-4">
              <button className="btn btn-primary btn-sm" onClick={() => router.push('/')}>
                Choose Project
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
          onSelect={(path) => handleSelectRepo(path, { navigateToNewInHome: false })}
          onCancel={() => setIsBrowsing(false)}
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
