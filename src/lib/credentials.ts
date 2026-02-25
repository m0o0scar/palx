import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const SERVICE_NAME = 'viba-git-credentials';
const CREDENTIALS_FILE_NAME = 'credentials.json';

export type CredentialType = 'github' | 'gitlab';

export interface BaseCredential {
  id: string;
  type: CredentialType;
  username: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubCredential extends BaseCredential {
  type: 'github';
}

export interface GitLabCredential extends BaseCredential {
  type: 'gitlab';
  serverUrl: string;
}

export type Credential = GitHubCredential | GitLabCredential;

type CredentialMetadata = {
  id: string;
  type: CredentialType;
  username: string;
  serverUrl?: string;
  createdAt: string;
  updatedAt: string;
  keytarAccount?: string;
};

type LegacyCredentialMetadata = {
  type: CredentialType;
  username: string;
  serverUrl?: string;
  createdAt: string;
  updatedAt: string;
};

type KeytarModule = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

let keytarPromise: Promise<KeytarModule | null> | null = null;
let keytarUnavailableReason: string | null = null;
let didLogKeytarWarning = false;

function keytarUnavailableMessage(): string {
  if (keytarUnavailableReason) {
    return `Secure credential storage is unavailable: ${keytarUnavailableReason}`;
  }
  return 'Secure credential storage is unavailable in this runtime.';
}

async function loadKeytar(): Promise<KeytarModule | null> {
  if (!keytarPromise) {
    keytarPromise = import('keytar')
      .then((module) => (module.default ?? module) as KeytarModule)
      .catch((error: unknown) => {
        keytarUnavailableReason = error instanceof Error ? error.message : String(error);
        if (!didLogKeytarWarning) {
          didLogKeytarWarning = true;
          console.warn(`[credentials] ${keytarUnavailableMessage()}`);
        }
        return null;
      });
  }

  return keytarPromise;
}

async function requireKeytar(): Promise<KeytarModule> {
  const keytar = await loadKeytar();
  if (!keytar) {
    throw new Error(keytarUnavailableMessage());
  }
  return keytar;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeGitLabServerUrl(serverUrl: string): string {
  return serverUrl.trim().replace(/\/$/, '');
}

function getDefaultKeytarAccount(id: string): string {
  return `credential-${id}`;
}

function getLegacyKeytarAccount(type: CredentialType): string {
  return `credential-${type}`;
}

function getKeytarAccountForMetadata(metadata: CredentialMetadata): string {
  return metadata.keytarAccount || getDefaultKeytarAccount(metadata.id);
}

function toCredential(metadata: CredentialMetadata): Credential {
  if (metadata.type === 'gitlab') {
    return {
      id: metadata.id,
      type: 'gitlab',
      username: metadata.username,
      serverUrl: metadata.serverUrl || 'https://gitlab.com',
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
    };
  }

  return {
    id: metadata.id,
    type: 'github',
    username: metadata.username,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  };
}

async function getCredentialsFilePath(): Promise<string> {
  const vibaDir = path.join(os.homedir(), '.viba');
  await fs.mkdir(vibaDir, { recursive: true });
  return path.join(vibaDir, CREDENTIALS_FILE_NAME);
}

function isLegacyCredentialMetadata(value: unknown, expectedType: CredentialType): value is LegacyCredentialMetadata {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;
  if (candidate.type !== expectedType) return false;
  if (typeof candidate.username !== 'string') return false;
  if (typeof candidate.createdAt !== 'string') return false;
  if (typeof candidate.updatedAt !== 'string') return false;

  if (expectedType === 'gitlab') {
    return typeof candidate.serverUrl === 'string';
  }

  return true;
}

function isCredentialMetadata(value: unknown): value is CredentialMetadata {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || !candidate.id.trim()) return false;
  if (candidate.type !== 'github' && candidate.type !== 'gitlab') return false;
  if (typeof candidate.username !== 'string') return false;
  if (typeof candidate.createdAt !== 'string') return false;
  if (typeof candidate.updatedAt !== 'string') return false;
  if (candidate.keytarAccount !== undefined && typeof candidate.keytarAccount !== 'string') return false;

  if (candidate.type === 'gitlab') {
    return typeof candidate.serverUrl === 'string';
  }

  return true;
}

async function writeCredentialsMetadata(metadata: CredentialMetadata[]): Promise<void> {
  const credentialsFilePath = await getCredentialsFilePath();
  await fs.writeFile(credentialsFilePath, JSON.stringify(metadata, null, 2), 'utf-8');
}

async function readCredentialsMetadata(): Promise<CredentialMetadata[]> {
  const credentialsFilePath = await getCredentialsFilePath();

  try {
    const content = await fs.readFile(credentialsFilePath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;

    if (Array.isArray(parsed)) {
      return parsed.filter(isCredentialMetadata);
    }

    if (!parsed || typeof parsed !== 'object') {
      return [];
    }

    const legacyMapped = parsed as Record<string, unknown>;
    const migrated: CredentialMetadata[] = [];

    if (isLegacyCredentialMetadata(legacyMapped.github, 'github')) {
      const metadata = legacyMapped.github;
      migrated.push({
        id: generateId(),
        type: 'github',
        username: metadata.username,
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
        keytarAccount: getLegacyKeytarAccount('github'),
      });
    }

    if (isLegacyCredentialMetadata(legacyMapped.gitlab, 'gitlab')) {
      const metadata = legacyMapped.gitlab;
      migrated.push({
        id: generateId(),
        type: 'gitlab',
        username: metadata.username,
        serverUrl: metadata.serverUrl,
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt,
        keytarAccount: getLegacyKeytarAccount('gitlab'),
      });
    }

    if (migrated.length > 0) {
      await writeCredentialsMetadata(migrated);
    }

    return migrated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return [];
    }

    console.error('Failed to parse credentials metadata:', error);
    return [];
  }
}

export async function getAllCredentials(): Promise<Credential[]> {
  const metadata = await readCredentialsMetadata();

  return metadata
    .map(toCredential)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getCredentialById(id: string): Promise<Credential | null> {
  const metadata = await readCredentialsMetadata();
  const found = metadata.find((credential) => credential.id === id);
  return found ? toCredential(found) : null;
}

export async function getCredentialToken(id: string): Promise<string | null> {
  const metadata = await readCredentialsMetadata();
  const found = metadata.find((credential) => credential.id === id);
  if (!found) {
    return null;
  }

  const keytar = await loadKeytar();
  if (!keytar) {
    return null;
  }

  return keytar.getPassword(SERVICE_NAME, getKeytarAccountForMetadata(found));
}

async function verifyGitHubToken(token: string): Promise<{ valid: boolean; username?: string; error?: string }> {
  try {
    const response = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return { valid: false, error: 'Invalid or expired GitHub token.' };
      }
      return { valid: false, error: `GitHub API returned ${response.status}.` };
    }

    const data = await response.json();
    const username = typeof data?.login === 'string' ? data.login : null;
    if (!username) {
      return { valid: false, error: 'GitHub API response did not include a username.' };
    }

    return { valid: true, username };
  } catch (error) {
    return { valid: false, error: `Failed to verify GitHub token: ${(error as Error).message}` };
  }
}

async function verifyGitLabToken(serverUrl: string, token: string): Promise<{ valid: boolean; username?: string; error?: string }> {
  try {
    const normalizedUrl = normalizeGitLabServerUrl(serverUrl);
    const response = await fetch(`${normalizedUrl}/api/v4/user`, {
      headers: {
        'PRIVATE-TOKEN': token,
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return { valid: false, error: 'Invalid or expired GitLab token.' };
      }
      return { valid: false, error: `GitLab API returned ${response.status}.` };
    }

    const data = await response.json();
    const username = typeof data?.username === 'string' ? data.username : null;
    if (!username) {
      return { valid: false, error: 'GitLab API response did not include a username.' };
    }

    return { valid: true, username };
  } catch (error) {
    return { valid: false, error: `Failed to verify GitLab token: ${(error as Error).message}` };
  }
}

export async function createGitHubCredential(token: string): Promise<{ success: boolean; credential?: GitHubCredential; error?: string }> {
  const trimmedToken = token.trim();
  if (!trimmedToken) {
    return { success: false, error: 'GitHub token is required.' };
  }

  let keytar: KeytarModule;
  try {
    keytar = await requireKeytar();
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }

  const verification = await verifyGitHubToken(trimmedToken);
  if (!verification.valid || !verification.username) {
    return { success: false, error: verification.error || 'Failed to verify GitHub token.' };
  }

  const metadata = await readCredentialsMetadata();
  const duplicate = metadata.find((credential) => (
    credential.type === 'github'
    && credential.username === verification.username
  ));

  if (duplicate) {
    return { success: false, error: `A GitHub credential for ${verification.username} already exists.` };
  }

  const id = generateId();
  const now = new Date().toISOString();
  const keytarAccount = getDefaultKeytarAccount(id);

  await keytar.setPassword(SERVICE_NAME, keytarAccount, trimmedToken);

  const created: CredentialMetadata = {
    id,
    type: 'github',
    username: verification.username,
    createdAt: now,
    updatedAt: now,
    keytarAccount,
  };

  metadata.push(created);
  await writeCredentialsMetadata(metadata);

  return {
    success: true,
    credential: {
      id: created.id,
      type: 'github',
      username: created.username,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    },
  };
}

export async function createGitLabCredential(
  serverUrl: string,
  token: string,
): Promise<{ success: boolean; credential?: GitLabCredential; error?: string }> {
  const normalizedServerUrl = normalizeGitLabServerUrl(serverUrl);
  const trimmedToken = token.trim();

  if (!normalizedServerUrl) {
    return { success: false, error: 'GitLab server URL is required.' };
  }

  try {
    new URL(normalizedServerUrl);
  } catch {
    return { success: false, error: 'GitLab server URL must be a valid URL.' };
  }

  if (!trimmedToken) {
    return { success: false, error: 'GitLab token is required.' };
  }

  let keytar: KeytarModule;
  try {
    keytar = await requireKeytar();
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }

  const verification = await verifyGitLabToken(normalizedServerUrl, trimmedToken);
  if (!verification.valid || !verification.username) {
    return { success: false, error: verification.error || 'Failed to verify GitLab token.' };
  }

  const metadata = await readCredentialsMetadata();
  const duplicate = metadata.find((credential) => (
    credential.type === 'gitlab'
    && credential.username === verification.username
    && credential.serverUrl === normalizedServerUrl
  ));

  if (duplicate) {
    return {
      success: false,
      error: `A GitLab credential for ${verification.username} on ${normalizedServerUrl} already exists.`,
    };
  }

  const id = generateId();
  const now = new Date().toISOString();
  const keytarAccount = getDefaultKeytarAccount(id);

  await keytar.setPassword(SERVICE_NAME, keytarAccount, trimmedToken);

  const created: CredentialMetadata = {
    id,
    type: 'gitlab',
    username: verification.username,
    serverUrl: normalizedServerUrl,
    createdAt: now,
    updatedAt: now,
    keytarAccount,
  };

  metadata.push(created);
  await writeCredentialsMetadata(metadata);

  return {
    success: true,
    credential: {
      id: created.id,
      type: 'gitlab',
      username: created.username,
      serverUrl: created.serverUrl || normalizedServerUrl,
      createdAt: created.createdAt,
      updatedAt: created.updatedAt,
    },
  };
}

export async function deleteCredential(id: string): Promise<{ success: boolean; error?: string }> {
  const metadata = await readCredentialsMetadata();
  const index = metadata.findIndex((credential) => credential.id === id);

  if (index === -1) {
    return { success: false, error: 'Credential not found.' };
  }

  const credential = metadata[index];
  metadata.splice(index, 1);
  await writeCredentialsMetadata(metadata);

  const keytar = await loadKeytar();
  if (keytar) {
    await keytar.deletePassword(SERVICE_NAME, getKeytarAccountForMetadata(credential));
  }

  return { success: true };
}
