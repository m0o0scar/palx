import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class FsLaunchError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'FsLaunchError';
    this.status = status;
  }
}

type CommandAttempt = {
  command: string;
  args: string[];
  cwd?: string;
};

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function runCommand(attempt: CommandAttempt): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(attempt.command, attempt.args, {
      cwd: attempt.cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });

    child.on('error', (error) => {
      reject(new Error(`Failed to launch ${attempt.command}: ${toErrorMessage(error)}`));
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `${attempt.command} exited with code ${code ?? 'unknown'}`));
    });
  });
}

async function runFirstSuccessful(attempts: CommandAttempt[]): Promise<void> {
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      await runCommand(attempt);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('No launch command was successful');
}

export function resolveExistingDirectory(targetPath: string): string {
  const trimmed = targetPath.trim();
  if (!trimmed) {
    throw new FsLaunchError('path is required', 400);
  }

  const normalized = path.resolve(trimmed);
  if (!fs.existsSync(normalized)) {
    throw new FsLaunchError(`Path not found: ${normalized}`, 404);
  }

  const stat = fs.statSync(normalized);
  if (!stat.isDirectory()) {
    throw new FsLaunchError('Path must be a directory', 400);
  }

  return normalized;
}

export function getFileManagerLaunchAttempts(directoryPath: string): CommandAttempt[] {
  if (process.platform === 'win32') {
    return [{ command: 'explorer.exe', args: [directoryPath] }];
  }

  if (process.platform === 'darwin') {
    return [{ command: 'open', args: [directoryPath] }];
  }

  return [{ command: 'xdg-open', args: [directoryPath] }];
}

export async function openDirectoryInFileManager(directoryPath: string): Promise<void> {
  const attempts = getFileManagerLaunchAttempts(directoryPath);
  try {
    await runFirstSuccessful(attempts);
  } catch (error) {
    throw new FsLaunchError(`Failed to open directory: ${toErrorMessage(error)}`, 500);
  }
}

export function getTerminalLaunchAttempts(directoryPath: string): CommandAttempt[] {
  if (process.platform === 'win32') {
    const escapedForCmd = directoryPath.replace(/"/g, '""');
    return [
      { command: 'wt.exe', args: ['-d', directoryPath] },
      { command: 'pwsh.exe', args: ['-NoExit', '-Command', `Set-Location -LiteralPath '${directoryPath.replace(/'/g, "''")}'`] },
      { command: 'powershell.exe', args: ['-NoExit', '-Command', `Set-Location -LiteralPath '${directoryPath.replace(/'/g, "''")}'`] },
      { command: 'cmd.exe', args: ['/k', `cd /d "${escapedForCmd}"`] },
    ];
  }

  if (process.platform === 'darwin') {
    return [{ command: 'open', args: ['-a', 'Terminal', directoryPath] }];
  }

  return [
    { command: 'gnome-terminal', args: ['--working-directory', directoryPath] },
    { command: 'konsole', args: ['--workdir', directoryPath] },
    { command: 'xfce4-terminal', args: ['--working-directory', directoryPath] },
    { command: 'kitty', args: ['--directory', directoryPath] },
    { command: 'alacritty', args: ['--working-directory', directoryPath] },
    { command: 'x-terminal-emulator', args: ['--working-directory', directoryPath] },
  ];
}

export async function openDirectoryInTerminal(directoryPath: string): Promise<void> {
  const attempts = getTerminalLaunchAttempts(directoryPath);
  try {
    await runFirstSuccessful(attempts);
  } catch (error) {
    throw new FsLaunchError(`Failed to open terminal: ${toErrorMessage(error)}`, 500);
  }
}
