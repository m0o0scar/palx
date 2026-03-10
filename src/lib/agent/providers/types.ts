import type {
  AgentChatInput,
  AgentProvider,
  AppStatus,
  ChatStreamEvent,
  LoginStartResponse,
  ProviderCatalogEntry,
  SessionAgentTurnDiagnosticUpdate,
  ThreadHistoryResponse,
} from '@/lib/agent/types';

export type InstallLogEvent = {
  stream: 'stdout' | 'stderr';
  text: string;
};

export type AgentRuntimeUpdate = {
  runtimePid: number | null;
};

export type AgentAdapter = {
  provider: AgentProvider;
  metadata: ProviderCatalogEntry;
  getStatus(): Promise<AppStatus>;
  ensureInstalled(onEvent: (event: InstallLogEvent) => void): Promise<AppStatus>;
  startLogin(): Promise<LoginStartResponse>;
  readThreadHistory(input: {
    threadId: string;
    workspacePath: string;
    model?: string | null;
    reasoningEffort?: AgentChatInput['reasoningEffort'];
  }): Promise<ThreadHistoryResponse>;
  streamChat(
    input: AgentChatInput,
    onEvent: (event: ChatStreamEvent) => void,
    signal?: AbortSignal,
    onDiagnostic?: (update: SessionAgentTurnDiagnosticUpdate) => void,
    onRuntimeUpdate?: (update: AgentRuntimeUpdate) => void,
  ): Promise<void>;
};
