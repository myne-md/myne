// `emptyTrash` — permanently delete every note currently in the trash
// (MYND-133). A TS orchestrator over `deleteNoteRouted`, mirroring
// `moveNote.ts::bulkMoveNotes`: N independent best-effort `Promise.allSettled`
// deletes, never rejecting, surfacing per-note failures for a remaining-count UI.
//
// **Sync-aware deletion (sync Bug 3 fix).** Each note is removed through
// `deleteNoteRouted`, NOT the bare `note_delete` unlink: when a sync endpoint is
// configured the deletion is a `deleted:`-marker tombstone version that
// PROPAGATES to other devices (and is horizon-GC'd server-side); local-only, it
// is the hard cryptographic-erase unlink. The old bare-unlink path silently
// dropped the blob from this device only — the emptied trash never reached the
// peer, which kept showing the notes despite a "synced" status.
//
// There is no backend `note_empty_trash` command: empty is exactly N
// `deleteNoteRouted` calls, and a restore racing an empty is benign in the Phase
// 1 single-window app (the Trash panel disables its actions during the op; worst
// case a just-restored note is re-deletable). This is the same one-shot
// best-effort + remaining-count posture as bulk move (grill 2026-05-29 Q8 /
// decisions.md 2026-05-26).
//
// The caller (Trash panel) computes `trashedIds` fresh from the trashed set at
// click time — `emptyTrash` does not enumerate; it purges exactly what it is
// handed.

import { deleteNoteRouted } from "./deleteNote";

/** Outcome of an {@link emptyTrash} call — purged IDs + per-note failures. */
export interface EmptyTrashResult {
  /** Note IDs that were permanently deleted. */
  purged: string[];
  /** Note IDs that failed, with the propagated IPC error. */
  failed: Array<{ noteId: string; error: unknown }>;
}

/**
 * Permanently delete each id in `trashedIds` via {@link deleteNoteRouted} — a
 * propagating tombstone under sync, a hard unlink local-only. Each delete is
 * independent (`Promise.allSettled`) — one failure does not abort the rest.
 * Never rejects; surfaces results via {@link EmptyTrashResult} so the UI can
 * report how many notes remain in the trash.
 *
 * Each `deleteNoteRouted` runs its own `flushBeforeFrontmatterWrite`
 * (myne-md/myne#819), so an empty-trash pays N flushes and a single unsettled
 * pane fails all N. That is DELIBERATE: `flushAll` walks every pane, so the
 * property "no permanent delete proceeds while any pane's save is failing" is
 * the safety we want, and N is the size of the user's own trash set. Batching
 * one flush ahead of the loop would drop that property for the panes the batch
 * later touches (a keystroke mid-batch). Kept as-is, and written down here so
 * the next reader does not "optimise" it into a per-batch flush.
 */
export async function emptyTrash(
  trashedIds: string[],
): Promise<EmptyTrashResult> {
  const settled = await Promise.allSettled(
    trashedIds.map((id) => deleteNoteRouted(id)),
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
