// myne-md/myne#908 item 6 — a truncated tab title reveals itself in place.
//
// The marquee decision and the reduced-motion switch are the two pieces that
// can be held to their rule without layout. The reveal itself is a DOM animation
// and stays manual (a Linux container cannot judge motion quality).

import { describe, expect, it } from "vitest";
import {
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
