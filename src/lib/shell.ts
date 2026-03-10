export type ShellKind = 'posix' | 'powershell';

export function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function quotePowerShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function quoteShellArg(value: string, shellKind: ShellKind = 'posix'): string {
  return shellKind === 'powershell'
    ? quotePowerShellArg(value)
    : quotePosixShellArg(value);
}

export function buildShellExportEnvironmentCommand(
  environment: Array<{ name: string; value: string }>,
  shellKind: ShellKind,
): string {
  const assignments = environment.filter((entry) => entry.name && entry.value);
  if (assignments.length === 0) return '';

  if (shellKind === 'powershell') {
    return assignments
      .map((entry) => `$env:${entry.name} = ${quotePowerShellArg(entry.value)}`)
      .join('; ');
  }

  return `export ${assignments.map((entry) => `${entry.name}=${quotePosixShellArg(entry.value)}`).join(' ')}`;
}

export function buildShellSetDirectoryCommand(directoryPath: string, shellKind: ShellKind): string {
  const trimmed = directoryPath.trim();
  if (!trimmed) return '';

  if (shellKind === 'powershell') {
    return `Set-Location -LiteralPath ${quotePowerShellArg(trimmed)}`;
  }

  return `cd ${quotePosixShellArg(trimmed)}`;
}

export function joinShellStatements(statements: Array<string | null | undefined>, shellKind: ShellKind): string {
  const filtered = statements.map((statement) => statement?.trim()).filter(Boolean);
  if (filtered.length === 0) return '';
  return filtered.join(shellKind === 'powershell' ? '; ' : ' && ');
}
