'use client';

import { useRepositories, useAddRepository, useDeleteRepository, useCloneRepository } from '@/hooks/use-git';
import { useCredentials, useGitHubRepositories, type Credential } from '@/hooks/use-credentials';
import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FileSystemBrowser } from './fs-browser';
import { toast } from '@/hooks/use-toast';
import { getRepositoryDisplayName } from '@/lib/utils';
import { Repository } from '@/lib/types';
import { Credential as GitCredential } from '@/lib/credentials';
import { useEscapeDismiss } from '@/hooks/use-escape-dismiss';

function getRemoteHostname(url: string): string | null {
    try {
        if (url.startsWith('git@')) {
            const match = url.match(/^git@([^:]+):/);
            return match ? match[1] : null;
        }
        return new URL(url).hostname;
    } catch {
        return null;
    }
}

function inferFolderNameFromRepoUrl(repoUrl: string): string | null {
    const sanitized = repoUrl.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (!sanitized) return null;

    const lastSlashIndex = sanitized.lastIndexOf('/');
    const lastColonIndex = sanitized.lastIndexOf(':');
    const splitIndex = Math.max(lastSlashIndex, lastColonIndex);
    const rawName = splitIndex >= 0 ? sanitized.slice(splitIndex + 1) : sanitized;
    const normalized = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName;
    const trimmed = normalized.trim();

    return trimmed.length > 0 ? trimmed : null;
}

function formatCredentialLabel(credential: Credential): string {
    if (credential.type === 'github') {
        return `GitHub (${credential.username})`;
    }
    return `GitLab (${new URL(credential.serverUrl).hostname} - ${credential.username})`;
}

export function RepoList() {
    const { data: repos, isLoading } = useRepositories();
    const { data: credentials } = useCredentials();
    const addRepo = useAddRepository();
    const cloneRepo = useCloneRepository();
    const deleteRepo = useDeleteRepository();
    const [browserOpen, setBrowserOpen] = useState(false);
    const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
    const [cloneFolderBrowserOpen, setCloneFolderBrowserOpen] = useState(false);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [initRepoDialogOpen, setInitRepoDialogOpen] = useState(false);
    const [selectedNonRepoPath, setSelectedNonRepoPath] = useState<string | null>(null);
    const [repoToDelete, setRepoToDelete] = useState<{ path: string; displayName: string } | null>(null);
    const [defaultRootFolder, setDefaultRootFolder] = useState<string | undefined>(undefined);
    const [cloneUrl, setCloneUrl] = useState('');
    const [cloneDestinationParent, setCloneDestinationParent] = useState('');
    const [cloneFolderName, setCloneFolderName] = useState('');
    const [cloneFolderNameTouched, setCloneFolderNameTouched] = useState(false);
    const [cloneCredentialId, setCloneCredentialId] = useState('auto');
    const router = useRouter();
    const closeCloneDialog = () => {
        setCloneFolderBrowserOpen(false);
        setCloneDialogOpen(false);
    };
    // Load settings on mount
    useEffect(() => {
        const loadSettings = async () => {
            try {
                const res = await fetch('/api/settings');
                if (res.ok) {
                    const data = await res.json();
                    setDefaultRootFolder(data.resolvedDefaultFolder);
                }
            } catch (e) {
                console.error('Failed to load settings:', e);
            }
        };
        loadSettings();
    }, []);

    const matchingCredentials = useMemo(() => {
        if (!credentials?.length || !cloneUrl.trim()) return [];

        const remoteHost = getRemoteHostname(cloneUrl.trim());
        if (!remoteHost) return [];

        return credentials.filter((cred: GitCredential) => {
            if (cred.type === 'github') {
                return remoteHost === 'github.com';
            }
            return getRemoteHostname(cred.serverUrl) === remoteHost;
        });
    }, [credentials, cloneUrl]);

    const autoCredential = matchingCredentials[0] ?? null;
    const orderedCredentials = useMemo(() => {
        if (!credentials) return [];
        const matchingIds = new Set(matchingCredentials.map((cred: GitCredential) => cred.id));
        return [
            ...matchingCredentials,
            ...credentials.filter((cred: GitCredential) => !matchingIds.has(cred.id)),
        ];
    }, [credentials, matchingCredentials]);
    const selectedCredential = useMemo(() => {
        if (cloneCredentialId === 'auto') {
            return null;
        }
        return orderedCredentials.find((credential) => credential.id === cloneCredentialId) ?? null;
    }, [cloneCredentialId, orderedCredentials]);
    const selectedGithubCredentialId = selectedCredential?.type === 'github' ? selectedCredential.id : null;
    const {
        data: githubRepositories,
        isLoading: isGitHubRepositoriesLoading,
        error: githubRepositoriesError,
    } = useGitHubRepositories(selectedGithubCredentialId);

    const handleAdd = async (path: string) => {
        if (!path) return;
        try {
            await addRepo.mutateAsync({ path });
            // Navigate to workspace page after successfully adding repository
            router.push(`/git?path=${encodeURIComponent(path)}`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            if (errorMessage.includes('already exists')) {
                toast({
                    type: 'warning',
                    title: 'Repository already added',
                    description: 'This repository is already in your list. Select it from the list to open it.',
                });
            } else {
                toast({
                    type: 'error',
                    title: 'Failed to add repository',
                    description: errorMessage,
                });
            }
        }
    };

    const handleRepoSelection = (path: string, meta: { isRepo: boolean }) => {
        if (!path) return;
        if (meta.isRepo) {
            handleAdd(path);
            return;
        }

        setSelectedNonRepoPath(path);
        setInitRepoDialogOpen(true);
    };

    const handleConfirmInitRepo = async () => {
        if (!selectedNonRepoPath) return;

        try {
            await addRepo.mutateAsync({ path: selectedNonRepoPath });
            setInitRepoDialogOpen(false);
            setSelectedNonRepoPath(null);
            router.push(`/git?path=${encodeURIComponent(selectedNonRepoPath)}`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            toast({
                type: 'error',
                title: 'Failed to initialize repository',
                description: errorMessage,
            });
        }
    };

    const handleCancelInitRepo = () => {
        setInitRepoDialogOpen(false);
        setSelectedNonRepoPath(null);
        setBrowserOpen(true);
    };

    const openCloneDialog = () => {
        setCloneUrl('');
        setCloneFolderName('');
        setCloneFolderNameTouched(false);
        setCloneCredentialId('auto');
        setCloneDestinationParent(defaultRootFolder || '');
        setCloneDialogOpen(true);
    };

    const handleCloneUrlChange = (value: string) => {
        setCloneUrl(value);
        if (!cloneFolderNameTouched) {
            setCloneFolderName(inferFolderNameFromRepoUrl(value) ?? '');
        }
    };

    const handleClone = async () => {
        const trimmedUrl = cloneUrl.trim();
        const trimmedParent = cloneDestinationParent.trim();
        const trimmedFolderName = cloneFolderName.trim();

        if (!trimmedUrl) {
            toast({
                type: 'error',
                title: 'Repository URL is required',
                description: 'Enter a repository URL to clone.',
            });
            return;
        }

        if (!trimmedParent) {
            toast({
                type: 'error',
                title: 'Destination folder is required',
                description: 'Select a local destination folder first.',
            });
            return;
        }

        const folderName = trimmedFolderName || inferFolderNameFromRepoUrl(trimmedUrl);
        if (!folderName) {
            toast({
                type: 'error',
                title: 'Folder name is required',
                description: 'Provide a destination folder name for this clone.',
            });
            return;
        }

        try {
            const clonedRepo = await cloneRepo.mutateAsync({
                repoUrl: trimmedUrl,
                destinationParent: trimmedParent,
                folderName,
                credentialId: cloneCredentialId === 'auto' ? null : cloneCredentialId,
            });

            const usedCredential = credentials?.find((cred: GitCredential) => cred.id === clonedRepo.usedCredentialId);
            toast({
                type: 'success',
                title: 'Repository cloned',
                description: usedCredential
                    ? `Cloned with ${formatCredentialLabel(usedCredential)}`
                    : 'Clone completed successfully.',
            });
            setCloneDialogOpen(false);
            setCloneFolderBrowserOpen(false);
            router.push(`/git?path=${encodeURIComponent(clonedRepo.path)}`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            toast({
                type: 'error',
                title: 'Failed to clone repository',
                description: errorMessage,
            });
        }
    };

    const handleDeleteClick = (e: React.MouseEvent, repo: { path: string; displayName: string }) => {
        e.stopPropagation();
        setRepoToDelete(repo);
        setDeleteDialogOpen(true);
    };

    const handleDeleteConfirm = async (deleteLocalFolder: boolean) => {
        if (!repoToDelete) return;
        try {
            await deleteRepo.mutateAsync({ path: repoToDelete.path, deleteLocalFolder });
            setDeleteDialogOpen(false);
            setRepoToDelete(null);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            toast({
                type: 'error',
                title: 'Failed to delete repository',
                description: errorMessage,
            });
        }
    };

    useEscapeDismiss(deleteDialogOpen, () => setDeleteDialogOpen(false), () => {
        if (deleteRepo.isPending) {
            return;
        }
        void handleDeleteConfirm(false);
    });
    useEscapeDismiss(cloneDialogOpen, closeCloneDialog, () => {
        if (cloneRepo.isPending) {
            return;
        }
        void handleClone();
    });
    useEscapeDismiss(initRepoDialogOpen, () => {
        setInitRepoDialogOpen(false);
        setSelectedNonRepoPath(null);
        setBrowserOpen(true);
    }, () => {
        if (addRepo.isPending) {
            return;
        }
        void handleConfirmInitRepo();
    });

    if (isLoading) return <div className="p-12 text-center opacity-70">Loading repositories...</div>;

    return (
        <div className="container mx-auto max-w-5xl py-12 px-6">
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight">Repositories</h1>
                    <p className="text-sm opacity-70 mt-1">Manage your git repositories.</p>
                </div>
                <div className="flex items-center gap-2">
                    <Link href="/credentials" className="btn gap-2">
                        <i className="iconoir-key text-[20px]" aria-hidden="true" />
                        Credentials
                    </Link>
                    <button onClick={openCloneDialog} className="btn gap-2">
                        <i className="iconoir-git-fork text-[20px]" aria-hidden="true" />
                        Clone
                    </button>
                    <button onClick={() => setBrowserOpen(true)} className="btn btn-accent gap-2">
                        <i className="iconoir-plus-circle text-[20px]" aria-hidden="true" />
                        Add Repository
                    </button>
                </div>
            </div>

            <div className="overflow-x-auto border border-base-300 rounded-lg bg-base-100">
                <table className="table w-full">
                    <thead className="bg-base-200/50">
                        <tr>
                            <th>Name</th>
                            <th>Path</th>
                            <th className="text-right">Action</th>
                        </tr>
                    </thead>
                    <tbody>
                        {repos?.length === 0 && (
                            <tr>
                                <td colSpan={3} className="text-center py-12 text-muted-foreground">
                                    <div className="flex flex-col items-center gap-2">
                                        <p>No repositories found.</p>
                                        <button className="btn btn-link" onClick={() => setBrowserOpen(true)}>Add your first repository</button>
                                    </div>
                                </td>
                            </tr>
                        )}
                        {repos?.map((repo: Repository) => {
                            const repoDisplayName = getRepositoryDisplayName(repo);
                            return (
                                <tr
                                    key={repo.path}
                                    className="hover:bg-base-200/30 cursor-pointer group"
                                    onClick={() => router.push(`/git?path=${encodeURIComponent(repo.path)}`)}
                                >
                                    <td>
                                        <div className="flex items-center gap-3">
                                            <i className="iconoir-bookmark text-[20px] opacity-70 group-hover:text-primary transition-colors" aria-hidden="true" />
                                            <span className="font-bold text-sm">{repoDisplayName}</span>
                                        </div>
                                    </td>
                                    <td className="text-sm opacity-70 font-mono truncate max-w-xs" title={repo.path}>
                                        {repo.path}
                                    </td>
                                    <td className="text-right">
                                        <div className="flex items-center justify-end gap-1">
                                            <Link
                                                href={`/git?path=${encodeURIComponent(repo.path)}`}
                                                className="btn btn-ghost btn-sm btn-square"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <i className="iconoir-arrow-right text-[16px]" aria-hidden="true" />
                                            </Link>
                                            <button
                                                className="btn btn-ghost btn-sm btn-square text-error hover:bg-error/10"
                                                onClick={(e) => handleDeleteClick(e, { path: repo.path, displayName: repoDisplayName })}
                                            >
                                                <i className="iconoir-trash text-[16px]" aria-hidden="true" />
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <FileSystemBrowser
                open={browserOpen}
                onOpenChange={setBrowserOpen}
                onSelect={handleRepoSelection}
                initialPath={defaultRootFolder}
            />

            {cloneDialogOpen && (
                <dialog className="modal modal-open">
                    <div className="modal-box max-w-2xl">
                        <h3 className="font-bold text-lg">Clone Repository</h3>
                        <p className="py-2 text-sm opacity-70">
                            Clone a remote repository into a local folder and add it to your repository list.
                        </p>

                        <div className="space-y-4 pt-2">
                            <div className="form-control">
                                <label className="label">
                                    <span className="label-text">Repository URL</span>
                                </label>
                                <input
                                    type="text"
                                    className="input input-bordered w-full"
                                    placeholder="https://github.com/org/repo.git"
                                    value={cloneUrl}
                                    onChange={(e) => handleCloneUrlChange(e.target.value)}
                                />
                            </div>

                            <div className="form-control">
                                <label className="label">
                                    <span className="label-text">Destination Parent Folder</span>
                                </label>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="text"
                                        className="input input-bordered w-full font-mono text-sm"
                                        value={cloneDestinationParent}
                                        onChange={(e) => setCloneDestinationParent(e.target.value)}
                                        placeholder={defaultRootFolder || '/path/to/folder'}
                                    />
                                    <button
                                        type="button"
                                        className="btn btn-outline"
                                        onClick={() => setCloneFolderBrowserOpen(true)}
                                    >
                                        Browse
                                    </button>
                                </div>
                            </div>

                            <div className="form-control">
                                <label className="label">
                                    <span className="label-text">Destination Folder Name</span>
                                </label>
                                <input
                                    type="text"
                                    className="input input-bordered w-full"
                                    value={cloneFolderName}
                                    onChange={(e) => {
                                        setCloneFolderNameTouched(true);
                                        setCloneFolderName(e.target.value);
                                    }}
                                    placeholder={inferFolderNameFromRepoUrl(cloneUrl) || 'repository-name'}
                                />
                            </div>

                            <div className="form-control">
                                <label className="label">
                                    <span className="label-text">Credential</span>
                                </label>
                                <select
                                    className="select select-bordered w-full"
                                    value={cloneCredentialId}
                                    onChange={(e) => setCloneCredentialId(e.target.value)}
                                >
                                    <option value="auto">
                                        {autoCredential
                                            ? `Auto detect (${formatCredentialLabel(autoCredential)})`
                                            : 'Auto detect'}
                                    </option>
                                    {orderedCredentials.map((credential) => (
                                        <option key={credential.id} value={credential.id}>
                                            {formatCredentialLabel(credential)}
                                        </option>
                                    ))}
                                </select>
                                {cloneUrl.trim() && matchingCredentials.length === 0 && (
                                    <label className="label">
                                        <span className="label-text-alt opacity-70">
                                            No matching credential found for this URL. Clone will run without stored credentials unless you pick one.
                                        </span>
                                    </label>
                                )}
                                {selectedGithubCredentialId && (
                                    <div className="mt-3 border border-base-300 rounded-lg bg-base-200/30 p-2">
                                        <p className="text-xs font-bold opacity-70 px-2 pb-2">
                                            Your GitHub repositories (recently updated first)
                                        </p>
                                        {isGitHubRepositoriesLoading && (
                                            <div className="px-2 py-3 text-sm opacity-70">Loading repositories...</div>
                                        )}
                                        {!isGitHubRepositoriesLoading && githubRepositoriesError && (
                                            <div className="px-2 py-3 text-sm text-error">
                                                {githubRepositoriesError instanceof Error
                                                    ? githubRepositoriesError.message
                                                    : 'Failed to load repositories'}
                                            </div>
                                        )}
                                        {!isGitHubRepositoriesLoading && !githubRepositoriesError && githubRepositories?.length === 0 && (
                                            <div className="px-2 py-3 text-sm opacity-70">
                                                No accessible repositories found for this account.
                                            </div>
                                        )}
                                        {!isGitHubRepositoriesLoading && !githubRepositoriesError && (githubRepositories?.length ?? 0) > 0 && (
                                            <div className="max-h-56 overflow-y-auto">
                                                {githubRepositories?.map((repo: any) => (
                                                    <button
                                                        key={repo.id}
                                                        type="button"
                                                        className={`w-full text-left px-2 py-2 rounded-md hover:bg-base-300/60 transition-colors ${cloneUrl.trim() === repo.cloneUrl ? 'bg-base-300/60' : ''}`}
                                                        onClick={() => handleCloneUrlChange(repo.cloneUrl)}
                                                        title={repo.cloneUrl}
                                                    >
                                                        <div className="flex items-center justify-between gap-2">
                                                            <span className="text-sm font-medium truncate">{repo.fullName}</span>
                                                            {repo.private && (
                                                                <span className="text-[10px] uppercase tracking-wide opacity-70">Private</span>
                                                            )}
                                                        </div>
                                                        <div className="text-xs font-mono opacity-60 truncate">{repo.cloneUrl}</div>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="modal-action">
                            <button className="btn" onClick={closeCloneDialog} disabled={cloneRepo.isPending}>Cancel</button>
                            <button className="btn btn-primary" onClick={handleClone} disabled={cloneRepo.isPending}>
                                {cloneRepo.isPending ? (
                                    <span className="flex items-center gap-2">
                                        <span className="loading loading-spinner loading-xs" />
                                        Cloning...
                                    </span>
                                ) : (
                                    'Clone'
                                )}
                            </button>
                        </div>
                    </div>
                    <form method="dialog" className="modal-backdrop">
                        <button onClick={closeCloneDialog}>close</button>
                    </form>
                </dialog>
            )}

            <FileSystemBrowser
                open={cloneFolderBrowserOpen}
                onOpenChange={setCloneFolderBrowserOpen}
                onSelect={(path) => setCloneDestinationParent(path)}
                initialPath={cloneDestinationParent || defaultRootFolder}
                title="Select Destination Folder"
                selectionMode="folder"
            />

            {initRepoDialogOpen && (
                <dialog className="modal modal-open">
                    <div className="modal-box max-w-xl">
                        <h3 className="font-bold text-lg">Initialize New Repository?</h3>
                        <p className="py-4">
                            <span className="break-all font-mono text-sm">{selectedNonRepoPath}</span>
                            <br />
                            This folder is not a Git repository. Initialize it as a new local Git repository and open it in workspace?
                        </p>
                        <div className="modal-action">
                            <button className="btn" onClick={handleCancelInitRepo} disabled={addRepo.isPending}>No</button>
                            <button className="btn btn-primary" onClick={handleConfirmInitRepo} disabled={addRepo.isPending}>
                                {addRepo.isPending ? (
                                    <span className="flex items-center gap-2">
                                        <span className="loading loading-spinner loading-xs" />
                                        Initializing...
                                    </span>
                                ) : (
                                    'Yes, Initialize'
                                )}
                            </button>
                        </div>
                    </div>
                    <form method="dialog" className="modal-backdrop">
                        <button onClick={handleCancelInitRepo}>close</button>
                    </form>
                </dialog>
            )}

            {deleteDialogOpen && (
                <dialog className="modal modal-open">
                    <div className="modal-box">
                        <h3 className="font-bold text-lg">Delete Repository</h3>
                        <p className="py-4 break-words">
                            Are you sure you want to remove <strong className="break-all">{repoToDelete?.displayName}</strong> from the list?
                            Choose whether to only remove it from your repository list, or also delete its local folder.
                        </p>
                        <div className="modal-action">
                            <button className="btn" onClick={() => setDeleteDialogOpen(false)} disabled={deleteRepo.isPending}>Cancel</button>
                            <button className="btn btn-error btn-outline" onClick={() => handleDeleteConfirm(false)} disabled={deleteRepo.isPending}>Delete Repo</button>
                            <button className="btn btn-error" onClick={() => handleDeleteConfirm(true)} disabled={deleteRepo.isPending}>Delete Repo &amp; Folder</button>
                        </div>
                    </div>
                    <form method="dialog" className="modal-backdrop">
                        <button onClick={() => setDeleteDialogOpen(false)}>close</button>
                    </form>
                </dialog>
            )}
        </div>
    );
}
