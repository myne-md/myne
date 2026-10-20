// Mobile ConflictCopyHost adapter (MYND-461 / SYNC-11). Constructs the shared
// `@myne/dialect` conflict-copy host from mobile note/prefs IO — the mobile side
// re-implements NONE of the orchestrator logic (it is consumed as source).
// Mirror of the desktop `src/notes/conflictCopy.ts`.

import { noteCreate, noteRead, noteUpdate } from "./notes";
import { evictLiveNote } from "./liveNote";
import { readNoteFolder } from "./note-organize";
import { prefsRead as ioPrefsRead, setFavorites, setItemOrder } from "./prefs";
import { patchDeletedField } from "../dialect/surgery";
import {
  applyConflictVersion as applyOrch,
  clearConflictMarkers,
  createConflictCopy as createOrch,
  undoConflictVersion as undoOrch,
  type ConflictCopyHost,
} from "../dialect/conflictCopy";

const host: ConflictCopyHost = {
  noteRead,
  noteUpdate,
  // A conflict copy inherits the source note's folder, which the shared
  // orchestrator does not know about, so the adapter reads it off the body it
  // is about to write. Desktop's `duplicateNote.ts` twin does the same.
  noteCreate: (plaintext: string) =>
    noteCreate(plaintext, readNoteFolder(plaintext) || null),
  // Routed / propagating delete: tombstone the note by patching its managed
  // `deleted:` frontmatter (RFC3339 UTC now) + rewriting it, so the deletion
  // SYNCS to other devices rather than a local-only hard unlink — the mobile
  // mirror of the desktop `deleteNoteRouted` → `patchDeletedField`/`tombstoneNote`.
  deleteNoteRouted: async (uuid) => {
    // Evict the note's LIVE SESSION first, mirroring `mobile/src/lib/notes.ts`
    // and the desktop shim (myne-md/myne#849 review). A live session holds the
    // document and re-writes `<vault>/notes/<id>.myn` on its next flush, so a
    // tombstone written underneath one lands and is then undone by the very next
    // keystroke. Reachable from "use this version", which tombstones the ORIGINAL
    // (`dialect/src/conflictCopy.ts`) while its pane is still open. Evict rather
    // than `closeLiveNote`, because this path holds no hold and a release would
    // spend the pane's (review D7); a failed flush keeps the session, so refuse.
    if (!(await evictLiveNote(uuid))) {
      throw { kind: "LiveSessionOpen", noteId: uuid };
    }
    const body = await noteRead(uuid);
    // `patchDeletedField` operates on bytes; encode in, decode out for the
    // string-based note IO. RFC3339 UTC now = the sync deletion tombstone.
    const patched = patchDeletedField(new TextEncoder().encode(body), new Date().toISOString());
    await noteUpdate(uuid, new TextDecoder().decode(patched));
  },
  prefsRead: async () => {
    const p = await ioPrefsRead();
    return { favorites: p.favorites, item_order: p.item_order };
  },
  setFavorites,
  setItemOrder,
};

export { clearConflictMarkers };

/** Keep the conflict copy as a separate ordinary note (clears its `conflict:` markers). */
export async function keepAsSeparate(copyId: string): Promise<void> {
  // The read is the write's base: with a live session open the read comes from
  // the session, and a `noteUpdate` with no base would replace it.
  const content = await noteRead(copyId);
  await noteUpdate(copyId, clearConflictMarkers(content), undefined, content);
}

/** Discard the conflict copy (routed tombstone — recoverable + propagating). */
export function discardConflict(copyId: string): Promise<void> {
  return host.deleteNoteRouted(copyId);
}

/** "Use this version" (take theirs): promote the copy, tombstone the original. */
export function applyConflictVersion(copyId: string, originalUuid: string): Promise<void> {
  return applyOrch(host, copyId, originalUuid);
}

export function createConflictCopy(remoteBody: string, originalUuid: string): Promise<string> {
  return createOrch(host, remoteBody, originalUuid);
}

export function undoConflictVersion(copyId: string, originalUuid: string): Promise<void> {
  return undoOrch(host, copyId, originalUuid);
}
