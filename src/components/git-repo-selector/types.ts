import type { Credential } from '@/lib/credentials';

export type RepoCredentialSelection = 'auto' | string;

export function getCredentialOptionLabel(credential: Credential): string {
  if (credential.type === 'github') {
    return `GitHub - ${credential.username}`;
  }

  let host = credential.serverUrl;
  try {
    host = new URL(credential.serverUrl).host;
  } catch {
    // Keep raw server URL if parsing fails.
  }

  return `GitLab - ${credential.username} @ ${host}`;
}
