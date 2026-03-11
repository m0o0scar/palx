import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

import type {
  AgentAccount,
  AgentReasoningEffort,
  AppStatus,
  ChatStreamEvent,
  FileChange,
  HistoryEntry,
  ModelOption,
  SessionAgentTurnDiagnosticUpdate,
  ThreadHistoryResponse,
  ToolTraceSource,
} from "@/lib/agent/types";
import { normalizeProviderReasoningEffort } from "@/lib/agent/reasoning";
import {
  createDeferred,
  defaultSpawnEnv,
  normalizeText,
  readCommandOutput,
  resolveExecutable,
  stringifyCompact,
} from "@/lib/agent/common";
import { buildCodexAppServerEnv } from "@/lib/agent/spawn-env";
import type { AgentRuntimeUpdate } from "@/lib/agent/providers/types";

type JsonRpcMessage = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
};

type ThreadItem =
  | {
      type: "userMessage";
      id: string;
      content: Array<{ type: "text"; text: string }>;
    }
  | {
      type: "agentMessage";
      id: string;
      text: string;
      phase: string | null;
    }
  | {
      type: "reasoning";
      id: string;
      summary: string[];
      content: string[];
    }
  | {
      type: "commandExecution";
      id: string;
      command: string;
      cwd: string;
      aggregatedOutput: string | null;
      status: string;
      exitCode: number | null;
    }
  | {
      type: "fileChange";
      id: string;
      changes: FileChange[];
      status: string;
    }
  | {
      type: "mcpToolCall";
      id: string;
      server: string;
      tool: string;
      status: string;
      arguments: unknown;
      result: unknown;
      error: unknown;
    }
  | {
      type: "dynamicToolCall";
      id: string;
      tool: string;
      arguments: unknown;
      status: string;
      contentItems: unknown;
      success: boolean | null;
    }
  | {
      type: "webSearch";
      id: string;
      query: string;
      action: unknown;
    }
  | {
      type: "plan";
      id: string;
      text: string;
    };

type RawResponseItem =
  | {
      type: "function_call";
      name: string;
      arguments: string;
      call_id: string;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: unknown;
    }
  | {
      type: "custom_tool_call";
      status?: string;
      call_id: string;
      name: string;
      input: string;
    }
  | {
      type: "custom_tool_call_output";
      call_id: string;
      output: unknown;
    }
  | {
      type: "web_search_call";
      status?: string;
      action?: {
        type?: string;
        query?: string;
        queries?: string[];
        url?: string;
        pattern?: string;
      };
    }
  | {
      type: "local_shell_call";
      call_id: string | null;
      status: string;
      action?: {
        type?: string;
        command?: string[];
        working_directory?: string | null;
      };
    }
  | {
      type: string;
      [key: string]: unknown;
    };

type ThreadTurn = {
  items?: ThreadItem[];
};

type ThreadSummary = {
  id: string;
  turns?: ThreadTurn[];
};

const CLIENT_INFO = {
  name: "palx",
  version: "0.66.0",
};
const SESSION_CODEX_SANDBOX_MODE = "danger-full-access";

// Palx requires web search in Codex sessions. The Codex API rejects
// reasoning.effort="minimal" when web_search is enabled, so do not expose it.
const GPT5_REASONING: AgentReasoningEffort[] = ["low", "medium", "high"];
const CODEX_REASONING: AgentReasoningEffort[] = ["low", "medium", "high", "xhigh"];
const O3_REASONING: AgentReasoningEffort[] = ["low", "medium", "high"];

const CODEX_MODEL_OPTIONS: ModelOption[] = [
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    description: "Balanced frontier GPT-5 model.",
    reasoningEfforts: GPT5_REASONING,
  },
  {
    id: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    description: "Agentic coding model tuned for code tasks.",
    reasoningEfforts: CODEX_REASONING,
  },
  {
    id: "gpt-5.2-codex",
    label: "GPT-5.2 Codex",
    description: "Earlier Codex-tuned GPT-5 model.",
    reasoningEfforts: CODEX_REASONING,
  },
  {
    id: "gpt-5.1-codex-max",
    label: "GPT-5.1 Codex Max",
    description: "High-capability Codex variant.",
    reasoningEfforts: CODEX_REASONING,
  },
  {
    id: "gpt-5",
    label: "GPT-5",
    description: "General GPT-5 model.",
    reasoningEfforts: GPT5_REASONING,
  },
  {
    id: "o3",
    label: "o3",
    description: "Reasoning-focused model.",
    reasoningEfforts: O3_REASONING,
  },
];

let activeInstall: Promise<void> | null = null;
let activeLoginSession: CodexLoginSession | null = null;

function installCommandParts() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  return [npmCommand, ["install", "-g", "@openai/codex@latest"]] as const;
}

function resolveCodexExecutable(env: NodeJS.ProcessEnv) {
  return resolveExecutable(["codex", "codex.cmd"], env);
}

export function getInstallCommandString() {
  const [command, args] = installCommandParts();
  return [command, ...args].join(" ");
}

async function readCodexConfiguredModel() {
  try {
    const config = await readFile(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
    const match = config.match(/^\s*model\s*=\s*"([^"\n]+)"/m);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}

function codexModelOptions(configuredModel: string | null) {
  if (!configuredModel || CODEX_MODEL_OPTIONS.some((model) => model.id === configuredModel)) {
    return CODEX_MODEL_OPTIONS;
  }

  return [
    {
      id: configuredModel,
      label: configuredModel,
      description: "Configured locally in ~/.codex/config.toml.",
      reasoningEfforts: undefined,
    },
    ...CODEX_MODEL_OPTIONS,
  ];
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function parseExecCommandSeed(value: string, workspacePath: string) {
  const parsed = parseJsonRecord(value);
  if (!parsed) {
    return null;
  }

  const command = normalizeText(parsed.cmd);
  if (!command) {
    return null;
  }

  return {
    command,
    cwd: normalizeText(parsed.workdir) || workspacePath,
    toolInput: stringifyCompact(parsed),
  };
}

function parseLocalShellSeed(
  item: Extract<RawResponseItem, { type: "local_shell_call" }>,
  workspacePath: string,
) {
  const action = item.action;
  if (!action || action.type !== "exec" || !Array.isArray(action.command)) {
    return null;
  }

  return {
    command: action.command.filter((part) => typeof part === "string").join(" "),
    cwd: normalizeText(action.working_directory) || workspacePath,
    toolInput: stringifyCompact(action),
  };
}

function normalizeToolEvent(
  event: Omit<Extract<ChatStreamEvent, { type: "tool_progress" }>, "type">,
): ChatStreamEvent {
  return {
    type: "tool_progress",
    ...event,
  };
}

function normalizeToolProgressMessage(params: Record<string, unknown>) {
  if (typeof params.message === "string") {
    return params.message;
  }

  if (typeof params.statusMessage === "string") {
    return params.statusMessage;
  }

  return null;
}

class CodexAppServerConnection {
  private child: ChildProcessWithoutNullStreams;
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    }
  >();
  private notificationListener: ((message: JsonRpcMessage) => void) | null = null;
  private stderrListener: ((text: string) => void) | null = null;

  constructor(
    private readonly workspacePath: string,
    options: {
      model?: string | null;
      reasoningEffort?: AgentReasoningEffort | null;
      extraEnv?: Record<string, string> | null;
    } = {},
  ) {
    const env = buildCodexAppServerEnv(options.extraEnv);
    const codexExecutable = resolveCodexExecutable(env);
    const effectiveReasoningEffort = normalizeProviderReasoningEffort(
      "codex",
      options.reasoningEffort,
    ) as AgentReasoningEffort | undefined;
    const args = [
      "-c",
      'approval_policy="never"',
      "-c",
      `sandbox_mode=${JSON.stringify(SESSION_CODEX_SANDBOX_MODE)}`,
    ];

    if (options.model?.trim()) {
      args.push("-c", `model=${JSON.stringify(options.model.trim())}`);
    }
    if (effectiveReasoningEffort) {
      args.push(
        "-c",
        `model_reasoning_effort=${JSON.stringify(effectiveReasoningEffort)}`,
      );
    }
    args.push("app-server");

    this.child = spawn(codexExecutable, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.workspacePath,
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => this.consumeStdout(chunk));
    this.child.stderr.on("data", (chunk) => {
      this.stderrListener?.(chunk.toString());
    });
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("close", () => {
      if (!this.closed) {
        this.failAll(new Error("Codex app-server closed unexpectedly."));
      }
    });
  }

  onNotification(listener: (message: JsonRpcMessage) => void) {
    this.notificationListener = listener;
  }

  onStderr(listener: (text: string) => void) {
    this.stderrListener = listener;
  }

  async initialize() {
    await this.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: {
        experimentalApi: true,
      },
    });
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    const id = this.nextId++;
    const deferred = createDeferred<T>();

    this.pending.set(id, {
      resolve: deferred.resolve as (value: unknown) => void,
      reject: deferred.reject,
    });

    this.child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      "utf8",
    );

    return await deferred.promise;
  }

  close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.pending.clear();
    if (this.child.exitCode !== null || this.child.killed) {
      return;
    }

    this.child.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      if (this.child.exitCode === null && !this.child.killed) {
        this.child.kill('SIGKILL');
      }
    }, 2000);
    killTimer.unref();
    this.child.once('close', () => {
      clearTimeout(killTimer);
    });
  }

  getRuntimePid() {
    return this.child.pid ?? null;
  }

  private consumeStdout(chunk: string) {
    this.buffer += chunk;

    for (;;) {
      const lineBreak = this.buffer.indexOf("\n");
      if (lineBreak === -1) {
        return;
      }

      const line = this.buffer.slice(0, lineBreak).trim();
      this.buffer = this.buffer.slice(lineBreak + 1);

      if (!line) {
        continue;
      }

      let message: JsonRpcMessage;

      try {
        message = JSON.parse(line) as JsonRpcMessage;
      } catch {
        continue;
      }

      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);

        if (message.error) {
          pending?.reject(new Error(message.error.message || "Codex request failed."));
        } else {
          pending?.resolve(message.result);
        }

        continue;
      }

      if (typeof message.id === "number" && message.method) {
        this.child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32000,
              message: "Interactive server requests are not supported by Palx.",
            },
          })}\n`,
          "utf8",
        );
      }

      this.notificationListener?.(message);
    }
  }

  private failAll(error: unknown) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }

    this.pending.clear();
  }
}

class CodexLoginSession {
  private connection = new CodexAppServerConnection(process.cwd());
  private completed = false;
  private expiresAt = Date.now() + 10 * 60 * 1000;
  private completion = createDeferred<void>();
  private loginId: string | null = null;
  private authUrl: string | null = null;
  private timeout: NodeJS.Timeout | null = null;

  async start() {
    await this.connection.initialize();
    this.connection.onNotification((message) => {
      if (message.method !== "account/login/completed" || !message.params) {
        return;
      }

      const success = Boolean(message.params.success);
      const error =
        normalizeText(message.params.error) || "Codex login did not complete successfully.";
      this.completed = true;
      this.cleanup();

      if (success) {
        this.completion.resolve();
      } else {
        this.completion.reject(new Error(error));
      }
    });

    const result = (await this.connection.request("account/login/start", {
      type: "chatgpt",
    })) as {
      type?: string;
      authUrl?: string;
      loginId?: string;
    };

    if (result.type !== "chatgpt" || !result.authUrl) {
      this.cleanup();
      throw new Error("Codex did not return a ChatGPT login URL.");
    }

    this.authUrl = result.authUrl;
    this.loginId = result.loginId ?? null;
    this.timeout = setTimeout(() => {
      if (!this.completed) {
        this.cleanup();
        this.completion.reject(new Error("Codex login timed out."));
      }
    }, Math.max(1, this.expiresAt - Date.now()));

    return {
      authUrl: this.authUrl,
      loginId: this.loginId,
    };
  }

  isActive() {
    return !this.completed && Date.now() < this.expiresAt && Boolean(this.authUrl);
  }

  getActiveState() {
    return {
      authUrl: this.authUrl ?? "",
      loginId: this.loginId,
    };
  }

  async waitForCompletion() {
    return await this.completion.promise;
  }

  private cleanup() {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }

    this.connection.close();

    if (activeLoginSession === this) {
      activeLoginSession = null;
    }
  }
}

async function withConnection<T>(
  workspacePath: string,
  work: (connection: CodexAppServerConnection) => Promise<T>,
) {
  const connection = new CodexAppServerConnection(workspacePath);

  try {
    await connection.initialize();
    return await work(connection);
  } finally {
    connection.close();
  }
}

async function readAccount() {
  return await withConnection(process.cwd(), async (connection) => {
    const result = (await connection.request("account/read", {})) as {
      account?: AgentAccount | null;
    };

    return result.account ?? null;
  });
}

export async function isCodexInstalled() {
  const env = defaultSpawnEnv();
  const codexExecutable = resolveCodexExecutable(env);
  try {
    const result = await readCommandOutput(codexExecutable, ["--version"], env);
    if (result.exitCode !== 0) {
      return { installed: false, version: null };
    }

    return {
      installed: true,
      version: normalizeText(result.stdout || result.stderr) || null,
    };
  } catch {
    return { installed: false, version: null };
  }
}

export async function getAppStatus(): Promise<AppStatus> {
  const installCommand = getInstallCommandString();
  const installProbe = await isCodexInstalled();
  const configuredModel = await readCodexConfiguredModel();
  const models = codexModelOptions(configuredModel);
  const defaultModel = configuredModel || models[0]?.id || null;

  if (!installProbe.installed) {
    return {
      provider: "codex",
      installed: false,
      version: null,
      loggedIn: false,
      account: null,
      installCommand,
      models,
      defaultModel,
    };
  }

  try {
    const account = await readAccount();
    return {
      provider: "codex",
      installed: true,
      version: installProbe.version,
      loggedIn: account !== null,
      account,
      installCommand,
      models,
      defaultModel,
    };
  } catch {
    const env = defaultSpawnEnv();
    const loginStatus = await readCommandOutput(resolveCodexExecutable(env), ["login", "status"], env);
    return {
      provider: "codex",
      installed: true,
      version: installProbe.version,
      loggedIn: loginStatus.exitCode === 0,
      account: null,
      installCommand,
      models,
      defaultModel,
    };
  }
}

export async function ensureCodexInstalled(
  onEvent: (event: { stream: "stdout" | "stderr"; text: string }) => void,
) {
  if (activeInstall) {
    throw new Error("Codex installation is already in progress.");
  }

  const currentStatus = await isCodexInstalled();
  if (currentStatus.installed) {
    return await getAppStatus();
  }

  const [command, args] = installCommandParts();
  const env = defaultSpawnEnv();

  activeInstall = new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      onEvent({ stream: "stdout", text: chunk.toString() });
    });
    child.stderr.on("data", (chunk) => {
      onEvent({ stream: "stderr", text: chunk.toString() });
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve();
      } else {
        reject(new Error(`Install command exited with code ${exitCode ?? "unknown"}.`));
      }
    });
  });

  try {
    await activeInstall;
  } finally {
    activeInstall = null;
  }

  return await getAppStatus();
}

export async function startLogin() {
  if (activeLoginSession?.isActive()) {
    return activeLoginSession.getActiveState();
  }

  const session = new CodexLoginSession();
  activeLoginSession = session;
  try {
    const started = await session.start();
    session.waitForCompletion().catch(() => {});
    return started;
  } catch (error) {
    if (activeLoginSession === session) {
      activeLoginSession = null;
    }
    throw error;
  }
}

function normalizeHistory(thread: ThreadSummary): HistoryEntry[] {
  const entries: HistoryEntry[] = [];

  for (const turn of thread.turns ?? []) {
    for (const item of turn.items ?? []) {
      switch (item.type) {
        case "userMessage": {
          const text = item.content
            .filter((content) => content.type === "text")
            .map((content) => content.text)
            .join("\n");
          entries.push({ kind: "user", id: item.id, text });
          break;
        }
        case "agentMessage":
          entries.push({
            kind: "assistant",
            id: item.id,
            text: item.text,
            phase: item.phase,
          });
          break;
        case "reasoning": {
          const summary = item.summary.join("\n").trim();
          const text = item.content.join("\n").trim();
          if (!summary && !text) {
            break;
          }
          entries.push({
            kind: "reasoning",
            id: item.id,
            summary,
            text,
          });
          break;
        }
        case "commandExecution":
          entries.push({
            kind: "command",
            id: item.id,
            command: item.command,
            cwd: item.cwd,
            output: item.aggregatedOutput ?? "",
            status: item.status,
            exitCode: item.exitCode,
            toolName: null,
            toolInput: null,
          });
          break;
        case "fileChange":
          entries.push({
            kind: "fileChange",
            id: item.id,
            status: item.status,
            output: "",
            changes: item.changes,
          });
          break;
        case "mcpToolCall":
          entries.push({
            kind: "tool",
            id: item.id,
            source: "mcp",
            server: item.server,
            tool: item.tool,
            status: item.status,
            input: stringifyCompact(item.arguments),
            message: null,
            result: stringifyCompact(item.result),
            error: stringifyCompact(item.error),
          });
          break;
        case "dynamicToolCall":
          entries.push({
            kind: "tool",
            id: item.id,
            source: "dynamic",
            server: null,
            tool: item.tool,
            status: item.status,
            input: stringifyCompact(item.arguments),
            message: null,
            result: stringifyCompact(item.contentItems),
            error: item.success === false && item.contentItems == null ? "Tool call failed." : null,
          });
          break;
        case "webSearch":
          entries.push({
            kind: "tool",
            id: item.id,
            source: "web_search",
            server: null,
            tool: "web_search",
            status: "completed",
            input: item.query,
            message: stringifyCompact(item.action),
            result: null,
            error: null,
          });
          break;
        case "plan":
          entries.push({
            kind: "plan",
            id: item.id,
            text: item.text,
          });
          break;
      }
    }
  }

  return entries;
}

export async function readThreadHistory(input: {
  workspacePath: string;
  threadId: string;
}): Promise<ThreadHistoryResponse> {
  return await withConnection(input.workspacePath, async (connection) => {
    const result = (await connection.request("thread/resume", {
      threadId: input.threadId,
      cwd: input.workspacePath,
      approvalPolicy: "never",
      sandbox: SESSION_CODEX_SANDBOX_MODE,
      persistExtendedHistory: true,
    })) as {
      thread?: ThreadSummary;
    };

    const thread = result.thread;
    if (!thread) {
      throw new Error(`Thread ${input.threadId} could not be resumed.`);
    }

    return {
      provider: "codex",
      threadId: thread.id,
      entries: normalizeHistory(thread),
    };
  });
}

export async function streamChat(
  input: {
    workspacePath: string;
    threadId?: string | null;
    message: string;
    model?: string | null;
    reasoningEffort?: AgentReasoningEffort | null;
    extraEnv?: Record<string, string> | null;
  },
  onEvent: (event: ChatStreamEvent) => void,
  signal?: AbortSignal,
  onDiagnostic?: (update: SessionAgentTurnDiagnosticUpdate) => void,
  onRuntimeUpdate?: (update: AgentRuntimeUpdate) => void,
) {
  const emitDiagnostic = (update: SessionAgentTurnDiagnosticUpdate) => {
    onDiagnostic?.(update);
  };
  const failDiagnosticStep = (key: string, label: string, error: unknown) => {
    emitDiagnostic({
      key,
      label,
      status: "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  };
  const runDiagnosticStep = async <T,>(
    key: string,
    label: string,
    action: () => Promise<T>,
  ) => {
    emitDiagnostic({ key, label, status: "running" });
    try {
      const result = await action();
      emitDiagnostic({ key, label, status: "completed" });
      return result;
    } catch (error) {
      failDiagnosticStep(key, label, error);
      throw error;
    }
  };

  const connection = new CodexAppServerConnection(input.workspacePath, {
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    extraEnv: input.extraEnv,
  });
  onRuntimeUpdate?.({
    runtimePid: connection.getRuntimePid(),
  });
  const turnDone = createDeferred<void>();
  const rawToolCalls = new Map<string, { source: ToolTraceSource; tool: string }>();
  let rawEventSequence = 0;
  let waitingForTurnStart = false;
  let turnStartReceived = false;

  const close = () => {
    connection.close();
    turnDone.reject(new Error("Chat stream aborted."));
  };
  signal?.addEventListener("abort", close, { once: true });

  try {
    await runDiagnosticStep("launch_runtime", "Launch Codex runtime", async () => {
      await connection.initialize();
    });
    connection.onNotification((message) => {
      if (!message.method || !message.params) {
        return;
      }

      const params = message.params;
      switch (message.method) {
        case "turn/started":
          turnStartReceived = true;
          if (waitingForTurnStart) {
            emitDiagnostic({
              key: "await_turn_started",
              label: "Await turn start signal",
              status: "completed",
            });
            waitingForTurnStart = false;
          }
          onEvent({
            type: "turn_started",
            turnId: normalizeText((params.turn as Record<string, unknown> | undefined)?.id),
          });
          break;
        case "item/started":
          onEvent({
            type: "item_started",
            item: (params.item as Record<string, unknown>) ?? {},
            threadId: normalizeText(params.threadId),
            turnId: normalizeText(params.turnId),
          });
          break;
        case "item/completed":
          onEvent({
            type: "item_completed",
            item: (params.item as Record<string, unknown>) ?? {},
            threadId: normalizeText(params.threadId),
            turnId: normalizeText(params.turnId),
          });
          break;
        case "item/agentMessage/delta":
          onEvent({
            type: "agent_message_delta",
            itemId: normalizeText(params.itemId),
            delta: normalizeText(params.delta),
            threadId: normalizeText(params.threadId),
            turnId: normalizeText(params.turnId),
          });
          break;
        case "item/reasoning/textDelta":
          onEvent({
            type: "reasoning_delta",
            itemId: normalizeText(params.itemId),
            delta: normalizeText(params.delta),
            threadId: normalizeText(params.threadId),
            turnId: normalizeText(params.turnId),
          });
          break;
        case "item/reasoning/summaryTextDelta":
          onEvent({
            type: "reasoning_summary_delta",
            itemId: normalizeText(params.itemId),
            delta: normalizeText(params.delta),
            threadId: normalizeText(params.threadId),
            turnId: normalizeText(params.turnId),
          });
          break;
        case "item/commandExecution/outputDelta":
          onEvent({
            type: "command_output_delta",
            itemId: normalizeText(params.itemId),
            delta: normalizeText(params.delta),
            threadId: normalizeText(params.threadId),
            turnId: normalizeText(params.turnId),
          });
          break;
        case "item/fileChange/outputDelta":
          onEvent({
            type: "file_change_delta",
            itemId: normalizeText(params.itemId),
            delta: normalizeText(params.delta),
            threadId: normalizeText(params.threadId),
            turnId: normalizeText(params.turnId),
          });
          break;
        case "turn/plan/updated":
          onEvent({
            type: "plan_updated",
            threadId: normalizeText(params.threadId),
            turnId: normalizeText(params.turnId),
            steps: Array.isArray(params.steps)
              ? params.steps.map((step) => {
                  const current = step as Record<string, unknown>;
                  return {
                    title: normalizeText(current.title),
                    status: normalizeText(current.status),
                  };
                })
              : [],
          });
          break;
        case "item/mcpToolCall/progress":
          onEvent(
            normalizeToolEvent({
              itemId: normalizeText(params.itemId),
              threadId: normalizeText(params.threadId),
              turnId: normalizeText(params.turnId),
              source: "mcp",
              status: normalizeText(params.status),
              server: normalizeText(params.server) || null,
              tool: normalizeText(params.tool),
              input: null,
              message: normalizeToolProgressMessage(params),
              result: null,
              error: null,
            }),
          );
          break;
        case "rawResponseItem/completed": {
          const item = (params.item as RawResponseItem | undefined) ?? null;
          const threadId = normalizeText(params.threadId);
          const turnId = normalizeText(params.turnId);

          if (!item) {
            break;
          }

          if (item.type === "function_call") {
            const functionCall = item as Extract<RawResponseItem, { type: "function_call" }>;
            rawToolCalls.set(functionCall.call_id, {
              source: "function",
              tool: functionCall.name,
            });

            if (functionCall.name === "exec_command") {
              const seed = parseExecCommandSeed(functionCall.arguments, input.workspacePath);
              if (seed) {
                onEvent({
                  type: "command_seed",
                  itemId: functionCall.call_id,
                  threadId,
                  turnId,
                  command: seed.command,
                  cwd: seed.cwd,
                  toolName: functionCall.name,
                  toolInput: seed.toolInput,
                });
                break;
              }
            }

            onEvent(
              normalizeToolEvent({
                itemId: functionCall.call_id,
                threadId,
                turnId,
                source: "function",
                status: "requested",
                server: null,
                tool: functionCall.name,
                input: functionCall.arguments,
                message: null,
                result: null,
                error: null,
              }),
            );
            break;
          }

          if (item.type === "function_call_output") {
            const functionCallOutput = item as Extract<
              RawResponseItem,
              { type: "function_call_output" }
            >;
            const toolCall = rawToolCalls.get(functionCallOutput.call_id);
            if (!toolCall || toolCall.tool === "exec_command") {
              break;
            }

            onEvent(
              normalizeToolEvent({
                itemId: functionCallOutput.call_id,
                threadId,
                turnId,
                source: toolCall.source,
                status: "completed",
                server: null,
                tool: toolCall.tool,
                input: null,
                message: null,
                result: stringifyCompact(functionCallOutput.output),
                error: null,
              }),
            );
            break;
          }

          if (item.type === "custom_tool_call") {
            const customToolCall = item as Extract<RawResponseItem, { type: "custom_tool_call" }>;
            rawToolCalls.set(customToolCall.call_id, {
              source: "custom",
              tool: customToolCall.name,
            });

            onEvent(
              normalizeToolEvent({
                itemId: customToolCall.call_id,
                threadId,
                turnId,
                source: "custom",
                status: customToolCall.status || "requested",
                server: null,
                tool: customToolCall.name,
                input: customToolCall.input,
                message: null,
                result: null,
                error: null,
              }),
            );
            break;
          }

          if (item.type === "custom_tool_call_output") {
            const customToolCallOutput = item as Extract<
              RawResponseItem,
              { type: "custom_tool_call_output" }
            >;
            const toolCall = rawToolCalls.get(customToolCallOutput.call_id) ?? {
              source: "custom" as const,
              tool: "custom_tool",
            };

            onEvent(
              normalizeToolEvent({
                itemId: customToolCallOutput.call_id,
                threadId,
                turnId,
                source: toolCall.source,
                status: "completed",
                server: null,
                tool: toolCall.tool,
                input: null,
                message: null,
                result: stringifyCompact(customToolCallOutput.output),
                error: null,
              }),
            );
            break;
          }

          if (item.type === "local_shell_call") {
            const localShellCall = item as Extract<RawResponseItem, { type: "local_shell_call" }>;
            const itemId = localShellCall.call_id || `${turnId}-local-shell-${rawEventSequence++}`;
            if (localShellCall.call_id) {
              rawToolCalls.set(localShellCall.call_id, {
                source: "local_shell",
                tool: "local_shell",
              });
            }

            const seed = parseLocalShellSeed(localShellCall, input.workspacePath);
            if (seed && seed.command) {
              onEvent({
                type: "command_seed",
                itemId,
                threadId,
                turnId,
                command: seed.command,
                cwd: seed.cwd,
                toolName: "local_shell",
                toolInput: seed.toolInput,
              });
              break;
            }

            onEvent(
              normalizeToolEvent({
                itemId,
                threadId,
                turnId,
                source: "local_shell",
                status: localShellCall.status,
                server: null,
                tool: "local_shell",
                input: stringifyCompact(localShellCall.action),
                message: null,
                result: null,
                error: null,
              }),
            );
            break;
          }

          if (item.type === "web_search_call") {
            const webSearchCall = item as Extract<RawResponseItem, { type: "web_search_call" }>;
            const itemId = `${turnId}-web-search-${rawEventSequence++}`;
            const query =
              webSearchCall.action?.query ||
              webSearchCall.action?.queries?.join("\n") ||
              webSearchCall.action?.url ||
              webSearchCall.action?.pattern ||
              null;

            onEvent(
              normalizeToolEvent({
                itemId,
                threadId,
                turnId,
                source: "web_search",
                status: webSearchCall.status || "completed",
                server: null,
                tool: "web_search",
                input: query,
                message: stringifyCompact(webSearchCall.action),
                result: null,
                error: null,
              }),
            );
          }
          break;
        }
        case "turn/completed": {
          const turn = (params.turn as Record<string, unknown>) ?? {};
          const error = turn.error as Record<string, unknown> | null | undefined;
          onEvent({
            type: "turn_completed",
            threadId: normalizeText(params.threadId),
            turnId: normalizeText(turn.id),
            status: normalizeText(turn.status),
            error: error ? normalizeText(error.message) || stringifyCompact(error) : null,
          });
          turnDone.resolve();
          break;
        }
        case "error": {
          const event = {
            type: "error",
            message:
              normalizeText(params.message) ||
              normalizeText((params.error as Record<string, unknown> | undefined)?.message) ||
              "Codex returned an error.",
          } satisfies ChatStreamEvent;
          onEvent(event);
          turnDone.reject(new Error(event.message));
          break;
        }
      }
    });

    let threadId = input.threadId?.trim() || "";

    if (threadId) {
      const resumed = await runDiagnosticStep("restore_thread", "Resume existing thread", async () => {
        return (await connection.request("thread/resume", {
          threadId,
          cwd: input.workspacePath,
          approvalPolicy: "never",
          sandbox: SESSION_CODEX_SANDBOX_MODE,
          persistExtendedHistory: true,
        })) as {
          thread?: { id?: string };
        };
      });

      threadId = normalizeText(resumed.thread?.id) || threadId;
    } else {
      const started = await runDiagnosticStep("start_thread", "Create new thread", async () => {
        return (await connection.request("thread/start", {
          cwd: input.workspacePath,
          approvalPolicy: "never",
          sandbox: SESSION_CODEX_SANDBOX_MODE,
          experimentalRawEvents: true,
          persistExtendedHistory: true,
        })) as {
          thread?: { id?: string };
        };
      });

      threadId = normalizeText(started.thread?.id);
    }

    if (!threadId) {
      throw new Error("Codex did not return a thread id.");
    }

    onEvent({ type: "thread_ready", threadId });

    emitDiagnostic({
      key: "await_turn_started",
      label: "Await turn start signal",
      status: "running",
    });
    waitingForTurnStart = true;
    await runDiagnosticStep("send_turn_start", "Send turn request", async () => {
      await connection.request("turn/start", {
        threadId,
        input: [
          {
            type: "text",
            text: input.message,
            text_elements: [],
          },
        ],
        cwd: input.workspacePath,
        approvalPolicy: "never",
        summary: "detailed",
      });
    });

    await turnDone.promise;
    if (waitingForTurnStart && !turnStartReceived) {
      emitDiagnostic({
        key: "await_turn_started",
        label: "Await turn start signal",
        status: "failed",
        detail: "Turn completed before a turn/started event arrived.",
      });
      waitingForTurnStart = false;
    }
  } catch (error) {
    if (waitingForTurnStart && !turnStartReceived) {
      failDiagnosticStep("await_turn_started", "Await turn start signal", error);
      waitingForTurnStart = false;
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", close);
    connection.close();
  }
}
