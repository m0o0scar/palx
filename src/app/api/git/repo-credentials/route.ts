import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getGitRepoCredential, setGitRepoCredential } from '@/app/actions/config';

const querySchema = z.object({
  path: z.string().min(1),
});

const updateSchema = z.object({
  repoPath: z.string().min(1),
  credentialId: z.string().nullable(),
});

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const { path } = querySchema.parse({ path: searchParams.get('path') });
    const credentialId = await getGitRepoCredential(path);
    return NextResponse.json({ repoPath: path, credentialId });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    }
    return NextResponse.json({ error: (error as Error).message || 'Failed to load credential mapping.' }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { repoPath, credentialId } = updateSchema.parse(body);
    await setGitRepoCredential(repoPath, credentialId);
    return NextResponse.json({ success: true, repoPath, credentialId: credentialId?.trim() || null });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message ?? 'Invalid request' }, { status: 400 });
    }
    return NextResponse.json({ error: (error as Error).message || 'Failed to update credential mapping.' }, { status: 500 });
  }
}
