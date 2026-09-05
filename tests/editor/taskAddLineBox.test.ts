// myne-md/myne#560 then #660: the `+` add-field affordance must contribute
// NOTHING to the line box, in either axis.
//
// It is cursor-gated: it appears the instant the caret lands on a task line and
// disappears when it leaves. Anything it adds to the line box is therefore added
// CONDITIONALLY, and the row changes under the caret. That cost two things, and
// the second is what got reported:
//
//   - CM6's height map gets a line whose height depends on the selection.
//   - `drawSelection` probes each selection's visual row twice, once from each
//     end (`rectanglesForRange` -> `wrappedLine`). When the two probes disagree
//     it paints TWO rectangles over one row, one running to the right edge and
//     one from the left, and a translucent `--selection-bg` doubles where they
//     overlap. That is the "double highlight" over a selected task row.
//
// jsdom has no layout, so this cannot measure a line box. It checks the rule
// that decides one.
//
// # Why the assertions changed shape
//
// The first answer kept the button IN FLOW and cancelled its height with
// negative block margins, and this suite asserted that arithmetic. #660 then
// wrapped it in a `width: 0; height: 0` slot to cancel the width too, and that
// version SHIPPED BROKEN: a zero-height inline-block still establishes an inline
// formatting context whose line box is sized by the inherited `line-height`, so
// the button laid out at its natural position inside it and overflowed roughly
// half a line downward, onto the following row.
//
// The suite did not catch it, and the reason is worth stating: every assertion
// it made was still true. `height` was still `1.35em`, `margin-block` still
// cancelled it, the slot was still zero-size. Arithmetic about a box's margins
// says nothing about where that box RENDERS once its parent has been forced to
// zero height.
//
// Zeroing the slot's height then took the CARET with it, which is the third
// version and the second thing this suite now pins. `drawSelection` draws the
// caret, and `RectangleMarker.forRange` reads its height from
// `coordsAtPos(head, assoc || 1)`. `assoc` is 0 for an ordinary caret, so it
// associates FORWARD, and forward of a caret at the end of a task line is this
// widget: a zero-height box there is a zero-height caret. Typing at the end of a
// task row showed none at all.
//
// So the rule has three parts and no two of them imply the third: the button is
// out of flow, the slot is zero-WIDTH, and the slot keeps a real border box that
// its block margins cancel. Each assertion below names which part it holds, and
// each was chosen because a shipped version failed exactly it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS: string = readFileSync(
  fileURLToPath(new URL("../../editor/src/task-surfaces.css", import.meta.url)),
  "utf8",
);

/** The declaration block for `selector`, from the first rule opening it at or
 *  after `fromIndex`, so the coarse-pointer override is read by the same parser
 *  as the base rule rather than by a second hand-rolled copy of it. */
function block(selector: string, fromIndex = 0): string {
  const at = CSS.indexOf(`${selector} {`, fromIndex);
  expect(at, `no rule for ${selector}`).toBeGreaterThan(-1);
  const open = CSS.indexOf("{", at);
  const close = CSS.indexOf("}", open);
  return CSS.slice(open + 1, close);
}

/** A numeric `em` declaration, or `null` when it is absent or not in `em`. */
function em(decls: string, prop: string): number | null {
  const m = new RegExp(`(?:^|;|\\s)${prop}\\s*:\\s*(-?[\\d.]+)em\\s*(?:;|$)`, "m").exec(decls);
  return m === null ? null : Number(m[1]);
}

describe(".cm-task-add is out of flow, so it cannot contribute a line box", () => {
  it("is absolutely positioned", () => {
    // The whole guarantee rests on this one declaration. An absolutely
    // positioned box is removed from the flow entirely, so it contributes
    // neither width nor height to the line, whatever its own metrics are. Put
    // it back in flow and every symptom of #560 and #660 returns together.
    expect(block(".cm-task-add")).toMatch(/(^|[\s;])position\s*:\s*absolute\s*;/);
  });

  it("carries no block margin, which would offset it off its anchor", () => {
    // The negative `margin-block` that used to cancel the in-flow height is not
    // merely redundant now, it is harmful: margins on an absolutely positioned
    // box shift it away from its `top` anchor, so a leftover would push the `+`
    // back down toward the next row, which is the exact defect being fixed.
    expect(em(block(".cm-task-add"), "margin-block")).toBeNull();
    expect(
      em(block(".cm-task-add", CSS.indexOf("@media (pointer: coarse)")), "margin-block"),
    ).toBeNull();
  });

  it("is centred on the slot's middle, which is the text's middle", () => {
    // `top: 50%` is half the slot's height, and the slot's symmetric negative
    // block margins put that midpoint exactly where `vertical-align: middle`
    // places its zero-height margin box: the parent's baseline plus half its
    // x-height. `translateY(-50%)` then lifts the button by half of ITS height.
    // Every term comes from the browser's font metrics, so this holds at every
    // `--editor-text-size` and `--editor-line-spacing` with no per-size fix, and
    // the coarse-pointer block below inherits it by changing only the size.
    //
    // `top: 0` here is the specific wrong answer: with a slot that now has a
    // real height it anchors to the slot's TOP, half a button above the text.
    const decls = block(".cm-task-add");
    expect(decls).toMatch(/(^|[\s;])top\s*:\s*50%\s*;/);
    expect(decls).toMatch(/transform\s*:\s*translateY\(\s*-50%\s*\)/);
  });

  it("sizes its glyph relatively, or the em metrics track nothing", () => {
    // `em` on width/height resolves against the element's OWN font-size. A
    // `font-size: 15px` here would silently pin the box to 15px whatever the
    // editor's text size is, and `translateY(-50%)` would then centre a box that
    // no longer matches the text around it.
    expect(block(".cm-task-add")).toMatch(/font-size\s*:\s*[\d.]+em/);
  });
});

describe(".cm-task-add-slot adds no width, and no height the line can see", () => {
  it("has zero width, which is the whole of what #660 needed", () => {
    expect(block(".cm-task-add-slot")).toMatch(/(^|[\s;])width\s*:\s*0\s*;/);
  });

  it("keeps a real border box, or the caret drawn against it has no height", () => {
    // `RectangleMarker.forRange` takes an empty range's height straight from
    // `coordsAtPos(head, assoc || 1)`, and `assoc` is 0 for an ordinary caret,
    // so it associates FORWARD. At the end of a task line the thing forward of
    // the caret is this widget, so a zero-height box here draws a caret zero
    // pixels tall and typing at the end of a task row shows no caret at all.
    // That shipped, so it is asserted rather than left to the comment.
    expect(em(block(".cm-task-add-slot"), "height")).toBeGreaterThan(0);
  });

  it("cancels that height with its block margins, so the line box is unchanged", () => {
    // `getBoundingClientRect()` reports the BORDER box (the caret's height),
    // while the line box is laid out from the MARGIN box. The two tests together
    // are the whole rule: a visible caret AND a line that does not grow under
    // it. Either alone is satisfiable by a version that shipped broken.
    const decls = block(".cm-task-add-slot");
    const height = em(decls, "height");
    const margin = em(decls, "margin-block");
    expect(height, "height must be in em so it tracks the editor text size").not.toBeNull();
    expect(margin, "margin-block must be in em, to cancel that height").not.toBeNull();
    expect(height! + 2 * margin!).toBeCloseTo(0, 6);
  });

  it("is the button's containing block", () => {
    // Without `position: relative` here the absolutely positioned button
    // resolves against the nearest positioned ancestor instead, which is
    // somewhere up in the editor chrome, and the `+` leaves the line entirely.
    expect(block(".cm-task-add-slot")).toMatch(/(^|[\s;])position\s*:\s*relative\s*;/);
  });

  it("sits at the text's vertical middle, which is what `top: 50%` anchors to", () => {
    // `vertical-align: middle` places the slot's MARGIN box, which the negative
    // margins have collapsed to a single point, at the baseline plus half the
    // parent's x-height. This declaration is therefore half of the centring
    // above, not decoration: with `baseline` instead, the whole button would
    // hang below the text.
    expect(block(".cm-task-add-slot")).toMatch(/vertical-align\s*:\s*middle/);
  });

  it("does not clip the button it holds", () => {
    expect(block(".cm-task-add-slot")).toMatch(/overflow\s*:\s*visible\s*;/);
  });

  // Non-vacuity: "contributes no geometry" must not be satisfied by an invisible
  // affordance. Every assertion above passes on a `display: none` button.
  it("still holds a button with a visible em-sized box", () => {
    const button = block(".cm-task-add");
    expect(em(button, "width")).toBe(1.35);
    expect(em(button, "height")).toBe(1.35);
    expect(button).not.toMatch(/display\s*:\s*none/);
  });
});
