// Client-side virtual-folder tree over note `folder:` frontmatter paths.
//
// MYND-562: mobile derives the tree from the SHARED, canonical `deriveFolderTree`
// (`@myne/editor/host`) — the same identity fold, display-case selection, and
// case-variant dedup desktop uses. Notes stay flat on disk (`notes/<uuid>.myn`);
// the folder is a canonical trailing-slash path in each note's frontmatter
// (absent = root), unioned with the `deliberate_folders` set so empty folders
// persist.
//
// MYND-596: the sidebar DISPLAY ORDER — folders and notes interleaved in one list
// per container, honoring the container-keyed `item_order` map — comes from the
// SHARED `orderContainerChildren` (`@myne/editor/host/notes/itemOrder`), the exact
// ranker desktop walks, so the two clients render the same list from the same
// synced `item_order` (a note can sit above a folder). The former mobile-local
// `itemOrderRank` / per-kind `folderChildren`+`notesDirectlyIn` ("light parity —
// per-level, not desktop's full flat interleave") are gone.

import {
  deriveFolderTree,
  type FolderNode,
  type FolderTree,
} from "@myne/editor/host/notes/folderTree";
import {
  buildContainerRank,
  computeItemOrderAfterReorder,
  itemOrderKey,
  orderContainerChildren,
  type Child,
  type ItemOrderMap,
  type OrderedNoteRecord,
} from "@myne/editor/host/notes/itemOrder";
import { folderKey } from "../dialect/folderPath";

/** Build the shared canonical folder tree from the note→folder map + the
 *  deliberate (empty-folder) set + the archived (`prefs.archived_folders`) set.
 *  `folderIndex` is `false` for every note — mobile has no folder-note
 *  designation UI, so no index-note hiding.
 *
 *  Both sets are REQUIRED, deliberately (myne-md/myne-mobile#39). This wrapper
 *  used to default `deliberate` to `[]`, and defaulting `archived` the same way
 *  would just move the forgettable step up one level — which is the exact shape
 *  of the bug this parameter exists to prevent. */
export function deriveTree(
  folderOf: Map<string, string | null>,
  deliberate: string[],
  archived: string[],
): FolderTree {
  const notes = Array.from(folderOf, ([noteUuid, folder]) => ({
    noteUuid,
    folder,
    folderIndex: false,
  }));
  return deriveFolderTree(notes, deliberate, archived);
}

/** Notes at-or-below this folder (subtree count), the count shown on a folder row. */
export function subtreeCount(node: FolderNode): number {
  let c = node.noteIds.length;
  for (const child of node.children) c += subtreeCount(child);
  return c;
}

/** Find the tree node whose folded identity matches `path`, or null. */
function nodeAt(tree: FolderTree, path: string): FolderNode | null {
  const want = folderKey(path);
  const stack = [...tree.roots];
  while (stack.length > 0) {
    const n = stack.pop()!;
    if (n.key === want) return n;
    for (const child of n.children) stack.push(child);
  }
  return null;
}

/** The container key one container is stored under in the `item_order` map:
 *  `""` for the tree root, else the container folder's folded key. */
function containerKeyOf(containerPath: string | null): string {
  return containerPath === null ? "" : folderKey(containerPath);
}

/** Resolve a container (root = `null`, else a folder DISPLAY path) to its child
 *  folders + directly-contained note ids. An unknown path yields an empty
 *  container (defensive — a stale path from transient state). */
export function containerNodes(
  tree: FolderTree,
  containerPath: string | null,
): { folders: FolderNode[]; noteIds: string[] } {
  if (containerPath === null) {
    return { folders: tree.roots, noteIds: tree.unfiledNoteIds };
  }
  const node = nodeAt(tree, containerPath);
  return node
    ? { folders: node.children, noteIds: node.noteIds }
    : { folders: [], noteIds: [] };
}

/** The `item_order` entry form of a rendered child — a note UUID verbatim, or a
 *  child folder's DISPLAY path (trailing `/`), NOT its folded key: the sequence
 *  stores display paths (folded only on compare via {@link itemOrderKey}). */
export function childKey(child: Child): string {
  return child.kind === "folder" ? child.node.path : child.id;
}

/**
 * One container's children — child folders + directly-contained notes — merged
 * into a single DISPLAY-ordered list via the SHARED `orderContainerChildren`
 * (MYND-596). The container reads only its OWN sequence (`item_order[key]`);
 * unlisted children fall back to folders-before-notes / folded name / recency,
 * exactly as desktop. Notes absent from `cache` are dropped (the windowing gate).
 */
export function orderedChildren(
  tree: FolderTree,
  containerPath: string | null,
  itemOrder: ItemOrderMap,
  cache: ReadonlyMap<string, OrderedNoteRecord>,
): Child[] {
  const { folders, noteIds } = containerNodes(tree, containerPath);
  const rank = buildContainerRank(itemOrder[containerKeyOf(containerPath)] ?? []);
  // `null`: mobile has no just-created pin (myne#654 is a desktop sidebar
  // affordance and mobile has no sidebar). Stated rather than defaulted,
  // because the parameter is required precisely so a client that HAS one
  // cannot forget to pass it.
  return orderContainerChildren(folders, noteIds, cache, rank, null);
}

/** {@link orderedChildren} projected to each child's `item_order` key (note UUID
 *  or child-folder display path) — the reorder helpers' working list. */
export function orderedChildKeys(
  tree: FolderTree,
  containerPath: string | null,
  itemOrder: ItemOrderMap,
  cache: ReadonlyMap<string, OrderedNoteRecord>,
): string[] {
  return orderedChildren(tree, containerPath, itemOrder, cache).map(childKey);
}

/**
 * The same rewrite for a row DROPPED onto another (owner, 2026-11-08: the arrows
 * became a press-and-hold drag). Shares one splice and one container rule with the
 * nudge, so a drag never touches a sibling container's order. `null` for a drop
 * onto itself or onto a row outside this container: moving a note between folders
 * is a `folder:` write, not an ordering one.
 */
export function reorderChildBeside(params: {
  tree: FolderTree;
  itemOrder: ItemOrderMap;
  cache: ReadonlyMap<string, OrderedNoteRecord>;
  containerPath: string | null;
  rowKey: string;
  targetKey: string;
  place: "above" | "below";
}): Record<string, string[]> | null {
  const { tree, itemOrder, cache, containerPath, rowKey, targetKey, place } = params;
  const keys = orderedChildKeys(tree, containerPath, itemOrder, cache);
  const folded = (k: string) => itemOrderKey(k);
  const index = keys.findIndex((k) => folded(k) === folded(rowKey));
  const targetIndex = keys.findIndex((k) => folded(k) === folded(targetKey));
  if (index < 0 || targetIndex < 0 || index === targetIndex) return null;
  return computeItemOrderAfterReorder({
    itemOrder,
    container: containerKeyOf(containerPath),
    containerChildKeys: keys.filter((_, i) => i !== index),
    draggedKey: rowKey,
    targetKey,
    place,
  });
}

/** Note ids at-or-below `path` (subtree; the `inFolder` view resolver). A root
 *  path (null / "") matches every note. Fold-insensitive prefix match. */
export function notesInSubtree(
  folderOf: Map<string, string | null>,
  path: string | null,
): string[] {
  const wantKey = path ? folderKey(path) : "";
  const out: string[] = [];
  for (const [id, f] of folderOf) {
    const key = f ? folderKey(f) : "";
    if (wantKey === "" || key.startsWith(wantKey)) out.push(id);
  }
  return out;
}
