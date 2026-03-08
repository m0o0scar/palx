export type {
  AgentProvider,
  AppStatus,
  ChatStreamEvent,
  CodexAccount as AgentAccount,
  FileChange,
  HistoryEntry,
  ModelOption,
  ProviderCatalogEntry,
  ReasoningEffort,
  SessionAgentRunState,
  ThreadHistoryResponse,
  ToolTraceSource,
} from "@/lib/types";

export type AgentReasoningEffort = import("@/lib/types").AgentReasoningEffort;

export type InstallStreamEvent =
  | {
      type: "install_started";
      command: string;
    }
  | {
      type: "install_log";
      stream: "stdout" | "stderr";
      text: string;
    }
  | {
      type: "install_completed";
      status: import("@/lib/types").AppStatus;
    }
  | {
      type: "error";
      message: string;
    };

export type LoginStartResponse =
  | {
      kind: "browser";
      authUrl: string;
      loginId?: string | null;
      message?: string | null;
    }
  | {
      kind: "pending";
      loginId?: string | null;
      message: string;
    };

export type AgentChatInput = {
  workspacePath: string;
  threadId?: string | null;
  message: string;
  model?: string | null;
  reasoningEffort?: import("@/lib/types").ReasoningEffort | null;
};

export type ChatInput = AgentChatInput;

export type RuntimeSessionSnapshot = {
  sessionId: string;
  provider: import("@/lib/types").AgentProvider;
  workspacePath: string;
  threadId: string | null;
  activeTurnId?: string | null;
  model: string | null;
  reasoningEffort: import("@/lib/types").ReasoningEffort | null;
  runState: import("@/lib/types").SessionAgentRunState;
  lastError: string | null;
  lastActivityAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  eventCount?: number;
  events: import("@/lib/types").ChatStreamEvent[];
};

export type AgentRunState = import("@/lib/types").SessionAgentRunState;

export type AgentSessionSnapshot = Omit<RuntimeSessionSnapshot, "activeTurnId" | "eventCount"> & {
  activeTurnId: string | null;
  eventCount: number;
};

export type AgentSessionView = {
  snapshot: RuntimeSessionSnapshot;
  history: import("@/lib/types").HistoryEntry[];
};

export type AgentSocketMessage =
  | {
      type: "snapshot";
      session: AgentSessionView;
    }
  | {
      type: "event";
      sessionId: string;
      snapshot: RuntimeSessionSnapshot;
      event: import("@/lib/types").ChatStreamEvent;
    };

export type AgentSessionUpdate =
  | {
      type: "snapshot";
      snapshot: AgentSessionSnapshot;
    }
  | {
      type: "stream_event";
      ordinal: number;
      event: import("@/lib/types").ChatStreamEvent;
      snapshot: AgentSessionSnapshot;
    };
