import simpleGit from 'simple-git';

import { getGitRepoCredential } from '@/app/actions/config';
import {
  getAllCredentials,
  getCredentialById,
  getCredentialToken,
} from '@/lib/credentials';
import {
  resolveGitSessionEnvironmentsWithDeps,
  type GitSessionAuthDependencies,
} from '@/lib/git-session-auth-core';

async function getPrimaryRemoteUrl(repoPath: string): Promise<string | null> {
  const git = simpleGit(repoPath);

  try {
    const originUrl = (await git.raw(['remote', 'get-url', 'origin'])).trim();
    if (originUrl) return originUrl;
  } catch {
    // Fall back to the first available remote below.
  }

  try {
    const remotes = await git.getRemotes(true);
    for (const remote of remotes) {
      const fetchUrl = remote.refs?.fetch?.trim();
      if (fetchUrl) return fetchUrl;

      const pushUrl = remote.refs?.push?.trim();
      if (pushUrl) return pushUrl;
    }
  } catch {
    // Ignore and fall back to null.
  }

  return null;
}

export async function resolveGitSessionEnvironments(
  repoPaths: string[],
  overrides: Partial<GitSessionAuthDependencies> = {},
) {
  return await resolveGitSessionEnvironmentsWithDeps(repoPaths, {
    getAllCredentials,
    getCredentialById,
    getCredentialToken,
    getGitRepoCredential,
    getPrimaryRemoteUrl,
    ...overrides,
  });
}
