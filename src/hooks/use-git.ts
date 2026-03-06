import { useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { GitStatus, GitLog, Project, AppSettings, FileDiffPayload, BranchTrackingInfo, GitError, GitWorktree, GitConflictState } from '@/lib/types';
import { showGitErrorToast } from './use-toast';

const API_BASE = '/api';

export function useSettings() {
  return useQuery<AppSettings & { resolvedDefaultFolder: string }>({
    queryKey: ['settings'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/settings`);
      if (!res.ok) throw new Error('Failed to fetch settings');
      return res.json();
    },
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (updates: Partial<AppSettings>) => {
      const res = await fetch(`${API_BASE}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!res.ok) throw new Error('Failed to update settings');
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });
}

export function useProjects() {
  return useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE}/projects`);
      if (!res.ok) throw new Error('Failed to fetch projects');
      return res.json();
    },
  });
}

export function useProject(projectPath: string | null) {
  const { data: projects } = useProjects();
  return useMemo(() => 
    projects?.find(project => project.path === projectPath) || null,
  [projects, projectPath]);
}

export function useAddProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ path, name }: { path: string; name?: string }) => {
      const res = await fetch(`${API_BASE}/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, name }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to add project');
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

interface CloneProjectParams {
  repoUrl: string;
  destinationParent: string;
  folderName?: string;
  credentialId?: string | null;
}

interface CloneProjectResponse extends Project {
  usedCredentialId: string | null;
}

export function useCloneProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: CloneProjectParams): Promise<CloneProjectResponse> => {
      const res = await fetch(`${API_BASE}/projects/clone`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Failed to clone project');
      }
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ path, updates }: { path: string; updates: Partial<Project> }) => {
      const res = await fetch(`${API_BASE}/projects`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, updates }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ path, deleteLocalFolder = false }: { path: string; deleteLocalFolder?: boolean }) => {
      const res = await fetch(`${API_BASE}/projects`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, deleteLocalFolder }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

// Backward-compatible hook names while callers migrate.
export const useRepositories = useProjects;
export const useRepository = useProject;
export const useAddRepository = useAddProject;
export const useCloneRepository = useCloneProject;
export const useUpdateRepository = useUpdateProject;
export const useDeleteRepository = useDeleteProject;


export function useGitStatus(repoPath: string | null) {
  return useQuery<GitStatus>({
    queryKey: ['git', repoPath, 'status'],
    queryFn: async () => {
      if (!repoPath) return null;
      const res = await fetch(`${API_BASE}/git/status?path=${encodeURIComponent(repoPath)}`);
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const err = new Error(errorData.error || 'Failed to fetch status') as GitError;
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    enabled: !!repoPath,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: (failureCount, error: GitError) => {
      // Don't retry for 404 or 400 errors
      if (error.status === 404 || error.status === 400) return false;
      return failureCount < 3;
    },
  });
}

export function useGitConflictState(repoPath: string | null) {
  return useQuery<GitConflictState>({
    queryKey: ['git', repoPath, 'conflict-state'],
    queryFn: async () => {
      if (!repoPath) {
        return {
          operation: null,
          conflictedFiles: [],
          hasConflicts: false,
          canContinue: false,
        };
      }
      const res = await fetch(`${API_BASE}/git/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath, action: 'get-conflict-state' }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const err = new Error(errorData.error || 'Failed to fetch conflict state') as GitError;
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      return {
        operation: data.operation ?? null,
        conflictedFiles: data.conflictedFiles ?? [],
        hasConflicts: Boolean(data.hasConflicts),
        canContinue: Boolean(data.canContinue),
      };
    },
    enabled: !!repoPath,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: (failureCount, error: GitError) => {
      if (error.status === 404 || error.status === 400) return false;
      return failureCount < 3;
    },
  });
}

export interface GitConflictFileVersions {
  ours: string;
  theirs: string;
  current: string;
}

export function useGitConflictFileVersions(repoPath: string | null, filePath: string | null) {
  return useQuery<GitConflictFileVersions>({
    queryKey: ['git', repoPath, 'conflict-file-versions', filePath],
    queryFn: async () => {
      if (!repoPath || !filePath) {
        return { ours: '', theirs: '', current: '' };
      }

      const res = await fetch(`${API_BASE}/git/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoPath,
          action: 'get-conflict-file-versions',
          data: { path: filePath },
        }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const err = new Error(errorData.error || 'Failed to fetch conflict file versions') as GitError;
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      return {
        ours: typeof data.ours === 'string' ? data.ours : '',
        theirs: typeof data.theirs === 'string' ? data.theirs : '',
        current: typeof data.current === 'string' ? data.current : '',
      };
    },
    enabled: !!repoPath && !!filePath,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: (failureCount, error: GitError) => {
      if (error.status === 404 || error.status === 400) return false;
      return failureCount < 3;
    },
  });
}

export function useGitLog(
  repoPath: string | null,
  limit: number = 50,
  options: { scope?: 'all' | 'current' } = {},
) {
  const scope = options.scope ?? 'all';

  return useQuery<GitLog>({
    queryKey: ['git', repoPath, 'log', limit, scope],
    queryFn: async () => {
      if (!repoPath) return null;
      const res = await fetch(
        `${API_BASE}/git/log?path=${encodeURIComponent(repoPath)}&limit=${limit}&scope=${scope}`
      );
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const err = new Error(errorData.error || 'Failed to fetch log') as GitError;
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    enabled: !!repoPath,
    placeholderData: (previousData) => previousData,
    retry: (failureCount, error: GitError) => {
      if (error.status === 404 || error.status === 400) return false;
      return failureCount < 3;
    },
  });
}

export function useGitBranches(repoPath: string | null) {
  return useQuery<{ 
    branches: string[], 
    current: string, 
    branchCommits: Record<string, string>, 
    remotes: Record<string, string[]>,
    remoteUrls: Record<string, string>,
    trackingInfo: Record<string, BranchTrackingInfo>,
    worktrees: GitWorktree[],
  }>({
    queryKey: ['git', repoPath, 'branches'],
    queryFn: async () => {
      if (!repoPath) return null;
      const res = await fetch(`${API_BASE}/git/branches?path=${encodeURIComponent(repoPath)}`);
      if (!res.ok) {
        throw new Error('Failed to fetch branches');
      }
      return res.json();
    },
    enabled: !!repoPath,
  });
}

export function useGitMergeBase(repoPath: string | null, targetRef: string | null, sourceRef: string | null) {
  return useQuery<string | null>({
    queryKey: ['git', repoPath, 'merge-base', targetRef, sourceRef],
    queryFn: async () => {
      if (!repoPath || !targetRef || !sourceRef) return null;
      const res = await fetch(`${API_BASE}/git/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoPath,
          action: 'get-merge-base',
          data: { targetRef, sourceRef },
        }),
      });
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const err = new Error(errorData.error || 'Failed to fetch merge-base') as GitError;
        err.status = res.status;
        throw err;
      }
      const data = await res.json();
      return typeof data.mergeBase === 'string' && data.mergeBase.trim() ? data.mergeBase.trim() : null;
    },
    enabled: !!repoPath && !!targetRef && !!sourceRef,
    retry: (failureCount, error: GitError) => {
      if (error.status === 404 || error.status === 400) return false;
      return failureCount < 2;
    },
  });
}

export function useGitDiff(repoPath: string | null, filePath: string | null) {
  return useQuery<FileDiffPayload>({
    queryKey: ['git', repoPath, 'diff', filePath],
    queryFn: async () => {
      if (!repoPath || !filePath) return null;
      const res = await fetch(`${API_BASE}/git/diff?path=${encodeURIComponent(repoPath)}&file=${encodeURIComponent(filePath)}`);
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const err = new Error(errorData.error || 'Failed to fetch diff') as GitError;
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    enabled: !!repoPath && !!filePath,
    retry: (failureCount, error: GitError) => {
      if (error.status === 404 || error.status === 400) return false;
      return failureCount < 3;
    },
  });
}

export interface CommitFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface CommitDiffQuery {
  commitHash?: string | null;
  fromCommitHash?: string | null;
  toCommitHash?: string | null;
}

export function useCommitDiff(repoPath: string | null, query: CommitDiffQuery) {
  const commitHash = query.commitHash ?? null;
  const fromCommitHash = query.fromCommitHash ?? null;
  const toCommitHash = query.toCommitHash ?? null;
  const hasRange = !!fromCommitHash && !!toCommitHash;
  const hasSingleCommit = !!commitHash;

  return useQuery<{ files: CommitFile[]; diff: string }>({
    queryKey: ['git', repoPath, 'commit-diff', commitHash, fromCommitHash, toCommitHash],
    queryFn: async () => {
      if (!repoPath) return null;
      if (!hasSingleCommit && !hasRange) return null;

      const params = new URLSearchParams({ path: repoPath });
      if (hasSingleCommit) {
        params.set('commit', commitHash);
      } else if (hasRange) {
        params.set('from', fromCommitHash);
        params.set('to', toCommitHash);
      }

      const res = await fetch(`${API_BASE}/git/diff?${params.toString()}`);
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const err = new Error(errorData.error || 'Failed to fetch commit diff') as GitError;
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    enabled: !!repoPath && (hasSingleCommit || hasRange),
    retry: (failureCount, error: GitError) => {
      if (error.status === 404 || error.status === 400) return false;
      return failureCount < 3;
    },
  });
}

export function useCommitFileDiff(repoPath: string | null, filePath: string | null, query: CommitDiffQuery) {
  const commitHash = query.commitHash ?? null;
  const fromCommitHash = query.fromCommitHash ?? null;
  const toCommitHash = query.toCommitHash ?? null;
  const hasRange = !!fromCommitHash && !!toCommitHash;
  const hasSingleCommit = !!commitHash;

  return useQuery<FileDiffPayload>({
    queryKey: ['git', repoPath, 'commit-file-diff', filePath, commitHash, fromCommitHash, toCommitHash],
    queryFn: async () => {
      if (!repoPath || !filePath) return null;
      if (!hasSingleCommit && !hasRange) return null;

      const params = new URLSearchParams({
        path: repoPath,
        file: filePath,
      });
      if (hasSingleCommit) {
        params.set('commit', commitHash);
      } else if (hasRange) {
        params.set('from', fromCommitHash);
        params.set('to', toCommitHash);
      }

      const res = await fetch(`${API_BASE}/git/diff?${params.toString()}`);
      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        const err = new Error(errorData.error || 'Failed to fetch file diff') as GitError;
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
    enabled: !!repoPath && !!filePath && (hasSingleCommit || hasRange),
    retry: (failureCount, error: GitError) => {
      if (error.status === 404 || error.status === 400) return false;
      return failureCount < 3;
    },
  });
}

// Stash types
export interface GitStash {
  index: number;
  message: string;
  date: string;
  hash: string;
}

export function useGitStashes(repoPath: string | null) {
  return useQuery<GitStash[]>({
    queryKey: ['git', repoPath, 'stashes'],
    queryFn: async () => {
      if (!repoPath) return [];
      const res = await fetch(`${API_BASE}/git/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath, action: 'stash-list' }),
      });
      if (!res.ok) {
        throw new Error('Failed to fetch stashes');
      }
      const data = await res.json();
      return data.stashes || [];
    },
    enabled: !!repoPath,
  });
}

export interface StashFile {
  path: string;
  status: string;
}

export function useStashFiles(repoPath: string | null, stashIndex: number | null) {
  return useQuery<StashFile[]>({
    queryKey: ['git', repoPath, 'stash-files', stashIndex],
    queryFn: async () => {
      if (!repoPath || stashIndex === null) return [];
      const res = await fetch(`${API_BASE}/git/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath, action: 'stash-files', data: { index: stashIndex } }),
      });
      if (!res.ok) {
        throw new Error('Failed to fetch stash files');
      }
      const data = await res.json();
      return data.files || [];
    },
    enabled: !!repoPath && stashIndex !== null,
  });
}

export function useStashFileDiff(repoPath: string | null, stashIndex: number | null, filePath: string | null) {
  return useQuery<FileDiffPayload>({
    queryKey: ['git', repoPath, 'stash-file-diff', stashIndex, filePath],
    queryFn: async () => {
      if (!repoPath || stashIndex === null || !filePath) return { left: '', right: '', diff: '' };
      const res = await fetch(`${API_BASE}/git/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath, action: 'stash-file-diff', data: { index: stashIndex, file: filePath } }),
      });
      if (!res.ok) {
        throw new Error('Failed to fetch stash file diff');
      }
      return res.json();
    },
    enabled: !!repoPath && stashIndex !== null && !!filePath,
  });
}

// Actions
export type GitActionType = 'commit' | 'push' | 'pull' | 'fetch' | 'stage' | 'unstage' | 'checkout' | 'checkout-to-local' | 'branch' | 'create-tag' | 'delete-branch' | 'delete-worktree' | 'delete-remote-branch' | 'delete-remote' | 'delete-tag' | 'delete-remote-tag' | 'rename-branch' | 'rename-remote-branch' | 'rename-remote' | 'set-remote-url' | 'add-remote' | 'reset' | 'revert' | 'cherry-pick' | 'cherry-pick-multiple' | 'cherry-pick-abort' | 'rebase' | 'merge' | 'check-merge-conflicts' | 'check-rebase-conflicts' | 'get-conflict-state' | 'get-conflict-file-versions' | 'resolve-conflict-file' | 'continue-merge' | 'abort-merge' | 'continue-rebase' | 'abort-rebase' | 'get-remotes' | 'get-remote-branches' | 'get-tracking-branch' | 'get-latest-commit-message' | 'push-to-remote' | 'pull-from-remote' | 'stash' | 'stash-apply' | 'stash-drop' | 'stash-pop' | 'reword' | 'discard' | 'cleanup-lock-file';

// Map action types to human-readable operation names
const actionOperationNames: Record<GitActionType, string> = {
  'commit': 'Commit',
  'push': 'Push',
  'pull': 'Pull',
  'fetch': 'Fetch',
  'stage': 'Stage',
  'unstage': 'Unstage',
  'checkout': 'Checkout',
  'checkout-to-local': 'Checkout',
  'branch': 'Create Branch',
  'create-tag': 'Create Tag',
  'delete-branch': 'Delete Branch',
  'delete-worktree': 'Delete Worktree',
  'delete-remote-branch': 'Delete Remote Branch',
  'delete-remote': 'Delete Remote',
  'delete-tag': 'Delete Tag',
  'delete-remote-tag': 'Delete Remote Tag',
  'rename-branch': 'Rename Branch',
  'rename-remote-branch': 'Rename Remote Branch',
  'rename-remote': 'Rename Remote',
  'set-remote-url': 'Set Remote URL',
  'add-remote': 'Add Remote',
  'reset': 'Reset',
  'revert': 'Revert Commit',
  'cherry-pick': 'Cherry Pick',
  'cherry-pick-multiple': 'Cherry Pick',
  'cherry-pick-abort': 'Cherry Pick',
  'rebase': 'Rebase',
  'merge': 'Merge',
  'check-merge-conflicts': 'Check Merge Conflicts',
  'check-rebase-conflicts': 'Check Rebase Conflicts',
  'get-conflict-state': 'Get Conflict State',
  'get-conflict-file-versions': 'Get Conflict File Versions',
  'resolve-conflict-file': 'Resolve Conflict File',
  'continue-merge': 'Continue Merge',
  'abort-merge': 'Abort Merge',
  'continue-rebase': 'Continue Rebase',
  'abort-rebase': 'Abort Rebase',
  'get-remotes': 'Get Remotes',
  'get-remote-branches': 'Get Remote Branches',
  'get-tracking-branch': 'Get Tracking Branch',
  'get-latest-commit-message': 'Get Latest Commit Message',
  'push-to-remote': 'Push',
  'pull-from-remote': 'Pull',
  'stash': 'Stash',
  'stash-apply': 'Apply Stash',
  'stash-drop': 'Drop Stash',
  'stash-pop': 'Pop Stash',
  'reword': 'Reword Commit',
  'discard': 'Discard Changes',
  'cleanup-lock-file': 'Cleanup Lock File',
};

const READ_ONLY_ACTIONS: readonly GitActionType[] = [
  'check-merge-conflicts',
  'check-rebase-conflicts',
  'get-conflict-state',
  'get-conflict-file-versions',
  'get-remotes',
  'get-remote-branches',
  'get-tracking-branch',
  'get-latest-commit-message'
];

interface GitActionPayload {
  repoPath: string;
  action: GitActionType;
  data?: any;
  suppressErrorToast?: boolean;
}

async function cleanupLockFile(repoPath: string) {
  const res = await fetch(`${API_BASE}/git/action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoPath, action: 'cleanup-lock-file' }),
  });
  if (!res.ok) {
    throw new Error('Failed to cleanup lock file');
  }
  return res.json();
}

export function useGitAction() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ repoPath, action, data }: GitActionPayload) => {
      const res = await fetch(`${API_BASE}/git/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repoPath, action, data }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to execute action');
      }
      return res.json();
    },
    onSuccess: (_, variables) => {
      // Don't invalidate for read-only actions
      if (!READ_ONLY_ACTIONS.includes(variables.action)) {
        // Invalidate relevant queries
        queryClient.invalidateQueries({ queryKey: ['git', variables.repoPath] });
      }
    },
    onError: (error: Error, variables) => {
      // Show error toast for git operations (except read-only actions)
      if (!READ_ONLY_ACTIONS.includes(variables.action) && !variables.suppressErrorToast) {
        const operationName = actionOperationNames[variables.action] || variables.action;

        // Check for lock file error
        if (error.message.includes('Unable to create') && error.message.includes('.git/index.lock')) {
          showGitErrorToast(error, {
            operation: operationName,
            fixLabel: 'Remove Lock File',
            onFix: async () => {
              await cleanupLockFile(variables.repoPath);
              // Invalidate queries to refresh status
              queryClient.invalidateQueries({ queryKey: ['git', variables.repoPath] });
            }
          });
        } else {
          showGitErrorToast(error, { operation: operationName });
        }
      }
    },
  });
}
