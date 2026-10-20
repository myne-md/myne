// Conflict-copy orchestrators (MYND-424 task 7 / MYND-427 / MYND-452, SYNC-11)
// — the cross-client TS side of the engine's keep-both resolution. Lifted out of
// the desktop `src/notes/conflictCopy.ts` into `@myne/dialect` (SYNC-45) so the
// mobile client consumes the identical logic instead of writing a second copy;
// the note-IO the orchestrators need is INJECTED via a `ConflictCopyHost` (the
// same EditorHost-seam pattern the shared editor uses), so neither the desktop
// `invoke("plugin:notes|…")` nor the desktop prefs plumbing is baked in here.
//
// The managed-frontmatter conflict markers (`conflict: true` + `conflict_of:`)
// are already specced in `markdown-dialect.md` §3.6.1 and their surgery lives in
// `./surgery`; this module only orchestrates the note/prefs IO around them.

import { patchFrontmatterField, patchDeletedField } from "./surgery";
import { migrateNoteUuidInPrefs } from "./conflictMigratePrefs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The note + prefs IO the orchestrators need, injected per client. */
export interface ConflictCopyHost {
  /** Read a note's plaintext by id. */
  noteRead(id: string): Promise<string>;
  /** Overwrite a note's plaintext.
   *
   *  `expectedBaseHashHex` and `base` are optional because a caller on a client
   *  without the three-way live save passes neither; where they exist they are
   *  what lets a write through a [live session](#live-session) MERGE a peer edit
   *  instead of replacing it (`myne-md/myne#849`).
   */
  noteUpdate(
    id: string,
    content: string,
    expectedBaseHashHex?: string,
    base?: string,
  ): Promise<void>;
  /** Create a new note from plaintext; returns the new note id. */
  noteCreate(plaintext: string): Promise<string>;
  /** Tombstone a note via the routed/propagating delete path (recoverable). */
  deleteNoteRouted(uuid: string): Promise<void>;
  /** Read the uuid-keyed prefs the take-theirs migration touches. `item_order`
   *  is the container-keyed map (MYND-596). */
  prefsRead(): Promise<{
    favorites: readonly string[];
    item_order: Readonly<Record<string, readonly string[]>>;
  }>;
  /** Persist the favorites set. */
  setFavorites(favorites: string[]): Promise<void>;
  /** Persist the item-order container-keyed map (MYND-596). */
  setItemOrder(itemOrder: Record<string, string[]>): Promise<void>;
}

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
 * Resolve a conflict copy by clearing its `conflict:` markers ("keep both as
 * separate notes" — the copy becomes an ordinary note). Returns the cleared
 * content for the caller to persist. Pure.
 */
export function clearConflictMarkers(content: string): string {
  const noConflict = patchFrontmatterField(encoder.encode(content), "conflict", null);
  const cleared = patchFrontmatterField(noConflict, "conflict_of", null);
  return decoder.decode(cleared);
}

/**
 * Materialize a keep-both conflict copy as a new note (the engine's
 * `ConflictCopyPlan` executed): create a fresh `.myn` carrying the remote body +
 * the conflict markers. Returns the new note id. The original note is untouched.
 */
export async function createConflictCopy(
  host: ConflictCopyHost,
  remoteBody: string,
  originalUuid: string,
): Promise<string> {
  return host.noteCreate(buildConflictCopyContent(remoteBody, originalUuid));
}

/** Move a note's `favorites` + `item_order` prefs membership from `fromUuid` to
 *  `toUuid` and persist — the shared read/migrate/write triad both the forward
 *  take-theirs and its undo use (the two prefs writes are independent domains, so
 *  they go out concurrently). No-op disk write when nothing changed. */
async function migratePrefsMembership(
  host: ConflictCopyHost,
  fromUuid: string,
  toUuid: string,
): Promise<void> {
  const prefs = await host.prefsRead();
  const migrated = migrateNoteUuidInPrefs(
    { favorites: prefs.favorites, itemOrder: prefs.item_order },
    fromUuid,
    toUuid,
  );
  if (migrated.changed) {
    await Promise.all([
      host.setFavorites(migrated.favorites),
      host.setItemOrder(migrated.itemOrder),
    ]);
  }
}

/**
 * Resolve a note conflict by "take theirs" / "Use this version" (MYND-452): the
 * remote conflict copy wins and the local original is sent to trash.
 *
 * Realized as **promote-the-copy** (no in-place overwrite of the original): the
 * copy's `conflict:` markers are cleared so it becomes the surviving ordinary
 * note, the original's uuid-keyed prefs membership (favorites star + manual
 * `item_order` position) is migrated onto the copy, and the original is
 * tombstoned via the **same routed/propagating path Discard uses** — so the win
 * replicates to other devices and the original is recoverable. The original is
 * trashed only AFTER the copy is safely promoted, so there is no window where
 * both versions are gone.
 */
export async function applyConflictVersion(
  host: ConflictCopyHost,
  copyId: string,
  originalUuid: string,
): Promise<void> {
  // 1. Promote the copy → ordinary surviving note.
  const copyContent = await host.noteRead(copyId);
  // The text this writes was derived from `copyContent`, and with a live session
  // open the read may have come FROM the session, so the same value is the base
  // the write must carry (`myne-md/myne#849`): without it a peer merge that landed
  // between the two is replaced rather than merged.
  await host.noteUpdate(copyId, clearConflictMarkers(copyContent), undefined, copyContent);
  // 2. Carry the original's favorites/item_order membership onto the copy.
  await migratePrefsMembership(host, originalUuid, copyId);
  // 3. Tombstone the original last (recoverable + propagating, like Discard).
  await host.deleteNoteRouted(originalUuid);
}

/**
 * Undo an `applyConflictVersion` take-theirs (MYND-452, the toast's Undo action):
 * reverse all three steps so the conflict re-appears exactly as before —
 * un-tombstone the original, re-mark the promoted copy as a conflict copy, and
 * revert the prefs migration (copy → original). Best-effort like the forward path.
 */
export async function undoConflictVersion(
  host: ConflictCopyHost,
  copyId: string,
  originalUuid: string,
): Promise<void> {
  const [original, copyContent] = await Promise.all([
    host.noteRead(originalUuid),
    host.noteRead(copyId),
  ]);
  await Promise.all([
    host.noteUpdate(
      originalUuid,
      decoder.decode(patchDeletedField(encoder.encode(original), null)),
      undefined,
      original,
    ),
    host.noteUpdate(
      copyId,
      buildConflictCopyContent(copyContent, originalUuid),
      undefined,
      copyContent,
    ),
  ]);
  await migratePrefsMembership(host, copyId, originalUuid);
}
