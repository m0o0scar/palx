import assert from 'node:assert';
import { describe, it } from 'node:test';

import { collectDescendantProcesses, parsePsProcessTable } from './process-tree.ts';

describe('parsePsProcessTable', () => {
  it('parses valid ps rows and ignores malformed lines', () => {
    const output = [
      '  101   1 S /usr/bin/node server.js',
      'bad line',
      '  202 101 R /bin/bash -lc npm test',
      '',
      '  303 202 S+ npm test',
    ].join('\n');

    const rows = parsePsProcessTable(output);
    assert.deepStrictEqual(rows, [
      { pid: 101, ppid: 1, state: 'S', command: '/usr/bin/node server.js' },
      { pid: 202, ppid: 101, state: 'R', command: '/bin/bash -lc npm test' },
      { pid: 303, ppid: 202, state: 'S+', command: 'npm test' },
    ]);
  });
});

describe('collectDescendantProcesses', () => {
  it('returns recursive descendants and excludes root', () => {
    const rows = parsePsProcessTable([
      '  10   1 S runtime',
      '  20  10 S child-a',
      '  30  10 S child-b',
      '  40  20 S grandchild-a',
      '  50  40 S great-grandchild',
    ].join('\n'));

    const descendants = collectDescendantProcesses(rows, 10);
    assert.deepStrictEqual(
      descendants.map((entry) => entry.pid),
      [20, 30, 40, 50],
    );
  });

  it('returns empty list when root is missing', () => {
    const rows = parsePsProcessTable('  1  0 S launchd');
    const descendants = collectDescendantProcesses(rows, 9999);
    assert.deepStrictEqual(descendants, []);
  });
});
