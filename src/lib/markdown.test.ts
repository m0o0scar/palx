import assert from 'node:assert';
import { describe, it } from 'node:test';
import { normalizeMarkdownLists } from './markdown.ts';

describe('normalizeMarkdownLists', () => {
  it('nests unordered bullets under ordered items when they split a single ordered list', () => {
    const input = [
      '1. Update the toolbar markup',
      '',
      '- Add compact controls.',
      '- Remove the alpha control.',
      '',
      '1. Update responsive styling',
      '',
      '- Hide desktop controls on small screens.',
      '- Keep the zoom percentage visible.',
      '',
      '1. Verify',
      '',
      '- Run targeted checks.',
    ].join('\n');

    const expected = [
      '1. Update the toolbar markup',
      '',
      '  - Add compact controls.',
      '  - Remove the alpha control.',
      '',
      '1. Update responsive styling',
      '',
      '  - Hide desktop controls on small screens.',
      '  - Keep the zoom percentage visible.',
      '',
      '1. Verify',
      '',
      '- Run targeted checks.',
    ].join('\n');

    assert.strictEqual(normalizeMarkdownLists(input), expected);
  });

  it('does not rewrite already nested lists', () => {
    const input = [
      '1. Update the toolbar markup',
      '',
      '  - Add compact controls.',
      '  - Remove the alpha control.',
      '',
      '2. Verify',
    ].join('\n');

    assert.strictEqual(normalizeMarkdownLists(input), input);
  });

  it('does not rewrite unordered list markers inside fenced code blocks', () => {
    const input = [
      '1. Example',
      '',
      '```md',
      '- this stays literal',
      '1. and so does this',
      '```',
      '',
      '2. Done',
    ].join('\n');

    assert.strictEqual(normalizeMarkdownLists(input), input);
  });
});
