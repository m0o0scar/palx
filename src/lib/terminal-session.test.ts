import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildTtydTerminalSrc,
  detectGitRemoteProvider,
  mergeGitTerminalSessionEnvironments,
  parseGitRemoteHost,
  parseTerminalSessionEnvironmentsFromSrc,
  parseTerminalWorkingDirectoryFromSrc,
  type ResolvedGitTerminalSessionEnvironment,
} from './terminal-session.ts';

describe('parseGitRemoteHost', () => {
  it('parses HTTPS remotes', () => {
    assert.strictEqual(parseGitRemoteHost('https://github.com/acme/repo.git'), 'github.com');
  });

  it('parses SCP-style SSH remotes', () => {
    assert.strictEqual(parseGitRemoteHost('git@gitlab.com:team/repo.git'), 'gitlab.com');
  });
});

describe('detectGitRemoteProvider', () => {
  it('detects GitHub and GitLab remotes', () => {
    assert.strictEqual(detectGitRemoteProvider('git@github.com:acme/repo.git'), 'github');
    assert.strictEqual(detectGitRemoteProvider('https://gitlab.com/acme/repo.git'), 'gitlab');
  });

  it('detects self-hosted GitLab remotes when host is known from credentials', () => {
    assert.strictEqual(
      detectGitRemoteProvider('git@git.corp.example:team/repo.git', {
        gitlabHosts: ['https://git.corp.example'],
      }),
      'gitlab',
    );
  });

  it('returns null for unknown hosts', () => {
    assert.strictEqual(detectGitRemoteProvider('https://example.com/acme/repo.git'), null);
  });
});

describe('buildTtydTerminalSrc', () => {
  it('includes tmux environment variables when provided', () => {
    const url = buildTtydTerminalSrc('session-1', 'agent', {
      name: 'GITHUB_TOKEN',
      value: 'secret-token',
    });
    const params = new URLSearchParams(url.split('?')[1] || '');
    assert.deepStrictEqual(params.getAll('arg'), [
      'new-session',
      '-e',
      'GITHUB_TOKEN=secret-token',
      '-A',
      '-s',
      'viba-session-1-agent',
    ]);
  });

  it('includes multiple tmux environment variables when provided', () => {
    const url = buildTtydTerminalSrc('session-1', 'agent', [
      {
        name: 'OPENAI_API_KEY',
        value: 'sk-example',
      },
      {
        name: 'OPENAI_BASE_URL',
        value: 'https://proxy.example.com/v1',
      },
    ]);
    const params = new URLSearchParams(url.split('?')[1] || '');
    assert.deepStrictEqual(params.getAll('arg'), [
      'new-session',
      '-e',
      'OPENAI_API_KEY=sk-example',
      '-e',
      'OPENAI_BASE_URL=https://proxy.example.com/v1',
      '-A',
      '-s',
      'viba-session-1-agent',
    ]);
  });

  it('includes tmux working directory when provided', () => {
    const url = buildTtydTerminalSrc('session-1', 'agent', null, {
      workingDirectory: '/tmp/viba workspace',
    });
    const params = new URLSearchParams(url.split('?')[1] || '');
    assert.deepStrictEqual(params.getAll('arg'), [
      'new-session',
      '-c',
      '/tmp/viba workspace',
      '-A',
      '-s',
      'viba-session-1-agent',
    ]);
  });

  it('builds shell-mode URLs with custom metadata', () => {
    const url = buildTtydTerminalSrc('session-1', 'agent', [
      { name: 'OPENAI_API_KEY', value: 'sk-example' },
    ], {
      persistenceMode: 'shell',
      workingDirectory: 'C:\\repo',
      shellKind: 'powershell',
    });
    const params = new URLSearchParams(url.split('?')[1] || '');
    assert.deepStrictEqual(params.getAll('viba-env'), ['OPENAI_API_KEY=sk-example']);
    assert.strictEqual(params.get('viba-cwd'), 'C:\\repo');
  });
});

describe('parseTerminalSessionEnvironmentsFromSrc', () => {
  it('extracts -e environment assignments from a ttyd URL', () => {
    const src = buildTtydTerminalSrc('session-1', 'agent', [
      { name: 'GITHUB_TOKEN', value: 'secret-token' },
      { name: 'OPENAI_API_KEY', value: 'sk-example' },
    ]);

    assert.deepStrictEqual(parseTerminalSessionEnvironmentsFromSrc(src), [
      { name: 'GITHUB_TOKEN', value: 'secret-token' },
      { name: 'OPENAI_API_KEY', value: 'sk-example' },
    ]);
  });

  it('ignores malformed env args and keeps the most recent duplicate', () => {
    const src = '/terminal?arg=new-session&arg=-e&arg=GITHUB_TOKEN=old&arg=-e&arg=BAD-NAME=value&arg=-e&arg=GITHUB_TOKEN=new';

    assert.deepStrictEqual(parseTerminalSessionEnvironmentsFromSrc(src), [
      { name: 'GITHUB_TOKEN', value: 'new' },
    ]);
  });

  it('extracts shell-mode environment assignments from a ttyd URL', () => {
    const src = '/terminal?viba-env=OPENAI_API_KEY%3Dsk-old&viba-env=OPENAI_API_KEY%3Dsk-new';

    assert.deepStrictEqual(parseTerminalSessionEnvironmentsFromSrc(src), [
      { name: 'OPENAI_API_KEY', value: 'sk-new' },
    ]);
  });
});

describe('parseTerminalWorkingDirectoryFromSrc', () => {
  it('extracts tmux working directory from a ttyd URL', () => {
    const src = buildTtydTerminalSrc('session-1', 'agent', null, {
      workingDirectory: '/tmp/viba workspace',
    });

    assert.strictEqual(parseTerminalWorkingDirectoryFromSrc(src), '/tmp/viba workspace');
  });

  it('extracts shell-mode working directory from a ttyd URL', () => {
    const src = buildTtydTerminalSrc('session-1', 'agent', null, {
      persistenceMode: 'shell',
      workingDirectory: 'C:\\repo',
    });

    assert.strictEqual(parseTerminalWorkingDirectoryFromSrc(src), 'C:\\repo');
  });
});

describe('mergeGitTerminalSessionEnvironments', () => {
  const createCandidate = (
    repoPath: string,
    name: string,
    value: string,
    credentialId: string,
    explicit: boolean,
  ): ResolvedGitTerminalSessionEnvironment => ({
    sourceRepoPath: repoPath,
    environment: { name, value },
    credentialId,
    explicit,
  });

  it('keeps both GitHub and GitLab env vars for mixed-provider sessions', () => {
    const environments = mergeGitTerminalSessionEnvironments([
      createCandidate('/repos/a', 'GITHUB_TOKEN', 'gh-token', 'github-1', false),
      createCandidate('/repos/b', 'GITLAB_TOKEN', 'gl-token', 'gitlab-1', false),
    ]);

    assert.deepStrictEqual(environments, [
      { name: 'GITHUB_TOKEN', value: 'gh-token' },
      { name: 'GITLAB_TOKEN', value: 'gl-token' },
    ]);
  });

  it('prefers explicit repo mappings over auto-selected credentials', () => {
    const environments = mergeGitTerminalSessionEnvironments([
      createCandidate('/repos/a', 'GITHUB_TOKEN', 'auto-token', 'github-auto', false),
      createCandidate('/repos/b', 'GITHUB_TOKEN', 'explicit-token', 'github-explicit', true),
    ]);

    assert.deepStrictEqual(environments, [
      { name: 'GITHUB_TOKEN', value: 'explicit-token' },
    ]);
  });

  it('omits a provider env when same-priority credentials conflict', () => {
    const conflicts: string[] = [];
    const environments = mergeGitTerminalSessionEnvironments([
      createCandidate('/repos/a', 'GITHUB_TOKEN', 'token-a', 'github-a', false),
      createCandidate('/repos/b', 'GITHUB_TOKEN', 'token-b', 'github-b', false),
      createCandidate('/repos/c', 'GITLAB_TOKEN', 'gitlab-token', 'gitlab-a', false),
    ], {
      onConflict: (message) => conflicts.push(message),
    });

    assert.deepStrictEqual(environments, [
      { name: 'GITLAB_TOKEN', value: 'gitlab-token' },
    ]);
    assert.strictEqual(conflicts.length, 1);
    assert.match(conflicts[0], /Conflicting GITHUB_TOKEN credentials/);
  });
});
