// Which side a portaled menu opens on (myne-md/myne#771).
//
// `<Select>` and `<SearchableSelect>` both anchored their menu below the
// trigger unconditionally. Correct in the middle of a settings panel, wrong
// near the bottom of the window — which is where the AI composer's two
// dropdowns now live, under the input, a few pixels above the status bar. The
// menu opened downward into nothing: two rows visible and the rest past the
// fold, unreachable, because a `position: fixed` portal does not extend the
// page for a scrollbar to appear.
//
// Nothing reported it. The menu renders, the options are in the DOM, every
// test that finds one by testid passes, and axe has no opinion about an
// element drawn below the viewport. A pure function is what lets the rule be
// driven at all: jsdom reports a fixed 768px viewport and computes no layout,
// so a test that could only go through the real `window` would be asserting a
// constant.

import { describe, expect, it } from "vitest";
import { placeMenu } from "../../src/components/primitives/menuPlacement";

/** A trigger `height`px tall whose top is `top`px down the viewport. */
const at = (top: number, height = 28) => ({ top, bottom: top + height });

/** The plain `<Select>`'s `max-height` in `components.css`. */
const CAP = 280;

describe("it opens downward when there is room", () => {
  it("places the menu under a trigger near the top", () => {
    const p = placeMenu(at(100), 800, { cap: CAP });
    expect(p.side).toBe("below");
    expect(p.top).toBe(132);
    expect(p.bottom).toBeUndefined();
  });

  it("bounds it by the room below when the room is the smaller of the two", () => {
    // Without this a menu whose own `max-height` exceeds the space below runs
    // off the bottom while still calling itself "below" — the original defect
    // wearing the correct side.
    const p = placeMenu(at(600), 800, { cap: CAP });
    expect(p.side).toBe("below");
    expect(p.maxHeight).toBe(800 - 628 - 4 - 8);
    expect(p.maxHeight, "the room was not the binding constraint").toBeLessThan(CAP);
  });

  it("does NOT grow to fill the room when there is more of it than the menu wants", () => {
    // The defect the first version of this shipped, and the reason `cap` is a
    // parameter at all: an inline `max-height` overrides the stylesheet, so
    // writing the available space there replaced the 280px rule instead of
    // deferring to it. Near the bottom of a tall window that is ~1200px of room
    // above, and a twenty-item folder list grew to fill nearly the whole screen.
    const p = placeMenu(at(100), 1400, { cap: CAP });
    expect(p.maxHeight).toBe(CAP);
  });
});

describe("it flips upward when there is not", () => {
  it("places the menu above a trigger near the bottom", () => {
    // The reported case: the composer's dropdowns sit ~60px above the bottom.
    const p = placeMenu(at(700), 800, { cap: CAP });
    expect(p.side).toBe("above");
    expect(p.top).toBeUndefined();
    // A CSS `bottom`, measured from the window's bottom edge to the trigger's
    // top. Using `top` with a guessed height would need the height first, and
    // the height is not known until it has rendered.
    expect(p.bottom).toBe(800 - 700 + 4);
  });

  it("bounds it by the room ABOVE, so it does not run off the top instead", () => {
    // Flipping without re-measuring moves the overflow rather than removing
    // it. A trigger 200px down a 400px viewport: 160px below, 188px above, so
    // it flips — and 188 is LESS than the searchable menu's own 320px
    // stylesheet cap, which is exactly the case where returning a side without
    // a height would put the menu off the top edge instead of the bottom.
    const p = placeMenu(at(200), 400, { cap: 320, minBelow: 300 });
    expect(p.side).toBe("above");
    expect(p.maxHeight).toBe(200 - 4 - 8);
    expect(p.maxHeight, "the room did not bind").toBeLessThan(320);
  });
});

describe("it does not flip into something worse", () => {
  it("stays below when below is cramped but above is more cramped", () => {
    // A short window cramps both sides. Flipping to the SMALLER one would be
    // worse for no reason, and "there is not much room below" is not on its
    // own an argument for above.
    const p = placeMenu(at(40), 300, { cap: CAP });
    expect(p.side).toBe("below");
  });

  it("prefers the roomier side once neither can hold the menu", () => {
    const p = placeMenu(at(240), 300, { cap: CAP });
    expect(p.side).toBe("above");
  });
});

describe("it always answers with a height", () => {
  it("never returns a negative one", () => {
    // A trigger scrolled past the viewport's edge yields a negative gap, and a
    // negative `max-height` is an invalid declaration the browser drops — which
    // would silently restore the stylesheet's constant, which is the bug.
    for (const top of [-400, 0, 400, 900, 5000]) {
      const p = placeMenu(at(top), 800, { cap: CAP });
      expect(p.maxHeight, `top=${top}`).toBeGreaterThanOrEqual(0);
    }
  });

  it("sets exactly one of top and bottom, never both", () => {
    // Both would be a stretched menu: `top` plus `bottom` on a fixed element
    // sizes it to the gap, and the `max-height` beside it would then be a cap
    // on a height nobody chose.
    for (const top of [50, 400, 760]) {
      const p = placeMenu(at(top), 800, { cap: CAP });
      expect(
        (p.top === undefined) !== (p.bottom === undefined),
        `top=${top} set neither or both`,
      ).toBe(true);
    }
  });
});

describe("the cap is the menu's own, not one number for every variant", () => {
  // The searchable variant is taller (320 against 280) because it carries a
  // pinned search row above its list. One shared constant here would make one
  // of the two menus wrong by 40px at every size, in a helper whose whole
  // purpose is that the arithmetic is written once.
  it("honours a larger cap", () => {
    expect(placeMenu(at(100), 1400, { cap: 320 }).maxHeight).toBe(320);
  });

  it("honours a smaller one", () => {
    expect(placeMenu(at(100), 1400, { cap: 280 }).maxHeight).toBe(280);
  });
});
