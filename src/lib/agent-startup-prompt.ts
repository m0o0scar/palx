import type { SessionGitRepoContext, SessionWorkspaceMode } from './types.ts';

const PLAN_MODE_STARTUP_INSTRUCTION =
  'Plan mode: in your first response of this session, inspect the relevant code, present a concrete implementation plan, and wait for explicit user approval before any file edits or write commands. After the user approves that initial plan, execute small or trivial follow-up changes directly without re-requesting approval. Request approval again only when a proposed change is substantial (for example meaningfully expands scope, changes approach, or introduces material risk).';
const AUTO_COMMIT_INSTRUCTION =
  'If you changed files inside a Git repository and the work for that repository is complete, commit that repository without confirmation. Use a commit message with a clear title and a detailed body explaining what changed and why. If multiple repositories changed, handle each repository separately. If no repository applies, skip Git-only steps. If GITHUB_TOKEN or GITLAB_TOKEN is set, push each changed repository after committed rounds and create or update a pull or merge request for each changed repository; include the repository path and link in the first push reply. Prefer provider-native CLIs when available: for GitHub, `gh auth setup-git` can wire `GITHUB_TOKEN` into `git push`; for GitLab, use `glab` with `GITLAB_TOKEN` and honor `GITLAB_HOST` for self-hosted instances.';
const AGENT_BROWSER_SKILL_INSTRUCTION =
  'For visual UI tasks, prioritize Chrome remote-debug MCP tooling to attach to the user\'s current browser session. If that is unavailable, fall back to the `agent-browser` skill (https://skills.sh/vercel-labs/agent-browser/agent-browser), which may run in a standalone browser session.';
const SYSTEMATIC_DEBUGGING_SKILL_INSTRUCTION =
  'For bugfix/debugging tasks, use the `systematic-debugging` skill (https://github.com/obra/superpowers).';
const OPTIONAL_SKILL_DISCOVERY_INSTRUCTION =
  'If this task would benefit from another specialized workflow, you may use `npx skills` to discover and install additional skills at your discretion. Prefer trusted sources, install only what is needed, read the installed `SKILL.md` before using it, and avoid unnecessary overlapping skills.';
const VISUAL_EVIDENCE_INSTRUCTION =
  'When working on a visual-related feature or bugfix in a web project, after coding is complete, use Chrome remote-debug MCP tooling first to test the relevant page and capture screenshot(s) in the user\'s current browser session. If the current session is unavailable, fall back to `agent-browser` or another standalone browser automation option. Do not commit evidence files to the repository; upload them as pull or merge request attachments or comments via GitHub or GitLab APIs.';

export type BuildAgentStartupPromptOptions = {
  taskDescription?: string | null;
  attachmentPaths?: string[];
  sessionMode?: 'fast' | 'plan';
  workspaceMode: SessionWorkspaceMode;
  gitRepos?: SessionGitRepoContext[];
  discoveredRepoRelativePaths?: string[];
};

function normalizeRepoPath(value: string | null | undefined): string {
  const trimmed = value?.trim() || '';
  if (!trimmed || trimmed === '.') return '.';
  return trimmed.replace(/^\.\/+/, '').replace(/\/+$/, '') || '.';
}

function uniqueRepoPaths(paths: string[]): string[] {
  return Array.from(new Set(paths.map((path) => normalizeRepoPath(path)).filter(Boolean))).sort((a, b) => {
    if (a === b) return 0;
    if (a === '.') return -1;
    if (b === '.') return 1;
    return a.localeCompare(b);
  });
}

function formatRepoPaths(paths: string[]): string {
  return paths.map((path) => `\`${path}\``).join(', ');
}

function getKnownRepoPaths(
  discoveredRepoRelativePaths: string[] | undefined,
  gitRepos: SessionGitRepoContext[] | undefined,
): string[] {
  const discoveredPaths = uniqueRepoPaths(discoveredRepoRelativePaths || []);
  if (discoveredPaths.length > 0) return discoveredPaths;
  return uniqueRepoPaths((gitRepos || []).map((repo) => repo.relativeRepoPath));
}

export function hasStartupTaskDescription(taskDescription?: string | null): boolean {
  return Boolean(taskDescription?.trim());
}

export function buildProjectGitInstructionLines(
  workspaceMode: SessionWorkspaceMode,
  gitRepos: SessionGitRepoContext[] = [],
  discoveredRepoRelativePaths: string[] = [],
): string[] {
  const repoPaths = getKnownRepoPaths(discoveredRepoRelativePaths, gitRepos);

  if (repoPaths.length === 0) {
    return [
      'Git context: no Git repositories were detected in this project.',
      'Run file edits in folder mode and skip commit, push, and pull or merge request steps unless the user explicitly asks you to initialize Git.',
    ];
  }

  if (workspaceMode === 'single_worktree' && gitRepos.length === 1) {
    const sourceRepoPath = normalizeRepoPath(gitRepos[0]?.relativeRepoPath);
    if (sourceRepoPath === '.') {
      return [
        'Git context: this project contains one Git repository at `.`.',
        'Your shell already starts in that repository, so run Git commands in `.`.',
      ];
    }

    return [
      `Git context: this project contains one Git repository at ${formatRepoPaths([sourceRepoPath])}.`,
      `Your shell already starts in that repository's worktree, so run Git commands in \`.\` even though its source-project path is \`${sourceRepoPath}\`.`,
    ];
  }

  if (workspaceMode === 'multi_repo_worktree') {
    return [
      `Git context: this project contains ${repoPaths.length} Git repositories at ${formatRepoPaths(repoPaths)}.`,
      'Your shell starts at the workspace root. Run each Git command from the matching repository path, not from the workspace root unless `.` is listed.',
      'If your changes span multiple repositories, commit, push, and open or update pull or merge requests separately for each repository.',
    ];
  }

  return [
    `Git context: this project contains ${repoPaths.length} Git repositories at ${formatRepoPaths(repoPaths)}.`,
    'Your shell starts at the project root. Before any Git command, `cd` into the repository you are working in; do not assume the project root is itself a Git repository unless `.` is listed.',
    ...(repoPaths.length > 1
      ? ['If your changes span multiple repositories, handle commits, pushes, and pull or merge requests separately for each repository.']
      : []),
  ];
}

export function buildAgentStartupPrompt({
  taskDescription,
  attachmentPaths = [],
  sessionMode = 'fast',
  workspaceMode,
  gitRepos = [],
  discoveredRepoRelativePaths = [],
}: BuildAgentStartupPromptOptions): string | null {
  if (!hasStartupTaskDescription(taskDescription)) {
    return null;
  }

  const trimmedTaskDescription = taskDescription!.trim();
  const normalizedAttachmentPaths = Array.from(
    new Set(attachmentPaths.map((entry) => entry.trim()).filter(Boolean)),
  );

  const instructionLines: string[] = [];
  if (sessionMode === 'plan') {
    instructionLines.push(PLAN_MODE_STARTUP_INSTRUCTION);
  }
  instructionLines.push(...buildProjectGitInstructionLines(workspaceMode, gitRepos, discoveredRepoRelativePaths));
  instructionLines.push(AUTO_COMMIT_INSTRUCTION);
  instructionLines.push(AGENT_BROWSER_SKILL_INSTRUCTION);
  instructionLines.push(SYSTEMATIC_DEBUGGING_SKILL_INSTRUCTION);
  instructionLines.push(OPTIONAL_SKILL_DISCOVERY_INSTRUCTION);
  instructionLines.push(VISUAL_EVIDENCE_INSTRUCTION);

  const taskSections: string[] = [trimmedTaskDescription];
  if (normalizedAttachmentPaths.length > 0) {
    taskSections.push([
      'Attachments:',
      ...normalizedAttachmentPaths.map((attachmentPath) => `- ${attachmentPath}`),
    ].join('\n'));
  }

  return [
    '# Instructions',
    '',
    instructionLines.map((line) => `- ${line}`).join('\n'),
    '',
    '# Task',
    '',
    taskSections.join('\n\n'),
  ].join('\n');
}
