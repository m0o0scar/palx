'use server';

import {
  createGitHubCredential,
  createGitLabCredential,
  deleteCredential,
  getAllCredentials,
} from '@/lib/credentials';
import type { Credential } from '@/lib/credentials';

type ListCredentialsResult =
  | { success: true; credentials: Credential[] }
  | { success: false; error: string };

export async function listCredentials(): Promise<ListCredentialsResult> {
  try {
    const credentials = await getAllCredentials();
    return { success: true, credentials };
  } catch (error) {
    console.error('Failed to list credentials:', error);
    return { success: false, error: 'Failed to load credentials.' };
  }
}

type SaveCredentialResult =
  | { success: true; credential: Credential }
  | { success: false; error: string };

export async function saveGitHubCredential(token: string): Promise<SaveCredentialResult> {
  const result = await createGitHubCredential(token);
  if (!result.success || !result.credential) {
    return { success: false, error: result.error || 'Failed to save GitHub credential.' };
  }

  return { success: true, credential: result.credential };
}

export async function saveGitLabCredential(serverUrl: string, token: string): Promise<SaveCredentialResult> {
  const result = await createGitLabCredential(serverUrl, token);
  if (!result.success || !result.credential) {
    return { success: false, error: result.error || 'Failed to save GitLab credential.' };
  }

  return { success: true, credential: result.credential };
}

type RemoveCredentialResult =
  | { success: true }
  | { success: false; error: string };

export async function removeCredential(id: string): Promise<RemoveCredentialResult> {
  try {
    const result = await deleteCredential(id);
    if (!result.success) {
      return { success: false, error: result.error || 'Failed to remove credential.' };
    }

    return { success: true };
  } catch (error) {
    console.error('Failed to remove credential:', error);
    return { success: false, error: 'Failed to remove credential.' };
  }
}
