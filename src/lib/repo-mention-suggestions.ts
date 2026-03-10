export const REPO_MENTION_SUGGESTION_LIMIT = 20;

type BuildRepoMentionSuggestionsArgs = {
  query: string;
  repoEntries: string[];
  currentAttachments: string[];
  carriedAttachments: string[];
  limit?: number;
};

export function buildRepoMentionSuggestions({
  query,
  repoEntries,
  currentAttachments,
  carriedAttachments,
  limit = REPO_MENTION_SUGGESTION_LIMIT,
}: BuildRepoMentionSuggestionsArgs): string[] {
  const lowerQuery = query.toLowerCase();
  const seen = new Set<string>();

  const mergedEntries = [
    ...currentAttachments,
    ...carriedAttachments,
    ...repoEntries,
  ];

  return mergedEntries
    .filter((entry) => entry.toLowerCase().includes(lowerQuery))
    .filter((entry) => {
      if (seen.has(entry)) return false;
      seen.add(entry);
      return true;
    })
    .slice(0, limit);
}
