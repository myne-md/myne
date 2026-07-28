// Conflict-copy materialization — desktop adapter over the shared
// `@myne/dialect` orchestrators (SYNC-45). The keep-both / take-theirs / undo
// logic lives in `dialect/src/conflictCopy.ts` (shared with mobile); this file
// only constructs the desktop `ConflictCopyHost` from the desktop note/prefs IO
// and re-exports the same public functions, so the ~existing callers
// (useConflictMaterializer, the Conflicts view) are unchanged. Behaviour —
// including the MYND-452 take-theirs + Undo — is identical to before the lift.

import { invoke } from "../platform/core";
import {
  buildConflictCopyContent,
  clearConflictMarkers,
  createConflictCopy as createConflictCopyShared,
  applyConflictVersion as applyConflictVersionShared,
  undoConflictVersion as undoConflictVersionShared,
  type ConflictCopyHost,
} from "../dialect";
import { noteRead } from "./readNote";
import { noteUpdate } from "./updateNote";
import { deleteNoteRouted } from "./deleteNote";
import { prefsRead, setFavorites, setItemOrder } from "../lib/prefs";

/** Desktop note/prefs IO wired into the shared orchestrators. */
const host: ConflictCopyHost = {
  noteRead,
  noteUpdate,
  noteCreate: (plaintext) => invoke<string>("plugin:notes|note_create", { plaintext }),
  deleteNoteRouted,
  prefsRead,
  setFavorites,
  setItemOrder,
};

// Pure helpers pass through unchanged.
export { buildConflictCopyContent, clearConflictMarkers };

/** Materialize a keep-both conflict copy as a new note. */
export function createConflictCopy(remoteBody: string, originalUuid: string): Promise<string> {
  return createConflictCopyShared(host, remoteBody, originalUuid);
}

/** "Take theirs" / "Use this version" (MYND-452): promote the copy, trash the original. */
export function applyConflictVersion(copyId: string, originalUuid: string): Promise<void> {
  return applyConflictVersionShared(host, copyId, originalUuid);
}

/** Undo a take-theirs (MYND-452 toast Undo): reverse all three steps. */
export function undoConflictVersion(copyId: string, originalUuid: string): Promise<void> {
  return undoConflictVersionShared(host, copyId, originalUuid);
}
