import { describe, it } from 'node:test';
import assert from 'node:assert';
import { resolveSessionTerminalRepoPaths } from './session-terminal-repos.ts';

describe('resolveSessionTerminalRepoPaths', () => {
  it('uses discovered project repos when session metadata has no repo contexts', () => {
    const repoPaths = resolveSessionTerminalRepoPaths({
      sessionRepoPaths: [],
      discoveredProjectRepoPaths: ['/project/apps/web', '/project/packages/ui'],
      projectPath: '/project',
    });

    assert.deepStrictEqual(repoPaths, ['/project/apps/web', '/project/packages/ui']);
  });

  it('keeps session repo paths and adds newly discovered repos without duplicates', () => {
    const repoPaths = resolveSessionTerminalRepoPaths({
      sessionRepoPaths: ['/project/apps/web'],
      discoveredProjectRepoPaths: ['/project/apps/web', '/project/packages/ui'],
      activeRepoPath: '/project/apps/web',
      projectPath: '/project',
    });

    assert.deepStrictEqual(repoPaths, ['/project/apps/web', '/project/packages/ui']);
  });

  it('falls back to active repo path and then project path when no repo list is available', () => {
    assert.deepStrictEqual(
      resolveSessionTerminalRepoPaths({
        sessionRepoPaths: [],
        discoveredProjectRepoPaths: [],
        activeRepoPath: '/project/repo',
        projectPath: '/project',
      }),
      ['/project/repo', '/project'],
    );

    assert.deepStrictEqual(
      resolveSessionTerminalRepoPaths({
        sessionRepoPaths: [],
        discoveredProjectRepoPaths: null,
        activeRepoPath: null,
        projectPath: '/project',
      }),
      ['/project'],
    );
  });
});
