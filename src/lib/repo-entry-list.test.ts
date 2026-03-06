import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { after, describe, it } from 'node:test';
import { listRepoEntries } from './repo-entry-list.ts';

const tempRoots: string[] = [];

after(async () => {
  await Promise.all(
    tempRoots.map((tempRoot) => fs.rm(tempRoot, { recursive: true, force: true }))
  );
});

describe('listRepoEntries', () => {
  it('includes repo-relative folder and file paths while skipping ignored directories', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viba-repo-entries-'));
    tempRoots.push(repoRoot);

    await fs.mkdir(path.join(repoRoot, 'src', 'components'), { recursive: true });
    await fs.mkdir(path.join(repoRoot, 'docs', 'guides'), { recursive: true });
    await fs.mkdir(path.join(repoRoot, 'node_modules', 'left-pad'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'src', 'components', 'Button.tsx'), 'export const Button = null;\n');
    await fs.writeFile(path.join(repoRoot, 'docs', 'guides', 'intro.md'), '# Intro\n');
    await fs.writeFile(path.join(repoRoot, 'README.md'), '# Repo\n');
    await fs.writeFile(path.join(repoRoot, 'node_modules', 'left-pad', 'index.js'), 'module.exports = () => "";\n');

    const entries = await listRepoEntries(repoRoot);

    assert.ok(entries.includes('src'));
    assert.ok(entries.includes('src/components'));
    assert.ok(entries.includes('src/components/Button.tsx'));
    assert.ok(entries.includes('docs'));
    assert.ok(entries.includes('docs/guides'));
    assert.ok(entries.includes('docs/guides/intro.md'));
    assert.ok(entries.includes('README.md'));
    assert.ok(!entries.some((entry) => entry.startsWith('node_modules')));
  });

  it('filters folder and file matches by query', async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'viba-repo-entries-query-'));
    tempRoots.push(repoRoot);

    await fs.mkdir(path.join(repoRoot, 'src', 'components'), { recursive: true });
    await fs.writeFile(path.join(repoRoot, 'src', 'components', 'Button.tsx'), 'export const Button = null;\n');
    await fs.writeFile(path.join(repoRoot, 'src', 'index.ts'), 'export {};\n');

    const entries = await listRepoEntries(repoRoot, 'comp');

    assert.deepStrictEqual(entries, ['src/components', 'src/components/Button.tsx']);
  });
});
