'use server';

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import simpleGit from 'simple-git';
import { resolveRepositoryPathByName } from '@/lib/repo-resolver';
import { getAllCredentials, getCredentialById, getCredentialToken } from '@/lib/credentials';
import type { Credential } from '@/lib/credentials';
import { detectGitRemoteProvider, parseGitRemoteHost } from '@/lib/terminal-session';

type ResolveRepositoryResult = {
  success: boolean;
  repoPath: string | null;
  error?: string;
};

type CloneRemoteRepositoryResult = {
  success: boolean;
  repoPath: string | null;
  error?: string;
};

export async function resolveRepositoryByName(repoName: string): Promise<ResolveRepositoryResult> {
  try {
    const resolvedPath = await resolveRepositoryPathByName(repoName);
    return {
      success: true,
      repoPath: resolvedPath,
    };
  } catch (error) {
    console.error('Failed to resolve repository by name:', error);
    return {
      success: false,
      repoPath: null,
      error: 'Failed to search repositories. Please try again.',
    };
  }
}

function getGitLabCredentialHost(credential: Credential): string | null {
  if (credential.type !== 'gitlab') return null;

  try {
    return new URL(credential.serverUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function pickCandidateCredential(
  credentials: Credential[],
  provider: 'github' | 'gitlab',
  remoteHost: string | null,
): Credential | null {
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

function getRepoNameFromRemoteUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;

  let rawPath = '';

  try {
    const parsed = new URL(trimmed);
    rawPath = parsed.pathname;
  } catch {
    const scpLikeMatch = trimmed.match(/^([^@]+@)?([^:]+):(.+)$/);
    if (scpLikeMatch) {
      rawPath = scpLikeMatch[3];
    } else {
      rawPath = trimmed;
    }
  }

  const normalized = rawPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return null;

  let baseName = path.posix.basename(normalized);
  if (!baseName || baseName === '.' || baseName === '..') return null;

  if (baseName.toLowerCase().endsWith('.git')) {
    baseName = baseName.slice(0, -4);
  }

  const sanitized = baseName
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  return sanitized || null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitizeErrorMessage(message: string, secretValues: string[]): string {
  let sanitized = message;

  for (const value of secretValues) {
    if (!value) continue;
    sanitized = sanitized.replace(new RegExp(escapeRegExp(value), 'g'), '***');
  }

  return sanitized.replace(/:\/\/[^/\s@]+@/g, '://***@');
}

function buildAuthenticatedCloneUrl(remoteUrl: string, credential: Credential, token: string): string {
  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return remoteUrl;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return remoteUrl;
  }

  if (credential.type === 'github') {
    parsed.username = 'x-access-token';
    parsed.password = token;
    return parsed.toString();
  }

  parsed.username = 'oauth2';
  parsed.password = token;
  return parsed.toString();
}

type CloneCredentialResolution =
  | { success: true; credential: Credential | null; token: string | null }
  | { success: false; error: string };

async function resolveCloneCredential(
  remoteUrl: string,
  credentialId: string | null,
): Promise<CloneCredentialResolution> {
  const allCredentials = await getAllCredentials();
  const provider = detectGitRemoteProvider(remoteUrl, {
    gitlabHosts: allCredentials.flatMap((credential) => {
      if (credential.type !== 'gitlab') return [];
      const host = getGitLabCredentialHost(credential);
      return host ? [host] : [];
    }),
  });
  const remoteHost = parseGitRemoteHost(remoteUrl);

  if (credentialId) {
    const selectedCredential = await getCredentialById(credentialId);
    if (!selectedCredential) {
      return { success: false, error: 'Selected credential was not found. Please choose another credential.' };
    }

    if (provider === 'github' && selectedCredential.type !== 'github') {
      return { success: false, error: 'Selected credential does not match this GitHub repository.' };
    }
    if (provider === 'gitlab' && selectedCredential.type !== 'gitlab') {
      return { success: false, error: 'Selected credential does not match this GitLab repository.' };
    }

    if (selectedCredential.type === 'gitlab' && remoteHost) {
      const credentialHost = getGitLabCredentialHost(selectedCredential);
      if (credentialHost && credentialHost !== remoteHost) {
        return {
          success: false,
          error: `Selected GitLab credential targets ${credentialHost}, but this repository uses ${remoteHost}.`,
        };
      }
    }

    const token = await getCredentialToken(selectedCredential.id);
    if (!token) {
      return { success: false, error: 'Could not load token for selected credential.' };
    }

    return { success: true, credential: selectedCredential, token };
  }

  if (!provider) {
    return { success: true, credential: null, token: null };
  }

  const candidate = pickCandidateCredential(allCredentials, provider, remoteHost);
  if (!candidate) {
    return { success: true, credential: null, token: null };
  }

  const token = await getCredentialToken(candidate.id);
  if (!token) {
    return { success: true, credential: null, token: null };
  }

  return { success: true, credential: candidate, token };
}

export async function cloneRemoteRepository(
  remoteUrl: string,
  credentialId: string | null,
): Promise<CloneRemoteRepositoryResult> {
  const trimmedRemoteUrl = remoteUrl.trim();
  if (!trimmedRemoteUrl) {
    return { success: false, repoPath: null, error: 'Please enter a remote repository URL.' };
  }

  const repoName = getRepoNameFromRemoteUrl(trimmedRemoteUrl);
  if (!repoName) {
    return { success: false, repoPath: null, error: 'Could not determine repository name from URL.' };
  }

  const cloneRoot = path.join(os.homedir(), '.viba', 'repos');
  await fs.mkdir(cloneRoot, { recursive: true });

  const targetPath = path.join(cloneRoot, repoName);
  try {
    await fs.access(targetPath);
    return {
      success: false,
      repoPath: null,
      error: `Repository already exists at ${targetPath}.`,
    };
  } catch {
    // Path does not exist yet.
  }

  const credentialResolution = await resolveCloneCredential(trimmedRemoteUrl, credentialId);
  if (!credentialResolution.success) {
    return { success: false, repoPath: null, error: credentialResolution.error };
  }

  const cloneUrl = (credentialResolution.credential && credentialResolution.token)
    ? buildAuthenticatedCloneUrl(trimmedRemoteUrl, credentialResolution.credential, credentialResolution.token)
    : trimmedRemoteUrl;

  const git = simpleGit();

  try {
    await git.clone(cloneUrl, targetPath);

    if (cloneUrl !== trimmedRemoteUrl) {
      const clonedRepoGit = simpleGit(targetPath);
      await clonedRepoGit.remote(['set-url', 'origin', trimmedRemoteUrl]);
    }

    return {
      success: true,
      repoPath: targetPath,
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const safeMessage = sanitizeErrorMessage(rawMessage, [
      cloneUrl,
      credentialResolution.token ?? '',
    ]);

    try {
      await fs.rm(targetPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }

    return {
      success: false,
      repoPath: null,
      error: safeMessage || 'Failed to clone repository.',
    };
  }
}
