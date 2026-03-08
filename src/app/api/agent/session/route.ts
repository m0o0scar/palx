import { NextRequest, NextResponse } from 'next/server';
import { getSessionAgentSnapshot, replaceSessionAgentHistory } from '@/app/actions/session';
import { getAgentAdapter } from '@/lib/agent/providers';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const sessionId = request.nextUrl.searchParams.get('sessionId')?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId is required.' }, { status: 400 });
  }

  const snapshotResult = await getSessionAgentSnapshot(sessionId);
  if (!snapshotResult.success || !snapshotResult.snapshot) {
    return NextResponse.json({
      error: snapshotResult.error || 'Session not found.',
    }, { status: 404 });
  }

  const snapshot = snapshotResult.snapshot;
  if (snapshot.history.length === 0 && snapshot.runtime.threadId) {
    try {
      const adapter = getAgentAdapter(snapshot.runtime.agentProvider);
      const thread = await adapter.readThreadHistory({
        workspacePath: snapshot.metadata.workspacePath,
        threadId: snapshot.runtime.threadId,
        model: snapshot.runtime.model,
        reasoningEffort: snapshot.runtime.reasoningEffort ?? null,
      });

      const history = thread.entries.map((entry, index) => ({
        ...entry,
        threadId: thread.threadId,
        ordinal: index,
      }));
      await replaceSessionAgentHistory(sessionId, history);
      const refreshed = await getSessionAgentSnapshot(sessionId);
      if (refreshed.success && refreshed.snapshot) {
        return NextResponse.json(refreshed.snapshot);
      }
    } catch {
      // Fall through to the persisted snapshot when provider replay is unavailable.
    }
  }

  return NextResponse.json(snapshot);
}
