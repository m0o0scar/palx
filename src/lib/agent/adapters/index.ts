import type { AgentProvider, ProviderCatalogEntry } from "@/lib/agent/types";

import { codexAdapter } from "./codex";
import { cursorAdapter } from "./cursor";
import { geminiAdapter } from "./gemini";
import type { AgentAdapter } from "./types";

const catalog: ProviderCatalogEntry[] = [
  {
    id: "codex",
    label: "Codex CLI",
    description: "Official OpenAI coding agent runtime.",
    available: true,
  },
  {
    id: "claude",
    label: "Claude Code",
    description: "Reserved adapter slot for Anthropic's CLI.",
    available: false,
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    description: "Google's coding agent runtime over ACP.",
    available: true,
  },
  {
    id: "cursor",
    label: "Cursor Agent CLI",
    description: "Cursor's coding agent runtime over ACP.",
    available: true,
  },
];

const adapters = new Map<AgentProvider, AgentAdapter>([
  ["codex", codexAdapter],
  ["gemini", geminiAdapter],
  ["cursor", cursorAdapter],
]);

export function listProviders() {
  return [...catalog];
}

export function getDefaultProvider(): AgentProvider {
  return "codex";
}

export function getAdapter(provider: AgentProvider) {
  const adapter = adapters.get(provider);
  if (!adapter) {
    throw new Error(`${provider} is not implemented yet.`);
  }

  return adapter;
}
