// Shared decoration-map key discipline (MYND-184 / 185 / 562).
//
// Folder-scoped decoration entries (`item_colors` folder keys + every
// `folder_icons` key) are keyed by the **folded folder identity** (`folderKey`),
// so they follow the folder across a rename and across the desktop↔mobile sync
// boundary regardless of display case. These pure helpers (no IPC, no React) are
// the ONE home for that discipline — the desktop client re-exports them via
// `src/notes/decorationRewrite.ts` and the mobile client imports them directly,
// so neither re-implements decoration identity (MYND-562: kill the two-client
// divergence class for decorations, mirroring the shared `deriveFolderTree`).
// Note-keyed `item_colors` entries are UUID-stable and pass through untouched.

import { foldSegment, normalizeFolderPath } from "@myne/dialect/folderPath";

/** A decoration-map key is a folder key iff it carries the trailing `/` (the
 *  same note-vs-folder discriminator as `item_order`). */
export function isFolderKey(key: string): boolean {
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
  if (oldNorm === null || newNorm === null) {
    return { next: map as Record<string, string>, changed: false };
  }
  const oldKey = foldSegment(oldNorm);
  const newKey = foldSegment(newNorm);
  // Case-only renames leave the folded identity unchanged — a no-op for
  // decoration keys (which are the folded identity, MYND-562).
  if (oldKey === newKey) {
    return { next: map as Record<string, string>, changed: false };
  }
  // Re-root in FOLDED space so the rewritten key stays folded: both prefixes
  // are folded, so the suffix slice is length-consistent even when folding
  // changes byte length (e.g. `İ` → `i̇`).
  return remapFolderPrefix(map, oldPath, (norm, value, next) => {
    next[newKey + foldSegment(norm).slice(oldKey.length)] = value;
  });
}

/**
 * Fold-on-load migration (MYND-562): re-key folder-scoped decoration entries
 * (trailing-slash keys) to the stable folded folder identity (`foldSegment` of
 * the normalized path), leaving note-UUID keys untouched. Idempotent — folding
 * an already-folded key is a no-op — so it self-heals against a straggler old
 * client's display-keyed write rather than a fragile one-shot. On a collision
 * (two display-case variants folding to one identity) the **lexicographic-min**
 * raw key's value wins, matching `deriveFolderTree`'s canonical-display pick and
 * the Rust merge's fold-dedup so every device converges on the same survivor.
 * Returns the same reference when nothing changed (caller skips a redundant
 * persist).
 */
export function foldDecorationKeys(
  map: Readonly<Record<string, string>>,
): { next: Record<string, string>; changed: boolean } {
  const next: Record<string, string> = {};
  const seen = new Set<string>();
  let changed = false;
  // Sorted so that on a fold-collision the lexicographic-min raw key wins.
  for (const k of Object.keys(map).sort()) {
    const value = map[k]!;
    if (!isFolderKey(k)) {
      next[k] = value; // note UUID — never folded
      continue;
    }
    const norm = normalizeFolderPath(k);
    if (norm === null) {
      next[k] = value; // not a real folder path — pass through defensively
      continue;
    }
    const folded = foldSegment(norm);
    if (seen.has(folded)) {
      changed = true; // collision loser dropped
      continue;
    }
    seen.add(folded);
    next[folded] = value;
    if (folded !== k) changed = true;
  }
  return changed
    ? { next, changed }
    : { next: map as Record<string, string>, changed: false };
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
