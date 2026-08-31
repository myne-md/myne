// Pure candidate ranking for the `[[` picker (§6.1) — extracted from the CM
// ViewPlugin so it's unit-testable without a view. Fuzzy-matches the WL-5
// note-set by BOTH title and vault path via the shared `fuzzyFilter` scorer
// (no new dependency), caps the result, and carries each note's derived path
// for the two-line row.
//
// Folder-target candidates (MYND-370) are ADDITIVE: the same note-set the
// picker already reads is ancestor-expanded into the set of folder paths it
// implies (deduped by folded identity), each offered as a row that inserts the
// trailing-slash form `[[Projects/]]` — resolving to the folder's index note
// (`resolveWikilink`). No new facet/plumbing: folders are derived from the
// notes already in hand.

import { fuzzyFilter, type FuzzyCandidate } from "@myne/editor/host/commands/fuzzy";
import {
  ancestorPaths,
  foldSegment,
  normalizeFolderPath,
} from "@myne/dialect/folderPath";
import { notePath, type ResolverNote } from "@myne/editor/host/notes/resolveWikilink";

/** A note candidate — inserts the canonical §3 path-with-alias link. */
export type NotePickerRow = { kind: "note"; note: ResolverNote; path: string };
/** A folder-target candidate (MYND-370) — inserts `[[<path>]]` where `path`
 *  carries its trailing slash (e.g. `"Projects/"`). */
export type FolderPickerRow = { kind: "folder"; path: string };
export type PickerRow = NotePickerRow | FolderPickerRow;

/** Max rows shown — in-RAM scoring is cheap, but a huge vault shouldn't render
 *  thousands of DOM rows. */
export const PICKER_CAP = 50;

/** The set of folder paths implied by the note-set: each note's `folder:` field
 *  ancestor-expanded, deduped by folded identity (first display form wins). */
function deriveFolderPaths(notes: readonly ResolverNote[]): string[] {
  const byKey = new Map<string, string>();
  for (const n of notes) {
    const norm = normalizeFolderPath(n.folder);
    if (norm === null) continue;
    for (const path of ancestorPaths(norm)) {
      const key = foldSegment(path);
      if (!byKey.has(key)) byKey.set(key, path);
    }
  }
  return [...byKey.values()];
}

/**
 * Rank the note-set against `query`, matching title AND path, plus the folder
 * paths the note-set implies (matched on the trailing-slash path), capped. Notes
 * without a title are excluded (can't author a link to a titleless note).
 * Folder rows sort after note rows of equal score (notes are the common case).
 *
 * `recent` (note UUIDs, newest first; myne-md/myne#601) breaks ties the score
 * cannot: many titles fuzzy-match two letters equally well, and the one being
 * linked to is almost always a note that was just open. It is a TIEBREAK rather
 * than a boost, so a better match still wins, except on an EMPTY query, where
 * `fuzzyFilter` gives every candidate the same score and the order is therefore
 * recency's alone. That case is the one that matters most: the picker opens on
 * `[[`, before a character is typed.
 */
export function rankNotes(
  query: string,
  notes: readonly ResolverNote[],
  recent: readonly string[],
  cap: number = PICKER_CAP,
): PickerRow[] {
  // The fuzzy item carries the row's discriminant so the scorer ranks notes and
  // folders together; the result `.map` rebuilds the public `PickerRow` shape.
  type RankItem =
    | { kind: "note"; note: ResolverNote }
    | { kind: "folder"; path: string };
  const noteCandidates: FuzzyCandidate<RankItem>[] = notes
    .filter((n): n is ResolverNote & { title: string } => n.title !== null && n.title !== "")
    .map((n) => ({ item: { kind: "note", note: n }, haystacks: [n.title, notePath(n)] }));
  const folderCandidates: FuzzyCandidate<RankItem>[] = deriveFolderPaths(notes).map(
    (path) => ({ item: { kind: "folder", path }, haystacks: [path] }),
  );
  // Position in `recent`, or `Infinity` for a note that is not in it, so an
  // untouched note sorts after every touched one, and a folder row (which has no
  // note to have been touched) keeps the place its score gave it.
  const recencyOf = new Map(recent.map((id, i) => [id, i] as const));
  const recencyRank = (item: RankItem): number =>
    item.kind === "note"
      ? (recencyOf.get(item.note.noteUuid) ?? Number.POSITIVE_INFINITY)
      : Number.POSITIVE_INFINITY;
  const scored = fuzzyFilter([...noteCandidates, ...folderCandidates], query);
  // Reorder only WITHIN equal scores. `fuzzyFilter` has already sorted by score
  // and `Array.prototype.sort` is stable, so anything this comparator calls
  // equal keeps the scorer's order; comparing scores here would re-implement it.
  //
  // Skipped entirely when nothing is recent, and that is not a micro-optimism:
  // on an EMPTY query `fuzzyFilter` returns every candidate at score 1, so this
  // sort is O(n log n) over every titled note plus every derived folder path,
  // with two map lookups per comparison, to choose `cap` rows. Before recency
  // existed the empty-query path was a bare `slice`. A host that tracks no
  // recency, and every mount before the first note is opened, gets that back.
  // `sort` mutates, so the copy is only needed on the path that sorts.
  const ordered =
    recencyOf.size === 0
      ? scored
      : scored
          .slice()
          .sort((a, b) =>
            a.score === b.score ? recencyRank(a.item) - recencyRank(b.item) : 0,
          );
  return ordered
    .slice(0, cap)
    .map((m) =>
      m.item.kind === "note"
        ? { kind: "note" as const, note: m.item.note, path: notePath(m.item.note) }
        : { kind: "folder" as const, path: m.item.path },
    );
}
