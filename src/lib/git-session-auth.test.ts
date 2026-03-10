import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  resolveGitSessionEnvironmentsWithDeps,
  type GitSessionAuthDependencies,
  type GitSessionCredential,
} from './git-session-auth-core.ts';

type TestDeps = GitSessionAuthDependencies;

function createDeps(options: {
  credentials: GitSessionCredential[];
  repoRemotes: Record<string, string | null>;
  repoCredentialIds?: Record<string, string | null>;
  tokens?: Record<string, string | null>;
}): TestDeps {
  const credentialsById = new Map(options.credentials.map((credential) => [credential.id, credential]));
  const tokens = options.tokens ?? {};
  const repoCredentialIds = options.repoCredentialIds ?? {};

  return {
    getAllCredentials: async () => options.credentials,
    getCredentialById: async (id: string) => credentialsById.get(id) ?? null,
    getCredentialToken: async (id: string) => tokens[id] ?? null,
    getGitRepoCredential: async (repoPath: string) => repoCredentialIds[repoPath] ?? null,
    getPrimaryRemoteUrl: async (repoPath: string) => options.repoRemotes[repoPath] ?? null,
  };
}

describe('resolveGitSessionEnvironments', () => {
  it('uses an explicit GitHub repo mapping when provided', async () => {
    const githubCredential: GitSessionCredential = {
      id: 'github-explicit',
      type: 'github',
    };

    const environments = await resolveGitSessionEnvironmentsWithDeps(
      ['/repos/github'],
      createDeps({
        credentials: [githubCredential],
        repoRemotes: {
          '/repos/github': 'https://github.com/acme/project.git',
        },
        repoCredentialIds: {
          '/repos/github': 'github-explicit',
        },
        tokens: {
          'github-explicit': 'ghu_explicit',
        },
      }),
    );

    assert.deepStrictEqual(environments, [
      { name: 'GITHUB_TOKEN', value: 'ghu_explicit' },
    ]);
  });

  it('resolves self-hosted GitLab credentials and includes GITLAB_HOST', async () => {
    const gitlabCredential: GitSessionCredential = {
      id: 'gitlab-self-hosted',
      type: 'gitlab',
      serverUrl: 'https://gitlab.corp.example',
    };

    const environments = await resolveGitSessionEnvironmentsWithDeps(
      ['/repos/gitlab'],
      createDeps({
        credentials: [gitlabCredential],
        repoRemotes: {
          '/repos/gitlab': 'git@gitlab.corp.example:team/project.git',
        },
        tokens: {
          'gitlab-self-hosted': 'glpat_self_hosted',
        },
      }),
    );

    assert.deepStrictEqual(environments, [
      { name: 'GITLAB_TOKEN', value: 'glpat_self_hosted' },
      { name: 'GITLAB_HOST', value: 'gitlab.corp.example' },
    ]);
  });

  it('keeps both GitHub and GitLab env vars for mixed-provider sessions', async () => {
    const githubCredential: GitSessionCredential = {
      id: 'github-1',
      type: 'github',
    };
    const gitlabCredential: GitSessionCredential = {
      id: 'gitlab-1',
      type: 'gitlab',
      serverUrl: 'https://gitlab.com',
    };

    const environments = await resolveGitSessionEnvironmentsWithDeps(
      ['/repos/github', '/repos/gitlab'],
      createDeps({
        credentials: [githubCredential, gitlabCredential],
        repoRemotes: {
          '/repos/github': 'https://github.com/acme/project.git',
          '/repos/gitlab': 'https://gitlab.com/team/project.git',
        },
        tokens: {
          'github-1': 'ghu_token',
          'gitlab-1': 'glpat_token',
        },
      }),
    );

    assert.deepStrictEqual(environments, [
      { name: 'GITHUB_TOKEN', value: 'ghu_token' },
      { name: 'GITLAB_TOKEN', value: 'glpat_token' },
    ]);
  });

  it('omits conflicted same-provider credentials instead of picking one arbitrarily', async () => {
    const githubA: GitSessionCredential = {
      id: 'github-a',
      type: 'github',
    };
    const githubB: GitSessionCredential = {
      id: 'github-b',
      type: 'github',
    };
    const gitlabCredential: GitSessionCredential = {
      id: 'gitlab-1',
      type: 'gitlab',
      serverUrl: 'https://gitlab.com',
    };

    const environments = await resolveGitSessionEnvironmentsWithDeps(
      ['/repos/github-a', '/repos/github-b', '/repos/gitlab'],
      createDeps({
        credentials: [githubA, githubB, gitlabCredential],
        repoRemotes: {
          '/repos/github-a': 'https://github.com/acme/project-a.git',
          '/repos/github-b': 'https://github.com/acme/project-b.git',
          '/repos/gitlab': 'https://gitlab.com/team/project.git',
        },
        repoCredentialIds: {
          '/repos/github-a': 'github-a',
          '/repos/github-b': 'github-b',
        },
        tokens: {
          'github-a': 'ghu_alice',
          'github-b': 'ghu_bob',
          'gitlab-1': 'glpat_token',
        },
      }),
    );

    assert.deepStrictEqual(environments, [
      { name: 'GITLAB_TOKEN', value: 'glpat_token' },
    ]);
  });

  it('returns no git auth vars when no matching credential is available', async () => {
    const environments = await resolveGitSessionEnvironmentsWithDeps(
      ['/repos/unknown'],
      createDeps({
        credentials: [],
        repoRemotes: {
          '/repos/unknown': 'https://example.com/acme/project.git',
        },
      }),
    );

    assert.deepStrictEqual(environments, []);
  });
});
