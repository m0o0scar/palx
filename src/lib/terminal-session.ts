export type TerminalSessionRole = string;
export type GitRemoteProvider = 'github' | 'gitlab';
export type TerminalSessionEnvironment = {
  name: string;
  value: string;
};
export type BuildTtydTerminalSrcOptions = {
  workingDirectory?: string | null;
};
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  const tmuxSession = getTmuxSessionName(sessionName, role);
  const params = new URLSearchParams();
  params.append('arg', 'new-session');
  const environments = Array.isArray(environment)
    ? environment
    : environment
      ? [environment]
      : [];

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

  return Array.from(environments.entries()).map(([name, value]) => ({ name, value }));
}
