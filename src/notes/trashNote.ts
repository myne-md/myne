// `trashNote` / `restoreNote` — vault-internal soft-trash (MYND-133).
//
// `trashed:` is the 4th Myne-managed canonical FM field (markdown-dialect
// §3.6.1). Trash/restore are TS orchestrators over the existing `note_update`
// IPC primitive — exactly like `moveNote.ts` rewrites `folder:` (decisions.md
// 2026-05-09 "Frontmatter byte-level surgery owned by TS dialect module").
// There is no backend `note_trash`/`note_restore` command and no ACL change:
// trashing a note keeps the `.myn` on disk and only adds/removes a frontmatter
// field, so it is structurally a note edit.
//
// Unlike `moveNote`, trash/restore do NOT bump `updated:` — moving a note to or
// from the trash is not a content edit, so the user-meaningful "last edited"
// timestamp must not advance. The `trashed:` value itself records *when* the
// note was trashed (surfaced as the Trash panel's relative age).

import { patchArchivedField, patchTrashedField } from "../dialect";
import { flushBeforeFrontmatterWrite } from "./flushBeforeFrontmatterWrite";
import { noteRead } from "./readNote";
import { noteUpdate } from "./updateNote";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Move a note to the vault trash by writing `trashed: <now>` (RFC 3339 UTC)
 * into its frontmatter, clearing any `archived:` first (archive ⊥ trash —
 * deleting an archived note moves it to trash; note-archive / MYND-331 Q2).
 * Idempotent: trashing an already-trashed note simply refreshes the timestamp
 * (state-C replace). The `archived:` clear is a state-D no-op on a note that is
 * not archived (the common case), so a plain live note trashes byte-for-byte as
 * before. Rejects with whatever `noteRead` / `noteUpdate` propagate (IPC error
 * shapes).
 */
export async function trashNote(noteId: string): Promise<void> {
  // Persist any dirty pane FIRST (myne-md/myne#819). Without this a pane
  // holding the pre-trash buffer autosaves `trashed:` back off after the write
  // and the note returns from the trash, still editable. This is the exact
  // losing direction `flushBeforeFrontmatterWrite`'s own roster calls out as
  // worse than a reverted field.
  await flushBeforeFrontmatterWrite();
  const current = await noteRead(noteId);
  // Clear archived first (no-op when absent), then set trashed — keeps the
  // archive ⊥ trash invariant when deleting straight from the Archive view.
  const unarchived = patchArchivedField(encoder.encode(current), null);
  const trashed = patchTrashedField(unarchived, new Date().toISOString());
  await noteUpdate(noteId, decoder.decode(trashed));
}

/**
 * Restore a note from the trash by deleting its `trashed:` field (state D).
 * Pure inverse of {@link trashNote}: the note returns to its verbatim `folder:`
 * path; no other field is touched. No-op-safe on a note that is not trashed
 * (state-D delete is a no-op when `trashed:` is absent). Rejects with whatever
 * `noteRead` / `noteUpdate` propagate.
 */
export async function restoreNote(noteId: string): Promise<void> {
  // Twin of `trashNote`'s flush (myne-md/myne#819): restoring a note that is
  // open and dirty must not race the pane's autosave either.
  await flushBeforeFrontmatterWrite();
  const current = await noteRead(noteId);
  const restored = patchTrashedField(encoder.encode(current), null);
  await noteUpdate(noteId, decoder.decode(restored));
}

/** Outcome of a {@link bulkTrashNotes} call — trashed IDs + per-note failures. */
export interface BulkTrashResult {
  /** Note IDs that were soft-trashed successfully. */
  trashed: string[];
  /** Note IDs that failed, with the propagated IPC error. */
  failed: Array<{ noteId: string; error: unknown }>;
}

/**
 * Soft-trash many notes at once (e.g. every note under a deleted folder). Each
 * note is an independent {@link trashNote} fired via `Promise.allSettled` —
 * trashing is not correctness-critical (mirrors `bulkMoveNotes`, grill
 * 2026-05-29 Q8), so a partial failure is benign: successful trashes stand,
 * failures are reported for a retry. Never rejects; surfaces results via
 * {@link BulkTrashResult}.
 */
export async function bulkTrashNotes(
  noteIds: string[],
): Promise<BulkTrashResult> {
  const settled = await Promise.allSettled(noteIds.map((id) => trashNote(id)));
  const trashed: string[] = [];
  const failed: Array<{ noteId: string; error: unknown }> = [];
  settled.forEach((outcome, i) => {
    const noteId = noteIds[i] ?? "";
    if (outcome.status === "fulfilled") trashed.push(noteId);
    else failed.push({ noteId, error: outcome.reason });
  });
  return { trashed, failed };
}
