// Flatten a derived `FolderTree` into the ordered list of *visible* sidebar
// rows (respecting ephemeral collapse state), so the existing `VirtualList`
// can window over a heterogeneous row list (section header / folder / note).
//
// Pure function — no React. Grill 2026-05-29 Q3 (tree = derived view) + Q8
// (sidebar render). Ordering: VAULT ROOT (unfiled notes) first, then FOLDERS;
// within a folder, **child folders before notes** (Obsidian convention).

import { buildRankMap, sortBatchIds, type NoteId } from "../sidebarState";
import type { TitleRecord } from "../loadNoteBatch";
import type { FolderNode, FolderTree } from "../folderTree";

export type VisibleRow =
  | { kind: "section"; key: string; label: string }
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
 * Flatten `tree` into visible rows. `cache` resolves note records (and gates
 * out ids not yet loaded); `collapsed` is the set of folded folder keys
 * (ephemeral, default empty = all expanded). `noteOrder` is the manual sidebar
 * sort sequence (note_order prefs field) — notes within each folder sort by
 * their index in it, then by recency for the unlisted remainder.
 */
export function flattenVisibleRows(
  tree: FolderTree,
  cache: ReadonlyMap<NoteId, TitleRecord>,
  collapsed: ReadonlySet<string>,
  noteOrder: readonly string[] = [],
): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const rank = buildRankMap(noteOrder);

  const unfiled = sortBatchIds(
    tree.unfiledNoteIds.filter((id) => cache.has(id)),
    cache,
    rank,
  );
  if (unfiled.length > 0) {
    rows.push({ kind: "section", key: "sec-root", label: "Vault root" });
    for (const id of unfiled) {
      rows.push({ kind: "note", key: `n-${id}`, id, depth: 0 });
    }
  }

  if (tree.roots.length > 0) {
    rows.push({ kind: "section", key: "sec-folders", label: "Folders" });
    const walk = (nodes: readonly FolderNode[], depth: number): void => {
      for (const node of nodes) {
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
        // Child folders first, then this folder's own notes.
        walk(node.children, depth + 1);
        for (const id of sortBatchIds(
          node.noteIds.filter((i) => cache.has(i)),
          cache,
          rank,
        )) {
          rows.push({ kind: "note", key: `n-${id}`, id, depth: depth + 1 });
        }
      }
    };
    walk(tree.roots, 0);
  }

  return rows;
}

/** The visible note IDs in tree order — the keyboard-navigation sequence. */
export function visibleNoteIds(rows: readonly VisibleRow[]): NoteId[] {
  const out: NoteId[] = [];
  for (const r of rows) if (r.kind === "note") out.push(r.id);
  return out;
}
