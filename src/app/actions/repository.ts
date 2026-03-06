'use server';

import {
  cloneRemoteProject,
  resolveProjectByName,
  type CloneRemoteProjectResult,
  type ResolveProjectResult,
} from '@/app/actions/project';

export async function resolveRepositoryByName(repoName: string): Promise<{
  success: boolean;
  repoPath: string | null;
  error?: string;
}> {
  const result: ResolveProjectResult = await resolveProjectByName(repoName);
  return {
    success: result.success,
    repoPath: result.projectPath,
    error: result.error,
  };
}

export async function cloneRemoteRepository(
  remoteUrl: string,
  credentialId: string | null,
): Promise<{
  success: boolean;
  repoPath: string | null;
  error?: string;
}> {
  const result: CloneRemoteProjectResult = await cloneRemoteProject(remoteUrl, credentialId);
  return {
    success: result.success,
    repoPath: result.projectPath,
    error: result.error,
  };
}
