import { simpleGit, SimpleGit, SimpleGitOptions } from 'simple-git';
import { GitStatus, GitLog, GitWorktree, GitConflictState } from './types';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, unlink, access, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

function normalizeRemoteUrlForHttpAuth(remoteUrl: string): string | null {
  if (remoteUrl.startsWith('http://') || remoteUrl.startsWith('https://')) {
    return remoteUrl;
  }

  // Support converting common SSH format to HTTPS for token-based auth.
  // Example: git@github.com:owner/repo.git -> https://github.com/owner/repo.git
  const sshMatch = remoteUrl.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}`;
  }

  return null;
}

function withCredentialsInRemoteUrl(remoteUrl: string, credentials: { username: string; token: string }): string {
  const normalized = normalizeRemoteUrlForHttpAuth(remoteUrl);
  if (!normalized) {
    return remoteUrl;
  }

  const urlObj = new URL(normalized);
  urlObj.username = credentials.username;
  urlObj.password = credentials.token;
  return urlObj.toString();
}

// Cache simple-git instances to avoid spawning too many processes if possible,
// though simple-git is lightweight.
const gitInstances: Record<string, SimpleGit> = {};

export function getGit(repoPath: string): SimpleGit {
  if (!gitInstances[repoPath]) {
    const options: Partial<SimpleGitOptions> = {
      baseDir: repoPath,
      binary: 'git',
      maxConcurrentProcesses: 6,
      trimmed: false,
    };
    const git = simpleGit(options);
    
    // Configure git to not prompt for credentials - fail instead of hang
    git.env({
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no',
    });
    
    gitInstances[repoPath] = git;
  }
  return gitInstances[repoPath];
}

export class GitService {
  constructor(private repoPath: string) { }

  private get git(): SimpleGit {
    return getGit(this.repoPath);
  }

  private resolveFilePathWithinRepo(filePath: string): string {
    const resolvedRepoPath = resolve(this.repoPath);
    const resolvedFilePath = resolve(resolvedRepoPath, filePath);
    const rel = relative(resolvedRepoPath, resolvedFilePath);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`File path is outside repository: ${filePath}`);
    }
    return resolvedFilePath;
  }

  static async cloneRepository(
    repoUrl: string,
    destinationPath: string,
    options: { credentials?: { username: string; token: string } } = {}
  ): Promise<void> {
    const trimmedRepoUrl = repoUrl.trim();
    const trimmedDestinationPath = destinationPath.trim();

    if (!trimmedRepoUrl) {
      throw new Error('Repository URL is required');
    }
    if (!trimmedDestinationPath) {
      throw new Error('Destination path is required');
    }

    const git = simpleGit({
      binary: 'git',
      maxConcurrentProcesses: 2,
      trimmed: false,
    });

    git.env({
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no',
    });

    const cloneUrl = options.credentials
      ? withCredentialsInRemoteUrl(trimmedRepoUrl, options.credentials)
      : trimmedRepoUrl;

    await git.clone(cloneUrl, trimmedDestinationPath);

    // Never persist tokenized URL in cloned repository config.
    if (cloneUrl !== trimmedRepoUrl) {
      const clonedGit = getGit(trimmedDestinationPath);
      await clonedGit.raw(['remote', 'set-url', 'origin', trimmedRepoUrl]);
    }
  }

  static async initializeRepository(directoryPath: string): Promise<void> {
    const trimmedPath = directoryPath.trim();
    if (!trimmedPath) {
      throw new Error('Path is required');
    }

    const git = simpleGit({
      baseDir: trimmedPath,
      binary: 'git',
      maxConcurrentProcesses: 2,
      trimmed: false,
    });
    await git.init();
  }

  async cleanupLockFile(): Promise<boolean> {
    const lockFilePath = join(this.repoPath, '.git', 'index.lock');
    try {
      await unlink(lockFilePath);
      return true;
    } catch (e) {
      // Ignore if file doesn't exist
      return false;
    }
  }

  async getStatus(): Promise<GitStatus> {
    const status = await this.git.status();
    // Transform simple-git status to our generic definitions if needed, 
    // but simple-git's StatusResult is compatible enough for now, 
    // except we might want to sanitize paths.
    // For now, we return it as is, casting to our interface (which matches simple-git mostly).
    return status as unknown as GitStatus;
  }

  private async hasRef(ref: string): Promise<boolean> {
    try {
      await this.git.revparse(['--verify', ref]);
      return true;
    } catch {
      return false;
    }
  }

  private async gitPathExists(gitPathName: string): Promise<boolean> {
    try {
      const gitPath = (await this.git.raw(['rev-parse', '--git-path', gitPathName])).trim();
      if (!gitPath) return false;
      await access(gitPath);
      return true;
    } catch {
      return false;
    }
  }

  async getConflictState(): Promise<GitConflictState> {
    const status = await this.git.status();
    const conflictedFiles = status.conflicted ?? [];
    const hasConflicts = conflictedFiles.length > 0;

    const [hasMergeHead, hasRebaseHead, hasRebaseApply, hasRebaseMerge] = await Promise.all([
      this.hasRef('MERGE_HEAD'),
      this.hasRef('REBASE_HEAD'),
      this.gitPathExists('rebase-apply'),
      this.gitPathExists('rebase-merge'),
    ]);

    let operation: GitConflictState['operation'] = null;
    if (hasRebaseHead || hasRebaseApply || hasRebaseMerge) {
      operation = 'rebase';
    } else if (hasMergeHead) {
      operation = 'merge';
    }

    return {
      operation,
      conflictedFiles,
      hasConflicts,
      canContinue: Boolean(operation) && !hasConflicts,
    };
  }

  async getLog(limit: number = 100, options: { includeAll?: boolean } = {}): Promise<GitLog> {
    const { includeAll = true } = options;
    const logOptions = {
      // Keep refs stable regardless of user-level git config (e.g. log.decorate=full).
      decorate: 'short',
      maxCount: limit,
      ...(includeAll ? { all: null } : {}),
      format: {
        hash: '%h',
        parents: '%p',
        date: '%ai',
        message: '%s',
        refs: '%d',
        author_name: '%an',
        author_email: '%ae',
        body: '%b'
      }
    };

    // Custom format to ensure we get parents and refs correctly.
    const log = await this.git.log(logOptions);

    // Transform simple-git ListLogLine to our Commit type
    // simple-git handles the parsing if we pass the format object keys correctly matching our type, mostly.
    // Parents in simple-git are usually just space separated string in the custom format result unless processed.
    // We might need to map it.

    const commits = log.all.map((commit) => ({
      ...commit,
      parents: typeof commit.parents === 'string' ? commit.parents.split(' ').filter(Boolean) : []
    }));

    return {
      all: commits,
      total: log.total,
      latest: commits[0] || null
    } as unknown as GitLog;
  }

  async getLatestCommitMessage(branch: string): Promise<string> {
    const message = await this.git.raw(['show', '-s', '--format=%B', branch]);
    return message.trimEnd();
  }

  async fetch(): Promise<void> {
    await this.git.raw(['fetch', '--prune']);
  }

  async fetchRemote(remote: string): Promise<void> {
    await this.git.raw(['fetch', '--prune', remote]);
  }

  async fetchAllRemotes(): Promise<void> {
    await this.git.raw(['fetch', '--all', '--prune']);
  }

  async addRemote(name: string, url: string): Promise<void> {
    const trimmedName = name.trim();
    const trimmedUrl = url.trim();

    if (!trimmedName) throw new Error('Remote name is required');
    if (!trimmedUrl) throw new Error('Remote URL is required');

    await this.git.raw(['remote', 'add', trimmedName, trimmedUrl]);
    await this.git.raw(['fetch', '--prune', trimmedName]);
  }

  async renameRemote(oldName: string, newName: string): Promise<void> {
    const trimmedOldName = oldName.trim();
    const trimmedNewName = newName.trim();

    if (!trimmedOldName) throw new Error('Old remote name is required');
    if (!trimmedNewName) throw new Error('New remote name is required');
    if (trimmedOldName === trimmedNewName) return;

    await this.git.raw(['remote', 'rename', trimmedOldName, trimmedNewName]);
  }

  async deleteRemote(name: string): Promise<void> {
    const trimmedName = name.trim();
    if (!trimmedName) throw new Error('Remote name is required to delete remote');

    await this.git.raw(['remote', 'remove', trimmedName]);
  }

  async pull(): Promise<void> {
    await this.git.pull();
  }

  async push(options: { credentials?: { username: string; token: string } } = {}): Promise<void> {
    const { credentials } = options;

    if (credentials) {
      // If credentials are provided, we must use pushToRemote with the authenticated URL
      // We need to resolve the current branch and its upstream
      const branchSummary = await this.git.branchLocal();
      const currentBranch = branchSummary.current;
      
      const tracking = await this.getTrackingBranch(currentBranch);
      if (!tracking) {
        throw new Error(`No upstream configured for branch '${currentBranch}'. Cannot push with credentials.`);
      }

      await this.pushToRemote(currentBranch, tracking.remote, tracking.branch, { credentials });
    } else {
      await this.git.push();
    }
  }

  private async hasHeadCommit(): Promise<boolean> {
    try {
      await this.git.revparse(['--verify', 'HEAD']);
      return true;
    } catch {
      return false;
    }
  }

  private async validateBranchName(branch: string): Promise<void> {
    await this.git.raw(['check-ref-format', '--branch', branch]);
  }

  private async ensureInitialBranchForFirstCommit(initialBranch?: string): Promise<void> {
    if (!initialBranch) return;
    if (await this.hasHeadCommit()) return;

    const branch = initialBranch.trim();
    if (!branch) {
      throw new Error('Initial branch name is required for first commit');
    }

    await this.validateBranchName(branch);
    await this.git.raw(['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  }

  async commit(message: string, files?: string[], options: { initialBranch?: string } = {}): Promise<void> {
    await this.ensureInitialBranchForFirstCommit(options.initialBranch);

    if (files && files.length > 0) {
      await this.git.add(files);
    }
    await this.git.commit(message);
  }

  async stage(files: string[]): Promise<void> {
    await this.git.add(files);
  }

  async unstage(files: string[]): Promise<void> {
    await this.git.reset(['HEAD', ...files]);
  }

  async discardUnstagedChanges(options: { includeUntracked?: boolean } = {}): Promise<void> {
    const { includeUntracked = true } = options;

    // Restore tracked working tree changes from index (keeps staged changes intact).
    await this.git.raw(['checkout', '--', '.']);

    if (includeUntracked) {
      // Remove untracked files/directories, but keep ignored files.
      await this.git.raw(['clean', '-fd']);
    }
  }

  // Get raw file content for diffing
  async getFileContent(path: string, ref: string = 'HEAD'): Promise<string> {
    if (ref === 'HEAD' && !(await this.hasHeadCommit())) {
      return '';
    }

    try {
      return await this.git.show([`${ref}:${path}`]);
    } catch (e) {
      // If file is new (untracked), we might want to read from fs?
      // But for "HEAD", it fails.
      // Let's assume frontend handles untracked files by reading fs API directly? 
      // Or we fallback here?
      // For now, let it throw or return empty.
      console.error(e);
      return "";
    }
  }

  private async getBlobFromRef(refSpec: string): Promise<Buffer | null> {
    try {
      const { stdout } = await execFileAsync('git', ['show', refSpec], {
        cwd: this.repoPath,
        encoding: 'buffer',
        maxBuffer: 50 * 1024 * 1024, // 50MB safety cap
      });
      return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    } catch {
      return null;
    }
  }

  async getFileContentBuffer(path: string, ref: string = 'HEAD'): Promise<Buffer | null> {
    if (ref === 'HEAD' && !(await this.hasHeadCommit())) {
      return null;
    }
    return this.getBlobFromRef(`${ref}:${path}`);
  }

  async getConflictFileVersions(path: string): Promise<{ ours: string; theirs: string; current: string }> {
    const [oursBuffer, theirsBuffer] = await Promise.all([
      this.getBlobFromRef(`:2:${path}`),
      this.getBlobFromRef(`:3:${path}`),
    ]);

    let current = '';
    try {
      const fullPath = this.resolveFilePathWithinRepo(path);
      current = await readFile(fullPath, 'utf-8');
    } catch {
      current = '';
    }

    return {
      ours: oursBuffer ? oursBuffer.toString('utf-8') : '',
      theirs: theirsBuffer ? theirsBuffer.toString('utf-8') : '',
      current,
    };
  }

  async resolveConflictFile(
    path: string,
    strategy: 'ours' | 'theirs' | 'manual',
    options: { content?: string; stage?: boolean } = {}
  ): Promise<void> {
    const { content, stage = true } = options;

    if (strategy === 'ours' || strategy === 'theirs') {
      await this.git.raw(['checkout', `--${strategy}`, '--', path]);
    } else {
      if (typeof content !== 'string') {
        throw new Error('Content is required for manual conflict resolution');
      }
      const fullPath = this.resolveFilePathWithinRepo(path);
      await writeFile(fullPath, content, 'utf-8');
    }

    if (stage) {
      await this.git.add([path]);
    }
  }

  async getDiff(path: string): Promise<string> {
    if (!(await this.hasHeadCommit())) {
      // In repos without commits, show both staged and unstaged file changes.
      const [stagedDiff, unstagedDiff] = await Promise.all([
        this.git.diff(['--cached', '--', path]),
        this.git.diff(['--', path]),
      ]);
      return [stagedDiff, unstagedDiff].filter(Boolean).join('\n');
    }

    // Get diff of working directory vs index (unstaged changes)
    // or index vs HEAD (staged changes)
    // This is a complex topic.
    // Keep comparing against HEAD, but force pathspec parsing with `--`
    // so deleted files (missing from working tree) are still treated as paths.
    return await this.git.diff(['HEAD', '--', path]);
  }

  private parseWorktreeEntries(rawWorktreeOutput: string): GitWorktree[] {
    const worktrees: Array<Omit<GitWorktree, 'isCurrent'> & { detached: boolean }> = [];
    let currentEntry: { path: string; branch: string | null; head: string | null; detached: boolean } | null = null;

    for (const line of rawWorktreeOutput.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (currentEntry) {
          worktrees.push(currentEntry);
        }
        currentEntry = {
          path: line.slice('worktree '.length).trim(),
          branch: null,
          head: null,
          detached: false,
        };
        continue;
      }

      if (!currentEntry) continue;

      if (line.startsWith('branch ')) {
        const branchRef = line.slice('branch '.length).trim();
        currentEntry.branch = branchRef.startsWith('refs/heads/')
          ? branchRef.slice('refs/heads/'.length)
          : branchRef || null;
        continue;
      }

      if (line.startsWith('HEAD ')) {
        currentEntry.head = line.slice('HEAD '.length).trim() || null;
        continue;
      }

      if (line === 'detached') {
        currentEntry.detached = true;
      }
    }

    if (currentEntry) {
      worktrees.push(currentEntry);
    }

    const normalizedRepoPath = resolve(this.repoPath);
    const uniqueByPath = new Map<string, GitWorktree>();
    for (const entry of worktrees) {
      const normalizedPath = resolve(entry.path);
      if (uniqueByPath.has(normalizedPath)) continue;
      uniqueByPath.set(normalizedPath, {
        path: entry.path,
        branch: entry.detached ? null : entry.branch,
        head: entry.head,
        isCurrent: normalizedPath === normalizedRepoPath,
      });
    }

    return Array.from(uniqueByPath.values()).sort((a, b) => {
      if (a.isCurrent && !b.isCurrent) return -1;
      if (!a.isCurrent && b.isCurrent) return 1;
      return a.path.localeCompare(b.path);
    });
  }

  async getWorktrees(currentBranch: string): Promise<GitWorktree[]> {
    try {
      const rawOutput = await this.git.raw(['worktree', 'list', '--porcelain']);
      const parsed = this.parseWorktreeEntries(rawOutput);
      if (parsed.length > 0) return parsed;
    } catch (error) {
      console.warn('Failed to list git worktrees:', error);
    }

    return [{
      path: this.repoPath,
      branch: currentBranch || null,
      head: null,
      isCurrent: true,
    }];
  }

  async getBranches() {
    // 1. Get current branch (HEAD)
    let currentBranch = '';
    try {
      currentBranch = (await this.git.revparse(['--abbrev-ref', 'HEAD'])).trim();
    } catch (e) {
      console.warn('Failed to get current branch:', e);
    }

    // 2. Get all refs (local and remote) with details
    // Format: refname|short_hash|upstream|upstream_track
    // Use a delimiter that is unlikely to be in branch names. '|' is good.
    const format = '%(refname)|%(objectname:short)|%(upstream:short)|%(upstream:track)';
    let rawRefs = '';
    try {
      rawRefs = await this.git.raw(['for-each-ref', `--format=${format}`, 'refs/heads', 'refs/remotes']);
    } catch (e) {
      console.error('Failed to get refs:', e);
      throw e;
    }

    const branches: string[] = [];
    const branchCommits: Record<string, string> = {};
    const remotes: Record<string, string[]> = {};
    const trackingInfo: Record<string, { upstream: string; ahead: number; behind: number }> = {};
    
    const lines = rawRefs.trim().split('\n');

    for (const line of lines) {
      if (!line) continue;

      const [refname, hash, upstream, track] = line.split('|');

      if (refname.startsWith('refs/heads/')) {
        // Local branch
        const branchName = refname.slice('refs/heads/'.length);
        branches.push(branchName);
        branchCommits[branchName] = hash;
        
        if (upstream) {
          // Parse track info: "[ahead 1, behind 2]"
          let ahead = 0;
          let behind = 0;
          if (track) {
            const aheadMatch = track.match(/ahead (\d+)/);
            if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);

            const behindMatch = track.match(/behind (\d+)/);
            if (behindMatch) behind = parseInt(behindMatch[1], 10);
          }
          
          trackingInfo[branchName] = {
            upstream, // e.g. "origin/main"
            ahead,
            behind
          };
        }
      } else if (refname.startsWith('refs/remotes/')) {
        // Remote branch
        const withoutPrefix = refname.slice('refs/remotes/'.length);
        // Format: origin/main
        const slashIndex = withoutPrefix.indexOf('/');
        if (slashIndex > 0) {
            const remoteName = withoutPrefix.slice(0, slashIndex);
            const branchName = withoutPrefix.slice(slashIndex + 1);

            // Skip HEAD symbolic refs
            if (branchName === 'HEAD' || branchName.startsWith('HEAD ')) continue;

            if (!remotes[remoteName]) {
                remotes[remoteName] = [];
            }
            remotes[remoteName].push(branchName);

            // Store commit hash with full remote ref path as used in frontend/original code
            // Original code used `branch` from `git.branch(['-a'])` which returns `remotes/origin/main`
            branchCommits[`remotes/${withoutPrefix}`] = hash;
        }
      }
    }

    // 3. Get remote URLs
    const remoteList = await this.git.getRemotes(true);
    const remoteUrls: Record<string, string> = {};
    for (const r of remoteList) {
        remoteUrls[r.name] = r.refs.fetch || r.refs.push;
        if (!remotes[r.name]) {
          remotes[r.name] = [];
        }
    }
    const worktrees = await this.getWorktrees(currentBranch);

    return {
      branches,
      current: currentBranch,
      branchCommits,
      remotes, // { "origin": ["main", "feature"], "upstream": ["main"] }
      remoteUrls,
      trackingInfo, // { "main": { upstream: "origin/main", ahead: 5, behind: 1 } }
      worktrees,
    };
  }

  async checkout(branch: string): Promise<void> {
    await this.git.checkout(branch);
  }

  async checkoutRemoteToLocal(remoteBranch: string, localBranch: string): Promise<void> {
    // remoteBranch is in format: remotes/origin/branch-name
    // We need to extract origin/branch-name for the tracking setup
    
    // First, verify the remote branch exists
    try {
      await this.git.revparse(['--verify', `refs/${remoteBranch}`]);
    } catch {
      throw new Error(`Remote branch '${remoteBranch}' does not exist`);
    }
    
    // Check if local branch already exists
    try {
      await this.git.revparse(['--verify', `refs/heads/${localBranch}`]);
      throw new Error(`Local branch '${localBranch}' already exists`);
    } catch (e) {
      // Branch doesn't exist, which is what we want (unless it's our "already exists" error)
      if ((e as Error).message.includes('already exists')) {
        throw e;
      }
    }
    
    // Extract the remote name and branch name from remotes/origin/branch-name
    const withoutRemotesPrefix = remoteBranch.replace(/^remotes\//, '');
    const slashIndex = withoutRemotesPrefix.indexOf('/');
    if (slashIndex <= 0) {
      throw new Error(`Invalid remote branch format: ${remoteBranch}`);
    }
    const remoteName = withoutRemotesPrefix.slice(0, slashIndex);
    const remoteBranchName = withoutRemotesPrefix.slice(slashIndex + 1);
    
    // Create local branch from remote branch and set up tracking
    // git checkout -b <local-branch> --track <remote>/<branch>
    await this.git.checkout(['-b', localBranch, '--track', `${remoteName}/${remoteBranchName}`]);
  }

  async createBranch(branch: string, fromRef?: string): Promise<void> {
    if (!fromRef) {
      await this.git.checkoutLocalBranch(branch);
      return;
    }

    // For remote refs, use "<remote>/<branch>" as start point.
    const startPoint = fromRef.startsWith('remotes/')
      ? fromRef.replace(/^remotes\//, '')
      : fromRef;

    await this.git.checkout(['-b', branch, startPoint]);
  }

  async createTag(
    tagName: string,
    commitHash: string,
    options: {
      pushToRemote?: boolean;
      remote?: string;
      credentials?: { username: string; token: string };
    } = {}
  ): Promise<void> {
    const { pushToRemote = false, remote, credentials } = options;

    const cleanTagName = tagName.trim();
    const cleanCommitHash = commitHash.trim();
    if (!cleanTagName) {
      throw new Error('Tag name is required');
    }
    if (!cleanCommitHash) {
      throw new Error('Commit hash is required');
    }

    await this.git.raw(['tag', cleanTagName, cleanCommitHash]);

    if (!pushToRemote) return;

    const allRemotes = await this.git.getRemotes();
    if (allRemotes.length === 0) {
      throw new Error('No remotes configured for this repository');
    }

    let selectedRemote = remote?.trim() || '';
    if (!selectedRemote) {
      const currentBranch = (await this.git.branchLocal()).current;
      if (currentBranch) {
        const tracking = await this.getTrackingBranch(currentBranch);
        if (tracking?.remote) {
          selectedRemote = tracking.remote;
        }
      }
    }

    if (!selectedRemote || !allRemotes.some((item) => item.name === selectedRemote)) {
      selectedRemote = allRemotes.some((item) => item.name === 'origin') ? 'origin' : allRemotes[0].name;
    }

    let targetRemote = selectedRemote;
    if (credentials) {
      const remoteUrl = await this.getRemoteUrl(selectedRemote);
      if (remoteUrl) {
        try {
          const urlObj = new URL(remoteUrl);
          urlObj.username = credentials.username;
          urlObj.password = credentials.token;
          targetRemote = urlObj.toString();
        } catch (e) {
          console.warn('[createTag] Failed to construct authenticated URL, falling back to remote name', e);
        }
      } else {
        console.warn(`[createTag] Could not resolve URL for remote '${selectedRemote}', falling back to remote name`);
      }
    }

    await this.git.push([targetRemote, `refs/tags/${cleanTagName}`]);
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.git.deleteLocalBranch(branch, true);
  }

  async deleteWorktree(worktreePath: string): Promise<void> {
    const targetPath = worktreePath.trim();
    if (!targetPath) {
      throw new Error('Worktree path is required');
    }

    const resolvedTargetPath = resolve(targetPath);
    const resolvedCurrentRepoPath = resolve(this.repoPath);
    if (resolvedTargetPath === resolvedCurrentRepoPath) {
      throw new Error('Cannot delete the current worktree');
    }

    const worktrees = await this.getWorktrees('');
    const isKnownWorktree = worktrees.some((worktree) => resolve(worktree.path) === resolvedTargetPath);
    if (!isKnownWorktree) {
      throw new Error(`Worktree not found: ${targetPath}`);
    }

    await this.git.raw(['worktree', 'remove', targetPath]);
    await this.git.raw(['worktree', 'prune']);
  }

  async deleteRemoteBranch(remote: string, branch: string, credentials?: { username: string; token: string }): Promise<void> {
    let targetRemote = remote;

    if (credentials) {
      const remoteUrl = await this.getRemoteUrl(remote);
      if (remoteUrl) {
        try {
          const urlObj = new URL(remoteUrl);
          urlObj.username = credentials.username;
          urlObj.password = credentials.token;
          targetRemote = urlObj.toString();
        } catch (e) {
          console.warn('[deleteRemoteBranch] Failed to construct authenticated URL, falling back to remote name', e);
        }
      } else {
        console.warn(`[deleteRemoteBranch] Could not resolve URL for remote '${remote}', falling back to remote name`);
      }
    }

    try {
      await this.git.push([targetRemote, '--delete', branch]);
    } catch (e: any) {
      const errorMessage = e?.message || '';
      if (errorMessage.includes('remote ref does not exist')) {
        console.debug(`[deleteRemoteBranch] Remote branch ${branch} does not exist on remote ${remote}, ignoring error.`);
      } else {
        throw e;
      }
    }

    // Also delete the remote-tracking branch locally to update the view immediately
    // This is necessary because if we used a URL for targetRemote, git won't automatically prune the named remote's ref
    try {
      await this.git.branch(['-r', '-D', `${remote}/${branch}`]);
    } catch (e) {
      // Ignore error if branch doesn't exist locally or if deletion fails for some reason
      console.debug(`[deleteRemoteBranch] Could not delete local remote-tracking branch ${remote}/${branch}:`, e);
    }
  }

  async deleteTag(tag: string): Promise<void> {
    await this.git.raw(['tag', '-d', tag]);
  }

  async deleteRemoteTag(remote: string, tag: string, credentials?: { username: string; token: string }): Promise<void> {
    let targetRemote = remote;

    if (credentials) {
      const remoteUrl = await this.getRemoteUrl(remote);
      if (remoteUrl) {
        try {
          const urlObj = new URL(remoteUrl);
          urlObj.username = credentials.username;
          urlObj.password = credentials.token;
          targetRemote = urlObj.toString();
        } catch (e) {
          console.warn('[deleteRemoteTag] Failed to construct authenticated URL, falling back to remote name', e);
        }
      } else {
        console.warn(`[deleteRemoteTag] Could not resolve URL for remote '${remote}', falling back to remote name`);
      }
    }

    await this.git.push([targetRemote, '--delete', `refs/tags/${tag}`]);
  }

  async renameBranch(
    oldName: string,
    newName: string,
    options: {
      renameTrackingRemote?: boolean;
      credentials?: { username: string; token: string };
    } = {}
  ): Promise<void> {
    const { renameTrackingRemote = false, credentials } = options;
    const trackingBeforeRename = renameTrackingRemote
      ? await this.getTrackingBranch(oldName)
      : null;

    await this.git.branch(['-m', oldName, newName]);

    if (!renameTrackingRemote || !trackingBeforeRename) return;

    await this.renameRemoteBranch(
      trackingBeforeRename.remote,
      trackingBeforeRename.branch,
      newName,
      credentials
    );

    // Keep the renamed local branch tracking the renamed remote branch.
    try {
      await this.git.branch(['--set-upstream-to', `${trackingBeforeRename.remote}/${newName}`, newName]);
    } catch (e) {
      console.debug(`[renameBranch] Could not set upstream for ${newName} to ${trackingBeforeRename.remote}/${newName}:`, e);
    }
  }

  async renameRemoteBranch(
    remote: string,
    oldName: string,
    newName: string,
    credentials?: { username: string; token: string }
  ): Promise<void> {
    if (oldName === newName) return;

    let targetRemote = remote;

    if (credentials) {
      const remoteUrl = await this.getRemoteUrl(remote);
      if (remoteUrl) {
        try {
          const urlObj = new URL(remoteUrl);
          urlObj.username = credentials.username;
          urlObj.password = credentials.token;
          targetRemote = urlObj.toString();
        } catch (e) {
          console.warn('[renameRemoteBranch] Failed to construct authenticated URL, falling back to remote name', e);
        }
      } else {
        console.warn(`[renameRemoteBranch] Could not resolve URL for remote '${remote}', falling back to remote name`);
      }
    }

    // Create the new remote branch from the old remote-tracking ref, then delete the old remote branch.
    // Using the remote-tracking ref avoids requiring a same-named local branch to exist.
    const oldTrackingRef = `refs/remotes/${remote}/${oldName}`;
    await this.git.push([targetRemote, `${oldTrackingRef}:refs/heads/${newName}`]);
    await this.git.push([targetRemote, '--delete', oldName]);

    // Update remote-tracking refs locally so the branches tree reflects the rename immediately.
    const newTrackingRef = `refs/remotes/${remote}/${newName}`;
    try {
      const oldTrackingHash = (await this.git.revparse([oldTrackingRef])).trim();
      await this.git.raw(['update-ref', newTrackingRef, oldTrackingHash]);
    } catch (e) {
      console.debug(`[renameRemoteBranch] Could not update local tracking ref ${newTrackingRef}:`, e);
    }

    try {
      await this.git.branch(['-r', '-D', `${remote}/${oldName}`]);
    } catch (e) {
      console.debug(`[renameRemoteBranch] Could not delete old local remote-tracking branch ${remote}/${oldName}:`, e);
    }
  }

  async reset(commitHash: string, mode: 'hard' | 'soft' | 'mixed' = 'hard'): Promise<void> {
    await this.git.reset([`--${mode}`, commitHash]);
  }

  async revert(commitHash: string): Promise<void> {
    await this.git.raw(['revert', '--no-edit', commitHash]);
  }

  async cherryPick(commitHash: string): Promise<void> {
    await this.git.raw(['cherry-pick', commitHash]);
  }

  async cherryPickMultiple(commitHashes: string[]): Promise<void> {
    if (commitHashes.length === 0) return;
    await this.git.raw(['cherry-pick', ...commitHashes]);
  }

  async abortCherryPick(): Promise<void> {
    await this.git.raw(['cherry-pick', '--abort']);
  }

  async continueMerge(): Promise<void> {
    await this.git.raw(['merge', '--continue']);
  }

  async abortMerge(): Promise<void> {
    await this.git.raw(['merge', '--abort']);
  }

  async continueRebase(): Promise<void> {
    await this.git.raw(['rebase', '--continue']);
  }

  async abortRebase(): Promise<void> {
    await this.git.raw(['rebase', '--abort']);
  }

  async rebase(ontoBranch: string, stashChanges: boolean = true): Promise<void> {
    if (stashChanges) {
      // Stash any local changes before rebasing
      const status = await this.git.status();
      const hasChanges = status.files.length > 0;
      
      if (hasChanges) {
        await this.git.stash(['push', '-m', 'auto-stash before rebase']);
      }
      
      try {
        await this.git.rebase([ontoBranch]);
        
        // Reapply stashed changes if we stashed anything
        if (hasChanges) {
          await this.git.stash(['pop']);
        }
      } catch (e) {
        // If rebase fails, try to pop stash anyway so user doesn't lose changes
        if (hasChanges) {
          try {
            await this.git.stash(['pop']);
          } catch {
            // Stash pop might fail if there are conflicts, that's ok
          }
        }
        throw e;
      }
    } else {
      // Discard local changes by resetting before rebase
      await this.git.reset(['--hard', 'HEAD']);
      await this.git.rebase([ontoBranch]);
    }
  }

  async reword(commitHash: string, newMessage: string, branch?: string): Promise<void> {
    const branchSummary = await this.git.branchLocal();
    const currentBranch = branchSummary.current;
    const targetBranch = branch || currentBranch;
    const needsCheckout = targetBranch !== currentBranch;

    // Check if we have uncommitted changes
    const status = await this.git.status();
    const hasChanges = status.files.length > 0;

    if (hasChanges) {
      // Stash changes before checkout
      await this.git.stash(['push', '-m', 'auto-stash before reword']);
    }

    // Checkout the target branch if it's not the current one
    if (needsCheckout) {
      await this.git.checkout(targetBranch);
    }

    try {
      // Verify that the commit to be reworded is the latest commit (HEAD)
      const headCommit = await this.git.revparse(['HEAD']);
      // We compare full hashes or short hashes? simple-git revparse returns full hash.
      // commitHash might be short or full. Let's resolve commitHash to full hash first.
      const resolvedCommitHash = await this.git.revparse([commitHash]);

      if (headCommit.trim() !== resolvedCommitHash.trim()) {
        throw new Error(`Commit ${commitHash} is not the latest commit on branch ${targetBranch}. Only the latest commit can be reworded.`);
      }

      // Reword the commit
      // We use raw command to ensure we don't accidentally include other options or files,
      // and because simple-git's commit(message, options) signature can be tricky with overloading.
      // Also, since we stashed everything, the index is clean, so --amend will only change the message.
      await this.git.raw(['commit', '--amend', '-m', newMessage]);

      // If we switched branches, switch back
      if (needsCheckout) {
        await this.git.checkout(currentBranch);
      }

      // Pop stashed changes if we stashed them
      if (hasChanges) {
        try {
          await this.git.stash(['pop']);
        } catch {
          // Stash pop might fail if there are conflicts
          console.warn('Failed to pop stash after reword');
        }
      }
    } catch (e) {
      // If error occurs, try to restore state
      if (needsCheckout) {
        try {
          await this.git.checkout(currentBranch);
        } catch {
            // Ignore
        }
      }

      if (hasChanges) {
        try {
          await this.git.stash(['pop']);
        } catch {
            // Ignore
        }
      }
      throw e;
    }
  }

  private parseNameStatusDiff(diffStat: string): { path: string; additions: number; deletions: number; status: string }[] {
    return diffStat
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, ...pathParts] = line.split('\t');
        // For rename/copy entries (old + new path), keep the destination path.
        const path = pathParts.length > 1 ? pathParts[pathParts.length - 1] : (pathParts[0] ?? '');
        return { path, status, additions: 0, deletions: 0 };
      });
  }

  async getCommitRangeRefs(oldestCommitHash: string, latestCommitHash: string): Promise<{ fromRef: string; toRef: string }> {
    const oldest = oldestCommitHash.trim();
    const latest = latestCommitHash.trim();

    if (!oldest || !latest) {
      throw new Error('Both oldest and latest commit hashes are required');
    }

    // Exclude the oldest selected commit itself by comparing its tree with the latest selected commit.
    return { fromRef: oldest, toRef: latest };
  }

  async getCommitDiff(commitHash: string): Promise<{ files: { path: string; additions: number; deletions: number; status: string }[]; diff: string }> {
    // Get the list of files changed in this commit with stats
    // Use -m --first-parent to handle merge commits properly:
    // - For regular commits: compares against the single parent (same behavior as before)
    // - For merge commits: compares against the first parent (the branch being merged INTO)
    const diffStat = await this.git.raw(['diff-tree', '-m', '--first-parent', '--no-commit-id', '--name-status', '-r', commitHash]);
    const files = this.parseNameStatusDiff(diffStat);

    // Get the full diff for this commit
    // Use -m --first-parent for merge commits to show the diff against first parent
    const diff = await this.git.raw(['show', '-m', '--first-parent', '--format=', commitHash]);

    return { files, diff };
  }

  async getCommitRangeDiff(oldestCommitHash: string, latestCommitHash: string): Promise<{ files: { path: string; additions: number; deletions: number; status: string }[]; diff: string }> {
    const { fromRef, toRef } = await this.getCommitRangeRefs(oldestCommitHash, latestCommitHash);
    const diffStat = await this.git.raw(['diff', '--name-status', fromRef, toRef]);
    const files = this.parseNameStatusDiff(diffStat);
    const diff = await this.git.raw(['diff', fromRef, toRef]);
    return { files, diff };
  }

  async getCommitFileDiff(commitHash: string, filePath: string): Promise<{ before: string; after: string; diff: string }> {
    // Get file content before the commit (parent)
    let before = '';
    let after = '';
    
    try {
      before = await this.git.show([`${commitHash}^:${filePath}`]);
    } catch {
      // File didn't exist before this commit (new file)
      before = '';
    }
    
    try {
      after = await this.git.show([`${commitHash}:${filePath}`]);
    } catch {
      // File was deleted in this commit
      after = '';
    }

    const diff = await this.getCommitFilePatch(commitHash, filePath);
    
    return { before, after, diff };
  }

  async getCommitRangeFileDiff(oldestCommitHash: string, latestCommitHash: string, filePath: string): Promise<{ before: string; after: string; diff: string }> {
    const { fromRef, toRef } = await this.getCommitRangeRefs(oldestCommitHash, latestCommitHash);
    let before = '';
    let after = '';

    try {
      before = await this.git.show([`${fromRef}:${filePath}`]);
    } catch {
      before = '';
    }

    try {
      after = await this.git.show([`${toRef}:${filePath}`]);
    } catch {
      after = '';
    }

    const diff = await this.getCommitRangeFilePatch(oldestCommitHash, latestCommitHash, filePath);
    return { before, after, diff };
  }

  async getCommitFilePatch(commitHash: string, filePath: string): Promise<string> {
    try {
      // Use show to get the diff (log message suppressed by format=)
      return await this.git.raw(['show', '--format=', commitHash, '--', filePath]);
    } catch (e) {
      console.warn('Failed to get commit file diff:', e);
      return '';
    }
  }

  async getCommitRangeFilePatch(oldestCommitHash: string, latestCommitHash: string, filePath: string): Promise<string> {
    try {
      const { fromRef, toRef } = await this.getCommitRangeRefs(oldestCommitHash, latestCommitHash);
      return await this.git.raw(['diff', fromRef, toRef, '--', filePath]);
    } catch (e) {
      console.warn('Failed to get commit range file diff:', e);
      return '';
    }
  }

  async getMergeBase(targetRef: string, sourceRef: string): Promise<string | null> {
    const trimmedTargetRef = targetRef.trim();
    const trimmedSourceRef = sourceRef.trim();
    if (!trimmedTargetRef || !trimmedSourceRef) return null;

    try {
      const mergeBase = await this.git.raw(['merge-base', trimmedTargetRef, trimmedSourceRef]);
      const normalized = mergeBase.trim();
      return normalized || null;
    } catch {
      return null;
    }
  }

  async willMergeHaveConflicts(sourceBranch: string, targetBranch?: string): Promise<boolean> {
    const branchSummary = await this.git.branchLocal();
    const mergeTargetBranch = targetBranch || branchSummary.current;

    if (!mergeTargetBranch) {
      throw new Error('Could not determine target branch for merge conflict check');
    }

    if (sourceBranch === mergeTargetBranch) {
      return false;
    }

    // Ensure both refs can be resolved before checking for conflicts.
    await this.git.revparse(['--verify', sourceBranch]);
    await this.git.revparse(['--verify', mergeTargetBranch]);

    const hasMergeTreeConflictMarkers = (output: string): boolean => {
      const normalized = output.toLowerCase();
      if (
        normalized.includes('conflict') ||
        normalized.includes('changed in both') ||
        normalized.includes('added in both') ||
        normalized.includes('removed in both') ||
        output.includes('<<<<<<<')
      ) {
        return true;
      }

      // Some git versions emit conflicted index stage entries in merge-tree output.
      return /^[0-9]{6}\s+[0-9a-f]{40,64}\s+[123]\t/m.test(output);
    };

    try {
      // Modern Git: non-destructive conflict detection.
      // Some Git versions may still return exit code 0 even when output includes conflicts,
      // so we inspect output instead of relying only on exit code.
      const mergeTreeOutput = await this.git.raw(['merge-tree', '--write-tree', mergeTargetBranch, sourceBranch]);
      return hasMergeTreeConflictMarkers(mergeTreeOutput);
    } catch (e) {
      const errorOutput = e as { message?: string; stdout?: string; stderr?: string };
      const rawOutput = `${errorOutput.message ?? ''}\n${errorOutput.stdout ?? ''}\n${errorOutput.stderr ?? ''}`;
      const normalizedOutput = rawOutput.toLowerCase();

      if (hasMergeTreeConflictMarkers(rawOutput)) {
        return true;
      }

      const isWriteTreeUnsupported =
        normalizedOutput.includes('unknown option') ||
        normalizedOutput.includes('usage: git merge-tree');

      if (!isWriteTreeUnsupported) {
        // Be conservative for write-tree errors that are not clearly a capability issue.
        // False positives are preferable to missing real conflicts.
        return true;
      }
    }

    // Fallback for older Git versions without --write-tree.
    const mergeBase = (await this.git.raw(['merge-base', mergeTargetBranch, sourceBranch])).trim();
    const mergeTreeOutput = await this.git.raw(['merge-tree', mergeBase, mergeTargetBranch, sourceBranch]);
    const normalizedOutput = mergeTreeOutput.toLowerCase();

    return (
      mergeTreeOutput.includes('<<<<<<<') ||
      normalizedOutput.includes('changed in both') ||
      normalizedOutput.includes('added in both') ||
      normalizedOutput.includes('removed in both') ||
      normalizedOutput.includes('conflict')
    );
  }

  async willRebaseHaveConflicts(ontoBranch: string, sourceBranch?: string): Promise<boolean> {
    const branchSummary = await this.git.branchLocal();
    const rebaseSourceBranch = sourceBranch || branchSummary.current;

    if (!rebaseSourceBranch) {
      throw new Error('Could not determine source branch for rebase conflict check');
    }

    if (rebaseSourceBranch === ontoBranch) {
      return false;
    }

    // Ensure refs exist before creating a temporary worktree.
    await this.git.revparse(['--verify', rebaseSourceBranch]);
    await this.git.revparse(['--verify', ontoBranch]);

    const tempWorktreePath = await mkdtemp(join(tmpdir(), 'git-web-rebase-check-'));
    let worktreeAdded = false;

    try {
      // Detached worktree avoids locking local branch refs and keeps check isolated.
      await this.git.raw(['worktree', 'add', '--detach', tempWorktreePath, rebaseSourceBranch]);
      worktreeAdded = true;

      const tempGit = simpleGit({
        baseDir: tempWorktreePath,
        binary: 'git',
        maxConcurrentProcesses: 2,
        trimmed: false,
      });

      tempGit.env({
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no',
      });

      await tempGit.rebase([ontoBranch]);
      return false;
    } catch (e) {
      const errorOutput = e as { message?: string; stdout?: string; stderr?: string };
      const rawOutput = `${errorOutput.message ?? ''}\n${errorOutput.stdout ?? ''}\n${errorOutput.stderr ?? ''}`;
      const normalizedOutput = rawOutput.toLowerCase();

      if (normalizedOutput.includes('conflict') || normalizedOutput.includes('could not apply')) {
        return true;
      }

      throw e;
    } finally {
      if (worktreeAdded) {
        try {
          await this.git.raw(['worktree', 'remove', '--force', tempWorktreePath]);
        } catch (e) {
          console.debug(`[willRebaseHaveConflicts] Failed to remove temp worktree ${tempWorktreePath}:`, e);
        }
      }
    }
  }

  async merge(
    targetBranch: string,
    options: {
      rebaseBeforeMerge?: boolean;
      squash?: boolean;
      fastForward?: boolean;
      squashMessage?: string;
    } = {}
  ): Promise<void> {
    const { rebaseBeforeMerge, squash, fastForward, squashMessage } = options;

    // Get the current branch name (the branch we want to merge INTO)
    const branchSummary = await this.git.branchLocal();
    const currentBranch = branchSummary.current;

    // Rebase the target branch onto the current branch before merging if requested
    // This ensures a cleaner history or fast-forward merge
    if (rebaseBeforeMerge) {
      // We must switch to the target branch to rebase it
      await this.git.checkout(targetBranch);
      await this.git.rebase([currentBranch]);
      // Switch back to the branch we want to merge INTO
      await this.git.checkout(currentBranch);
    }

    // Build merge arguments
    const mergeArgs: string[] = [];

    if (squash) {
      mergeArgs.push('--squash');
    }

    if (fastForward) {
      mergeArgs.push('--ff-only');
    } else if (!squash) {
      // Use no-ff by default unless squashing (squash doesn't create a merge commit anyway)
      mergeArgs.push('--no-ff');
    }

    // Merge the target branch into current branch
    mergeArgs.push(targetBranch);

    await this.git.merge(mergeArgs);

    // If squash merge, we need to commit with the provided message
    if (squash) {
      const message = squashMessage || `Squash merge branch '${targetBranch}'`;
      await this.git.commit(message);
    }
  }

  async getRemotes(): Promise<string[]> {
    const remotes = await this.git.getRemotes();
    return remotes.map(r => r.name);
  }

  async getRemoteBranches(remote: string): Promise<string[]> {
    // Fetch from remote first to get latest branches
    await this.git.fetch(remote);
    
    const allBranches = await this.git.branch(['-r']);
    const remoteBranches: string[] = [];
    
    for (const branch of allBranches.all) {
      // Remote branches look like: origin/main, origin/feature
      if (branch.startsWith(`${remote}/`)) {
        const branchName = branch.slice(`${remote}/`.length);
        // Skip HEAD symbolic ref
        if (branchName === 'HEAD' || branchName.startsWith('HEAD ')) continue;
        remoteBranches.push(branchName);
      }
    }
    
    return remoteBranches;
  }

  async getTrackingBranch(localBranch: string): Promise<{ remote: string; branch: string } | null> {
    try {
      const upstream = await this.git.raw(['for-each-ref', '--format=%(upstream:short)', `refs/heads/${localBranch}`]);
      const upstreamBranch = upstream.trim();
      
      if (upstreamBranch) {
        // Parse "origin/main" format
        const slashIndex = upstreamBranch.indexOf('/');
        if (slashIndex > 0) {
          return {
            remote: upstreamBranch.slice(0, slashIndex),
            branch: upstreamBranch.slice(slashIndex + 1)
          };
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  async pullFromRemote(
    localBranch: string,
    remote: string,
    remoteBranch: string,
    options: {
      rebase?: boolean;
    } = {}
  ): Promise<void> {
    const { rebase = true } = options;
    
    console.log('[pullFromRemote] Starting pull:', { localBranch, remote, remoteBranch, options });
    
    // Get current branch to see if we need to checkout
    const branchSummary = await this.git.branchLocal();
    const initialBranch = branchSummary.current;
    const needsCheckout = localBranch !== initialBranch;

    // First, fetch from remote to get latest refs
    console.log('[pullFromRemote] Fetching from remote:', remote);
    await this.git.fetch(remote);
    console.log('[pullFromRemote] Fetch completed');
    
    const remoteFull = `${remote}/${remoteBranch}`;
    
    // Check if remote branch exists
    try {
      await this.git.revparse(['--verify', `refs/remotes/${remoteFull}`]);
      console.log('[pullFromRemote] Remote branch exists:', remoteFull);
    } catch {
      throw new Error(`Remote branch '${remoteFull}' does not exist`);
    }
    
    // Check if we have uncommitted changes
    const status = await this.git.status();
    const hasChanges = status.files.length > 0;
    console.log('[pullFromRemote] Has uncommitted changes:', hasChanges);
    
    if (hasChanges) {
      // Stash changes before pull
      console.log('[pullFromRemote] Stashing changes...');
      await this.git.stash(['push', '-m', 'auto-stash before pull']);
    }

    // Checkout the target branch if it's not the current one
    if (needsCheckout) {
      console.log(`[pullFromRemote] Checking out branch ${localBranch}...`);
      await this.git.checkout(localBranch);
    }
    
    try {
      if (rebase) {
        // Rebase onto remote branch
        console.log('[pullFromRemote] Rebasing onto:', remoteFull);
        await this.git.rebase([remoteFull]);
        console.log('[pullFromRemote] Rebase completed');
      } else {
        // Merge remote branch
        console.log('[pullFromRemote] Merging:', remoteFull);
        await this.git.merge([remoteFull]);
        console.log('[pullFromRemote] Merge completed');
      }
      
      // If we switched branches, try to switch back
      if (needsCheckout) {
        console.log(`[pullFromRemote] Returning to original branch ${initialBranch}...`);
        await this.git.checkout(initialBranch);
      }

      // Pop stashed changes if we stashed them
      if (hasChanges) {
        try {
          console.log('[pullFromRemote] Popping stashed changes...');
          await this.git.stash(['pop']);
        } catch {
          throw new Error('Pull succeeded but failed to restore local changes. Run "git stash pop" manually.');
        }
      }

      // Refresh remote refs again after pull so remote branch updates are reflected in the UI.
      console.log('[pullFromRemote] Refreshing remote refs after pull:', remote);
      await this.git.fetch(remote);
      console.log('[pullFromRemote] Post-pull fetch completed');
      
      console.log('[pullFromRemote] Operation completed successfully');
    } catch (e) {
      console.error('[pullFromRemote] Error:', e);
      
      // If we are in a conflicted state, we DON'T checkout back to the initial branch
      // as the user needs to resolve conflicts on the localBranch.
      // However, we should still try to inform them.

      const isConflict = (e as any).message?.toLowerCase().includes('conflict') || 
                        (e as any).stdout?.toLowerCase().includes('conflict') ||
                        (e as any).stderr?.toLowerCase().includes('conflict');

      if (!isConflict) {
        // If it wasn't a conflict, try to abort and return to initial state
        try {
          if (rebase) {
            await this.git.rebase(['--abort']);
          } else {
            await this.git.merge(['--abort']);
          }
        } catch {
          // Abort might fail
        }

        if (needsCheckout) {
          try {
            await this.git.checkout(initialBranch);
          } catch {
            // Checkout back might fail
          }
        }

        if (hasChanges) {
          try {
            await this.git.stash(['pop']);
          } catch {
            // Pop might fail
          }
        }
      } else {
        // It IS a conflict. We stay on localBranch.
        // We cannot pop the stash here because it will definitely conflict further or fail.
      }
      
      throw e;
    }
  }

  async getRemoteUrl(remoteName: string): Promise<string | null> {
    try {
      const remotes = await this.git.getRemotes(true);
      const remote = remotes.find(r => r.name === remoteName);
      return remote ? (remote.refs.push || remote.refs.fetch) : null;
    } catch {
      return null;
    }
  }

  // Stash operations
  async stash(message?: string): Promise<void> {
    // Include untracked files so stash works for "new file" only changes from the UI.
    const args = ['push', '--include-untracked'];
    if (message) {
      args.push('-m', message);
    }
    await this.git.stash(args);
  }

  async getStashes(): Promise<{ index: number; message: string; date: string; hash: string }[]> {
    try {
      // Use git stash list with custom format to get useful info
      const result = await this.git.raw(['stash', 'list', '--format=%gd|%s|%ai|%H']);
      if (!result.trim()) {
        return [];
      }
      
      return result.trim().split('\n').map((line, idx) => {
        const [ref, message, date, hash] = line.split('|');
        // ref is like "stash@{0}", extract the index
        const indexMatch = ref.match(/stash@\{(\d+)\}/);
        const index = indexMatch ? parseInt(indexMatch[1], 10) : idx;
        return { index, message: message || 'No message', date, hash };
      });
    } catch {
      return [];
    }
  }

  async applyStash(index: number): Promise<void> {
    await this.git.stash(['apply', `stash@{${index}}`]);
  }

  async dropStash(index: number): Promise<void> {
    await this.git.stash(['drop', `stash@{${index}}`]);
  }

  async popStash(index: number): Promise<void> {
    await this.git.stash(['pop', `stash@{${index}}`]);
  }

  async getStashFiles(index: number): Promise<{ path: string; status: string }[]> {
    try {
      // Get list of files changed in this stash
      const result = await this.git.raw(['stash', 'show', '--name-status', `stash@{${index}}`]);
      if (!result.trim()) {
        return [];
      }
      
      return result.trim().split('\n').map(line => {
        const [status, ...pathParts] = line.split('\t');
        const path = pathParts.join('\t');
        return { path, status };
      });
    } catch {
      return [];
    }
  }

  async getStashFileDiff(index: number, filePath: string): Promise<{ left: string; right: string; diff: string }> {
    // Get the content before the stash (from the parent commit of the stash)
    // and the content in the stash itself
    let left = '';
    let right = '';
    
    try {
      // stash@{n}^1 is the parent commit (the state before stashing)
      // We need to get the file content from the parent
      left = await this.git.show([`stash@{${index}}^1:${filePath}`]);
    } catch {
      // File might not exist before the stash (new file)
      left = '';
    }
    
    try {
      // Get the file content from the stash itself
      right = await this.git.show([`stash@{${index}}:${filePath}`]);
    } catch {
      // File might be deleted in the stash
      right = '';
    }

    const diff = await this.getStashFilePatch(index, filePath);
    
    return { left, right, diff };
  }

  async getStashFilePatch(index: number, filePath: string): Promise<string> {
    try {
      // git stash show -p stash@{index} -- filePath
      return await this.git.raw(['stash', 'show', '-p', `stash@{${index}}`, '--', filePath]);
    } catch (e) {
      console.warn('Failed to get stash file diff:', e);
      return '';
    }
  }

  private async getRemoteTagNames(remote: string): Promise<Set<string>> {
    const output = await this.git.raw(['ls-remote', '--tags', remote]);
    const remoteTags = new Set<string>();

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parts = trimmed.split('\t');
      if (parts.length < 2) continue;
      const ref = parts[1];
      if (!ref.startsWith('refs/tags/')) continue;
      if (ref.endsWith('^{}')) continue;

      remoteTags.add(ref.slice('refs/tags/'.length));
    }

    return remoteTags;
  }

  private async pushLocalOnlyTagsToRemote(targetRemote: string, remoteForDiscovery: string): Promise<number> {
    const localTags = (await this.git.tags()).all;
    if (localTags.length === 0) return 0;

    const remoteTags = await this.getRemoteTagNames(remoteForDiscovery);
    const localOnlyTags = localTags.filter((tag) => !remoteTags.has(tag));
    if (localOnlyTags.length === 0) return 0;

    const tagRefSpecs = localOnlyTags.map((tag) => `refs/tags/${tag}`);
    await this.git.push([targetRemote, ...tagRefSpecs]);
    return localOnlyTags.length;
  }

  async pushToRemote(
    localBranch: string,
    remote: string,
    remoteBranch: string,
    options: {
      rebaseFirst?: boolean;
      forcePush?: boolean;
      pushLocalOnlyTags?: boolean;
      setUpstream?: boolean;
      squash?: boolean;
      squashMessage?: string;
      credentials?: { username: string; token: string };
    } = {}
  ): Promise<void> {
    const { rebaseFirst, forcePush, pushLocalOnlyTags, setUpstream, squash, squashMessage, credentials } = options;
    
    // Mask token for logging
    const logOptions = { ...options };
    if (logOptions.credentials) {
      logOptions.credentials = { ...logOptions.credentials, token: '***' };
    }
    
    console.log('[pushToRemote] Starting push:', { localBranch, remote, remoteBranch, options: logOptions });
    
    // Get current branch to see if we need to checkout
    const branchSummary = await this.git.branchLocal();
    const initialBranch = branchSummary.current;
    const needsCheckout = localBranch !== initialBranch;

    // Check if we have uncommitted changes
    const status = await this.git.status();
    const hasChanges = status.files.length > 0;
    console.log('[pushToRemote] Has uncommitted changes:', hasChanges);
    
    if (hasChanges) {
      // Stash changes before push (including any rebase/merge operations)
      console.log('[pushToRemote] Stashing changes...');
      await this.git.stash(['push', '-m', 'auto-stash before push']);
    }

    // Checkout the target branch if it's not the current one
    if (needsCheckout) {
      console.log(`[pushToRemote] Checking out branch ${localBranch}...`);
      await this.git.checkout(localBranch);
    }
    
    try {
      // Determine the remote URL or name to use
      let targetRemote = remote;
      
      if (credentials) {
        const remoteUrl = await this.getRemoteUrl(remote);
        if (remoteUrl) {
          try {
            // Inject credentials into the URL
            const urlObj = new URL(remoteUrl);
            urlObj.username = credentials.username;
            urlObj.password = credentials.token;
            targetRemote = urlObj.toString();
            console.log('[pushToRemote] Using authenticated URL for push');
          } catch (e) {
            console.warn('[pushToRemote] Failed to construct authenticated URL, falling back to remote name', e);
          }
        } else {
            console.warn(`[pushToRemote] Could not resolve URL for remote '${remote}', falling back to remote name`);
        }
      }

      // First, fetch from remote to update our local refs (general fetch, not specific branch)
      // This updates our knowledge of what branches exist on the remote
      console.log('[pushToRemote] Fetching from remote:', remote);
      // Note: We use the original remote name for fetch, assuming fetch auth is handled or same as push
      // If fetch requires auth, we might need to use targetRemote here too, but simple-git might handle it if configured
      // For now, let's try using targetRemote for fetch as well if we have credentials
      await this.git.fetch(targetRemote);
      console.log('[pushToRemote] Fetch completed');
      
      const remoteFull = `${remote}/${remoteBranch}`;
      
      // Check if remote branch exists by trying to resolve it
      let remoteBranchExists = false;
      try {
        await this.git.revparse(['--verify', `refs/remotes/${remoteFull}`]);
        remoteBranchExists = true;
        console.log('[pushToRemote] Remote branch exists:', remoteFull);
      } catch {
        // Remote branch doesn't exist
        remoteBranchExists = false;
        console.log('[pushToRemote] Remote branch does not exist:', remoteFull);
      }
      
      // Force push should overwrite remote history with local state.
      // Do not integrate remote commits first, otherwise remote history is preserved.
      const shouldIntegrateRemote = remoteBranchExists && !forcePush;

      // Only rebase/merge if the remote branch exists and force push is not requested
      if (shouldIntegrateRemote) {
        if (rebaseFirst) {
          // Remote branch exists, rebase onto it
          console.log('[pushToRemote] Rebasing onto:', remoteFull);
          await this.git.rebase([remoteFull]);
          console.log('[pushToRemote] Rebase completed');
        } else {
          // Remote branch exists, merge it
          console.log('[pushToRemote] Merging:', remoteFull);
          await this.git.merge([remoteFull]);
          console.log('[pushToRemote] Merge completed');
        }

        // Handle squash if requested
        if (squash) {
            console.log('[pushToRemote] Squashing commits onto:', remoteFull);
            // Reset soft to remote branch to stage all changes
            await this.git.reset(['--soft', remoteFull]);
            
            // Commit all staged changes
            const message = squashMessage || `Squash commits before push to ${remoteBranch}`;
            await this.git.commit(message);
            console.log('[pushToRemote] Squash completed');
        }
      } else if (remoteBranchExists && forcePush) {
          console.log('[pushToRemote] Force push requested; skipping pre-push rebase/merge to avoid preserving remote history');
      } else if (squash) {
          console.warn('[pushToRemote] Cannot squash: remote branch does not exist');
          // We could throw here, or just continue without squashing.
          // For now, warning is safer than failing unexpectedly if user just ticked it by habit.
      }
      
      // Build push options
      const pushOptions: string[] = [];
      
      // If we squashed, we rewrote history relative to what might be on remote (if we didn't rebase perfectly or if we are overwriting),
      // but actually, if we rebased onto remoteFull, then reset --soft remoteFull, then committed...
      // We are now 1 commit ahead of remoteFull.
      // So it SHOULD be a fast-forward push.
      // UNLESS remote moved since our fetch?
      // But generally, squash implies we are replacing our history with a single commit.
      // If we are just appending to remote, fast-forward is fine.
      // BUT, if we had *multiple* commits that were *already* on remote?
      // No, we rebased onto remoteFull.
      // So we incorporated all remote changes.
      // So our new commit is child of remoteFull.
      // So fast-forward should work.
      // However, if the user intended to squash commits that were *already pushed* (e.g. fixing up a PR),
      // they would need force push.
      // If rebaseFirst is true, we rebased on remote.
      // If remote has A->B. Local has A->B->C->D.
      // Rebase: Local A->B->C->D.
      // Reset soft to B (remoteFull).
      // Commit: A->B->E (where E contains C+D).
      // Push E. E's parent is B. Remote is at B.
      // Fast-forward A->B->E.
      // This works!
      // BUT, what if local was A->B->C (pushed) -> D (local).
      // Remote is at C.
      // Fetch: remote is C.
      // Rebase onto C: Local is A->B->C->D.
      // Reset soft to C.
      // Commit E (contains D). Parent C.
      // Push E. Fast-forward to C->E.
      // Wait, where did C go? C is on remote.
      // So we squashed D into E?
      // Yes. C remains individual.
      // This squashes *local* commits (ahead of remote).
      // It does NOT squash commits that are already on remote.
      // This matches "squash all the local commits into one".
      // Perfect.
      // So no implicit force push needed.
      
      if (forcePush) {
          pushOptions.push('--force');
      }
      
      // Add --progress to see what's happening
      pushOptions.push('--progress');
      
      console.log('[pushToRemote] Pushing to', remote, 'with refspec', `${localBranch}:${remoteBranch}`, 'options:', pushOptions);
      
      // Use simple-git's push method with explicit remote and branch
      // This handles credentials better than raw commands
      // Use targetRemote (which might contain credentials)
      const pushResult = await this.git.push(targetRemote, `${localBranch}:${remoteBranch}`, pushOptions);
      console.log('[pushToRemote] Push completed successfully, result:', pushResult);

      if (setUpstream) {
        // Push may use an authenticated URL instead of the named remote, so set upstream
        // explicitly against the remote name to guarantee tracking is configured.
        await this.git.raw(['config', `branch.${localBranch}.remote`, remote]);
        await this.git.raw(['config', `branch.${localBranch}.merge`, `refs/heads/${remoteBranch}`]);
      }

      if (pushLocalOnlyTags ?? true) {
        const pushedTagCount = await this.pushLocalOnlyTagsToRemote(targetRemote, remote);
        console.log(`[pushToRemote] Pushed ${pushedTagCount} local-only tag(s) to ${remote}`);
      }
      
      // If we switched branches, try to switch back
      if (needsCheckout) {
        console.log(`[pushToRemote] Returning to original branch ${initialBranch}...`);
        await this.git.checkout(initialBranch);
      }

      // Pop stashed changes if we stashed them
      if (hasChanges) {
        try {
          console.log('[pushToRemote] Popping stashed changes...');
          await this.git.stash(['pop']);
        } catch {
          // Stash pop might fail if there are conflicts
          throw new Error('Push succeeded but failed to restore local changes. Run "git stash pop" manually.');
        }
      }
      
      console.log('[pushToRemote] Operation completed successfully');
    } catch (e) {
      console.error('[pushToRemote] Error:', e);
      
      const isConflict = (e as any).message?.toLowerCase().includes('conflict') || 
                        (e as any).stdout?.toLowerCase().includes('conflict') ||
                        (e as any).stderr?.toLowerCase().includes('conflict');

      if (!isConflict) {
        if (needsCheckout) {
          try {
            await this.git.checkout(initialBranch);
          } catch {
            // Ignore
          }
        }

        if (hasChanges) {
          try {
            await this.git.stash(['pop']);
          } catch {
            // Ignore
          }
        }
      }
      
      throw e;
    }
  }
}
