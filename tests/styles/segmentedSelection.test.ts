// The `<Segmented>` selection is legible even when its thumb measures zero.
//
// This is a CSS assertion and it lives in its own file because jsdom does not
// apply an external stylesheet: a component test can see `aria-checked`, and
// cannot see that the rule keyed off it paints anything. The rule is the whole
// mitigation for myne-md/myne#727 — a graph pane mounting before its tab is
// visible measured `offsetWidth` 0, so the selected label took `--accent-on`
// (near-black on the dark themes) over an unpainted segment and the active half
// rendered invisible, with no error anywhere and every test green.
//
// myne-md/myne#773 made the active segment paint its own fill BENEATH the
// sliding thumb, so a measurement failure costs a transition rather than
// legibility. Deleting that one declaration silently reopens the bug, which is
// exactly the class of change nothing else here would notice.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHEET: string = readFileSync(
  fileURLToPath(new URL("../../client-core/src/components.css", import.meta.url)),
  "utf8",
);

/** The declaration body of the first rule whose selector contains `needle`. */
function ruleBody(needle: string): string {
  const at = SHEET.indexOf(needle);
  expect(at, `no rule matching ${needle} in components.css`).toBeGreaterThan(-1);
  const open = SHEET.indexOf("{", at);
  const close = SHEET.indexOf("}", open);
  return SHEET.slice(open + 1, close);
}

describe("the segmented control's selection cannot depend on a measurement", () => {
  it("paints the active segment itself, not only via the thumb", () => {
    const body = ruleBody('.myne-segmented__segment[aria-checked="true"]');
    expect(
      body,
      "the active segment must carry its own accent background: the thumb is " +
        "measured in JS and can be zero-wide, and a segment with --accent-on ink " +
        "over no fill is invisible (myne-md/myne#727)",
    ).toContain("background: var(--accent)");
    expect(body).toContain("color: var(--accent-on)");
  });

  it("keeps the thumb as a glide rather than the only selection paint", () => {
    // If the thumb ever stops being decorative-only the rule above stops being a
    // safety net, so its own fill is pinned too.
    expect(ruleBody(".myne-segmented__thumb")).toContain("background: var(--accent)");
  });

  it("offers a dense variant, so a floating cluster need not fork the component", () => {
    // The graph pane's fork cited a measurement bug AND density. #727 fixed the
    // first; without the second this control gets re-implemented again.
    expect(SHEET).toContain('.myne-segmented[data-size="sm"]');
  });
});
