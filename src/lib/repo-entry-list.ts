import fs from 'fs/promises';
import path from 'path';

const MAX_ENTRIES = 10000;
const MAX_DIRS = 15000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', '.viba', '.cache', 'dist', 'build', 'coverage']);

export async function listRepoEntries(repoPath: string, query: string = ''): Promise<string[]> {
  const queue: string[] = [repoPath];
  const allEntries: string[] = [];
  let scannedDirs = 0;

  try {
    while (queue.length > 0 && scannedDirs < MAX_DIRS && allEntries.length < MAX_ENTRIES) {
      const currentDir = queue.shift();
      if (!currentDir) break;
      scannedDirs += 1;

      let entries: Array<import('fs').Dirent>;
      try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);

        if (entry.isDirectory()) {
          if (SKIP_DIRS.has(entry.name)) continue;

          const relativePath = path.relative(repoPath, fullPath);
          if (relativePath && !relativePath.startsWith('..')) {
            allEntries.push(relativePath);
            if (allEntries.length >= MAX_ENTRIES) break;
          }

          queue.push(fullPath);
          continue;
        }

        if (!entry.isFile()) continue;

        const relativePath = path.relative(repoPath, fullPath);
        if (!relativePath || relativePath.startsWith('..')) continue;
        allEntries.push(relativePath);
        if (allEntries.length >= MAX_ENTRIES) break;
      }
    }

    if (!query) return allEntries.slice(0, 50);

    const lowerQuery = query.toLowerCase();
    return allEntries.filter((entry) => entry.toLowerCase().includes(lowerQuery)).slice(0, 50);
  } catch {
    return [];
  }
}
