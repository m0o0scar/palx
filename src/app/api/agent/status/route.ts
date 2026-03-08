import { NextRequest, NextResponse } from 'next/server';
import { getDefaultAgentProvider, getAgentAdapter, listAgentProviders } from '@/lib/agent/providers';
import type { AgentProvider } from '@/lib/types';

export const runtime = 'nodejs';

function normalizeProvider(value: string | null): AgentProvider {
  return value === 'codex' || value === 'gemini' || value === 'cursor'
    ? value
    : getDefaultAgentProvider();
}

export async function GET(request: NextRequest) {
  const provider = normalizeProvider(request.nextUrl.searchParams.get('provider'));

  try {
    const status = await getAgentAdapter(provider).getStatus();
    return NextResponse.json({
      providers: listAgentProviders(),
      defaultProvider: getDefaultAgentProvider(),
      status,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to load provider status.';
    return NextResponse.json({
      providers: listAgentProviders(),
      defaultProvider: getDefaultAgentProvider(),
      status: null,
      error: message,
    }, { status: 400 });
  }
}
