import type { Metadata } from 'next';
import SessionPageClient from './SessionPageClient';
import { resolveRepoCardIcon } from '@/app/actions/git';
import { getLocalDb } from '@/lib/local-db';

type SessionRouteProps = {
  params: Promise<{ sessionId: string }>;
};

type SessionRouteContext = {
  title?: string;
  projectPath?: string;
};

const SESSION_FALLBACK_FAVICON_PATH = '/repo-generic-icon.svg';

async function readSessionRouteContext(sessionId: string): Promise<SessionRouteContext> {
  try {
    const db = getLocalDb();
    const row = db.prepare(`
      SELECT title, project_path
      FROM sessions
      WHERE session_name = ?
    `).get(sessionId) as { title: string | null; project_path: string | null } | undefined;

    const trimmedTitle = row?.title?.trim();
    const trimmedProjectPath = row?.project_path?.trim();

    return {
      title: trimmedTitle || undefined,
      projectPath: trimmedProjectPath || undefined,
    };
  } catch {
    return {};
  }
}

async function resolveSessionFavicon(projectPath?: string): Promise<string> {
  if (!projectPath) {
    return SESSION_FALLBACK_FAVICON_PATH;
  }

  try {
    const iconResolution = await resolveRepoCardIcon(projectPath);
    if (iconResolution.success && iconResolution.iconPath) {
      return `/api/file-thumbnail?path=${encodeURIComponent(iconResolution.iconPath)}`;
    }
  } catch {
    // Fall back to a generic icon if resolution fails.
  }

  return SESSION_FALLBACK_FAVICON_PATH;
}

export async function generateMetadata({ params }: SessionRouteProps): Promise<Metadata> {
  const { sessionId } = await params;
  const sessionContext = await readSessionRouteContext(sessionId);
  const sessionFavicon = await resolveSessionFavicon(sessionContext.projectPath);

  const metadata: Metadata = {
    icons: {
      icon: sessionFavicon,
    },
  };

  if (sessionContext.title) {
    metadata.title = sessionContext.title;
  }

  return metadata;
}

export default function SessionPage() {
  return <SessionPageClient />;
}
