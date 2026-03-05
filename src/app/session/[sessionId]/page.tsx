import type { Metadata } from 'next';
import SessionPageClient from './SessionPageClient';
import { resolveRepoCardIcon } from '@/app/actions/git';
import { getLocalDb } from '@/lib/local-db';

type SessionRouteProps = {
  params: Promise<{ sessionId: string }>;
};

type SessionRouteContext = {
  title?: string;
  repoPath?: string;
};

const SESSION_FALLBACK_FAVICON_PATH = '/repo-generic-icon.svg';

async function readSessionRouteContext(sessionId: string): Promise<SessionRouteContext> {
  try {
    const db = getLocalDb();
    const row = db.prepare(`
      SELECT title, repo_path
      FROM sessions
      WHERE session_name = ?
    `).get(sessionId) as { title: string | null; repo_path: string | null } | undefined;

    const trimmedTitle = row?.title?.trim();
    const trimmedRepoPath = row?.repo_path?.trim();

    return {
      title: trimmedTitle || undefined,
      repoPath: trimmedRepoPath || undefined,
    };
  } catch {
    return {};
  }
}

async function resolveSessionFavicon(repoPath?: string): Promise<string> {
  if (!repoPath) {
    return SESSION_FALLBACK_FAVICON_PATH;
  }

  try {
    const iconResolution = await resolveRepoCardIcon(repoPath);
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
  const sessionFavicon = await resolveSessionFavicon(sessionContext.repoPath);

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
