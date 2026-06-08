// Obsidian importer — empty-source-directory → deliberate_folders detection.
//
// Sub-feature 1 of the obsidian-importer epic (MYND-51), task 4 (SYNC-4).
//
// An Obsidian directory that contains no importable note beneath it has no
// note `folder:` field to represent it, so it would vanish on import. To keep
// the round trip faithful, its canonical trailing-slash `folder:` value is
// persisted to `deliberate_folders` (vault.prefs §9.5.2). A directory that has
// (or is an ancestor of) any imported note is already represented by that
// note's `folder:` field and is NOT emitted — no double-count.
//
// Pure + in-memory: this yields the deduplicated set of values; the engine
// (sub-feature 3) issues the single `set_deliberate_folders` write at
// end-of-import. No IPC here. Folder identity + ancestor expansion reuse the
// shared `folderKey` / `ancestorPaths` helpers (the same ones the daily-note
// resolver and folder-tree derivation use — SYNC-5).

import {
  ancestorPaths,
  folderKey,
  normalizeFolderPath,
} from "../../dialect/folderPath";

/**
 * Canonical `folder:` values for source directories with no importable note
 * beneath them, deduplicated under case-fold+NFC identity. A directory that is
 * (or is an ancestor of) any imported note's folder is "covered" and excluded.
 *
 * @param sourceDirs   every directory the walk saw, as Obsidian-relative paths.
 * @param noteFolders  the `folder:` value each imported note received (null = root).
 */
export function collectDeliberateImportFolders(
  sourceDirs: readonly string[],
  noteFolders: readonly (string | null)[],
): string[] {
  const covered = new Set<string>();
  for (const f of noteFolders) {
    if (f === null) continue;
    for (const ancestor of ancestorPaths(f)) covered.add(folderKey(ancestor));
  }

  const result: string[] = [];
  const seen = new Set<string>();
  for (const dir of sourceDirs) {
    const canonical = normalizeFolderPath(dir);
    if (canonical === null) continue; // vault root — never a deliberate folder
    const key = folderKey(canonical);
    if (covered.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(canonical);
  }
  return result;
}
