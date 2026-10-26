// The board's drag decisions (myne-md/myne#922 task 5). Pure: no DOM, no IPC.
//
// What matters here is not that a card appears to move. It is the three rules
// the board's correctness rests on: a press only becomes a drag after the
// pointer travels (so the card's click still opens a note), a drop names a LANE
// VALUE (so the same gesture means the same thing after somebody else's edit),
// and a refusal removes the optimistic placement rather than leaving the board
// showing a lane the note does not have.

import { describe, expect, it } from "vitest";
import {
  applyOptimistic,
  adjacentLane,
  asRefusal,
  boardDragReducer,
  dropDecision,
  initialBoardDragState,
  laneOf,
  type BoardDragState,
  type PendingDrop,
} from "../../src/notes/views/boardDrag";
import type { BoardLane } from "../../src/notes/views/lanes";
import type { ViewRow } from "../../src/notes/queryEngine";

function row(noteId: string, title = noteId): ViewRow {
  return { noteId, title, folder: null, values: {} };
}

const LANES: BoardLane[] = [
  { value: "Backlog", rows: [row("n1", "Pick a name")] },
  { value: "Doing", rows: [row("n2", "Draft the guide")] },
  { value: "Done", rows: [] },
];

/** A state with the pointer past the threshold on `n2`, which lives in Doing. */
function dragging(): BoardDragState {
  let state = boardDragReducer(initialBoardDragState, {
    type: "arm",
    noteId: "n2",
    fromLane: "Doing",
    x: 10,
    y: 10,
  });
  state = boardDragReducer(state, { type: "move", x: 40, y: 10 });
  return state;
}

describe("the press becomes a drag only past the threshold", () => {
  it("keeps a small movement as a press, so the card's click still opens the note", () => {
    let state = boardDragReducer(initialBoardDragState, {
      type: "arm",
      noteId: "n2",
      fromLane: "Doing",
      x: 10,
      y: 10,
    });
    // One pixel of jitter: a normal click on a card.
    state = boardDragReducer(state, { type: "move", x: 11, y: 11 });
    expect(state.dragging).toBeNull();
    expect(state.armed?.noteId).toBe("n2");
  });

  it("turns the same press into a drag once the pointer has travelled", () => {
    const state = dragging();
    expect(state.armed).toBeNull();
    expect(state.dragging).toMatchObject({ noteId: "n2", fromLane: "Doing" });
  });

  it("cancels a gesture that was never a drag", () => {
    let state = boardDragReducer(initialBoardDragState, {
      type: "arm",
      noteId: "n2",
      fromLane: "Doing",
      x: 10,
      y: 10,
    });
    state = boardDragReducer(state, { type: "cancel" });
    expect(state).toEqual(initialBoardDragState);
  });
});

describe("a drop target is a lane value", () => {
  it("asks for a move when the lane differs from the one rendered", () => {
    const state = boardDragReducer(dragging(), { type: "over", lane: "Done" });
    expect(dropDecision(state, "Done")).toEqual({
      noteId: "n2",
      fromLane: "Doing",
      toLane: "Done",
    });
  });

  it("refuses to move a card onto the lane it already occupies", () => {
    let state = boardDragReducer(dragging(), { type: "over", lane: "Backlog" });
    state = boardDragReducer(state, { type: "over", lane: "Doing" });
    // Re-entering the origin lane clears the highlight rather than pretending it
    // is a drop target…
    expect(state.hoverLane).toBeNull();
    // …and a release there is not a move, so nothing is written.
    expect(dropDecision(state, "Doing")).toBeNull();
  });

  it("has no decision while the pointer is between lanes", () => {
    const state = boardDragReducer(dragging(), { type: "over", lane: "Done" });
    expect(dropDecision(state, null)).toBeNull();
  });
});

describe("the optimistic placement", () => {
  const pending: PendingDrop = { noteId: "n2", fromLane: "Doing", toLane: "Done" };

  it("renders the card in the lane it was dropped on and nowhere else", () => {
    const placed = applyOptimistic(LANES, pending);
    expect(placed.find((lane) => lane.value === "Doing")?.rows).toEqual([]);
    expect(placed.find((lane) => lane.value === "Done")?.rows.map((r) => r.noteId)).toEqual([
      "n2",
    ]);
    // The lanes themselves are untouched: a board's lanes are declared, so a
    // placement may not add or remove one.
    expect(placed.map((lane) => lane.value)).toEqual(["Backlog", "Doing", "Done"]);
  });

  it("never invents a row the result does not carry", () => {
    const placed = applyOptimistic(LANES, {
      noteId: "gone",
      fromLane: "Doing",
      toLane: "Done",
    });
    expect(placed).toEqual(LANES);
  });

  it("stops applying the moment the host refuses", () => {
    let state = boardDragReducer(dragging(), { type: "over", lane: "Done" });
    state = boardDragReducer(state, { type: "drop", lane: "Done" });
    expect(state.pending).toEqual(pending);

    state = boardDragReducer(state, {
      type: "refused",
      reason: { kind: "FieldChanged" },
    });
    expect(state.pending).toBeNull();
    expect(state.refusal).toMatchObject({
      noteId: "n2",
      // The lane the card is back IN, not the one it was dropped on: the line
      // this feeds says where the card went, and a refusal returns it.
      fromLane: "Doing",
      reason: { kind: "FieldChanged" },
    });
    // …so the board renders the data again, which is where the note still is.
    expect(applyOptimistic(LANES, state.pending)).toEqual(LANES);
  });

  it("ends when the data has moved the note", () => {
    let state = boardDragReducer(dragging(), { type: "over", lane: "Done" });
    state = boardDragReducer(state, { type: "drop", lane: "Done" });
    state = boardDragReducer(state, { type: "landed" });
    expect(state.pending).toBeNull();
  });

  it("is cleared by a new gesture rather than carrying a stale placement", () => {
    let state = boardDragReducer(dragging(), { type: "over", lane: "Done" });
    state = boardDragReducer(state, { type: "drop", lane: "Done" });
    state = boardDragReducer(state, {
      type: "arm",
      noteId: "n1",
      fromLane: "Backlog",
      x: 0,
      y: 0,
    });
    expect(state.pending).toBeNull();
  });
});

describe("the keyboard path", () => {
  it("places the card exactly as a drop does", () => {
    const state = boardDragReducer(initialBoardDragState, {
      type: "keyboard-drop",
      noteId: "n2",
      fromLane: "Doing",
      toLane: "Done",
    });
    expect(state.pending).toEqual({
      noteId: "n2",
      fromLane: "Doing",
      toLane: "Done",
    });
  });

  it("walks the lane order and stops at both ends", () => {
    expect(adjacentLane(LANES, "Backlog", 1)).toBe("Doing");
    expect(adjacentLane(LANES, "Doing", -1)).toBe("Backlog");
    expect(adjacentLane(LANES, "Backlog", -1)).toBeNull();
    expect(adjacentLane(LANES, "Done", 1)).toBeNull();
  });
});

describe("reading the data", () => {
  it("reports the lane a note is rendered in, or none", () => {
    expect(laneOf(LANES, "n2")).toBe("Doing");
    expect(laneOf(LANES, "nobody")).toBeNull();
  });
});

describe("normalising a rejection", () => {
  it("keeps a host refusal as it arrived", () => {
    expect(asRefusal({ kind: "FieldChanged" })).toEqual({ kind: "FieldChanged" });
  });

  it("turns a transport failure into the residual reason rather than inventing one", () => {
    expect(asRefusal(new Error("ipc down"))).toEqual({
      kind: "Io",
      detail: { io_error_kind: "Other" },
    });
  });
});
