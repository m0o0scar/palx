export type ResolveSessionTerminalRepoPathsOptions = {
  sessionRepoPaths?: string[];
  discoveredProjectRepoPaths?: string[] | null;
  activeRepoPath?: string | null;
  projectPath: string;
};

export function resolveSessionTerminalRepoPaths(
  options: ResolveSessionTerminalRepoPathsOptions,
): string[] {
  const combined = [
    ...(options.sessionRepoPaths ?? []),
    ...(options.discoveredProjectRepoPaths ?? []),
  ]
    .map((repoPath) => repoPath.trim())
    .filter(Boolean);

  if (combined.length > 0) {
    return Array.from(new Set(combined));
  }

  const fallback = [
    options.activeRepoPath?.trim() ?? '',
    options.projectPath.trim(),
  ].filter(Boolean);

  return Array.from(new Set(fallback));
}
