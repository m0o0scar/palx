import { NextResponse } from 'next/server';

import type { AgentProvider, ReasoningEffort } from '@/lib/agent/types';

const PROVIDERS = new Set<AgentProvider>(['codex', 'claude', 'gemini', 'cursor']);
const REASONING_EFFORTS = new Set<ReasoningEffort>(['minimal', 'low', 'medium', 'high', 'xhigh']);

export function asTrimmedString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function asBoolean(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') {
      return true;
    }
    if (normalized === 'false' || normalized === '0') {
      return false;
    }
  }

  return null;
}

export function parseProvider(value: unknown): AgentProvider | null {
  const provider = asTrimmedString(value) as AgentProvider | null;
  if (!provider || !PROVIDERS.has(provider)) {
    return null;
  }

  return provider;
}

export function parseReasoningEffort(value: unknown): ReasoningEffort | null {
  const effort = asTrimmedString(value) as ReasoningEffort | null;
  if (!effort || !REASONING_EFFORTS.has(effort)) {
    return null;
  }

  return effort;
}

export async function readJsonObject(request: Request) {
  const body = (await request.json()) as unknown;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Invalid request payload');
  }

  return body as Record<string, unknown>;
}

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}
