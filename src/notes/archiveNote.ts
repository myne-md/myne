// `archiveNote` / `unarchiveNote` — vault-internal note archive (note-archive /
// MYND-331).
//
// `archived:` is the 8th Myne-managed canonical FM field (markdown-dialect
// §3.6.1). Archive/unarchive are TS orchestrators over the existing `note_update`
// IPC primitive — exactly like `trashNote.ts` (decisions.md 2026-05-09
// "Frontmatter byte-level surgery owned by TS dialect module"). There is no
// backend command and no ACL change: archiving keeps the `.myn` on disk and only
// adds/removes a frontmatter field, so it is structurally a note edit.
//
// Like trash/restore, archive/unarchive do NOT bump `updated:` — moving a note to
// or from the Archive is not a content edit. The `archived:` value records *when*
// the note was archived (the Archive view sorts on it, newest first).
//
// Archive ⊥ trash (the mutual-exclusion invariant, MYND-331 Q2): a note is at most
// one of `archived` / `trashed`. Archiving clears any `trashed:` here; the inverse
// (deleting an archived note clears `archived:`) lives in `trashNote`. Both clears
// are no-ops when the other field is absent, so the invariant holds from any entry
// point without the UI having to police it.

import { patchArchivedField, patchTrashedField } from "../dialect";
import { flushBeforeFrontmatterWrite } from "./flushBeforeFrontmatterWrite";
import { noteRead } from "./readNote";
import { noteUpdate } from "./updateNote";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * Move a note to the Archive by writing `archived: <now>` (RFC 3339 UTC) into its
 * frontmatter, clearing any `trashed:` first (archive ⊥ trash). Idempotent:
 * archiving an already-archived note refreshes the timestamp (state-C replace).
 * Rejects with whatever `noteRead` / `noteUpdate` propagate (IPC error shapes).
 */
export async function archiveNote(noteId: string): Promise<void> {
  // Persist any dirty pane FIRST (myne-md/myne#819). #825 closes the archived
  // note's tabs on success, and a pane's autosave-on-unmount is itself a writer:
  // without this flush it rewrites the buffer without the just-written
  // `archived:` field and silently un-archives the note.
  await flushBeforeFrontmatterWrite();
  const current = await noteRead(noteId);
  // Clear trashed first (state-D no-op when absent), then set archived — the two
  // patchers touch independent lines, so composing them enforces archive ⊥ trash.
  const untrashed = patchTrashedField(encoder.encode(current), null);
  const archived = patchArchivedField(untrashed, new Date().toISOString());
  await noteUpdate(noteId, decoder.decode(archived));
}

/**
 * Restore a note from the Archive by deleting its `archived:` field (state D).
 * Pure inverse of {@link archiveNote}: the note returns to its verbatim `folder:`
 * path, live; no other field is touched. No-op-safe on a note that is not archived.
 * Rejects with whatever `noteRead` / `noteUpdate` propagate.
 */
export async function unarchiveNote(noteId: string): Promise<void> {
  // Twin of `archiveNote`'s flush (myne-md/myne#819): the Archive panel's
  // Restore re-enters the live tree, and a dirty pane must not race the write.
  await flushBeforeFrontmatterWrite();
  const current = await noteRead(noteId);
  const restored = patchArchivedField(encoder.encode(current), null);
  await noteUpdate(noteId, decoder.decode(restored));
}

/** Outcome of a {@link bulkArchiveNotes} call — archived IDs + per-note failures. */
export interface BulkArchiveResult {
  /** Note IDs that were archived successfully. */
  archived: string[];
  /** Note IDs that failed, with the propagated IPC error. */
  failed: Array<{ noteId: string; error: unknown }>;
}

/** Outcome of a {@link bulkUnarchiveNotes} call — restored IDs + per-note failures. */
export interface BulkUnarchiveResult {
  /** Note IDs that were restored from the Archive successfully. */
  unarchived: string[];
  /** Note IDs that failed, with the propagated IPC error. */
  failed: Array<{ noteId: string; error: unknown }>;
}

/**
 * Archive many notes at once (the bulk-selection "Arşivle N not" action). Each
 * note is an independent {@link archiveNote} fired via `Promise.allSettled` —
 * archiving is not correctness-critical (mirrors `bulkTrashNotes`), so a partial
 * failure is benign: successful archives stand, failures are reported for a retry.
 * Never rejects; surfaces results via {@link BulkArchiveResult}.
 */
export async function bulkArchiveNotes(
  noteIds: string[],
): Promise<BulkArchiveResult> {
  const settled = await Promise.allSettled(
    noteIds.map((id) => archiveNote(id)),
  );
  const archived: string[] = [];
  const failed: Array<{ noteId: string; error: unknown }> = [];
  settled.forEach((outcome, i) => {
    const noteId = noteIds[i] ?? "";
    if (outcome.status === "fulfilled") archived.push(noteId);
    else failed.push({ noteId, error: outcome.reason });
  });
  return { archived, failed };
}

/**
 * Restore many notes from the Archive at once — the bulk operation behind the
 * "disable archiving" settings toggle, which empties the Archive so no note is
 * left inaccessible once its entry points are hidden. Each note is an independent
 * {@link unarchiveNote} fired via `Promise.allSettled`; like {@link bulkArchiveNotes}
 * a partial failure is benign (successful restores stand, failures are reported so
 * the caller can decide whether to still persist the disable flag). Never rejects;
 * surfaces results via {@link BulkUnarchiveResult}.
 */
export async function bulkUnarchiveNotes(
  noteIds: string[],
): Promise<BulkUnarchiveResult> {
  const settled = await Promise.allSettled(
    noteIds.map((id) => unarchiveNote(id)),
  );
  const unarchived: string[] = [];
  const failed: Array<{ noteId: string; error: unknown }> = [];
  settled.forEach((outcome, i) => {
    const noteId = noteIds[i] ?? "";
    if (outcome.status === "fulfilled") unarchived.push(noteId);
    else failed.push({ noteId, error: outcome.reason });
  });
  return { unarchived, failed };
}
