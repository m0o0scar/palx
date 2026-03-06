'use server';

import { getLocalDb } from '@/lib/local-db';

export interface ProjectSettings {
  agentProvider?: string;
  agentModel?: string;
  startupScript?: string;
  devServerScript?: string;
  alias?: string | null;
  // Deprecated compatibility fields.
  lastBranch?: string;
  credentialId?: string | null;
  credentialPreference?: 'auto' | 'github' | 'gitlab';
}

export interface Config {
  recentProjects: string[];
  // Backward compatibility for callers that have not migrated yet.
  recentRepos: string[];
  defaultRoot: string;
  selectedIde: string;
  agentWidth: number;
  projectSettings: Record<string, ProjectSettings>;
  // Backward compatibility for callers that have not migrated yet.
  repoSettings: Record<string, ProjectSettings>;
  pinnedFolderShortcuts: string[];
}

const DEFAULT_CONFIG: Config = {
  recentProjects: [],
  recentRepos: [],
  defaultRoot: '',
  selectedIde: 'vscode',
  agentWidth: 66.666,
  projectSettings: {},
  repoSettings: {},
  pinnedFolderShortcuts: [],
};

type ConfigRow = {
  default_root: string;
  selected_ide: string;
  agent_width: number;
};

type ProjectSettingsRow = {
  project_path: string;
  agent_provider: string | null;
  agent_model: string | null;
  startup_script: string | null;
  dev_server_script: string | null;
  alias: string | null;
};

function toProjectSettings(row: ProjectSettingsRow): ProjectSettings {
  const settings: ProjectSettings = {};
  if (row.agent_provider !== null) settings.agentProvider = row.agent_provider;
  if (row.agent_model !== null) settings.agentModel = row.agent_model;
  if (row.startup_script !== null) settings.startupScript = row.startup_script;
  if (row.dev_server_script !== null) settings.devServerScript = row.dev_server_script;
  if (row.alias !== null) settings.alias = row.alias;
  return settings;
}

function writeConfig(config: Config): void {
  const db = getLocalDb();
  const tx = db.transaction((nextConfig: Config) => {
    db.prepare(`
      INSERT OR REPLACE INTO app_config (
        singleton_id, default_root, selected_ide, agent_width
      ) VALUES (
        1, @defaultRoot, @selectedIde, @agentWidth
      )
    `).run({
      defaultRoot: nextConfig.defaultRoot,
      selectedIde: nextConfig.selectedIde,
      agentWidth: nextConfig.agentWidth,
    });

    db.prepare('DELETE FROM app_config_recent_projects').run();
    const insertRecentProject = db.prepare(`
      INSERT INTO app_config_recent_projects (position, project_path) VALUES (?, ?)
    `);
    nextConfig.recentProjects.forEach((projectPath, index) => {
      insertRecentProject.run(index, projectPath);
    });

    db.prepare('DELETE FROM app_config_pinned_folder_shortcuts').run();
    const insertPinnedShortcut = db.prepare(`
      INSERT INTO app_config_pinned_folder_shortcuts (position, folder_path) VALUES (?, ?)
    `);
    nextConfig.pinnedFolderShortcuts.forEach((folderPath, index) => {
      insertPinnedShortcut.run(index, folderPath);
    });

    db.prepare('DELETE FROM app_config_project_settings').run();
    const insertProjectSettings = db.prepare(`
      INSERT INTO app_config_project_settings (
        project_path, agent_provider, agent_model, startup_script, dev_server_script, alias
      ) VALUES (
        @projectPath, @agentProvider, @agentModel, @startupScript, @devServerScript, @alias
      )
    `);
    for (const [projectPath, projectSettings] of Object.entries(nextConfig.projectSettings)) {
      insertProjectSettings.run({
        projectPath,
        agentProvider: projectSettings.agentProvider ?? null,
        agentModel: projectSettings.agentModel ?? null,
        startupScript: projectSettings.startupScript ?? null,
        devServerScript: projectSettings.devServerScript ?? null,
        alias: projectSettings.alias ?? null,
      });
    }
  });

  tx(config);
}

export async function getConfig(): Promise<Config> {
  const db = getLocalDb();
  const configRow = db.prepare(`
    SELECT default_root, selected_ide, agent_width
    FROM app_config
    WHERE singleton_id = 1
  `).get() as ConfigRow | undefined;

  const recentProjects = db.prepare(`
    SELECT project_path
    FROM app_config_recent_projects
    ORDER BY position ASC
  `).all() as Array<{ project_path: string }>;

  const pinnedFolderShortcuts = db.prepare(`
    SELECT folder_path
    FROM app_config_pinned_folder_shortcuts
    ORDER BY position ASC
  `).all() as Array<{ folder_path: string }>;

  const projectSettingsRows = db.prepare(`
    SELECT
      project_path, agent_provider, agent_model, startup_script, dev_server_script, alias
    FROM app_config_project_settings
  `).all() as ProjectSettingsRow[];

  const projectSettings = Object.fromEntries(
    projectSettingsRows.map((row) => [row.project_path, toProjectSettings(row)]),
  );

  return {
    ...DEFAULT_CONFIG,
    defaultRoot: configRow?.default_root ?? DEFAULT_CONFIG.defaultRoot,
    selectedIde: configRow?.selected_ide ?? DEFAULT_CONFIG.selectedIde,
    agentWidth: configRow?.agent_width ?? DEFAULT_CONFIG.agentWidth,
    recentProjects: recentProjects.map((entry) => entry.project_path),
    recentRepos: recentProjects.map((entry) => entry.project_path),
    pinnedFolderShortcuts: pinnedFolderShortcuts.map((entry) => entry.folder_path),
    projectSettings,
    repoSettings: projectSettings,
  };
}

export async function saveConfig(config: Config): Promise<void> {
  try {
    writeConfig(config);
  } catch (error) {
    console.error('Failed to save config:', error);
    throw new Error('Failed to save configuration.');
  }
}

export async function updateConfig(updates: Partial<Config>): Promise<Config> {
  const currentConfig = await getConfig();
  const normalizedUpdates = { ...updates };
  if (normalizedUpdates.recentRepos && !normalizedUpdates.recentProjects) {
    normalizedUpdates.recentProjects = normalizedUpdates.recentRepos;
  }
  if (normalizedUpdates.repoSettings && !normalizedUpdates.projectSettings) {
    normalizedUpdates.projectSettings = normalizedUpdates.repoSettings;
  }

  const newConfig = { ...currentConfig, ...normalizedUpdates };
  newConfig.recentRepos = newConfig.recentProjects;
  newConfig.repoSettings = newConfig.projectSettings;
  await saveConfig(newConfig);
  return newConfig;
}

export async function getProjectAlias(projectPath: string): Promise<string | null> {
  const config = await getConfig();
  const alias = config.projectSettings[projectPath]?.alias?.trim();
  return alias || null;
}

export async function updateProjectSettings(projectPath: string, updates: Partial<ProjectSettings>): Promise<Config> {
  const currentConfig = await getConfig();
  const currentProjectSettings = currentConfig.projectSettings[projectPath] || {};

  const newConfig: Config = {
    ...currentConfig,
    projectSettings: {
      ...currentConfig.projectSettings,
      [projectPath]: { ...currentProjectSettings, ...updates },
    },
  };

  await saveConfig(newConfig);
  return newConfig;
}

export async function getGitRepoCredential(repoPath: string): Promise<string | null> {
  const db = getLocalDb();
  const row = db.prepare(`
    SELECT credential_id
    FROM git_repo_credentials
    WHERE repo_path = ?
  `).get(repoPath) as { credential_id: string | null } | undefined;

  return row?.credential_id ?? null;
}

export async function setGitRepoCredential(repoPath: string, credentialId: string | null): Promise<void> {
  const db = getLocalDb();
  const normalizedCredentialId = credentialId?.trim() || null;

  if (!normalizedCredentialId) {
    db.prepare('DELETE FROM git_repo_credentials WHERE repo_path = ?').run(repoPath);
    return;
  }

  db.prepare(`
    INSERT OR REPLACE INTO git_repo_credentials (repo_path, credential_id)
    VALUES (?, ?)
  `).run(repoPath, normalizedCredentialId);
}

// Backward-compatible wrappers while callers migrate.
export type RepoSettings = ProjectSettings;

export async function getRepoAlias(repoPath: string): Promise<string | null> {
  return getProjectAlias(repoPath);
}

export async function updateRepoSettings(repoPath: string, updates: Partial<RepoSettings>): Promise<Config> {
  return updateProjectSettings(repoPath, updates);
}
