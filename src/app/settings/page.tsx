'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

type SessionInfo = {
  enabled: boolean;
  authenticated: boolean;
  email: string | null;
};

export default function SettingsPage() {
  const router = useRouter();
  const [patterns, setPatterns] = useState<string[]>([]);
  const [newPattern, setNewPattern] = useState('');
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    void (async () => {
      try {
        const [sessionResponse, whitelistResponse] = await Promise.all([
          fetch('/api/auth/session', { cache: 'no-store' }),
          fetch('/api/auth/whitelist', { cache: 'no-store' }),
        ]);

        if (!sessionResponse.ok) {
          throw new Error('Failed to load auth session');
        }

        if (!whitelistResponse.ok) {
          throw new Error('Failed to load whitelist');
        }

        const sessionData = await sessionResponse.json() as SessionInfo;
        const whitelistData = await whitelistResponse.json() as { patterns?: string[] };

        if (!active) return;

        setSessionInfo(sessionData);
        setPatterns(Array.isArray(whitelistData.patterns) ? whitelistData.patterns : []);
      } catch {
        if (!active) return;
        setError('Failed to load whitelist settings.');
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    })();

    return () => {
      active = false;
    };
  }, []);

  const normalizedNewPattern = useMemo(() => newPattern.trim(), [newPattern]);

  const handleAddPattern = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!normalizedNewPattern) return;

    const hasDuplicate = patterns.some((pattern) => pattern.toLowerCase() === normalizedNewPattern.toLowerCase());
    if (hasDuplicate) {
      setError('Pattern already exists.');
      return;
    }

    setPatterns((current) => [...current, normalizedNewPattern]);
    setNewPattern('');
    setError(null);
    setSuccess(null);
  };

  const handleRemovePattern = (indexToRemove: number) => {
    setPatterns((current) => current.filter((_, index) => index !== indexToRemove));
    setError(null);
    setSuccess(null);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setSuccess(null);

    try {
      const response = await fetch('/api/auth/whitelist', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ patterns }),
      });

      const data = await response.json().catch(() => ({} as { error?: string; patterns?: string[] }));
      if (!response.ok) {
        setError(typeof data.error === 'string' ? data.error : 'Failed to save whitelist.');
        return;
      }

      setPatterns(Array.isArray(data.patterns) ? data.patterns : []);
      setSuccess('Whitelist saved.');
    } catch {
      setError('Failed to save whitelist.');
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
  };

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-[#f6f6f8] p-6 dark:bg-[#0d1117]">
        <span className="loading loading-spinner loading-lg text-primary" aria-label="Loading" />
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#f6f6f8] p-6 dark:bg-[#0d1117]">
      <div className="mx-auto w-full max-w-3xl space-y-5">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold text-slate-900 dark:text-slate-100">Settings</h1>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              Manage global application settings.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/" className="btn btn-ghost btn-sm">
              Back home
            </Link>
            {sessionInfo?.enabled ? (
              <button type="button" className="btn btn-outline btn-sm" onClick={() => void handleLogout()}>
                Sign out
              </button>
            ) : null}
          </div>
        </header>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Email whitelist</h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
              Manage allowed email patterns for Auth0 magic-link login.
            </p>
          </div>
          <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300">
            <p><strong>Examples:</strong> <code>*</code> allows all emails, <code>*@sea.com</code> allows sea.com mailboxes, and <code>alice@example.com</code> allows one address.</p>
            {!sessionInfo?.enabled ? (
              <p className="mt-2 text-amber-700 dark:text-amber-300">Auth0 credentials are not configured, so login enforcement is currently disabled.</p>
            ) : null}
          </div>

          {(error || success) && (
            <div className={`mb-3 rounded-lg px-3 py-2 text-sm ${error
              ? 'border border-red-200 bg-red-50 text-red-700 dark:border-red-500/40 dark:bg-red-950/30 dark:text-red-300'
              : 'border border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-950/30 dark:text-emerald-300'}`}>
              {error || success}
            </div>
          )}

          <form className="mb-4 flex flex-col gap-2 sm:flex-row" onSubmit={handleAddPattern}>
            <input
              className="input input-bordered w-full"
              value={newPattern}
              onChange={(event) => setNewPattern(event.target.value)}
              placeholder="Add pattern, e.g. *@example.com"
            />
            <button type="submit" className="btn btn-primary sm:w-auto" disabled={!normalizedNewPattern}>
              Add pattern
            </button>
          </form>

          <div className="space-y-2">
            {patterns.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">No whitelist patterns configured. No email will be allowed.</p>
            ) : (
              patterns.map((pattern, index) => (
                <div key={`${pattern}-${index}`} className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-700 dark:bg-slate-800/60">
                  <code className="text-sm text-slate-700 dark:text-slate-200">{pattern}</code>
                  <button
                    type="button"
                    className="btn btn-ghost btn-xs text-red-600 hover:bg-red-100 dark:text-red-300 dark:hover:bg-red-900/40"
                    onClick={() => handleRemovePattern(index)}
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="mt-5">
            <button type="button" className="btn btn-primary" onClick={() => void handleSave()} disabled={saving}>
              {saving ? <span className="loading loading-spinner loading-xs" aria-hidden="true" /> : null}
              Save whitelist
            </button>
          </div>
        </section>
      </div>
    </main>
  );
}
