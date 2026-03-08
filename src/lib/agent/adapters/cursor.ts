import {
  ensureAcpInstalled,
  getAcpAppStatus,
  readAcpThreadHistory,
  startAcpLogin,
  streamAcpChat,
} from "@/lib/agent/transports/acp";

import type { AgentAdapter } from "./types";

export const cursorAdapter: AgentAdapter = {
  provider: "cursor",
  metadata: {
    id: "cursor",
    label: "Cursor Agent CLI",
    description: "Cursor's coding agent runtime over ACP.",
    available: true,
  },
  getStatus: async () => await getAcpAppStatus("cursor"),
  ensureInstalled: async (onEvent) => await ensureAcpInstalled("cursor", onEvent),
  startLogin: async () => await startAcpLogin("cursor"),
  readThreadHistory: async (input) => await readAcpThreadHistory("cursor", input),
  streamChat: async (input, onEvent, signal) =>
    await streamAcpChat("cursor", input, onEvent, signal),
};
