import { NextResponse } from 'next/server';

import { terminateSessionTurnSubprocess } from '@/lib/agent/session-manager';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    sessionId?: string;
    pid?: number;
  } | null;

  const result = await terminateSessionTurnSubprocess(
    body?.sessionId?.trim() || '',
    typeof body?.pid === 'number' ? body.pid : Number.NaN,
  );

  if (!result.success) {
    return NextResponse.json({
      error: result.error || 'Failed to terminate runtime subprocess.',
    }, { status: 400 });
  }

  return NextResponse.json({
    success: true,
    terminated: result.terminated ?? false,
  });
}
