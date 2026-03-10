import { NextResponse } from 'next/server';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { GitService } from '@/lib/git';
import { addProject, getProjects } from '@/lib/store';
import { findCredentialForRemote, getCredentialById, getCredentialToken } from '@/lib/credentials';

const cloneProjectSchema = z.object({
  repoUrl: z.string().min(1, 'Repository URL is required'),
  destinationParent: z.string().min(1, 'Destination parent folder is required'),
  folderName: z.string().optional(),
  credentialId: z.string().nullable().optional(),
});

function inferFolderNameFromRepoUrl(repoUrl: string): string | null {
  const sanitized = repoUrl.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (!sanitized) return null;

  const lastSlashIndex = sanitized.lastIndexOf('/');
  const lastColonIndex = sanitized.lastIndexOf(':');
  const splitIndex = Math.max(lastSlashIndex, lastColonIndex);
  const rawName = splitIndex >= 0 ? sanitized.slice(splitIndex + 1) : sanitized;
  const normalized = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName;
  const trimmed = normalized.trim();

  return trimmed.length > 0 ? trimmed : null;
}

function normalizeFolderName(rawFolderName: string): string {
  const trimmed = rawFolderName.trim();
  if (!trimmed) {
    throw new Error('Destination folder name is required');
  }
  if (trimmed === '.' || trimmed === '..') {
    throw new Error('Invalid destination folder name');
  }
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new Error('Destination folder name cannot include path separators');
  }
  if (path.posix.basename(trimmed) !== trimmed || path.win32.basename(trimmed) !== trimmed) {
    throw new Error('Invalid destination folder name');
  }
  return trimmed;
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { repoUrl, destinationParent, folderName, credentialId } = cloneProjectSchema.parse(body);

    const normalizedParent = path.resolve(destinationParent.trim());
    if (!fs.existsSync(normalizedParent)) {
      return NextResponse.json({ error: `Destination parent folder not found: ${normalizedParent}` }, { status: 404 });
    }
    if (!fs.statSync(normalizedParent).isDirectory()) {
      return NextResponse.json({ error: `Destination parent is not a directory: ${normalizedParent}` }, { status: 400 });
    }

    const inferredFolderName = folderName?.trim() || inferFolderNameFromRepoUrl(repoUrl);
    if (!inferredFolderName) {
      return NextResponse.json({ error: 'Unable to infer destination folder name from repository URL. Please provide folder name.' }, { status: 400 });
    }

    const normalizedFolderName = normalizeFolderName(inferredFolderName);
    const destinationPath = path.join(normalizedParent, normalizedFolderName);
    const normalizedDestinationPath = path.resolve(destinationPath);

    const existingProject = getProjects().find((project) => path.resolve(project.path) === normalizedDestinationPath);
    if (existingProject) {
      return NextResponse.json({ error: 'Project already exists' }, { status: 400 });
    }

    if (fs.existsSync(normalizedDestinationPath)) {
      const stat = fs.statSync(normalizedDestinationPath);
      if (!stat.isDirectory()) {
        return NextResponse.json({ error: `Destination path is not a folder: ${normalizedDestinationPath}` }, { status: 400 });
      }
      const entries = fs.readdirSync(normalizedDestinationPath);
      if (entries.length > 0) {
        return NextResponse.json({ error: 'Destination folder already exists and is not empty' }, { status: 400 });
      }
    }

    let credentialsForClone: { username: string; token: string } | undefined;

    if (credentialId) {
      const selectedCredential = await getCredentialById(credentialId);
      if (!selectedCredential) {
        return NextResponse.json({ error: 'Selected credential not found' }, { status: 400 });
      }
      const token = await getCredentialToken(selectedCredential.id);
      if (!token) {
        return NextResponse.json({ error: 'Selected credential token is unavailable' }, { status: 400 });
      }
      credentialsForClone = { username: selectedCredential.username, token };
    } else {
      const matchedCredential = await findCredentialForRemote(repoUrl);
      if (matchedCredential) {
        credentialsForClone = {
          username: matchedCredential.credential.username,
          token: matchedCredential.token,
        };
      }
    }

    await GitService.cloneRepository(repoUrl, normalizedDestinationPath, {
      credentials: credentialsForClone,
    });

    const project = addProject(normalizedDestinationPath, normalizedFolderName);

    return NextResponse.json({
      ...project,
      usedCredentialId: credentialId ?? null,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0]?.message ?? 'Invalid clone payload' }, { status: 400 });
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
