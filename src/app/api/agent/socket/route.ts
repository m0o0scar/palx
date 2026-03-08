import { NextRequest, NextResponse } from 'next/server';
import { buildSessionAgentWsUrl, ensureSessionNotificationServer } from '@/lib/sessionNotificationServer';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('sessionId')?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId is required.' }, { status: 400 });
  }

  try {
    const { wsBaseUrl } = await ensureSessionNotificationServer();
    return NextResponse.json({
      wsUrl: buildSessionAgentWsUrl(wsBaseUrl, sessionId),
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Failed to initialize agent socket.',
    }, { status: 500 });
  }
}
