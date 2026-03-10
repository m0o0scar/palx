import { NextRequest, NextResponse } from 'next/server';

import { listSessionTurnSubprocesses } from '@/lib/agent/session-manager';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('sessionId')?.trim() || '';
  const result = await listSessionTurnSubprocesses(sessionId);

  if (!result.success) {
    return NextResponse.json({
      error: result.error || 'Failed to list runtime subprocesses.',
    }, { status: 400 });
  }

  return NextResponse.json({
    runtimePid: result.runtimePid ?? null,
    subprocesses: result.subprocesses ?? [],
  });
}
