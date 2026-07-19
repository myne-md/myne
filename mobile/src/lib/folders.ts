// Client-side virtual-folder tree over note `folder:` frontmatter paths.
//
// MYND-562: mobile now derives the tree from the SHARED, canonical
// `deriveFolderTree` (`@myne/editor/host`) — the same identity fold, display-
// case selection, and case-variant dedup desktop uses — instead of a parallel
// mobile implementation, so the two clients can no longer diverge on folder
// name/order/identity. Notes stay flat on disk (`notes/<uuid>.myn`); the folder
// is a canonical trailing-slash path in each note's frontmatter (absent = root),
// unioned with the `deliberate_folders` set so empty folders persist.

import {
  deriveFolderTree,
  type FolderNode,
  type FolderTree,
} from "@myne/editor/host/notes/folderTree";
import { foldSegment, folderKey } from "../dialect/folderPath";

export interface FolderRow {
  /** Canonical trailing-slash DISPLAY path, e.g. "Projects/Myne/". */
  path: string;
  /** Folded folder identity (`folderKey`) — the decoration / cross-client key. */
  key: string;
  /** Last segment (display name), e.g. "Myne". */
  name: string;
  /** Notes at-or-below this folder (subtree count). */
  count: number;
}

/** Build the shared canonical folder tree from the note→folder map + the
 *  deliberate (empty-folder) set. `folderIndex` is `false` for every note —
 *  mobile has no folder-note designation UI, so no index-note hiding. */
export function deriveTree(
  folderOf: Map<string, string | null>,
  deliberate: string[] = [],
): FolderTree {
  const notes = Array.from(folderOf, ([noteUuid, folder]) => ({
    noteUuid,
    folder,
    folderIndex: false,
  }));
  return deriveFolderTree(notes, deliberate);
}

function subtreeCount(node: FolderNode): number {
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

/** Rank an item (note id, or a folded folder key) by its position in the
 *  unified `item_order` sequence (MYND-183); items absent from the sequence
 *  sort last. Folder entries in the sequence carry a trailing slash and are
 *  folded to their identity so the rank matches `FolderRow.key` / a note UUID.
 *  MYND-562: the ONE ordering both clients honor, so lists match across
 *  devices (light parity — per-level, not desktop's full flat interleave). */
export function itemOrderRank(itemOrder: string[]): (idOrKey: string) => number {
  const rank = new Map<string, number>();
  itemOrder.forEach((entry, i) => {
    const key = entry.endsWith("/") ? folderKey(entry) : entry;
    if (!rank.has(key)) rank.set(key, i);
  });
  return (idOrKey) => rank.get(idOrKey) ?? Number.MAX_SAFE_INTEGER;
}

/** Immediate child folders of `current` (null = root), deduped + canonical-cased
 *  by the shared derivation, each with a subtree note count. Ordered by the
 *  user's manual `item_order` (folded-name fallback for unlisted folders). */
export function folderChildren(
  folderOf: Map<string, string | null>,
  current: string | null,
  deliberate: string[] = [],
  itemOrder: string[] = [],
): FolderRow[] {
  const tree = deriveTree(folderOf, deliberate);
  const nodes =
    current === null ? tree.roots : (nodeAt(tree, current)?.children ?? []);
  const rank = itemOrderRank(itemOrder);
  return nodes
    .map((n) => ({
      path: n.path,
      key: n.key,
      name: n.name,
      count: subtreeCount(n),
    }))
    .sort((a, b) => {
      const ra = rank(a.key);
      const rb = rank(b.key);
      if (ra !== rb) return ra - rb;
      return foldSegment(a.name).localeCompare(foldSegment(b.name));
    });
}

/** Note ids whose folder is EXACTLY `current` (null = root / unfiled). */
export function notesDirectlyIn(
  folderOf: Map<string, string | null>,
  current: string | null,
): string[] {
  const currentKey = current ? folderKey(current) : "";
  const out: string[] = [];
  for (const [id, f] of folderOf) {
    const key = f ? folderKey(f) : "";
    if (key === currentKey) out.push(id);
  }
  return out;
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
