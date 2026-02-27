import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const SERVICE_NAME = 'viba-agent-api-credentials';
const CONFIGS_FILE_NAME = 'agent-api-configs.json';
const SUPPORTED_AGENT_APIS = ['codex'] as const;

export type AgentApiCredentialAgent = typeof SUPPORTED_AGENT_APIS[number];

export interface AgentApiCredential {
  agent: AgentApiCredentialAgent;
  apiProxy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentApiCredentialSecret {
  agent: AgentApiCredentialAgent;
  apiKey: string;
  apiProxy?: string;
}

type AgentApiCredentialMetadata = {
  agent: AgentApiCredentialAgent;
  apiProxy?: string;
  createdAt: string;
  updatedAt: string;
  keytarAccount?: string;
};

type KeytarModule = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

let keytarPromise: Promise<KeytarModule | null> | null = null;
let keytarUnavailableReason: string | null = null;
let didLogKeytarWarning = false;

function isSupportedAgentApi(value: string): value is AgentApiCredentialAgent {
  return SUPPORTED_AGENT_APIS.includes(value as AgentApiCredentialAgent);
}

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
          console.warn(`[agent-api-credentials] ${keytarUnavailableMessage()}`);
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

function getDefaultKeytarAccount(agent: AgentApiCredentialAgent): string {
  return `agent-api-${agent}`;
}

function getKeytarAccountForMetadata(metadata: AgentApiCredentialMetadata): string {
  return metadata.keytarAccount || getDefaultKeytarAccount(metadata.agent);
}

function normalizeApiProxy(apiProxy: string): string | undefined {
  const trimmed = apiProxy.trim();
  if (!trimmed) return undefined;

  try {
    // Validate and persist as-entered once it is a valid URL.
    new URL(trimmed);
  } catch {
    throw new Error('API proxy must be a valid URL.');
  }

  return trimmed;
}

function toAgentApiCredential(metadata: AgentApiCredentialMetadata): AgentApiCredential {
  return {
    agent: metadata.agent,
    apiProxy: metadata.apiProxy,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  };
}

function isAgentApiCredentialMetadata(value: unknown): value is AgentApiCredentialMetadata {
  if (!value || typeof value !== 'object') return false;

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.agent !== 'string' || !isSupportedAgentApi(candidate.agent)) return false;
  if (typeof candidate.createdAt !== 'string') return false;
  if (typeof candidate.updatedAt !== 'string') return false;
  if (candidate.apiProxy !== undefined && typeof candidate.apiProxy !== 'string') return false;
  if (candidate.keytarAccount !== undefined && typeof candidate.keytarAccount !== 'string') return false;

  return true;
}

async function getConfigsFilePath(): Promise<string> {
  const vibaDir = path.join(os.homedir(), '.viba');
  await fs.mkdir(vibaDir, { recursive: true });
  return path.join(vibaDir, CONFIGS_FILE_NAME);
}

async function writeAgentApiCredentialMetadata(metadata: AgentApiCredentialMetadata[]): Promise<void> {
  const configsFilePath = await getConfigsFilePath();
  await fs.writeFile(configsFilePath, JSON.stringify(metadata, null, 2), 'utf-8');
}

async function readAgentApiCredentialMetadata(): Promise<AgentApiCredentialMetadata[]> {
  const configsFilePath = await getConfigsFilePath();

  try {
    const content = await fs.readFile(configsFilePath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;

    if (Array.isArray(parsed)) {
      return parsed.filter(isAgentApiCredentialMetadata);
    }

    if (!parsed || typeof parsed !== 'object') {
      return [];
    }

    // Legacy map shape: { codex: { ... }, ... }
    const entries = Object.entries(parsed as Record<string, unknown>);
    const migrated = entries
      .filter(([agent]) => isSupportedAgentApi(agent))
      .map(([agent, value]) => {
        if (!value || typeof value !== 'object') return null;
        const candidate = value as Record<string, unknown>;
        if (candidate.agent === undefined) {
          return {
            ...candidate,
            agent,
          } as unknown;
        }
        return candidate;
      })
      .filter(isAgentApiCredentialMetadata);

    if (migrated.length > 0) {
      await writeAgentApiCredentialMetadata(migrated);
    }

    return migrated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return [];
    }

    console.error('Failed to parse agent API credential metadata:', error);
    return [];
  }
}

export async function getAllAgentApiCredentials(): Promise<AgentApiCredential[]> {
  const metadata = await readAgentApiCredentialMetadata();
  return metadata
    .map(toAgentApiCredential)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function createOrUpdateAgentApiCredential(
  agent: AgentApiCredentialAgent,
  apiKey: string,
  apiProxy: string,
): Promise<{ success: boolean; credential?: AgentApiCredential; error?: string }> {
  if (!isSupportedAgentApi(agent)) {
    return { success: false, error: `Unsupported agent: ${agent}` };
  }

  const trimmedApiKey = apiKey.trim();
  if (!trimmedApiKey) {
    return { success: false, error: 'API key is required.' };
  }

  let normalizedApiProxy: string | undefined;
  try {
    normalizedApiProxy = normalizeApiProxy(apiProxy);
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }

  let keytar: KeytarModule;
  try {
    keytar = await requireKeytar();
  } catch (error) {
    return { success: false, error: (error as Error).message };
  }

  const metadata = await readAgentApiCredentialMetadata();
  const now = new Date().toISOString();
  const index = metadata.findIndex((credential) => credential.agent === agent);
  const keytarAccount = index >= 0
    ? getKeytarAccountForMetadata(metadata[index])
    : getDefaultKeytarAccount(agent);

  await keytar.setPassword(SERVICE_NAME, keytarAccount, trimmedApiKey);

  if (index >= 0) {
    const existing = metadata[index];
    metadata[index] = {
      ...existing,
      apiProxy: normalizedApiProxy,
      updatedAt: now,
      keytarAccount,
    };
  } else {
    metadata.push({
      agent,
      apiProxy: normalizedApiProxy,
      createdAt: now,
      updatedAt: now,
      keytarAccount,
    });
  }

  await writeAgentApiCredentialMetadata(metadata);

  const saved = metadata.find((credential) => credential.agent === agent);
  if (!saved) {
    return { success: false, error: 'Failed to persist agent API credential.' };
  }

  return { success: true, credential: toAgentApiCredential(saved) };
}

export async function deleteAgentApiCredential(
  agent: AgentApiCredentialAgent,
): Promise<{ success: boolean; error?: string }> {
  if (!isSupportedAgentApi(agent)) {
    return { success: false, error: `Unsupported agent: ${agent}` };
  }

  const metadata = await readAgentApiCredentialMetadata();
  const index = metadata.findIndex((credential) => credential.agent === agent);
  if (index === -1) {
    return { success: false, error: 'Agent API credential not found.' };
  }

  const [removed] = metadata.splice(index, 1);
  await writeAgentApiCredentialMetadata(metadata);

  const keytar = await loadKeytar();
  if (keytar) {
    await keytar.deletePassword(SERVICE_NAME, getKeytarAccountForMetadata(removed));
  }

  return { success: true };
}

export async function getAgentApiCredentialSecret(
  agent: AgentApiCredentialAgent,
): Promise<AgentApiCredentialSecret | null> {
  if (!isSupportedAgentApi(agent)) {
    return null;
  }

  const metadata = await readAgentApiCredentialMetadata();
  const found = metadata.find((credential) => credential.agent === agent);
  if (!found) {
    return null;
  }

  const keytar = await loadKeytar();
  if (!keytar) {
    return null;
  }

  const apiKey = await keytar.getPassword(SERVICE_NAME, getKeytarAccountForMetadata(found));
  if (!apiKey) {
    return null;
  }

  return {
    agent: found.agent,
    apiKey,
    apiProxy: found.apiProxy,
  };
}
