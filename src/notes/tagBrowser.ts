// Tag-browser view-model (knowledge-graph-ux #6 / MYND-200, build-phase v1.1).
// A PURE projection of the Rust-built tag tree into render rows, plus the SYNC-3
// trash-excluding live-id derivation and the single `byTag` consumption path
// (SYNC-10 — no divergent "notes-for-tag" route). No tree-building, folding, or
// count math here: `tagTree()` already returns nodes with `depth` /
// `directCount` / `subtreeCount` / `display`, computed Rust-side (N2). The UI
// renders `display` and NEVER the folded `key` (SYNC-2).

import { byTag, type TagTreeNode } from "./vaultIndices";
import { liveIdSet, type ResolverNote } from "./resolveWikilink";

/** Indentation step (px) applied per tag-tree depth level. */
export const TAG_INDENT_PX = 14;

/**
 * A render-ready tag row. `display` is the label the UI shows; `key` (the folded
 * canonical tag) rides along ONLY as the click identity (`byTag` folds it again,
 * idempotently) — it is never rendered as a label.
 */
export type TagRow = {
  key: string;
  display: string;
  depth: number;
  indentPx: number;
  directCount: number;
  subtreeCount: number;
};

/**
 * Project the Rust-built tag tree into render rows: carry `display`/counts
 * through unchanged and derive indent from the pre-computed `depth`. Order is
 * preserved (the Rust tree is already in display order). Pure.
 */
export function tagRows(nodes: ReadonlyArray<TagTreeNode>): TagRow[] {
  return nodes.map((n) => ({
    key: n.key,
    display: n.display,
    depth: n.depth,
    indentPx: n.depth * TAG_INDENT_PX,
    directCount: n.directCount,
    subtreeCount: n.subtreeCount,
  }));
}

/** A note under a tag — its id + display title (resolved from the note-set). */
export type TaggedNote = { noteId: string; title: string | null };

/**
 * Map a tag's note-ids to display rows, dropping any id absent from the live
 * note-set (the SYNC-3 trash/template exclusion — the resolver note-set IS the
 * live set). Pure, so the exclusion is unit-testable without IPC.
 */
export function tagNoteRows(
  ids: ReadonlyArray<string>,
  notes: ReadonlyArray<ResolverNote>,
): TaggedNote[] {
  const titleById = new Map(notes.map((n) => [n.noteUuid, n.title]));
  const out: TaggedNote[] = [];
  for (const id of ids) {
    if (!titleById.has(id)) continue; // trashed/template — excluded
    out.push({ noteId: id, title: titleById.get(id) ?? null });
  }
  return out;
}

/**
 * A tag's notes (subtree-inclusive, trash-excluded), as display rows. Consumes
 * the single `byTag` surface (SYNC-10) with the SYNC-3 live-id set, then resolves
 * titles. Async (one IPC).
 */
export async function notesForTag(
  tag: string,
  notes: ReadonlyArray<ResolverNote>,
): Promise<TaggedNote[]> {
  const ids = await byTag(tag, liveIdSet(notes));
  return tagNoteRows(ids, notes);
}
