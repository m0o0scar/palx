'use server';

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export interface RepoSettings {
  agentProvider?: string;
  agentModel?: string;
  startupScript?: string;
  devServerScript?: string;
  lastBranch?: string;
  credentialId?: string | null;
  credentialPreference?: 'auto' | 'github' | 'gitlab';
}

export interface Config {
  recentRepos: string[];
  defaultRoot: string;
  selectedIde: string;
  agentWidth: number;
  repoSettings: Record<string, RepoSettings>;
  pinnedFolderShortcuts: string[];
}

const DEFAULT_CONFIG: Config = {
  recentRepos: [],
  defaultRoot: '',
  selectedIde: 'vscode',
  agentWidth: 66.666,
  repoSettings: {},
  pinnedFolderShortcuts: [],
};

async function getConfigPath(): Promise<string> {
  const homedir = os.homedir();
  const vibaDir = path.join(homedir, '.viba');
  try {
    await fs.mkdir(vibaDir, { recursive: true });
  } catch (error) {
    // Ignore if exists
  }
  return path.join(vibaDir, 'config.json');
}

export async function getConfig(): Promise<Config> {
  try {
    const configPath = await getConfigPath();
    const content = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(content);
    return { ...DEFAULT_CONFIG, ...config };
  } catch (error) {
    // Return default if file doesn't exist or is invalid
    return DEFAULT_CONFIG;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  try {
    const configPath = await getConfigPath();
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save config:', error);
    throw new Error('Failed to save configuration.');
  }
}

export async function updateConfig(updates: Partial<Config>): Promise<Config> {
  const currentConfig = await getConfig();
  const newConfig = { ...currentConfig, ...updates };
  await saveConfig(newConfig);
  return newConfig;
}

export async function updateRepoSettings(repoPath: string, updates: Partial<RepoSettings>): Promise<Config> {
  const currentConfig = await getConfig();
  const currentRepoSettings = currentConfig.repoSettings[repoPath] || {};

  const newConfig: Config = {
    ...currentConfig,
    repoSettings: {
      ...currentConfig.repoSettings,
      [repoPath]: { ...currentRepoSettings, ...updates },
    },
  };

  await saveConfig(newConfig);
  return newConfig;
}
