import { NextResponse } from 'next/server';
import { updateProjectSettings } from '@/app/actions/config';
import { normalizeProviderReasoningEffort } from '@/lib/agent/reasoning';
import type { AgentProvider } from '@/lib/types';

type UpdateProjectSettingsRequest = {
  projectPath?: unknown;
  updates?: {
    agentProvider?: unknown;
    agentModel?: unknown;
    agentReasoningEffort?: unknown;
  };
};

function normalizeProvider(value: unknown): AgentProvider | undefined {
  return value === 'codex' || value === 'gemini' || value === 'cursor'
    ? value
    : undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as UpdateProjectSettingsRequest;
    const projectPath = normalizeOptionalString(body.projectPath);
    if (!projectPath) {
      return NextResponse.json({ error: 'projectPath is required.' }, { status: 400 });
    }

    const agentProvider = normalizeProvider(body.updates?.agentProvider);
    const agentModel = normalizeOptionalString(body.updates?.agentModel);
    const agentReasoningEffort = normalizeProviderReasoningEffort(
      agentProvider,
      normalizeOptionalString(body.updates?.agentReasoningEffort),
    );

    const config = await updateProjectSettings(projectPath, {
      agentProvider,
      agentModel,
      agentReasoningEffort,
    });

    return NextResponse.json({ config });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update project settings.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
