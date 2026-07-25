// @vitest-environment jsdom
//
// Task 1 (persistent-editorview, MYND-534) — CMEditor persistent-view swap API.
// Verifies the opt-in `onSwapReady` handle: buildState constructs a note state
// from a doc, applyState swaps it into the ONE live view (captureState reflects
// it), two built states are independent (per-note isolation), and history rides
// the built state (undo reverts a post-swap edit → per-note undo is preserved).

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { CMEditor, type EditorSwapApi } from "../../editor/src/CMEditor";

afterEach(cleanup);

/** Mount a CMEditor and return its live view + swap API. */
function mountEditor(initial: string): { view: EditorView; api: EditorSwapApi } {
  let view: EditorView | null = null;
  let api: EditorSwapApi | null = null;
  render(
    <CMEditor
      value={initial}
      onChange={() => {}}
      onReady={(v) => {
        if (v) view = v;
      }}
      onSwapReady={(a) => {
        if (a) api = a;
      }}
    />,
  );
  if (view === null || api === null) throw new Error("CMEditor did not expose view + swap API");
  return { view, api };
}

describe("CMEditor persistent-view swap API", () => {
  it("buildState constructs a state carrying the given doc", () => {
    const { api } = mountEditor("first");
    const state = api.buildState("hello world");
    expect(state.doc.toString()).toBe("hello world");
  });

  it("applyState swaps the doc into the one live view; captureState reflects it", () => {
    const { view, api } = mountEditor("first");
    expect(view.state.doc.toString()).toBe("first");
    api.applyState(api.buildState("second note body"));
    expect(view.state.doc.toString()).toBe("second note body");
    expect(api.captureState().doc.toString()).toBe("second note body");
  });

  it("built states are independent (per-note isolation)", () => {
    const { api } = mountEditor("first");
    const a = api.buildState("note A");
    const b = api.buildState("note B");
    expect(a.doc.toString()).toBe("note A");
    expect(b.doc.toString()).toBe("note B");
  });

  it("preserves undo history in a swapped-in state (per-note undo)", () => {
    const { view, api } = mountEditor("first");
    api.applyState(api.buildState("base"));
    // Simulate a user edit in this note.
    view.dispatch({ changes: { from: 4, insert: " EDIT" } });
    expect(view.state.doc.toString()).toBe("base EDIT");
    // Undo must revert it — proves the history extension rode the built state.
    undo(view);
    expect(view.state.doc.toString()).toBe("base");
  });
});
