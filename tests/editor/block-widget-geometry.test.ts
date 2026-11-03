// @vitest-environment node
//
// A block widget's spacing may not be a MARGIN (myne-md/myne#990).
//
// # The defect this holds shut
//
// CodeMirror builds its height map from `getBoundingClientRect()`, and a rect
// excludes margins. The attachment cards carried their 3px/10px block rhythm as
// a margin, so every whole-line embed contributed 13px that the map never
// learned about. The error accumulates down the note, so with five images the
// painted content was 37px taller than CodeMirror believed: every coordinate
// below them resolved one to three rows low, a click landed rows away from the
// pointer, a selection's endpoints snapped to rows it had not been dragged over,
// and an arrow-key round trip did not come back.
//
// # Why this is a rule-sheet test and not a rendering test
//
// jsdom has no layout, so it cannot measure the difference; Playwright can, and
// the numbers in the issue come from there. What can be decided without a
// browser is the INVARIANT: no rule that a block widget's own DOM carries may
// express vertical space as a margin, and every card class that still carries
// one (they are legal on the inline form) must be zeroed inside the wrapper that
// replaces it. The second half is the anti-drift half: a new card class with a
// margin is exactly how this bug got shipped once.

import { describe, expect, it } from "vitest";

import { myneThemeSpec } from "../../src/editor/theme";

type Rule = Record<string, string | number>;

const spec = myneThemeSpec as unknown as Record<string, Rule>;

/** The wrapper `decorations/attachment-embed.ts` puts around a whole-line embed.
 *  Its padding is the block rhythm; nothing inside a block widget may repeat it
 *  as a margin. */
const WRAPPER = ".cm-attachment-block";

/** True when the rule adds vertical space through a margin. `margin: "0"` and
 *  the `0 auto` shorthand are neutral and legal (the latter is horizontal). */
function hasVerticalMargin(rule: Rule): boolean {
  const neutral = (value: string): boolean => {
    const parts = value.trim().split(/\s+/);
    if (parts.length === 1) return parts[0] === "0" || parts[0] === "0px";
    const top = parts[0];
    const bottom = parts[2] ?? top;
    return (top === "0" || top === "0px") && (bottom === "0" || bottom === "0px");
  };
  if (typeof rule.margin === "string" && !neutral(rule.margin)) return true;
  for (const key of ["marginTop", "marginBottom"]) {
    const value = rule[key];
    if (typeof value === "string" && value !== "0" && value !== "0px") return true;
  }
  return false;
}

/** True when the rule removes the vertical margin: the `0` shorthand, or BOTH
 *  longhands at zero. One longhand alone is not enough, because a half-zeroed pair is
 *  exactly the drift this file exists to catch. */
function zeroesVerticalMargin(rule: Rule): boolean {
  if (hasVerticalMargin(rule)) return false;
  if (typeof rule.margin === "string" && /^0(px)?$/.test(rule.margin.trim())) return true;
  return ["marginTop", "marginBottom"].every(
    (key) => typeof rule[key] === "string" && /^0(px)?$/.test(String(rule[key]).trim()),
  );
}

/** Direct children of the wrapper whose rule zeroes the vertical margin. */
function zeroedInWrapper(): Set<string> {
  const zeroed = new Set<string>();
  for (const [selector, rule] of Object.entries(spec)) {
    const children = selector
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.startsWith(`${WRAPPER} > `))
      .map((part) => part.slice(`${WRAPPER} > `.length));
    if (children.length === 0) continue;
    if (!zeroesVerticalMargin(rule)) continue;
    for (const child of children) zeroed.add(child);
  }
  return zeroed;
}

describe("block-widget geometry (myne-md/myne#990)", () => {
  it("gives the wrapper its rhythm as padding, never as a margin", () => {
    const wrapper = spec[WRAPPER];
    expect(wrapper, `${WRAPPER} must exist: it is the measured box a block embed is wrapped in`).toBeDefined();
    expect(hasVerticalMargin(wrapper), `${WRAPPER} may not carry a vertical margin`).toBe(false);
    const padding = wrapper.padding ?? "";
    expect(typeof padding, `${WRAPPER} must carry its spacing as padding`).toBe("string");
    // A vertical component, not a horizontal-only shorthand.
    expect(
      String(padding).trim().split(/\s+/).length >= 3,
      `${WRAPPER} padding must set a vertical value: got ${JSON.stringify(padding)}`,
    ).toBe(true);
  });

  it("wraps every attachment widget root, and zeroes the ones that carry a margin", () => {
    // The ROOT classes only, deliberately. A margin on a DESCENDANT of a card is
    // inside the card's own border box, which is the box CodeMirror measures, so
    // it is counted. `.cm-attachment-pdf-page` and the transcript rows are that
    // case and must keep their margins. Only a widget's root lands directly in
    // `.cm-content`, where a margin escapes the measurement.
    //
    // The list is the root class of each attachment widget (`widgets.ts`), and
    // the two assertions are bidirectional: a root may not carry a margin without
    // being zeroed inside the wrapper, and the wrapper may not zero a selector
    // that is not a root. Adding a widget is the moment to revisit both, and the
    // failure names the selector.
    const ROOTS = [
      ".cm-attachment-frame",
      ".cm-attachment-file-card",
      ".cm-attachment-audio",
      ".cm-attachment-tombstone",
    ];
    const zeroed = zeroedInWrapper();
    const withMargin = ROOTS.filter((root) => hasVerticalMargin(spec[root] ?? {}));

    expect(withMargin.length, "no root carries a vertical margin, so is the scan still right?").toBeGreaterThan(0);
    expect(
      withMargin.filter((root) => !zeroed.has(root)),
      [
        `These widget roots carry a vertical margin but are not zeroed inside ${WRAPPER},`,
        "so their BLOCK form contributes height CodeMirror's height map never counts.",
        `Add them to the ${WRAPPER} > … rule in editor/src/theme.ts that sets margin: 0.`,
      ].join(" "),
    ).toEqual([]);
    expect(
      [...zeroed].filter((selector) => !ROOTS.includes(selector)),
      `${WRAPPER} zeroes a selector that is not a widget root, so either the list above is stale or that rule is`,
    ).toEqual([]);
  });

  it("lists the alignment rule above the zeroing rule, because the zeroing rule is more specific", () => {
    // `.cm-attachment-block > .cm-attachment-frame` (0,2,0) beats
    // `.cm-attachment-frame-align-center` (0,1,0). So the zeroing rule may only
    // touch the VERTICAL longhands: a `margin: 0` shorthand there pins every
    // centred or right-aligned block embed to the left edge, silently.
    const zeroing = Object.entries(spec).find(
      ([selector, rule]) =>
        selector.split(",").some((part) => part.trim().startsWith(`${WRAPPER} > `)) && zeroesVerticalMargin(rule),
    );
    expect(zeroing, "the wrapper must zero the vertical margin of its children").toBeDefined();
    const rule = zeroing![1];
    expect(
      rule.margin,
      "a margin shorthand here would override the align classes' horizontal auto margins; use marginTop/marginBottom",
    ).toBeUndefined();
  });

  it("keeps a failure chip clear of the overlay that sits in the frame's corner", () => {
    // The image widget swaps a failed <img> for the tombstone chip inside the
    // embed's frame. The "⋯" menu is absolutely positioned in that frame's
    // top-right corner, so without reserved space it paints over the filename,
    // which is the whole message on that chip.
    const chip = spec[".cm-attachment-frame > .cm-attachment-tombstone"];
    expect(
      chip,
      ".cm-attachment-frame > .cm-attachment-tombstone must exist: a failed embed renders the broken chip inside the frame",
    ).toBeDefined();
    const reserved = String(chip.paddingRight ?? "");
    expect(reserved, "the failure chip must reserve room for the corner overlay").not.toBe("");
    expect(reserved).toContain("--space-6");
  });
});
