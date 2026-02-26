'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { FolderGit2, GitBranch as GitBranchIcon, Plus, X, ChevronRight, FolderCog, Bot, Cpu, Trash2, Play, KeyRound, Settings, ExternalLink } from 'lucide-react';
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
  saveAttachments,
  checkAgentCliInstalled,
  installAgentCli,
  SupportedAgentCli,
} from '@/app/actions/git';
import { resolveRepositoryByName } from '@/app/actions/repository';
import { copySessionAttachments, createSession, deleteSession, getSessionPrefillContext, listSessions, saveSessionLaunchContext, SessionMetadata } from '@/app/actions/session';
import { getConfig, updateConfig, updateRepoSettings, Config } from '@/app/actions/config';
import { listCredentials } from '@/app/actions/credentials';
import type { Credential } from '@/lib/credentials';
import { useRouter } from 'next/navigation';
import { getBaseName } from '@/lib/path';
import { notifySessionsUpdated, SESSIONS_UPDATED_EVENT, SESSIONS_UPDATED_STORAGE_KEY } from '@/lib/session-updates';
import Image from 'next/image';
import { useDialogKeyboardShortcuts } from '@/hooks/useDialogKeyboardShortcuts';

import agentProvidersDataRaw from '@/data/agent-providers.json';

type Model = {
  id: string;
  label: string;
  description?: string;
};

type AgentProvider = {
  name: string;
  cli: string;
  description?: string;
  models: Model[];
};

type SessionMode = 'fast' | 'plan';
type RepoCredentialSelection = 'auto' | string;

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

const agentProvidersData = agentProvidersDataRaw as unknown as AgentProvider[];
const SESSION_MODE_STORAGE_KEY = 'viba:new-session-mode';
const AGENT_LOGIN_COMMANDS: Record<SupportedAgentCli, string> = {
  gemini: 'gemini',
  codex: 'codex',
  agent: 'agent',
};
const AGENT_CLI_LABELS: Record<SupportedAgentCli, string> = {
  gemini: 'Gemini CLI',
  codex: 'Codex CLI',
  agent: 'Cursor Agent CLI',
};

type TerminalWindow = Window & {
  term?: {
    paste: (text: string) => void;
  };
};

type GitRepoSelectorProps = {
  mode?: 'home' | 'new';
  repoPath?: string | null;
  fromRepoName?: string | null;
  prefillFromSession?: string | null;
};

export default function GitRepoSelector({
  mode = 'home',
  repoPath = null,
  fromRepoName = null,
  prefillFromSession = null,
}: GitRepoSelectorProps) {
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [isSelectingRoot, setIsSelectingRoot] = useState(false);
  const [isRepoSettingsDialogOpen, setIsRepoSettingsDialogOpen] = useState(false);

  const [config, setConfig] = useState<Config | null>(null);

  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [repoForSettings, setRepoForSettings] = useState<string | null>(null);
  const [repoCredentialSelection, setRepoCredentialSelection] = useState<RepoCredentialSelection>('auto');
  const [credentialOptions, setCredentialOptions] = useState<Credential[]>([]);

  const router = useRouter();

  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [currentBranchName, setCurrentBranchName] = useState<string>('');
  const [existingSessions, setExistingSessions] = useState<SessionMetadata[]>([]);
  const [allSessions, setAllSessions] = useState<SessionMetadata[]>([]);

  const [selectedProvider, setSelectedProvider] = useState<AgentProvider | null>(null);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [startupScript, setStartupScript] = useState<string>('');
  const [devServerScript, setDevServerScript] = useState<string>('');
  const [showSessionAdvanced, setShowSessionAdvanced] = useState(false);
  const [initialMessage, setInitialMessage] = useState<string>('');
  const [title, setTitle] = useState<string>('');
  const [sessionMode, setSessionMode] = useState<SessionMode>('fast');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [prefilledAttachmentNames, setPrefilledAttachmentNames] = useState<string[]>([]);
  const [prefillSourceSessionName, setPrefillSourceSessionName] = useState<string | null>(null);
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
  const [loginCommandInjected, setLoginCommandInjected] = useState(false);
  const [loginModalError, setLoginModalError] = useState<string | null>(null);
  const [repoSettingsError, setRepoSettingsError] = useState<string | null>(null);
  const [isLoadingCredentialOptions, setIsLoadingCredentialOptions] = useState(false);
  const [isSavingRepoSettings, setIsSavingRepoSettings] = useState(false);
  const loginTerminalRef = useRef<HTMLIFrameElement>(null);

  const collapsedSessionSetupLabel = selectedProvider && selectedModel
    ? `Show Session Setup (${selectedProvider.name} / ${selectedModel})`
    : 'Show Session Setup';

  const notifySessionsChanged = useCallback(() => {
    notifySessionsUpdated();
  }, []);

  const refreshSessionData = useCallback(async (repo: string | null = selectedRepo) => {
    try {
      const [allSess, repoSess] = await Promise.all([
        listSessions(),
        repo ? listSessions(repo) : Promise.resolve([] as SessionMetadata[]),
      ]);
      setAllSessions(allSess);
      if (repo) {
        setExistingSessions(repoSess);
      }
    } catch (e) {
      console.error('Failed to refresh sessions', e);
    }
  }, [selectedRepo]);

  const toSupportedAgentCli = useCallback((value: string | null | undefined): SupportedAgentCli | null => {
    if (value === 'gemini' || value === 'codex' || value === 'agent') return value;
    return null;
  }, []);

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
    setRepoSettingsError(null);
    setIsLoadingCredentialOptions(false);
  }, [isSavingRepoSettings]);

  // Load config and all sessions on mount
  useEffect(() => {
    const loadData = async () => {
      try {
        const [cfg, sessions, credentialsResult] = await Promise.all([
          getConfig(),
          listSessions(),
          listCredentials(),
        ]);
        setConfig(cfg);
        setAllSessions(sessions);
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

    const handleStorage = (event: StorageEvent) => {
      if (event.key === SESSIONS_UPDATED_STORAGE_KEY) {
        refresh();
      }
    };

    const handleFocus = () => {
      refresh();
    };

    const handleSessionsUpdated = () => {
      refresh();
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener('focus', handleFocus);
    window.addEventListener(SESSIONS_UPDATED_EVENT, handleSessionsUpdated);

    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener(SESSIONS_UPDATED_EVENT, handleSessionsUpdated);
    };
  }, [mode, refreshSessionData, selectedRepo]);

  const loadSelectedRepoData = async (path: string) => {
    setSelectedRepo(path);
    setRepoFilesCache([]);

    // Load saved provider/model
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

  const handleCurrentRepoChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (mode !== 'new') return;

    const nextRepo = e.target.value;
    if (!nextRepo || nextRepo === selectedRepo) return;

    const changed = await handleSelectRepo(nextRepo);
    if (!changed) return;

    const params = new URLSearchParams();
    params.set('repo', nextRepo);
    if (prefillFromSession) {
      params.set('prefillFromSession', prefillFromSession);
    }

    router.replace(`/new?${params.toString()}`);
  };

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
      router.replace(`/new?${params.toString()}`);
    };

    void resolveFromRepoName();

    return () => {
      isCancelled = true;
    };
  }, [fromRepoName, mode, prefillFromSession, repoPath, router]);

  useEffect(() => {
    setHasAppliedPrefill(false);
    setPrefilledAttachmentNames([]);
    setPrefillSourceSessionName(null);
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

      const provider = agentProvidersData.find(p => p.cli === context.agentProvider);
      if (provider) {
        setSelectedProvider(provider);
        if (context.model && (context.model === 'auto' || provider.models.some(m => m.id === context.model))) {
          setSelectedModel(context.model);
        } else {
          setSelectedModel('auto');
        }
      }

      setTitle(context.title || '');
      setInitialMessage(context.initialMessage || '');
      setPrefilledAttachmentNames(context.attachmentNames || []);
      setPrefillSourceSessionName(context.sourceSessionName);
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

    const savedProviderCli = settings.agentProvider;
    const savedModel = settings.agentModel;
    const savedStartupScript = settings.startupScript;
    const savedDevServerScript = settings.devServerScript;

    if (savedProviderCli) {
      const provider = agentProvidersData.find(p => p.cli === savedProviderCli);
      if (provider) {
        setSelectedProvider(provider);
        if (savedModel && (savedModel === 'auto' || provider.models.some(m => m.id === savedModel))) {
          setSelectedModel(savedModel);
        } else {
          setSelectedModel('auto');
        }
      } else {
        // Default if saved one is invalid
        setSelectedProvider(agentProvidersData[0]);
        setSelectedModel('auto');
      }
    } else {
      // Default
      setSelectedProvider(agentProvidersData[0]);
      setSelectedModel('auto');
    }

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

  const handleProviderChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const cli = e.target.value;
    const provider = agentProvidersData.find(p => p.cli === cli);
    if (provider && selectedRepo) {
      setSelectedProvider(provider);
      // Default to auto
      const defaultModel = 'auto';
      setSelectedModel(defaultModel);

      const newConfig = await updateRepoSettings(selectedRepo, {
        agentProvider: provider.cli,
        agentModel: defaultModel
      });
      setConfig(newConfig);
    }
  };

  const handleModelChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const model = e.target.value;
    setSelectedModel(model);
    if (selectedRepo) {
      const newConfig = await updateRepoSettings(selectedRepo, { agentModel: model });
      setConfig(newConfig);
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

  const normalizeAttachmentFile = useCallback((file: File, index: number): File => {
    if (file.name && file.name.trim().length > 0) {
      return file;
    }

    const extension = file.type
      ? file.type.split('/')[1]?.split('+')[0] || 'bin'
      : 'bin';
    const generatedName = `pasted-file-${Date.now()}-${index + 1}.${extension}`;

    return new File([file], generatedName, {
      type: file.type,
      lastModified: file.lastModified || Date.now(),
    });
  }, []);

  const appendAttachments = useCallback((incomingFiles: File[]) => {
    if (incomingFiles.length === 0) return;

    setAttachments(prev => {
      const byName = new Map(prev.map(file => [file.name, file]));
      incomingFiles.forEach(file => {
        byName.set(file.name, file);
      });
      return Array.from(byName.values());
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

  const updateSuggestions = (query: string, files: string[], currentAttachments: File[], carriedAttachments: string[]) => {
    const lowerQ = query.toLowerCase();

    const attachmentNames = [...currentAttachments.map(f => f.name), ...carriedAttachments];
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
          updateSuggestions(query, files, attachments, prefilledAttachmentNames);
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

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;

    const selectedFiles = Array.from(e.target.files).map((file, index) => normalizeAttachmentFile(file, index));
    appendAttachments(selectedFiles);
    e.target.value = '';
  };

  useEffect(() => {
    if (mode !== 'new' || !selectedRepo) return;

    const handlePaste = (event: ClipboardEvent) => {
      const clipboardData = event.clipboardData;
      if (!clipboardData) return;

      const fromItems = Array.from(clipboardData.items)
        .filter(item => item.kind === 'file')
        .map(item => item.getAsFile())
        .filter((file): file is File => file !== null);

      const pastedFiles = (fromItems.length > 0 ? fromItems : Array.from(clipboardData.files))
        .map((file, index) => normalizeAttachmentFile(file, index));

      if (pastedFiles.length === 0) return;

      event.preventDefault();
      appendAttachments(pastedFiles);
    };

    window.addEventListener('paste', handlePaste);
    return () => {
      window.removeEventListener('paste', handlePaste);
    };
  }, [appendAttachments, mode, normalizeAttachmentFile, selectedRepo]);

  const removeAttachment = (idx: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  const removePrefilledAttachment = (idx: number) => {
    setPrefilledAttachmentNames(prev => prev.filter((_, i) => i !== idx));
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

    setRepoForSettings(repo);
    setRepoCredentialSelection(resolveRepoCredentialSelection(repo));
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

    if (credentialId && !credentialOptions.some((credential) => credential.id === credentialId)) {
      setRepoSettingsError('Selected credential no longer exists. Please choose another credential.');
      return;
    }

    setIsSavingRepoSettings(true);
    setRepoSettingsError(null);
    try {
      const newConfig = await updateRepoSettings(repoForSettings, {
        credentialId,
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
  }, [isLoginModalOpen, loginCommand]);

  const ensureAgentCliReady = useCallback(async (): Promise<boolean> => {
    const agentCli = toSupportedAgentCli(selectedProvider?.cli);
    if (!agentCli) return true;

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

    setLoginAgentCli(agentCli);
    setLoginCommand(AGENT_LOGIN_COMMANDS[agentCli]);
    setLoginCommandInjected(false);
    setLoginModalError(null);
    setIsLoginModalOpen(true);
    return false;
  }, [selectedProvider?.cli, toSupportedAgentCli]);

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

      const wtResult = await createSession(selectedRepo, baseBranch, {
        agent: selectedProvider?.cli || 'agent',
        model: selectedModel || '',
        title: title,
        devServerScript: resolvedDevServerScript || undefined
      });

      if (wtResult.success && wtResult.sessionName && wtResult.worktreePath && wtResult.branchName) {
        let uploadedAttachmentNames: string[] = [];
        let carriedAttachmentNames: string[] = [];

        // Upload newly selected attachments.
        if (attachments.length > 0) {
          const formData = new FormData();
          attachments.forEach(file => formData.append(file.name, file)); // Use filename as key or just 'files'
          // Backend iterates entries [name, file].
          uploadedAttachmentNames = await saveAttachments(wtResult.worktreePath, formData);
        }

        // Copy carried attachments from the source session.
        if (prefillSourceSessionName && prefilledAttachmentNames.length > 0) {
          const copiedResult = await copySessionAttachments(
            prefillSourceSessionName,
            wtResult.worktreePath,
            prefilledAttachmentNames
          );

          if (!copiedResult.success) {
            setError(copiedResult.error || 'Failed to carry over attachments from source session');
            setLoading(false);
            return;
          }

          carriedAttachmentNames = copiedResult.copiedAttachmentNames;
        }

        const allAttachmentNames = Array.from(new Set([
          ...uploadedAttachmentNames,
          ...carriedAttachmentNames,
        ]));

        // Process initial message mentions
        const trimmedInitialMessage = initialMessage.trim();
        let processedMessage = trimmedInitialMessage;

        // Helper to match replacement
        processedMessage = processedMessage.replace(/@(\S+)/g, (match, name) => {
          if (allAttachmentNames.includes(name)) {
            return `${wtResult.worktreePath}-attachments/${name}`;
          }
          // Assume repo file - keep relative path as we run in worktree root
          return name;
        });

        // 3. Persist launch context for the new session
        const launchContextResult = await saveSessionLaunchContext(wtResult.sessionName, {
          title: title || undefined,
          initialMessage: processedMessage || undefined,
          rawInitialMessage: trimmedInitialMessage || undefined,
          startupScript: startupScript || undefined,
          attachmentNames: allAttachmentNames,
          agentProvider: selectedProvider?.cli || 'agent',
          model: selectedModel || '',
          sessionMode,
        });

        if (!launchContextResult.success) {
          setError(launchContextResult.error || 'Failed to save session context');
          setLoading(false);
          return;
        }

        // 4. Navigate to session page by path only
        const dest = `/session/${wtResult.sessionName}`;
        notifySessionsChanged();
        router.push(dest);
        setLoading(false);

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
      const dest = `/session/${session.sessionName}`;
      router.push(dest);
      setLoading(false);

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

  const recentRepos = config?.recentRepos ?? [];
  const selectableRepos = selectedRepo
    ? (recentRepos.includes(selectedRepo) ? recentRepos : [selectedRepo, ...recentRepos])
    : recentRepos;

  return (
    <>
      {mode === 'home' && (
        <div className="card w-full max-w-2xl bg-base-200 shadow-xl">
          <div className="card-body">
            <h2 className="card-title flex justify-between items-center">
              <div className="flex items-center gap-2">
                <Image src="/icon.png" alt="Viba" width={24} height={24} className="rounded-sm" />
                Viba
              </div>
              <div className="flex items-center gap-2">
                <button
                  className="btn btn-ghost btn-sm gap-2"
                  onClick={() => router.push('/credentials')}
                  title="Manage GitHub/GitLab credentials"
                >
                  <KeyRound className="w-4 h-4" />
                  Credentials
                </button>
                <button
                  className="btn btn-ghost btn-sm gap-2"
                  onClick={() => setIsSelectingRoot(true)}
                  title={config?.defaultRoot ? `Default: ${config.defaultRoot}` : "Set default browsing folder"}
                >
                  <FolderCog className="w-4 h-4" />
                  {config?.defaultRoot ? "Change Default" : "Set Default Root"}
                </button>
                <button className="btn btn-primary btn-sm gap-2" onClick={() => setIsBrowsing(true)}>
                  <Plus className="w-4 h-4" /> Open Local Repo
                </button>
              </div>
            </h2>

            {error && <div className="alert alert-error text-sm py-2 px-3 mt-2">{error}</div>}

            <div className="mt-4 space-y-4">

              <div className="space-y-2">
                <h3 className="text-sm font-semibold opacity-70 uppercase tracking-wide">Recent Repositories</h3>
                {!isLoaded ? (
                  <div className="flex items-center justify-center py-8 bg-base-100 rounded-lg">
                    <span className="loading loading-spinner loading-md"></span>
                  </div>
                ) : (!config || config.recentRepos.length === 0) ? (
                  <div className="text-center py-8 text-base-content/40 italic bg-base-100 rounded-lg">
                    No recent repositories found.
                  </div>
                ) : (
                  <div className="flex flex-col gap-2">
                    {config.recentRepos.map(repo => {
                      const credentialLabel = getRepoCredentialLabel(repo);
                      const runningSessionCount = runningSessionCountByRepo.get(repo) ?? 0;

                      return (
                        <div
                          key={repo}
                          onClick={() => handleSelectRepo(repo)}
                          className="flex items-center justify-between p-3 bg-base-100 hover:bg-base-300 rounded-md cursor-pointer group transition-all border border-base-300"
                        >
                          <div className="flex items-center gap-3 overflow-hidden shrink min-w-0">
                            <FolderGit2 className="w-5 h-5 text-secondary shrink-0" />
                            <div className="flex flex-col overflow-hidden">
                              <span className="font-medium truncate">{getBaseName(repo)}</span>
                              <span className="text-xs opacity-50 truncate">{repo}</span>
                              <span className="text-[10px] opacity-60 mt-0.5">
                                Credential: {credentialLabel}
                              </span>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {runningSessionCount > 0 && (
                              <span
                                className="badge badge-sm badge-secondary"
                                title={`${runningSessionCount} running session${runningSessionCount === 1 ? '' : 's'}`}
                              >
                                {runningSessionCount}
                              </span>
                            )}
                            <button
                              onClick={(e) => {
                                void handleOpenRepoSettings(e, repo);
                              }}
                              className="btn btn-circle btn-ghost btn-xs opacity-0 group-hover:opacity-100"
                              title="Repository settings"
                            >
                              <Settings className="w-3 h-3" />
                            </button>
                            <button
                              onClick={(e) => handleRemoveRecent(e, repo)}
                              className="btn btn-circle btn-ghost btn-xs opacity-0 group-hover:opacity-100 text-error"
                              title="Remove from history"
                            >
                              <X className="w-3 h-3" />
                            </button>
                            <ChevronRight className="w-4 h-4 opacity-30" />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {mode === 'home' && isRepoSettingsDialogOpen && repoForSettings && (
        <div className="fixed inset-0 z-[1002] flex items-center justify-center bg-base-content/60 p-4">
          <div className="w-full max-w-xl rounded-xl border border-base-300 bg-base-100 shadow-2xl">
            <div className="space-y-4 p-5 md:p-6">
              <h3 className="text-xl font-semibold">Repository Settings</h3>
              <p className="text-sm opacity-75">
                Choose which credential this repository should use for authenticated Git operations.
              </p>

              <div className="space-y-2">
                <label className="text-xs uppercase tracking-wide opacity-70">Repository</label>
                <div className="rounded-md border border-base-300 bg-base-200 px-3 py-2 font-mono text-xs break-all">
                  {repoForSettings}
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-xs uppercase tracking-wide opacity-70">Credential</label>
                <select
                  className="select select-bordered w-full"
                  value={repoCredentialSelection}
                  onChange={(event) => setRepoCredentialSelection(event.target.value)}
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
                  <div className="text-xs opacity-60">
                    No credentials found. Add credentials from the Credentials page.
                  </div>
                )}
              </div>

              {isLoadingCredentialOptions && (
                <div className="text-sm opacity-70 flex items-center gap-2">
                  <span className="loading loading-spinner loading-xs"></span>
                  Loading credentials...
                </div>
              )}

              {repoSettingsError && (
                <div className="alert alert-error text-sm py-2">
                  {repoSettingsError}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  className="btn btn-ghost"
                  onClick={dismissRepoSettingsDialog}
                  disabled={isSavingRepoSettings}
                >
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => void handleSaveRepoSettings()}
                  disabled={isSavingRepoSettings || isLoadingCredentialOptions}
                >
                  {isSavingRepoSettings ? <span className="loading loading-spinner loading-xs"></span> : null}
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {mode === 'new' && selectedRepo && (
        <div className="w-full max-w-6xl space-y-4">
          {error && <div className="alert alert-error text-sm py-2 px-3">{error}</div>}
          <div className="flex flex-col gap-4 w-full">
            <div className="card w-full bg-base-200 shadow-xl">
              <div className="card-body">
                <h2 className="card-title flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <FolderGit2 className="w-6 h-6 text-primary" />
                    Git Repository Selector
                  </div>
                  <button className="btn btn-sm btn-ghost" onClick={() => router.push('/')}>
                    Change Repo
                  </button>
                </h2>

                <div className="mt-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="bg-base-100 p-4 rounded-lg border border-base-300 space-y-2">
                      <label className="text-xs opacity-50 uppercase tracking-widest">Current Repository</label>
                      <div className="join w-full">
                        <div className="join-item bg-base-300 flex items-center px-3 border border-base-content/20 border-r-0">
                          <FolderGit2 className="w-4 h-4 text-primary" />
                        </div>
                        <select
                          className="select select-bordered join-item w-full font-mono focus:outline-none"
                          value={selectedRepo}
                          onChange={(e) => {
                            void handleCurrentRepoChange(e);
                          }}
                          disabled={loading || selectableRepos.length === 0}
                        >
                          {selectableRepos.map(repo => (
                            <option key={repo} value={repo}>
                              {getBaseName(repo)}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="text-[10px] opacity-50 font-mono truncate px-1" title={selectedRepo}>
                        {selectedRepo}
                      </div>
                    </div>

                    {/* Branch Selection */}
                    <div className="bg-base-100 p-4 rounded-lg border border-base-300 space-y-2">
                      <div className="flex justify-between items-center">
                        <label className="text-sm font-medium opacity-70 uppercase tracking-widest">Current Branch</label>
                        {loading && <span className="loading loading-spinner loading-xs"></span>}
                      </div>

                      <div className="join w-full">
                        <div className="join-item bg-base-300 flex items-center px-3 border border-base-content/20 border-r-0">
                          <GitBranchIcon className="w-4 h-4" />
                        </div>
                        <select
                          className="select select-bordered join-item w-full font-mono focus:outline-none"
                          value={currentBranchName}
                          onChange={handleBranchChange}
                          disabled={loading}
                        >
                          {branches.map(branch => (
                            <option key={branch.name} value={branch.name}>
                              {branch.name} {branch.current ? '(checked out)' : ''}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="text-[10px] opacity-50 px-1 italic">
                        Switching branches updates the working directory.
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Continue Existing Session Card */}
            {existingSessions.length > 0 && (
              <div className="card w-full bg-base-200 shadow-xl">
                <div className="card-body">
                  <h2 className="card-title flex items-center gap-2">
                    <Play className="w-6 h-6 text-success" />
                    Continue Existing Session
                  </h2>
                  <div className="flex flex-col gap-2 mt-4 max-h-64 overflow-y-auto">
                    {existingSessions.map((session) => (
                      <div key={session.sessionName} className="flex flex-col gap-2 p-3 bg-base-100 rounded-md border border-base-300">
                        <div className="flex justify-between items-start">
                          <div>
                            {session.title && <div className="font-semibold">{session.title}</div>}
                            <div className="text-xs opacity-60 font-mono">{session.sessionName}</div>
                            <div className="text-xs opacity-60 mt-1">
                              Agent: {session.agent} • Model: {session.model}
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              className="btn btn-sm btn-success btn-outline gap-2"
                              onClick={() => handleResumeSession(session)}
                              disabled={loading || deletingSessionName === session.sessionName}
                            >
                              <ExternalLink className="w-3 h-3" /> Open
                            </button>
                            <button
                              className="btn btn-sm btn-secondary btn-outline gap-2"
                              onClick={() => handleNewAttemptFromSession(session)}
                              disabled={loading || deletingSessionName === session.sessionName}
                              title="Start a new attempt prefilled from this session"
                            >
                              <Plus className="w-3 h-3" /> New Attempt
                            </button>
                            <button
                              className="btn btn-sm btn-error btn-outline gap-2"
                              onClick={() => handleDeleteSession(session)}
                              disabled={loading || deletingSessionName === session.sessionName}
                            >
                              <Trash2 className="w-3 h-3" />
                              {deletingSessionName === session.sessionName ? 'Deleting...' : 'Delete'}
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Start New Session Card */}
            <div className="card w-full bg-base-200 shadow-xl">
              <div className="card-body">
                <h2 className="card-title flex items-center gap-2">
                  <Bot className="w-6 h-6 text-secondary" />
                  Start New Session
                </h2>

                <div className="mt-4 space-y-6">
                  <div className="space-y-3">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm px-2 h-auto min-h-0 normal-case justify-start gap-2"
                      onClick={() => setShowSessionAdvanced(prev => !prev)}
                    >
                      <ChevronRight className={`w-4 h-4 transition-transform ${showSessionAdvanced ? 'rotate-90' : ''}`} />
                      {showSessionAdvanced ? 'Hide Session Setup' : collapsedSessionSetupLabel}
                    </button>

                    {showSessionAdvanced && (
                      <>
                        {/* Agent Selection */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div className="space-y-2">
                            <label className="text-sm font-medium opacity-70">Agent Provider</label>
                            <div className="join w-full">
                              <div className="join-item bg-base-300 flex items-center px-3 border border-base-content/20 border-r-0">
                                <Bot className="w-4 h-4" />
                              </div>
                              <select
                                className="select select-bordered join-item w-full focus:outline-none"
                                value={selectedProvider?.cli || ''}
                                onChange={handleProviderChange}
                                disabled={loading}
                              >
                                {agentProvidersData.map(provider => (
                                  <option key={provider.cli} value={provider.cli}>
                                    {provider.name}
                                  </option>
                                ))}
                              </select>
                            </div>
                            {selectedProvider?.description && (
                              <p className="text-[10px] opacity-60 mt-1 pl-1 italic leading-tight">
                                {selectedProvider.description}
                              </p>
                            )}
                          </div>

                          <div className="space-y-2">
                            <label className="text-sm font-medium opacity-70">Model</label>
                            <div className="join w-full">
                              <div className="join-item bg-base-300 flex items-center px-3 border border-base-content/20 border-r-0">
                                <Cpu className="w-4 h-4" />
                              </div>
                              <select
                                className="select select-bordered join-item w-full focus:outline-none"
                                value={selectedModel}
                                onChange={handleModelChange}
                                disabled={loading || !selectedProvider}
                              >
                                <option value="auto">Auto</option>
                                {selectedProvider?.models.map(model => (
                                  <option key={model.id} value={model.id}>
                                    {model.label}
                                  </option>
                                ))}
                              </select>
                            </div>
                            {selectedProvider?.models.find(m => m.id === selectedModel)?.description && (
                              <p className="text-[10px] opacity-60 mt-1 pl-1 italic leading-tight">
                                {selectedProvider.models.find(m => m.id === selectedModel)?.description}
                              </p>
                            )}
                          </div>
                        </div>

                        <div className="space-y-2">
                          <label className="text-sm font-medium opacity-70">Start up script (Optional)</label>
                          <input
                            type="text"
                            className="input input-bordered w-full font-mono text-sm"
                            placeholder="npm i"
                            value={startupScript}
                            onChange={handleStartupScriptChange}
                            onBlur={saveStartupScript}
                            onKeyDown={(e) => {
                              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                                e.preventDefault();
                                handleStartSession();
                              }
                            }}
                            disabled={loading}
                          />
                          <div className="text-xs opacity-50 px-1">
                            Script to run in the terminal agent iframe upon startup.
                          </div>
                        </div>

                        <div className="space-y-2">
                          <label className="text-sm font-medium opacity-70">Dev server script (Optional)</label>
                          <input
                            type="text"
                            className="input input-bordered w-full font-mono text-sm"
                            placeholder="npm run dev"
                            value={devServerScript}
                            onChange={handleDevServerScriptChange}
                            onBlur={saveDevServerScript}
                            onKeyDown={(e) => {
                              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                                e.preventDefault();
                                handleStartSession();
                              }
                            }}
                            disabled={loading}
                          />
                          <div className="text-xs opacity-50 px-1">
                            Script for the Session View Start Dev Server button in the right terminal.
                          </div>
                        </div>
                      </>
                    )}
                  </div>

                  <div className="divider"></div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium opacity-70">Session Mode</label>
                    <select
                      className="select select-bordered w-full focus:outline-none"
                      value={sessionMode}
                      onChange={handleSessionModeChange}
                      disabled={loading}
                    >
                      <option value="fast">Fast Mode (default)</option>
                      <option value="plan">Plan Mode</option>
                    </select>
                    <div className="text-xs opacity-50 px-1">
                      {sessionMode === 'plan'
                        ? 'Plan mode asks the agent to study the repo, propose a plan, and wait for your approval before implementation.'
                        : 'Fast mode starts the agent with current behavior.'}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium opacity-70">Title (Optional)</label>
                    <input
                      type="text"
                      className="input input-bordered w-full font-mono text-sm"
                      placeholder="Task Title"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                          e.preventDefault();
                          handleStartSession();
                        }
                      }}
                      disabled={loading}
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium opacity-70">Initial Message (Optional)</label>
                    <div className="relative">
                      <textarea
                        className="textarea textarea-bordered w-full h-64 font-mono text-sm leading-tight resize-none"
                        placeholder="Describe what you want the agent to do... Type @ to mention files."
                        value={initialMessage}
                        onChange={handleMessageChange}
                        onKeyDown={handleKeyDown}
                        onClick={(e) => {
                          setCursorPosition(e.currentTarget.selectionStart);
                          setShowSuggestions(false); // Hide on click? Or re-val?
                        }}
                        onKeyUp={(e) => setCursorPosition(e.currentTarget.selectionStart)}
                        disabled={loading}
                      ></textarea>
                      {showSuggestions && suggestionList.length > 0 && (
                        <div className="absolute left-0 right-0 z-50 mt-1 max-h-48 overflow-y-auto bg-base-100 border border-base-300 rounded-md shadow-lg">
                          {suggestionList.map((s, idx) => (
                            <button
                              key={s}
                              className={`w-full text-left px-3 py-2 text-xs border-b border-base-200 last:border-0 truncate ${idx === selectedIndex ? 'bg-primary text-primary-content' : 'hover:bg-primary/10'
                                }`}
                              onMouseDown={(e) => {
                                e.preventDefault(); // Prevent blur
                                handleSelectSuggestion(s);
                              }}
                            >
                              {s}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium opacity-70">Attachments (Optional)</label>
                    <input
                      type="file"
                      multiple
                      className="file-input file-input-bordered w-full"
                      onChange={handleFileSelect}
                      disabled={loading}
                    />
                    <div className="text-xs opacity-50 px-1">
                      Paste files from clipboard with Cmd/Ctrl+V anywhere on this page.
                    </div>
                    {attachments.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        {attachments.map((file, idx) => (
                          <span key={`upload-${idx}`} className="badge badge-neutral gap-2 p-3">
                            {file.name}
                            <button onClick={() => removeAttachment(idx)} className="btn btn-ghost btn-xs btn-circle text-error">
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                    {prefilledAttachmentNames.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        {prefilledAttachmentNames.map((name, idx) => (
                          <span key={`prefill-${name}-${idx}`} className="badge badge-secondary gap-2 p-3">
                            {name}
                            <button
                              onClick={() => removePrefilledAttachment(idx)}
                              className="btn btn-ghost btn-xs btn-circle text-error"
                              title="Remove carried attachment"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="card-actions justify-end mt-4">
                    <button
                      className="btn btn-primary btn-wide shadow-lg"
                      onClick={handleStartSession}
                      disabled={loading}
                    >
                      {loading ? <span className="loading loading-spinner"></span> : "Start Session"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {mode === 'new' && !selectedRepo && (
        <div className="card w-full max-w-2xl bg-base-200 shadow-xl">
          <div className="card-body">
            {error && <div className="alert alert-error text-sm py-2 px-3">{error}</div>}
            <h2 className="card-title">Select a Repository</h2>
            <p className="opacity-70 text-sm">Choose a repository first, then start or resume a session.</p>
            <div className="card-actions justify-end mt-4">
              <button className="btn btn-primary" onClick={() => router.push('/')}>
                Go to Home
              </button>
            </div>
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
