// Durability helpers for the decoration maps (MYND-184 / 185).
//
// Folder-keyed decoration entries (`item_colors` folder keys + every
// `folder_icons` key) are keyed by the canonical trailing-slash path, so they
// must follow the folder when its path changes. These pure helpers mirror the
// folded-prefix rewrite/prune discipline of `planFolderRename` /
// `planFolderDelete` (`folderActions.ts`) — the same machinery `deliberate_folders`
// already rides — and are called from the rename / delete handlers so a folder's
// color + icon survive a rename (which re-roots a whole subtree) and are pruned
// on delete. Note-keyed `item_colors` entries are UUID-stable (the UUID is the
// filename) so they need no rewrite — only a lazy prune of dead UUIDs on the next
// write ({@link pruneStaleNoteColors}, the `favorites` pattern).
//
// Pure (no IPC, no React) so they stay unit-testable should a JS test runner
// land (none is wired up today; see CLAUDE.md).

import { foldSegment, normalizeFolderPath } from "../dialect/folderPath";
import type { TitleRecord } from "./loadNoteBatch";
import type { NoteId } from "./sidebarState";

/** A decoration-map key is a folder key iff it carries the trailing `/` (the
 *  same note-vs-folder discriminator as `item_order`). */
function isFolderKey(key: string): boolean {
  return key.endsWith("/");
}

/**
 * Folded-prefix walk over a decoration map: every folder-keyed entry under
 * `targetPath` is handed to `onMatch`, which decides its fate in `next` (re-key
 * it for a rename, or write nothing to drop it for a delete). Non-folder keys
 * (note UUIDs) and folder keys outside the subtree pass through untouched.
 * Returns the same reference when nothing matched (so callers skip a redundant
 * write). The fold + trailing-slash matching mirrors `planFolderRename` /
 * `planFolderDelete` in `folderActions.ts`.
 */
function remapFolderPrefix(
  map: Readonly<Record<string, string>>,
  targetPath: string,
  onMatch: (norm: string, value: string, next: Record<string, string>) => void,
): { next: Record<string, string>; changed: boolean } {
  const targetNorm = normalizeFolderPath(targetPath);
  if (targetNorm === null) {
    return { next: map as Record<string, string>, changed: false };
  }
  const targetKey = foldSegment(targetNorm);
  let changed = false;
  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    if (isFolderKey(k)) {
      const norm = normalizeFolderPath(k);
      if (norm !== null && foldSegment(norm).startsWith(targetKey)) {
        onMatch(norm, v, next);
        changed = true;
        continue;
      }
    }
    next[k] = v;
  }
  return { next, changed };
}

/**
 * Re-root every folder-keyed entry under `oldPath` to sit under `newPath`,
 * preserving the descendant suffix (a rename of `Projects/` rewrites
 * `Projects/Myne/` → `<new>/Myne/`). Non-folder keys and folder keys outside
 * the renamed subtree pass through. Returns the same reference when nothing
 * matched.
 */
export function rewriteFolderPrefix(
  map: Readonly<Record<string, string>>,
  oldPath: string,
  newPath: string,
): { next: Record<string, string>; changed: boolean } {
  const oldNorm = normalizeFolderPath(oldPath);
  const newNorm = normalizeFolderPath(newPath);
  if (oldNorm === null || newNorm === null || oldNorm === newNorm) {
    return { next: map as Record<string, string>, changed: false };
  }
  return remapFolderPrefix(map, oldPath, (norm, value, next) => {
    next[newNorm + norm.slice(oldNorm.length)] = value;
  });
}

/**
 * Drop every folder-keyed entry under `deletedPath` (the folder itself + any
 * deliberate descendant). Note keys and out-of-subtree folder keys pass
 * through. Returns the same reference when nothing matched.
 */
export function pruneFolderPrefix(
  map: Readonly<Record<string, string>>,
  deletedPath: string,
): { next: Record<string, string>; changed: boolean } {
  // onMatch writes nothing to `next` → the matched entry is dropped.
  return remapFolderPrefix(map, deletedPath, () => {});
}

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
