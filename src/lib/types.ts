export interface Project {
  path: string;
  name: string;
  displayName?: string | null;
  iconPath?: string | null;
  lastOpenedAt?: string;
  expandedFolders?: string[];
  visibilityMap?: Record<string, 'visible' | 'hidden'>;
  localGroupExpanded?: boolean;
  remotesGroupExpanded?: boolean;
  worktreesGroupExpanded?: boolean;
}

// TODO: remove once all callers are migrated.
export type Repository = Project;

export interface GitWorktree {
  path: string;
  branch: string | null;
  head: string | null;
  isCurrent: boolean;
}

export interface AppSettings {
  defaultRootFolder: string | null;
  sidebarCollapsed?: boolean;
  historyPanelHeight?: number;
}

export interface DiffImageSide {
  mimeType: string;
  base64: string;
}

export interface DiffImage {
  left: DiffImageSide | null;
  right: DiffImageSide | null;
}

export interface FileDiffPayload {
  diff: string;
  left: string;
  right: string;
  imageDiff?: DiffImage | null;
}

export interface GitStatus {
  current: string | null;
  tracking: string | null;
  ahead: number;
  behind: number;
  conflicted: string[];
  created: string[];
  deleted: string[];
  modified: string[];
  not_added: string[];
  renamed: Array<{ from: string; to: string }>;
  staged: string[];
  files: GitFileStatus[];
}

export interface GitFileStatus {
  path: string;
  index: string;
  working_dir: string;
}

export interface Commit {
  hash: string;
  date: string;
  message: string;
  refs: string;
  body: string;
  author_name: string;
  author_email: string;
  parents: string[];
}

export interface GitLog {
  all: Commit[];
  total: number;
  latest: Commit | null;
}

export interface GitError extends Error {
  status?: number;
}

export interface BranchTrackingInfo {
  upstream: string;
  ahead: number;
  behind: number;
}

export type GitConflictOperation = 'merge' | 'rebase' | null;

export interface GitConflictState {
  operation: GitConflictOperation;
  conflictedFiles: string[];
  hasConflicts: boolean;
  canContinue: boolean;
}

export type SessionWorkspaceMode = 'single_worktree' | 'multi_repo_worktree' | 'folder';

export interface SessionGitRepoContext {
  sourceRepoPath: string;
  relativeRepoPath: string;
  worktreePath: string;
  branchName: string;
  baseBranch?: string;
}
