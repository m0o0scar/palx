import { NextResponse } from 'next/server';
import { cancelSessionTurn } from '@/lib/agent/session-manager';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { sessionId?: string } | null;
  const result = await cancelSessionTurn(body?.sessionId ?? '');

  if (!result.success) {
    return NextResponse.json({ error: result.error || 'Failed to cancel agent turn.' }, { status: 400 });
  }

  return NextResponse.json(result);
}
