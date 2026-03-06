'use server';

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import simpleGit from 'simple-git';
import { getErrorMessage } from '../../lib/error-utils';
import { removeWorktree, terminateSessionTerminalSessions } from './git';
import { discoverProjectGitRepos } from './project';
import { getLocalDb } from '@/lib/local-db';
import { publishSessionListUpdated } from '@/lib/sessionNotificationServer';
import type { SessionGitRepoContext, SessionWorkspaceMode } from '@/lib/types';

export type SessionMetadata = {
  sessionName: string;
  projectPath: string;
  workspacePath: string;
  workspaceMode: SessionWorkspaceMode;
  activeRepoPath?: string;
  gitRepos: SessionGitRepoContext[];
  agent: string;
  model: string;
  title?: string;
  devServerScript?: string;
  initialized?: boolean;
  timestamp: string;
  // Backward compatibility fields.
  repoPath?: string;
  worktreePath?: string;
  branchName?: string;
  baseBranch?: string;
};

export type SessionLaunchContext = {
  sessionName: string;
  title?: string;
  initialMessage?: string;
  rawInitialMessage?: string;
  startupScript?: string;
  attachmentPaths?: string[];
  attachmentNames?: string[];
  agentProvider?: string;
  model?: string;
  sessionMode?: 'fast' | 'plan';
  isResume?: boolean;
  timestamp: string;
};

export type SessionPrefillContext = {
  sourceSessionName: string;
  projectPath: string;
  title?: string;
  initialMessage?: string;
  attachmentPaths: string[];
  agentProvider: string;
  model: string;
  // Backward compatibility.
  repoPath?: string;
};

export type SessionCreateGitContextInput = {
  repoPath: string;
  baseBranch?: string;
};

type SessionRow = {
  session_name: string;
  project_path: string | null;
  workspace_path: string | null;
  workspace_mode: string | null;
  active_repo_path: string | null;
  repo_path: string | null;
  worktree_path: string | null;
  branch_name: string | null;
  base_branch: string | null;
  agent: string;
  model: string;
  title: string | null;
  dev_server_script: string | null;
  initialized: number | null;
  timestamp: string;
};

type SessionGitRepoRow = {
  session_name: string;
  source_repo_path: string;
  relative_repo_path: string;
  worktree_path: string;
  branch_name: string;
  base_branch: string | null;
};

type SessionLaunchContextRow = {
  session_name: string;
  title: string | null;
  initial_message: string | null;
  raw_initial_message: string | null;
  startup_script: string | null;
  attachment_paths_json: string | null;
  attachment_names_json: string | null;
  agent_provider: string | null;
  model: string | null;
  session_mode: string | null;
  is_resume: number | null;
  timestamp: string;
};

function parseStringArray(value: string | null): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return undefined;
  }
}

function toSessionGitRepoContext(row: SessionGitRepoRow): SessionGitRepoContext {
  return {
    sourceRepoPath: row.source_repo_path,
    relativeRepoPath: row.relative_repo_path,
    worktreePath: row.worktree_path,
    branchName: row.branch_name,
    baseBranch: row.base_branch ?? undefined,
  };
}

function normalizeSessionWorkspaceMode(value: string | null | undefined): SessionWorkspaceMode {
  if (value === 'single_worktree' || value === 'multi_repo_worktree' || value === 'folder') {
    return value;
  }
  return 'folder';
}

function toCompatibilityFields(metadata: SessionMetadata): Pick<SessionMetadata, 'repoPath' | 'worktreePath' | 'branchName' | 'baseBranch'> {
  const activeContext = metadata.gitRepos.find((context) => context.sourceRepoPath === metadata.activeRepoPath)
    || metadata.gitRepos[0];

  return {
    repoPath: activeContext?.sourceRepoPath || metadata.activeRepoPath || metadata.projectPath,
    worktreePath: activeContext?.worktreePath || metadata.workspacePath,
    branchName: activeContext?.branchName,
    baseBranch: activeContext?.baseBranch,
  };
}

async function getSessionGitRepos(sessionName: string): Promise<SessionGitRepoContext[]> {
  const db = getLocalDb();
  const rows = db.prepare(`
    SELECT
      session_name, source_repo_path, relative_repo_path, worktree_path, branch_name, base_branch
    FROM session_git_repos
    WHERE session_name = ?
    ORDER BY source_repo_path ASC
  `).all(sessionName) as SessionGitRepoRow[];

  return rows.map(toSessionGitRepoContext);
}

async function rowToSessionMetadata(row: SessionRow): Promise<SessionMetadata> {
  const projectPath = row.project_path?.trim() || row.repo_path?.trim() || '';
  const workspacePath = row.workspace_path?.trim() || row.worktree_path?.trim() || projectPath;
  const gitRepos = await getSessionGitRepos(row.session_name);

  const fallbackRepo = row.repo_path?.trim();
  const fallbackWorktree = row.worktree_path?.trim();
  const fallbackBranch = row.branch_name?.trim();
  const fallbackBase = row.base_branch?.trim() || undefined;

  if (gitRepos.length === 0 && fallbackRepo && fallbackWorktree && fallbackBranch) {
    gitRepos.push({
      sourceRepoPath: fallbackRepo,
      relativeRepoPath: projectPath ? (path.relative(projectPath, fallbackRepo) === '.' ? '' : path.relative(projectPath, fallbackRepo)) : '',
      worktreePath: fallbackWorktree,
      branchName: fallbackBranch,
      baseBranch: fallbackBase,
    });
  }

  const metadata: SessionMetadata = {
    sessionName: row.session_name,
    projectPath,
    workspacePath,
    workspaceMode: normalizeSessionWorkspaceMode(row.workspace_mode),
    activeRepoPath: row.active_repo_path?.trim() || undefined,
    gitRepos,
    agent: row.agent,
    model: row.model,
    title: row.title ?? undefined,
    devServerScript: row.dev_server_script ?? undefined,
    initialized: row.initialized === null ? undefined : Boolean(row.initialized),
    timestamp: row.timestamp,
  };

  return {
    ...metadata,
    ...toCompatibilityFields(metadata),
  };
}

function rowToSessionLaunchContext(row: SessionLaunchContextRow): SessionLaunchContext {
  return {
    sessionName: row.session_name,
    title: row.title ?? undefined,
    initialMessage: row.initial_message ?? undefined,
    rawInitialMessage: row.raw_initial_message ?? undefined,
    startupScript: row.startup_script ?? undefined,
    attachmentPaths: parseStringArray(row.attachment_paths_json),
    attachmentNames: parseStringArray(row.attachment_names_json),
    agentProvider: row.agent_provider ?? undefined,
    model: row.model ?? undefined,
    sessionMode: row.session_mode === 'plan' ? 'plan' : (row.session_mode === 'fast' ? 'fast' : undefined),
    isResume: row.is_resume === null ? undefined : Boolean(row.is_resume),
    timestamp: row.timestamp,
  };
}

function normalizePath(value: string): string {
  return path.resolve(value.trim());
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const normalizedParent = normalizePath(parentPath);
  const normalizedCandidate = normalizePath(candidatePath);
  if (normalizedParent === normalizedCandidate) return true;
  const relativePath = path.relative(normalizedParent, normalizedCandidate);
  return relativePath !== '' && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function hasOverlappingRepoRoots(repoPaths: string[]): boolean {
  const normalized = Array.from(new Set(repoPaths.map((repoPath) => normalizePath(repoPath)))).sort((a, b) => a.localeCompare(b));
  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      if (isPathInside(normalized[i], normalized[j])) {
        return true;
      }
    }
  }
  return false;
}

function buildSessionName(): string {
  const date = new Date();
  const timestamp = date.toISOString().replace(/[-:]/g, '').slice(0, 8)
    + '-'
    + date.getHours().toString().padStart(2, '0')
    + date.getMinutes().toString().padStart(2, '0');
  const nonce = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${nonce}`;
}

function slugifyProjectPath(projectPath: string): string {
  const baseName = path.basename(projectPath).toLowerCase();
  const safeBaseName = baseName.replace(/[^a-z0-9._-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  if (safeBaseName) return safeBaseName;
  return createHash('sha1').update(projectPath).digest('hex').slice(0, 12);
}

function buildSessionBranchName(sessionName: string, repoPath: string): string {
  const repoHash = createHash('sha1').update(repoPath).digest('hex').slice(0, 8);
  return `palx/${sessionName}/${repoHash}`;
}

async function resolveDefaultBaseBranch(repoPath: string): Promise<string> {
  const git = simpleGit(repoPath);
  const branches = await git.branchLocal();
  if (branches.current?.trim()) return branches.current.trim();
  if (branches.all.includes('main')) return 'main';
  if (branches.all.includes('master')) return 'master';
  if (branches.all.length > 0) return branches.all[0];
  return 'main';
}

async function copyProjectWithoutGitRepos(
  projectPath: string,
  workspacePath: string,
  gitRepoPaths: string[],
): Promise<void> {
  const normalizedProjectPath = normalizePath(projectPath);
  const excludedRoots = gitRepoPaths.map((repoPath) => normalizePath(repoPath));

  await fs.cp(normalizedProjectPath, workspacePath, {
    recursive: true,
    force: false,
    errorOnExist: false,
    filter: (sourcePath) => {
      const normalizedSourcePath = normalizePath(sourcePath);
      if (normalizedSourcePath === normalizedProjectPath) return true;
      for (const excludedRoot of excludedRoots) {
        if (normalizedSourcePath === excludedRoot) return false;
        if (isPathInside(excludedRoot, normalizedSourcePath)) return false;
      }
      return true;
    },
  });
}

function getSessionRootPath(projectPath: string, sessionName: string): string {
  const projectSlug = slugifyProjectPath(projectPath);
  return path.join(os.homedir(), '.viba', 'projects', projectSlug, sessionName);
}

function normalizeGitContextInput(
  projectPath: string,
  discoveredRepoPaths: string[],
  requestedContexts: SessionCreateGitContextInput[],
): SessionCreateGitContextInput[] {
  const requestedMap = new Map<string, SessionCreateGitContextInput>();
  for (const context of requestedContexts) {
    const normalizedRepoPath = context.repoPath?.trim();
    if (!normalizedRepoPath) continue;
    requestedMap.set(normalizePath(normalizedRepoPath), {
      repoPath: normalizePath(normalizedRepoPath),
      baseBranch: context.baseBranch?.trim() || undefined,
    });
  }

  return discoveredRepoPaths.map((repoPath) => {
    const normalizedRepoPath = normalizePath(repoPath);
    const requested = requestedMap.get(normalizedRepoPath);
    return {
      repoPath: normalizedRepoPath,
      baseBranch: requested?.baseBranch,
    };
  });
}

async function createSingleRepoSession(
  projectPath: string,
  sessionName: string,
  context: SessionCreateGitContextInput,
): Promise<{ workspacePath: string; gitRepos: SessionGitRepoContext[]; activeRepoPath: string }> {
  const sessionRootPath = getSessionRootPath(projectPath, sessionName);
  const workspacePath = path.join(sessionRootPath, 'workspace');
  await fs.mkdir(path.dirname(workspacePath), { recursive: true });

  const baseBranch = context.baseBranch || await resolveDefaultBaseBranch(context.repoPath);
  const branchName = buildSessionBranchName(sessionName, context.repoPath);
  const git = simpleGit(context.repoPath);
  await git.raw(['worktree', 'add', '-b', branchName, workspacePath, baseBranch]);

  const relativeRepoPath = path.relative(projectPath, context.repoPath);

  return {
    workspacePath,
    activeRepoPath: context.repoPath,
    gitRepos: [{
      sourceRepoPath: context.repoPath,
      relativeRepoPath: relativeRepoPath === '.' ? '' : relativeRepoPath,
      worktreePath: workspacePath,
      branchName,
      baseBranch,
    }],
  };
}

async function createMultiRepoSession(
  projectPath: string,
  sessionName: string,
  contexts: SessionCreateGitContextInput[],
): Promise<{ workspacePath: string; gitRepos: SessionGitRepoContext[]; activeRepoPath: string }> {
  const sessionRootPath = getSessionRootPath(projectPath, sessionName);
  const workspacePath = path.join(sessionRootPath, 'workspace');
  await fs.mkdir(workspacePath, { recursive: true });

  const sourceRepoPaths = contexts.map((context) => context.repoPath);
  await copyProjectWithoutGitRepos(projectPath, workspacePath, sourceRepoPaths);

  const gitRepos: SessionGitRepoContext[] = [];

  for (const context of contexts) {
    const relativeRepoPath = path.relative(projectPath, context.repoPath);
    const normalizedRelativeRepoPath = relativeRepoPath === '.' ? '' : relativeRepoPath;
    const targetWorktreePath = path.join(workspacePath, normalizedRelativeRepoPath);

    await fs.mkdir(path.dirname(targetWorktreePath), { recursive: true });

    const baseBranch = context.baseBranch || await resolveDefaultBaseBranch(context.repoPath);
    const branchName = buildSessionBranchName(sessionName, context.repoPath);
    const git = simpleGit(context.repoPath);
    await git.raw(['worktree', 'add', '-b', branchName, targetWorktreePath, baseBranch]);

    gitRepos.push({
      sourceRepoPath: context.repoPath,
      relativeRepoPath: normalizedRelativeRepoPath,
      worktreePath: targetWorktreePath,
      branchName,
      baseBranch,
    });
  }

  return {
    workspacePath,
    activeRepoPath: contexts[0]?.repoPath || '',
    gitRepos,
  };
}

async function getSessionPromptsDir(): Promise<string> {
  const promptsDir = path.join(os.homedir(), '.viba', 'session-prompts');
  await fs.mkdir(promptsDir, { recursive: true });
  return promptsDir;
}

export async function saveSessionMetadata(metadata: SessionMetadata): Promise<void> {
  const db = getLocalDb();
  const compatibility = toCompatibilityFields(metadata);

  const transaction = db.transaction((nextMetadata: SessionMetadata) => {
    db.prepare(`
      INSERT OR REPLACE INTO sessions (
        session_name, project_path, workspace_path, workspace_mode, active_repo_path,
        repo_path, worktree_path, branch_name, base_branch,
        agent, model, title, dev_server_script, initialized, timestamp
      ) VALUES (
        @sessionName, @projectPath, @workspacePath, @workspaceMode, @activeRepoPath,
        @repoPath, @worktreePath, @branchName, @baseBranch,
        @agent, @model, @title, @devServerScript, @initialized, @timestamp
      )
    `).run({
      sessionName: nextMetadata.sessionName,
      projectPath: nextMetadata.projectPath,
      workspacePath: nextMetadata.workspacePath,
      workspaceMode: nextMetadata.workspaceMode,
      activeRepoPath: nextMetadata.activeRepoPath ?? null,
      repoPath: compatibility.repoPath ?? null,
      worktreePath: compatibility.worktreePath ?? null,
      branchName: compatibility.branchName ?? null,
      baseBranch: compatibility.baseBranch ?? null,
      agent: nextMetadata.agent,
      model: nextMetadata.model,
      title: nextMetadata.title ?? null,
      devServerScript: nextMetadata.devServerScript ?? null,
      initialized: nextMetadata.initialized === undefined ? null : Number(nextMetadata.initialized),
      timestamp: nextMetadata.timestamp,
    });

    db.prepare(`DELETE FROM session_git_repos WHERE session_name = ?`).run(nextMetadata.sessionName);
    const insertGitRepo = db.prepare(`
      INSERT INTO session_git_repos (
        session_name, source_repo_path, relative_repo_path, worktree_path, branch_name, base_branch
      ) VALUES (
        @sessionName, @sourceRepoPath, @relativeRepoPath, @worktreePath, @branchName, @baseBranch
      )
    `);

    for (const gitRepo of nextMetadata.gitRepos) {
      insertGitRepo.run({
        sessionName: nextMetadata.sessionName,
        sourceRepoPath: gitRepo.sourceRepoPath,
        relativeRepoPath: gitRepo.relativeRepoPath,
        worktreePath: gitRepo.worktreePath,
        branchName: gitRepo.branchName,
        baseBranch: gitRepo.baseBranch ?? null,
      });
    }
  });

  transaction(metadata);
}

export async function writeSessionPromptFile(
  sessionName: string,
  prompt: string
): Promise<{ success: boolean; filePath?: string; error?: string }> {
  try {
    const promptsDir = await getSessionPromptsDir();
    const filePath = path.join(promptsDir, `${sessionName}.txt`);
    await fs.writeFile(filePath, prompt, 'utf-8');
    return { success: true, filePath };
  } catch (e: unknown) {
    console.error('Failed to write session prompt file:', e);
    return { success: false, error: getErrorMessage(e) };
  }
}

export async function saveSessionLaunchContext(
  sessionName: string,
  context: Omit<SessionLaunchContext, 'sessionName' | 'timestamp'>
): Promise<{ success: boolean; error?: string }> {
  try {
    const contextData: SessionLaunchContext = {
      sessionName,
      ...context,
      timestamp: new Date().toISOString(),
    };
    const db = getLocalDb();
    db.prepare(`
      INSERT OR REPLACE INTO session_launch_contexts (
        session_name, title, initial_message, raw_initial_message, startup_script,
        attachment_paths_json, attachment_names_json, agent_provider, model,
        session_mode, is_resume, timestamp
      ) VALUES (
        @sessionName, @title, @initialMessage, @rawInitialMessage, @startupScript,
        @attachmentPathsJson, @attachmentNamesJson, @agentProvider, @model,
        @sessionMode, @isResume, @timestamp
      )
    `).run({
      sessionName: contextData.sessionName,
      title: contextData.title ?? null,
      initialMessage: contextData.initialMessage ?? null,
      rawInitialMessage: contextData.rawInitialMessage ?? null,
      startupScript: contextData.startupScript ?? null,
      attachmentPathsJson: contextData.attachmentPaths ? JSON.stringify(contextData.attachmentPaths) : null,
      attachmentNamesJson: contextData.attachmentNames ? JSON.stringify(contextData.attachmentNames) : null,
      agentProvider: contextData.agentProvider ?? null,
      model: contextData.model ?? null,
      sessionMode: contextData.sessionMode ?? null,
      isResume: contextData.isResume === undefined ? null : Number(contextData.isResume),
      timestamp: contextData.timestamp,
    });
    return { success: true };
  } catch (e: unknown) {
    console.error('Failed to save session launch context:', e);
    return { success: false, error: getErrorMessage(e) };
  }
}

export async function consumeSessionLaunchContext(
  sessionName: string
): Promise<{ success: boolean; context?: SessionLaunchContext; error?: string }> {
  try {
    const db = getLocalDb();
    const row = db.prepare(`
      SELECT
        session_name, title, initial_message, raw_initial_message, startup_script,
        attachment_paths_json, attachment_names_json, agent_provider, model,
        session_mode, is_resume, timestamp
      FROM session_launch_contexts
      WHERE session_name = ?
    `).get(sessionName) as SessionLaunchContextRow | undefined;
    const context = row ? rowToSessionLaunchContext(row) : undefined;
    return { success: true, context };
  } catch (e: unknown) {
    console.error('Failed to consume session launch context:', e);
    return { success: false, error: getErrorMessage(e) };
  }
}

async function getSessionLaunchContext(
  sessionName: string
): Promise<{ success: boolean; context?: SessionLaunchContext; error?: string }> {
  try {
    const db = getLocalDb();
    const row = db.prepare(`
      SELECT
        session_name, title, initial_message, raw_initial_message, startup_script,
        attachment_paths_json, attachment_names_json, agent_provider, model,
        session_mode, is_resume, timestamp
      FROM session_launch_contexts
      WHERE session_name = ?
    `).get(sessionName) as SessionLaunchContextRow | undefined;
    const context = row ? rowToSessionLaunchContext(row) : undefined;
    return { success: true, context };
  } catch (e: unknown) {
    console.error('Failed to read session launch context:', e);
    return { success: false, error: getErrorMessage(e) };
  }
}

export async function getSessionPrefillContext(
  sessionName: string
): Promise<{ success: boolean; context?: SessionPrefillContext; error?: string }> {
  const metadata = await getSessionMetadata(sessionName);
  if (!metadata) {
    return { success: false, error: 'Session metadata not found' };
  }

  const launchContextResult = await getSessionLaunchContext(sessionName);
  if (!launchContextResult.success) {
    return { success: false, error: launchContextResult.error || 'Failed to load session launch context' };
  }

  const launchContext = launchContextResult.context;
  const rawAttachmentPaths = launchContext?.attachmentPaths || [];
  const normalizedAttachmentPaths = rawAttachmentPaths
    .map((entry) => entry.trim())
    .filter(Boolean);
  const attachmentPaths = normalizedAttachmentPaths.length > 0
    ? Array.from(new Set(normalizedAttachmentPaths))
    : Array.from(
      new Set(
        (launchContext?.attachmentNames || [])
          .map((name) => name.trim())
          .filter(Boolean)
          .map((name) => path.join(`${metadata.workspacePath}-attachments`, name))
      )
    );

  const prefill: SessionPrefillContext = {
    sourceSessionName: sessionName,
    projectPath: metadata.projectPath,
    repoPath: metadata.repoPath,
    title: launchContext?.title || metadata.title,
    initialMessage: launchContext?.rawInitialMessage || launchContext?.initialMessage,
    attachmentPaths,
    agentProvider: launchContext?.agentProvider || metadata.agent,
    model: launchContext?.model || metadata.model,
  };

  return { success: true, context: prefill };
}

export async function copySessionAttachments(
  sourceSessionName: string,
  targetWorkspacePath: string,
  requestedAttachmentNames: string[]
): Promise<{ success: boolean; copiedAttachmentNames: string[]; missingAttachmentNames: string[]; error?: string }> {
  try {
    const metadata = await getSessionMetadata(sourceSessionName);
    if (!metadata) {
      return {
        success: false,
        copiedAttachmentNames: [],
        missingAttachmentNames: [],
        error: 'Source session metadata not found',
      };
    }

    const sourceAttachmentsDir = `${metadata.workspacePath}-attachments`;
    const targetAttachmentsDir = `${targetWorkspacePath}-attachments`;
    await fs.mkdir(targetAttachmentsDir, { recursive: true });

    const copiedAttachmentNames: string[] = [];
    const missingAttachmentNames: string[] = [];
    const dedupedRequestedNames = Array.from(
      new Set(requestedAttachmentNames.map((name) => name.trim()).filter(Boolean))
    );

    for (const name of dedupedRequestedNames) {
      const safeName = name.replace(/[^a-zA-Z0-9._-]/g, '_');
      const sourcePath = path.join(sourceAttachmentsDir, safeName);
      const targetPath = path.join(targetAttachmentsDir, safeName);

      try {
        await fs.copyFile(sourcePath, targetPath);
        copiedAttachmentNames.push(safeName);
      } catch (e: unknown) {
        const errorCode =
          typeof e === 'object' && e !== null && 'code' in e
            ? (e as { code?: string }).code
            : undefined;

        if (errorCode === 'ENOENT') {
          missingAttachmentNames.push(name);
          continue;
        }

        throw e;
      }
    }

    return { success: true, copiedAttachmentNames, missingAttachmentNames };
  } catch (e: unknown) {
    console.error('Failed to copy session attachments:', e);
    return {
      success: false,
      copiedAttachmentNames: [],
      missingAttachmentNames: [],
      error: getErrorMessage(e),
    };
  }
}

export async function getSessionMetadata(sessionName: string): Promise<SessionMetadata | null> {
  try {
    const db = getLocalDb();
    const row = db.prepare(`
      SELECT
        session_name, project_path, workspace_path, workspace_mode, active_repo_path,
        repo_path, worktree_path, branch_name, base_branch,
        agent, model, title, dev_server_script, initialized, timestamp
      FROM sessions
      WHERE session_name = ?
    `).get(sessionName) as SessionRow | undefined;

    if (!row) return null;
    return await rowToSessionMetadata(row);
  } catch {
    return null;
  }
}

export async function listSessions(projectPath?: string): Promise<SessionMetadata[]> {
  try {
    const db = getLocalDb();
    const query = projectPath
      ? `
        SELECT
          session_name, project_path, workspace_path, workspace_mode, active_repo_path,
          repo_path, worktree_path, branch_name, base_branch,
          agent, model, title, dev_server_script, initialized, timestamp
        FROM sessions
        WHERE project_path = ?
        ORDER BY timestamp DESC
      `
      : `
        SELECT
          session_name, project_path, workspace_path, workspace_mode, active_repo_path,
          repo_path, worktree_path, branch_name, base_branch,
          agent, model, title, dev_server_script, initialized, timestamp
        FROM sessions
        ORDER BY timestamp DESC
      `;

    const rows = projectPath
      ? (db.prepare(query).all(projectPath) as SessionRow[])
      : (db.prepare(query).all() as SessionRow[]);

    return Promise.all(rows.map((row) => rowToSessionMetadata(row)));
  } catch (error) {
    console.error('Failed to list sessions:', error);
    return [];
  }
}

export async function createSession(
  projectPath: string,
  gitContextsOrBaseBranch: string | SessionCreateGitContextInput[],
  metadata: { agent: string; model: string; title?: string; devServerScript?: string }
): Promise<{
  success: boolean;
  sessionName?: string;
  workspacePath?: string;
  workspaceMode?: SessionWorkspaceMode;
  activeRepoPath?: string;
  gitRepos?: SessionGitRepoContext[];
  branchName?: string;
  worktreePath?: string;
  error?: string;
}> {
  try {
    const normalizedProjectPath = normalizePath(projectPath);
    const projectStats = await fs.stat(normalizedProjectPath);
    if (!projectStats.isDirectory()) {
      return { success: false, error: 'Project path must be a directory.' };
    }

    const discovery = await discoverProjectGitRepos(normalizedProjectPath);
    const discoveredRepoPaths = discovery.repos.map((repo) => repo.repoPath);
    const hasOverlap = hasOverlappingRepoRoots(discoveredRepoPaths);

    const requestedContexts = typeof gitContextsOrBaseBranch === 'string'
      ? [{ repoPath: normalizedProjectPath, baseBranch: gitContextsOrBaseBranch }]
      : gitContextsOrBaseBranch;

    const normalizedContexts = normalizeGitContextInput(normalizedProjectPath, discoveredRepoPaths, requestedContexts);
    const sessionName = buildSessionName();

    let workspaceMode: SessionWorkspaceMode = 'folder';
    let workspacePath = normalizedProjectPath;
    let activeRepoPath: string | undefined;
    let gitRepos: SessionGitRepoContext[] = [];

    if (discoveredRepoPaths.length === 1 && !hasOverlap) {
      workspaceMode = 'single_worktree';
      const singleResult = await createSingleRepoSession(
        normalizedProjectPath,
        sessionName,
        normalizedContexts[0] ?? { repoPath: discoveredRepoPaths[0] },
      );
      workspacePath = singleResult.workspacePath;
      activeRepoPath = singleResult.activeRepoPath;
      gitRepos = singleResult.gitRepos;
    } else if (discoveredRepoPaths.length > 1 && !hasOverlap) {
      workspaceMode = 'multi_repo_worktree';
      const multiResult = await createMultiRepoSession(
        normalizedProjectPath,
        sessionName,
        normalizedContexts,
      );
      workspacePath = multiResult.workspacePath;
      activeRepoPath = multiResult.activeRepoPath;
      gitRepos = multiResult.gitRepos;
    } else {
      workspaceMode = 'folder';
      workspacePath = normalizedProjectPath;
      activeRepoPath = undefined;
      gitRepos = [];
    }

    const sessionData: SessionMetadata = {
      sessionName,
      projectPath: normalizedProjectPath,
      workspacePath,
      workspaceMode,
      activeRepoPath,
      gitRepos,
      agent: metadata.agent,
      model: metadata.model,
      title: metadata.title,
      devServerScript: metadata.devServerScript,
      initialized: false,
      timestamp: new Date().toISOString(),
    };

    await saveSessionMetadata(sessionData);
    try {
      await publishSessionListUpdated();
    } catch (notificationError) {
      console.warn('Failed to publish session list update after create:', notificationError);
    }

    const compatibility = toCompatibilityFields(sessionData);
    return {
      success: true,
      sessionName,
      workspacePath,
      workspaceMode,
      activeRepoPath,
      gitRepos,
      branchName: compatibility.branchName,
      worktreePath: compatibility.worktreePath,
    };
  } catch (e: unknown) {
    console.error('Failed to create session:', e);
    return { success: false, error: getErrorMessage(e) };
  }
}

export async function markSessionInitialized(sessionName: string): Promise<void> {
  const metadata = await getSessionMetadata(sessionName);
  if (!metadata) return;
  if (metadata.initialized) return;

  metadata.initialized = true;
  await saveSessionMetadata(metadata);
}

async function cleanupSessionWorkspace(metadata: SessionMetadata): Promise<void> {
  if (metadata.workspaceMode === 'folder') return;

  const sessionRootPath = path.dirname(metadata.workspacePath);
  if (sessionRootPath && sessionRootPath.startsWith(path.join(os.homedir(), '.viba', 'projects'))) {
    try {
      await fs.rm(sessionRootPath, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors.
    }
  }
}

export async function deleteSession(sessionName: string): Promise<{ success: boolean; error?: string }> {
  try {
    const metadata = await getSessionMetadata(sessionName);
    if (!metadata) {
      return { success: false, error: 'Session metadata not found' };
    }

    if (metadata.workspaceMode === 'single_worktree' || metadata.workspaceMode === 'multi_repo_worktree') {
      for (const gitRepo of metadata.gitRepos) {
        await removeWorktree(gitRepo.sourceRepoPath, gitRepo.worktreePath, gitRepo.branchName);
      }
    }

    await terminateSessionTerminalSessions(sessionName);
    await cleanupSessionWorkspace(metadata);

    const db = getLocalDb();
    db.prepare(`DELETE FROM sessions WHERE session_name = ?`).run(sessionName);
    db.prepare(`DELETE FROM session_git_repos WHERE session_name = ?`).run(sessionName);
    db.prepare(`DELETE FROM session_launch_contexts WHERE session_name = ?`).run(sessionName);

    const promptsDir = await getSessionPromptsDir();
    const promptFilePath = path.join(promptsDir, `${sessionName}.txt`);
    await fs.rm(promptFilePath, { force: true });

    try {
      await publishSessionListUpdated();
    } catch (notificationError) {
      console.warn('Failed to publish session list update after delete:', notificationError);
    }

    return { success: true };
  } catch (e: unknown) {
    console.error('Failed to delete session:', e);
    return { success: false, error: getErrorMessage(e) };
  }
}

export async function deleteSessionInBackground(sessionName: string): Promise<{ success: boolean; error?: string }> {
  try {
    const metadata = await getSessionMetadata(sessionName);
    if (!metadata) {
      return { success: false, error: 'Session metadata not found' };
    }

    void deleteSession(sessionName).catch((error) => {
      console.error(`Background cleanup of session ${sessionName} failed:`, error);
    });

    return { success: true };
  } catch (e: unknown) {
    console.error('Failed to schedule background session deletion:', e);
    return { success: false, error: getErrorMessage(e) };
  }
}

async function resolveSessionGitTarget(
  sessionName: string,
  sourceRepoPath?: string,
): Promise<{ metadata: SessionMetadata; gitRepo: SessionGitRepoContext } | { error: string }> {
  const metadata = await getSessionMetadata(sessionName);
  if (!metadata) {
    return { error: 'Session metadata not found' };
  }

  if (metadata.workspaceMode === 'folder' || metadata.gitRepos.length === 0) {
    return { error: 'This session is in folder mode and has no Git context.' };
  }

  const normalizedRequestedRepoPath = sourceRepoPath?.trim();
  const gitRepo = normalizedRequestedRepoPath
    ? metadata.gitRepos.find((repo) => repo.sourceRepoPath === normalizedRequestedRepoPath)
    : metadata.gitRepos.find((repo) => repo.sourceRepoPath === metadata.activeRepoPath) || metadata.gitRepos[0];

  if (!gitRepo) {
    return { error: 'Requested repository context was not found for this session.' };
  }

  return { metadata, gitRepo };
}

async function updateSessionGitRepoBaseBranch(
  sessionName: string,
  sourceRepoPath: string,
  baseBranch: string,
): Promise<void> {
  const db = getLocalDb();
  db.prepare(`
    UPDATE session_git_repos
    SET base_branch = ?
    WHERE session_name = ? AND source_repo_path = ?
  `).run(baseBranch, sessionName, sourceRepoPath);
}

export async function updateSessionActiveRepo(
  sessionName: string,
  activeRepoPath: string,
): Promise<{ success: boolean; activeRepoPath?: string; error?: string }> {
  try {
    const metadata = await getSessionMetadata(sessionName);
    if (!metadata) {
      return { success: false, error: 'Session metadata not found' };
    }

    if (metadata.workspaceMode === 'folder') {
      return { success: false, error: 'This session is in folder mode.' };
    }

    if (!metadata.gitRepos.some((gitRepo) => gitRepo.sourceRepoPath === activeRepoPath)) {
      return { success: false, error: 'Repository is not part of this session.' };
    }

    metadata.activeRepoPath = activeRepoPath;
    await saveSessionMetadata(metadata);

    return { success: true, activeRepoPath };
  } catch (e: unknown) {
    console.error('Failed to update active repo:', e);
    return { success: false, error: getErrorMessage(e) };
  }
}

export async function mergeSessionToBase(
  sessionName: string,
  sourceRepoPath?: string,
): Promise<{ success: boolean; branchName?: string; baseBranch?: string; error?: string }> {
  try {
    const target = await resolveSessionGitTarget(sessionName, sourceRepoPath);
    if ('error' in target) {
      return { success: false, error: target.error };
    }

    const { gitRepo } = target;
    const baseBranch = gitRepo.baseBranch?.trim();
    if (!baseBranch) {
      return { success: false, error: 'Base branch is missing for the selected repository context.' };
    }

    const worktreeGit = simpleGit(gitRepo.worktreePath);
    const worktreeStatus = await worktreeGit.status();
    if (!worktreeStatus.isClean()) {
      return { success: false, error: 'Worktree has uncommitted changes. Commit your changes first.' };
    }

    const git = simpleGit(gitRepo.sourceRepoPath);
    const branchSummary = await git.branchLocal();
    if (!branchSummary.all.includes(baseBranch)) {
      return { success: false, error: `Base branch "${baseBranch}" not found in repository.` };
    }
    if (!branchSummary.all.includes(gitRepo.branchName)) {
      return { success: false, error: `Session branch "${gitRepo.branchName}" not found in repository.` };
    }

    const originalBranch = branchSummary.current;
    if (originalBranch !== baseBranch) {
      await git.checkout(baseBranch);
    }

    await git.merge(['--no-ff', gitRepo.branchName]);

    if (originalBranch && originalBranch !== baseBranch) {
      await git.checkout(originalBranch);
    }

    return {
      success: true,
      branchName: gitRepo.branchName,
      baseBranch,
    };
  } catch (e: unknown) {
    console.error('Failed to merge session branch:', e);
    return { success: false, error: getErrorMessage(e) };
  }
}

export async function rebaseSessionOntoBase(
  sessionName: string,
  sourceRepoPath?: string,
): Promise<{ success: boolean; branchName?: string; baseBranch?: string; error?: string }> {
  try {
    const target = await resolveSessionGitTarget(sessionName, sourceRepoPath);
    if ('error' in target) {
      return { success: false, error: target.error };
    }

    const { gitRepo } = target;
    const baseBranch = gitRepo.baseBranch?.trim();
    if (!baseBranch) {
      return { success: false, error: 'Base branch is missing for the selected repository context.' };
    }

    const worktreeGit = simpleGit(gitRepo.worktreePath);
    const worktreeStatus = await worktreeGit.status();
    if (!worktreeStatus.isClean()) {
      return { success: false, error: 'Worktree has uncommitted changes. Commit your changes first.' };
    }

    const repoGit = simpleGit(gitRepo.sourceRepoPath);
    const branchSummary = await repoGit.branchLocal();
    if (!branchSummary.all.includes(baseBranch)) {
      return { success: false, error: `Base branch "${baseBranch}" not found in repository.` };
    }
    if (!branchSummary.all.includes(gitRepo.branchName)) {
      return { success: false, error: `Session branch "${gitRepo.branchName}" not found in repository.` };
    }

    const worktreeBranchSummary = await worktreeGit.branchLocal();
    if (worktreeBranchSummary.current !== gitRepo.branchName) {
      await worktreeGit.checkout(gitRepo.branchName);
    }

    await worktreeGit.rebase([baseBranch]);

    return {
      success: true,
      branchName: gitRepo.branchName,
      baseBranch,
    };
  } catch (e: unknown) {
    console.error('Failed to rebase session branch:', e);
    return { success: false, error: getErrorMessage(e) };
  }
}

export async function getSessionUncommittedFileCount(
  sessionName: string,
  sourceRepoPath?: string,
): Promise<{ success: boolean; count?: number; error?: string }> {
  try {
    const target = await resolveSessionGitTarget(sessionName, sourceRepoPath);
    if ('error' in target) {
      return { success: false, error: target.error };
    }

    const git = simpleGit(target.gitRepo.worktreePath);
    const status = await git.status();

    return { success: true, count: status.files.length };
  } catch (e: unknown) {
    console.error('Failed to get uncommitted file count:', e);
    return { success: false, error: getErrorMessage(e) };
  }
}

export async function getSessionDivergence(
  sessionName: string,
  sourceRepoPath?: string,
): Promise<{ success: boolean; ahead?: number; behind?: number; error?: string }> {
  try {
    const target = await resolveSessionGitTarget(sessionName, sourceRepoPath);
    if ('error' in target) {
      return { success: false, error: target.error };
    }

    const { gitRepo } = target;
    const baseBranch = gitRepo.baseBranch?.trim();
    if (!baseBranch) {
      return { success: false, error: 'Base branch is unavailable for this session.' };
    }

    const git = simpleGit(gitRepo.sourceRepoPath);
    const branchSummary = await git.branchLocal();
    if (!branchSummary.all.includes(baseBranch)) {
      return { success: false, error: `Base branch "${baseBranch}" not found in repository.` };
    }
    if (!branchSummary.all.includes(gitRepo.branchName)) {
      return { success: false, error: `Session branch "${gitRepo.branchName}" not found in repository.` };
    }

    const rawCounts = await git.raw(['rev-list', '--left-right', '--count', `${baseBranch}...${gitRepo.branchName}`]);
    const [behindRaw, aheadRaw] = rawCounts.trim().split(/\s+/);
    const behind = Number.parseInt(behindRaw, 10);
    const ahead = Number.parseInt(aheadRaw, 10);

    if (Number.isNaN(behind) || Number.isNaN(ahead)) {
      return { success: false, error: 'Failed to parse git divergence output.' };
    }

    return { success: true, ahead, behind };
  } catch (e: unknown) {
    console.error('Failed to get session divergence:', e);
    return { success: false, error: getErrorMessage(e) };
  }
}

export async function listSessionBaseBranches(
  sessionName: string,
  sourceRepoPath?: string,
): Promise<{ success: boolean; baseBranch?: string; branches?: string[]; mainWorktreeBranch?: string; error?: string }> {
  try {
    const target = await resolveSessionGitTarget(sessionName, sourceRepoPath);
    if ('error' in target) {
      return { success: false, error: target.error };
    }

    const { gitRepo } = target;
    const git = simpleGit(gitRepo.sourceRepoPath);
    const branchSummary = await git.branchLocal();
    const branches = [...branchSummary.all].sort((a, b) => a.localeCompare(b));
    const baseBranch = gitRepo.baseBranch?.trim();
    const mainWorktreeBranch = branchSummary.current?.trim() || undefined;

    return { success: true, baseBranch, branches, mainWorktreeBranch };
  } catch (e: unknown) {
    console.error('Failed to list session base branches:', e);
    return { success: false, error: getErrorMessage(e) };
  }
}

export async function createSessionBaseBranch(
  sessionName: string,
  branchName: string,
  fromBranch: string,
  sourceRepoPath?: string,
): Promise<{ success: boolean; branchName?: string; fromBranch?: string; error?: string }> {
  try {
    const target = await resolveSessionGitTarget(sessionName, sourceRepoPath);
    if ('error' in target) {
      return { success: false, error: target.error };
    }

    const { gitRepo } = target;
    const nextBranchName = branchName.trim();
    if (!nextBranchName) {
      return { success: false, error: 'Branch name cannot be empty.' };
    }

    const nextFromBranch = fromBranch.trim();
    if (!nextFromBranch) {
      return { success: false, error: 'Base branch cannot be empty.' };
    }

    const git = simpleGit(gitRepo.sourceRepoPath);

    try {
      await git.raw(['check-ref-format', '--branch', nextBranchName]);
    } catch {
      return { success: false, error: `Invalid branch name: "${nextBranchName}".` };
    }

    const branchSummary = await git.branchLocal();
    if (!branchSummary.all.includes(nextFromBranch)) {
      return { success: false, error: `Base branch "${nextFromBranch}" not found in repository.` };
    }
    if (branchSummary.all.includes(nextBranchName)) {
      return { success: false, error: `Branch "${nextBranchName}" already exists.` };
    }

    await git.raw(['branch', nextBranchName, nextFromBranch]);

    return {
      success: true,
      branchName: nextBranchName,
      fromBranch: nextFromBranch,
    };
  } catch (e: unknown) {
    console.error('Failed to create session base branch:', e);
    return { success: false, error: getErrorMessage(e) };
  }
}

export async function updateSessionBaseBranch(
  sessionName: string,
  baseBranch: string,
  sourceRepoPath?: string,
): Promise<{ success: boolean; baseBranch?: string; error?: string }> {
  try {
    const target = await resolveSessionGitTarget(sessionName, sourceRepoPath);
    if ('error' in target) {
      return { success: false, error: target.error };
    }

    const { gitRepo } = target;
    const nextBaseBranch = baseBranch.trim();
    if (!nextBaseBranch) {
      return { success: false, error: 'Base branch cannot be empty.' };
    }

    const git = simpleGit(gitRepo.sourceRepoPath);
    const branchSummary = await git.branchLocal();
    if (!branchSummary.all.includes(nextBaseBranch)) {
      return { success: false, error: `Base branch "${nextBaseBranch}" not found in repository.` };
    }

    await updateSessionGitRepoBaseBranch(sessionName, gitRepo.sourceRepoPath, nextBaseBranch);

    const metadata = await getSessionMetadata(sessionName);
    if (metadata) {
      metadata.gitRepos = metadata.gitRepos.map((context) => (
        context.sourceRepoPath === gitRepo.sourceRepoPath
          ? { ...context, baseBranch: nextBaseBranch }
          : context
      ));
      await saveSessionMetadata(metadata);
    }

    return { success: true, baseBranch: nextBaseBranch };
  } catch (e: unknown) {
    console.error('Failed to update session base branch:', e);
    return { success: false, error: getErrorMessage(e) };
  }
}
