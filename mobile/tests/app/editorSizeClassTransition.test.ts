// @vitest-environment jsdom
//
// The fold is a remount (myne-md/myne#918).
//
// `EditorFlow` renders the note at different tree positions in the phone layout
// and in the folded band, so a size-class change tears the CodeMirror view down
// and builds a new one. The text survives because it lives in the flow, but the
// instance does not, and with it the scroll offset, the caret and the undo
// history.
//
// The first two are replayed from a snapshot. The third is NOT, and the last
// test here exists to say so in code rather than only in the PRD: a future
// reader who sees "restore" in a name will otherwise assume undo comes back too.

import { describe, expect, it, vi } from "vitest";

import {
  applyCaret,
  snapshotCaret,
  type CaretRestoreTarget,
} from "../../src/app/flows/editor/caretRestore";

/** The members the helper is allowed to touch, and nothing else. */
function fakeView(head: number, length: number, scrollTop: number, hasFocus = false, anchor = head) {
  const dispatch = vi.fn<(spec: { selection: { anchor: number; head: number } }) => void>();
  const focus = vi.fn();
  const view: CaretRestoreTarget = {
    state: { selection: { main: { anchor, head } }, doc: { length } },
    dispatch,
    hasFocus,
    focus,
  };
  const scroller = { scrollTop };
  return { view, dispatch, focus, scroller };
}

describe("snapshotting the caret before a fold", () => {
  it("records the caret, the scroll offset and the note it came from", () => {
    const { view, scroller } = fakeView(42, 200, 380);
    expect(snapshotCaret(view, "note-a", scroller)).toEqual({
      head: 42,
      anchor: 42,
      scrollTop: 380,
      noteId: "note-a",
      focused: false,
    });
  });

  it("records a null note id rather than inventing one", () => {
    const { view, scroller } = fakeView(0, 0, 0);
    expect(snapshotCaret(view, null, scroller).noteId).toBeNull();
  });
});

describe("replaying it onto the rebuilt view", () => {
  it("puts the caret and the scroll offset back", () => {
    const { view, dispatch, scroller } = fakeView(0, 200, 0);
    const applied = applyCaret(view, { head: 42, anchor: 42, scrollTop: 380, noteId: "note-a", focused: false }, "note-a", scroller);
    expect(applied).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ selection: { anchor: 42, head: 42 } });
    expect(scroller.scrollTop).toBe(380);
  });

  it("clamps to the new document when a sync shortened it mid-fold", () => {
    // The two views are normally built from the same buffer, but a sync can land
    // between them, and an out-of-range anchor throws inside CodeMirror.
    const { view, dispatch, scroller } = fakeView(0, 30, 0);
    applyCaret(view, { head: 42, anchor: 42, scrollTop: 380, noteId: "note-a", focused: false }, "note-a", scroller);
    expect(dispatch).toHaveBeenCalledWith({ selection: { anchor: 30, head: 30 } });
  });

  it("refuses a snapshot captured on a different note", () => {
    const { view, dispatch, scroller } = fakeView(0, 200, 0);
    const applied = applyCaret(view, { head: 42, anchor: 42, scrollTop: 380, noteId: "note-a", focused: false }, "note-b", scroller);
    expect(applied).toBe(false);
    expect(dispatch, "another note's caret is not this note's caret").not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(0);
  });

  it("does nothing when there is no snapshot", () => {
    const { view, dispatch, scroller } = fakeView(0, 200, 0);
    expect(applyCaret(view, null, "note-a", scroller)).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("gives the keyboard back only when the editor had it", () => {
    const focused = fakeView(0, 200, 0, true);
    applyCaret(focused.view, { head: 10, anchor: 10, scrollTop: 0, noteId: "note-a", focused: true }, "note-a", focused.scroller);
    expect(focused.focus, "a fold mid-typing must not dismiss the keyboard").toHaveBeenCalledTimes(1);

    const idle = fakeView(0, 200, 0, false);
    applyCaret(idle.view, { head: 10, anchor: 10, scrollTop: 0, noteId: "note-a", focused: false }, "note-a", idle.scroller);
    expect(idle.focus, "and must not raise it when it was closed").not.toHaveBeenCalled();
  });

  it("carries a selection as a selection, rather than collapsing it to the caret", () => {
    const { view, dispatch, scroller } = fakeView(120, 200, 0, false, 40);
    const snap = snapshotCaret(view, "note-a", scroller);
    expect(snap).toMatchObject({ anchor: 40, head: 120 });
    applyCaret(view, snap, "note-a", scroller);
    expect(dispatch).toHaveBeenCalledWith({ selection: { anchor: 40, head: 120 } });
  });

  it("dispatches a selection and nothing else, because the undo history is gone", () => {
    // The assertion the PRD's accepted residue rests on. If a future change adds
    // history restoration it has to edit this test, which is where a reader will
    // find out that today it does not.
    const { view, dispatch, scroller } = fakeView(0, 200, 0);
    applyCaret(view, { head: 10, anchor: 10, scrollTop: 0, noteId: "note-a", focused: false }, "note-a", scroller);
    expect(dispatch.mock.calls).toHaveLength(1);
    expect(Object.keys(dispatch.mock.calls[0][0])).toEqual(["selection"]);
  });
});
