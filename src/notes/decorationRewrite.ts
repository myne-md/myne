// Desktop re-export shim for the shared decoration-map key discipline.
//
// The pure fold/rewrite/prune helpers moved to `@myne/editor/host/notes/
// decorationKeys` (MYND-562) so the desktop and mobile clients share ONE
// decoration-identity implementation — mirroring the shared `deriveFolderTree`.
// Desktop importers keep importing from `../decorationRewrite` unchanged; only
// `pruneStaleNoteColors` stays here because it is desktop-specific (it reads the
// `NoteId`/`TitleRecord` live cache).

import {
  isFolderKey,
  foldDecorationKeys,
  pruneFolderPrefix,
  rewriteFolderPrefix,
} from "@myne/editor/host/notes/decorationKeys";
import type { TitleRecord } from "./loadNoteBatch";
import type { NoteId } from "./sidebarState";

export { foldDecorationKeys, pruneFolderPrefix, rewriteFolderPrefix };

/**
 * Lazy GC for `item_colors`: drop note-keyed entries (no trailing `/`) whose
 * note is no longer in the live cache — the `favorites`-pruning pattern,
 * applied on every write. Folder keys are always kept (rename/delete handle
 * those explicitly; folders are not in the note cache).
 */
export function pruneStaleNoteColors(
  map: Readonly<Record<string, string>>,
  cache: ReadonlyMap<NoteId, TitleRecord>,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (isFolderKey(k) || cache.has(k)) next[k] = v;
  }
  return next;
}
