import { NextResponse } from 'next/server';
import { getAgentAdapter, getDefaultAgentProvider } from '@/lib/agent/providers';
import type { AgentProvider } from '@/lib/types';

export const runtime = 'nodejs';

function normalizeProvider(value: unknown): AgentProvider {
  return value === 'codex' || value === 'gemini' || value === 'cursor'
    ? value
    : getDefaultAgentProvider();
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { provider?: AgentProvider };
  const provider = normalizeProvider(body.provider);

  try {
    const login = await getAgentAdapter(provider).startLogin();
    return NextResponse.json(login);
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Login failed.',
    }, { status: 400 });
  }
}
