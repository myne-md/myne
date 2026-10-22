// myne-md/myne#908 item 6 — a truncated tab title reveals itself in place.
//
// The marquee decision and the reduced-motion switch are the two pieces that
// can be held to their rule without layout. The reveal itself is a DOM animation
// and stays manual (a Linux container cannot judge motion quality).

import { describe, expect, it } from "vitest";
import {
  centreScrollLeft,
  marqueeShift,
  prefersReducedMotion,
} from "../../src/notes/components/tabTitleReveal";

describe("marqueeShift", () => {
  it("does not move a title that fits", () => {
    expect(marqueeShift(180, 120)).toBe(0);
    expect(marqueeShift(180, 180)).toBe(0);
  });

  it("ignores a one-pixel measurement wobble", () => {
    expect(marqueeShift(180, 181)).toBe(0);
  });

  it("returns the overflow distance for a truncated title", () => {
    expect(marqueeShift(180, 420)).toBe(240);
  });

  it("stays still when the box has not been measured", () => {
    expect(marqueeShift(0, 420)).toBe(0);
    expect(marqueeShift(Number.NaN, 420)).toBe(0);
  });
});

describe("prefersReducedMotion", () => {
  it("is false when the platform has no preference or no matchMedia", () => {
    expect(prefersReducedMotion(undefined)).toBe(false);
    expect(prefersReducedMotion({ matches: false })).toBe(false);
  });

  it("is true when reduced motion is requested", () => {
    expect(prefersReducedMotion({ matches: true })).toBe(true);
  });
});

// `marqueeTiming` no longer exists: the base branch replaced it with the shared
// `useTitleReveal` hook, which builds the same four phases inline from
// `MARQUEE_PX_PER_MS` and `MARQUEE_HOLD_MS` (constant speed, a long hold at the
// start, a short one at the end, and a return trip). The constants it reads are
// asserted above, and the strip's own behaviour is asserted in
// `TabStrip.test.tsx`.

describe("centreScrollLeft", () => {
  it("puts the tab's middle on the viewport's middle", () => {
    // tab 500px in, 120px wide, 800px viewport → its centre (560) sits at 400.
    expect(centreScrollLeft(500, 120, 800)).toBe(500 - (800 - 120) / 2);
  });

  it("never scrolls before the first tab", () => {
    // The strip's own left edge is 0; a negative offset would show blank space to
    // the left of the first tab, which reads as a broken strip.
    expect(centreScrollLeft(6, 132, 800)).toBe(0);
  });

  it("survives a measurement pass with no layout", () => {
    expect(centreScrollLeft(Number.NaN, 132, 800)).toBe(0);
  });
});
