// myne-md/myne#560: the `+` add-field affordance must contribute NOTHING to the
// line box.
//
// It is cursor-gated: it appears the instant the caret lands on a task line and
// disappears when it leaves. Anything it adds to the line box is therefore added
// CONDITIONALLY, and the row changes height under the caret. That cost two
// things, and the second is what got reported:
//
//   - CM6's height map gets a line whose height depends on the selection.
//   - `drawSelection` probes each selection's visual row twice, once from each
//     end. When the two probes disagree it paints TWO rectangles over one row,
//     one running to the right edge and one from the left, and a translucent
//     `--selection-bg` doubles where they overlap. That is the "double
//     highlight" over a selected task row.
//
// jsdom has no layout, so this cannot measure a line box. It checks the
// arithmetic that decides one: a box whose block margins cancel its own height
// has a zero-height margin box and contributes nothing, at ANY font size,
// which is the point of expressing all three in `em`. A px box that merely
// happens to fit at the default typography would grow the line again the moment
// the user picks the small text size or the tight line spacing.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CSS = readFileSync(
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

describe(".cm-task-add is line-box neutral", () => {
  it("cancels its own height with its block margins", () => {
    const decls = block(".cm-task-add");
    const height = em(decls, "height");
    const margin = em(decls, "margin-block");
    expect(height, "height must be in em so it tracks the editor text size").not.toBeNull();
    expect(margin, "margin-block must be in em, to cancel that height").not.toBeNull();
    // margin box = height + top margin + bottom margin
    expect(height! + 2 * margin!).toBeCloseTo(0, 6);
  });

  it("does not sit ON the baseline, where its full height lands above it", () => {
    // `vertical-align: baseline` on a tall inline-flex box is what made the row
    // grow in the first place: the whole box counts as above-baseline height.
    expect(block(".cm-task-add")).toMatch(/vertical-align\s*:\s*middle/);
  });

  it("keeps the same property on the coarse-pointer size bump", () => {
    // The touch target is larger, so an uncancelled box there would grow the
    // line by MORE, not less.
    const decls = block(".cm-task-add", CSS.indexOf("@media (pointer: coarse)"));
    const height = em(decls, "height");
    const margin = em(decls, "margin-block");
    expect(height).not.toBeNull();
    expect(margin).not.toBeNull();
    expect(height! + 2 * margin!).toBeCloseTo(0, 6);
  });

  it("sizes its glyph relatively, or the em metrics above track nothing", () => {
    // `em` on width/height/margin resolves against the element's OWN font-size.
    // A `font-size: 15px` here would silently pin the box to 15px whatever the
    // editor's text size is, and the first test would still pass.
    expect(block(".cm-task-add")).toMatch(/font-size\s*:\s*[\d.]+em/);
  });
});

// myne-md/myne#660, the horizontal half of the same rule, which #560 named and
// deferred in its own comment: "the box below still contributes inline WIDTH
// when the caret arrives, so on a row near the wrap width it can still force a
// wrap … taking the widget out of flow would close that".
//
// It did not close it, and the double highlight came back on `Cmd+Shift+←` and
// on a double-click. The `+` now lives in a zero-size slot, so a line measures
// identically whether or not the widget is in the DOM, which is what stops its
// arrival and departure moving a wrap point mid-measure.
describe(".cm-task-add-slot takes the widget out of flow in BOTH axes", () => {
  it("has zero width and zero height", () => {
    const rule = block(".cm-task-add-slot");
    expect(rule).toMatch(/(^|[\s;])width\s*:\s*0\s*;/);
    expect(rule).toMatch(/(^|[\s;])height\s*:\s*0\s*;/);
  });

  it("does not clip the button it holds", () => {
    expect(block(".cm-task-add-slot")).toMatch(/overflow\s*:\s*visible\s*;/);
  });

  // Non-vacuity: "contributes no geometry" must not be satisfied by an
  // invisible affordance. The button inside still has a real box, in `em`, for
  // the reason the suite above spends four tests on.
  it("still holds a button with a visible em-sized box", () => {
    const button = block(".cm-task-add");
    expect(em(button, "width")).toBe(1.35);
    expect(em(button, "height")).toBe(1.35);
  });
});
