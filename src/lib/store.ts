import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Project, AppSettings } from './types';
import { getLocalDb } from './local-db';

type ProjectRow = {
  path: string;
  name: string;
  display_name: string | null;
  icon_path: string | null;
  last_opened_at: string | null;
  expanded_folders_json: string | null;
  visibility_map_json: string | null;
  local_group_expanded: number | null;
  remotes_group_expanded: number | null;
  worktrees_group_expanded: number | null;
};

type AppSettingsRow = {
  default_root_folder: string | null;
  sidebar_collapsed: number | null;
  history_panel_height: number | null;
};

function parseJsonValue<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function normalizeDisplayName(displayName?: string | null): string | null | undefined {
  if (displayName === undefined) return undefined;
  if (displayName === null) return null;
  const normalized = displayName.trim();
  return normalized.length > 0 ? normalized : null;
}

function normalizeIconPath(iconPath?: string | null): string | null | undefined {
  if (iconPath === undefined) return undefined;
  if (iconPath === null) return null;
  const normalized = iconPath.trim();
  return normalized.length > 0 ? normalized : null;
}

function rowToProject(row: ProjectRow): Project {
  const project: Project = {
    path: row.path,
    name: row.name,
  };

  if (row.display_name !== null) project.displayName = row.display_name;
  if (row.icon_path !== null) project.iconPath = row.icon_path;
  if (row.last_opened_at !== null) project.lastOpenedAt = row.last_opened_at;

  const expandedFolders = parseJsonValue<Project['expandedFolders']>(row.expanded_folders_json);
  if (expandedFolders) project.expandedFolders = expandedFolders;
  const visibilityMap = parseJsonValue<Project['visibilityMap']>(row.visibility_map_json);
  if (visibilityMap) project.visibilityMap = visibilityMap;

  if (row.local_group_expanded !== null) project.localGroupExpanded = Boolean(row.local_group_expanded);
  if (row.remotes_group_expanded !== null) project.remotesGroupExpanded = Boolean(row.remotes_group_expanded);
  if (row.worktrees_group_expanded !== null) project.worktreesGroupExpanded = Boolean(row.worktrees_group_expanded);
  return project;
}

function writeProject(project: Project): void {
  const db = getLocalDb();
  db.prepare(`
    INSERT OR REPLACE INTO projects (
      path, name, display_name, icon_path, last_opened_at,
      expanded_folders_json, visibility_map_json, local_group_expanded,
      remotes_group_expanded, worktrees_group_expanded, created_at, updated_at
    ) VALUES (
      @path, @name, @displayName, @iconPath, @lastOpenedAt,
      @expandedFoldersJson, @visibilityMapJson, @localGroupExpanded,
      @remotesGroupExpanded, @worktreesGroupExpanded,
      COALESCE((SELECT created_at FROM projects WHERE path = @path), datetime('now')),
      datetime('now')
    )
  `).run({
    path: project.path,
    name: project.name,
    displayName: project.displayName ?? null,
    iconPath: project.iconPath ?? null,
    lastOpenedAt: project.lastOpenedAt ?? null,
    expandedFoldersJson: project.expandedFolders ? JSON.stringify(project.expandedFolders) : null,
    visibilityMapJson: project.visibilityMap ? JSON.stringify(project.visibilityMap) : null,
    localGroupExpanded: project.localGroupExpanded === undefined ? null : Number(project.localGroupExpanded),
    remotesGroupExpanded: project.remotesGroupExpanded === undefined ? null : Number(project.remotesGroupExpanded),
    worktreesGroupExpanded: project.worktreesGroupExpanded === undefined ? null : Number(project.worktreesGroupExpanded),
  });
}

export function getProjects(): Project[] {
  const db = getLocalDb();
  const rows = db.prepare(`
    SELECT
      path, name, display_name, icon_path, last_opened_at,
      expanded_folders_json, visibility_map_json, local_group_expanded,
      remotes_group_expanded, worktrees_group_expanded
    FROM projects
    ORDER BY rowid ASC
  `).all() as ProjectRow[];

  return rows.map(rowToProject);
}

export function addProject(projectPath: string, name?: string, displayName?: string | null): Project {
  const db = getLocalDb();
  const existing = db.prepare(`
    SELECT path FROM projects WHERE path = ?
  `).get(projectPath) as { path: string } | undefined;

  if (existing) {
    throw new Error('Project already exists');
  }

  const normalizedDisplayName = normalizeDisplayName(displayName);
  const newProject: Project = {
    path: projectPath,
    name: name || path.basename(projectPath),
    ...(normalizedDisplayName ? { displayName: normalizedDisplayName } : {}),
  };

  writeProject(newProject);
  return newProject;
}

export function updateProject(projectPath: string, updates: Partial<Project>): Project {
  const db = getLocalDb();
  const row = db.prepare(`
    SELECT
      path, name, display_name, icon_path, last_opened_at,
      expanded_folders_json, visibility_map_json, local_group_expanded,
      remotes_group_expanded, worktrees_group_expanded
    FROM projects
    WHERE path = ?
  `).get(projectPath) as ProjectRow | undefined;

  if (!row) {
    throw new Error('Project not found');
  }

  const current = rowToProject(row);
  const normalizedUpdates: Partial<Project> = { ...updates };
  if ('displayName' in normalizedUpdates) {
    normalizedUpdates.displayName = normalizeDisplayName(normalizedUpdates.displayName);
  }
  if ('iconPath' in normalizedUpdates) {
    normalizedUpdates.iconPath = normalizeIconPath(normalizedUpdates.iconPath);
  }

  const updatedProject = { ...current, ...normalizedUpdates };
  writeProject(updatedProject);
  return updatedProject;
}

export function removeProject(projectPath: string, options?: { deleteLocalFolder?: boolean }): void {
  const { deleteLocalFolder = false } = options || {};

  if (deleteLocalFolder) {
    const resolvedProjectPath = path.resolve(projectPath);
    const rootPath = path.parse(resolvedProjectPath).root;
    if (resolvedProjectPath === rootPath) {
      throw new Error('Refusing to delete a filesystem root path');
    }
    fs.rmSync(resolvedProjectPath, { recursive: true, force: true });
  }

  const db = getLocalDb();
  db.prepare(`DELETE FROM projects WHERE path = ?`).run(projectPath);
}

export function getSettings(): AppSettings {
  const defaults: AppSettings = {
    defaultRootFolder: null,
    sidebarCollapsed: false,
  };

  const db = getLocalDb();
  const row = db.prepare(`
    SELECT default_root_folder, sidebar_collapsed, history_panel_height
    FROM app_settings
    WHERE singleton_id = 1
  `).get() as AppSettingsRow | undefined;

  if (!row) {
    return defaults;
  }

  return {
    ...defaults,
    defaultRootFolder: row.default_root_folder,
    sidebarCollapsed: row.sidebar_collapsed === null ? defaults.sidebarCollapsed : Boolean(row.sidebar_collapsed),
    historyPanelHeight: row.history_panel_height ?? undefined,
  };
}

export function updateSettings(updates: Partial<AppSettings>): AppSettings {
  const current = getSettings();
  const updated = { ...current, ...updates };
  const db = getLocalDb();

  db.prepare(`
    INSERT OR REPLACE INTO app_settings (
      singleton_id, default_root_folder, sidebar_collapsed, history_panel_height
    ) VALUES (1, @defaultRootFolder, @sidebarCollapsed, @historyPanelHeight)
  `).run({
    defaultRootFolder: updated.defaultRootFolder,
    sidebarCollapsed: updated.sidebarCollapsed === undefined ? null : Number(updated.sidebarCollapsed),
    historyPanelHeight: updated.historyPanelHeight ?? null,
  });

  return updated;
}

export function getDefaultRootFolder(): string {
  const settings = getSettings();

  if (settings.defaultRootFolder) {
    try {
      if (fs.existsSync(settings.defaultRootFolder) && fs.statSync(settings.defaultRootFolder).isDirectory()) {
        return settings.defaultRootFolder;
      }
    } catch {
      // Fall back to home directory if path is inaccessible.
    }
  }

  return os.homedir();
}

// Backward-compatible wrappers while callers migrate.
export const getRepositories = getProjects;
export const addRepository = addProject;
export const updateRepository = updateProject;
export const removeRepository = removeProject;
