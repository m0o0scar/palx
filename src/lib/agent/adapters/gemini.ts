import {
  ensureAcpInstalled,
  getAcpAppStatus,
  readAcpThreadHistory,
  startAcpLogin,
  streamAcpChat,
} from "@/lib/agent/transports/acp";

import type { AgentAdapter } from "./types";

export const geminiAdapter: AgentAdapter = {
  provider: "gemini",
  metadata: {
    id: "gemini",
    label: "Gemini CLI",
    description: "Google's coding agent runtime over ACP.",
    available: true,
  },
  getStatus: async () => await getAcpAppStatus("gemini"),
  ensureInstalled: async (onEvent) => await ensureAcpInstalled("gemini", onEvent),
  startLogin: async () => await startAcpLogin("gemini"),
  readThreadHistory: async (input) => await readAcpThreadHistory("gemini", input),
  streamChat: async (input, onEvent, signal, onDiagnostic, onRuntimeUpdate) =>
    await streamAcpChat("gemini", input, onEvent, signal, onDiagnostic, onRuntimeUpdate),
};
