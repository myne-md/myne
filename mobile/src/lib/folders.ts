// Client-side virtual-folder tree over note `folder:` frontmatter paths — the
// mobile counterpart to the desktop folderTree/folderTreeRows. Notes stay flat
// on disk (`notes/<uuid>.myn`); the folder is a canonical trailing-slash path in
// each note's frontmatter (absent = root). This derives the drill-down view:
// immediate sub-folders + notes directly at a level.

import { folderKey, ancestorPaths } from "../dialect/folderPath";

export interface FolderRow {
  /** Canonical trailing-slash path, e.g. "Projects/Myne/". */
  path: string;
  /** Last segment (display name), e.g. "Myne". */
  name: string;
  /** Notes at-or-below this folder (subtree count). */
  count: number;
}

function depthOf(path: string | null): number {
  return path ? path.split("/").filter(Boolean).length : 0;
}

/** Immediate child folders of `current` (null = root), across the folders any
 *  note lives in (ancestors expanded), with a subtree note count. Sorted by name. */
export function folderChildren(folderOf: Map<string, string | null>, current: string | null): FolderRow[] {
  const currentKey = current ? folderKey(current) : "";
  const currentDepth = depthOf(current);

  // Every folder path implied by a note (ancestor-expanded).
  const all = new Set<string>();
  for (const f of folderOf.values()) {
    if (!f) continue;
    for (const a of ancestorPaths(f)) all.add(a);
  }

  const rows: FolderRow[] = [];
  for (const path of all) {
    const segs = path.split("/").filter(Boolean);
    if (segs.length !== currentDepth + 1) continue;
    // For a non-root current, the child's parent must fold-match current.
    if (current) {
      const parent = segs.slice(0, currentDepth).join("/") + "/";
      if (folderKey(parent) !== currentKey) continue;
    }
    const key = folderKey(path);
    let count = 0;
    for (const f of folderOf.values()) {
      if (f && folderKey(f).startsWith(key)) count += 1;
    }
    rows.push({ path, name: segs[segs.length - 1], count });
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name));
}

/** Note ids whose folder is EXACTLY `current` (null = root / unfiled). */
export function notesDirectlyIn(folderOf: Map<string, string | null>, current: string | null): string[] {
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
export function notesInSubtree(folderOf: Map<string, string | null>, path: string | null): string[] {
  const wantKey = path ? folderKey(path) : "";
  const out: string[] = [];
  for (const [id, f] of folderOf) {
    const key = f ? folderKey(f) : "";
    if (wantKey === "" || key.startsWith(wantKey)) out.push(id);
  }
  return out;
}
