'use server';

import path from 'node:path';
import { getLocalDb } from '@/lib/local-db';
import type { SessionGitRepoContext } from '@/lib/types';

export type DraftMetadata = {
  id: string;
  projectPath: string;
  gitContexts: SessionGitRepoContext[];
  message: string;
  attachmentPaths: string[];
  agentProvider: string;
  model: string;
  timestamp: string;
  title: string;
  startupScript: string;
  devServerScript: string;
  sessionMode: 'fast' | 'plan';
  // Backward compatibility fields.
  repoPath?: string;
  branchName?: string;
};

type DraftRow = {
  id: string;
  project_path: string | null;
  repo_path: string | null;
  branch_name: string | null;
  git_contexts_json: string | null;
  message: string;
  attachment_paths_json: string;
  agent_provider: string;
  model: string;
  timestamp: string;
  title: string;
  startup_script: string;
  dev_server_script: string;
  session_mode: string;
};

function parseAttachmentPaths(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
}

function parseGitContexts(
  value: string | null,
  fallbackRepoPath: string | null,
  fallbackBranchName: string | null,
): SessionGitRepoContext[] {
  if (value) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        const contexts = parsed
          .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
          .map((entry) => {
            const sourceRepoPath = typeof entry.sourceRepoPath === 'string' ? entry.sourceRepoPath.trim() : '';
            const relativeRepoPath = typeof entry.relativeRepoPath === 'string' ? entry.relativeRepoPath.trim() : '';
            const worktreePath = typeof entry.worktreePath === 'string' ? entry.worktreePath.trim() : '';
            const branchName = typeof entry.branchName === 'string' ? entry.branchName.trim() : '';
            const baseBranch = typeof entry.baseBranch === 'string' ? entry.baseBranch.trim() : undefined;
            if (!sourceRepoPath || !branchName) return null;
            return {
              sourceRepoPath,
              relativeRepoPath,
              worktreePath,
              branchName,
              baseBranch,
            } as SessionGitRepoContext;
          })
          .filter((entry): entry is SessionGitRepoContext => Boolean(entry));

        if (contexts.length > 0) {
          return contexts;
        }
      }
    } catch {
      // Ignore malformed JSON.
    }
  }

  if (fallbackRepoPath && fallbackBranchName) {
    return [{
      sourceRepoPath: fallbackRepoPath,
      relativeRepoPath: '',
      worktreePath: '',
      branchName: fallbackBranchName,
    }];
  }

  return [];
}

function rowToDraft(row: DraftRow): DraftMetadata {
  const projectPath = (row.project_path?.trim() || row.repo_path?.trim() || '');
  const gitContexts = parseGitContexts(row.git_contexts_json, row.repo_path, row.branch_name);
  const primaryContext = gitContexts[0];

  return {
    id: row.id,
    projectPath,
    gitContexts,
    message: row.message,
    attachmentPaths: parseAttachmentPaths(row.attachment_paths_json),
    agentProvider: row.agent_provider,
    model: row.model,
    timestamp: row.timestamp,
    title: row.title,
    startupScript: row.startup_script,
    devServerScript: row.dev_server_script,
    sessionMode: row.session_mode === 'plan' ? 'plan' : 'fast',
    repoPath: primaryContext?.sourceRepoPath || row.repo_path || undefined,
    branchName: primaryContext?.branchName || row.branch_name || undefined,
  };
}

function normalizeGitContexts(draft: DraftMetadata): SessionGitRepoContext[] {
  if (draft.gitContexts.length > 0) {
    return draft.gitContexts
      .map((context) => ({
        sourceRepoPath: context.sourceRepoPath.trim(),
        relativeRepoPath: context.relativeRepoPath.trim(),
        worktreePath: context.worktreePath.trim(),
        branchName: context.branchName.trim(),
        baseBranch: context.baseBranch?.trim() || undefined,
      }))
      .filter((context) => context.sourceRepoPath && context.branchName);
  }

  if (draft.repoPath?.trim() && draft.branchName?.trim()) {
    return [{
      sourceRepoPath: draft.repoPath.trim(),
      relativeRepoPath: '',
      worktreePath: '',
      branchName: draft.branchName.trim(),
    }];
  }

  return [];
}

export async function saveDraft(draft: DraftMetadata): Promise<{ success: boolean; error?: string }> {
  try {
    const db = getLocalDb();
    const safeId = path.basename(draft.id);
    const projectPath = draft.projectPath?.trim() || draft.repoPath?.trim() || '';
    if (!projectPath) {
      return { success: false, error: 'Project path is required.' };
    }

    const gitContexts = normalizeGitContexts(draft);
    const primaryContext = gitContexts[0];

    db.prepare(`
      INSERT OR REPLACE INTO drafts (
        id, project_path, repo_path, branch_name, git_contexts_json, message,
        attachment_paths_json, agent_provider, model, timestamp, title,
        startup_script, dev_server_script, session_mode
      ) VALUES (
        @id, @projectPath, @repoPath, @branchName, @gitContextsJson, @message,
        @attachmentPathsJson, @agentProvider, @model, @timestamp, @title,
        @startupScript, @devServerScript, @sessionMode
      )
    `).run({
      id: safeId,
      projectPath,
      repoPath: primaryContext?.sourceRepoPath ?? null,
      branchName: primaryContext?.branchName ?? null,
      gitContextsJson: JSON.stringify(gitContexts),
      message: draft.message,
      attachmentPathsJson: JSON.stringify(draft.attachmentPaths),
      agentProvider: draft.agentProvider,
      model: draft.model,
      timestamp: draft.timestamp,
      title: draft.title,
      startupScript: draft.startupScript,
      devServerScript: draft.devServerScript,
      sessionMode: draft.sessionMode,
    });
    return { success: true };
  } catch (e) {
    console.error('Failed to save draft:', e);
    return { success: false, error: 'Failed to save draft' };
  }
}

export async function listDrafts(projectPath?: string): Promise<DraftMetadata[]> {
  try {
    const db = getLocalDb();
    const query = projectPath
      ? `
        SELECT
          id, project_path, repo_path, branch_name, git_contexts_json, message,
          attachment_paths_json, agent_provider, model, timestamp, title,
          startup_script, dev_server_script, session_mode
        FROM drafts
        WHERE project_path = ?
        ORDER BY timestamp DESC
      `
      : `
        SELECT
          id, project_path, repo_path, branch_name, git_contexts_json, message,
          attachment_paths_json, agent_provider, model, timestamp, title,
          startup_script, dev_server_script, session_mode
        FROM drafts
        ORDER BY timestamp DESC
      `;

    const rows = projectPath
      ? (db.prepare(query).all(projectPath) as DraftRow[])
      : (db.prepare(query).all() as DraftRow[]);

    return rows.map(rowToDraft);
  } catch (e) {
    console.error('Failed to list drafts:', e);
    return [];
  }
}

export async function deleteDraft(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    const db = getLocalDb();
    const safeId = path.basename(id);
    db.prepare(`
      DELETE FROM drafts WHERE id = ?
    `).run(safeId);
    return { success: true };
  } catch (e) {
    console.error('Failed to delete draft:', e);
    return { success: false, error: 'Failed to delete draft' };
  }
}
