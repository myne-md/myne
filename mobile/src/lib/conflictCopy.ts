// Mobile ConflictCopyHost adapter (MYND-461 / SYNC-11). Constructs the shared
// `@myne/dialect` conflict-copy host from mobile note/prefs IO — the mobile side
// re-implements NONE of the orchestrator logic (it is consumed as source).
// Mirror of the desktop `src/notes/conflictCopy.ts`.

import { noteCreate, noteRead, noteUpdate } from "./notes";
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
  noteCreate,
  // Routed / propagating delete: tombstone the note by patching its managed
  // `deleted:` frontmatter (RFC3339 UTC now) + rewriting it, so the deletion
  // SYNCS to other devices rather than a local-only hard unlink — the mobile
  // mirror of the desktop `deleteNoteRouted` → `patchDeletedField`/`tombstoneNote`.
  deleteNoteRouted: async (uuid) => {
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
  await noteUpdate(copyId, clearConflictMarkers(await noteRead(copyId)));
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
