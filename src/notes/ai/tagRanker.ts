// Tag-candidate ranker + folded-vocabulary bias (auto-tag-link MYND-411 task 1).
//
// A pure, model-agnostic reducer: given the vault's existing tag vocabulary
// (the folded `vault.indices`/MYI1 set-union of frontmatter `tags:` + inline
// `#hashtag`, read as the derived RAM cache) and a raw candidate-tag list (as
// `Engine.infer` would emit), return ranked `{ tag, isNew }` suggestions.
//
// Sprawl guard: existing-vocabulary matches rank first and a candidate that
// folds onto an existing tag COLLAPSES onto that tag's canonical display casing
// instead of appearing as a near-duplicate new tag. Two new candidates that
// fold together collapse to one. The fold is `foldSegment` — the §3.7.8 tag
// identity reused verbatim (`vaultIndices.ts` stores `foldSegment(tag)` as the
// canonical key), NOT a second normalizer.
//
// Scope: this is lexical fold-collapse only. Semantic synonym collapse
// (`#ml` ↔ `#machine-learning`) is a model/alias-map concern, out of scope for
// this pure ranker. No UI, no `Engine`/Tauri/IPC — pure function.

import { foldSegment } from "../../dialect/folderPath";

/** One ranked tag suggestion. */
export interface TagSuggestion {
  /** Display form: an existing tag's canonical casing when the candidate
   *  collapses onto the vocabulary, else the candidate's own cleaned text. */
  tag: string;
  /** True when the tag is not already in the vault's folded vocabulary. */
  isNew: boolean;
}

/**
 * Clean a raw tag token before folding: trim, then strip a single leading `#`
 * (a model may emit `#tag` while the vault index stores bare `tag`) and trim
 * again. This is input cleanup on the raw candidate stream, not a fold — the
 * identity fold stays `foldSegment`.
 */
export function cleanTagToken(raw: string): string {
  const trimmed = raw.trim();
  const bare = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
  return bare.trim();
}

/**
 * Rank raw candidate tags against the existing folded vocabulary. Existing-
 * vocabulary matches (exact or folded-normalized) come first, in input order;
 * genuinely-new tags follow, in input order. Near-duplicates (same fold) are
 * collapsed to a single suggestion. Deterministic and pure.
 */
export function rankTagCandidates(
  existingTags: readonly string[],
  candidates: readonly string[],
): TagSuggestion[] {
  // Existing vocabulary: folded key → canonical display (first occurrence wins).
  const vocab = new Map<string, string>();
  for (const t of existingTags) {
    const cleaned = cleanTagToken(t);
    if (cleaned.length === 0) continue;
    const key = foldSegment(cleaned);
    if (!vocab.has(key)) vocab.set(key, cleaned);
  }

  const seen = new Set<string>();
  const existing: TagSuggestion[] = [];
  const fresh: TagSuggestion[] = [];

  for (const raw of candidates) {
    const cleaned = cleanTagToken(raw);
    if (cleaned.length === 0) continue; // empty / whitespace / bare `#`
    const key = foldSegment(cleaned);
    if (seen.has(key)) continue; // near-dup already emitted → collapse
    seen.add(key);

    const canonical = vocab.get(key);
    if (canonical !== undefined) {
      existing.push({ tag: canonical, isNew: false }); // collapse onto vocab casing
    } else {
      fresh.push({ tag: cleaned, isNew: true });
    }
  }

  // Existing-vocabulary tags rank ahead of new; input order preserved within
  // each group (stable → deterministic).
  return [...existing, ...fresh];
}
