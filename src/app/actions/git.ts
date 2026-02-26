'use server';

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import simpleGit from 'simple-git';
import { getConfig } from '@/app/actions/config';
import { getAllCredentials, getCredentialById, getCredentialToken } from '@/lib/credentials';
import type { Credential } from '@/lib/credentials';
import {
  buildTtydTerminalSrc,
  detectGitRemoteProvider,
  getTmuxSessionName,
  parseGitRemoteHost,
  TerminalSessionEnvironment,
  TerminalSessionRole,
} from '@/lib/terminal-session';

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
const AGENT_BROWSER_SKILL_NAME = 'agent-browser';
const AGENT_BROWSER_SKILL_REPO_URL = 'https://github.com/vercel-labs/agent-browser';
const AGENT_BROWSER_SKILL_SOURCE_URL = 'https://skills.sh/vercel-labs/agent-browser/agent-browser';
const AGENT_BROWSER_TARGET_AGENTS = ['codex', 'cursor', 'gemini-cli'] as const;

function normalizeAgentCli(agentCli: string): SupportedAgentCli | null {
  if (agentCli === 'gemini' || agentCli === 'codex' || agentCli === 'agent') {
    return agentCli;
  }
  return null;
}

type ProcessResult = {
  exitCode: number;
  output: string;
};

async function runProcess(
  command: string,
  args: string[],
  options?: { cwd?: string }
): Promise<ProcessResult> {
  const { spawn } = await import('child_process');
  return new Promise<ProcessResult>((resolve) => {
    const outputChunks: string[] = [];
    const child = spawn(command, args, {
      cwd: options?.cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk: Buffer) => {
      outputChunks.push(chunk.toString());
    });

    child.stderr.on('data', (chunk: Buffer) => {
      outputChunks.push(chunk.toString());
    });

    child.on('close', (code) => {
      resolve({
        exitCode: code ?? 1,
        output: outputChunks.join('').trim(),
      });
    });

    child.on('error', (error) => {
      resolve({
        exitCode: 1,
        output: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

function getCodexSkillsDirectory(): string {
  const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  return path.join(codexHome, 'skills');
}

function getGlobalAgentsSkillsDirectory(): string {
  return path.join(os.homedir(), '.agents', 'skills');
}

async function ensureAgentBrowserSkillInstalledForCodex(): Promise<void> {
  const targetSkillManifests = [
    path.join(getGlobalAgentsSkillsDirectory(), AGENT_BROWSER_SKILL_NAME, 'SKILL.md'),
    path.join(getCodexSkillsDirectory(), AGENT_BROWSER_SKILL_NAME, 'SKILL.md'),
  ];

  try {
    await Promise.any(targetSkillManifests.map(async (manifestPath) => {
      await fs.access(manifestPath);
      return manifestPath;
    }));
    return;
  } catch {
    // Install when missing.
  }

  const npxVersionResult = await runProcess('npx', ['--version']);
  if (npxVersionResult.exitCode !== 0) {
    console.warn('Skipping Codex agent-browser skill installation: npx is not available.');
    return;
  }
  const addResult = await runProcess('npx', [
    'skills',
    'add',
    AGENT_BROWSER_SKILL_REPO_URL,
    '--skill',
    AGENT_BROWSER_SKILL_NAME,
    '--agent',
    ...AGENT_BROWSER_TARGET_AGENTS,
    '-g',
    '-y',
  ]);
  if (addResult.exitCode !== 0) {
    console.warn(`Failed to install Codex agent-browser skill via npx skills add: ${addResult.output || 'unknown error'}`);
    return;
  }

  try {
    await Promise.any(targetSkillManifests.map(async (manifestPath) => {
      await fs.access(manifestPath);
      return manifestPath;
    }));
  } catch {
    console.warn(
      `Expected ${AGENT_BROWSER_SKILL_NAME}/SKILL.md in either ${getGlobalAgentsSkillsDirectory()} or ${getCodexSkillsDirectory()} after installing from ${AGENT_BROWSER_SKILL_SOURCE_URL}, but it was not found.`
    );
  }
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

    const items = await Promise.all(
      sortedEntries.map(async (entry) => {
        if (!entry.isDirectory() && !entry.isFile()) return null;

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

        return {
          name: entry.name,
          path: fullPath,
          isDirectory: entry.isDirectory(),
          isGitRepo,
        } as FileSystemItem;
      })
    );

    return items.filter((item): item is FileSystemItem => item !== null);
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
      if (normalizedCli === 'codex') {
        await ensureAgentBrowserSkillInstalledForCodex();
      }
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

type TerminalSessionSources = {
  agentTerminalSrc: string;
  floatingTerminalSrc: string;
};

function toTerminalSessionEnvironment(
  credential: Credential,
  token: string,
): TerminalSessionEnvironment {
  return credential.type === 'github'
    ? { name: 'GITHUB_TOKEN', value: token }
    : { name: 'GITLAB_TOKEN', value: token };
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

async function getPrimaryRemoteUrl(repoPath: string): Promise<string | null> {
  const git = simpleGit(repoPath);

  try {
    const originUrl = (await git.raw(['remote', 'get-url', 'origin'])).trim();
    if (originUrl) return originUrl;
  } catch {
    // Fallback to first available remote below.
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
    // Ignore and fallback to null.
  }

  return null;
}

async function resolveTerminalSessionEnvironment(repoPath: string): Promise<TerminalSessionEnvironment | null> {
  const config = await getConfig();
  const repoSettings = config.repoSettings?.[repoPath];

  if (repoSettings?.credentialId) {
    const selectedCredential = await getCredentialById(repoSettings.credentialId);
    if (selectedCredential) {
      const token = await getCredentialToken(selectedCredential.id);
      if (token) {
        return toTerminalSessionEnvironment(selectedCredential, token);
      }
    }
  }

  const remoteUrl = await getPrimaryRemoteUrl(repoPath);
  if (!remoteUrl) return null;

  const allCredentials = await getAllCredentials();
  const provider = detectGitRemoteProvider(remoteUrl, {
    gitlabHosts: allCredentials.flatMap((credential) => {
      if (credential.type !== 'gitlab') return [];
      const host = getGitLabCredentialHost(credential);
      return host ? [host] : [];
    }),
  });
  if (!provider) return null;

  const remoteHost = parseGitRemoteHost(remoteUrl);

  const credential = pickCandidateCredential(allCredentials, provider, remoteHost);

  if (!credential) return null;

  const token = await getCredentialToken(credential.id);
  if (!token) return null;

  return toTerminalSessionEnvironment(credential, token);
}

export async function getSessionTerminalSources(
  sessionName: string,
  repoPath: string,
): Promise<TerminalSessionSources> {
  const fallback: TerminalSessionSources = {
    agentTerminalSrc: buildTtydTerminalSrc(sessionName, 'agent'),
    floatingTerminalSrc: buildTtydTerminalSrc(sessionName, 'terminal'),
  };

  if (os.platform() === 'win32') {
    return fallback;
  }

  try {
    const environment = await resolveTerminalSessionEnvironment(repoPath);
    return {
      agentTerminalSrc: buildTtydTerminalSrc(sessionName, 'agent', environment),
      floatingTerminalSrc: buildTtydTerminalSrc(sessionName, 'terminal', environment),
    };
  } catch (error) {
    console.error('Failed to resolve terminal session environment:', error);
    return fallback;
  }
}

export async function startTtydProcess(): Promise<{ success: boolean; persistenceMode?: 'tmux' | 'shell'; error?: string }> {
  if (global.ttydProcess) {
    if (global.ttydPersistenceMode === 'tmux' && os.platform() !== 'win32') {
      try {
        const { spawnSync } = await import('child_process');
        // Re-apply tmux defaults for already-running instances so wheel scrollback stays available.
        spawnSync('tmux', ['set-option', '-g', 'mouse', 'on'], {
          stdio: 'ignore',
          env: process.env,
        });
      } catch (error) {
        console.error('Failed to apply tmux mouse option:', error);
      }
    }
    return { success: true, persistenceMode: global.ttydPersistenceMode || 'shell' };
  }

  try {
    const { spawn, spawnSync } = await import('child_process');

    const env: NodeJS.ProcessEnv = { ...process.env };
    // Clean up environment variables to prevent conflicts
    // Specifically remove TURBOPACK which causes "Multiple bundler flags set" error
    // when running next dev inside the terminal if the parent process has it set.
    delete (env as any).TURBOPACK;
    delete (env as any).PORT;
    delete (env as any).NODE_ENV;

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
      // Keep deep history and wheel scrollback in tmux-backed ttyd sessions.
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

export async function setTmuxSessionMouseMode(
  sessionName: string,
  role: TerminalSessionRole,
  enabled: boolean
): Promise<{ success: boolean; error?: string }> {
  if (os.platform() === 'win32') {
    return { success: true };
  }

  try {
    const { spawnSync } = await import('child_process');
    const tmuxSession = getTmuxSessionName(sessionName, role);
    const hasSessionResult = spawnSync('tmux', ['has-session', '-t', tmuxSession], {
      stdio: 'ignore',
      env: process.env,
    });

    // Session might not be created yet (e.g. hidden terminal iframe not initialized).
    // Treat this as a no-op so toggling mode remains robust.
    if (typeof hasSessionResult.status === 'number' && hasSessionResult.status !== 0) {
      return { success: true };
    }

    const result = spawnSync('tmux', ['set-option', '-t', tmuxSession, 'mouse', enabled ? 'on' : 'off'], {
      stdio: 'ignore',
      env: process.env,
    });

    if (typeof result.status === 'number' && result.status !== 0) {
      return { success: false, error: `tmux exited with status ${result.status}` };
    }

    return { success: true };
  } catch (error) {
    console.error('Failed to set tmux mouse mode:', error);
    return { success: false, error: 'Failed to set tmux mouse mode.' };
  }
}

export async function setTmuxSessionStatusVisibility(
  sessionName: string,
  role: TerminalSessionRole,
  visible: boolean
): Promise<{ success: boolean; applied: boolean; error?: string }> {
  if (os.platform() === 'win32') {
    return { success: true, applied: false };
  }

  try {
    const { spawnSync } = await import('child_process');
    const tmuxSession = getTmuxSessionName(sessionName, role);
    const hasSessionResult = spawnSync('tmux', ['has-session', '-t', tmuxSession], {
      stdio: 'ignore',
      env: process.env,
    });

    // Session might not be created yet (e.g. hidden terminal iframe not initialized).
    // Treat this as a no-op so callers can retry later.
    if (typeof hasSessionResult.status === 'number' && hasSessionResult.status !== 0) {
      return { success: true, applied: false };
    }

    const result = spawnSync('tmux', ['set-option', '-t', tmuxSession, 'status', visible ? 'on' : 'off'], {
      stdio: 'ignore',
      env: process.env,
    });

    if (typeof result.status === 'number' && result.status !== 0) {
      return { success: false, applied: false, error: `tmux exited with status ${result.status}` };
    }

    return { success: true, applied: true };
  } catch (error) {
    console.error('Failed to set tmux session status visibility:', error);
    return { success: false, applied: false, error: 'Failed to set tmux session status visibility.' };
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

    const files = Array.from(formData.entries());

    const savePromises = files.map(async ([, entry]) => {
      if (entry instanceof File) {
        const buffer = Buffer.from(await entry.arrayBuffer());
        const safeName = entry.name.replace(/[^a-zA-Z0-9._-]/g, '_');
        const fullPath = path.join(attachmentsDir, safeName);
        await fs.writeFile(fullPath, buffer);
        return safeName;
      }
      return null;
    });

    const results = await Promise.all(savePromises);
    return results.filter((name): name is string => name !== null);
  } catch (error) {
    console.error('Failed to save attachments:', error);
    return [];
  }
}
