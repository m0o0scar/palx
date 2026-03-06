'use server';

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import simpleGit from 'simple-git';
import { resolveRepositoryPathByName } from '@/lib/repo-resolver';
import { getAllCredentials, getCredentialById, getCredentialToken } from '@/lib/credentials';
import type { Credential } from '@/lib/credentials';
import { detectGitRemoteProvider, parseGitRemoteHost } from '@/lib/terminal-session';
import { listDrafts, type DraftMetadata } from './draft';
import { listSessions, type SessionMetadata } from './session';

type GitBranch = {
  name: string;
  current: boolean;
};

export type ResolveProjectResult = {
  success: boolean;
  projectPath: string | null;
  error?: string;
};

export type CloneRemoteProjectResult = {
  success: boolean;
  projectPath: string | null;
  error?: string;
};

export type DiscoveredProjectGitRepo = {
  repoPath: string;
  relativePath: string;
};

export type DiscoverProjectGitReposResult = {
  repos: DiscoveredProjectGitRepo[];
  truncated: boolean;
  scannedDirs: number;
  overlapDetected: boolean;
};

export type DiscoverProjectGitReposWithBranchesResult = DiscoverProjectGitReposResult & {
  branchesByRepo: Record<string, GitBranch[]>;
};

export type ProjectActivityResult = {
  sessions: SessionMetadata[];
  drafts: DraftMetadata[];
};

const DISCOVERY_SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  '.viba',
  '.cache',
  'dist',
  'build',
  'coverage',
]);

const MAX_DISCOVERY_DEPTH = 8;
const MAX_DISCOVERED_DIRS = 15000;
const MAX_DISCOVERED_REPOS = 200;

function normalizeAbsolutePath(targetPath: string): string {
  return path.resolve(targetPath);
}

function pathContainsPath(parentPath: string, candidatePath: string): boolean {
  const normalizedParent = normalizeAbsolutePath(parentPath);
  const normalizedCandidate = normalizeAbsolutePath(candidatePath);
  if (normalizedParent === normalizedCandidate) return true;

  const relativePath = path.relative(normalizedParent, normalizedCandidate);
  return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function hasOverlappingRepoRoots(repoPaths: string[]): boolean {
  const normalized = Array.from(
    new Set(
      repoPaths
        .map((repoPath) => repoPath.trim())
        .filter(Boolean)
        .map((repoPath) => normalizeAbsolutePath(repoPath))
    )
  ).sort((a, b) => a.localeCompare(b));

  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      if (pathContainsPath(normalized[i], normalized[j])) {
        return true;
      }
    }
  }

  return false;
}

async function isGitRepositoryRoot(dirPath: string): Promise<boolean> {
  const gitPath = path.join(dirPath, '.git');
  try {
    const gitStat = await fs.stat(gitPath);
    return gitStat.isDirectory() || gitStat.isFile();
  } catch {
    return false;
  }
}

async function listRepoBranches(repoPath: string): Promise<GitBranch[]> {
  try {
    const git = simpleGit(repoPath);
    const branchSummary = await git.branchLocal();
    return branchSummary.all.map((name) => ({
      name,
      current: branchSummary.current === name,
    }));
  } catch {
    return [];
  }
}

export async function discoverProjectGitRepos(projectPath: string): Promise<DiscoverProjectGitReposResult> {
  const normalizedProjectPath = projectPath.trim();
  if (!normalizedProjectPath) {
    throw new Error('Project path is required.');
  }

  const absoluteProjectPath = normalizeAbsolutePath(normalizedProjectPath);
  const projectStats = await fs.stat(absoluteProjectPath);
  if (!projectStats.isDirectory()) {
    throw new Error('Project path must be a directory.');
  }

  const queue: Array<{ dirPath: string; depth: number }> = [{ dirPath: absoluteProjectPath, depth: 0 }];
  const visited = new Set<string>();
  const discoveredRepos: string[] = [];
  let scannedDirs = 0;
  let truncated = false;

  for (let index = 0; index < queue.length; index += 1) {
    if (scannedDirs >= MAX_DISCOVERED_DIRS || discoveredRepos.length >= MAX_DISCOVERED_REPOS) {
      truncated = true;
      break;
    }

    const current = queue[index];
    if (current.depth > MAX_DISCOVERY_DEPTH) continue;

    const normalizedCurrentDir = normalizeAbsolutePath(current.dirPath);
    if (visited.has(normalizedCurrentDir)) continue;
    visited.add(normalizedCurrentDir);
    scannedDirs += 1;

    if (await isGitRepositoryRoot(normalizedCurrentDir)) {
      discoveredRepos.push(normalizedCurrentDir);
    }

    let entries: Array<import('fs').Dirent>;
    try {
      entries = await fs.readdir(normalizedCurrentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (DISCOVERY_SKIP_DIRS.has(entry.name)) continue;

      const childPath = path.join(normalizedCurrentDir, entry.name);
      queue.push({ dirPath: childPath, depth: current.depth + 1 });
    }
  }

  const uniqueRepos = Array.from(new Set(discoveredRepos)).sort((a, b) => a.localeCompare(b));
  const repos: DiscoveredProjectGitRepo[] = uniqueRepos.map((repoPath) => {
    const relativePath = path.relative(absoluteProjectPath, repoPath);
    return {
      repoPath,
      relativePath: relativePath === '.' ? '' : relativePath,
    };
  });

  return {
    repos,
    truncated,
    scannedDirs,
    overlapDetected: hasOverlappingRepoRoots(uniqueRepos),
  };
}

export async function discoverProjectGitReposWithBranches(projectPath: string): Promise<DiscoverProjectGitReposWithBranchesResult> {
  const discovery = await discoverProjectGitRepos(projectPath);
  const branchEntries = await Promise.all(
    discovery.repos.map(async (repo) => [repo.repoPath, await listRepoBranches(repo.repoPath)] as const)
  );

  return {
    ...discovery,
    branchesByRepo: Object.fromEntries(branchEntries),
  };
}

export async function getProjectActivity(projectPath: string): Promise<ProjectActivityResult> {
  const [sessions, drafts] = await Promise.all([
    listSessions(projectPath),
    listDrafts(projectPath),
  ]);

  return {
    sessions,
    drafts,
  };
}

export async function resolveProjectByName(projectName: string): Promise<ResolveProjectResult> {
  try {
    const resolvedPath = await resolveRepositoryPathByName(projectName);
    return {
      success: true,
      projectPath: resolvedPath,
    };
  } catch (error) {
    console.error('Failed to resolve project by name:', error);
    return {
      success: false,
      projectPath: null,
      error: 'Failed to search projects. Please try again.',
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

function getProjectNameFromRemoteUrl(remoteUrl: string): string | null {
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

  const normalized = rawPath.replace(/\/+$/, '');
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

export async function cloneRemoteProject(
  remoteUrl: string,
  credentialId: string | null,
): Promise<CloneRemoteProjectResult> {
  const trimmedRemoteUrl = remoteUrl.trim();
  if (!trimmedRemoteUrl) {
    return { success: false, projectPath: null, error: 'Please enter a remote project URL.' };
  }

  const projectName = getProjectNameFromRemoteUrl(trimmedRemoteUrl);
  if (!projectName) {
    return { success: false, projectPath: null, error: 'Could not determine project name from URL.' };
  }

  const cloneRoot = path.join(os.homedir(), '.viba', 'projects');
  await fs.mkdir(cloneRoot, { recursive: true });

  const targetPath = path.join(cloneRoot, projectName);
  try {
    await fs.access(targetPath);
    return {
      success: false,
      projectPath: null,
      error: `Project already exists at ${targetPath}.`,
    };
  } catch {
    // Path does not exist yet.
  }

  const credentialResolution = await resolveCloneCredential(trimmedRemoteUrl, credentialId);
  if (!credentialResolution.success) {
    return { success: false, projectPath: null, error: credentialResolution.error };
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
      projectPath: targetPath,
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
      projectPath: null,
      error: safeMessage || 'Failed to clone project.',
    };
  }
}
