import { NextRequest, NextResponse } from 'next/server';

import { getAgentAdapter } from '@/lib/agent/providers';
import { errorMessage } from '@/lib/agent/http';
import { jsonError, parseProvider, parseReasoningEffort } from '@/lib/agent/route-utils';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const provider = parseProvider(request.nextUrl.searchParams.get('provider'));
  const workspacePath = request.nextUrl.searchParams.get('workspacePath')?.trim();
  const threadId = request.nextUrl.searchParams.get('threadId')?.trim();
  const model = request.nextUrl.searchParams.get('model')?.trim() || null;
  const reasoningEffort = parseReasoningEffort(request.nextUrl.searchParams.get('reasoningEffort'));

  if (!provider) {
    return jsonError('provider is required');
  }

  if (!workspacePath) {
    return jsonError('workspacePath is required');
  }

  if (!threadId) {
    return jsonError('threadId is required');
  }

  try {
    return NextResponse.json(
      await getAgentAdapter(provider).readThreadHistory({
        workspacePath,
        threadId,
        model,
        reasoningEffort,
      }),
    );
  } catch (error) {
    return jsonError(errorMessage(error), 500);
  }
}

