import type { AgentProvider, ReasoningEffort } from "@/lib/types";

export function normalizeReasoningEffort(value: string | null | undefined): ReasoningEffort | undefined {
  const normalized = value?.trim();
  return normalized ? (normalized as ReasoningEffort) : undefined;
}

export function normalizeProviderReasoningEffort(
  provider: AgentProvider | string | null | undefined,
  reasoningEffort: string | null | undefined,
): ReasoningEffort | undefined {
  const normalized = normalizeReasoningEffort(reasoningEffort);
  if (!normalized) {
    return undefined;
  }

  // Palx always enables web search for Codex sessions, and Codex rejects that
  // tool combination when reasoning.effort is set to "minimal".
  if (provider === "codex" && normalized === "minimal") {
    return "low";
  }

  return normalized;
}

export function normalizeNullableProviderReasoningEffort(
  provider: AgentProvider | string | null | undefined,
  reasoningEffort: string | null | undefined,
): ReasoningEffort | null {
  return normalizeProviderReasoningEffort(provider, reasoningEffort) ?? null;
}
