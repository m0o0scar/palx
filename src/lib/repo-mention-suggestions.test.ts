import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildRepoMentionSuggestions,
  REPO_MENTION_SUGGESTION_LIMIT,
} from './repo-mention-suggestions.ts';

describe('buildRepoMentionSuggestions', () => {
  it('prioritizes attachments, deduplicates matches, and caps the final list', () => {
    const suggestions = buildRepoMentionSuggestions({
      query: '',
      currentAttachments: ['README.md', 'src/components/Button.tsx'],
      carriedAttachments: ['README.md', 'docs/spec.md'],
      repoEntries: Array.from({ length: 30 }, (_, index) => `src/file-${index}.ts`),
    });

    assert.deepStrictEqual(suggestions.slice(0, 3), [
      'README.md',
      'src/components/Button.tsx',
      'docs/spec.md',
    ]);
    assert.equal(suggestions.length, REPO_MENTION_SUGGESTION_LIMIT);
  });

  it('returns both folders and files that match the query', () => {
    const suggestions = buildRepoMentionSuggestions({
      query: 'comp',
      currentAttachments: [],
      carriedAttachments: [],
      repoEntries: [
        'src/components',
        'src/components/Button.tsx',
        'src/index.ts',
      ],
    });

    assert.deepStrictEqual(suggestions, [
      'src/components',
      'src/components/Button.tsx',
    ]);
  });
});
