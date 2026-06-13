// Pure candidate ranking for the `[[` picker (§6.1) — extracted from the CM
// ViewPlugin so it's unit-testable without a view. Fuzzy-matches the WL-5
// note-set by BOTH title and vault path via the shared `fuzzyFilter` scorer
// (no new dependency), caps the result, and carries each note's derived path
// for the two-line row.

import { fuzzyFilter } from "../../commands/fuzzy";
import { notePath, type ResolverNote } from "../../notes/resolveWikilink";

export type PickerRow = { note: ResolverNote; path: string };

/** Max rows shown — in-RAM scoring is cheap, but a huge vault shouldn't render
 *  thousands of DOM rows. */
export const PICKER_CAP = 50;

/**
 * Rank the note-set against `query`, matching title AND path, capped. Notes
 * without a title are excluded (can't author a link to a titleless note).
 */
export function rankNotes(
  query: string,
  notes: readonly ResolverNote[],
  cap: number = PICKER_CAP,
): PickerRow[] {
  const candidates = notes
    .filter((n): n is ResolverNote & { title: string } => n.title !== null && n.title !== "")
    .map((n) => ({ item: n, haystacks: [n.title, notePath(n)] }));
  return fuzzyFilter(candidates, query)
    .slice(0, cap)
    .map((m) => ({ note: m.item, path: notePath(m.item) }));
}
