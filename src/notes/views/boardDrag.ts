// The board's drag, as decisions rather than as DOM (myne-md/myne#922 task 5).
//
// A drag is ONE field write. It calls the host-owned field command with the view
// id, the `group_by` key, the lane value the card was RENDERED in and the lane
// value it was dropped on. That is the whole design, and it is the reason a
// board can be a projection: the precondition is value-anchored, so a change
// anywhere else in the note does not block the drag and a change to that same
// field refuses with a reason. Nothing here rewrites a note, a board file or a
// per-card rank.
//
// Four decisions live in this module, and each is here rather than in the
// component so it can be tested without a DOM:
//
// 1. **A press becomes a drag only after the pointer has travelled.** The card's
//    own click opens its note, and a card that started dragging on `pointerdown`
//    would open a note on every click. `DRAG_THRESHOLD_PX` is that boundary.
// 2. **The drop target is a LANE VALUE, never an index.** An index is a position
//    in a list the data owns, so the same drop would mean a different lane
//    after somebody else's edit. The lanes are values; the write names one.
// 3. **Optimism is a placement, not a write.** `applyOptimistic` moves the
//    rendered card; the note is unchanged until the host says so. A refusal
//    drops the placement, so the card returns to the lane the NOTE reports.
// 4. **A card whose lane value is a LIST does not offer the gesture.** A
//    list-valued `group_by` fans one note across several lanes, and one scalar
//    cannot be the value-anchored precondition for "which of my values am I
//    moving". The table's bulk action excludes the same notes for the same
//    reason; here they simply do not offer the gesture, rather than offering one
//    that must fail.
//
// Pointer events, not mouse events, in the component: the same module has to
// work under a finger on the phone (task 11 owns the device verdict, this owns
// the path). No touch-specific branch is written here, which is why a touch
// device can drive it unchanged.

import type { NoteSetFieldError } from "../../types/note-set-field-error";
import { setNoteField } from "../setNoteField";
import type { ViewRow } from "../queryEngine";
import type { BoardLane } from "./lanes";

/** How far a pointer must travel with the button held before a press is a drag.
 *  A gesture constant rather than a token: it is not a value a theme repaints. */
export const DRAG_THRESHOLD_PX = 4;

/** A card the pointer is on, with the lane it was rendered in. */
export interface DragArm {
  readonly noteId: string;
  readonly fromLane: string;
  readonly startX: number;
  readonly startY: number;
}

/** A drop the board has sent to the host and not yet seen resolved. */
export interface PendingDrop {
  readonly noteId: string;
  readonly fromLane: string;
  readonly toLane: string;
}

/** A drop the host refused, with its own reason.
 *
 *  `fromLane` rather than the drop target, because the line this feeds says
 *  where the card IS: a refusal puts it back in the lane it came from, so naming
 *  the lane it was dropped on told the reader the opposite of what happened
 *  (board-view, found by the E2E). */
export interface DragRefusal {
  readonly noteId: string;
  readonly fromLane: string;
  readonly reason: NoteSetFieldError;
}

export interface BoardDragState {
  /** Pointer down on a card, below the threshold. Not yet a drag. */
  readonly armed: DragArm | null;
  /** Past the threshold: the card is being dragged. */
  readonly dragging: DragArm | null;
  /** The lane under the pointer while dragging, or `null` between lanes. */
  readonly hoverLane: string | null;
  /** The placement the board is showing optimistically. */
  readonly pending: PendingDrop | null;
  /** The last refusal, shown as one line until the next gesture. */
  readonly refusal: DragRefusal | null;
}

export const initialBoardDragState: BoardDragState = {
  armed: null,
  dragging: null,
  hoverLane: null,
  pending: null,
  refusal: null,
};

export type BoardDragAction =
  | { type: "arm"; noteId: string; fromLane: string; x: number; y: number }
  | { type: "move"; x: number; y: number }
  | { type: "over"; lane: string }
  | { type: "cancel" }
  | { type: "drop"; lane: string }
  /** A move the keyboard asked for directly: there is no pointer, so there is no
   *  hover or threshold to pass, and the placement is the same one a drop makes. */
  | { type: "keyboard-drop"; noteId: string; fromLane: string; toLane: string }
  | { type: "landed" }
  | { type: "refused"; reason: NoteSetFieldError };

function moved(arm: DragArm, x: number, y: number): boolean {
  return (
    Math.abs(x - arm.startX) >= DRAG_THRESHOLD_PX ||
    Math.abs(y - arm.startY) >= DRAG_THRESHOLD_PX
  );
}

/**
 * What a release over `lane` would ask the host for, or `null` when the gesture
 * is not a move (not dragging, no lane, or the lane the card came from).
 */
export function dropDecision(
  state: BoardDragState,
  lane: string | null,
): PendingDrop | null {
  const arm = state.dragging;
  if (arm === null || lane === null || lane === arm.fromLane) return null;
  return { noteId: arm.noteId, fromLane: arm.fromLane, toLane: lane };
}

export function boardDragReducer(
  state: BoardDragState,
  action: BoardDragAction,
): BoardDragState {
  switch (action.type) {
    case "arm":
      return {
        ...initialBoardDragState,
        armed: {
          noteId: action.noteId,
          fromLane: action.fromLane,
          startX: action.x,
          startY: action.y,
        },
      };
    case "move": {
      // Below the threshold the press is still a candidate for the card's own
      // click, so nothing about the render changes yet.
      if (state.armed === null) return state;
      if (!moved(state.armed, action.x, action.y)) return state;
      return { ...state, armed: null, dragging: state.armed };
    }
    case "over": {
      if (state.dragging === null) return state;
      // The lane the card came from is not a drop target, and re-entering it
      // clears the highlight rather than pretending it is one.
      const next = action.lane === state.dragging.fromLane ? null : action.lane;
      return next === state.hoverLane ? state : { ...state, hoverLane: next };
    }
    case "cancel":
      return {
        ...initialBoardDragState,
        pending: state.pending,
        refusal: state.refusal,
      };
    case "drop": {
      const decision = dropDecision(state, action.lane);
      return {
        armed: null,
        dragging: null,
        hoverLane: null,
        // A release on the lane the card came from is not a move and does not
        // clear a refusal the reader is still looking at.
        pending: decision ?? state.pending,
        refusal: decision === null ? state.refusal : null,
      };
    }
    case "landed":
      return { ...state, pending: null };
    case "keyboard-drop":
      return {
        armed: null,
        dragging: null,
        hoverLane: null,
        pending: {
          noteId: action.noteId,
          fromLane: action.fromLane,
          toLane: action.toLane,
        },
        refusal: null,
      };
    case "refused":
      // The placement goes away FIRST: the card must be back where the note
      // says it is before the line explaining why appears. The line names the
      // lane it went back TO, which is the one the gesture started in; the drop
      // target is where it did not go, so naming that would report the opposite
      // of what the reader can see.
      return { ...state, pending: null, refusal: {
        noteId: state.pending?.noteId ?? "",
        fromLane: state.pending?.fromLane ?? "",
        reason: action.reason,
      } };
  }
}

/** The lane a note is currently rendered in, or `null` when the result no
 *  longer carries it (filtered out, trashed, or moved away). */
export function laneOf(
  lanes: readonly BoardLane[],
  noteId: string,
): string | null {
  for (const lane of lanes) {
    if (lane.rows.some((row) => row.noteId === noteId)) return lane.value;
  }
  return null;
}

function rowOf(
  lanes: readonly BoardLane[],
  noteId: string,
): ViewRow | undefined {
  for (const lane of lanes) {
    const row = lane.rows.find((r) => r.noteId === noteId);
    if (row !== undefined) return row;
  }
  return undefined;
}

/**
 * The lanes to RENDER while a drop is pending: the card appears in the lane it
 * was dropped on and nowhere else. A pure placement over the data the host last
 * returned, so a refusal simply stops applying it.
 */
export function applyOptimistic(
  lanes: readonly BoardLane[],
  pending: PendingDrop | null,
): BoardLane[] {
  if (pending === null) return [...lanes];
  const row = rowOf(lanes, pending.noteId);
  // The card is not in the result at all: nothing to place optimistically.
  if (row === undefined) return [...lanes];
  return lanes.map((lane) => {
    const without = lane.rows.filter((r) => r.noteId !== pending.noteId);
    if (lane.value !== pending.toLane) {
      return without.length === lane.rows.length ? lane : { ...lane, rows: without };
    }
    return { ...lane, rows: [...without, row] };
  });
}

/**
 * The neighbouring lane's value, for the keyboard path (`Alt+ArrowLeft/Right`).
 * The keyboard is not a lesser way to move a card: a board a keyboard cannot
 * operate is a board half the product cannot use.
 */
export function adjacentLane(
  lanes: readonly BoardLane[],
  from: string,
  delta: -1 | 1,
): string | null {
  const index = lanes.findIndex((lane) => lane.value === from);
  if (index === -1) return null;
  const next = index + delta;
  if (next < 0 || next >= lanes.length) return null;
  return lanes[next]?.value ?? null;
}

/** The write one drop performs. A drop is one command, one field, one note. */
export interface BoardDropRequest {
  readonly viewId: string;
  /** The view's `group_by` key: the field the lanes are. */
  readonly field: string;
  readonly noteId: string;
  /** The value the card was RENDERED with. `""` is the engine's no-value group,
   *  which means the field is absent, so the precondition is `null`. */
  readonly fromLane: string;
  readonly toLane: string;
}

/**
 * Perform one drop. Resolves with the host's snapshot id (or `null` when it
 * captured none) and rejects with a `NoteSetFieldError` when the host refused,
 * which is the caller's cue to put the card back and say why.
 */
export function commitBoardDrop(request: BoardDropRequest): Promise<string | null> {
  return setNoteField({
    noteId: request.noteId,
    viewId: request.viewId,
    field: request.field,
    expectedValue: request.fromLane === "" ? null : request.fromLane,
    newValue: request.toLane,
  }).then((result) => result.snapshotId);
}

/** Normalise an unknown rejection to a host refusal, so the refusal line always
 *  has a reason rather than a blank. */
export function asRefusal(error: unknown): NoteSetFieldError {
  if (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { kind?: unknown }).kind === "string"
  ) {
    return error as NoteSetFieldError;
  }
  return { kind: "Io", detail: { io_error_kind: "Other" } };
}
