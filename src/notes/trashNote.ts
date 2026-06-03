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

import { patchTrashedField } from "../dialect";
import { noteRead } from "./readNote";
import { noteUpdate } from "./updateNote";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Move a note to the vault trash by writing `trashed: <now>` (RFC 3339 UTC)
 * into its frontmatter. Idempotent: trashing an already-trashed note simply
 * refreshes the timestamp (state-C replace). Rejects with whatever
 * `noteRead` / `noteUpdate` propagate (IPC error shapes).
 */
export async function trashNote(noteId: string): Promise<void> {
  const current = await noteRead(noteId);
  const trashed = patchTrashedField(
    encoder.encode(current),
    new Date().toISOString(),
  );
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
  const current = await noteRead(noteId);
  const restored = patchTrashedField(encoder.encode(current), null);
  await noteUpdate(noteId, decoder.decode(restored));
}
