'use client';

import { listCredentials, removeCredential, saveGitHubCredential, saveGitLabCredential } from '@/app/actions/credentials';
import type { Credential, CredentialType, GitLabCredential } from '@/lib/credentials';
import { ArrowLeft, KeyRound, Trash2 } from 'lucide-react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

const DEFAULT_GITLAB_SERVER_URL = 'https://gitlab.com';
const PROVIDER_ICON_URLS = {
  github: 'https://www.google.com/s2/favicons?domain=github.com&sz=64',
  gitlab: 'https://www.google.com/s2/favicons?domain=gitlab.com&sz=64',
} as const;

type FlashMessage = {
  tone: 'success' | 'error';
  text: string;
} | null;

function formatCredentialSubtitle(credential: Credential): string {
  if (credential.type === 'gitlab') {
    return `${credential.username} @ ${credential.serverUrl}`;
  }
  return credential.username;
}

function formatProviderLabel(type: CredentialType): string {
  return type === 'github' ? 'GitHub' : 'GitLab';
}

function ProviderIcon({ type }: { type: CredentialType }) {
  return (
    <Image
      src={PROVIDER_ICON_URLS[type]}
      alt={`${formatProviderLabel(type)} icon`}
      width={20}
      height={20}
      className="h-5 w-5 rounded-sm"
      unoptimized
    />
  );
}

export default function CredentialsPage() {
  const router = useRouter();

  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);

  const [githubToken, setGitHubToken] = useState('');
  const [gitlabToken, setGitLabToken] = useState('');
  const [gitlabServerUrl, setGitLabServerUrl] = useState(DEFAULT_GITLAB_SERVER_URL);

  const [savingType, setSavingType] = useState<CredentialType | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [flashMessage, setFlashMessage] = useState<FlashMessage>(null);

  const githubCredentials = useMemo(
    () => credentials.filter((credential) => credential.type === 'github'),
    [credentials],
  );

  const gitlabCredentials = useMemo(
    () => credentials.filter((credential) => credential.type === 'gitlab') as GitLabCredential[],
    [credentials],
  );

  const reloadCredentials = async () => {
    const result = await listCredentials();

    if (!result.success) {
      setFlashMessage({ tone: 'error', text: result.error });
      setLoading(false);
      return;
    }

    setCredentials(result.credentials);
    setLoading(false);
  };

  useEffect(() => {
    let isActive = true;

    void (async () => {
      const result = await listCredentials();
      if (!isActive) return;

      if (!result.success) {
        setFlashMessage({ tone: 'error', text: result.error });
        setLoading(false);
        return;
      }

      setCredentials(result.credentials);
      setLoading(false);
    })();

    return () => {
      isActive = false;
    };
  }, []);

  const handleSaveGitHub = async () => {
    setFlashMessage(null);
    setSavingType('github');

    const result = await saveGitHubCredential(githubToken);
    if (!result.success) {
      setFlashMessage({ tone: 'error', text: result.error });
      setSavingType(null);
      return;
    }

    setGitHubToken('');
    setFlashMessage({ tone: 'success', text: 'GitHub credential added.' });
    await reloadCredentials();
    setSavingType(null);
  };

  const handleSaveGitLab = async () => {
    setFlashMessage(null);
    setSavingType('gitlab');

    const result = await saveGitLabCredential(gitlabServerUrl, gitlabToken);
    if (!result.success) {
      setFlashMessage({ tone: 'error', text: result.error });
      setSavingType(null);
      return;
    }

    setGitLabToken('');
    setFlashMessage({ tone: 'success', text: 'GitLab credential added.' });
    await reloadCredentials();
    setSavingType(null);
  };

  const handleDelete = async (credential: Credential) => {
    const providerLabel = formatProviderLabel(credential.type);
    const confirmed = confirm(`Delete this ${providerLabel} credential for ${formatCredentialSubtitle(credential)}?`);
    if (!confirmed) return;

    setFlashMessage(null);
    setDeletingId(credential.id);

    const result = await removeCredential(credential.id);
    if (!result.success) {
      setFlashMessage({ tone: 'error', text: result.error });
      setDeletingId(null);
      return;
    }

    setFlashMessage({ tone: 'success', text: `${providerLabel} credential deleted.` });
    await reloadCredentials();
    setDeletingId(null);
  };

  return (
    <main className="min-h-screen bg-base-100 p-4 md:p-10">
      <div className="mx-auto w-full max-w-5xl space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button className="btn btn-ghost btn-sm" onClick={() => router.push('/')}>
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
            <div>
              <h1 className="text-2xl font-semibold">Credentials</h1>
              <p className="text-sm opacity-70">GitHub and GitLab API tokens are stored securely in your system keychain.</p>
            </div>
          </div>
        </div>

        {flashMessage && (
          <div className={`alert ${flashMessage.tone === 'error' ? 'alert-error' : 'alert-success'} text-sm`}>
            {flashMessage.text}
          </div>
        )}

        {loading ? (
          <div className="card bg-base-200 shadow-xl">
            <div className="card-body items-center py-10">
              <span className="loading loading-spinner loading-md"></span>
              <p className="text-sm opacity-70">Loading credentials...</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 items-start">
            <div className="card bg-base-200 shadow-xl">
              <div className="card-body space-y-4">
                <h2 className="card-title flex items-center gap-2">
                  <ProviderIcon type="github" />
                  GitHub
                </h2>

                <label className="form-control w-full gap-2">
                  <span className="label-text text-xs uppercase tracking-wide opacity-70">Personal Access Token</span>
                  <input
                    type="password"
                    className="input input-bordered w-full"
                    placeholder="ghp_xxx"
                    value={githubToken}
                    onChange={(event) => setGitHubToken(event.target.value)}
                    disabled={savingType === 'github'}
                  />
                </label>

                <div className="card-actions justify-end pt-1">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => void handleSaveGitHub()}
                    disabled={savingType === 'github'}
                  >
                    {savingType === 'github' ? <span className="loading loading-spinner loading-xs"></span> : <KeyRound className="h-4 w-4" />}
                    Add Credential
                  </button>
                </div>

                <div className="divider my-0"></div>

                {githubCredentials.length === 0 ? (
                  <div className="text-sm opacity-60">No GitHub credentials saved.</div>
                ) : (
                  <div className="space-y-2">
                    {githubCredentials.map((credential) => (
                      <div key={credential.id} className="rounded-md border border-base-300 bg-base-100 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 flex items-start gap-2">
                            <ProviderIcon type="github" />
                            <div className="min-w-0">
                              <div className="text-sm font-medium truncate">{credential.username}</div>
                              <div className="text-xs opacity-60">Updated {new Date(credential.updatedAt).toLocaleString()}</div>
                            </div>
                          </div>
                          <button
                            className="btn btn-error btn-outline btn-xs"
                            onClick={() => void handleDelete(credential)}
                            disabled={deletingId === credential.id}
                          >
                            {deletingId === credential.id ? <span className="loading loading-spinner loading-xs"></span> : <Trash2 className="h-3.5 w-3.5" />}
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="card bg-base-200 shadow-xl">
              <div className="card-body space-y-4">
                <h2 className="card-title flex items-center gap-2">
                  <ProviderIcon type="gitlab" />
                  GitLab
                </h2>

                <label className="form-control w-full gap-2">
                  <span className="label-text text-xs uppercase tracking-wide opacity-70">Server URL</span>
                  <input
                    type="url"
                    className="input input-bordered w-full"
                    placeholder={DEFAULT_GITLAB_SERVER_URL}
                    value={gitlabServerUrl}
                    onChange={(event) => setGitLabServerUrl(event.target.value)}
                    disabled={savingType === 'gitlab'}
                  />
                </label>

                <label className="form-control w-full gap-2">
                  <span className="label-text text-xs uppercase tracking-wide opacity-70">Personal Access Token</span>
                  <input
                    type="password"
                    className="input input-bordered w-full"
                    placeholder="glpat-xxx"
                    value={gitlabToken}
                    onChange={(event) => setGitLabToken(event.target.value)}
                    disabled={savingType === 'gitlab'}
                  />
                </label>

                <div className="card-actions justify-end pt-1">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => void handleSaveGitLab()}
                    disabled={savingType === 'gitlab'}
                  >
                    {savingType === 'gitlab' ? <span className="loading loading-spinner loading-xs"></span> : <KeyRound className="h-4 w-4" />}
                    Add Credential
                  </button>
                </div>

                <div className="divider my-0"></div>

                {gitlabCredentials.length === 0 ? (
                  <div className="text-sm opacity-60">No GitLab credentials saved.</div>
                ) : (
                  <div className="space-y-2">
                    {gitlabCredentials.map((credential) => (
                      <div key={credential.id} className="rounded-md border border-base-300 bg-base-100 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 flex items-start gap-2">
                            <ProviderIcon type="gitlab" />
                            <div className="min-w-0">
                              <div className="text-sm font-medium truncate">{credential.username}</div>
                              <div className="text-xs opacity-70 truncate">{credential.serverUrl}</div>
                              <div className="text-xs opacity-60">Updated {new Date(credential.updatedAt).toLocaleString()}</div>
                            </div>
                          </div>
                          <button
                            className="btn btn-error btn-outline btn-xs"
                            onClick={() => void handleDelete(credential)}
                            disabled={deletingId === credential.id}
                          >
                            {deletingId === credential.id ? <span className="loading loading-spinner loading-xs"></span> : <Trash2 className="h-3.5 w-3.5" />}
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
