// Conflict-copy materialization (MYND-424 task 7 / MYND-427) — the TS side of
// the engine's keep-both resolution (SYNC-11). When the engine decides two
// concurrent body edits both survive, the *remote* revision is materialized as a
// new `.myn` note carrying the managed frontmatter `conflict: true` +
// `conflict_of: <original-uuid>`. The original note is left untouched; both
// survive. MYND-427's Conflicts view groups copies by `conflict_of:`.
//
// TS orchestrator over the generic `patchFrontmatterField` surgery + the existing
// `note_create` IPC — exactly like `trashNote`/`archiveNote` (no backend command,
// no ACL change; the markers ride the existing `.myn` envelope).

import { patchFrontmatterField, patchDeletedField } from "../dialect";
import { invoke } from "@tauri-apps/api/core";
import { noteRead } from "./readNote";
import { noteUpdate } from "./updateNote";
import { deleteNoteRouted } from "./deleteNote";
import { prefsRead, setFavorites, setItemOrder } from "../lib/prefs";
import { migrateNoteUuidInPrefs } from "./conflictMigratePrefs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Build the conflict-copy content: the remote body with `conflict: true` +
 * `conflict_of: <originalUuid>` added to its frontmatter (composing onto any
 * frontmatter the body already carries). Pure — unit-tested.
 */
export function buildConflictCopyContent(remoteBody: string, originalUuid: string): string {
  const withConflict = patchFrontmatterField(encoder.encode(remoteBody), "conflict", "true");
  const withBoth = patchFrontmatterField(withConflict, "conflict_of", originalUuid);
  return decoder.decode(withBoth);
}

/**
 * Materialize a keep-both conflict copy as a new note (the engine's
 * `ConflictCopyPlan` executed): create a fresh `.myn` carrying the remote body +
 * the conflict markers. Returns the new note id. The original note is untouched.
 */
export async function createConflictCopy(
  remoteBody: string,
  originalUuid: string,
): Promise<string> {
  const content = buildConflictCopyContent(remoteBody, originalUuid);
  return invoke<string>("plugin:notes|note_create", { plaintext: content });
}

/**
 * Resolve a conflict copy by clearing its `conflict:` markers ("keep both as
 * separate notes" — the copy becomes an ordinary note). Returns the cleared
 * content for the caller to `note_update`.
 */
export function clearConflictMarkers(content: string): string {
  const noConflict = patchFrontmatterField(encoder.encode(content), "conflict", null);
  const cleared = patchFrontmatterField(noConflict, "conflict_of", null);
  return decoder.decode(cleared);
}

/**
 * Resolve a note conflict by "take theirs" / "Use this version" (MYND-452):
 * the remote conflict copy wins and the local original is sent to trash.
 *
 * Realized as **promote-the-copy** (no in-place overwrite of the original): the
 * copy's `conflict:` markers are cleared so it becomes the surviving ordinary
 * note, the original's uuid-keyed prefs membership (favorites star + manual
 * `item_order` position) is migrated onto the copy, and the original is
 * tombstoned via the **same routed/propagating path Discard uses**
 * (`deleteNoteRouted`) — so the win replicates to other devices and the original
 * is recoverable (the Undo affordance un-tombstones it; post-window recovery is
 * identical to Discard's). The original is trashed only AFTER the copy is safely
 * promoted, so there is no window where both versions are gone.
 *
 * `originalUuid` must be a real note uuid (the group's `conflict_of:`); the
 * caller is responsible for not invoking this on an unknown-original copy.
 */
export async function applyConflictVersion(
  copyId: string,
  originalUuid: string,
): Promise<void> {
  // 1. Promote the copy → ordinary surviving note.
  const copyContent = await noteRead(copyId);
  await noteUpdate(copyId, clearConflictMarkers(copyContent));
  // 2. Carry the original's favorites/item_order membership onto the copy.
  await migratePrefsMembership(originalUuid, copyId);
  // 3. Tombstone the original last (recoverable + propagating, like Discard).
  await deleteNoteRouted(originalUuid);
}

/** Move a note's `favorites` + `item_order` prefs membership from `fromUuid` to
 *  `toUuid` and persist — the shared read/migrate/write triad both the forward
 *  take-theirs and its undo use (the two prefs writes are independent domains,
 *  so they go out concurrently). No-op disk write when nothing changed. */
async function migratePrefsMembership(
  fromUuid: string,
  toUuid: string,
): Promise<void> {
  const prefs = await prefsRead();
  const migrated = migrateNoteUuidInPrefs(
    { favorites: prefs.favorites, itemOrder: prefs.item_order },
    fromUuid,
    toUuid,
  );
  if (migrated.changed) {
    await Promise.all([
      setFavorites(migrated.favorites),
      setItemOrder(migrated.itemOrder),
    ]);
  }
}

/**
 * Undo a `applyConflictVersion` take-theirs (MYND-452, the toast's Undo action):
 * reverse all three steps so the conflict re-appears exactly as before.
 *
 * 1. Un-tombstone the original — clear its `deleted:` marker (a new version that
 *    propagates the un-deletion, the in-band inverse of `tombstoneNote`).
 * 2. Re-mark the promoted copy as a conflict copy (`conflict: true` +
 *    `conflict_of: <originalUuid>`), so it returns to the Conflicts surface.
 * 3. Revert the prefs migration (copy → original).
 *
 * Best-effort like the forward path: conflicts only occur under sync, so the
 * original was tombstoned (not hard-deleted) and is still on disk to un-mark.
 */
export async function undoConflictVersion(
  copyId: string,
  originalUuid: string,
): Promise<void> {
  // 1+2. Read both notes concurrently (independent), then un-tombstone the
  //      original and re-mark the copy as a conflict copy (also independent —
  //      different notes — so the two writes go out together).
  const [original, copyContent] = await Promise.all([
    noteRead(originalUuid),
    noteRead(copyId),
  ]);
  await Promise.all([
    noteUpdate(originalUuid, decoder.decode(patchDeletedField(encoder.encode(original), null))),
    noteUpdate(copyId, buildConflictCopyContent(copyContent, originalUuid)),
  ]);
  // 3. Revert the prefs migration (copy → original).
  await migratePrefsMembership(copyId, originalUuid);
}
