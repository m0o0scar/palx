import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Readable, Writable } from "node:stream";

import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  RequestError,
  ndJsonStream,
  type AuthMethod,
  type InitializeResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
  type SessionUpdate,
  type ToolCall,
  type ToolCallContent,
  type ToolCallLocation,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";

import type {
  AgentAccount,
  AppStatus,
  ChatInput,
  ChatStreamEvent,
  FileChange,
  HistoryEntry,
  LoginStartResponse,
  ModelOption,
  ProviderCatalogEntry,
  SessionAgentTurnDiagnosticUpdate,
  ThreadHistoryResponse,
  ToolTraceSource,
} from "@/lib/agent/types";
import {
  defaultSpawnEnv,
  normalizeText,
  readCommandOutput,
  readJsonFile,
  resolveExecutable,
  stringifyCompact,
  waitForReplayIdle,
} from "@/lib/agent/common";
import { buildAcpSpawnEnv } from "@/lib/agent/spawn-env";
import type { AgentRuntimeUpdate } from "@/lib/agent/providers/types";

type AcpProviderId = "gemini" | "cursor";

type CommandSpec = {
  binaryNames: string[];
  args: string[];
  buildArgs?: (model?: string | null) => string[];
};

type InstallSpec = {
  display: string;
  command: string;
  args: string[];
};

type LoginSpec =
  | {
      type: "acp";
      methodId?: string;
      message: string;
    }
  | {
      type: "command";
      binaryNames: string[];
      args: string[];
      message: string;
    };

type ModelCatalog = {
  models: ModelOption[];
  defaultModel: string | null;
};

type AcpProviderConfig = {
  provider: AcpProviderId;
  metadata: ProviderCatalogEntry;
  acp: CommandSpec;
  version: CommandSpec;
  install: InstallSpec;
  login: LoginSpec;
  detectLogin?: (
    binaryPath: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<{ loggedIn: boolean; account: AgentAccount | null }>;
  listModels?: (binaryPath: string, env: NodeJS.ProcessEnv) => Promise<ModelCatalog>;
  fallbackModels: ModelCatalog;
};

type AcpConnection = {
  child: ChildProcessWithoutNullStreams;
  client: ClientSideConnection;
  init: InitializeResponse;
  close(): Promise<void>;
};

type InstallLogEvent = {
  stream: "stdout" | "stderr";
  text: string;
};

type ToolState = {
  toolCallId: string;
  title: string;
  status: string;
  kind: string | null;
  rawInput: unknown;
  rawOutput: unknown;
  locations: ToolCallLocation[];
  content: ToolCallContent[];
};

type ParsedToolSnapshot = {
  id: string;
  title: string;
  status: string;
  source: ToolTraceSource;
  toolName: string;
  input: string | null;
  message: string | null;
  result: string | null;
  error: string | null;
  command: {
    command: string;
    cwd: string;
    output: string;
    exitCode: number | null;
    toolInput: string | null;
    status: string;
  } | null;
  fileChanges: FileChange[];
};

type TextChunkKind = "assistant" | "reasoning";

class TurnTextSegmenter {
  private readonly counters: Record<TextChunkKind, number> = {
    assistant: 0,
    reasoning: 0,
  };
  private readonly activeIds: Partial<Record<TextChunkKind, string>> = {};
  private activeKind: TextChunkKind | null = null;

  constructor(private readonly turnKey: string) {}

  next(kind: TextChunkKind): string {
    if (this.activeKind === kind) {
      const existing = this.activeIds[kind];
      if (existing) {
        return existing;
      }
    }

    const nextIndex = this.counters[kind] + 1;
    this.counters[kind] = nextIndex;
    const id = `${kind}-${this.turnKey}-${nextIndex}`;
    this.activeIds[kind] = id;
    this.activeKind = kind;
    return id;
  }

  markBoundary() {
    this.activeKind = null;
  }
}

type LoginTask = {
  response: Promise<LoginStartResponse>;
  finished: Promise<void>;
};

const CLIENT_INFO = {
  name: "palx",
  version: "0.66.0",
};

const activeLogins = new Map<AcpProviderId, LoginTask>();

const GEMINI_MODEL_CATALOG: ModelCatalog = {
  defaultModel: "auto-gemini-2.5",
  models: [
    {
      id: "auto-gemini-2.5",
      label: "Auto Gemini 2.5",
      description: "Let Gemini CLI route between Gemini 2.5 Pro and Flash.",
    },
    {
      id: "gemini-2.5-pro",
      label: "Gemini 2.5 Pro",
      description: "Highest-quality Gemini 2.5 coding model.",
    },
    {
      id: "gemini-2.5-flash",
      label: "Gemini 2.5 Flash",
      description: "Faster Gemini 2.5 model.",
    },
    {
      id: "gemini-2.5-flash-lite",
      label: "Gemini 2.5 Flash Lite",
      description: "Lower-cost Gemini 2.5 fast model.",
    },
    {
      id: "auto-gemini-3",
      label: "Auto Gemini 3",
      description: "Preview routing between Gemini 3 Pro and Flash variants.",
    },
    {
      id: "gemini-3-pro-preview",
      label: "Gemini 3 Pro Preview",
      description: "Preview Gemini 3 Pro model; account access may be required.",
    },
    {
      id: "gemini-3-flash-preview",
      label: "Gemini 3 Flash Preview",
      description: "Preview Gemini 3 Flash model; account access may be required.",
    },
  ],
};

const CURSOR_FALLBACK_MODEL_CATALOG: ModelCatalog = {
  defaultModel: "auto",
  models: [
    {
      id: "auto",
      label: "Auto",
      description: "Let Cursor choose the best model available to the account.",
    },
    {
      id: "gpt-5.3-codex",
      label: "GPT-5.3 Codex",
      description: "OpenAI coding-focused model when available in Cursor.",
    },
    {
      id: "opus-4.6-thinking",
      label: "Claude 4.6 Opus (Thinking)",
      description: "High-capability Claude thinking model when available in Cursor.",
    },
    {
      id: "gemini-3-pro",
      label: "Gemini 3 Pro",
      description: "Google Gemini model when available in Cursor.",
    },
  ],
};

const providerConfigs: Record<AcpProviderId, AcpProviderConfig> = {
  gemini: {
    provider: "gemini",
    metadata: {
      id: "gemini",
      label: "Gemini CLI",
      description: "Google's coding agent runtime over ACP.",
      available: true,
    },
    acp: {
      binaryNames: ["gemini"],
      args: ["--experimental-acp"],
      buildArgs: (model) =>
        model?.trim()
          ? ["--model", model.trim(), "--experimental-acp"]
          : ["--experimental-acp"],
    },
    version: {
      binaryNames: ["gemini"],
      args: ["--version"],
    },
    install: {
      display: "npm install -g @google/gemini-cli@latest",
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["install", "-g", "@google/gemini-cli@latest"],
    },
    login: {
      type: "acp",
      methodId: "oauth-personal",
      message: "Gemini sign-in was started. Finish the Google browser flow, then return here.",
    },
    detectLogin: async (_binaryPath, env) => {
      if (env.GEMINI_API_KEY) {
        return {
          loggedIn: true,
          account: {
            type: "gemini-api-key",
            planType: null,
          },
        };
      }

      if (env.GOOGLE_API_KEY || env.GOOGLE_GENAI_USE_VERTEXAI) {
        return {
          loggedIn: true,
          account: {
            type: "vertex-ai",
            planType: null,
          },
        };
      }

      const settings = await readJsonFile<{
        security?: {
          auth?: {
            selectedType?: string;
          };
        };
      }>(path.join(os.homedir(), ".gemini", "settings.json"));
      const selectedType = settings?.security?.auth?.selectedType ?? null;

      if (selectedType === "gemini-api-key") {
        return {
          loggedIn: Boolean(env.GEMINI_API_KEY),
          account: env.GEMINI_API_KEY
            ? {
                type: "gemini-api-key",
                planType: null,
              }
            : null,
        };
      }

      if (selectedType === "vertex-ai") {
        const hasVertexKey = Boolean(env.GOOGLE_API_KEY || env.GOOGLE_GENAI_USE_VERTEXAI);
        return {
          loggedIn: hasVertexKey,
          account: hasVertexKey
            ? {
                type: "vertex-ai",
                planType: null,
              }
            : null,
        };
      }

      const loggedIn =
        existsSync(path.join(os.homedir(), ".gemini", "oauth_creds.json")) ||
        existsSync(path.join(os.homedir(), ".gemini", "google_accounts.json"));

      return {
        loggedIn,
        account: loggedIn
          ? {
              type: selectedType || "oauth-personal",
              planType: null,
            }
          : null,
      };
    },
    fallbackModels: GEMINI_MODEL_CATALOG,
  },
  cursor: {
    provider: "cursor",
    metadata: {
      id: "cursor",
      label: "Cursor Agent CLI",
      description: "Cursor's coding agent runtime over ACP.",
      available: true,
    },
    acp: {
      binaryNames: ["cursor-agent", "agent"],
      args: ["acp"],
      buildArgs: (model) => (model?.trim() ? ["--model", model.trim(), "acp"] : ["acp"]),
    },
    version: {
      binaryNames: ["cursor-agent", "agent"],
      args: ["--version"],
    },
    install: {
      display: "curl https://cursor.com/install -fsS | bash",
      command: "sh",
      args: ["-lc", "curl https://cursor.com/install -fsS | bash"],
    },
    login: {
      type: "command",
      binaryNames: ["cursor-agent", "agent"],
      args: ["login"],
      message: "Cursor sign-in was started. Finish the browser flow, then return here.",
    },
    detectLogin: async () => {
      if (process.env.CURSOR_API_KEY) {
        return {
          loggedIn: true,
          account: {
            type: "cursor-api-key",
            planType: null,
          },
        };
      }

      const config = await readJsonFile<{
        authInfo?: {
          email?: string;
        };
      }>(path.join(os.homedir(), ".cursor", "cli-config.json"));
      const email = config?.authInfo?.email ?? null;
      return {
        loggedIn: Boolean(email),
        account: email
          ? {
              type: "cursor",
              email,
              planType: null,
            }
          : null,
      };
    },
    listModels: async (binaryPath, env) => {
      const result = await readCommandOutput(binaryPath, ["--list-models"], env);
      if (result.exitCode !== 0) {
        return CURSOR_FALLBACK_MODEL_CATALOG;
      }

      const parsed = parseCursorModelCatalog(result.stdout || result.stderr);
      if (parsed.models.length === 0) {
        return CURSOR_FALLBACK_MODEL_CATALOG;
      }

      return parsed;
    },
    fallbackModels: CURSOR_FALLBACK_MODEL_CATALOG,
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readStringField(
  source: Record<string, unknown> | undefined,
  keys: string[],
): string | null {
  if (!source) {
    return null;
  }

  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }

    if (Array.isArray(value)) {
      const parts = value.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      );
      if (parts.length > 0) {
        return parts.join(" ");
      }
    }
  }

  return null;
}

function dedupeModels(models: ModelOption[]) {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (!model.id || seen.has(model.id)) {
      return false;
    }

    seen.add(model.id);
    return true;
  });
}

function parseCursorModelCatalog(stdout: string): ModelCatalog {
  const models: ModelOption[] = [];
  let defaultModel: string | null = null;
  let currentModel: string | null = null;

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (!line || !line.includes(" - ")) {
      continue;
    }

    const separator = line.indexOf(" - ");
    const id = line.slice(0, separator).trim();
    const remainder = line.slice(separator + 3).trim();
    if (!id || !remainder) {
      continue;
    }

    const isDefault = remainder.includes("(default)");
    const isCurrent = remainder.includes("(current)");
    const label = remainder.replace(/\s+\((default|current)\)/g, "").trim();

    models.push({
      id,
      label,
      description: isDefault
        ? "Cursor account default."
        : isCurrent
          ? "Currently selected in Cursor CLI."
          : null,
    });

    if (isDefault && !defaultModel) {
      defaultModel = id;
    }
    if (isCurrent && !currentModel) {
      currentModel = id;
    }
  }

  return {
    models: dedupeModels(models),
    defaultModel: currentModel || defaultModel || models[0]?.id || null,
  };
}

async function getVersionInfo(config: AcpProviderConfig) {
  const env = defaultSpawnEnv();
  const binaryPath = resolveExecutable(config.version.binaryNames, env);

  try {
    const result = await readCommandOutput(binaryPath, config.version.args, env);
    if (result.exitCode !== 0) {
      return {
        installed: false,
        version: null,
        binaryPath,
        env,
      };
    }

    return {
      installed: true,
      version: normalizeText(result.stdout || result.stderr) || null,
      binaryPath,
      env,
    };
  } catch {
    return {
      installed: false,
      version: null,
      binaryPath,
      env,
    };
  }
}

async function getModelCatalog(
  config: AcpProviderConfig,
  versionInfo?: Awaited<ReturnType<typeof getVersionInfo>>,
) {
  const info = versionInfo ?? (await getVersionInfo(config));
  if (!info.installed) {
    return config.fallbackModels;
  }

  if (!config.listModels) {
    return config.fallbackModels;
  }

  try {
    const catalog = await config.listModels(info.binaryPath, info.env);
    if (catalog.models.length === 0) {
      return config.fallbackModels;
    }

    return {
      models: dedupeModels(catalog.models),
      defaultModel: catalog.defaultModel || catalog.models[0]?.id || null,
    };
  } catch {
    return config.fallbackModels;
  }
}

function createPermissionResponse(params: RequestPermissionRequest): RequestPermissionResponse {
  const options = params.options ?? [];
  const selected =
    options.find((option) => option.kind === "allow_once") ??
    options.find((option) => option.kind === "allow_always") ??
    options.find((option) => option.kind === "reject_once") ??
    options[0];

  if (!selected) {
    return {
      outcome: {
        outcome: "cancelled",
      },
    };
  }

  return {
    outcome: {
      outcome: "selected",
      optionId: selected.optionId,
    },
  };
}

function resolveSessionPath(workspacePath: string, rawPath: string) {
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }

  return path.resolve(workspacePath, rawPath);
}

async function createAcpConnection(
  config: AcpProviderConfig,
  workspacePath: string,
  callbacks: {
    onSessionUpdate?: (notification: SessionNotification) => void;
    onPermissionRequest?: (params: RequestPermissionRequest) => void;
  } = {},
  options: {
    model?: string | null;
    extraEnv?: Record<string, string> | null;
  } = {},
): Promise<AcpConnection> {
  const env = buildAcpSpawnEnv(options.extraEnv);
  const binaryPath = resolveExecutable(config.acp.binaryNames, env);
  const args = config.acp.buildArgs ? config.acp.buildArgs(options.model) : config.acp.args;

  const child = spawn(binaryPath, args, {
    cwd: workspacePath,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {});

  const input = Writable.toWeb(child.stdin);
  const output = Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(input, output);

  const client = new ClientSideConnection(
    () => ({
      sessionUpdate: async (params: SessionNotification) => {
        callbacks.onSessionUpdate?.(params);
      },
      requestPermission: async (params: RequestPermissionRequest) => {
        callbacks.onPermissionRequest?.(params);
        return createPermissionResponse(params);
      },
      readTextFile: async ({ path: rawPath }) => {
        const resolvedPath = resolveSessionPath(workspacePath, rawPath);
        return {
          content: await readFile(resolvedPath, "utf8"),
        };
      },
      writeTextFile: async ({ path: rawPath, content }) => {
        const resolvedPath = resolveSessionPath(workspacePath, rawPath);
        await mkdir(path.dirname(resolvedPath), { recursive: true });
        await writeFile(resolvedPath, content, "utf8");
        return {};
      },
    }),
    stream,
  );

  const init = await client.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: {
        readTextFile: true,
        writeTextFile: true,
      },
    },
    clientInfo: CLIENT_INFO,
  });

  return {
    child,
    client,
    init,
    async close() {
      if (child.exitCode !== null || child.killed) {
        return;
      }

      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill("SIGKILL");
        }, 2000);
        timeout.unref();
        child.once("close", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
  };
}

function isAuthRequired(error: unknown) {
  if (error instanceof RequestError) {
    return error.code === -32000;
  }

  return isRecord(error) && error.code === -32000;
}

function extractTextContent(content: unknown): string | null {
  if (!content) {
    return null;
  }

  if (isRecord(content) && content.type === "text" && typeof content.text === "string") {
    return content.text;
  }

  return stringifyCompact(content);
}

function formatLocations(locations: ToolCallLocation[]) {
  if (locations.length === 0) {
    return null;
  }

  return locations
    .map((location) =>
      location.line && location.line > 0 ? `${location.path}:${location.line}` : location.path,
    )
    .join("\n");
}

function resolveDiffKind(change: ToolCallContent & { type: "diff" }) {
  if (isRecord(change._meta) && typeof change._meta.kind === "string") {
    return change._meta.kind;
  }

  if (!change.oldText && change.newText) {
    return "add";
  }

  if (change.oldText && !change.newText) {
    return "delete";
  }

  return "modify";
}

function formatDiff(change: ToolCallContent & { type: "diff" }) {
  const kind = resolveDiffKind(change);
  switch (kind) {
    case "add":
      return `+++ after\n${change.newText}`;
    case "delete":
      return `--- before\n${change.oldText}`;
    default:
      return `--- before\n${change.oldText}\n+++ after\n${change.newText}`;
  }
}

function summarizeToolContent(content: ToolCallContent[]) {
  const resultParts: string[] = [];
  const fileChanges: FileChange[] = [];

  for (const item of content) {
    switch (item.type) {
      case "content": {
        const text = extractTextContent(item.content);
        if (text) {
          resultParts.push(text);
        }
        break;
      }
      case "diff":
        fileChanges.push({
          path: item.path,
          kind: resolveDiffKind(item),
          diff: formatDiff(item),
        });
        break;
      case "terminal":
        resultParts.push(`[terminal ${item.terminalId}]`);
        break;
    }
  }

  return {
    resultText: resultParts.join("\n\n").trim() || null,
    fileChanges,
  };
}

function combineCommandOutput(rawOutput: unknown, contentText: string | null) {
  if (typeof rawOutput === "string" && rawOutput.trim()) {
    return rawOutput;
  }

  if (isRecord(rawOutput)) {
    const stdout = normalizeText(rawOutput.stdout);
    const stderr = normalizeText(rawOutput.stderr);
    const output = [stdout, stderr].filter(Boolean).join(stdout && stderr ? "\n" : "");
    if (output) {
      return output;
    }
  }

  return contentText ?? "";
}

function resolveCommandLabel(title: string) {
  const trimmed = title.trim();
  if (!trimmed) {
    return "Command";
  }

  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function mergeToolState(previous: ToolState | undefined, update: ToolCall | ToolCallUpdate): ToolState {
  return {
    toolCallId: update.toolCallId,
    title: update.title ?? previous?.title ?? "ACP Tool",
    status: update.status ?? previous?.status ?? "pending",
    kind: update.kind ?? previous?.kind ?? null,
    rawInput:
      "rawInput" in update && update.rawInput !== undefined ? update.rawInput : previous?.rawInput,
    rawOutput:
      "rawOutput" in update && update.rawOutput !== undefined
        ? update.rawOutput
        : previous?.rawOutput,
    locations:
      "locations" in update && update.locations !== undefined
        ? (update.locations ?? [])
        : (previous?.locations ?? []),
    content:
      "content" in update && update.content !== undefined
        ? (update.content ?? [])
        : (previous?.content ?? []),
  };
}

function parseToolSnapshot(state: ToolState, cwd: string): ParsedToolSnapshot {
  const input = stringifyCompact(state.rawInput);
  const message = formatLocations(state.locations);
  const { resultText, fileChanges } = summarizeToolContent(state.content);
  const source: ToolTraceSource = state.kind === "execute" ? "local_shell" : "acp";

  if (source === "local_shell") {
    const rawInput = isRecord(state.rawInput) ? state.rawInput : undefined;
    const rawOutput = isRecord(state.rawOutput) ? state.rawOutput : undefined;
    const command =
      readStringField(rawInput, ["command", "cmd"]) ?? resolveCommandLabel(state.title);
    const commandCwd =
      readStringField(rawInput, ["cwd", "workdir", "workingDirectory"]) ?? cwd;
    const output = combineCommandOutput(state.rawOutput, resultText);
    const exitCode =
      rawOutput && typeof rawOutput.exitCode === "number" ? rawOutput.exitCode : null;

    return {
      id: state.toolCallId,
      title: state.title,
      status: state.status,
      source,
      toolName: "ACP Execute",
      input,
      message,
      result: resultText ?? stringifyCompact(state.rawOutput),
      error: state.status === "failed" ? resultText ?? "Command failed." : null,
      command: {
        command,
        cwd: commandCwd,
        output,
        exitCode,
        toolInput: input,
        status: state.status,
      },
      fileChanges,
    };
  }

  const rawOutputText = stringifyCompact(state.rawOutput);
  const result = resultText ?? rawOutputText;

  return {
    id: state.toolCallId,
    title: state.title,
    status: state.status,
    source,
    toolName: state.title || state.kind || "ACP Tool",
    input,
    message,
    result,
    error: state.status === "failed" ? result ?? "Tool call failed." : null,
    command: null,
    fileChanges,
  };
}

class AcpTurnProjector {
  private readonly toolStates = new Map<string, ToolState>();
  private readonly commandSeedSignatures = new Map<string, string>();
  private readonly textSegmenter: TurnTextSegmenter;

  constructor(
    private readonly threadId: string,
    private readonly turnId: string,
    private readonly onEvent: (event: ChatStreamEvent) => void,
    private readonly cwd: string,
  ) {
    this.textSegmenter = new TurnTextSegmenter(turnId);
  }

  handlePermissionRequest(params: RequestPermissionRequest) {
    this.markTextBoundary();
    this.projectToolUpdate(params.toolCall);
  }

  handleUpdate(update: SessionUpdate) {
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text =
          update.content.type === "text" ? update.content.text : stringifyCompact(update.content);
        if (text) {
          this.onEvent({
            type: "agent_message_delta",
            itemId: this.nextTextItemId("assistant"),
            delta: text,
            threadId: this.threadId,
            turnId: this.turnId,
          });
        }
        return;
      }
      case "agent_thought_chunk": {
        const text =
          update.content.type === "text" ? update.content.text : stringifyCompact(update.content);
        if (text) {
          this.onEvent({
            type: "reasoning_summary_delta",
            itemId: this.nextTextItemId("reasoning"),
            delta: text,
            threadId: this.threadId,
            turnId: this.turnId,
          });
        }
        return;
      }
      case "tool_call":
      case "tool_call_update":
        this.markTextBoundary();
        this.projectToolUpdate(update);
        return;
      case "plan":
        this.markTextBoundary();
        this.onEvent({
          type: "plan_updated",
          threadId: this.threadId,
          turnId: this.turnId,
          steps: update.entries.map((entry) => ({
            title: entry.content,
            status: entry.status,
          })),
        });
        return;
      default:
        return;
    }
  }

  private nextTextItemId(kind: TextChunkKind) {
    return this.textSegmenter.next(kind);
  }

  private markTextBoundary() {
    this.textSegmenter.markBoundary();
  }

  private projectToolUpdate(update: ToolCall | ToolCallUpdate) {
    const nextState = mergeToolState(this.toolStates.get(update.toolCallId), update);
    this.toolStates.set(update.toolCallId, nextState);
    const snapshot = parseToolSnapshot(nextState, this.cwd);

    if (snapshot.command) {
      const seedSignature = JSON.stringify({
        command: snapshot.command.command,
        cwd: snapshot.command.cwd,
        toolName: snapshot.toolName,
        input: snapshot.command.toolInput,
      });

      if (this.commandSeedSignatures.get(snapshot.id) !== seedSignature) {
        this.commandSeedSignatures.set(snapshot.id, seedSignature);
        this.onEvent({
          type: "command_seed",
          itemId: snapshot.id,
          threadId: this.threadId,
          turnId: this.turnId,
          command: snapshot.command.command,
          cwd: snapshot.command.cwd,
          toolName: snapshot.toolName,
          toolInput: snapshot.command.toolInput,
        });
      }

      const commandItem = {
        type: "commandExecution",
        id: snapshot.id,
        command: snapshot.command.command,
        cwd: snapshot.command.cwd,
        aggregatedOutput: snapshot.command.output,
        status: snapshot.command.status,
        exitCode: snapshot.command.exitCode,
      } as const;

      this.onEvent({
        type: "item_started",
        item: commandItem,
        threadId: this.threadId,
        turnId: this.turnId,
      });

      if (snapshot.command.output) {
        this.onEvent({
          type: "command_output_delta",
          itemId: snapshot.id,
          delta: snapshot.command.output,
          threadId: this.threadId,
          turnId: this.turnId,
        });
      }

      if (snapshot.command.status === "completed" || snapshot.command.status === "failed") {
        this.onEvent({
          type: "item_completed",
          item: commandItem,
          threadId: this.threadId,
          turnId: this.turnId,
        });
      }
    } else {
      this.onEvent({
        type: "tool_progress",
        itemId: snapshot.id,
        threadId: this.threadId,
        turnId: this.turnId,
        status: snapshot.status,
        source: snapshot.source,
        server: null,
        tool: snapshot.toolName,
        input: snapshot.input,
        message: snapshot.message,
        result: snapshot.result,
        error: snapshot.error,
      });
    }

    for (const [index, change] of snapshot.fileChanges.entries()) {
      const itemId = `${snapshot.id}:file:${index}`;
      const fileChangeItem = {
        type: "fileChange",
        id: itemId,
        status: snapshot.status,
        changes: [change],
      } as const;

      this.onEvent({
        type: "item_started",
        item: fileChangeItem,
        threadId: this.threadId,
        turnId: this.turnId,
      });
      this.onEvent({
        type: "file_change_delta",
        itemId,
        delta: change.diff,
        threadId: this.threadId,
        turnId: this.turnId,
      });

      if (snapshot.status === "completed" || snapshot.status === "failed") {
        this.onEvent({
          type: "item_completed",
          item: fileChangeItem,
          threadId: this.threadId,
          turnId: this.turnId,
        });
      }
    }
  }
}

class AcpHistoryCollector {
  private readonly toolStates = new Map<string, ToolState>();
  private readonly byId = new Map<string, HistoryEntry>();
  private readonly order: string[] = [];
  private readonly textSegmenters = new Map<string, TurnTextSegmenter>();
  private turnIndex = 0;

  constructor(private readonly cwd: string) {}

  handleUpdate(update: SessionUpdate) {
    switch (update.sessionUpdate) {
      case "user_message_chunk":
        this.handleUserChunk(
          update.content.type === "text" ? update.content.text : stringifyCompact(update.content),
        );
        return;
      case "agent_thought_chunk":
        this.handleReasoningChunk(
          update.content.type === "text" ? update.content.text : stringifyCompact(update.content),
        );
        return;
      case "agent_message_chunk":
        this.handleAssistantChunk(
          update.content.type === "text" ? update.content.text : stringifyCompact(update.content),
        );
        return;
      case "tool_call":
      case "tool_call_update":
        this.markCurrentTurnTextBoundary();
        this.handleTool(update);
        return;
      case "plan":
        this.markCurrentTurnTextBoundary();
        this.upsertEntry(`plan-${this.currentTurnKey()}`, () => ({
          kind: "plan",
          id: `plan-${this.currentTurnKey()}`,
          text: update.entries.map((entry) => `${entry.status.toUpperCase()} ${entry.content}`).join("\n"),
        }));
        return;
      default:
        return;
    }
  }

  entries() {
    return this.order
      .map((id) => this.byId.get(id))
      .filter((entry): entry is HistoryEntry => Boolean(entry));
  }

  private handleUserChunk(text: string | null) {
    if (!text) {
      return;
    }

    this.markCurrentTurnTextBoundary();
    this.turnIndex += 1;
    const id = `user-${this.currentTurnKey()}`;
    this.upsertEntry(id, (existing) => ({
      kind: "user",
      id,
      text: existing && existing.kind === "user" ? existing.text + text : text,
    }));
  }

  private handleReasoningChunk(text: string | null) {
    if (!text) {
      return;
    }

    const id = this.nextCurrentTurnTextId("reasoning");
    this.upsertEntry(id, (existing) => ({
      kind: "reasoning",
      id,
      summary: existing && existing.kind === "reasoning" ? existing.summary + text : text,
      text: existing && existing.kind === "reasoning" ? existing.text : "",
    }));
  }

  private handleAssistantChunk(text: string | null) {
    if (!text) {
      return;
    }

    const id = this.nextCurrentTurnTextId("assistant");
    this.upsertEntry(id, (existing) => ({
      kind: "assistant",
      id,
      text: existing && existing.kind === "assistant" ? existing.text + text : text,
      phase: null,
    }));
  }

  private handleTool(update: ToolCall | ToolCallUpdate) {
    const nextState = mergeToolState(this.toolStates.get(update.toolCallId), update);
    this.toolStates.set(update.toolCallId, nextState);
    const snapshot = parseToolSnapshot(nextState, this.cwd);

    const command = snapshot.command;
    if (command) {
      this.upsertEntry(snapshot.id, () => ({
        kind: "command",
        id: snapshot.id,
        command: command.command,
        cwd: command.cwd,
        output: command.output,
        status: command.status,
        exitCode: command.exitCode,
        toolName: snapshot.toolName,
        toolInput: command.toolInput,
      }));
    } else {
      this.upsertEntry(snapshot.id, () => ({
        kind: "tool",
        id: snapshot.id,
        source: snapshot.source,
        server: null,
        tool: snapshot.toolName,
        status: snapshot.status,
        input: snapshot.input,
        message: snapshot.message,
        result: snapshot.result,
        error: snapshot.error,
      }));
    }

    for (const [index, change] of snapshot.fileChanges.entries()) {
      const id = `${snapshot.id}:file:${index}`;
      this.upsertEntry(id, () => ({
        kind: "fileChange",
        id,
        status: snapshot.status,
        output: change.diff,
        changes: [change],
      }));
    }
  }

  private currentTurnKey() {
    return this.turnIndex > 0 ? String(this.turnIndex) : "0";
  }

  private getCurrentTurnSegmenter() {
    const turnKey = this.currentTurnKey();
    const existing = this.textSegmenters.get(turnKey);
    if (existing) {
      return existing;
    }

    const created = new TurnTextSegmenter(turnKey);
    this.textSegmenters.set(turnKey, created);
    return created;
  }

  private nextCurrentTurnTextId(kind: TextChunkKind) {
    return this.getCurrentTurnSegmenter().next(kind);
  }

  private markCurrentTurnTextBoundary() {
    this.getCurrentTurnSegmenter().markBoundary();
  }

  private upsertEntry(id: string, build: (existing?: HistoryEntry) => HistoryEntry) {
    const existing = this.byId.get(id);
    const next = build(existing);
    if (!this.byId.has(id)) {
      this.order.push(id);
    }
    this.byId.set(id, next);
  }
}

async function probeLoggedIn(config: AcpProviderConfig) {
  const connection = await createAcpConnection(config, process.cwd());

  try {
    await connection.client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    return true;
  } catch (error) {
    if (isAuthRequired(error)) {
      return false;
    }

    throw error;
  } finally {
    await connection.close();
  }
}

async function ensureInstalledInternal(
  config: AcpProviderConfig,
  onEvent: (event: InstallLogEvent) => void,
) {
  const env = defaultSpawnEnv();

  await new Promise<void>((resolve, reject) => {
    const child = spawn(config.install.command, config.install.args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

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
        return;
      }

      reject(new Error(`${config.metadata.label} install exited with code ${exitCode}.`));
    });
  });
}

async function startAcpAuthLogin(config: AcpProviderConfig) {
  if (config.login.type !== "acp") {
    throw new Error(`${config.metadata.label} does not use ACP-managed login.`);
  }
  const login = config.login;

  const existing = activeLogins.get(config.provider);
  if (existing) {
    return await existing.response;
  }

  const response = Promise.resolve<LoginStartResponse>({
    kind: "pending",
    message: login.message,
  });

  const finished = (async () => {
    const connection = await createAcpConnection(config, process.cwd());

    try {
      const authMethod = pickAuthMethod(connection.init.authMethods ?? [], login.methodId);
      if (!authMethod) {
        throw new Error(`${config.metadata.label} did not advertise a usable auth method.`);
      }

      await connection.client.authenticate({
        methodId: authMethod.id,
      });
    } finally {
      await connection.close();
      activeLogins.delete(config.provider);
    }
  })();

  activeLogins.set(config.provider, { response, finished });
  void finished.catch(() => {});
  return await response;
}

function pickAuthMethod(authMethods: AuthMethod[], requestedMethodId?: string) {
  if (requestedMethodId) {
    const match = authMethods.find((method) => method.id === requestedMethodId);
    if (match) {
      return match;
    }
  }

  return authMethods.find((method) => !("type" in method)) ?? authMethods[0];
}

function extractFirstUrl(value: string) {
  return value.match(/https?:\/\/[^\s]+/i)?.[0] ?? null;
}

async function startCommandLogin(config: AcpProviderConfig) {
  if (config.login.type !== "command") {
    throw new Error(`${config.metadata.label} does not use command-managed login.`);
  }
  const login = config.login;

  const existing = activeLogins.get(config.provider);
  if (existing) {
    return await existing.response;
  }

  const env = defaultSpawnEnv();
  const binaryPath = resolveExecutable(login.binaryNames, env);
  let combinedOutput = "";

  let resolveResponse!: (value: LoginStartResponse) => void;
  let rejectResponse!: (reason?: unknown) => void;

  const response = new Promise<LoginStartResponse>((resolve, reject) => {
    resolveResponse = resolve;
    rejectResponse = reject;
  });

  const child = spawn(binaryPath, login.args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let settled = false;
  const settle = (value: LoginStartResponse) => {
    if (settled) {
      return;
    }

    settled = true;
    resolveResponse(value);
  };

  const maybeResolveUrl = () => {
    const url = extractFirstUrl(combinedOutput);
    if (url) {
      settle({
        kind: "browser",
        authUrl: url,
        loginId: null,
        message: login.message,
      });
    }
  };

  child.stdout.on("data", (chunk) => {
    combinedOutput += chunk.toString();
    maybeResolveUrl();
  });
  child.stderr.on("data", (chunk) => {
    combinedOutput += chunk.toString();
    maybeResolveUrl();
  });
  child.on("error", (error) => {
    if (!settled) {
      rejectResponse(error);
    }
  });

  const responseTimeout = setTimeout(() => {
    settle({
      kind: "pending",
      message: login.message,
    });
  }, 1200);
  responseTimeout.unref();

  const finished = new Promise<void>((resolve, reject) => {
    child.on("close", (exitCode) => {
      clearTimeout(responseTimeout);
      activeLogins.delete(config.provider);

      if (!settled) {
        if (exitCode === 0) {
          settle({
            kind: "pending",
            message: login.message,
          });
        } else {
          rejectResponse(
            new Error(
              combinedOutput.trim() ||
                `${config.metadata.label} login exited with code ${exitCode}.`,
            ),
          );
        }
      }

      if (exitCode === 0) {
        resolve();
        return;
      }

      reject(new Error(`${config.metadata.label} login exited with code ${exitCode}.`));
    });
  });

  activeLogins.set(config.provider, { response, finished });
  void finished.catch(() => {});
  return await response;
}

export async function getAcpAppStatus(provider: AcpProviderId): Promise<AppStatus> {
  const config = providerConfigs[provider];
  const versionInfo = await getVersionInfo(config);
  const modelCatalog = await getModelCatalog(config, versionInfo);

  if (!versionInfo.installed) {
    return {
      provider,
      installed: false,
      version: null,
      loggedIn: false,
      account: null,
      installCommand: config.install.display,
      models: modelCatalog.models,
      defaultModel: modelCatalog.defaultModel,
    };
  }

  const loginProbe = config.detectLogin
    ? await config.detectLogin(versionInfo.binaryPath, versionInfo.env)
    : await probeLoggedIn(config).then((loggedIn) => ({
        loggedIn,
        account: null,
      }));

  return {
    provider,
    installed: true,
    version: versionInfo.version,
    loggedIn: loginProbe.loggedIn,
    account: loginProbe.account,
    installCommand: config.install.display,
    models: modelCatalog.models,
    defaultModel: modelCatalog.defaultModel,
  };
}

export async function ensureAcpInstalled(
  provider: AcpProviderId,
  onEvent: (event: InstallLogEvent) => void,
) {
  const config = providerConfigs[provider];
  await ensureInstalledInternal(config, onEvent);
  return await getAcpAppStatus(provider);
}

export async function startAcpLogin(provider: AcpProviderId): Promise<LoginStartResponse> {
  const config = providerConfigs[provider];
  if (config.login.type === "acp") {
    return await startAcpAuthLogin(config);
  }

  return await startCommandLogin(config);
}

export async function readAcpThreadHistory(
  provider: AcpProviderId,
  input: {
    workspacePath: string;
    threadId: string;
  },
): Promise<ThreadHistoryResponse> {
  const config = providerConfigs[provider];
  const collector = new AcpHistoryCollector(input.workspacePath);
  let lastReplayActivityAt = Date.now();
  const connection = await createAcpConnection(config, input.workspacePath, {
    onSessionUpdate: ({ update }) => {
      lastReplayActivityAt = Date.now();
      collector.handleUpdate(update);
    },
  });

  try {
    await connection.client.loadSession({
      sessionId: input.threadId,
      cwd: input.workspacePath,
      mcpServers: [],
    });
    await waitForReplayIdle(() => lastReplayActivityAt);
  } finally {
    await connection.close();
  }

  return {
    provider,
    threadId: input.threadId,
    entries: collector.entries(),
  };
}

export async function streamAcpChat(
  provider: AcpProviderId,
  input: ChatInput,
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

  const config = providerConfigs[provider];
  let threadId = input.threadId?.trim() || "";
  const turnId = randomUUID();
  let suppressHistory = Boolean(threadId);
  let cancelled = false;
  let projector: AcpTurnProjector | null = null;
  let lastReplayActivityAt = Date.now();

  const connection = await runDiagnosticStep("launch_runtime", "Launch ACP runtime", async () => {
    return await createAcpConnection(
      config,
      input.workspacePath,
      {
        onSessionUpdate: ({ update }) => {
          lastReplayActivityAt = Date.now();
          if (suppressHistory || !projector) {
            return;
          }

          projector.handleUpdate(update);
        },
        onPermissionRequest: (params) => {
          if (suppressHistory || !projector) {
            return;
          }

          projector.handlePermissionRequest(params);
        },
      },
      {
        model: input.model,
        extraEnv: input.extraEnv,
      },
    );
  });
  onRuntimeUpdate?.({
    runtimePid: connection.child.pid ?? null,
  });

  const abortHandler = () => {
    cancelled = true;
    if (!threadId) {
      return;
    }

    void connection.client.cancel({ sessionId: threadId }).catch(() => {});
  };

  if (signal?.aborted) {
    abortHandler();
  }
  signal?.addEventListener("abort", abortHandler, { once: true });

  try {
    if (threadId) {
      await runDiagnosticStep("load_session", "Load existing session", async () => {
        await connection.client.loadSession({
          sessionId: threadId,
          cwd: input.workspacePath,
          mcpServers: [],
        });
      });
      await runDiagnosticStep("replay_history", "Replay prior session history", async () => {
        await waitForReplayIdle(() => lastReplayActivityAt);
      });
    } else {
      const session = await runDiagnosticStep("start_session", "Create new ACP session", async () => {
        return await connection.client.newSession({
          cwd: input.workspacePath,
          mcpServers: [],
        });
      });
      threadId = session.sessionId;
    }

    projector = new AcpTurnProjector(threadId, turnId, onEvent, input.workspacePath);
    suppressHistory = false;

    onEvent({
      type: "thread_ready",
      threadId,
    });
    onEvent({
      type: "turn_started",
      turnId,
    });

    const promptResult = await runDiagnosticStep("send_prompt", "Send prompt", async () => {
      return await connection.client.prompt({
        sessionId: threadId,
        messageId: randomUUID(),
        prompt: [
          {
            type: "text",
            text: input.message,
          },
        ],
      });
    });

    onEvent({
      type: "turn_completed",
      threadId,
      turnId,
      status: normalizeText(promptResult.stopReason) || (cancelled ? "cancelled" : "completed"),
      error: cancelled ? "Request cancelled." : null,
    });
  } catch (error) {
    throw error;
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    await connection.close();
  }
}
