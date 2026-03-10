import { NextRequest, NextResponse } from 'next/server';
import { getSessionAgentSnapshot, replaceSessionAgentHistory } from '@/app/actions/session';
import { getAgentAdapter } from '@/lib/agent/providers';
import { enrichSessionRuntimeWithDiagnostics } from '@/lib/agent/session-manager';

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
  const enrichedSnapshot = {
    ...snapshot,
    runtime: enrichSessionRuntimeWithDiagnostics(sessionId, snapshot.runtime) ?? snapshot.runtime,
  };
  if (enrichedSnapshot.history.length === 0 && enrichedSnapshot.runtime.threadId) {
    try {
      const adapter = getAgentAdapter(enrichedSnapshot.runtime.agentProvider);
      const thread = await adapter.readThreadHistory({
        workspacePath: enrichedSnapshot.metadata.workspacePath,
        threadId: enrichedSnapshot.runtime.threadId,
        model: enrichedSnapshot.runtime.model,
        reasoningEffort: enrichedSnapshot.runtime.reasoningEffort ?? null,
      });

      const history = thread.entries.map((entry, index) => ({
        ...entry,
        threadId: thread.threadId,
        ordinal: index,
      }));
      await replaceSessionAgentHistory(sessionId, history);
      const refreshed = await getSessionAgentSnapshot(sessionId);
      if (refreshed.success && refreshed.snapshot) {
        return NextResponse.json({
          ...refreshed.snapshot,
          runtime: enrichSessionRuntimeWithDiagnostics(sessionId, refreshed.snapshot.runtime) ?? refreshed.snapshot.runtime,
        });
      }
    } catch {
      // Fall through to the persisted snapshot when provider replay is unavailable.
    }
  }

  return NextResponse.json(enrichedSnapshot);
}
