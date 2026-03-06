import fs from 'fs/promises';
import type { Dirent } from 'fs';
import path from 'path';
import { getConfig } from '@/app/actions/config';

const MAX_SCAN_DEPTH = 5;
const MAX_SCANNED_DIRECTORIES = 5000;
const RESOLUTION_CACHE_TTL_MS = 5 * 60 * 1000;
const SKIPPED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  '.next',
  '.viba',
  'dist',
  'build',
  'coverage',
]);

type RepoResolutionCacheEntry = {
  projectPath: string;
  resolvedAt: number;
};

declare global {
  var repoResolutionCache: Map<string, RepoResolutionCacheEntry> | undefined;
}

function getResolutionCache(): Map<string, RepoResolutionCacheEntry> {
  if (!global.repoResolutionCache) {
    global.repoResolutionCache = new Map<string, RepoResolutionCacheEntry>();
  }
  return global.repoResolutionCache;
}

function cacheResolution(repoName: string, repoPath: string): void {
  getResolutionCache().set(repoName.toLowerCase(), {
    projectPath: repoPath,
    resolvedAt: Date.now(),
  });
}

async function getValidCachedResolution(repoName: string): Promise<string | null> {
  const entry = getResolutionCache().get(repoName.toLowerCase());
  if (!entry) return null;
  if (Date.now() - entry.resolvedAt > RESOLUTION_CACHE_TTL_MS) {
    getResolutionCache().delete(repoName.toLowerCase());
    return null;
  }

  if (await isExistingDirectory(entry.projectPath)) {
    return entry.projectPath;
  }

  getResolutionCache().delete(repoName.toLowerCase());
  return null;
}

async function isExistingDirectory(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dirPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

function hasMatchingName(repoPath: string, repoName: string): boolean {
  return path.basename(repoPath).toLowerCase() === repoName.toLowerCase();
}

function shouldSkipDirectory(entryName: string, targetName: string): boolean {
  const lowerName = entryName.toLowerCase();
  if (lowerName === targetName) return false;
  if (SKIPPED_DIR_NAMES.has(lowerName)) return true;
  if (entryName.startsWith('.')) return true;
  return false;
}

async function findByNameWithinRoot(rootPath: string, repoName: string): Promise<string | null> {
  const directCandidate = path.join(rootPath, repoName);
  if (await isExistingDirectory(directCandidate)) {
    return directCandidate;
  }

  const queue: Array<{ dirPath: string; depth: number }> = [{ dirPath: rootPath, depth: 0 }];
  let scannedCount = 0;
  const targetName = repoName.toLowerCase();

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    scannedCount += 1;
    if (scannedCount > MAX_SCANNED_DIRECTORIES) {
      break;
    }

    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (shouldSkipDirectory(entry.name, targetName)) continue;

      const nextDirPath = path.join(current.dirPath, entry.name);

      if (entry.name.toLowerCase() === targetName && await isExistingDirectory(nextDirPath)) {
        return nextDirPath;
      }

      if (current.depth + 1 <= MAX_SCAN_DEPTH) {
        queue.push({ dirPath: nextDirPath, depth: current.depth + 1 });
      }
    }
  }

  return null;
}

export async function resolveRepositoryPathByName(repoName: string): Promise<string | null> {
  const trimmedName = repoName.trim();
  if (!trimmedName) return null;

  const cachedResolution = await getValidCachedResolution(trimmedName);
  if (cachedResolution) {
    return cachedResolution;
  }

  const config = await getConfig();
  const recentProjects = config.recentProjects ?? config.recentRepos ?? [];

  const recentMatches = recentProjects.filter((repoPath) => hasMatchingName(repoPath, trimmedName));
  for (const repoPath of recentMatches) {
    if (await isExistingDirectory(repoPath)) {
      cacheResolution(trimmedName, repoPath);
      return repoPath;
    }
  }

  const searchRoots: string[] = [];
  const visitedRoots = new Set<string>();
  for (const repoPath of recentProjects) {
    const parentPath = path.dirname(repoPath);
    if (!visitedRoots.has(parentPath)) {
      visitedRoots.add(parentPath);
      searchRoots.push(parentPath);
    }
  }
  if (config.defaultRoot && !visitedRoots.has(config.defaultRoot)) {
    visitedRoots.add(config.defaultRoot);
    searchRoots.push(config.defaultRoot);
  }

  for (const rootPath of searchRoots) {
    const resolvedPath = await findByNameWithinRoot(rootPath, trimmedName);
    if (resolvedPath) {
      cacheResolution(trimmedName, resolvedPath);
      return resolvedPath;
    }
  }

  return null;
}
