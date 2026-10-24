// `setNoteField` — the caller side of `note_set_field`, the host-owned field
// write a saved view performs.
//
// The AUTHORITY is not here. Which fields a view may write, whether this device
// approved it, and whether the value is still the one the caller looked at are
// decided in `myne-core` (`plugins/notes/commands.rs`), behind one command, for
// every client. This module does the three things a WebView caller owes that
// host write:
//
//   1. **Flush every dirty pane first, INSIDE this writer.** The host does a
//      read-patch-write against disk, and a pane whose autosave is still pending
//      is a second writer of the same bytes. `flushBeforeFrontmatterWrite`
//      rejects rather than clobbering, so a failing save aborts the field write
//      instead of racing it (`src/AGENTS.md`, and myne-md/myne#520 for why the
//      flush lives in the writer rather than in a caller's wrapper).
//   2. **Re-index the note**, because the property index is what a table view
//      reads. The command returns only the snapshot id — deliberately, since the
//      new value is the one the caller asked for and echoing the whole note back
//      would cross IPC with plaintext nobody needs — so the body is read once
//      here and handed to `reindexNoteFromBody`.
//   3. **Announce the write**, so every open pane holding that note re-reads. The
//      host write is out-of-band of any pane's autosave loop; `PaneView` re-reads
//      only on a nonce bump, so without this the editor keeps showing bytes that
//      are no longer on disk and its next autosave writes that stale buffer back
//      over the change. Same shape as `TASK_WRITE_EVENT`, and a window event
//      rather than a prop because the caller is a table view with no route into
//      the pane tree.
//
// A refusal (see `types/note-set-field-error.ts`) rejects with the host's named
// reason and nothing is announced: no bytes changed, so no pane is stale.

import { invoke } from "../platform/core";
import type { NoteSetFieldError } from "../types/note-set-field-error";
import { flushBeforeFrontmatterWrite } from "./flushBeforeFrontmatterWrite";
import { noteRead } from "./readNote";
import { reindexNoteFromBody } from "./vaultIndices";

/**
 * Broadcast after a successful field write so panes showing that note reload.
 *
 * Carries the note id and nothing else: a pane decides for itself whether it
 * holds that note, and each pane keeps its own dirty-buffer guard.
 */
export const NOTE_FIELD_WRITE_EVENT = "myne-note-field-written";

export type NoteFieldWriteDetail = { noteId: string };

/** What one field write asks for. */
export type SetNoteFieldRequest = {
  noteId: string;
  /** The saved view performing the write; it supplies both permissions. */
  viewId: string;
  /** The top-level frontmatter property to replace. */
  field: string;
  /**
   * The value the caller believes is on disk, or `null` when it believes the
   * field is absent. The host refuses with `FieldChanged` when they differ, which
   * is what makes the precondition value-anchored rather than whole-note.
   */
  expectedValue: string | null;
  newValue: string;
};

export type SetNoteFieldResult = {
  /**
   * The pre-write snapshot captured before the overwrite, or `null` when none
   * was (the coalescing window skipped it, or the note is a CRDT note, whose
   * change graph is its own history). A grouped undo restores the notes that
   * have one and reports the rest as not restorable from that action.
   */
  snapshotId: string | null;
};

/**
 * Replace one frontmatter field through the host's view-scoped writer.
 *
 * Resolves with the snapshot id the host captured, if any. Rejects with a
 * `NoteSetFieldError` refusal (nothing written), or with whatever the flush or
 * the re-read threw.
 */
export async function setNoteField(
  request: SetNoteFieldRequest,
): Promise<SetNoteFieldResult> {
  // Before the invoke, not after: the host reads and rewrites disk, and a pane's
  // pending autosave must not land between those two steps.
  await flushBeforeFrontmatterWrite();

  const snapshotId = await invoke<string | null>("plugin:notes|note_set_field", {
    noteId: request.noteId,
    viewId: request.viewId,
    field: request.field,
    expectedValue: request.expectedValue,
    newValue: request.newValue,
  });

  // The index is what a table view re-queries, so it is refreshed before the
  // reload is announced: a pane that reloads and a table that re-runs must both
  // see the new value, and the index is the slower of the two to catch up.
  await reindexNoteFromBody(request.noteId, await noteRead(request.noteId));

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<NoteFieldWriteDetail>(NOTE_FIELD_WRITE_EVENT, {
        detail: { noteId: request.noteId },
      }),
    );
  }

  return { snapshotId };
}

export type { NoteSetFieldError };
