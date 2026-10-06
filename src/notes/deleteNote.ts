// IPC primitive + action alias for the `note_delete` Tauri command.
//
// Hard-delete a `.myn` note. Cryptographic erase is structural via the
// v0.1 key hierarchy — the file's bytes contain the only on-disk wrapped
// copy of `enc_item_key`, so `unlink` removes both ciphertext and
// item-key in a single operation; without `itemsKey` in RAM the bytes
// remain indistinguishable from random (`decisions.md` 2026-05-07 "Note
// delete cryptographic erase: structural property of v0.1 key
// hierarchy"). Soft-trash + undo are deferred to MYND-133 (v0.2).
//
// UI MUST surface a confirmation modal before calling this — see
// `<DeleteConfirmModal>` (Task 22 of `notes-sidebar-autosave`) for the
// canonical UX envelope.

import { invoke } from "../platform/core";
import { patchDeletedField } from "../dialect";
import { flushBeforeFrontmatterWrite } from "./flushBeforeFrontmatterWrite";
import { noteRead } from "./readNote";
import { noteUpdate } from "./updateNote";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Hard-delete a `.myn` note. Rejects with a `NoteDeleteError` (see
 * `src/types/note-delete-error.ts`); `NoteNotFound` is strict at IPC,
 * idempotent at UI per `decisions.md` 2026-05-07 "Note delete UX".
 */
export async function noteDelete(noteId: string): Promise<void> {
  await invoke<void>("plugin:notes|note_delete", { noteId });
}

/**
 * Tombstone a note under sync (MYND-426 task 1): write a `deleted: <now>`
 * marker (RFC 3339 UTC) into the note's frontmatter via the existing
 * `note_update` IPC — a new version with a fresh `content_nonce` the vault head
 * commits — instead of a bare `unlink`. A bare absence cannot propagate through
 * the blind server (and would risk resurrection); a `deleted`-marked version
 * does. TS orchestrator over `noteRead`/`noteUpdate`, exactly like `archiveNote`.
 */
export async function tombstoneNote(noteId: string): Promise<void> {
  const current = await noteRead(noteId);
  const tombstoned = patchDeletedField(
    encoder.encode(current),
    new Date().toISOString(),
  );
  await noteUpdate(noteId, decoder.decode(tombstoned));
  // Tell the sync engine this new version is a deletion, so the next push sets
  // the server tombstone flag (horizon-GC reclaims the ciphertext after other
  // devices have had time to pull it). Best-effort: the `deleted:` field already
  // propagates the deletion regardless; the flag only governs server reclamation.
  try {
    await invoke("plugin:sync|sync_mark_tombstone", {
      noteIdHex: noteId.replace(/-/g, ""),
    });
  } catch {
    // Sync not configured / command unavailable — the deletion still propagates.
  }
}

/** True when a sync endpoint is configured (the under-sync reroute predicate). */
async function isSyncConfigured(): Promise<boolean> {
  try {
    const cfg = await invoke<{ endpoint_url: string | null }>(
      "plugin:sync|sync_get_endpoint",
    );
    return cfg.endpoint_url != null;
  } catch {
    return false;
  }
}

/**
 * Delete a note, rerouting under sync to a tombstone version (MYND-426 task 1):
 * when a sync endpoint is configured the deletion is a `deleted`-marked version
 * that propagates to other devices; otherwise (local-only) it is the hard
 * cryptographic-erase unlink. `forceTombstone` lets a caller (or test) pick the
 * path explicitly without the endpoint probe.
 */
export async function deleteNoteRouted(
  noteId: string,
  forceTombstone?: boolean,
): Promise<void> {
  // Persist any dirty pane FIRST (myne-md/myne#819): a pane still holding the
  // pre-delete buffer would otherwise autosave the note straight back (the
  // tombstone route writes `deleted:`; the hard route unlinks, and the stale
  // save recreates the file). Same reason and same losing direction as
  // `trashNote`'s flush.
  await flushBeforeFrontmatterWrite();
  const tombstone = forceTombstone ?? (await isSyncConfigured());
  if (tombstone) {
    await tombstoneNote(noteId);
  } else {
    await noteDelete(noteId);
  }
}

/**
 * Action alias for the IPC primitive — same shape, semantically named
 * after the user-facing verb. Callers in `src/notes/components/` and
 * `Editor.tsx` import this; the alias keeps the action-name vocabulary
 * consistent across the module per the 2026-05-15 MYND-82 grill Q9
 * "Save-handler discipline".
 */
export const deleteNote = noteDelete;
