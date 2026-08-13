// Folder-archive helpers (MYND-470, mobile) — the mobile-side surface of the
// `prefs.archived_folders` set (folders archived as a UNIT; the folder-level twin
// of the per-note `archived:` marker). Notes are NOT rewritten; a folder is
// archived by adding its canonical trailing-slash path to the set, so an archived
// folder's whole subtree drops out of the working-set tree while the notes stay
// live (still resolvable as backlink / graph / tag / search targets — archive ≠
// trash).
//
// The predicate + set-fold helpers are no longer ported here: they live in the
// SHARED layer (`@myne/editor/host/notes/archivedFolders`) and `deriveFolderTree`
// applies them itself (myne-md/myne-mobile#39). This file used to carry hand-copies
// of them and, crucially, NOT a copy of `filterVisibleDeliberate` — so mobile hid
// an archived folder's notes but kept the folder itself as an empty shell, while
// desktop hid both from the same synced prefs. Re-exporting rather than re-porting
// is what keeps that from happening again.
//
// What remains defined below is genuinely mobile-shaped: the Archive view's
// top-level fold, its restore planner, and a subtree gather over mobile's
// note→folder map (desktop reads its `TitleRecord` cache instead).

import { folderKey } from "../dialect/folderPath";

export {
  archivedFolderKeys,
  filterVisibleDeliberate,
  isNoteFolderArchived,
} from "@myne/editor/host/notes/archivedFolders";

/**
 * The top-level archived folders (original canonical paths) for the Archive
 * view — an entry nested under another archived entry is folded away (if
 * `Projects/` and `Projects/Myne/` are both archived, only `Projects/` shows).
 * Sorted by folded key for a stable display order.
 */
export function topLevelArchivedFolders(archivedFolders: readonly string[]): string[] {
  const byKey = new Map<string, string>();
  for (const f of archivedFolders) {
    const key = folderKey(f);
    if (key.length > 0 && !byKey.has(key)) byKey.set(key, f);
  }
  const keys = [...byKey.keys()];
  const top = keys.filter(
    (key) => !keys.some((other) => other !== key && key.startsWith(other)),
  );
  top.sort((a, b) => a.localeCompare(b));
  return top.map((key) => byKey.get(key) as string);
}

/**
 * Restore a folder: the `archived_folders` set with `path` AND every entry
 * nested under it removed (restoring `Projects/` also un-archives a separately
 * archived `Projects/Myne/`, matching the top-level fold in the view). Returns a
 * fresh array — pass it to `setArchivedFolders`.
 */
export function removeFolderFromArchive(
  archivedFolders: readonly string[],
  path: string,
): string[] {
  const target = folderKey(path);
  if (target.length === 0) return [...archivedFolders];
  return archivedFolders.filter((f) => !folderKey(f).startsWith(target));
}

/**
 * Every note id whose folder is at/under `archivedKey`, from a note→folder map
 * (an archived folder is absent from the live tree, so its subtree is gathered
 * by folder prefix). The caller passes a map already scoped to non-trashed
 * archived notes. Feeds the folder row's "Delete → Trash" (bulk soft-trash).
 */
export function collectSubtreeNoteIds(
  folderOf: ReadonlyMap<string, string | null>,
  archivedKey: string,
): string[] {
  if (archivedKey.length === 0) return [];
  const ids: string[] = [];
  for (const [id, folder] of folderOf) {
    if (folderKey(folder).startsWith(archivedKey)) ids.push(id);
  }
  return ids;
}
