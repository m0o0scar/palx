import fs from 'fs/promises';
import type { Dirent } from 'fs';
import path from 'path';
import { getConfig } from '@/app/actions/config';

const MAX_SCAN_DEPTH = 5;
const MAX_SCANNED_DIRECTORIES = 5000;

async function isGitRepository(dirPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(dirPath, '.git'));
    return true;
  } catch {
    return false;
  }
}

function hasMatchingName(repoPath: string, repoName: string): boolean {
  return path.basename(repoPath).toLowerCase() === repoName.toLowerCase();
}

async function findByNameWithinRoot(rootPath: string, repoName: string): Promise<string | null> {
  const directCandidate = path.join(rootPath, repoName);
  if (await isGitRepository(directCandidate)) {
    return directCandidate;
  }

  const queue: Array<{ dirPath: string; depth: number }> = [{ dirPath: rootPath, depth: 0 }];
  let scannedCount = 0;
  const targetName = repoName.toLowerCase();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;

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
      if (entry.name === '.git' || entry.name === 'node_modules') continue;

      const nextDirPath = path.join(current.dirPath, entry.name);

      if (entry.name.toLowerCase() === targetName && await isGitRepository(nextDirPath)) {
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

  const config = await getConfig();

  const recentMatches = config.recentRepos.filter((repoPath) => hasMatchingName(repoPath, trimmedName));
  for (const repoPath of recentMatches) {
    if (await isGitRepository(repoPath)) {
      return repoPath;
    }
  }

  const searchRoots: string[] = [];
  if (config.defaultRoot) {
    searchRoots.push(config.defaultRoot);
  }
  for (const repoPath of config.recentRepos) {
    const parentPath = path.dirname(repoPath);
    if (!searchRoots.includes(parentPath)) {
      searchRoots.push(parentPath);
    }
  }

  for (const rootPath of searchRoots) {
    const resolvedPath = await findByNameWithinRoot(rootPath, trimmedName);
    if (resolvedPath) {
      return resolvedPath;
    }
  }

  return null;
}
