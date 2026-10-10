// The navbar search (myne-md/myne#845).
//
// It matches a story's id, its derived display name, its description and its
// tags, so "sync error" or "empty state" finds a story whose id says nothing
// about either. The scorer is deliberately small and dependency-free: the repo's
// reproducible-build commitment means no search library, and ranking a few
// hundred short strings does not need one.
//
// Two tiers. A term that appears as a substring of a higher-weight field ranks
// above one matched only as a subsequence (which is what makes a near-miss on
// spelling still find the thing). Everything is lowercased once.

import type { StoryDescriptor } from "./types";
import { entryName } from "./naming";

/** Field weights. A human name matters more than an id, a description more than a tag. */
const WEIGHT = {
  name: 6,
  surface: 5,
  state: 4,
  description: 3,
  tag: 2,
  id: 1,
} as const;

/** True when every character of `needle` appears in `hay`, in order. */
function subsequence(needle: string, hay: string): boolean {
  let index = 0;
  for (const char of hay) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

/** Split a query into lowercase terms, dropping empties. */
export function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
}

/** Score one story against one term. 0 means no match at all. */
function scoreTerm(story: StoryDescriptor, term: string): number {
  const fields: Array<[keyof typeof WEIGHT, string]> = [
    ["name", entryName(story.surface, story.title).toLowerCase()],
    ["surface", story.surface.toLowerCase()],
    ["state", story.state.toLowerCase()],
    ["description", story.description.toLowerCase()],
    ["id", story.id.toLowerCase()],
    ...story.tags.map((tag): [keyof typeof WEIGHT, string] => ["tag", tag.toLowerCase()]),
  ];

  let best = 0;
  for (const [field, value] of fields) {
    const weight = WEIGHT[field];
    if (value.includes(term)) {
      // A field that STARTS with the term is a stronger signal than one that
      // merely contains it.
      best = Math.max(best, weight * (value.startsWith(term) ? 2 : 1));
    } else if (term.length >= 3 && subsequence(term, value)) {
      best = Math.max(best, weight * 0.5);
    }
  }
  return best;
}

/**
 * Score one story against a whole query. Every term must match somewhere, so a
 * two-word query narrows rather than widens.
 */
export function scoreStory(story: StoryDescriptor, query: string): number {
  const queryTerms = terms(query);
  if (queryTerms.length === 0) return 0;
  let total = 0;
  for (const term of queryTerms) {
    const score = scoreTerm(story, term);
    if (score === 0) return 0;
    total += score;
  }
  return total;
}

/** Stories matching `query`, best first. An empty query returns `[]`. */
export function searchStories(
  stories: readonly StoryDescriptor[],
  query: string,
): StoryDescriptor[] {
  if (terms(query).length === 0) return [];
  return stories
    .map((story) => ({ story, score: scoreStory(story, query) }))
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.story.id.localeCompare(b.story.id))
    .map((hit) => hit.story);
}
