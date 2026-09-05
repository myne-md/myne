// myne-md/myne#660, the double highlight, third time filed.
//
// #210 removed the `::selection` rule and it reproduced. #560 rebuilt
// `.cm-task-add`'s vertical metrics and added `isCaretLine`, and it reproduced
// on two gestures neither covered: `Cmd+Shift+←` from a line end, and a
// double-click on a word mid-row.
//
// Three closed issues on one symptom is the argument for asserting the RULE
// rather than eyeballing a screenshot. The `.cm-task-add-slot` geometry half
// lives in `taskAddLineBox.test.ts`, next to the vertical half it completes and
// next to the `block()` helper that reads that stylesheet correctly.

import { describe, expect, it } from "vitest";

import { needsSelectionRemeasure } from "../../editor/src/selection-remeasure";

describe("a selection change that moved the DOM gets a second look", () => {
  const base = {
    selectionSet: false,
    viewportChanged: false,
    geometryChanged: false,
  };

  // Both reported gestures arrive as `selectionSet` alongside a layout change , 
  // the `+` leaving the line, or the `- [ ] ` run becoming source. The
  // predicate cannot distinguish them, which is the point of taking a plain
  // update shape, so they are one case rather than two identical ones.
  it("fires for a selection change that changed the layout", () => {
    expect(
      needsSelectionRemeasure({ ...base, selectionSet: true, geometryChanged: true }),
    ).toBe(true);
  });

  it("fires when the selection change came with a viewport change", () => {
    expect(
      needsSelectionRemeasure({ ...base, selectionSet: true, viewportChanged: true }),
    ).toBe(true);
  });

  // The other direction, which is what keeps this from being a blanket
  // re-measure: `embedded-html.ts` carries an explicit "do NOT call
  // requestMeasure here" because a measure per update runs mid-scroll.
  it("does not fire on a plain caret move with no layout change", () => {
    expect(needsSelectionRemeasure({ ...base, selectionSet: true })).toBe(false);
  });

  it("does not fire on scrolling with no selection change", () => {
    expect(
      needsSelectionRemeasure({ ...base, viewportChanged: true, geometryChanged: true }),
    ).toBe(false);
  });

  it("does not fire on an update that changed nothing", () => {
    expect(needsSelectionRemeasure(base)).toBe(false);
  });
});
