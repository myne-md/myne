// The bulk field set, and the one-action restore of what it wrote (view-manifests
// task 10).
//
// # There is no second write path, and that is the design
//
// A bulk edit is N SINGLE-NOTE writes through `note_set_field` (task 5), one after
// another. Every authority check therefore happens once per note, in the host:
// this device's approval, the view's `write_fields`, the value-anchored
// precondition, the reserved-marker refusal. A bulk command would have been a
// second place to keep those checks correct, and the vault has no multi-file
// transaction, so it could not have offered atomicity either.
//
// # Partial failure is reported, never rolled back
//
// The vault cannot write N notes atomically. Pretending otherwise would be a worse
// lie than a count, so what the caller gets back is each note's own outcome: what
// landed, what was refused and WHY, and which written notes have no snapshot to
// restore. The count is DERIVED from those lists rather than tracked alongside
// them, because a parallel counter is a second thing to keep true.
//
// # The restore
//
// One action, restoring the pre-write snapshot of each note it wrote, in REVERSE
// write order. Reverse because that is the order that unwinds a set of nested
// states; in practice the writes are independent, so it is the conservative
// choice rather than a correctness requirement, and it costs nothing.
//
// A lane rename also changes the view DEFINITION (`lanes`), so the action carries
// the definition as it was and the same restore puts it back, with its version
// moved FORWARD and this device's approval riding along. One action, one restore:
// a button that brought back forty cards and left the lane order renamed would be
// a half-restored action wearing the word "restore".
//
// Two rules from `src/AGENTS.md` apply to the restore because it is an out-of-band
// whole-note write:
//
//   - flush first, INSIDE this writer. A pane whose autosave is still pending
//     would otherwise write its stale buffer back over the restored bytes;
//   - announce each restored note, so every open pane re-reads. Same event the
//     field write dispatches: a pane only needs to know "these bytes moved".
//
// # What is NOT restorable, and why it is said out loud
//
// `note_set_field` reports `snapshotId: null` when the snapshot coalescing window
// skipped the write, and for a CRDT note (whose change graph is its own history).
// Those notes were written and cannot be restored from this action, so they come
// back in their own list rather than being silently skipped: a restore that
// quietly does less than it says is the failure this reporting exists to prevent.

import { flushBeforeFrontmatterWrite } from "./flushBeforeFrontmatterWrite";
import { NOTE_FIELD_WRITE_EVENT, setNoteField } from "./setNoteField";
import { noteRead } from "./readNote";
import { reindexNoteFromBody } from "./vaultIndices";
import type { NoteSetFieldError } from "../types/note-set-field-error";
import type { SavedView } from "../lib/prefs";
import { snapshotRestore } from "./snapshots";
import { saveLocalViewEdit } from "./views/saveViewEdit";
import {
  canRestoreAction,
  clearBulkUndo,
  lastBulkAction,
  recordBulkAction,
  type BulkUndoAction,
} from "./views/bulkUndoJournal";

/** One note the action should write, with the value the caller believes is there. */
export interface BulkFieldTarget {
  readonly noteId: string;
  /** The scalar the caller believes the field holds, or `null` when absent. */
  readonly expectedValue: string | null;
}

/** A note the action wrote. */
export interface BulkFieldWritten {
  readonly noteId: string;
  readonly snapshotId: string | null;
}

/** A note the host refused, with its own reason. */
export interface BulkFieldRefused {
  readonly noteId: string;
  readonly reason: NoteSetFieldError;
}

export interface BulkFieldResult {
  /** `null` when nothing landed: a failed action has nothing to restore and does
   *  not become the restorable one. */
  readonly actionId: string | null;
  readonly written: readonly BulkFieldWritten[];
  readonly refused: readonly BulkFieldRefused[];
  /** `written.length`, named so a caller never counts anything itself. */
  readonly writtenCount: number;
  readonly refusedCount: number;
}

export interface BulkFieldRequest {
  readonly viewId: string;
  readonly field: string;
  readonly newValue: string;
  readonly targets: readonly BulkFieldTarget[];
  /**
   * The view definition BEFORE this action, when the action also changes it.
   * A lane rename passes it so one restore puts the declaration back too; every
   * notes-only action leaves it out.
   */
  readonly previousView?: SavedView;
}

function newActionId(): string {
  // The journal only needs an identity for "which action is this", so a plain
  // random id is enough; it never reaches the vault.
  return crypto.randomUUID();
}

/**
 * Set one declared field on every target, one note at a time.
 *
 * Never throws for a per-note refusal: a refusal is one line of the report. It
 * does throw when the batch could not start at all (a flush that refuses), which
 * is the caller's cue that nothing was attempted.
 */
export async function bulkSetField(
  request: BulkFieldRequest,
): Promise<BulkFieldResult> {
  const written: BulkFieldWritten[] = [];
  const refused: BulkFieldRefused[] = [];

  for (const target of request.targets) {
    try {
      const { snapshotId } = await setNoteField({
        noteId: target.noteId,
        viewId: request.viewId,
        field: request.field,
        expectedValue: target.expectedValue,
        newValue: request.newValue,
      });
      written.push({ noteId: target.noteId, snapshotId });
    } catch (err) {
      // A refusal carries `kind`; anything else (a transport failure) is reported
      // as the residual Io rather than invented as a reason the host never gave.
      refused.push({
        noteId: target.noteId,
        reason:
          typeof err === "object" && err !== null && typeof (err as { kind?: unknown }).kind === "string"
            ? (err as NoteSetFieldError)
            : { kind: "Io", detail: { io_error_kind: "Other" } },
      });
    }
  }

  if (written.length === 0) {
    return {
      actionId: null,
      written,
      refused,
      writtenCount: written.length,
      refusedCount: refused.length,
    };
  }

  const actionId = newActionId();
  recordBulkAction({
    actionId,
    viewId: request.viewId,
    field: request.field,
    notes: written.map((w) => ({ noteId: w.noteId, snapshotId: w.snapshotId })),
    ...(request.previousView === undefined
      ? {}
      : { previousView: request.previousView }),
  });

  return {
    actionId,
    written,
    refused,
    writtenCount: written.length,
    refusedCount: refused.length,
  };
}

/** A note a restore could not put back. */
export interface BulkRestoreFailed {
  readonly noteId: string;
  /** Why: the host's refusal, or the fact that no snapshot was captured at all. */
  readonly reason: "notRestorable" | "restoreFailed";
}

export interface BulkRestoreResult {
  readonly restored: readonly string[];
  readonly failed: readonly BulkRestoreFailed[];
  readonly restoredCount: number;
  /** Whether the action's VIEW DEFINITION was put back (a lane rename's `lanes`).
   *  `false` for an action that never changed the definition. */
  readonly viewRestored: boolean;
  /** Whether that definition write was attempted and failed. Never inferred from
   *  `viewRestored === false`: "nothing to restore" and "the restore failed" are
   *  different sentences to a reader. */
  readonly viewRestoreFailed: boolean;
}

/**
 * Restore the last bulk action, in one call.
 *
 * Resolves with what was restored and what was not. The journal entry is dropped
 * either way: the action is no longer "the last bulk action" once the user has
 * acted on it, and a half-restored action re-offered as one button would be a
 * second chance at the same failure.
 *
 * `currentView` is the definition the caller is holding NOW, needed because
 * restoring a definition must move its version FORWARD rather than revive the old
 * number: a revived version would no longer match this device's approval, so the
 * view would come back unapproved and the next query would refuse to run. It is
 * only read when the action changed the definition, which only a lane rename
 * does.
 */
export async function restoreLastBulkAction(
  currentView?: SavedView,
): Promise<BulkRestoreResult> {
  const action: BulkUndoAction | null = lastBulkAction();
  if (action === null) {
    return {
      restored: [],
      failed: [],
      restoredCount: 0,
      viewRestored: false,
      viewRestoreFailed: false,
    };
  }

  // Once, for the batch, and before the first restore: the rule is the writer's,
  // not each note's, and N flushes for one action is N chances to refuse halfway.
  await flushBeforeFrontmatterWrite();

  const restored: string[] = [];
  const failed: BulkRestoreFailed[] = [];

  // Reverse write order. The writes are independent, so this is the conservative
  // unwind rather than a correctness requirement.
  for (let i = action.notes.length - 1; i >= 0; i -= 1) {
    const note = action.notes[i];
    if (note.snapshotId === null) {
      failed.push({ noteId: note.noteId, reason: "notRestorable" });
      continue;
    }
    try {
      await snapshotRestore(note.noteId, note.snapshotId);
    } catch {
      failed.push({ noteId: note.noteId, reason: "restoreFailed" });
      continue;
    }
    // The restored BYTES are not the restored INDEX. A snapshot restore writes
    // the note and announces the pane reload, and the property index is what a
    // table or a board reads, so without this the view keeps showing the values
    // the action wrote until something else reindexes (found by the board's E2E:
    // a restore put the lane back on disk while the board still drew the renamed
    // lane). Same call `setNoteField` makes for the same reason.
    await reindexRestored(note.noteId);
    restored.push(note.noteId);
    announceRestored(note.noteId);
  }

  const previous = action.previousView;
  const canRestoreView = previous !== undefined && currentView !== undefined;
  let viewRestoreFailed = false;
  if (canRestoreView) {
    try {
      // A LOCAL EDIT like any other: the version moves forward and this device's
      // approval rides along, because the person at this device is the one who
      // asked for the restore.
      await saveLocalViewEdit(
        currentView,
        { ...currentView, lanes: previous.lanes },
        true,
      );
    } catch {
      viewRestoreFailed = true;
    }
  }

  clearBulkUndo();
  return {
    restored,
    failed,
    restoredCount: restored.length,
    // "Nothing to restore" is not "restored nothing": a rename's notes may all be
    // CRDT notes while its declaration still came back.
    viewRestored: canRestoreView && !viewRestoreFailed,
    viewRestoreFailed,
  };
}

/** Whether the last action offers anything for one restore to do. Exported so a
 *  caller does not re-derive the rule (and cannot forget the definition half). */
export function lastActionIsRestorable(): boolean {
  const action = lastBulkAction();
  return action !== null && canRestoreAction(action);
}

/**
 * Re-read a restored note into the property index, best effort.
 *
 * A failure here must not be reported as a failed RESTORE: the bytes are back on
 * disk either way, and the worst case is a derived surface showing the old value
 * until the next reconcile. `reindexNoteFromBody` already swallows its own parse
 * and apply failures, so this guard is about the read.
 */
async function reindexRestored(noteId: string): Promise<void> {
  try {
    await reindexNoteFromBody(noteId, await noteRead(noteId));
  } catch {
    /* the restore stands; the index heals on the next reconcile */
  }
}

/** A restore rewrites the whole note out of band of any pane's autosave loop, so
 *  every open pane holding it must re-read. The field write's own event is the
 *  generic "this note's disk bytes moved" signal, and a pane acts on the id alone. */
function announceRestored(noteId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<{ noteId: string }>(NOTE_FIELD_WRITE_EVENT, {
      detail: { noteId },
    }),
  );
}
