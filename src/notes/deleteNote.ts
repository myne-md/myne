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

import { invoke } from "@tauri-apps/api/core";

/**
 * Hard-delete a `.myn` note. Rejects with a `NoteDeleteError` (see
 * `src/types/note-delete-error.ts`); `NoteNotFound` is strict at IPC,
 * idempotent at UI per `decisions.md` 2026-05-07 "Note delete UX".
 */
export async function noteDelete(noteId: string): Promise<void> {
  await invoke<void>("plugin:notes|note_delete", { noteId });
}

/**
 * Action alias for the IPC primitive — same shape, semantically named
 * after the user-facing verb. Callers in `src/notes/components/` and
 * `Editor.tsx` import this; the alias keeps the action-name vocabulary
 * consistent across the module per the 2026-05-15 MYND-82 grill Q9
 * "Save-handler discipline".
 */
export const deleteNote = noteDelete;
