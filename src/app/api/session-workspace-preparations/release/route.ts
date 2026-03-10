import { NextResponse } from 'next/server';
import { releasePreparedSessionWorkspace } from '@/app/actions/session';

export const runtime = 'nodejs';

type ReleasePreparedWorkspaceRequest = {
  preparationId?: unknown;
};

function normalizePreparationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as ReleasePreparedWorkspaceRequest | null;
    const preparationId = normalizePreparationId(body?.preparationId);
    if (!preparationId) {
      return NextResponse.json({ error: 'preparationId is required.' }, { status: 400 });
    }

    const result = await releasePreparedSessionWorkspace(preparationId);
    if (!result.success) {
      return NextResponse.json({ error: result.error || 'Failed to release prepared workspace.' }, { status: 500 });
    }

    return NextResponse.json({ success: true, released: result.released });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to release prepared workspace.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
