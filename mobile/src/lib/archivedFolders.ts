// Folder-archive predicate + set helpers (MYND-470, mobile). Port of the
// desktop `src/notes/archivedFolders.ts` pure logic — folders archived as a UNIT
// via the `prefs.archived_folders` set (the folder-level twin of the per-note
// `archived:` marker). Notes are NOT rewritten; a folder is archived by adding
// its canonical trailing-slash path to the set, so an archived folder's whole
// subtree drops out of the working-set tree while the notes stay live (still
// resolvable as backlink / graph / tag / search targets — archive ≠ trash).
//
// The set holds canonical trailing-slash folder paths (NFC-normalized, sorted,
// deduped by the shared Rust codec). A note is folder-archived when its folder
// equals OR is nested under any archived folder — the trailing slash makes the
// nesting check a plain prefix test that can't false-match a sibling whose name
// merely starts with the archived name (`Projects/` archives `Projects/Myne/`
// but NOT `ProjectsX/`). All folding goes through `folderKey` (NFC + case-fold),
// the same identity the folder tree (`folders.ts`) uses.

import { folderKey } from "../dialect/folderPath";

/**
 * Fold a raw `archived_folders` set into canonical folded keys (trailing-slash,
 * NFC + case-fold), dropping empties + duplicates. The queryable form consumed
 * by {@link isNoteFolderArchived} (compute once per set, reuse across notes).
 */
export function archivedFolderKeys(archivedFolders: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const f of archivedFolders) {
    const key = folderKey(f);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Whether a note living in `noteFolder` is folder-archived by the pre-folded
 * `archivedKeys` (from {@link archivedFolderKeys}). `noteFolder` is a canonical
 * trailing-slash path or `null` for the vault root (root is never archivable).
 */
export function isNoteFolderArchived(
  noteFolder: string | null,
  archivedKeys: readonly string[],
): boolean {
  if (archivedKeys.length === 0) return false;
  const key = folderKey(noteFolder);
  if (key.length === 0) return false; // root — never under an archived folder
  return archivedKeys.some((ak) => key.startsWith(ak));
}

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
