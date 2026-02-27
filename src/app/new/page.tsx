import GitRepoSelector from '@/components/GitRepoSelector';

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

  return (
    <main className="flex min-h-screen flex-col items-center bg-[#f6f6f8] p-4 md:p-8 dark:bg-[#0d1117]">
      <GitRepoSelector
        mode="new"
        repoPath={repoPath ?? null}
        fromRepoName={fromName ?? null}
        prefillFromSession={prefillFromSession ?? null}
      />
    </main>
  );
}
