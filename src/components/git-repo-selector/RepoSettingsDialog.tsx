import { X } from 'lucide-react';
import type { Credential } from '@/lib/credentials';
import { getCredentialOptionLabel, type RepoCredentialSelection } from './types';

export type RepoSettingsDialogProps = {
  isOpen: boolean;
  repoForSettings: string | null;
  repoCredentialSelection: RepoCredentialSelection;
  repoStartupCommand: string;
  repoDevServerCommand: string;
  defaultRepoStartupCommand: string;
  defaultRepoDevServerCommand: string;
  credentialOptions: Credential[];
  isSavingRepoSettings: boolean;
  isLoadingCredentialOptions: boolean;
  repoSettingsError: string | null;
  onCredentialChange: (value: RepoCredentialSelection) => void;
  onStartupCommandChange: (value: string) => void;
  onDevServerCommandChange: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
};

export function RepoSettingsDialog({
  isOpen,
  repoForSettings,
  repoCredentialSelection,
  repoStartupCommand,
  repoDevServerCommand,
  defaultRepoStartupCommand,
  defaultRepoDevServerCommand,
  credentialOptions,
  isSavingRepoSettings,
  isLoadingCredentialOptions,
  repoSettingsError,
  onCredentialChange,
  onStartupCommandChange,
  onDevServerCommandChange,
  onClose,
  onSave,
}: RepoSettingsDialogProps) {
  if (!isOpen || !repoForSettings) return null;

  return (
    <div className="fixed inset-0 z-[1002] flex items-center justify-center bg-slate-900/35 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#151b26]">
        <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/70 px-5 py-4 md:px-6 dark:border-white/10 dark:bg-[#1e2532]/75">
          <h3 className="text-lg font-bold text-slate-900 dark:text-white">Repository Settings</h3>
          <button
            className="btn btn-circle btn-ghost btn-sm text-slate-500 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
            onClick={onClose}
            disabled={isSavingRepoSettings}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5 md:p-6">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Choose which credential this repository should use for authenticated Git operations.
          </p>

          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Repository</label>
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 break-all font-mono text-xs text-slate-700 dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-200">
              {repoForSettings}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Credential</label>
            <select
              className="select w-full border-slate-200 bg-slate-50 text-slate-700 focus:border-primary focus:outline-none dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-200"
              value={repoCredentialSelection}
              onChange={(event) => onCredentialChange(event.target.value)}
              disabled={isSavingRepoSettings}
            >
              <option value="auto">Auto (match repository remote)</option>
              {credentialOptions.map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {getCredentialOptionLabel(credential)}
                </option>
              ))}
            </select>
            {credentialOptions.length === 0 && !isLoadingCredentialOptions && (
              <div className="text-xs text-slate-500 dark:text-slate-400">
                No credentials found. Add credentials from the Credentials page.
              </div>
            )}
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Start Up Command</label>
            <input
              className="input w-full border-slate-200 bg-slate-50 font-mono text-sm text-slate-800 focus:border-primary focus:outline-none dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-200"
              value={repoStartupCommand}
              onChange={(event) => onStartupCommandChange(event.target.value)}
              placeholder={defaultRepoStartupCommand}
              disabled={isSavingRepoSettings}
            />
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Default: <span className="font-mono">{defaultRepoStartupCommand}</span>
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Dev Server Command</label>
            <input
              className="input w-full border-slate-200 bg-slate-50 font-mono text-sm text-slate-800 focus:border-primary focus:outline-none dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-200"
              value={repoDevServerCommand}
              onChange={(event) => onDevServerCommandChange(event.target.value)}
              placeholder={defaultRepoDevServerCommand}
              disabled={isSavingRepoSettings}
            />
            <div className="text-xs text-slate-500 dark:text-slate-400">
              Default: <span className="font-mono">{defaultRepoDevServerCommand}</span>
            </div>
          </div>

          {isLoadingCredentialOptions && (
            <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
              <span className="loading loading-spinner loading-xs"></span>
              Loading credentials...
            </div>
          )}

          {repoSettingsError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {repoSettingsError}
            </div>
          )}

          <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-white/10">
            <button
              className="btn btn-ghost text-slate-700 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
              onClick={onClose}
              disabled={isSavingRepoSettings}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={onSave}
              disabled={isSavingRepoSettings || isLoadingCredentialOptions}
            >
              {isSavingRepoSettings ? <span className="loading loading-spinner loading-xs"></span> : null}
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
