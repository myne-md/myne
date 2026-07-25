// Fold-aware matcher for the Settings search (MYND-536). A thin generic wrapper
// over the shared `fuzzyFilter` scorer (exact/prefix/word-boundary/substring —
// `src/commands/fuzzy`, re-exported from the editor host) that accent-folds both
// the query and every haystack first, so matching is BOTH case-insensitive
// (fuzzyFilter, downstream) AND accent-insensitive (foldAccents, here). Generic
// over the item type + its haystacks, so it carries no dependency on the
// settings registry — the registry (settingsSearchIndex) builds candidates and
// calls this.

import { fuzzyFilter, type FuzzyMatch } from "../../../commands/fuzzy";
import { foldAccents } from "./foldAccents";

export type SearchCandidate<T> = {
  item: T;
  /** Every string this item should be findable by (title, description,
   *  keywords, panel label). Falsy/empty entries are ignored. */
  haystacks: readonly string[];
};

/**
 * Score candidates against `query`, accent- and case-insensitively. An
 * empty/whitespace query returns every candidate (mirrors `fuzzyFilter`'s
 * trimmed-empty behavior) so a blank box is "no filter", not "no results".
 * Results are ordered best-match first by the underlying scorer.
 */
export function matchHaystacks<T>(
  candidates: readonly SearchCandidate<T>[],
  query: string,
): FuzzyMatch<T>[] {
  const folded = candidates.map((c) => ({
    item: c.item,
    haystacks: c.haystacks.filter(Boolean).map(foldAccents),
  }));
  return fuzzyFilter(folded, foldAccents(query));
}
