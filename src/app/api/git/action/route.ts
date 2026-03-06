import { NextResponse } from 'next/server';
import { GitService } from '@/lib/git';
import { getCredentialById, getCredentialToken, findCredentialForRemote } from '@/lib/credentials';
import { getGitRepoCredential } from '@/app/actions/config';
import { getImageMimeType, isImageFile } from '@/lib/utils';
import { handleGitError } from '@/lib/api-utils';
import { runCodexCliNonInteractive } from '@/lib/codex-cli';
import { z } from 'zod';
import fs from 'node:fs';

const actionSchema = z.object({
  repoPath: z.string(),
  action: z.enum(['commit', 'push', 'pull', 'stage', 'unstage', 'fetch', 'checkout', 'checkout-to-local', 'branch', 'create-tag', 'delete-branch', 'delete-worktree', 'delete-remote-branch', 'delete-remote', 'delete-tag', 'delete-remote-tag', 'rename-branch', 'rename-remote-branch', 'rename-remote', 'set-remote-url', 'add-remote', 'reset', 'revert', 'cherry-pick', 'cherry-pick-multiple', 'cherry-pick-abort', 'rebase', 'merge', 'check-merge-conflicts', 'check-rebase-conflicts', 'get-conflict-state', 'get-conflict-file-versions', 'resolve-conflict-file', 'continue-merge', 'abort-merge', 'continue-rebase', 'abort-rebase', 'get-remotes', 'get-remote-branches', 'get-tracking-branch', 'get-latest-commit-message', 'get-merge-base', 'push-to-remote', 'pull-from-remote', 'stash', 'stash-list', 'stash-apply', 'stash-drop', 'stash-pop', 'stash-files', 'stash-file-diff', 'reword', 'discard', 'cleanup-lock-file']),
  data: z.any().optional(), // Payload depends on action
});

async function resolveCredentials(repoPath: string, git: GitService, remoteName?: string) {
  // 1. Check explicit per-repo credential mapping.
  const mappedCredentialId = await getGitRepoCredential(repoPath);
  if (mappedCredentialId) {
    const cred = await getCredentialById(mappedCredentialId);
    if (cred) {
      const token = await getCredentialToken(cred.id);
      if (token) {
        return { username: cred.username, token };
      }
    }
  }

  // 2. Fallback: try to find matching credential by URL
  if (remoteName) {
    const remoteUrl = await git.getRemoteUrl(remoteName);
    if (remoteUrl) {
       const result = await findCredentialForRemote(remoteUrl);
       if (result) {
         return { username: result.credential.username, token: result.token };
       }
    }
  }

  return undefined;
}

function toImageSide(buffer: Buffer | null, mimeType: string) {
  if (!buffer) return null;
  return {
    mimeType,
    base64: buffer.toString('base64'),
  };
}

const AUTO_COMMIT_MESSAGE_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    message: { type: 'string', minLength: 1 },
  },
  required: ['message'],
  additionalProperties: false,
} as const;

function buildAutoCommitMessagePrompt(userHint?: string): string {
  const hint = userHint?.trim();
  const lines = [
    'Generate a git commit message for the currently staged changes in this repository.',
    'Inspect staged changes only (for example: git status --short and git diff --cached).',
    'Write a concise, imperative subject line (<= 72 chars).',
    'Include a body only when needed to clarify context.',
    'Return only JSON matching the provided schema.',
  ];

  if (hint) {
    lines.push('Additional context from user:');
    lines.push(hint);
  }

  return lines.join('\n');
}

function parseGeneratedCommitMessage(rawOutput: string): string {
  try {
    const parsed = JSON.parse(rawOutput) as { message?: unknown };
    if (typeof parsed.message !== 'string') return '';
    return parsed.message.trim();
  } catch {
    return '';
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { repoPath, action, data } = actionSchema.parse(body);

    // Check if path exists
    if (!fs.existsSync(repoPath)) {
      return NextResponse.json({ error: `Path not found: ${repoPath}` }, { status: 404 });
    }

    const git = new GitService(repoPath);

    switch (action) {
      case 'commit': {
        const providedMessage = typeof data?.message === 'string' ? data.message.trim() : '';
        let commitMessage = providedMessage;

        if (!commitMessage) {
          const codexResult = await runCodexCliNonInteractive({
            cwd: repoPath,
            prompt: buildAutoCommitMessagePrompt(typeof data?.prompt === 'string' ? data.prompt : undefined),
            outputSchema: AUTO_COMMIT_MESSAGE_OUTPUT_SCHEMA,
          });

          const generatedMessage = parseGeneratedCommitMessage(codexResult.lastMessage)
            || parseGeneratedCommitMessage(codexResult.output);

          if (codexResult.exitCode !== 0 || !generatedMessage) {
            const reason = codexResult.timedOut
              ? 'Codex timed out while generating a commit message.'
              : (codexResult.output || `Codex exited with status ${codexResult.exitCode}.`);
            throw new Error(`Failed to auto-generate commit message. ${reason}`);
          }

          commitMessage = generatedMessage;
        }

        await git.commit(commitMessage, data?.files, { initialBranch: data?.initialBranch });
        break;
      }
      case 'push':
        // Try to resolve credentials
        let pushCredentials = await resolveCredentials(repoPath, git, undefined);
        
        if (!pushCredentials) {
            // If no associated credential, try to infer from upstream
            try {
                const status = await git.getBranches();
                const current = status.current;
                const tracking = status.trackingInfo[current];
                if (tracking && tracking.upstream) {
                    const slashIndex = tracking.upstream.indexOf('/');
                    if (slashIndex > 0) {
                        const remoteName = tracking.upstream.slice(0, slashIndex);
                        pushCredentials = await resolveCredentials(repoPath, git, remoteName);
                    }
                }
            } catch (e) {
                // Ignore errors finding upstream, just proceed without creds
                console.warn('[API] Failed to resolve upstream for push credentials:', e);
            }
        }
        
        await git.push({ credentials: pushCredentials });
        break;
      case 'pull':
        await git.pull();
        break;
      case 'fetch':
        if (data?.allRemotes) {
          await git.fetchAllRemotes();
        } else if (data?.remote) {
          await git.fetchRemote(data.remote);
        } else {
          await git.fetch();
        }
        break;
      case 'stage':
        if (!data?.files) throw new Error('Files are required for staging');
        await git.stage(data.files);
        break;
      case 'unstage':
        if (!data?.files) throw new Error('Files are required for unstaging');
        await git.unstage(data.files);
        break;
      case 'discard':
        await git.discardUnstagedChanges({
          includeUntracked: data?.includeUntracked ?? true,
        });
        break;
      case 'checkout':
        if (!data?.branch) throw new Error('Branch name is required for checkout');
        await git.checkout(data.branch);
        break;
      case 'checkout-to-local':
        if (!data?.remoteBranch) throw new Error('Remote branch is required for checkout-to-local');
        if (!data?.localBranch) throw new Error('Local branch name is required for checkout-to-local');
        await git.checkoutRemoteToLocal(data.remoteBranch, data.localBranch);
        break;
      case 'branch':
        if (!data?.branch) throw new Error('Branch name is required to create branch');
        await git.createBranch(data.branch, data?.fromRef);
        break;
      case 'create-tag':
        if (!data?.tagName) throw new Error('Tag name is required to create tag');
        if (!data?.commitHash) throw new Error('Commit hash is required to create tag');
        if (data?.pushToRemote) {
          let remoteForTag = typeof data?.remote === 'string' && data.remote.trim() ? data.remote.trim() : undefined;
          if (!remoteForTag) {
            const branches = await git.getBranches();
            const current = branches.current;
            const trackingUpstream = current ? branches.trackingInfo?.[current]?.upstream : undefined;
            if (trackingUpstream) {
              const slashIndex = trackingUpstream.indexOf('/');
              if (slashIndex > 0) {
                remoteForTag = trackingUpstream.slice(0, slashIndex);
              }
            }
          }
          if (!remoteForTag) {
            const remotes = await git.getRemotes();
            if (remotes.includes('origin')) {
              remoteForTag = 'origin';
            } else {
              remoteForTag = remotes[0];
            }
          }

          const tagCreds = remoteForTag ? await resolveCredentials(repoPath, git, remoteForTag) : undefined;
          await git.createTag(data.tagName, data.commitHash, {
            pushToRemote: true,
            remote: remoteForTag ?? undefined,
            credentials: tagCreds,
          });
        } else {
          await git.createTag(data.tagName, data.commitHash, { pushToRemote: false });
        }
        break;
      case 'delete-branch':
        if (!data?.branch) throw new Error('Branch name is required to delete branch');
        await git.deleteBranch(data.branch);
        break;
      case 'delete-worktree':
        if (!data?.path) throw new Error('Worktree path is required to delete worktree');
        await git.deleteWorktree(data.path);
        break;
      case 'delete-remote-branch':
        if (!data?.remote) throw new Error('Remote name is required to delete remote branch');
        if (!data?.branch) throw new Error('Branch name is required to delete remote branch');
        
        const deleteCreds = await resolveCredentials(repoPath, git, data.remote);
        await git.deleteRemoteBranch(data.remote, data.branch, deleteCreds);
        break;
      case 'delete-remote':
        if (!data?.name) throw new Error('Remote name is required to delete remote');
        await git.deleteRemote(data.name);
        break;
      case 'delete-tag':
        if (!data?.tag) throw new Error('Tag name is required to delete tag');
        await git.deleteTag(data.tag);
        break;
      case 'delete-remote-tag':
        if (!data?.remote) throw new Error('Remote name is required to delete remote tag');
        if (!data?.tag) throw new Error('Tag name is required to delete remote tag');

        const deleteTagCreds = await resolveCredentials(repoPath, git, data.remote);
        await git.deleteRemoteTag(data.remote, data.tag, deleteTagCreds);
        break;
      case 'rename-branch':
        if (!data?.oldName) throw new Error('Old branch name is required to rename branch');
        if (!data?.newName) throw new Error('New branch name is required to rename branch');
        if (data?.renameTrackingRemote) {
          const tracking = await git.getTrackingBranch(data.oldName);
          const renameTrackingCreds = tracking
            ? await resolveCredentials(repoPath, git, tracking.remote)
            : undefined;
          await git.renameBranch(data.oldName, data.newName, {
            renameTrackingRemote: true,
            credentials: renameTrackingCreds,
          });
        } else {
          await git.renameBranch(data.oldName, data.newName);
        }
        break;
      case 'rename-remote-branch':
        if (!data?.remote) throw new Error('Remote name is required to rename remote branch');
        if (!data?.oldName) throw new Error('Old branch name is required to rename remote branch');
        if (!data?.newName) throw new Error('New branch name is required to rename remote branch');

        const renameCreds = await resolveCredentials(repoPath, git, data.remote);
        await git.renameRemoteBranch(data.remote, data.oldName, data.newName, renameCreds);
        break;
      case 'rename-remote':
        if (!data?.oldName) throw new Error('Old remote name is required to rename remote');
        if (!data?.newName) throw new Error('New remote name is required to rename remote');
        await git.renameRemote(data.oldName, data.newName);
        break;
      case 'set-remote-url':
        if (!data?.name) throw new Error('Remote name is required to set remote URL');
        if (!data?.url) throw new Error('Remote URL is required');
        await git.setRemoteUrl(data.name, data.url);
        break;
      case 'add-remote':
        if (!data?.name) throw new Error('Remote name is required to add remote');
        if (!data?.url) throw new Error('Remote URL is required to add remote');
        await git.addRemote(data.name, data.url);
        break;
      case 'reset':
        if (!data?.commitHash) throw new Error('Commit hash is required for reset');
        await git.reset(data.commitHash, data.mode ?? 'hard');
        break;
      case 'revert':
        if (!data?.commitHash) throw new Error('Commit hash is required for revert');
        await git.revert(data.commitHash);
        break;
      case 'cherry-pick':
        if (!data?.commitHash) throw new Error('Commit hash is required for cherry-pick');
        await git.cherryPick(data.commitHash);
        break;
      case 'cherry-pick-multiple':
        if (!Array.isArray(data?.commitHashes) || data.commitHashes.length === 0) {
          throw new Error('Commit hashes are required for multi cherry-pick');
        }
        if (!data.commitHashes.every((hash: unknown) => typeof hash === 'string' && hash.trim().length > 0)) {
          throw new Error('All commit hashes must be non-empty strings');
        }
        await git.cherryPickMultiple(data.commitHashes);
        break;
      case 'cherry-pick-abort':
        await git.abortCherryPick();
        break;
      case 'rebase':
        if (!data?.ontoBranch) throw new Error('Target branch is required for rebase');
        await git.rebase(data.ontoBranch, data.stashChanges ?? true);
        break;
      case 'reword':
        if (!data?.commitHash) throw new Error('Commit hash is required for reword');
        if (!data?.message) throw new Error('New message is required for reword');
        await git.reword(data.commitHash, data.message, data.branch);
        break;
      case 'merge':
        if (!data?.targetBranch) throw new Error('Target branch is required for merge');
        await git.merge(data.targetBranch, {
          rebaseBeforeMerge: data.rebaseBeforeMerge ?? false,
          squash: data.squash ?? false,
          fastForward: data.fastForward ?? false,
          squashMessage: data.squashMessage,
        });
        break;
      case 'check-merge-conflicts':
        if (!data?.sourceBranch) throw new Error('Source branch is required for merge conflict check');
        const hasConflicts = await git.willMergeHaveConflicts(data.sourceBranch, data.targetBranch);
        return NextResponse.json({ success: true, hasConflicts });
      case 'check-rebase-conflicts':
        if (!data?.ontoBranch) throw new Error('Target branch is required for rebase conflict check');
        if (!data?.sourceBranch) throw new Error('Source branch is required for rebase conflict check');
        const hasRebaseConflicts = await git.willRebaseHaveConflicts(data.ontoBranch, data.sourceBranch);
        return NextResponse.json({ success: true, hasConflicts: hasRebaseConflicts });
      case 'get-conflict-state':
        const conflictState = await git.getConflictState();
        return NextResponse.json({ success: true, ...conflictState });
      case 'get-conflict-file-versions':
        if (!data?.path) throw new Error('File path is required');
        const versions = await git.getConflictFileVersions(data.path);
        return NextResponse.json({ success: true, ...versions });
      case 'resolve-conflict-file':
        if (!data?.path) throw new Error('File path is required');
        if (!data?.strategy) throw new Error('Resolution strategy is required');
        if (!['ours', 'theirs', 'manual'].includes(data.strategy)) {
          throw new Error('Resolution strategy must be ours, theirs, or manual');
        }
        await git.resolveConflictFile(data.path, data.strategy, {
          content: data.content,
          stage: data.stage ?? true,
        });
        break;
      case 'continue-merge':
        await git.continueMerge();
        break;
      case 'abort-merge':
        await git.abortMerge();
        break;
      case 'continue-rebase':
        await git.continueRebase();
        break;
      case 'abort-rebase':
        await git.abortRebase();
        break;
      case 'get-remotes':
        const remotes = await git.getRemotes();
        return NextResponse.json({ success: true, remotes });
      case 'get-remote-branches':
        if (!data?.remote) throw new Error('Remote name is required');
        const remoteBranches = await git.getRemoteBranches(data.remote);
        return NextResponse.json({ success: true, branches: remoteBranches });
      case 'get-tracking-branch':
        if (!data?.branch) throw new Error('Branch name is required');
        const tracking = await git.getTrackingBranch(data.branch);
        return NextResponse.json({ success: true, tracking });
      case 'get-latest-commit-message':
        if (!data?.branch) throw new Error('Branch name is required');
        const message = await git.getLatestCommitMessage(data.branch);
        return NextResponse.json({ success: true, message });
      case 'get-merge-base':
        if (!data?.targetRef) throw new Error('Target ref is required');
        if (!data?.sourceRef) throw new Error('Source ref is required');
        const mergeBase = await git.getMergeBase(data.targetRef, data.sourceRef);
        return NextResponse.json({ success: true, mergeBase });
      case 'push-to-remote':
        console.log('[API] push-to-remote action received:', data);
        if (!data?.localBranch) throw new Error('Local branch is required');
        if (!data?.remote) throw new Error('Remote is required');
        if (!data?.remoteBranch) throw new Error('Remote branch is required');
        
        const creds = await resolveCredentials(repoPath, git, data.remote);
        
        console.log('[API] Calling git.pushToRemote...');
        await git.pushToRemote(data.localBranch, data.remote, data.remoteBranch, {
          rebaseFirst: data.rebaseFirst ?? !(data.forcePush ?? false),
          forcePush: data.forcePush ?? false,
          pushLocalOnlyTags: data.pushLocalOnlyTags ?? true,
          setUpstream: data.setUpstream ?? false,
          squash: data.squash ?? false,
          squashMessage: data.squashMessage,
          credentials: creds,
        });
        console.log('[API] git.pushToRemote completed');
        break;
      case 'pull-from-remote':
        console.log('[API] pull-from-remote action received:', data);
        if (!data?.localBranch) throw new Error('Local branch is required');
        if (!data?.remote) throw new Error('Remote is required');
        if (!data?.remoteBranch) throw new Error('Remote branch is required');
        console.log('[API] Calling git.pullFromRemote...');
        await git.pullFromRemote(data.localBranch, data.remote, data.remoteBranch, {
          rebase: data.rebase ?? true,
        });
        console.log('[API] git.pullFromRemote completed');
        break;
      case 'stash':
        await git.stash(data?.message);
        break;
      case 'stash-list':
        const stashes = await git.getStashes();
        return NextResponse.json({ success: true, stashes });
      case 'stash-apply':
        if (data?.index === undefined) throw new Error('Stash index is required');
        await git.applyStash(data.index);
        break;
      case 'stash-drop':
        if (data?.index === undefined) throw new Error('Stash index is required');
        await git.dropStash(data.index);
        break;
      case 'stash-pop':
        if (data?.index === undefined) throw new Error('Stash index is required');
        await git.popStash(data.index);
        break;
      case 'stash-files':
        if (data?.index === undefined) throw new Error('Stash index is required');
        const stashFiles = await git.getStashFiles(data.index);
        return NextResponse.json({ success: true, files: stashFiles });
      case 'stash-file-diff':
        if (data?.index === undefined) throw new Error('Stash index is required');
        if (!data?.file) throw new Error('File path is required');
        if (isImageFile(data.file)) {
          const mimeType = getImageMimeType(data.file);
          const [leftBuffer, rightBuffer, diff] = await Promise.all([
            git.getFileContentBuffer(data.file, `stash@{${data.index}}^1`),
            git.getFileContentBuffer(data.file, `stash@{${data.index}}`),
            git.getStashFilePatch(data.index, data.file),
          ]);

          return NextResponse.json({
            success: true,
            left: '',
            right: '',
            diff,
            imageDiff: {
              left: toImageSide(leftBuffer, mimeType),
              right: toImageSide(rightBuffer, mimeType),
            },
          });
        }

        const stashFileDiff = await git.getStashFileDiff(data.index, data.file);
        return NextResponse.json({ success: true, ...stashFileDiff });
      case 'cleanup-lock-file':
        const cleaned = await git.cleanupLockFile();
        return NextResponse.json({ success: true, cleaned });
      default:
        return NextResponse.json({ error: 'Invalid action' }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return handleGitError(error);
  }
}
