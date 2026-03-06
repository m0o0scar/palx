import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildTtydTerminalSrc,
  detectGitRemoteProvider,
  parseTerminalSessionEnvironmentsFromSrc,
  parseGitRemoteHost,
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
});
