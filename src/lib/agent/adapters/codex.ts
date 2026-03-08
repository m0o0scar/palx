import {
  ensureCodexInstalled,
  getAppStatus,
  readThreadHistory,
  startLogin,
  streamChat,
} from "@/lib/agent/transports/codex";

import type { AgentAdapter } from "./types";

export const codexAdapter: AgentAdapter = {
  provider: "codex",
  metadata: {
    id: "codex",
    label: "Codex CLI",
    description: "Official OpenAI coding agent runtime.",
    available: true,
  },
  getStatus: getAppStatus,
  ensureInstalled: ensureCodexInstalled,
  startLogin: async () => {
    const login = await startLogin();
    return {
      kind: "browser",
      authUrl: login.authUrl,
      loginId: login.loginId,
      message: "Finish the ChatGPT sign-in, then return here.",
    };
  },
  readThreadHistory,
  streamChat,
};
