// Folder-archive helpers — the desktop-side surface of the `archived_folders`
// prefs set (folders archived as a UNIT; the folder-level twin of the per-note
// `archived:` marker). Notes are NOT rewritten; a folder is archived by adding
// its canonical path to the set, so an archived folder's whole subtree drops out
// of the working-set sidebar/tree while the notes themselves stay live at the
// note level (still resolvable as backlink / graph / tag / search targets —
// archive ≠ trash).
//
// The predicate + set-fold helpers now live in the SHARED layer
// (`@myne/editor/host/notes/archivedFolders`) because the tree derivation that
// consumes them is shared, and `deriveFolderTree` applies them itself
// (myne-md/myne-mobile#39). They are re-exported here so this module stays the
// one import site for folder-archive logic on the desktop side; what remains
// defined below is the part that is genuinely desktop-shaped — it reads the
// sidebar's `TitleRecord` cache.

import { folderKey } from "../dialect/folderPath";
import type { TitleRecord } from "./loadNoteBatch";

export {
  archivedFolderKeys,
  filterVisibleDeliberate,
  isNoteFolderArchived,
} from "@myne/editor/host/notes/archivedFolders";

/**
 * The top-level archived folders (original canonical paths) for the Archive
 * panel — an entry nested under another archived entry is folded away (if
 * `Projects/` and `Projects/Myne/` are both archived, only `Projects/` shows).
 * Sorted by folded key for a stable display order.
 */
export function topLevelArchivedFolders(
  archivedFolders: readonly string[],
): string[] {
  // De-dupe by folded key while keeping the first-seen original spelling.
  const byKey = new Map<string, string>();
  for (const f of archivedFolders) {
    const key = folderKey(f);
    if (key.length > 0 && !byKey.has(key)) byKey.set(key, f);
  }
  const keys = [...byKey.keys()];
  const top = keys.filter(
    // Keep a key unless a DIFFERENT archived key is a strict prefix of it.
    (key) => !keys.some((other) => other !== key && key.startsWith(other)),
  );
  top.sort((a, b) => a.localeCompare(b));
  return top.map((key) => byKey.get(key) as string);
}

/**
 * Every note whose folder is at/under a single archived folded key, from the
 * FULL cache (an archived folder is absent from the live tree, so its subtree
 * can't be read off `deriveFolderTree` — it must be gathered from the cache by
 * prefix). Excludes already-trashed / tombstoned notes (trash wins). Feeds the
 * Archive panel's folder-row "Delete → Trash" (bulk soft-trash of the subtree).
 */
export function collectSubtreeNoteIdsFromCache(
  cache: ReadonlyMap<string, TitleRecord>,
  archivedKey: string,
): string[] {
  if (archivedKey.length === 0) return [];
  const ids: string[] = [];
  for (const record of cache.values()) {
    if (record.trashed != null || record.deleted != null) continue;
    if (folderKey(record.folder).startsWith(archivedKey)) {
      ids.push(record.noteUuid);
    }
  }
  return ids;
}
