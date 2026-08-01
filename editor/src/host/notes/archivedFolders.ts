// Folder-archive predicate + set helpers, SHARED by every client (folder-archive
// feature). Folders archived as a UNIT — the folder-level twin of the per-note
// `archived:` marker. Notes are NOT rewritten; a folder is archived by adding its
// canonical path to the `archived_folders` prefs set, so an archived folder's
// whole subtree drops out of the working-set tree while the notes themselves stay
// live at the note level (still resolvable as backlink / graph / tag / search
// targets — archive ≠ trash).
//
// The set holds canonical trailing-slash folder paths (NFC-normalized, sorted,
// deduped by the Rust codec — the same encoding as `deliberate_folders` /
// `ai_excluded_folders`). A note is folder-archived when its folder equals OR is
// nested under any archived folder — the trailing slash makes the nesting check a
// plain prefix test that can't false-match a sibling whose name merely starts with
// the archived name (`Projects/` archives `Projects/Myne/` but NOT `ProjectsX/`).
//
// All folding goes through `folderKey` (NFC + case-fold on the normalized
// trailing-slash path) so the comparison uses the SAME identity as the folder tree
// (`deriveFolderTree`'s `FolderNode.key`) — a note gated here is gated the same way
// the tree derivation folds it.
//
// These live in the shared layer rather than per-client because the tree
// derivation they feed is shared: `deriveFolderTree` applies them itself
// (myne-md/myne-mobile#39). A client that re-implemented the fold would be one
// `startsWith` away from a tree that disagrees with the note filter.

import { folderKey } from "@myne/dialect/folderPath";

/**
 * Fold a raw `archived_folders` set into its canonical folded keys (trailing-
 * slash, NFC + case-fold), dropping empties + duplicates. The queryable form
 * consumed by {@link isNoteFolderArchived} / {@link filterVisibleDeliberate}
 * (compute once per set, reuse across the cache).
 */
export function archivedFolderKeys(
  archivedFolders: readonly string[],
): string[] {
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
 * Whether a note living in `noteFolder` is folder-archived by the
 * `archived_folders` set. `noteFolder` is a canonical trailing-slash folder path
 * or `null` for the vault root (root is never archivable, so a root note is never
 * folder-archived). `archivedKeys` are pre-folded (via {@link archivedFolderKeys}).
 */
export function isNoteFolderArchived(
  noteFolder: string | null,
  archivedKeys: readonly string[],
): boolean {
  if (archivedKeys.length === 0) return false;
  const key = folderKey(noteFolder);
  if (key.length === 0) return false; // root — never under an archived folder
  // Every archived key ends in `/`, so `startsWith` matches the folder itself
  // and any descendant but never a name-prefix sibling.
  return archivedKeys.some((ak) => key.startsWith(ak));
}

/**
 * Drop deliberate-folder entries that live under an archived folder, so an
 * archived-but-`deliberate` (or archived-and-empty) folder does not leak back
 * into the tree as an empty node once {@link isNoteFolderArchived} has stripped
 * its notes. Only HIDES from the derivation — the `deliberate_folders` prefs set
 * is untouched, so the empty folder reappears on restore.
 *
 * The prefix test also covers the second way an archived folder survives: a
 * deliberate DESCENDANT. `deriveFolderTree` materializes ancestors, so a
 * deliberate `Projects/Myne/` would re-create `Projects/` after `Projects/` was
 * archived — dropping the descendant too is what prevents that.
 */
export function filterVisibleDeliberate(
  deliberate: readonly string[],
  archivedKeys: readonly string[],
): string[] {
  if (archivedKeys.length === 0) return [...deliberate];
  return deliberate.filter((f) => {
    const key = folderKey(f);
    return key.length === 0 || !archivedKeys.some((ak) => key.startsWith(ak));
  });
}
