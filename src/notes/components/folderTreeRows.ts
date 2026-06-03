// Flatten a derived `FolderTree` into the ordered list of *visible* sidebar
// rows (respecting ephemeral collapse state), so the existing `VirtualList`
// can window over a heterogeneous row list (section header / folder / note).
//
// Pure function — no React. Grill 2026-05-29 Q3 (tree = derived view) + Q8
// (sidebar render). MYND-183 reshape: the sidebar is a SINGLE interleaved
// file-tree — folderless ("unfiled") notes render at the ROOT level alongside
// top-level folders (no separate "Vault root" section), and within every
// container sub-folders and notes are ordered TOGETHER, freely interleaved by
// the unified `item_order` prefs sequence. A child listed in `item_order` sorts
// by its index; unlisted children sort after all listed ones — folders before
// notes (folded name), then notes by recency.

import { foldSegment } from "../../dialect/folderPath";
import { buildRankMap, uuidv7Ms, type NoteId } from "../sidebarState";
import { itemOrderKey } from "./itemOrderReorder";
import type { TitleRecord } from "../loadNoteBatch";
import type { FolderNode, FolderTree } from "../folderTree";

export type VisibleRow =
  | {
      kind: "folder";
      key: string;
      node: FolderNode;
      depth: number;
      collapsed: boolean;
      /** No child folders and no notes anywhere beneath — a bare deliberate folder. */
      empty: boolean;
    }
  | { kind: "note"; key: string; id: NoteId; depth: number };

/** A folder is "empty" (rendered dimmed, no disclosure) when it has no children and no notes. */
function isEmptyFolder(node: FolderNode): boolean {
  return node.children.length === 0 && node.noteIds.length === 0;
}

/**
 * Build the unified `item_order` rank map — a `key → index` lookup over the
 * heterogeneous prefs sequence. A folder entry (trailing `/`) is normalized +
 * case-folded so it matches a {@link FolderNode.key}; a note entry (a UUID) is
 * kept verbatim so it matches a note id. Folded folder paths and raw UUIDs
 * never collide (a UUID carries no trailing slash). First occurrence wins —
 * defensive against accidental duplicates in the sequence.
 */
export function buildItemRankMap(
  itemOrder: readonly string[],
): Map<string, number> {
  // Fold each entry to its canonical key ([`itemOrderKey`]: folder paths →
  // `FolderNode.key`, note UUIDs verbatim) then reuse the shared first-occurrence
  // rank builder. Relative order is all that matters, so a (rare) malformed
  // folder path keyed by its raw form is harmless — it matches no node.
  return buildRankMap(itemOrder.map(itemOrderKey));
}

export type Child =
  | { kind: "folder"; node: FolderNode }
  | { kind: "note"; id: NoteId };

/**
 * Merge a container's child folders and notes into one display-ordered list,
 * interleaved by the unified `item_order` rank. A child present in `rank` sorts
 * by its index; unlisted children sort after all listed ones — folders before
 * notes (by folded name), then notes by recency (`updatedAt` desc, UUIDv7
 * fallback). Notes not yet loaded into `cache` are dropped (windowing gate —
 * the same gate the pre-MYND-183 code applied to each note group).
 */
export function orderContainerChildren(
  folders: readonly FolderNode[],
  noteIds: readonly NoteId[],
  cache: ReadonlyMap<NoteId, TitleRecord>,
  rank: ReadonlyMap<string, number>,
): Child[] {
  const children: Child[] = [
    ...folders.map((node) => ({ kind: "folder" as const, node })),
    ...noteIds
      .filter((id) => cache.has(id))
      .map((id) => ({ kind: "note" as const, id })),
  ];
  const MAX = Number.MAX_SAFE_INTEGER;
  const keyOf = (c: Child): string =>
    c.kind === "folder" ? c.node.key : c.id;
  const noteMs = (id: NoteId): number =>
    cache.get(id)?.updatedAt?.getTime() ?? uuidv7Ms(id) ?? 0;

  children.sort((a, b) => {
    const ra = rank.get(keyOf(a)) ?? MAX;
    const rb = rank.get(keyOf(b)) ?? MAX;
    if (ra !== rb) return ra - rb;
    // Equal ranks ⇒ both unlisted (finite indices are unique per key).
    if (a.kind === "folder" && b.kind === "folder") {
      return foldSegment(a.node.name).localeCompare(foldSegment(b.node.name));
    }
    if (a.kind === "note" && b.kind === "note") {
      return noteMs(b.id) - noteMs(a.id); // recency desc
    }
    // Mixed kind, both unlisted: folders before notes.
    return a.kind === "folder" ? -1 : 1;
  });
  return children;
}

/**
 * Flatten `tree` into visible rows. `cache` resolves note records (and gates
 * out ids not yet loaded); `collapsed` is the set of folded folder keys
 * (ephemeral, default empty = all expanded). `itemOrder` is the unified manual
 * sidebar order (the `item_order` prefs sequence) — folders and notes within
 * each container are interleaved by their index in it.
 *
 * Output is folder + note rows only — folderless notes and top-level folders
 * interleave at depth 0. No section-header row is emitted: the single `"Notes"`
 * header (with the new-folder / new-note actions) is a static element in the
 * render layer, not a scrolling row. An empty vault therefore flattens to `[]`.
 */
export function flattenVisibleRows(
  tree: FolderTree,
  cache: ReadonlyMap<NoteId, TitleRecord>,
  collapsed: ReadonlySet<string>,
  itemOrder: readonly string[] = [],
): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const rank = buildItemRankMap(itemOrder);

  const walk = (children: readonly Child[], depth: number): void => {
    for (const child of children) {
      if (child.kind === "note") {
        rows.push({ kind: "note", key: `n-${child.id}`, id: child.id, depth });
        continue;
      }
      const node = child.node;
      const collapsedNode = collapsed.has(node.key);
      rows.push({
        kind: "folder",
        key: `f-${node.key}`,
        node,
        depth,
        collapsed: collapsedNode,
        empty: isEmptyFolder(node),
      });
      if (collapsedNode) continue;
      walk(
        orderContainerChildren(node.children, node.noteIds, cache, rank),
        depth + 1,
      );
    }
  };

  // Root level: top-level folders + folderless (unfiled) notes, interleaved.
  walk(orderContainerChildren(tree.roots, tree.unfiledNoteIds, cache, rank), 0);

  return rows;
}

/**
 * Build the Favorites section's note rows (MYND-183) — the `favorites` prefs
 * sequence rendered as note rows in display order, with **section-qualified
 * keys** (`fav-<id>`) so a favorited note that ALSO appears in the tree
 * (`n-<id>`) keeps a unique `VirtualList` key. A favorite id with no live note
 * (`cache` miss) is skipped — the render half of stale-UUID GC; the persisted
 * list is pruned lazily on the next write ({@link pruneFavorites}). Returns `[]`
 * when there are no live favorites, so the caller can omit the section.
 */
export function buildFavoriteRows(
  favorites: readonly string[],
  cache: ReadonlyMap<NoteId, TitleRecord>,
): VisibleRow[] {
  const rows: VisibleRow[] = [];
  for (const id of favorites) {
    if (!cache.has(id)) continue; // stale-UUID GC (render half)
    rows.push({ kind: "note", key: `fav-${id}`, id, depth: 0 });
  }
  return rows;
}

/**
 * Stale-UUID GC (persist half): drop favorite ids with no live note, preserving
 * order. The client calls this before the next `favorites` write so a deleted
 * note doesn't linger in the encrypted blob.
 */
export function pruneFavorites(
  favorites: readonly string[],
  cache: ReadonlyMap<NoteId, TitleRecord>,
): string[] {
  return favorites.filter((id) => cache.has(id));
}

/**
 * Toggle `id` in the favorites sequence — append when absent, remove when
 * present (the star / context-menu action; the ONLY remove path, MYND-183).
 * No duplicates by construction.
 */
export function toggleFavoriteList(
  favorites: readonly string[],
  id: string,
): string[] {
  return favorites.includes(id)
    ? favorites.filter((f) => f !== id)
    : [...favorites, id];
}

/**
 * The visible note IDs in row order — the keyboard-navigation sequence.
 * Deduped to FIRST occurrence: a note shown in both the Favorites section and
 * the tree is visited once. Pass `[...favoriteRows, ...treeRows]` so the
 * Favorites copy wins the keyboard sequence (the tree copy stays mouse-only).
 */
export function visibleNoteIds(rows: readonly VisibleRow[]): NoteId[] {
  const out: NoteId[] = [];
  const seen = new Set<NoteId>();
  for (const r of rows) {
    if (r.kind === "note" && !seen.has(r.id)) {
      seen.add(r.id);
      out.push(r.id);
    }
  }
  return out;
}
