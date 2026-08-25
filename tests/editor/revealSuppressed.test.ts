// @vitest-environment jsdom
//
// The two suppressors every view-based reveal predicate honours, asserted
// SEPARATELY, because in a real editor they mask each other.
//
// Reading view sets `EditorView.editable.of(false)` as well as
// `readingModeFacet`, and an editor that cannot be typed into is usually also
// not focused, so a suite that drives reading mode through `viewModeExtension`
// exercises the focus clause and learns nothing about the facet. Measured: with
// the facet clause deleted, all 1712 editor tests still passed.
//
// That is not a hypothetical gap. The facet exists precisely because a
// non-editable CM6 view CAN take a selection, which is exactly the reading
// COMPANION mirror `PaneView` renders beside a live editor: click into it and
// it has focus, and only the facet is left holding the "reading view never
// lifts source" contract.

import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  isCaretLine,
  isCursorLine,
  isInsideRange,
  readingModeFacet,
  revealsRange,
} from "@myne/editor/decorations/cursor-aware";

/** A view whose focus is stated rather than inherited from the DOM, so the two
 *  clauses can be varied one at a time. */
function viewWith(reading: boolean, focused: boolean): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc: "one two three",
      selection: { anchor: 4, head: 4 },
      extensions: [readingModeFacet.of(reading)],
    }),
  });
  Object.defineProperty(view, "hasFocus", { get: () => focused });
  return view;
}

const PREDICATES: ReadonlyArray<[string, (v: EditorView) => boolean]> = [
  ["isCursorLine", (v) => isCursorLine(v, 0, 13)],
  ["isInsideRange", (v) => isInsideRange(v, 0, 13)],
  ["revealsRange", (v) => revealsRange(v, 0, 13)],
  ["isCaretLine", (v) => isCaretLine(v, 0, 13)],
];

describe("reveal suppressors, one clause at a time", () => {
  it.each(PREDICATES)("%s reveals in a focused live view", (_n, ask) => {
    // The direction that must hold, or every construct simply stops revealing.
    const view = viewWith(false, true);
    expect(ask(view)).toBe(true);
    view.destroy();
  });

  it.each(PREDICATES)("%s is suppressed by reading view even when FOCUSED", (_n, ask) => {
    const view = viewWith(true, true);
    expect(ask(view)).toBe(false);
    view.destroy();
  });

  it.each(PREDICATES)("%s is suppressed by loss of focus in a live view", (_n, ask) => {
    const view = viewWith(false, false);
    expect(ask(view)).toBe(false);
    view.destroy();
  });
});
