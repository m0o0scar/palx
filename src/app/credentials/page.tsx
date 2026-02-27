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
import { ArrowLeft, KeyRound, Trash2 } from 'lucide-react';
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

  return (
    <main className="min-h-screen bg-base-100 p-4 md:p-10">
      <div className="mx-auto w-full max-w-6xl space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button className="btn btn-ghost btn-sm" onClick={() => router.push('/')}>
              <ArrowLeft className="h-4 w-4" />
              Back
            </button>
            <div>
              <h1 className="text-2xl font-semibold">Credentials</h1>
              <p className="text-sm opacity-70">
                Git and coding agent API credentials are stored securely in your system keychain.
              </p>
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
          <div className="space-y-6">
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide opacity-70">Git Credentials</h2>
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 items-start">
                <div className="card bg-base-200 shadow-xl">
                  <div className="card-body space-y-4">
                    <h3 className="card-title flex items-center gap-2">
                      <ProviderIcon type="github" />
                      GitHub
                    </h3>

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
                    <h3 className="card-title flex items-center gap-2">
                      <ProviderIcon type="gitlab" />
                      GitLab
                    </h3>

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
            </section>

            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide opacity-70">Coding Agent API Credential</h2>
              <div className="grid grid-cols-1 gap-5 lg:grid-cols-1 items-start">
                {AGENT_API_ORDER.map((agent) => {
                  const configuredCredential = agentApiCredentialMap.get(agent);
                  const isSaving = savingAgent === agent;
                  const isDeleting = deletingAgent === agent;

                  return (
                    <div key={agent} className="card bg-base-200 shadow-xl">
                      <div className="card-body space-y-4">
                        <h3 className="card-title">{AGENT_API_LABELS[agent]}</h3>

                        <label className="form-control w-full gap-2">
                          <span className="label-text text-xs uppercase tracking-wide opacity-70">API Key</span>
                          <input
                            type="password"
                            className="input input-bordered w-full"
                            placeholder={AGENT_API_KEY_PLACEHOLDERS[agent]}
                            value={agentApiKeyInputs[agent]}
                            onChange={(event) => setAgentApiKeyInputs((previous) => ({ ...previous, [agent]: event.target.value }))}
                            disabled={isSaving || isDeleting}
                          />
                        </label>

                        <label className="form-control w-full gap-2">
                          <span className="label-text text-xs uppercase tracking-wide opacity-70">API Proxy (Optional)</span>
                          <input
                            type="url"
                            className="input input-bordered w-full"
                            placeholder={AGENT_API_PROXY_PLACEHOLDERS[agent]}
                            value={agentApiProxyInputs[agent]}
                            onChange={(event) => setAgentApiProxyInputs((previous) => ({ ...previous, [agent]: event.target.value }))}
                            disabled={isSaving || isDeleting}
                          />
                        </label>

                        <div className="card-actions justify-end">
                          {configuredCredential && (
                            <button
                              className="btn btn-error btn-outline btn-sm"
                              onClick={() => void handleDeleteAgentApi(agent)}
                              disabled={isSaving || isDeleting}
                            >
                              {isDeleting ? <span className="loading loading-spinner loading-xs"></span> : <Trash2 className="h-3.5 w-3.5" />}
                              Remove
                            </button>
                          )}
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => void handleSaveAgentApi(agent)}
                            disabled={isSaving || isDeleting}
                          >
                            {isSaving ? <span className="loading loading-spinner loading-xs"></span> : <KeyRound className="h-4 w-4" />}
                            {configuredCredential ? 'Update' : 'Save'}
                          </button>
                        </div>

                        <div className="rounded-md border border-base-300 bg-base-100 p-3 text-xs opacity-80">
                          {configuredCredential ? (
                            <div className="space-y-1">
                              <div>API key configured.</div>
                              <div className="opacity-70">Updated {new Date(configuredCredential.updatedAt).toLocaleString()}</div>
                              <div className="opacity-70">
                                Proxy {configuredCredential.apiProxy ? configuredCredential.apiProxy : 'not set'}
                              </div>
                            </div>
                          ) : (
                            <div>No API credential saved.</div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
