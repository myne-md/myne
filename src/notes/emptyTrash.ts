// `emptyTrash` — permanently delete every note currently in the trash
// (MYND-133). A TS orchestrator over the existing `note_delete` IPC primitive,
// mirroring `moveNote.ts::bulkMoveNotes`: N independent best-effort
// `Promise.allSettled` hard-deletes, never rejecting, surfacing per-note
// failures for a remaining-count UI.
//
// There is no backend `note_empty_trash` command: empty is exactly N
// `note_delete` calls, and a restore racing an empty is benign in the Phase 1
// single-window app (the Trash panel disables its actions during the op; worst
// case a just-restored note is re-deletable). This is the same one-shot
// best-effort + remaining-count posture as bulk move (grill 2026-05-29 Q8 /
// decisions.md 2026-05-26).
//
// The caller (Trash panel) computes `trashedIds` fresh from the trashed set at
// click time — `emptyTrash` does not enumerate; it purges exactly what it is
// handed.

import { noteDelete } from "./deleteNote";

/** Outcome of an {@link emptyTrash} call — purged IDs + per-note failures. */
export interface EmptyTrashResult {
  /** Note IDs that were permanently deleted. */
  purged: string[];
  /** Note IDs that failed, with the propagated IPC error. */
  failed: Array<{ noteId: string; error: unknown }>;
}

/**
 * Permanently delete each id in `trashedIds` via `note_delete`. Each delete is
 * independent (`Promise.allSettled`) — one failure does not abort the rest.
 * Never rejects; surfaces results via {@link EmptyTrashResult} so the UI can
 * report how many notes remain in the trash.
 */
export async function emptyTrash(
  trashedIds: string[],
): Promise<EmptyTrashResult> {
  const settled = await Promise.allSettled(
    trashedIds.map((id) => noteDelete(id)),
  );
  const purged: string[] = [];
  const failed: Array<{ noteId: string; error: unknown }> = [];
  settled.forEach((outcome, i) => {
    const noteId = trashedIds[i] ?? "";
    if (outcome.status === "fulfilled") {
      purged.push(noteId);
    } else {
      failed.push({ noteId, error: outcome.reason });
    }
  });
  return { purged, failed };
}
