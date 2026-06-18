// @vitest-environment jsdom
//
// Multi-cursor (MYND-306). CM6 supports multiple selections natively; Myne
// turns them on. Two enablement facts under test here, against editor STATE
// (not pixels):
//   - `myneExtensions()` sets `EditorState.allowMultipleSelections` to `true`,
//     so a multi-range selection survives transaction normalization instead of
//     being collapsed back to the primary range;
//   - a single insert transaction applied to a multi-selection state edits at
//     EVERY cursor (the lockstep edit — story 4); and
//   - `simplifySelection`/Escape collapses back to one range (story 6).
//
// `drawSelection()` (the load-bearing paint of secondary cursors, SYNC-3) and
// the `Mod-d` binding (selectNextOccurrence) have their own assertions in
// `multi-cursor.test.ts` (this file) + `keymap.test.ts`.

import { describe, expect, it } from "vitest";
import { EditorSelection, EditorState } from "@codemirror/state";
import { simplifySelection } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { myneExtensions } from "../../src/editor/extensions";
import { selectionCountObserver } from "../../src/editor/selection-count";

function state(doc: string, ranges: { anchor: number; head?: number }[]): EditorState {
  return EditorState.create({
    doc,
    selection: EditorSelection.create(
      ranges.map((r) => EditorSelection.range(r.anchor, r.head ?? r.anchor)),
    ),
    extensions: [myneExtensions()],
  });
}

describe("multi-cursor — allowMultipleSelections facet (MYND-306)", () => {
  it("the editor enables the allowMultipleSelections facet", () => {
    const s = state("alpha beta", [{ anchor: 0 }]);
    expect(s.facet(EditorState.allowMultipleSelections)).toBe(true);
  });

  it("a multi-range selection is preserved (not collapsed to the primary range)", () => {
    // Two empty cursors: one at offset 0, one at offset 6. With the facet ON,
    // both survive; with it OFF, CM6 would normalize to the primary range only.
    const s = state("alpha beta", [{ anchor: 0 }, { anchor: 6 }]);
    expect(s.selection.ranges.length).toBe(2);
    expect(s.selection.ranges.map((r) => r.from)).toEqual([0, 6]);
  });
});

describe("multi-cursor — lockstep editing (story 4)", () => {
  it("an insert transaction applied to a multi-cursor state edits at every cursor", () => {
    // Three cursors at the start of three lines; inserting "x" at each lands
    // three edits in one transaction (the CM6 multi-cursor type primitive).
    const doc = "one\ntwo\nthree";
    const s = state(doc, [{ anchor: 0 }, { anchor: 4 }, { anchor: 8 }]);
    const tr = s.update(
      s.changeByRange((range) => ({
        changes: { from: range.from, insert: "x" },
        range: EditorSelection.cursor(range.from + 1),
      })),
    );
    expect(tr.state.doc.toString()).toBe("xone\nxtwo\nxthree");
    // All three cursors advanced past their inserted char; the later cursors
    // are mapped forward through the inserts that precede them (1, 4+1+1=6,
    // 8+1+1+1=11), so all three ranges remain empty and each sits right after
    // the "x" it inserted.
    expect(tr.state.selection.ranges.every((r) => r.empty)).toBe(true);
    expect(tr.state.selection.ranges.map((r) => r.from)).toEqual([1, 6, 11]);
    for (const r of tr.state.selection.ranges) {
      expect(tr.state.doc.sliceString(r.from - 1, r.from)).toBe("x");
    }
  });

  it("a delete transaction applied to a multi-cursor state deletes at every cursor", () => {
    const doc = "Xone\nXtwo\nXthree";
    const s = state(doc, [{ anchor: 1 }, { anchor: 6 }, { anchor: 11 }]);
    const tr = s.update(
      s.changeByRange((range) => ({
        changes: { from: range.from - 1, to: range.from },
        range: EditorSelection.cursor(range.from - 1),
      })),
    );
    expect(tr.state.doc.toString()).toBe("one\ntwo\nthree");
  });
});

describe("multi-cursor — drawSelection paints cursors (SYNC-3, story 5)", () => {
  it("mounts the drawSelection cursor layer (secondary cursors get painted)", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView({
      state: state("one\ntwo\nthree", [{ anchor: 0 }, { anchor: 4 }]),
      parent: host,
    });
    try {
      // `drawSelection()` renders a `.cm-cursorLayer` (it takes over cursor
      // painting from the browser). Without it the layer is absent and the
      // browser paints only the primary cursor — the load-bearing reason this
      // extension is mounted (PRD Implementation Decisions).
      expect(view.dom.querySelector(".cm-cursorLayer")).not.toBeNull();
    } finally {
      view.destroy();
      host.remove();
    }
  });
});

describe("multi-cursor — collapse to one (story 6)", () => {
  it("simplifySelection (the Escape command) collapses multiple ranges to one", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView({
      state: state("one\ntwo\nthree", [{ anchor: 0 }, { anchor: 4 }, { anchor: 8 }]),
      parent: host,
    });
    try {
      expect(view.state.selection.ranges.length).toBe(3);
      expect(simplifySelection(view)).toBe(true);
      expect(view.state.selection.ranges.length).toBe(1);
    } finally {
      view.destroy();
      host.remove();
    }
  });
});

describe("multi-cursor — selection-count observability (SYNC-8, story 7)", () => {
  it("writes data-selection-count onto the editor DOM and keeps it live", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const view = new EditorView({
      state: EditorState.create({
        doc: "one\ntwo\nthree",
        extensions: [
          EditorState.allowMultipleSelections.of(true),
          selectionCountObserver(),
        ],
      }),
      parent: host,
    });
    try {
      // One cursor at mount.
      expect(view.dom.getAttribute("data-selection-count")).toBe("1");
      // Add two cursors → three ranges.
      view.dispatch({
        selection: EditorSelection.create([
          EditorSelection.cursor(0),
          EditorSelection.cursor(4),
          EditorSelection.cursor(8),
        ]),
      });
      expect(view.dom.getAttribute("data-selection-count")).toBe("3");
      // Collapse back to one.
      view.dispatch({ selection: EditorSelection.cursor(0) });
      expect(view.dom.getAttribute("data-selection-count")).toBe("1");
    } finally {
      view.destroy();
      host.remove();
    }
  });
});
