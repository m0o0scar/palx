'use client';

import {
  listAgentApiCredentials,
  listCredentials,
  removeAgentApiCredential,
  removeCredential,
  saveAgentApiCredential,
  saveGitHubCredential,
  saveGitLabCredential,
} from '@/app/actions/credentials';
import type {
  AgentApiCredential,
  AgentApiCredentialAgent,
} from '@/lib/agent-api-credentials';
import type { Credential, CredentialType, GitLabCredential } from '@/lib/credentials';
import { ChevronRight, KeyRound, Trash2 } from 'lucide-react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

const DEFAULT_GITLAB_SERVER_URL = 'https://gitlab.com';
const PROVIDER_ICON_URLS = {
  github: 'https://www.google.com/s2/favicons?domain=github.com&sz=64',
  gitlab: 'https://www.google.com/s2/favicons?domain=gitlab.com&sz=64',
} as const;
const AGENT_API_LABELS: Record<AgentApiCredentialAgent, string> = {
  codex: 'Codex CLI',
};
const AGENT_API_KEY_PLACEHOLDERS: Record<AgentApiCredentialAgent, string> = {
  codex: 'sk-...',
};
const AGENT_API_PROXY_PLACEHOLDERS: Record<AgentApiCredentialAgent, string> = {
  codex: 'https://proxy.example.com/v1',
};
const AGENT_API_ORDER: AgentApiCredentialAgent[] = ['codex'];

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
  const [agentApiCredentials, setAgentApiCredentials] = useState<AgentApiCredential[]>([]);
  const [loading, setLoading] = useState(true);

  const [githubToken, setGitHubToken] = useState('');
  const [gitlabToken, setGitLabToken] = useState('');
  const [gitlabServerUrl, setGitLabServerUrl] = useState(DEFAULT_GITLAB_SERVER_URL);
  const [agentApiKeyInputs, setAgentApiKeyInputs] = useState<Record<AgentApiCredentialAgent, string>>({
    codex: '',
  });
  const [agentApiProxyInputs, setAgentApiProxyInputs] = useState<Record<AgentApiCredentialAgent, string>>({
    codex: '',
  });

  const [savingType, setSavingType] = useState<CredentialType | null>(null);
  const [savingAgent, setSavingAgent] = useState<AgentApiCredentialAgent | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deletingAgent, setDeletingAgent] = useState<AgentApiCredentialAgent | null>(null);
  const [flashMessage, setFlashMessage] = useState<FlashMessage>(null);

  const githubCredentials = useMemo(
    () => credentials.filter((credential) => credential.type === 'github'),
    [credentials],
  );

  const gitlabCredentials = useMemo(
    () => credentials.filter((credential) => credential.type === 'gitlab') as GitLabCredential[],
    [credentials],
  );

  const agentApiCredentialMap = useMemo(() => {
    return new Map(agentApiCredentials.map((credential) => [credential.agent, credential]));
  }, [agentApiCredentials]);

  const reloadCredentials = async () => {
    const [gitResult, agentResult] = await Promise.all([
      listCredentials(),
      listAgentApiCredentials(),
    ]);

    if (!gitResult.success) {
      setFlashMessage({ tone: 'error', text: gitResult.error });
      setLoading(false);
      return;
    }

    if (!agentResult.success) {
      setFlashMessage({ tone: 'error', text: agentResult.error });
      setLoading(false);
      return;
    }

    setCredentials(gitResult.credentials);
    setAgentApiCredentials(agentResult.credentials);
    setAgentApiProxyInputs((previous) => {
      const next = { ...previous };
      for (const agent of AGENT_API_ORDER) {
        next[agent] = agentResult.credentials.find((credential) => credential.agent === agent)?.apiProxy || '';
      }
      return next;
    });
    setLoading(false);
  };

  useEffect(() => {
    let isActive = true;

    void (async () => {
      const [gitResult, agentResult] = await Promise.all([
        listCredentials(),
        listAgentApiCredentials(),
      ]);
      if (!isActive) return;

      if (!gitResult.success) {
        setFlashMessage({ tone: 'error', text: gitResult.error });
        setLoading(false);
        return;
      }

      if (!agentResult.success) {
        setFlashMessage({ tone: 'error', text: agentResult.error });
        setLoading(false);
        return;
      }

      setCredentials(gitResult.credentials);
      setAgentApiCredentials(agentResult.credentials);
      setAgentApiProxyInputs((previous) => {
        const next = { ...previous };
        for (const agent of AGENT_API_ORDER) {
          next[agent] = agentResult.credentials.find((credential) => credential.agent === agent)?.apiProxy || '';
        }
        return next;
      });
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

  const handleSaveAgentApi = async (agent: AgentApiCredentialAgent) => {
    setFlashMessage(null);
    setSavingAgent(agent);

    const result = await saveAgentApiCredential(
      agent,
      agentApiKeyInputs[agent],
      agentApiProxyInputs[agent],
    );
    if (!result.success) {
      setFlashMessage({ tone: 'error', text: result.error });
      setSavingAgent(null);
      return;
    }

    setAgentApiKeyInputs((previous) => ({ ...previous, [agent]: '' }));
    setAgentApiProxyInputs((previous) => ({ ...previous, [agent]: result.credential.apiProxy || '' }));
    setFlashMessage({ tone: 'success', text: `${AGENT_API_LABELS[agent]} credential saved.` });
    await reloadCredentials();
    setSavingAgent(null);
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

  const handleDeleteAgentApi = async (agent: AgentApiCredentialAgent) => {
    const confirmed = confirm(`Delete the saved ${AGENT_API_LABELS[agent]} API credential?`);
    if (!confirmed) return;

    setFlashMessage(null);
    setDeletingAgent(agent);

    const result = await removeAgentApiCredential(agent);
    if (!result.success) {
      setFlashMessage({ tone: 'error', text: result.error });
      setDeletingAgent(null);
      return;
    }

    setAgentApiKeyInputs((previous) => ({ ...previous, [agent]: '' }));
    setAgentApiProxyInputs((previous) => ({ ...previous, [agent]: '' }));
    setFlashMessage({ tone: 'success', text: `${AGENT_API_LABELS[agent]} credential deleted.` });
    await reloadCredentials();
    setDeletingAgent(null);
  };

  const panelClass = 'overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm';
  const sectionHeaderClass = 'flex flex-col gap-3 border-b border-slate-200 px-6 py-5 md:flex-row md:items-center md:justify-between';
  const inputClass = 'block w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-900 placeholder-slate-400 transition-all focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60';
  const primaryButtonClass = 'inline-flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60';
  const secondaryButtonClass = 'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60';
  const rowActionButtonClass = 'inline-flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-all hover:bg-red-50 hover:text-red-500';

  return (
    <main className="min-h-screen bg-[#f6f6f8] px-4 py-8 md:px-8 md:py-12">
      <div className="mx-auto w-full max-w-4xl space-y-8">
        <div className="mb-8">
          <div className="mb-2 flex items-center gap-4">
            <button
              type="button"
              className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-white hover:text-slate-900"
              onClick={() => router.push('/')}
              aria-label="Back to home"
            >
              <ChevronRight className="h-6 w-6 rotate-180" />
            </button>
            <h1 className="text-3xl font-black tracking-[-0.02em] text-slate-900 md:text-4xl">Credential Management</h1>
          </div>
          <p className="ml-14 text-sm text-slate-500 md:text-base">
            Manage your API keys and access tokens for third-party services safely.
          </p>
        </div>

        {flashMessage && (
          <div
            className={`rounded-lg border px-4 py-3 text-sm ${
              flashMessage.tone === 'error'
                ? 'border-red-200 bg-red-50 text-red-700'
                : 'border-emerald-200 bg-emerald-50 text-emerald-700'
            }`}
          >
            {flashMessage.text}
          </div>
        )}

        {loading ? (
          <div className={`${panelClass} p-10`}>
            <div className="flex flex-col items-center gap-3">
              <span className="loading loading-spinner loading-md text-primary"></span>
              <p className="text-sm text-slate-500">Loading credentials...</p>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <section className={panelClass}>
              <div className={sectionHeaderClass}>
                <div>
                  <h2 className="text-lg font-bold text-slate-900">GitHub Credentials</h2>
                  <p className="mt-1 text-sm text-slate-500">Access private repositories and Gists.</p>
                </div>
                <button
                  className={primaryButtonClass}
                  onClick={() => void handleSaveGitHub()}
                  disabled={savingType === 'github'}
                >
                  {savingType === 'github' ? <span className="loading loading-spinner loading-xs"></span> : <KeyRound className="h-4 w-4" />}
                  Add Token
                </button>
              </div>

              <div className="border-b border-slate-100 bg-slate-50/40 px-6 py-4">
                <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Personal Access Token
                </label>
                <input
                  type="password"
                  className={inputClass}
                  placeholder="ghp_xxx"
                  value={githubToken}
                  onChange={(event) => setGitHubToken(event.target.value)}
                  disabled={savingType === 'github'}
                />
              </div>

              {githubCredentials.length === 0 ? (
                <div className="px-6 py-6 text-sm text-slate-500">No GitHub credentials saved.</div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {githubCredentials.map((credential) => (
                    <div
                      key={credential.id}
                      className="group flex items-center justify-between gap-4 px-6 py-5 transition-colors hover:bg-slate-50"
                    >
                      <div className="flex min-w-0 items-center gap-4">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100">
                          <ProviderIcon type="github" />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-900">{credential.username}</div>
                          <div className="mt-0.5 text-xs text-slate-500">
                            Updated {new Date(credential.updatedAt).toLocaleString()}
                          </div>
                        </div>
                      </div>
                      <button
                        className={`${rowActionButtonClass} opacity-0 group-hover:opacity-100 disabled:opacity-40`}
                        onClick={() => void handleDelete(credential)}
                        disabled={deletingId === credential.id}
                        title="Delete"
                      >
                        {deletingId === credential.id ? <span className="loading loading-spinner loading-xs"></span> : <Trash2 className="h-4 w-4" />}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className={panelClass}>
              <div className={sectionHeaderClass}>
                <div>
                  <h2 className="text-lg font-bold text-slate-900">GitLab Credentials</h2>
                  <p className="mt-1 text-sm text-slate-500">Connect to self-hosted or cloud GitLab instances.</p>
                </div>
                <button
                  className={secondaryButtonClass}
                  onClick={() => void handleSaveGitLab()}
                  disabled={savingType === 'gitlab'}
                >
                  {savingType === 'gitlab' ? <span className="loading loading-spinner loading-xs"></span> : <KeyRound className="h-4 w-4" />}
                  Add Instance
                </button>
              </div>

              <div className="space-y-4 border-b border-slate-100 bg-slate-50/40 px-6 py-4">
                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Server URL
                  </label>
                  <input
                    type="url"
                    className={inputClass}
                    placeholder={DEFAULT_GITLAB_SERVER_URL}
                    value={gitlabServerUrl}
                    onChange={(event) => setGitLabServerUrl(event.target.value)}
                    disabled={savingType === 'gitlab'}
                  />
                </div>
                <div>
                  <label className="mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Personal Access Token
                  </label>
                  <input
                    type="password"
                    className={inputClass}
                    placeholder="glpat-xxx"
                    value={gitlabToken}
                    onChange={(event) => setGitLabToken(event.target.value)}
                    disabled={savingType === 'gitlab'}
                  />
                </div>
              </div>

              {gitlabCredentials.length === 0 ? (
                <div className="px-6 py-6 text-sm text-slate-500">No GitLab credentials saved.</div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {gitlabCredentials.map((credential) => (
                    <div
                      key={credential.id}
                      className="group flex items-center justify-between gap-4 px-6 py-5 transition-colors hover:bg-slate-50"
                    >
                      <div className="flex min-w-0 items-center gap-4">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-orange-50">
                          <ProviderIcon type="gitlab" />
                        </div>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-900">{credential.username}</div>
                          <div className="truncate text-xs text-slate-500">{credential.serverUrl}</div>
                          <div className="mt-0.5 text-xs text-slate-500">
                            Updated {new Date(credential.updatedAt).toLocaleString()}
                          </div>
                        </div>
                      </div>
                      <button
                        className={`${rowActionButtonClass} opacity-0 group-hover:opacity-100 disabled:opacity-40`}
                        onClick={() => void handleDelete(credential)}
                        disabled={deletingId === credential.id}
                        title="Delete"
                      >
                        {deletingId === credential.id ? <span className="loading loading-spinner loading-xs"></span> : <Trash2 className="h-4 w-4" />}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {AGENT_API_ORDER.map((agent) => {
              const configuredCredential = agentApiCredentialMap.get(agent);
              const isSaving = savingAgent === agent;
              const isDeleting = deletingAgent === agent;

              return (
                <section key={agent} className={panelClass}>
                  <div className={sectionHeaderClass}>
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg bg-emerald-100 p-1.5 text-emerald-600">
                        <KeyRound className="h-5 w-5" />
                      </div>
                      <div>
                        <h2 className="text-lg font-bold text-slate-900">{AGENT_API_LABELS[agent]} Configuration</h2>
                        <p className="text-sm text-slate-500">Configure access for LLM capabilities.</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {configuredCredential && (
                        <button
                          className={secondaryButtonClass}
                          onClick={() => void handleDeleteAgentApi(agent)}
                          disabled={isSaving || isDeleting}
                        >
                          {isDeleting ? <span className="loading loading-spinner loading-xs"></span> : <Trash2 className="h-4 w-4" />}
                          Remove
                        </button>
                      )}
                      <button
                        className={primaryButtonClass}
                        onClick={() => void handleSaveAgentApi(agent)}
                        disabled={isSaving || isDeleting}
                      >
                        {isSaving ? <span className="loading loading-spinner loading-xs"></span> : <KeyRound className="h-4 w-4" />}
                        {configuredCredential ? 'Save Changes' : 'Save'}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-6 p-6">
                    <div className="max-w-2xl space-y-4">
                      <div>
                        <label className="mb-2 block text-sm font-medium text-slate-700">API Key</label>
                        <input
                          type="password"
                          className={inputClass}
                          placeholder={AGENT_API_KEY_PLACEHOLDERS[agent]}
                          value={agentApiKeyInputs[agent]}
                          onChange={(event) =>
                            setAgentApiKeyInputs((previous) => ({ ...previous, [agent]: event.target.value }))
                          }
                          disabled={isSaving || isDeleting}
                        />
                        <p className="mt-1 text-xs text-slate-500">
                          Your API key is stored locally and never shared.
                        </p>
                      </div>

                      <div>
                        <label className="mb-2 block text-sm font-medium text-slate-700">
                          API Proxy <span className="font-normal text-slate-400">(Optional)</span>
                        </label>
                        <input
                          type="url"
                          className={inputClass}
                          placeholder={AGENT_API_PROXY_PLACEHOLDERS[agent]}
                          value={agentApiProxyInputs[agent]}
                          onChange={(event) =>
                            setAgentApiProxyInputs((previous) => ({ ...previous, [agent]: event.target.value }))
                          }
                          disabled={isSaving || isDeleting}
                        />
                        <p className="mt-1 text-xs text-slate-500">
                          Override this when using a proxy or a compatible endpoint.
                        </p>
                      </div>
                    </div>

                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                      {configuredCredential ? (
                        <div className="space-y-1">
                          <div>API key configured.</div>
                          <div>Updated {new Date(configuredCredential.updatedAt).toLocaleString()}</div>
                          <div>Proxy {configuredCredential.apiProxy ? configuredCredential.apiProxy : 'not set'}</div>
                        </div>
                      ) : (
                        <div>No API credential saved.</div>
                      )}
                    </div>
                  </div>
                </section>
              );
            })}

            <div className="pb-2 pt-4 text-center text-xs text-slate-400">
              Credentials are encrypted at rest using your system keychain.
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
