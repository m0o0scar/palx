import { NextResponse } from 'next/server';
import { getProjects, addProject, updateProject, removeProject } from '@/lib/store';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function GET() {
  const projects = getProjects();
  return NextResponse.json(projects);
}

const addProjectSchema = z.object({
  path: z.string().min(1),
  name: z.string().optional(),
  displayName: z.string().nullable().optional(),
});

const updateProjectSchema = z.object({
  path: z.string().min(1),
  updates: z.object({
    name: z.string().optional(),
    displayName: z.string().nullable().optional(),
    iconPath: z.string().nullable().optional(),
    lastOpenedAt: z.string().optional(),
    expandedFolders: z.array(z.string()).optional(),
    visibilityMap: z.record(z.string(), z.enum(['visible', 'hidden'])).optional(),
    localGroupExpanded: z.boolean().optional(),
    remotesGroupExpanded: z.boolean().optional(),
    worktreesGroupExpanded: z.boolean().optional(),
  }),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { path: projectPath, name, displayName } = addProjectSchema.parse(body);
    const normalizedProjectPath = path.resolve(projectPath);

    const existingProject = getProjects().find((project) => (
      path.resolve(project.path) === normalizedProjectPath
    ));
    if (existingProject) {
      return NextResponse.json(existingProject);
    }

    const stat = await fs.stat(normalizedProjectPath);
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
    }

    const project = addProject(normalizedProjectPath, name, displayName);
    return NextResponse.json(project);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { path, updates } = updateProjectSchema.parse(body);
    const project = updateProject(path, updates);
    return NextResponse.json(project);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

const deleteProjectSchema = z.object({
  path: z.string().min(1),
  deleteLocalFolder: z.boolean().optional().default(false),
});

export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    const { path, deleteLocalFolder } = deleteProjectSchema.parse(body);
    removeProject(path, { deleteLocalFolder });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
