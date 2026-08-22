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
import { readNoteId } from "../../editor/src/note-identity";

afterEach(cleanup);

/** Mount a CMEditor and return its live view + swap API. */
function mountEditor(initial: string): { view: EditorView; api: EditorSwapApi } {
  let view: EditorView | null = null;
  let api: EditorSwapApi | null = null;
  render(
    <CMEditor
      noteId={null}
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

  it("the host re-converging on a swapped-in doc is a no-op for the mirror", () => {
    // MYND-534 × myne#167 interop. A swap moves the doc imperatively, outside
    // the controlled `value`; the host then catches up with
    // `setContent(doc)` (PaneView's note-switch path). That re-converge must
    // stay a no-op — it carries no baseline, so it would otherwise be treated
    // as authoritative and re-dispatched over a doc that already holds it.
    let view: EditorView | null = null;
    let api: EditorSwapApi | null = null;
    const onChange = vi.fn();
    const { rerender } = render(
      <CMEditor
        noteId={null}
        value="note A"
        onChange={onChange}
        onReady={(v) => {
          if (v) view = v;
        }}
        onSwapReady={(a) => {
          if (a) api = a;
        }}
      />,
    );
    if (view === null || api === null) throw new Error("no view + swap API");
    const live = view as EditorView;
    const swap = api as EditorSwapApi;

    swap.applyState(swap.buildState("note B"));
    expect(live.state.doc.toString()).toBe("note B");
    onChange.mockClear();

    rerender(<CMEditor noteId={null} value="note B" onChange={onChange} />);

    expect(live.state.doc.toString()).toBe("note B");
    expect(onChange).not.toHaveBeenCalled();
  });
});

// myne-md/myne#520 and myne-md/myne#564. Both of these exist because the
// DELETION TEST answered "nothing": emptying the `noteId` effect's body, and
// deleting the whole post-swap `reapplyCompartments` dispatch, each left the
// full suite green. The wires they cover are the ones the desktop shell depends
// on most, because it keeps ONE view per pane and swaps documents through it.
describe("CMEditor compartments follow the props, not the mount", () => {
  /** Mount with a `noteId` and keep the rerender handle. */
  function mountWithNoteId(noteId: string | null) {
    let view: EditorView | null = null;
    let api: EditorSwapApi | null = null;
    const props = (id: string | null, readOnly = false) => (
      <CMEditor
        noteId={id}
        readOnly={readOnly}
        viewMode={readOnly ? "reading" : "live"}
        value="body"
        onChange={() => {}}
        onReady={(v) => {
          if (v) view = v;
        }}
        onSwapReady={(a) => {
          if (a) api = a;
        }}
      />
    );
    const { rerender } = render(props(noteId));
    if (view === null || api === null) throw new Error("CMEditor exposed no view");
    return { view: view as EditorView, api: api as EditorSwapApi, rerender, props };
  }

  it("seeds the note identity at mount", () => {
    const { view } = mountWithNoteId("note-a");
    expect(readNoteId(view.state)).toBe("note-a");
  });

  it("follows a noteId prop change on the SAME view, which is what a pane does", () => {
    // The whole of myne#520 rests on this: a pane swaps notes through one
    // long-lived view, so a facet seeded only at mount names the first note the
    // pane ever opened for the rest of the session, and the cover banner then
    // asks the host to act on it.
    const { view, rerender, props } = mountWithNoteId("note-a");
    rerender(props("note-b"));
    expect(readNoteId(view.state)).toBe("note-b");
  });

  it("re-applies note identity AND read-only when a CAPTURED state is swapped back in", () => {
    // The real path, and the only one that reaches `reapplyCompartments`: the
    // pane CAPTURES a note's state, the props move on while that note is
    // backgrounded, and the cached state is applied later. `view.setState`
    // resets every compartment to the seed the cached state was built with, so
    // without the re-apply the note comes back carrying the config it left
    // with. A state built FRESH after the prop change cannot show this, because
    // `makeState` seeds it from the current refs, which is why an earlier
    // version of this test passed with the re-apply deleted.
    //
    // Two compartments rather than one: `readOnly` is myne#564's contract for
    // the reading mirror and is invisible to any assertion about the document,
    // and `noteId` is myne#520's.
    const { view, api, rerender, props } = mountWithNoteId("note-a");
    const cached = api.captureState();
    expect(readNoteId(cached)).toBe("note-a");
    expect(cached.readOnly).toBe(false);

    rerender(props("note-b", true));
    api.applyState(cached);

    expect(readNoteId(view.state)).toBe("note-b");
    expect(view.state.readOnly).toBe(true);
  });
});
