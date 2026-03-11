import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inferPreviewUrlFromTerminalText,
  terminalTranscriptContainsCommand,
} from './dev-server-terminal.ts';

test('infers preview URL from Next.js Local output', () => {
  const text = [
    '▲ Next.js 16.1.6',
    '- Local:        http://127.0.0.1:3000',
  ].join('\n');

  assert.equal(inferPreviewUrlFromTerminalText(text), 'http://localhost:3000');
});

test('infers preview URL from generic localhost output', () => {
  const text = 'App ready at http://0.0.0.0:4173/preview';

  assert.equal(inferPreviewUrlFromTerminalText(text), 'http://localhost:4173/preview');
});

test('returns null when transcript does not contain a preview URL', () => {
  assert.equal(inferPreviewUrlFromTerminalText('waiting for compilation...'), null);
});

test('detects the configured dev command in terminal transcript', () => {
  assert.equal(
    terminalTranscriptContainsCommand('$ npm run dev\nready', 'npm run dev'),
    true,
  );
});

test('ignores empty command matches', () => {
  assert.equal(terminalTranscriptContainsCommand('$ npm run dev', '   '), false);
});
