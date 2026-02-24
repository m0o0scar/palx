'use server';

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import simpleGit from 'simple-git';
import { getTmuxSessionName, TerminalSessionRole } from '@/lib/terminal-session';

export type FileSystemItem = {
  name: string;
  path: string;
  isDirectory: boolean;
  isGitRepo: boolean;
};

export type GitBranch = {
  name: string;
  current: boolean;
};

export type SupportedAgentCli = 'gemini' | 'codex' | 'agent';

type AgentCliConfig = {
  executable: string;
  installCommand: string;
};

const AGENT_CLI_CONFIG: Record<SupportedAgentCli, AgentCliConfig> = {
  gemini: {
    executable: 'gemini',
    installCommand: 'npm install -g google/gemini-cli',
  },
  codex: {
    executable: 'codex',
    installCommand: 'npm i -g openai/codex',
  },
  agent: {
    executable: 'agent',
    installCommand: 'curl https://cursor.com/install -fsS | bash',
  },
};

function normalizeAgentCli(agentCli: string): SupportedAgentCli | null {
  if (agentCli === 'gemini' || agentCli === 'codex' || agentCli === 'agent') {
    return agentCli;
  }
  return null;
}

export async function getHomeDirectory() {
  return os.homedir();
}

export async function listPathEntries(dirPath: string): Promise<FileSystemItem[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    const sortedEntries = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    const items: FileSystemItem[] = [];

    for (const entry of sortedEntries) {
      if (!entry.isDirectory() && !entry.isFile()) continue;

      const fullPath = path.join(dirPath, entry.name);
      let isGitRepo = false;

      if (entry.isDirectory()) {
        try {
          const gitDir = path.join(fullPath, '.git');
          await fs.access(gitDir);
          isGitRepo = true;
        } catch {
          isGitRepo = false;
        }
      }

      items.push({
        name: entry.name,
        path: fullPath,
        isDirectory: entry.isDirectory(),
        isGitRepo,
      });
    }

    return items;
  } catch (error) {
    console.error('Error listing directory entries:', error);
    return [];
  }
}

export async function listDirectories(dirPath: string): Promise<FileSystemItem[]> {
  const items = await listPathEntries(dirPath);
  return items.filter((item) => item.isDirectory);
}

export async function checkDirectoryAccessible(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dirPath);
    if (!stats.isDirectory()) return false;
    await fs.readdir(dirPath);
    return true;
  } catch {
    return false;
  }
}

export async function getBranches(repoPath: string): Promise<GitBranch[]> {
  try {
    const git = simpleGit(repoPath);
    const branchSummary = await git.branchLocal();

    return branchSummary.all.map(name => ({
      name,
      current: branchSummary.current === name,
    }));
  } catch (error) {
    console.error('Error fetching branches:', error);
    throw new Error('Failed to fetch branches. Make sure the path is a valid git repository.');
  }
}

export async function checkoutBranch(repoPath: string, branchName: string): Promise<void> {
  try {
    const git = simpleGit(repoPath);
    await git.checkout(branchName);
  } catch (error) {
    console.error('Error checking out branch:', error);
    throw new Error(`Failed to checkout branch ${branchName}`);
  }
}

export async function checkIsGitRepo(dirPath: string): Promise<boolean> {
  try {
    const gitDir = path.join(dirPath, '.git');
    await fs.access(gitDir);
    return true;
  } catch {
    return false;
  }
}

export async function checkAgentCliInstalled(
  agentCli: string
): Promise<{ success: boolean; installed: boolean; error?: string }> {
  const normalizedCli = normalizeAgentCli(agentCli);
  if (!normalizedCli) {
    return { success: false, installed: false, error: `Unsupported coding agent CLI: ${agentCli}` };
  }

  try {
    const { spawn } = await import('child_process');
    const cliConfig = AGENT_CLI_CONFIG[normalizedCli];
    const isWindows = os.platform() === 'win32';
    const shell = isWindows ? 'powershell' : 'bash';
    const shellArgs = isWindows
      ? ['-Command', `Get-Command ${cliConfig.executable} -ErrorAction SilentlyContinue`]
      : ['-lc', `command -v ${cliConfig.executable}`];

    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(shell, shellArgs, { stdio: 'ignore' });
      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', () => resolve(1));
    });

    return { success: true, installed: exitCode === 0 };
  } catch (error) {
    console.error('Failed to detect coding agent CLI:', error);
    return { success: false, installed: false, error: 'Failed to detect coding agent CLI installation status.' };
  }
}

export async function installAgentCli(agentCli: string): Promise<{ success: boolean; error?: string }> {
  const normalizedCli = normalizeAgentCli(agentCli);
  if (!normalizedCli) {
    return { success: false, error: `Unsupported coding agent CLI: ${agentCli}` };
  }

  try {
    const { spawn } = await import('child_process');
    const cliConfig = AGENT_CLI_CONFIG[normalizedCli];
    const isWindows = os.platform() === 'win32';
    const shell = isWindows ? 'powershell' : 'bash';
    const shellArgs = isWindows
      ? ['-Command', cliConfig.installCommand]
      : ['-lc', cliConfig.installCommand];

    const outputChunks: string[] = [];
    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn(shell, shellArgs, {
        cwd: os.homedir(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      child.stdout.on('data', (chunk: Buffer) => {
        outputChunks.push(chunk.toString());
      });

      child.stderr.on('data', (chunk: Buffer) => {
        outputChunks.push(chunk.toString());
      });

      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', () => resolve(1));
    });

    if (exitCode === 0) {
      return { success: true };
    }

    const detail = outputChunks.join('').trim();
    return {
      success: false,
      error: detail || `Failed to install ${normalizedCli} CLI.`,
    };
  } catch (error) {
    console.error('Failed to install coding agent CLI:', error);
    return { success: false, error: 'Failed to install coding agent CLI.' };
  }
}

// Global variable to track the ttyd process
declare global {
  var ttydProcess: ReturnType<typeof import('child_process').spawn> | undefined;
  var ttydPersistenceMode: 'tmux' | 'shell' | undefined;
}

export async function startTtydProcess(): Promise<{ success: boolean; persistenceMode?: 'tmux' | 'shell'; error?: string }> {
  if (global.ttydProcess) {
    return { success: true, persistenceMode: global.ttydPersistenceMode || 'shell' };
  }

  try {
    const { spawn, spawnSync } = await import('child_process');

    const env: any = { ...process.env };
    // Clean up environment variables to prevent conflicts
    // Specifically remove TURBOPACK which causes "Multiple bundler flags set" error
    // when running next dev inside the terminal if the parent process has it set.
    delete env.TURBOPACK;
    delete env.PORT;
    delete env.NODE_ENV;

    const workingDir = os.homedir();
    const isWindows = os.platform() === 'win32';
    const commandProbe = isWindows ? 'where' : 'which';
    const hasTmux =
      !isWindows &&
      spawnSync(commandProbe, ['tmux'], {
        stdio: 'ignore',
        env: process.env,
      }).status === 0;

    const ttydArgs = [
      '-p', '7681',
      '-t', 'theme={"background": "white", "foreground": "black", "cursor": "black", "selectionBackground": "rgba(59, 130, 246, 0.4)"}',
      '-t', 'disableResizeOverlay=true',
      '-t', 'fontSize=12',
      '-t', 'fontWeight=300',
      '-t', 'fontWeightBold=500',
      '-w', workingDir,
      '-W',
    ];

    let persistenceMode: 'tmux' | 'shell' = 'shell';
    if (hasTmux) {
      // Ensure tmux sessions keep enough history and support mouse wheel scrolling.
      spawnSync('tmux', ['start-server'], {
        stdio: 'ignore',
        env: process.env,
      });
      spawnSync('tmux', ['set-option', '-g', 'mouse', 'on'], {
        stdio: 'ignore',
        env: process.env,
      });
      spawnSync('tmux', ['set-option', '-g', 'history-limit', '200000'], {
        stdio: 'ignore',
        env: process.env,
      });

      // Use URL args so each iframe can attach to a dedicated tmux session.
      ttydArgs.push('-a', 'tmux');
      persistenceMode = 'tmux';
    } else {
      const shell = isWindows ? 'powershell' : 'bash';
      console.warn('tmux is unavailable; falling back to non-persistent ttyd shell mode.');
      ttydArgs.push(shell);
    }

    const child = spawn('ttyd', ttydArgs, {
      stdio: 'ignore',
      detached: false,
      cwd: workingDir,
      env: {
        ...env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });

    child.on('error', (err) => {
      console.error('Failed to start ttyd:', err);
      global.ttydProcess = undefined;
      global.ttydPersistenceMode = undefined;
    });

    child.on('exit', () => {
      global.ttydProcess = undefined;
      global.ttydPersistenceMode = undefined;
    });

    global.ttydProcess = child;
    global.ttydPersistenceMode = persistenceMode;

    await new Promise(resolve => setTimeout(resolve, 1000));

    return { success: true, persistenceMode };
  } catch (error) {
    console.error('Error starting ttyd:', error);
    return { success: false, error: 'Failed to start ttyd. Make sure ttyd is installed and in your PATH.' };
  }
}

export async function terminateSessionTerminalSessions(sessionName: string): Promise<void> {
  if (os.platform() === 'win32') return;

  try {
    const { spawnSync } = await import('child_process');
    const tmuxExists =
      spawnSync('which', ['tmux'], {
        stdio: 'ignore',
        env: process.env,
      }).status === 0;

    if (!tmuxExists) return;

    const roles: TerminalSessionRole[] = ['agent', 'terminal'];
    for (const role of roles) {
      const tmuxSession = getTmuxSessionName(sessionName, role);
      spawnSync('tmux', ['kill-session', '-t', tmuxSession], {
        stdio: 'ignore',
        env: process.env,
      });
    }
  } catch (error) {
    console.error('Failed to terminate session terminal sessions:', error);
  }
}

export async function prepareSessionWorktree(
  repoPath: string,
  baseBranch: string
): Promise<{ success: boolean; sessionName?: string; worktreePath?: string; branchName?: string; error?: string }> {
  try {
    const { v4: uuidv4 } = await import('uuid');
    const shortUuid = uuidv4().split('-')[0];

    const date = new Date();
    const timestamp = date.toISOString().replace(/[-:]/g, '').slice(0, 8) + '-' + date.getHours().toString().padStart(2, '0') + date.getMinutes().toString().padStart(2, '0');
    const sessionName = `${timestamp}-${shortUuid}`;

    const branchName = `viba/${sessionName}`;

    const repoName = path.basename(repoPath);
    const parentDir = path.dirname(repoPath);

    const vibaDir = path.join(parentDir, '.viba', repoName);
    const worktreePath = path.join(vibaDir, sessionName);

    await fs.mkdir(vibaDir, { recursive: true });

    const git = simpleGit(repoPath);

    await git.raw(['worktree', 'add', '-b', branchName, worktreePath, baseBranch]);

    return {
      success: true,
      sessionName,
      worktreePath,
      branchName
    };
  } catch (e: any) {
    console.error("Failed to create worktree:", e);
    return { success: false, error: e.message || String(e) };
  }
}

export async function removeWorktree(repoPath: string, worktreePath: string, branchName: string): Promise<{ success: boolean; error?: string }> {
  try {
    const git = simpleGit(repoPath);

    try {
      await git.raw(['worktree', 'remove', '--force', worktreePath]);
    } catch (e: any) {
      const errorMsg = e.message || String(e);
      if (errorMsg.includes('is not a working tree') || errorMsg.includes('not a valid path')) {
        console.warn(`Path ${worktreePath} is not a valid working tree according to git, continuing cleanup...`);
      } else {
        console.error(`Git worktree remove failed, but continuing with cleanup: ${errorMsg}`);
      }

      // Try to prune in case of stale worktree metadata
      try {
        await git.raw(['worktree', 'prune']);
      } catch {
        // ignore prune errors
      }
    }

    try {
      await git.deleteLocalBranch(branchName, true);
    } catch (e: any) {
      console.warn(`Failed to delete branch ${branchName}: ${e.message || e}`);
    }

    try {
      await fs.rm(worktreePath, { recursive: true, force: true });
    } catch {
      // ignore
    }

    try {
      const attachmentsDir = `${worktreePath}-attachments`;
      await fs.rm(attachmentsDir, { recursive: true, force: true });
    } catch {
      // ignore
    }

    return { success: true };
  } catch (e: any) {
    console.error("Failed to cleanup worktree (critical error):", e);
    // Even on critical error, return success: true if we want the session to be considered "deleted"
    // so the metadata can be removed.
    return { success: true };
  }
}

export async function getStartupScript(repoPath: string): Promise<string> {
  try {
    const files = await fs.readdir(repoPath);
    if (files.includes('package-lock.json')) return 'npm install';
    if (files.includes('pnpm-lock.yaml')) return 'pnpm install';
    if (files.includes('yarn.lock')) return 'yarn install';
    return '';
  } catch (error) {
    console.error('Error determining startup script:', error);
    return '';
  }
}

export async function getDefaultDevServerScript(repoPath: string): Promise<string> {
  try {
    const packageJsonPath = path.join(repoPath, 'package.json');
    const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent) as { scripts?: Record<string, unknown> };
    const scripts = packageJson.scripts;

    if (!scripts || typeof scripts !== 'object') return '';
    if (typeof scripts.dev === 'string' && scripts.dev.trim()) return 'npm run dev';
    if (typeof scripts.watch === 'string' && scripts.watch.trim()) return 'npm run watch';
    if (typeof scripts.start === 'string' && scripts.start.trim()) return 'npm run start';

    return '';
  } catch (error: unknown) {
    const errorCode =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: string }).code
        : undefined;

    if (errorCode !== 'ENOENT') {
      console.error('Error determining default dev server script:', error);
    }
    return '';
  }
}

export async function listRepoFiles(repoPath: string, query: string = ''): Promise<string[]> {
  try {
    const git = simpleGit(repoPath);
    const result = await git.raw(['ls-files']);
    const allFiles = result.split('\n').filter(Boolean);

    if (!query) return allFiles.slice(0, 50);

    const lowerQuery = query.toLowerCase();
    return allFiles.filter(f => f.toLowerCase().includes(lowerQuery)).slice(0, 50);
  } catch (error) {
    console.error('Failed to list repo files:', error);
    return [];
  }
}

export async function saveAttachments(worktreePath: string, formData: FormData): Promise<string[]> {
  try {
    const attachmentsDir = `${worktreePath}-attachments`;
    await fs.mkdir(attachmentsDir, { recursive: true });

    const savedNames: string[] = [];
    const files = Array.from(formData.entries());

    for (const [, entry] of files) {
      if (entry instanceof File) {
        const buffer = Buffer.from(await entry.arrayBuffer());
        const safeName = entry.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const fullPath = path.join(attachmentsDir, safeName);
        await fs.writeFile(fullPath, buffer);
        savedNames.push(safeName);
      }
    }
    return savedNames;
  } catch (error) {
    console.error('Failed to save attachments:', error);
    return [];
  }
}
