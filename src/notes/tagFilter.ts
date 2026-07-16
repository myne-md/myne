// Tag-filter model (tag-system #1 / MYND-46). The net-new multi-select +
// AND/OR combination layer over the single `byTag` path (SYNC-10). Pure set
// algebra (`combineTagSets`) + a thin async orchestration (`tagFilterIds`) that
// composes `byTag` per selected tag over the one SYNC-3 live-id set. No UI, no
// persistence (TS-3 — selection state is ephemeral, held by the consumer).
// Default mode AND; 0 tags = no-filter (empty, NOT all-notes) — TS-2.

import type { TitleRecord } from "./loadNoteBatch";
import { sortBatchIds, type NoteId } from "./sidebarState";
import { byTag } from "./vaultIndices";
// `combineTagSets` + `FilterMode` + `DEFAULT_FILTER_MODE` now live in the shared
// `@myne/editor` package (`host/notes/tagCombine`) — one set-algebra core shared
// with the query engine (no fork, no drift). Imported for local use below +
// re-exported so existing `./tagFilter` importers stay unchanged.
import {
  combineTagSets,
  DEFAULT_FILTER_MODE,
  type FilterMode,
} from "@myne/editor/host/notes/tagCombine";

export { combineTagSets, DEFAULT_FILTER_MODE };
export type { FilterMode };

// ============================================================
// Rich contract (TS-1): { rows: {noteId, title, matchedKeys[]}[], count }.
// ============================================================

/** A filtered-result row: the note, its display title, and which selected tags
 *  matched it (`matchedKeys`). In AND mode every row matched every selected tag;
 *  in OR mode `matchedKeys` is the subset that matched (drives "matched #x"
 *  chips). */
export type TagFilterRow = {
  noteId: string;
  title: string | null;
  matchedKeys: string[];
};

/** The rich filter result the surface (#2) renders. */
export type TagFilterResult = { rows: TagFilterRow[]; count: number };

/** A selected tag's resolved id list (its `byTag` result). */
export type TagResultList = { key: string; ids: ReadonlyArray<string> };

/**
 * Combine per-tag id-lists into the surviving ids (same order/membership as
 * `combineTagSets`), each annotated with the selected keys that matched it.
 * Pure — the provenance map is derived from the lists, the ordering delegates to
 * `combineTagSets`.
 */
export function combineWithProvenance(
  lists: ReadonlyArray<TagResultList>,
  mode: FilterMode,
): Array<{ noteId: string; matchedKeys: string[] }> {
  const keysById = new Map<string, string[]>();
  for (const { key, ids } of lists) {
    for (const id of ids) {
      const arr = keysById.get(id);
      if (arr) arr.push(key);
      else keysById.set(id, [key]);
    }
  }
  const ordered = combineTagSets(
    lists.map((l) => l.ids),
    mode,
  );
  return ordered.map((noteId) => ({
    noteId,
    matchedKeys: keysById.get(noteId) ?? [],
  }));
}

/**
 * Shape combined (id + matchedKeys) entries into the rich, recency-sorted
 * contract. Sort + title both come from the same `TitleRecord` cache, reusing
 * the canonical `sortBatchIds` (updatedAt desc, UUIDv7-creation fallback) so the
 * result order never diverges from the sidebar's. Pure.
 */
export function tagFilterRows(
  combined: ReadonlyArray<{ noteId: string; matchedKeys: string[] }>,
  cache: ReadonlyMap<NoteId, TitleRecord>,
): TagFilterResult {
  const matchedById = new Map(combined.map((c) => [c.noteId, c.matchedKeys]));
  const sortedIds = sortBatchIds(
    combined.map((c) => c.noteId),
    cache,
  );
  const rows = sortedIds.map((id) => ({
    noteId: id,
    title: cache.get(id)?.title ?? null,
    matchedKeys: matchedById.get(id) ?? [],
  }));
  return { rows, count: rows.length };
}

/**
 * End-to-end filter: resolve a multi-tag selection to the rich, recency-sorted
 * contract. Composes `byTag` per tag (SYNC-10) over the one shared live-id set
 * (SYNC-3) — so trashed/template notes never enter — combines with provenance,
 * then shapes + sorts via the `TitleRecord` cache. 0 tags → empty result, no
 * IPC. This is the surface-facing entry point (#2/#3 consume it).
 */
export async function tagFilter(
  selectedKeys: ReadonlyArray<string>,
  mode: FilterMode,
  liveIds: ReadonlySet<string>,
  cache: ReadonlyMap<NoteId, TitleRecord>,
): Promise<TagFilterResult> {
  if (selectedKeys.length === 0) return { rows: [], count: 0 };
  const lists = await Promise.all(
    selectedKeys.map(async (key) => ({ key, ids: await byTag(key, liveIds) })),
  );
  return tagFilterRows(combineWithProvenance(lists, mode), cache);
}

// ============================================================
// Freshness (SYNC-5/14): the consumer re-runs `tagFilter` on each index-nonce
// bump (a cheap, decrypt-free in-RAM re-query) and stabilizes the result so a
// reference-equal outcome bails the React render. These helpers are pure; the
// consumer owns the nonce subscription + the previous-result ref.
// ============================================================

/** Value-equality of two filter results (rows in order, matchedKeys, count). Pure. */
export function sameFilterResult(
  a: TagFilterResult,
  b: TagFilterResult,
): boolean {
  if (a === b) return true;
  if (a.count !== b.count || a.rows.length !== b.rows.length) return false;
  for (let i = 0; i < a.rows.length; i++) {
    const x = a.rows[i]!;
    const y = b.rows[i]!;
    if (x.noteId !== y.noteId || x.title !== y.title) return false;
    if (x.matchedKeys.length !== y.matchedKeys.length) return false;
    for (let j = 0; j < x.matchedKeys.length; j++) {
      if (x.matchedKeys[j] !== y.matchedKeys[j]) return false;
    }
  }
  return true;
}

/**
 * Return `prev` (reference-equal) when `next` is value-equal to it, so a
 * consumer holding `prev` in a ref bails its React render; otherwise `next`.
 * This is what makes a 500-note import that doesn't change the current filter's
 * result produce zero visible re-renders. Pure.
 */
export function stabilizeResult(
  prev: TagFilterResult | null,
  next: TagFilterResult,
): TagFilterResult {
  return prev !== null && sameFilterResult(prev, next) ? prev : next;
}
