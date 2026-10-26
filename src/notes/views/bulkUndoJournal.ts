// The session-scoped journal behind one bulk field action (view-manifests task 10,
// extended by the board's lane rename in myne-md/myne#922 task 7).
//
// WHAT IT IS FOR, AND WHAT IT PROMISES. A bulk field set is N single-note writes,
// each with its own pre-write snapshot (task 5's `note_set_field` returns the id of
// the snapshot it captured). The user sees ONE action, so undoing it must be one
// action too. This journal is what remembers which snapshots belonged together.
//
// **"Restore this action", not "undo", and the difference is honest.** The
// snapshots are the durable part: they live in the note's own history and survive a
// restart. The GROUPING does not, because this journal is memory only. So the
// promise is "the last bulk action is restorable while this session lasts", and the
// copy says exactly that rather than promising an undo that a restart would break.
//
// **It holds ids and nothing else.** No note text, no values, no titles: a note id
// and a snapshot id are references, not content. That is why the journal can be a
// plain module-level array, and why it is still cleared on vault lock: leaving one
// vault must not carry a map of what was touched in it into the next session.

import type { SavedView } from "../../lib/prefs";
//
// ONE action is restorable at a time — the last one. Keeping a stack would offer an
// undo the UI has no surface to express (there is one bar, one button), and a
// deeper history nobody can reach is a lie about what the button does.

/** One note the action wrote, with the snapshot it can be restored from. */
export interface BulkUndoNote {
  readonly noteId: string;
  /** `null` when the host captured no snapshot: the coalescing window skipped it,
   *  or the note is a CRDT note, whose change graph is its own history. */
  readonly snapshotId: string | null;
}

/** One completed bulk action. */
export interface BulkUndoAction {
  readonly actionId: string;
  readonly viewId: string;
  readonly field: string;
  /** Every note the action wrote, in the order it wrote them. */
  readonly notes: readonly BulkUndoNote[];
  /**
   * The view DEFINITION as it was before the action, when the action changed it.
   *
   * Only a lane rename does (it rewrites `lanes`), and it is here because the
   * one-action promise has to cover the definition too: a rename that moved
   * forty cards and left the lane order renamed would be a half-restored action,
   * which is the shape the journal exists to prevent. `undefined` for every
   * action that only wrote notes.
   */
  readonly previousView?: SavedView;
}

/** Whether one restore could put anything back. A rename whose notes were all
 *  CRDT notes still has a definition to restore, which is why the snapshots are
 *  not the only answer. */
export function canRestoreAction(action: BulkUndoAction): boolean {
  return (
    action.previousView !== undefined ||
    action.notes.some((note) => note.snapshotId !== null)
  );
}

let last: BulkUndoAction | null = null;

/** Record the action that just completed. The previous one stops being
 *  restorable, which is the documented limit rather than an oversight. */
export function recordBulkAction(action: BulkUndoAction): void {
  last = {
    ...action,
    notes: action.notes.map((n) => ({ noteId: n.noteId, snapshotId: n.snapshotId })),
  };
}

/** The action one restore would restore, or `null`. */
export function lastBulkAction(): BulkUndoAction | null {
  return last;
}

/** Drop it, for any reason: a successful restore, a failed one the user is done
 *  with, or a vault leaving. */
export function clearBulkUndo(): void {
  last = null;
}

/**
 * The lock and vault-switch variant.
 *
 * Same body as {@link clearBulkUndo}, and named separately on purpose: the two
 * moments are different facts (an action was restored, a vault is going away), and
 * a single name is how a store ends up cleared on one and not the other with every
 * gate green. `scripts/check-frontend-lock-teardown.mjs` names this function and
 * asserts it on every path that ends a vault session.
 */
export function clearBulkUndoForLock(): void {
  last = null;
}
