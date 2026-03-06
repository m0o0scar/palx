'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useProjects, useUpdateProject } from '@/hooks/use-git';

export function WorkspaceRepoOpenTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const repoPath = searchParams.get('path');
  const { data: projects } = useProjects();
  const updateProject = useUpdateProject();
  const lastTrackedPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pathname.startsWith('/git')) {
      lastTrackedPathRef.current = null;
      return;
    }

    if (!repoPath || !projects?.some((project) => project.path === repoPath)) {
      return;
    }

    if (lastTrackedPathRef.current === repoPath) {
      return;
    }

    lastTrackedPathRef.current = repoPath;
    updateProject.mutate({
      path: repoPath,
      updates: {
        lastOpenedAt: new Date().toISOString(),
      },
    });
  }, [pathname, repoPath, projects, updateProject]);

  return null;
}
