export type TerminalSessionRole = string;
export type GitRemoteProvider = 'github' | 'gitlab';
export type TerminalPersistenceMode = 'tmux' | 'shell';
export type TerminalShellKind = 'posix' | 'powershell';
export type TerminalSessionEnvironment = {
  name: string;
  value: string;
};
export type ResolvedGitTerminalSessionEnvironment = {
  sourceRepoPath: string;
  environment: TerminalSessionEnvironment;
  credentialId: string;
  explicit: boolean;
};
export type BuildTtydTerminalSrcOptions = {
  workingDirectory?: string | null;
  persistenceMode?: TerminalPersistenceMode;
  shellKind?: TerminalShellKind;
};
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SHELL_ENV_PARAM = 'viba-env';
const SHELL_CWD_PARAM = 'viba-cwd';

type DetectGitRemoteProviderOptions = {
  gitlabHosts?: string[];
};

function sanitizeTmuxSessionName(value: string): string {
  const safe = value.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
  return safe || 'session';
}

export function getTmuxSessionName(sessionName: string, role: TerminalSessionRole): string {
  return `viba-${sanitizeTmuxSessionName(sessionName).slice(0, 40)}-${role}`;
}

function normalizeGitRemoteUrl(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return '';

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const scpLikeMatch = trimmed.match(/^([^@]+@)?([^:]+):(.+)$/);
  if (!scpLikeMatch) {
    return '';
  }

  const userPart = scpLikeMatch[1] || '';
  const host = scpLikeMatch[2];
  const path = scpLikeMatch[3].replace(/^\/+/, '');
  return `ssh://${userPart}${host}/${path}`;
}

export function parseGitRemoteHost(remoteUrl: string): string | null {
  const normalized = normalizeGitRemoteUrl(remoteUrl);
  if (!normalized) return null;

  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeKnownHost(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    // Fall through to parse as a bare host (optionally with port).
  }

  try {
    return new URL(`ssh://${trimmed}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function detectGitRemoteProvider(
  remoteUrl: string,
  options?: DetectGitRemoteProviderOptions,
): GitRemoteProvider | null {
  const host = parseGitRemoteHost(remoteUrl);
  if (!host) return null;

  if (host === 'github.com' || host.includes('github')) {
    return 'github';
  }

  if (host === 'gitlab.com' || host.includes('gitlab')) {
    return 'gitlab';
  }

  if (options?.gitlabHosts?.some((knownHost) => normalizeKnownHost(knownHost) === host)) {
    return 'gitlab';
  }

  return null;
}

export function buildTtydTerminalSrc(
  sessionName: string,
  role: TerminalSessionRole,
  environment?: TerminalSessionEnvironment | TerminalSessionEnvironment[] | null,
  options?: BuildTtydTerminalSrcOptions,
): string {
  const environments = Array.isArray(environment)
    ? environment
    : environment
      ? [environment]
      : [];
  const persistenceMode = options?.persistenceMode ?? 'tmux';
  const params = new URLSearchParams();

  if (persistenceMode === 'tmux') {
    const tmuxSession = getTmuxSessionName(sessionName, role);
    params.append('arg', 'new-session');

    for (const env of environments) {
      if (!env.value) continue;
      params.append('arg', '-e');
      params.append('arg', `${env.name}=${env.value}`);
    }

    const workingDirectory = options?.workingDirectory?.trim();
    if (workingDirectory) {
      params.append('arg', '-c');
      params.append('arg', workingDirectory);
    }
    params.append('arg', '-A');
    params.append('arg', '-s');
    params.append('arg', tmuxSession);
    return `/terminal?${params.toString()}`;
  }

  for (const env of environments) {
    if (!env.value) continue;
    params.append(SHELL_ENV_PARAM, `${env.name}=${env.value}`);
  }

  const workingDirectory = options?.workingDirectory?.trim();
  if (workingDirectory) {
    params.append(SHELL_CWD_PARAM, workingDirectory);
  }

  const query = params.toString();
  return query ? `/terminal?${query}` : '/terminal';
}

export function mergeGitTerminalSessionEnvironments(
  candidates: ResolvedGitTerminalSessionEnvironment[],
  options?: { onConflict?: (message: string) => void },
): TerminalSessionEnvironment[] {
  const merged = new Map<string, ResolvedGitTerminalSessionEnvironment>();
  const conflictedNames = new Set<string>();

  for (const candidate of candidates) {
    const envName = candidate.environment.name;
    if (conflictedNames.has(envName)) continue;

    const existing = merged.get(envName);
    if (!existing) {
      merged.set(envName, candidate);
      continue;
    }

    if (
      existing.credentialId === candidate.credentialId
      || existing.environment.value === candidate.environment.value
    ) {
      continue;
    }

    if (existing.explicit && !candidate.explicit) {
      continue;
    }

    if (!existing.explicit && candidate.explicit) {
      merged.set(envName, candidate);
      continue;
    }

    conflictedNames.add(envName);
    merged.delete(envName);
    options?.onConflict?.(
      `Conflicting ${envName} credentials for repos ${existing.sourceRepoPath} and ${candidate.sourceRepoPath}; omitting ${envName}.`,
    );
  }

  return Array.from(merged.values()).map((entry) => entry.environment);
}

export function parseTerminalSessionEnvironmentsFromSrc(src: string): TerminalSessionEnvironment[] {
  const trimmed = src.trim();
  if (!trimmed) return [];

  const queryIndex = trimmed.indexOf('?');
  const query = queryIndex >= 0 ? trimmed.slice(queryIndex + 1) : trimmed.replace(/^\?/, '');
  const params = new URLSearchParams(query);
  const args = params.getAll('arg');
  const environments = new Map<string, string>();

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '-e') continue;

    const assignment = args[i + 1];
    i += 1;
    if (!assignment) continue;

    const separatorIndex = assignment.indexOf('=');
    if (separatorIndex <= 0) continue;

    const name = assignment.slice(0, separatorIndex).trim();
    if (!ENV_NAME_PATTERN.test(name)) continue;

    const value = assignment.slice(separatorIndex + 1);
    if (!value) continue;

    environments.set(name, value);
  }

  for (const assignment of params.getAll(SHELL_ENV_PARAM)) {
    const separatorIndex = assignment.indexOf('=');
    if (separatorIndex <= 0) continue;

    const name = assignment.slice(0, separatorIndex).trim();
    if (!ENV_NAME_PATTERN.test(name)) continue;

    const value = assignment.slice(separatorIndex + 1);
    if (!value) continue;

    environments.set(name, value);
  }

  return Array.from(environments.entries()).map(([name, value]) => ({ name, value }));
}

export function parseTerminalWorkingDirectoryFromSrc(src: string): string | null {
  const trimmed = src.trim();
  if (!trimmed) return null;

  const queryIndex = trimmed.indexOf('?');
  const query = queryIndex >= 0 ? trimmed.slice(queryIndex + 1) : trimmed.replace(/^\?/, '');
  const params = new URLSearchParams(query);
  const args = params.getAll('arg');

  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '-c') continue;
    const workingDirectory = args[i + 1]?.trim();
    if (workingDirectory) return workingDirectory;
  }

  return params.get(SHELL_CWD_PARAM)?.trim() || null;
}
