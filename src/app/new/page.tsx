import GitRepoSelector from '@/components/GitRepoSelector';
import { redirect } from 'next/navigation';
import { resolveRepositoryPathByName } from '@/lib/repo-resolver';

type NewSessionPageProps = {
  searchParams: Promise<{
    repo?: string | string[];
    from?: string | string[];
    prefillFromSession?: string | string[];
  }>;
};

export default async function NewSessionPage({ searchParams }: NewSessionPageProps) {
  const params = await searchParams;
  const repoParam = params.repo;
  const fromParam = params.from;
  const prefillParam = params.prefillFromSession;
  const repoPathFromParam = Array.isArray(repoParam) ? repoParam[0] : repoParam;
  const fromName = Array.isArray(fromParam) ? fromParam[0] : fromParam;
  const prefillFromSession = Array.isArray(prefillParam) ? prefillParam[0] : prefillParam;
  const repoPath = repoPathFromParam;
  let initialError: string | null = null;

  if (!repoPath && fromName) {
    const resolvedRepoPath = await resolveRepositoryPathByName(fromName);
    if (resolvedRepoPath) {
      const nextParams = new URLSearchParams();
      nextParams.set('repo', resolvedRepoPath);
      if (prefillFromSession) {
        nextParams.set('prefillFromSession', prefillFromSession);
      }
      redirect(`/new?${nextParams.toString()}`);
    } else {
      initialError = `Could not find a matching repository for "${fromName}".`;
    }
  }

  return (
    <main className="flex min-h-screen flex-col items-center bg-base-100 p-4 md:p-8">
      <GitRepoSelector
        mode="new"
        repoPath={repoPath ?? null}
        prefillFromSession={prefillFromSession ?? null}
        initialError={initialError}
      />
    </main>
  );
}
