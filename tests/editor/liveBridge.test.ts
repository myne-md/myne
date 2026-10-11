// The remote-change dispatch bridge (epic live-collab, `collab-editor-bridge`
// task 7).
//
// A sync pull merged a peer revision into an open session and handed the pane
// body splices; this file tests the TS half that turns them into ONE
// CodeMirror `ChangeSet` (the local-edit direction is the whole-markdown funnel,
// so there is no transaction-to-splice converter to test here). The Rust side
// owns the offset translation, the body-span clamp and the minimal-splice
// property: `core/src/plugins/live/{apply_local,apply_remote,body_guard}.rs`.

import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { remoteDispatchSpec, splicesToChanges } from "../../editor/src/live-bridge";

describe("splicesToChanges", () => {
  it("builds ONE multi-range ChangeSet from remote splices", () => {
    const st = EditorState.create({ doc: "l1\nl2\nl3\nl4\nl5\n" });
    // Two disjoint edits (as a merged pull's diff_splices would return).
    const changes = splicesToChanges(
      [
        { from: 0, to: 1, insert: "L" },
        { from: 6, to: 7, insert: "L" },
      ],
      st.doc.length,
    );
    let ranges = 0;
    changes.iterChanges(() => {
      ranges += 1;
    });
    expect(ranges).toBe(2);
    // Dispatching the ChangeSet updates the body exactly once to the remote text.
    expect(st.update({ changes }).state.doc.toString()).toBe("L1\nl2\nL3\nl4\nl5\n");
  });
});

describe("remoteDispatchSpec", () => {
  it("keeps the caret AFTER a remote insertion exactly at it (insert-side)", () => {
    const st = EditorState.create({ doc: "abc", selection: EditorSelection.cursor(1) });
    const spec = remoteDispatchSpec(st, [{ from: 1, to: 1, insert: "X" }]);
    const next = st.update(spec).state;
    expect(next.doc.toString()).toBe("aXbc");
    // assoc = 1: the caret rides after the peer's insertion, not before it.
    expect(next.selection.main.head).toBe(2);
  });
});
