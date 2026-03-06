import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { addProject, getProjects, updateProject } from '@/lib/store';

const MAX_ICON_BYTES = 2 * 1024 * 1024;
const ICON_DIR = path.join(os.homedir(), '.viba', 'project-icons');
const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico']);
type ParsedIconUpload = {
  projectPath: string;
  extension: string;
  fileBuffer: Buffer;
};

function sanitizeExtension(fileName: string): string | null {
  const extension = path.extname(fileName).toLowerCase();
  if (!extension || !ALLOWED_EXTENSIONS.has(extension)) return null;
  return extension;
}

function findProjectByAbsolutePath(projectPath: string) {
  const normalizedProjectPath = path.resolve(projectPath);
  return getProjects().find((project) => path.resolve(project.path) === normalizedProjectPath) || null;
}

async function ensureProjectExists(projectPath: string) {
  const normalizedProjectPath = path.resolve(projectPath);
  const existingProject = findProjectByAbsolutePath(normalizedProjectPath);
  if (existingProject) return existingProject;

  let projectStats;
  try {
    projectStats = await fs.stat(normalizedProjectPath);
  } catch {
    throw new Error('Project not found.');
  }

  if (!projectStats.isDirectory()) {
    throw new Error('Project path must be a directory.');
  }

  try {
    addProject(normalizedProjectPath, path.basename(normalizedProjectPath));
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (!/already exists/i.test(message)) {
      throw error;
    }
  }

  const ensuredProject = findProjectByAbsolutePath(normalizedProjectPath);
  if (!ensuredProject) {
    throw new Error('Project not found.');
  }
  return ensuredProject;
}

function getManagedIconPath(projectPath: string, extension: string): string {
  const projectHash = createHash('sha1').update(projectPath).digest('hex').slice(0, 16);
  return path.join(ICON_DIR, `${projectHash}${extension}`);
}

function isManagedIconPath(iconPath: string | null | undefined): boolean {
  if (!iconPath) return false;
  const normalized = path.resolve(iconPath);
  return normalized.startsWith(path.resolve(ICON_DIR) + path.sep) || normalized === path.resolve(ICON_DIR);
}

async function removeExistingManagedIcon(iconPath: string | null | undefined): Promise<void> {
  if (!iconPath || !isManagedIconPath(iconPath)) return;
  try {
    await fs.rm(iconPath, { force: true });
  } catch {
    // Ignore cleanup failures.
  }
}

async function parseIconUpload(request: Request): Promise<ParsedIconUpload> {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? '';

  if (contentType.includes('multipart/form-data')) {
    const formData = await request.formData();
    const projectPathValue = formData.get('projectPath');
    const iconFileValue = formData.get('iconFile');

    if (typeof projectPathValue !== 'string' || !projectPathValue.trim()) {
      throw new Error('projectPath is required.');
    }

    if (!(iconFileValue instanceof File)) {
      throw new Error('iconFile is required.');
    }

    const extension = sanitizeExtension(iconFileValue.name);
    if (!extension) {
      throw new Error('Unsupported icon type. Use png, jpg, jpeg, webp, svg, or ico.');
    }

    if (iconFileValue.size > MAX_ICON_BYTES) {
      throw new Error('Icon file must be 2MB or smaller.');
    }

    return {
      projectPath: path.resolve(projectPathValue.trim()),
      extension,
      fileBuffer: Buffer.from(await iconFileValue.arrayBuffer()),
    };
  }

  const body = await request.json().catch(() => null);
  const projectPathValue = typeof body?.projectPath === 'string' ? body.projectPath.trim() : '';
  const iconPathValue = typeof body?.iconPath === 'string' ? body.iconPath.trim() : '';

  if (!projectPathValue) {
    throw new Error('projectPath is required.');
  }

  if (!iconPathValue) {
    throw new Error('iconPath is required.');
  }

  const resolvedIconPath = path.resolve(iconPathValue);
  const extension = sanitizeExtension(path.basename(resolvedIconPath));
  if (!extension) {
    throw new Error('Unsupported icon type. Use png, jpg, jpeg, webp, svg, or ico.');
  }

  let iconStats;
  try {
    iconStats = await fs.stat(resolvedIconPath);
  } catch {
    throw new Error('Icon file not found.');
  }

  if (!iconStats.isFile()) {
    throw new Error('Icon path must be a file.');
  }

  if (iconStats.size > MAX_ICON_BYTES) {
    throw new Error('Icon file must be 2MB or smaller.');
  }

  return {
    projectPath: path.resolve(projectPathValue),
    extension,
    fileBuffer: await fs.readFile(resolvedIconPath),
  };
}

export async function POST(request: Request) {
  try {
    const { projectPath, extension, fileBuffer } = await parseIconUpload(request);
    const existingProject = await ensureProjectExists(projectPath);

    await fs.mkdir(ICON_DIR, { recursive: true });

    const destinationPath = getManagedIconPath(projectPath, extension);
    await removeExistingManagedIcon(existingProject.iconPath);

    await fs.writeFile(destinationPath, fileBuffer);

    const updatedProject = updateProject(existingProject.path, { iconPath: destinationPath });
    return NextResponse.json({ success: true, iconPath: updatedProject.iconPath ?? null });
  } catch (error) {
    const message = (error as Error).message || 'Failed to upload project icon.';
    if (message === 'Project not found.') {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    if (
      message === 'Project path must be a directory.'
      || message === 'projectPath is required.'
      || message === 'iconFile is required.'
      || message === 'iconPath is required.'
      || message === 'Unsupported icon type. Use png, jpg, jpeg, webp, svg, or ico.'
      || message === 'Icon file must be 2MB or smaller.'
      || message === 'Icon file not found.'
      || message === 'Icon path must be a file.'
    ) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    console.error('Failed to upload project icon:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    const projectPath = typeof body?.projectPath === 'string' ? body.projectPath.trim() : '';
    if (!projectPath) {
      return NextResponse.json({ error: 'projectPath is required.' }, { status: 400 });
    }

    const normalizedProjectPath = path.resolve(projectPath);
    const existingProject = await ensureProjectExists(normalizedProjectPath);

    await removeExistingManagedIcon(existingProject.iconPath);
    updateProject(existingProject.path, { iconPath: null });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = (error as Error).message || 'Failed to remove project icon.';
    if (message === 'Project not found.') {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    if (message === 'Project path must be a directory.') {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    console.error('Failed to remove project icon:', error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
