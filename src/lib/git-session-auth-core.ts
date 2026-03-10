import {
  detectGitRemoteProvider,
  mergeGitTerminalSessionEnvironments,
  parseGitRemoteHost,
  type ResolvedGitTerminalSessionEnvironment,
  type TerminalSessionEnvironment,
} from './terminal-session.ts';

export type GitSessionCredential = {
  id: string;
  type: 'github' | 'gitlab';
  serverUrl?: string;
};

export type GitSessionAuthDependencies = {
  getAllCredentials: () => Promise<GitSessionCredential[]>;
  getCredentialById: (id: string) => Promise<GitSessionCredential | null>;
  getCredentialToken: (id: string) => Promise<string | null>;
  getGitRepoCredential: (repoPath: string) => Promise<string | null>;
  getPrimaryRemoteUrl: (repoPath: string) => Promise<string | null>;
};

const DEFAULT_GITLAB_HOST = 'gitlab.com';

function getGitLabCredentialHost(credential: GitSessionCredential): string | null {
  if (credential.type !== 'gitlab' || !credential.serverUrl) return null;

  try {
    return new URL(credential.serverUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function pickCandidateCredential(
  credentials: GitSessionCredential[],
  provider: 'github' | 'gitlab',
  remoteHost: string | null,
): GitSessionCredential | null {
  if (provider === 'github') {
    return credentials.find((credential) => credential.type === 'github') || null;
  }

  if (remoteHost) {
    const hostMatch = credentials.find((credential) => (
      credential.type === 'gitlab'
      && getGitLabCredentialHost(credential) === remoteHost
    ));
    if (hostMatch) return hostMatch;
  }

  return credentials.find((credential) => credential.type === 'gitlab') || null;
}

function toGitSessionEnvironmentCandidates(
  repoPath: string,
  credential: GitSessionCredential,
  token: string,
  explicit: boolean,
): ResolvedGitTerminalSessionEnvironment[] {
  const candidates: ResolvedGitTerminalSessionEnvironment[] = [{
    sourceRepoPath: repoPath,
    environment: credential.type === 'github'
      ? { name: 'GITHUB_TOKEN', value: token }
      : { name: 'GITLAB_TOKEN', value: token },
    credentialId: credential.id,
    explicit,
  }];

  if (credential.type === 'gitlab') {
    const host = getGitLabCredentialHost(credential);
    if (host && host !== DEFAULT_GITLAB_HOST) {
      candidates.push({
        sourceRepoPath: repoPath,
        environment: { name: 'GITLAB_HOST', value: host },
        credentialId: credential.id,
        explicit,
      });
    }
  }

  return candidates;
}

async function resolveGitSessionEnvironmentCandidatesForRepo(
  repoPath: string,
  allCredentials: GitSessionCredential[],
  deps: GitSessionAuthDependencies,
): Promise<ResolvedGitTerminalSessionEnvironment[]> {
  const remoteUrl = await deps.getPrimaryRemoteUrl(repoPath);
  if (!remoteUrl) return [];

  const provider = detectGitRemoteProvider(remoteUrl, {
    gitlabHosts: allCredentials.flatMap((credential) => {
      if (credential.type !== 'gitlab') return [];
      const host = getGitLabCredentialHost(credential);
      return host ? [host] : [];
    }),
  });
  if (!provider) return [];

  const remoteHost = parseGitRemoteHost(remoteUrl);
  const credentialId = await deps.getGitRepoCredential(repoPath);
  if (credentialId) {
    const selectedCredential = await deps.getCredentialById(credentialId);
    if (!selectedCredential) {
      console.warn(`Selected credential ${credentialId} for ${repoPath} was not found.`);
      return [];
    }

    if (provider === 'github' && selectedCredential.type !== 'github') {
      console.warn(`Selected credential ${selectedCredential.id} does not match GitHub remote for ${repoPath}.`);
      return [];
    }

    if (provider === 'gitlab' && selectedCredential.type !== 'gitlab') {
      console.warn(`Selected credential ${selectedCredential.id} does not match GitLab remote for ${repoPath}.`);
      return [];
    }

    if (selectedCredential.type === 'gitlab' && remoteHost) {
      const credentialHost = getGitLabCredentialHost(selectedCredential);
      if (credentialHost && credentialHost !== remoteHost) {
        console.warn(
          `Selected GitLab credential ${selectedCredential.id} targets ${credentialHost}, but ${repoPath} uses ${remoteHost}.`,
        );
        return [];
      }
    }

    const token = await deps.getCredentialToken(selectedCredential.id);
    if (!token) {
      console.warn(`Could not load token for selected credential ${selectedCredential.id} on ${repoPath}.`);
      return [];
    }

    return toGitSessionEnvironmentCandidates(repoPath, selectedCredential, token, true);
  }

  const credential = pickCandidateCredential(allCredentials, provider, remoteHost);
  if (!credential) return [];

  const token = await deps.getCredentialToken(credential.id);
  if (!token) return [];

  return toGitSessionEnvironmentCandidates(repoPath, credential, token, false);
}

export async function resolveGitSessionEnvironmentsWithDeps(
  repoPaths: string[],
  deps: GitSessionAuthDependencies,
): Promise<TerminalSessionEnvironment[]> {
  const uniqueRepoPaths = Array.from(new Set(repoPaths.map((repoPath) => repoPath.trim()).filter(Boolean)));
  if (uniqueRepoPaths.length === 0) return [];

  const allCredentials = await deps.getAllCredentials();
  const candidates = (await Promise.all(
    uniqueRepoPaths.map((repoPath) => resolveGitSessionEnvironmentCandidatesForRepo(repoPath, allCredentials, deps)),
  )).flat();

  return mergeGitTerminalSessionEnvironments(candidates, {
    onConflict: (message) => console.warn(message),
  });
}
