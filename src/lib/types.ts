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

export type AgentProvider = 'codex' | 'gemini' | 'cursor' | (string & {});

export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | (string & {});

export type AgentReasoningEffort = ReasoningEffort;

export type SessionAgentRunState =
  | 'idle'
  | 'queued'
  | 'running'
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'needs_auth'
  | (string & {});

export type ProviderCatalogEntry = {
  id: AgentProvider;
  label: string;
  description: string;
  available: boolean;
};

export type ModelOption = {
  id: string;
  label: string;
  description?: string | null;
  reasoningEfforts?: ReasoningEffort[];
};

export type CodexAccount = {
  type: string;
  email?: string | null;
  planType?: string | null;
};

export type ToolTraceSource =
  | 'mcp'
  | 'function'
  | 'custom'
  | 'dynamic'
  | 'web_search'
  | 'local_shell'
  | 'acp';

export type FileChange = {
  path: string;
  kind: string;
  diff: string;
};

export type AppStatus = {
  provider: AgentProvider;
  installed: boolean;
  version: string | null;
  loggedIn: boolean;
  account: CodexAccount | null;
  installCommand: string;
  models: ModelOption[];
  defaultModel: string | null;
};

export type HistoryEntry =
  | {
      kind: 'user';
      id: string;
      text: string;
    }
  | {
      kind: 'assistant';
      id: string;
      text: string;
      phase: string | null;
    }
  | {
      kind: 'reasoning';
      id: string;
      summary: string;
      text: string;
    }
  | {
      kind: 'command';
      id: string;
      command: string;
      cwd: string;
      output: string;
      status: string;
      exitCode: number | null;
      toolName: string | null;
      toolInput: string | null;
    }
  | {
      kind: 'tool';
      id: string;
      source: ToolTraceSource;
      server: string | null;
      tool: string;
      status: string;
      input: string | null;
      message: string | null;
      result: string | null;
      error: string | null;
    }
  | {
      kind: 'fileChange';
      id: string;
      status: string;
      output: string;
      changes: FileChange[];
    }
  | {
      kind: 'plan';
      id: string;
      text: string;
    };

export type ThreadHistoryResponse = {
  provider: AgentProvider;
  threadId: string;
  entries: HistoryEntry[];
};

export type ChatStreamEvent =
  | {
      type: 'thread_ready';
      threadId: string;
    }
  | {
      type: 'turn_started';
      turnId: string;
    }
  | {
      type: 'item_started';
      item: Record<string, unknown>;
      threadId: string;
      turnId: string;
    }
  | {
      type: 'item_completed';
      item: Record<string, unknown>;
      threadId: string;
      turnId: string;
    }
  | {
      type: 'agent_message_delta';
      itemId: string;
      delta: string;
      threadId: string;
      turnId: string;
    }
  | {
      type: 'reasoning_delta';
      itemId: string;
      delta: string;
      threadId: string;
      turnId: string;
    }
  | {
      type: 'reasoning_summary_delta';
      itemId: string;
      delta: string;
      threadId: string;
      turnId: string;
    }
  | {
      type: 'command_output_delta';
      itemId: string;
      delta: string;
      threadId: string;
      turnId: string;
    }
  | {
      type: 'command_seed';
      itemId: string;
      threadId: string;
      turnId: string;
      command: string;
      cwd: string;
      toolName: string;
      toolInput: string | null;
    }
  | {
      type: 'file_change_delta';
      itemId: string;
      delta: string;
      threadId: string;
      turnId: string;
    }
  | {
      type: 'plan_updated';
      threadId: string;
      turnId: string;
      steps: Array<{
        title: string;
        status: string;
      }>;
    }
  | {
      type: 'tool_progress';
      itemId: string;
      threadId: string;
      turnId: string;
      status: string;
      source: ToolTraceSource;
      server: string | null;
      tool: string;
      input: string | null;
      message: string | null;
      result: string | null;
      error: string | null;
    }
  | {
      type: 'turn_completed';
      threadId: string;
      turnId: string;
      status: string;
      error: string | null;
    }
  | {
      type: 'error';
      message: string;
    };

export type SessionAgentRuntimeState = {
  sessionName: string;
  agentProvider: AgentProvider;
  model: string;
  reasoningEffort?: ReasoningEffort;
  threadId?: string | null;
  activeTurnId?: string | null;
  runState?: SessionAgentRunState | null;
  lastError?: string | null;
  lastActivityAt?: string | null;
};

export type SessionAgentHistoryItem = HistoryEntry & {
  sessionName: string;
  threadId?: string | null;
  turnId?: string | null;
  ordinal: number;
  itemStatus?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SessionAgentHistoryInput = HistoryEntry & {
  threadId?: string | null;
  turnId?: string | null;
  ordinal?: number;
  itemStatus?: string | null;
  createdAt?: string;
  updatedAt?: string;
};
