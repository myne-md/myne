// Flatten a derived `FolderTree` into the ordered list of *visible* sidebar
// rows (respecting ephemeral collapse state), so the existing `VirtualList`
// can window over a heterogeneous row list (section header / folder / note).
//
// Pure function — no React. Grill 2026-05-29 Q3 (tree = derived view) + Q8
// (sidebar render). MYND-183 reshape: the sidebar is a SINGLE interleaved
// file-tree — folderless ("unfiled") notes render at the ROOT level alongside
// top-level folders (no separate "Vault root" section), and within every
// container sub-folders and notes are ordered TOGETHER, freely interleaved by
// the `item_order` sequence. MYND-596 reshape: `item_order` is a per-container
// map (`""` = root, else a folded folder key → that container's manual
// sequence), so each container is ranked independently. A child listed in its
// container's sequence sorts by its index; unlisted children sort after all
// listed ones — folders before notes (folded name), then notes by recency.
//
// The rank/interleave primitives (`orderContainerChildren`, `buildContainerRank`)
// live in the shared `@myne/editor/host/notes/itemOrder` module; this file
// re-exports them for the desktop consumers that reach them through here.

import {
  orderContainerChildren,
  buildContainerRank,
  type NoteId,
  type ItemOrderMap,
  type Child,
} from "@myne/editor/host/notes/itemOrder";
import type { TitleRecord } from "../loadNoteBatch";
import type { FolderNode, FolderTree } from "../folderTree";

export { orderContainerChildren, buildContainerRank };
export type { Child };

/**
 * Where a row sits in the hierarchy, for assistive technology
 * (myne-md/myne#728, task 7).
 *
 * This tree is FLATTENED before it is rendered, because the sidebar windows it
 * through `VirtualList`: there is one list of rows, each with a `depth` and a
 * left padding, and no nested DOM containers at all. So `role="group"`, which
 * the WAI-ARIA tree pattern uses to express nesting, has nothing to wrap: a
 * screen reader walking the rendered rows would be told about a flat list of
 * treeitems and hear nothing about the hierarchy the indentation is drawing.
 *
 * `aria-level` / `aria-posinset` / `aria-setsize` are what ARIA prescribes for
 * exactly this case, and they are carried here rather than derived in the
 * renderer because only the flattener knows a container's child count: the
 * renderer sees one row at a time and a virtualized window of them at that.
 *
 * `level` is 1-based (ARIA counts from one; `depth` counts from zero and stays
 * as-is because the layout arithmetic uses it). `posInSet` is 1-based within
 * the row's OWN container, and `setSize` is that container's visible child
 * count, so a collapsed folder's children are excluded from both, which is
 * correct: they are not in the tree the user is walking.
 */
export interface RowHierarchy {
  /** 1-based ARIA level. Root rows are 1. */
  level: number;
  /** 1-based position among the row's siblings in its own container. */
  posInSet: number;
  /** Number of visible siblings in that container, this row included. */
  setSize: number;
}

export type VisibleRow =
  | ({
      kind: "folder";
      key: string;
      node: FolderNode;
      depth: number;
      collapsed: boolean;
      /** No child folders and no notes anywhere beneath — a bare deliberate folder. */
      empty: boolean;
    } & RowHierarchy)
  | ({ kind: "note"; key: string; id: NoteId; depth: number } & RowHierarchy);

/** A folder is "empty" (rendered dimmed, no disclosure) when it has no children,
 *  no notes, and no folder note. A folder whose only content is its (hidden,
 *  excluded-from-`noteIds`) index note is NOT empty — it stays a normal,
 *  double-clickable row (MYND-370). */
function isEmptyFolder(node: FolderNode): boolean {
  return (
    node.children.length === 0 &&
    node.noteIds.length === 0 &&
    node.indexNoteId === null
  );
}

/**
 * Flatten `tree` into visible rows. `cache` resolves note records (and gates
 * out ids not yet loaded); `collapsed` is the set of folded folder keys
 * (ephemeral, default empty = all expanded). `itemOrder` is the per-container
 * manual sidebar order (`item_order`, MYND-596) — a map keyed by container
 * (`""` = tree root, else a folded folder key) whose values are that
 * container's manual sequence. Each container ranks its own children
 * independently: root by `itemOrder[""]`, a folder's children by
 * `itemOrder[node.key]`.
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
  itemOrder: ItemOrderMap = {},
  /** The session's newest create, pinned to the top of its container
   *  (myne#654). Required for the same reason `orderContainerChildren`'s is. */
  pinFirst: NoteId | null,
): VisibleRow[] {
  const rows: VisibleRow[] = [];

  const walk = (children: readonly Child[], depth: number): void => {
    // Counted once per container, before the walk: `posInSet`/`setSize`
    // describe this container's own children, and a child's subtree is walked
    // in between, so the size cannot be an accumulating counter.
    const setSize = children.length;
    let posInSet = 0;
    for (const child of children) {
      posInSet += 1;
      const hierarchy: RowHierarchy = { level: depth + 1, posInSet, setSize };
      if (child.kind === "note") {
        rows.push({ kind: "note", key: `n-${child.id}`, id: child.id, depth, ...hierarchy });
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
        ...hierarchy,
      });
      if (collapsedNode) continue;
      // This folder is a container: rank its children by its own sequence.
      walk(
        orderContainerChildren(
          node.children,
          node.noteIds,
          cache,
          buildContainerRank(itemOrder[node.key] ?? []),
          pinFirst,
        ),
        depth + 1,
      );
    }
  };

  // Root level (container key `""`): top-level folders + folderless (unfiled)
  // notes, interleaved by the root container's own sequence.
  walk(
    orderContainerChildren(
      tree.roots,
      tree.unfiledNoteIds,
      cache,
      buildContainerRank(itemOrder[""] ?? []),
      pinFirst,
    ),
    0,
  );

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
  const live = favorites.filter((id) => cache.has(id)); // stale-UUID GC (render half)
  // Favorites is a FLAT section of its own, so every row is level 1 and the
  // set is the live favourites. Counted after the GC filter rather than off
  // `favorites.length`: a stale id is not a row, and announcing "3 of 7" over
  // four rendered rows is worse than not announcing a position at all.
  return live.map((id, i) => ({
    kind: "note" as const,
    key: `fav-${id}`,
    id,
    depth: 0,
    level: 1,
    posInSet: i + 1,
    setSize: live.length,
  }));
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
