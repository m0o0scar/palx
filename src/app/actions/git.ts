'use server';

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import simpleGit from 'simple-git';
import { getGitRepoCredential } from '@/app/actions/config';
import { getAgentApiCredentialSecret } from '@/lib/agent-api-credentials';
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
import { listRepoEntries } from '@/lib/repo-entry-list';
import { getProjects } from '@/lib/store';

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

export type SupportedAgentCli = 'codex';

type AgentCliConfig = {
  executable: string;
  installCommand: string;
};

type ResolveRepoCardIconResult = {
  success: boolean;
  iconPath: string | null;
  error?: string;
};

const AGENT_CLI_CONFIG: Record<SupportedAgentCli, AgentCliConfig> = {
  codex: {
    executable: 'codex',
    installCommand: 'npm i -g openai/codex',
  },
};
const CODEX_SKILL_TARGET_AGENTS = ['codex'] as const;
const CODEX_SKILL_DEFINITIONS = [
  {
    name: 'agent-browser',
    repoUrl: 'https://github.com/vercel-labs/agent-browser',
    sourceUrl: 'https://skills.sh/vercel-labs/agent-browser/agent-browser',
  },
  {
    name: 'systematic-debugging',
    repoUrl: 'https://github.com/obra/superpowers',
    sourceUrl: 'https://github.com/obra/superpowers',
  },
] as const;

const TTYD_MONOCHROME_THEME = {
  background: '#22272e',
  foreground: '#adbac7',
  cursor: '#adbac7',
  selectionBackground: 'rgba(49, 109, 202, 0.35)',
  black: '#adbac7',
  red: '#adbac7',
  green: '#adbac7',
  yellow: '#adbac7',
  blue: '#adbac7',
  magenta: '#adbac7',
  cyan: '#adbac7',
  white: '#adbac7',
  brightBlack: '#adbac7',
  brightRed: '#adbac7',
  brightGreen: '#adbac7',
  brightYellow: '#adbac7',
  brightBlue: '#adbac7',
  brightMagenta: '#adbac7',
  brightCyan: '#adbac7',
  brightWhite: '#adbac7',
} as const;

const REPO_CARD_ICON_EXTENSIONS = new Set([
  '.avif',
  '.bmp',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
]);

const REPO_CARD_ICON_CANDIDATE_RELATIVE_PATHS = [
  'src/app/icon.png',
  'src/app/icon.jpg',
  'src/app/icon.jpeg',
  'src/app/icon.ico',
  'src/app/icon.svg',
  'src/app/favicon.ico',
  'app/icon.png',
  'app/icon.jpg',
  'app/icon.jpeg',
  'app/icon.ico',
  'app/icon.svg',
  'app/favicon.ico',
  'public/favicon.ico',
  'public/icon.png',
  'public/icon.jpg',
  'public/icon.jpeg',
  'public/icon.ico',
  'public/icon.svg',
  'public/logo.png',
  'public/logo.jpg',
  'public/logo.jpeg',
  'public/logo.svg',
  'public/apple-touch-icon.png',
  'favicon.ico',
  'icon.png',
  'icon.svg',
  'logo.png',
  'logo.svg',
] as const;

const REPO_CARD_MANIFEST_CANDIDATE_RELATIVE_PATHS = [
  'public/manifest.json',
  'public/manifest.webmanifest',
  'manifest.json',
  'manifest.webmanifest',
] as const;

const REPO_CARD_ICON_FALLBACK_DIRS = [
  '.',
  'public',
  'src',
  'src/app',
  'src/assets',
  'app',
  'assets',
  'static',
] as const;

const REPO_CARD_ICON_FILENAME_PATTERNS = [
  /^favicon(?:[-_.].+)?\.[a-z0-9]+$/i,
  /^icon(?:[-_.].+)?\.[a-z0-9]+$/i,
  /^logo(?:[-_.].+)?\.[a-z0-9]+$/i,
  /^apple-touch-icon(?:[-_.].+)?\.[a-z0-9]+$/i,
];

type ManifestIconEntry = {
  src?: string;
  sizes?: string;
};

type ResolvedManifestIconEntry = {
  src: string;
  size: number;
  index: number;
};

function normalizeAgentCli(agentCli: string): SupportedAgentCli | null {
  if (agentCli === 'codex') {
    return agentCli;
  }
  return null;
}

function isSupportedRepoCardIconPath(filePath: string): boolean {
  const extension = path.extname(filePath).toLowerCase();
  return REPO_CARD_ICON_EXTENSIONS.has(extension);
}

async function fileExistsAsRepoCardIcon(filePath: string): Promise<boolean> {
  if (!isSupportedRepoCardIconPath(filePath)) return false;

  try {
    const stats = await fs.stat(filePath);
    return stats.isFile();
  } catch {
    return false;
  }
}

async function pickFirstExistingRepoCardIcon(repoPath: string, relativePaths: readonly string[]): Promise<string | null> {
  for (const relativePath of relativePaths) {
    const absolutePath = path.join(repoPath, relativePath);
    if (await fileExistsAsRepoCardIcon(absolutePath)) {
      return absolutePath;
    }
  }
  return null;
}

function parseLargestManifestIconSize(icon: ManifestIconEntry): number {
  if (!icon.sizes || typeof icon.sizes !== 'string') return 0;

  return icon.sizes
    .split(/\s+/)
    .map((size) => size.trim().toLowerCase())
    .reduce((largest, size) => {
      if (!size || size === 'any') return Math.max(largest, Number.MAX_SAFE_INTEGER);
      const match = size.match(/^(\d+)x(\d+)$/);
      if (!match) return largest;

      const width = Number(match[1]);
      const height = Number(match[2]);
      if (!Number.isFinite(width) || !Number.isFinite(height)) return largest;
      return Math.max(largest, width * height);
    }, 0);
}

function parseManifestIconObjectSize(sizeKey: string): number {
  const normalizedSizeKey = sizeKey.trim().toLowerCase();
  if (!normalizedSizeKey) return 0;

  const squareMatch = normalizedSizeKey.match(/^(\d+)$/);
  if (squareMatch) {
    const edge = Number(squareMatch[1]);
    return Number.isFinite(edge) ? edge * edge : 0;
  }

  const rectMatch = normalizedSizeKey.match(/^(\d+)x(\d+)$/);
  if (!rectMatch) return 0;

  const width = Number(rectMatch[1]);
  const height = Number(rectMatch[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 0;
  return width * height;
}

function extractManifestIconEntries(parsed: unknown): ResolvedManifestIconEntry[] {
  if (!parsed || typeof parsed !== 'object' || !('icons' in parsed)) {
    return [];
  }

  const rawIcons = (parsed as { icons?: unknown }).icons;
  if (!rawIcons) return [];

  const entries: ResolvedManifestIconEntry[] = [];
  let index = 0;

  if (Array.isArray(rawIcons)) {
    for (const rawEntry of rawIcons) {
      if (
        rawEntry
        && typeof rawEntry === 'object'
        && 'src' in rawEntry
        && typeof (rawEntry as { src?: unknown }).src === 'string'
      ) {
        const iconEntry = rawEntry as ManifestIconEntry;
        const iconSource = iconEntry.src;
        if (typeof iconSource !== 'string') {
          index += 1;
          continue;
        }
        entries.push({
          src: iconSource,
          size: parseLargestManifestIconSize(iconEntry),
          index,
        });
      }
      index += 1;
    }
    return entries;
  }

  if (typeof rawIcons === 'object') {
    for (const [sizeKey, sourcePath] of Object.entries(rawIcons as Record<string, unknown>)) {
      if (typeof sourcePath !== 'string') {
        index += 1;
        continue;
      }

      entries.push({
        src: sourcePath,
        size: parseManifestIconObjectSize(sizeKey),
        index,
      });
      index += 1;
    }
  }

  return entries;
}

function normalizeManifestIconSourcePath(sourcePath: string): string {
  return sourcePath.trim().replace(/[?#].*$/, '');
}

function toManifestIconCandidatePaths(repoPath: string, manifestPath: string, sourcePath: string): string[] {
  const normalizedSourcePath = normalizeManifestIconSourcePath(sourcePath);
  if (!normalizedSourcePath) return [];
  if (/^(?:https?:)?\/\//i.test(normalizedSourcePath)) return [];
  if (/^data:/i.test(normalizedSourcePath)) return [];

  const candidates: string[] = [];
  if (normalizedSourcePath.startsWith('/')) {
    const withoutLeadingSlash = normalizedSourcePath.replace(/^\/+/, '');
    candidates.push(path.join(repoPath, 'public', withoutLeadingSlash));
    candidates.push(path.join(repoPath, withoutLeadingSlash));
  } else {
    candidates.push(path.resolve(path.dirname(manifestPath), normalizedSourcePath));
    candidates.push(path.resolve(repoPath, normalizedSourcePath));
    candidates.push(path.resolve(repoPath, 'public', normalizedSourcePath));
  }

  return Array.from(new Set(candidates));
}

async function resolveManifestRepoCardIcon(repoPath: string): Promise<string | null> {
  for (const manifestRelativePath of REPO_CARD_MANIFEST_CANDIDATE_RELATIVE_PATHS) {
    const manifestPath = path.join(repoPath, manifestRelativePath);

    let parsed: unknown;
    try {
      const manifestContent = await fs.readFile(manifestPath, 'utf-8');
      parsed = JSON.parse(manifestContent);
    } catch {
      continue;
    }

    const icons = extractManifestIconEntries(parsed);

    if (icons.length === 0) continue;

    const orderedIcons = icons
      .sort((a, b) => b.size - a.size || a.index - b.index);

    for (const icon of orderedIcons) {
      for (const candidatePath of toManifestIconCandidatePaths(repoPath, manifestPath, icon.src)) {
        if (await fileExistsAsRepoCardIcon(candidatePath)) {
          return candidatePath;
        }
      }
    }
  }

  return null;
}

async function resolveFallbackRepoCardIcon(repoPath: string): Promise<string | null> {
  for (const relativeDir of REPO_CARD_ICON_FALLBACK_DIRS) {
    const dirPath = path.resolve(repoPath, relativeDir);
    let entries: Array<import('fs').Dirent>;
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!REPO_CARD_ICON_FILENAME_PATTERNS.some((pattern) => pattern.test(entry.name))) continue;

      const candidatePath = path.join(dirPath, entry.name);
      if (await fileExistsAsRepoCardIcon(candidatePath)) {
        return candidatePath;
      }
    }
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

async function isSkillInstalled(skillName: string): Promise<boolean> {
  const targetSkillManifests = [
    path.join(getGlobalAgentsSkillsDirectory(), skillName, 'SKILL.md'),
    path.join(getCodexSkillsDirectory(), skillName, 'SKILL.md'),
  ];

  try {
    await Promise.any(targetSkillManifests.map(async (manifestPath) => {
      await fs.access(manifestPath);
      return manifestPath;
    }));
    return true;
  } catch {
    return false;
  }
}

async function ensureCodexSkillsInstalledForCodex(): Promise<void> {
  const missingSkills: typeof CODEX_SKILL_DEFINITIONS[number][] = [];
  for (const skillDefinition of CODEX_SKILL_DEFINITIONS) {
    if (!(await isSkillInstalled(skillDefinition.name))) {
      missingSkills.push(skillDefinition);
    }
  }

  if (missingSkills.length === 0) {
    return;
  }

  const npxVersionResult = await runProcess('npx', ['--version']);
  if (npxVersionResult.exitCode !== 0) {
    console.warn('Skipping Codex skill installation: npx is not available.');
    return;
  }

  for (const skillDefinition of missingSkills) {
    const addResult = await runProcess('npx', [
      'skills',
      'add',
      skillDefinition.repoUrl,
      '--skill',
      skillDefinition.name,
      '--agent',
      ...CODEX_SKILL_TARGET_AGENTS,
      '-g',
      '-y',
    ]);
    if (addResult.exitCode !== 0) {
      console.warn(`Failed to install Codex ${skillDefinition.name} skill via npx skills add: ${addResult.output || 'unknown error'}`);
      continue;
    }

    if (!(await isSkillInstalled(skillDefinition.name))) {
      console.warn(
        `Expected ${skillDefinition.name}/SKILL.md in either ${getGlobalAgentsSkillsDirectory()} or ${getCodexSkillsDirectory()} after installing from ${skillDefinition.sourceUrl}, but it was not found.`
      );
    }
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

    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn('bash', ['-lc', `command -v ${cliConfig.executable}`], { stdio: 'ignore' });
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

    const outputChunks: string[] = [];
    const exitCode = await new Promise<number>((resolve) => {
      const child = spawn('bash', ['-lc', cliConfig.installCommand], {
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
        await ensureCodexSkillsInstalledForCodex();
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

function resolveAgentCliFromSession(agentCli: string | undefined): SupportedAgentCli | null {
  if (!agentCli) return null;

  const exact = normalizeAgentCli(agentCli);
  if (exact) return exact;

  const lower = agentCli.toLowerCase();
  if (lower.includes('codex')) return 'codex';

  return null;
}

function toAgentTerminalSessionEnvironments(
  agentCli: SupportedAgentCli,
  apiKey: string,
  apiProxy: string | undefined,
): TerminalSessionEnvironment[] {
  if (agentCli !== 'codex') return [];
  return [
    { name: 'OPENAI_API_KEY', value: apiKey },
    ...(apiProxy ? [{ name: 'OPENAI_BASE_URL', value: apiProxy }] : []),
  ];
}

async function resolveGitTerminalSessionEnvironments(repoPath: string): Promise<TerminalSessionEnvironment[]> {
  const credentialId = await getGitRepoCredential(repoPath);
  if (credentialId) {
    const selectedCredential = await getCredentialById(credentialId);
    if (selectedCredential) {
      const token = await getCredentialToken(selectedCredential.id);
      if (token) {
        return [toTerminalSessionEnvironment(selectedCredential, token)];
      }
    }
  }

  const remoteUrl = await getPrimaryRemoteUrl(repoPath);
  if (!remoteUrl) return [];

  const allCredentials = await getAllCredentials();
  const provider = detectGitRemoteProvider(remoteUrl, {
    gitlabHosts: allCredentials.flatMap((credential) => {
      if (credential.type !== 'gitlab') return [];
      const host = getGitLabCredentialHost(credential);
      return host ? [host] : [];
    }),
  });
  if (!provider) return [];

  const remoteHost = parseGitRemoteHost(remoteUrl);

  const credential = pickCandidateCredential(allCredentials, provider, remoteHost);

  if (!credential) return [];

  const token = await getCredentialToken(credential.id);
  if (!token) return [];

  return [toTerminalSessionEnvironment(credential, token)];
}

async function resolveAgentApiTerminalSessionEnvironments(agentCli: string | undefined): Promise<TerminalSessionEnvironment[]> {
  const normalizedAgentCli = resolveAgentCliFromSession(agentCli);
  if (!normalizedAgentCli) return [];

  const credential = await getAgentApiCredentialSecret(normalizedAgentCli);
  if (!credential || !credential.apiKey) return [];

  return toAgentTerminalSessionEnvironments(normalizedAgentCli, credential.apiKey, credential.apiProxy);
}

export async function getSessionTerminalSources(
  sessionName: string,
  repoPath: string,
  agentCli?: string,
): Promise<TerminalSessionSources> {
  const fallback: TerminalSessionSources = {
    agentTerminalSrc: buildTtydTerminalSrc(sessionName, 'agent'),
    floatingTerminalSrc: buildTtydTerminalSrc(sessionName, 'terminal'),
  };

  try {
    const [gitEnvironments, agentEnvironments] = await Promise.all([
      resolveGitTerminalSessionEnvironments(repoPath),
      resolveAgentApiTerminalSessionEnvironments(agentCli),
    ]);
    const environments = [...gitEnvironments, ...agentEnvironments];

    return {
      agentTerminalSrc: buildTtydTerminalSrc(sessionName, 'agent', environments),
      floatingTerminalSrc: buildTtydTerminalSrc(sessionName, 'terminal', environments),
    };
  } catch (error) {
    console.error('Failed to resolve terminal session environment:', error);
    return fallback;
  }
}

export async function startTtydProcess(): Promise<{ success: boolean; persistenceMode?: 'tmux' | 'shell'; error?: string }> {
  if (global.ttydProcess) {
    if (global.ttydPersistenceMode === 'tmux') {
      try {
        const { spawnSync } = await import('child_process');
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

    // Omit variables that can cause conflicts for nested Next.js/terminal processes.
    const {
      TURBOPACK: _turbopack,
      PORT: _port,
      NODE_ENV: _nodeEnv,
      COLORTERM: _colorTerm,
      FORCE_COLOR: _forceColor,
      CLICOLOR: _cliColor,
      CLICOLOR_FORCE: _cliColorForce,
      ...env
    } = process.env;

    const workingDir = os.homedir();
    const hasTmux =
      spawnSync('which', ['tmux'], {
        stdio: 'ignore',
        env: process.env,
      }).status === 0;

    const ttydArgs = [
      '-p', '7681',
      '-t', `theme=${JSON.stringify(TTYD_MONOCHROME_THEME)}`,
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
      console.warn('tmux is unavailable; falling back to non-persistent ttyd shell mode.');
      ttydArgs.push('bash');
    }

    const child = spawn('ttyd', ttydArgs, {
      stdio: 'ignore',
      detached: false,
      cwd: workingDir,
      env: {
        ...env,
        NODE_ENV: 'development',
        TERM: 'xterm',
        NO_COLOR: '1',
        CLICOLOR: '0',
        CLICOLOR_FORCE: '0',
        FORCE_COLOR: '0',
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

export async function terminateTmuxSessionRole(
  sessionName: string,
  role: TerminalSessionRole,
): Promise<{ success: boolean; removed: boolean; error?: string }> {
  try {
    const { spawnSync } = await import('child_process');
    const tmuxExists =
      spawnSync('which', ['tmux'], {
        stdio: 'ignore',
        env: process.env,
      }).status === 0;

    if (!tmuxExists) return { success: true, removed: false };

    const tmuxSession = getTmuxSessionName(sessionName, role);
    const hasSessionResult = spawnSync('tmux', ['has-session', '-t', tmuxSession], {
      stdio: 'ignore',
      env: process.env,
    });

    if (typeof hasSessionResult.status === 'number' && hasSessionResult.status !== 0) {
      return { success: true, removed: false };
    }

    const result = spawnSync('tmux', ['kill-session', '-t', tmuxSession], {
      stdio: 'ignore',
      env: process.env,
    });

    if (typeof result.status === 'number' && result.status !== 0) {
      return { success: false, removed: false, error: `tmux exited with status ${result.status}` };
    }

    return { success: true, removed: true };
  } catch (error) {
    console.error('Failed to terminate tmux session role:', error);
    return { success: false, removed: false, error: 'Failed to terminate tmux session role.' };
  }
}

export async function terminateSessionTerminalSessions(sessionName: string): Promise<void> {
  try {
    const { spawnSync } = await import('child_process');
    const tmuxExists =
      spawnSync('which', ['tmux'], {
        stdio: 'ignore',
        env: process.env,
      }).status === 0;

    if (!tmuxExists) return;

    const prefixRole = '__viba_session_role__';
    const prefix = getTmuxSessionName(sessionName, prefixRole).replace(prefixRole, '');
    const listedSessions = spawnSync('tmux', ['list-sessions', '-F', '#S'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: process.env,
      encoding: 'utf-8',
    });

    const sessions = typeof listedSessions.stdout === 'string'
      ? listedSessions.stdout.split('\n').map((value) => value.trim()).filter(Boolean)
      : [];

    for (const tmuxSession of sessions) {
      if (!tmuxSession.startsWith(prefix)) continue;
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

    const branchName = `palx/${sessionName}`;

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
  void repoPath;
  return '';
}

export async function getDefaultDevServerScript(repoPath: string): Promise<string> {
  void repoPath;
  return '';
}

export async function resolveRepoCardIcon(repoPath: string): Promise<ResolveRepoCardIconResult> {
  if (!repoPath || !path.isAbsolute(repoPath)) {
    return { success: false, iconPath: null, error: 'Invalid project path.' };
  }

  try {
    const projects = getProjects();
    const project = projects.find((entry) => path.resolve(entry.path) === path.resolve(repoPath));
    const iconPath = project?.iconPath?.trim() || null;
    if (!iconPath) return { success: true, iconPath: null };

    const iconStats = await fs.stat(iconPath);
    if (!iconStats.isFile()) return { success: true, iconPath: null };

    return { success: true, iconPath };
  } catch (error) {
    console.error('Failed to resolve project card icon:', error);
    return { success: false, iconPath: null, error: 'Failed to resolve project icon.' };
  }
}

export async function listRepoFiles(repoPath: string, query: string = ''): Promise<string[]> {
  try {
    return await listRepoEntries(repoPath, query);
  } catch (error) {
    console.error('Failed to list project files and folders:', error);
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
