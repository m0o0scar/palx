#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SERVER_NAME = "viba-agent-notify";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2024-11-05";
const TOOL_NAME = "notify_reply_finished";
const TOOL_DESCRIPTION = "Notify Viba session page that the agent has finished replying.";

function sanitizeSessionName(value) {
  const safe = String(value || "").trim().replace(/[^a-zA-Z0-9._-]/g, "-");
  return safe || "session";
}

function parseSessionNameArg(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--session") {
      return argv[i + 1] || "";
    }
  }
  return "";
}

function resolveDefaultSessionName() {
  const fromArg = parseSessionNameArg(process.argv.slice(2));
  if (fromArg) return sanitizeSessionName(fromArg);

  const fromEnv = process.env.VIBA_SESSION_NAME;
  if (fromEnv) return sanitizeSessionName(fromEnv);

  const fromCwd = path.basename(process.cwd());
  return sanitizeSessionName(fromCwd);
}

function buildNotificationFilePath(sessionName) {
  const notificationsDir = path.join(os.homedir(), ".viba", "session-notifications");
  return {
    notificationsDir,
    filePath: path.join(notificationsDir, `${sanitizeSessionName(sessionName)}.jsonl`),
  };
}

async function appendReplyFinishedEvent(input) {
  const sessionName = sanitizeSessionName(input?.sessionName || resolveDefaultSessionName());
  const messageText = typeof input?.message === "string" ? input.message.trim() : "";
  const message = messageText || "Agent finished replying";

  const { notificationsDir, filePath } = buildNotificationFilePath(sessionName);
  const now = new Date().toISOString();
  const event = {
    id: `${now}-${Math.random().toString(16).slice(2, 10)}`,
    type: "reply_finished",
    timestamp: now,
    message,
    source: "mcp",
  };

  await fs.mkdir(notificationsDir, { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, "utf-8");

  return { sessionName, message, event };
}

function sendPacket(payload) {
  const body = JSON.stringify(payload);
  const byteLength = Buffer.byteLength(body, "utf8");
  process.stdout.write(`Content-Length: ${byteLength}\r\n\r\n${body}`);
}

function sendResult(id, result) {
  sendPacket({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function sendError(id, code, message) {
  sendPacket({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

async function handleRequest(message) {
  const id = message.id;
  const method = message.method;

  if (method === "initialize") {
    const requestedProtocol =
      message?.params && typeof message.params.protocolVersion === "string"
        ? message.params.protocolVersion
        : PROTOCOL_VERSION;
    sendResult(id, {
      protocolVersion: requestedProtocol,
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
    });
    return;
  }

  if (method === "notifications/initialized") {
    return;
  }

  if (method === "ping") {
    sendResult(id, {});
    return;
  }

  if (method === "tools/list") {
    sendResult(id, {
      tools: [
        {
          name: TOOL_NAME,
          description: TOOL_DESCRIPTION,
          inputSchema: {
            type: "object",
            properties: {
              message: {
                type: "string",
                description: "Optional user-facing notification message.",
              },
              sessionName: {
                type: "string",
                description: "Optional session name override.",
              },
            },
            additionalProperties: false,
          },
        },
      ],
    });
    return;
  }

  if (method === "tools/call") {
    const params = message.params || {};
    if (params.name !== TOOL_NAME) {
      sendError(id, -32601, `Unknown tool: ${params.name || ""}`);
      return;
    }

    try {
      const { sessionName, message: resolvedMessage } = await appendReplyFinishedEvent(params.arguments || {});
      sendResult(id, {
        content: [
          {
            type: "text",
            text: `Notified session ${sessionName}: ${resolvedMessage}`,
          },
        ],
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      sendResult(id, {
        isError: true,
        content: [
          {
            type: "text",
            text: `Failed to notify session: ${errorMessage}`,
          },
        ],
      });
    }
    return;
  }

  if (id !== undefined) {
    sendError(id, -32601, `Method not found: ${method || ""}`);
  }
}

let inputBuffer = Buffer.alloc(0);

function processInputBuffer() {
  while (true) {
    const headerEndIndex = inputBuffer.indexOf("\r\n\r\n");
    if (headerEndIndex === -1) return;

    const headerText = inputBuffer.slice(0, headerEndIndex).toString("utf8");
    const contentLengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
    if (!contentLengthMatch) {
      inputBuffer = Buffer.alloc(0);
      return;
    }

    const contentLength = Number.parseInt(contentLengthMatch[1], 10);
    const messageStartIndex = headerEndIndex + 4;
    const messageEndIndex = messageStartIndex + contentLength;
    if (inputBuffer.length < messageEndIndex) return;

    const bodyText = inputBuffer.slice(messageStartIndex, messageEndIndex).toString("utf8");
    inputBuffer = inputBuffer.slice(messageEndIndex);

    let parsedMessage;
    try {
      parsedMessage = JSON.parse(bodyText);
    } catch {
      continue;
    }

    Promise.resolve(handleRequest(parsedMessage)).catch(() => {
      // Keep server alive on handler failures.
    });
  }
}

process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  processInputBuffer();
});

process.stdin.on("error", () => {
  process.exit(1);
});

