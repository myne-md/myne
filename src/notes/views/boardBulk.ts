// A lane rename and a multi-card move, as one host-owned action
// (myne-md/myne#922 task 7).
//
// # Why this is the dangerous task, and what makes it safe
//
// A lane rename rewrites one property across every card in the lane. The shape
// that ruins it is the obvious one: N independent writes presented as N actions.
// A user who renames a lane would get N undo steps, and a failure halfway would
// leave the lane half renamed with nothing that puts it back. So:
//
//   - **Every card is one `note_set_field` call, sequentially**, through
//     `bulkSetField` and therefore through the same authority checks a single
//     drag passes. There is no Rust bulk command and no second write path: the
//     vault has no multi-file transaction, so a bulk command could not have
//     offered atomicity either, only a second place to keep four checks correct.
//   - **The whole batch is ONE journal entry**, so one restore returns every note
//     it wrote. The journal is the previous feature's, unchanged in shape.
//   - **The definition change rides in the same entry.** A rename also rewrites
//     the view's declared `lanes`, so the entry carries the definition as it was
//     and the same restore puts it back. Otherwise "restore" would bring back
//     forty cards and leave the lane order renamed, which is a half-restored
//     action wearing the wrong word.
//   - **A partial result is reported per card with its reason**, never rolled back
//     and never summarized into a boolean. The count is derived from the lists.
//
// # The definition is only rewritten when the rename actually happened
//
// Three cases, and the difference matters to whether the board still shows what
// the notes say:
//
// 1. **Cards existed and at least one moved** → rewrite the declaration. The lane
//    is now called something else; the cards that refused keep the old value and
//    show up in a lane the data names.
// 2. **Cards existed and every one refused** → leave the declaration alone. The
//    lane was not renamed, because nothing carries the new name.
// 3. **The lane was empty** → rewrite the declaration. Renaming an empty declared
//    lane is exactly the setup a board is for, and there is no card to disagree.
//
// The rewrite itself is a LOCAL EDIT like any other (`saveLocalViewEdit`), so the
// version moves forward and this device's approval of the new bytes rides along in
// the same prefs write: the person at this device is the one who asked for the
// change. An update that arrives from somewhere else does not follow, which is the
// previous feature's rule and the reason the two paths are distinct.

import type { SavedView } from "../../lib/prefs";
import { bulkSetField, type BulkFieldResult } from "../bulkSetField";
import { saveLocalViewEdit } from "./saveViewEdit";

/** One card the action should move, with the lane value it was rendered in. */
export interface BoardCardLane {
  readonly noteId: string;
  /** `""` is the engine's no-value lane, which means the field is absent. */
  readonly fromLane: string;
}

export interface MoveCardsRequest {
  readonly viewId: string;
  /** The view's `group_by` key: the field the lanes are. */
  readonly field: string;
  readonly toLane: string;
  readonly cards: readonly BoardCardLane[];
}

/**
 * Move every named card to one lane, one note at a time.
 *
 * No definition change: a lane value that was not declared simply appends in
 * first-appearance order, which is the same place it already rendered.
 */
export function moveCardsToLane(
  request: MoveCardsRequest,
): Promise<BulkFieldResult> {
  return bulkSetField({
    viewId: request.viewId,
    field: request.field,
    newValue: request.toLane,
    targets: request.cards.map((card) => ({
      noteId: card.noteId,
      expectedValue: card.fromLane === "" ? null : card.fromLane,
    })),
  });
}

export interface RenameLaneRequest extends MoveCardsRequest {
  /** The lane value being renamed. */
  readonly fromLane: string;
  /** The definition the person is looking at. */
  readonly view: SavedView;
  /** Whether this device has approved `view`'s current version. */
  readonly approved: boolean;
}

export interface RenameLaneResult {
  /** What the notes did, reported per card exactly as a move is. */
  readonly move: BulkFieldResult;
  /** The definition after the `lanes` rewrite, or `null` when the declaration was
   *  not rewritten (nothing moved, or the declaration never named the value). */
  readonly view: SavedView | null;
  /** The `lanes` value the definition should carry, or `null` when unchanged. */
  readonly nextLanes: readonly string[] | null;
  /** The rewrite was attempted and failed: the cards moved, the order did not. */
  readonly definitionFailed: boolean;
}

/**
 * The declared order after renaming `from` to `to`, or `null` when the
 * declaration does not name `from` (in which case there is nothing to rewrite and
 * the lane's position already comes from the data).
 *
 * Every occurrence is replaced, not just the first: the format preserves a
 * repeated value verbatim, and a declaration that named the lane twice would
 * otherwise keep a name no card carries any more.
 */
export function renamedLanes(
  declared: readonly string[] | undefined,
  from: string,
  to: string,
): string[] | null {
  if (declared === undefined || !declared.includes(from)) return null;
  return declared.map((value) => (value === from ? to : value));
}

/** Whether a rename should rewrite the declaration. See the three cases in the
 *  module header; the caller passes what the move actually did. */
export function shouldRewriteLanes(
  move: BulkFieldResult,
  cardCount: number,
): boolean {
  if (cardCount === 0) return true;
  return move.writtenCount > 0;
}

/**
 * Rename a lane: write the new value on every card in it, then rewrite the
 * declaration, as one restorable action.
 */
export async function renameLane(
  request: RenameLaneRequest,
): Promise<RenameLaneResult> {
  const move = await bulkSetField({
    viewId: request.viewId,
    field: request.field,
    newValue: request.toLane,
    targets: request.cards.map((card) => ({
      noteId: card.noteId,
      expectedValue: card.fromLane === "" ? null : card.fromLane,
    })),
    // The definition as it was, so ONE restore puts the declaration back too.
    previousView: request.view,
  });

  const nextLanes = renamedLanes(
    request.view.lanes,
    request.fromLane,
    request.toLane,
  );
  if (
    nextLanes === null ||
    !shouldRewriteLanes(move, request.cards.length)
  ) {
    return { move, view: null, nextLanes: null, definitionFailed: false };
  }

  try {
    const saved = await saveLocalViewEdit(
      request.view,
      { ...request.view, lanes: [...nextLanes] },
      request.approved,
    );
    return { move, view: saved, nextLanes, definitionFailed: false };
  } catch {
    // The cards moved and the order did not. Reported rather than swallowed: a
    // rename that half-happened and says nothing is the shape this task exists to
    // avoid.
    return { move, view: null, nextLanes, definitionFailed: true };
  }
}
