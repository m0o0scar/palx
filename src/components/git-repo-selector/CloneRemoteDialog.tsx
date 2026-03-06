import { CloudDownload, FolderCog, FolderGit2, X } from 'lucide-react';
import type { Credential } from '@/lib/credentials';
import { getCredentialOptionLabel, type RepoCredentialSelection } from './types';

export type CloneRemoteDialogProps = {
  isOpen: boolean;
  defaultRoot: string | null | undefined;
  remoteRepoUrl: string;
  cloneCredentialSelection: RepoCredentialSelection;
  credentialOptions: Credential[];
  isCloningRemote: boolean;
  isLoadingCloneCredentialOptions: boolean;
  cloneRemoteError: string | null;
  onClose: () => void;
  onRemoteRepoUrlChange: (value: string) => void;
  onCloneCredentialSelectionChange: (value: RepoCredentialSelection) => void;
  onBrowseLocalFolder: () => void;
  onSetDefaultFolder: () => void;
  onCloneProject: () => void;
};

export function CloneRemoteDialog({
  isOpen,
  defaultRoot,
  remoteRepoUrl,
  cloneCredentialSelection,
  credentialOptions,
  isCloningRemote,
  isLoadingCloneCredentialOptions,
  cloneRemoteError,
  onClose,
  onRemoteRepoUrlChange,
  onCloneCredentialSelectionChange,
  onBrowseLocalFolder,
  onSetDefaultFolder,
  onCloneProject,
}: CloneRemoteDialogProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[1002] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl dark:border-white/10 dark:bg-[#151b26]">
        <div className="flex items-center justify-between border-b border-slate-100 bg-slate-50/60 px-5 py-4 md:px-6 dark:border-white/10 dark:bg-[#1e2532]/75">
          <div>
            <h3 className="text-lg font-bold text-slate-900 dark:text-white">Add New Project</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400">Connect a local folder or clone from URL</p>
          </div>
          <button className="btn btn-circle btn-ghost btn-sm text-slate-500 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white" onClick={onClose} disabled={isCloningRemote}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-1 flex-col overflow-y-auto md:flex-row">
          <div className="flex-1 space-y-4 border-b border-slate-100 p-5 md:border-r md:border-b-0 md:p-6 dark:border-white/10">
            <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Browse Local</h4>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Select any local folder to use as a project.
            </p>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600 dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-300">
              Default root: <span className="font-mono">{defaultRoot || '~'}</span>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                className="btn btn-primary btn-sm gap-2"
                onClick={onBrowseLocalFolder}
              >
                <FolderGit2 className="h-4 w-4" />
                Browse Local Folder
              </button>
              <button
                className="btn btn-ghost btn-sm gap-2 text-slate-700 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
                onClick={onSetDefaultFolder}
              >
                <FolderCog className="h-4 w-4" />
                Set Default Folder
              </button>
            </div>
          </div>

          <div className="w-full space-y-4 bg-slate-50/35 p-5 md:w-[420px] md:p-6 dark:bg-[#111722]">
            <h4 className="text-sm font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Clone Remote</h4>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Clone into <span className="font-mono">~/.viba/repos</span> and open it immediately.
            </p>

            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Repository URL</label>
              <input
                className="input w-full border-slate-200 bg-white font-mono text-sm text-slate-800 focus:border-primary focus:outline-none dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-200"
                placeholder="https://github.com/org/repo.git"
                value={remoteRepoUrl}
                onChange={(event) => onRemoteRepoUrlChange(event.target.value)}
                disabled={isCloningRemote}
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Credential</label>
              <select
                className="select w-full border-slate-200 bg-white text-slate-700 focus:border-primary focus:outline-none dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-200"
                value={cloneCredentialSelection}
                onChange={(event) => onCloneCredentialSelectionChange(event.target.value)}
                disabled={isCloningRemote || isLoadingCloneCredentialOptions}
              >
                <option value="auto">Auto (match repository remote)</option>
                {credentialOptions.map((credential) => (
                  <option key={credential.id} value={credential.id}>
                    {getCredentialOptionLabel(credential)}
                  </option>
                ))}
              </select>
              {credentialOptions.length === 0 && !isLoadingCloneCredentialOptions && (
                <div className="text-xs text-slate-500 dark:text-slate-400">
                  No credentials found. Clone uses anonymous access unless remote auth is configured.
                </div>
              )}
            </div>

            {isLoadingCloneCredentialOptions && (
              <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                <span className="loading loading-spinner loading-xs"></span>
                Loading credentials...
              </div>
            )}

            {isCloningRemote && (
              <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 dark:border-slate-700 dark:bg-[#1e2532] dark:text-slate-300">
                <span className="loading loading-spinner loading-xs"></span>
                Cloning repository...
              </div>
            )}

            {cloneRemoteError && (
              <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {cloneRemoteError}
              </div>
            )}

            <div className="flex justify-end gap-2 border-t border-slate-100 pt-4 dark:border-white/10">
              <button
                className="btn btn-ghost text-slate-700 dark:text-slate-300 dark:hover:bg-white/10 dark:hover:text-white"
                onClick={onClose}
                disabled={isCloningRemote}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary gap-2"
                onClick={onCloneProject}
                disabled={isCloningRemote || !remoteRepoUrl.trim() || isLoadingCloneCredentialOptions}
              >
                {isCloningRemote ? <span className="loading loading-spinner loading-xs"></span> : <CloudDownload className="h-4 w-4" />}
                Clone Project
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
