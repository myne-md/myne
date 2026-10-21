// myne-md/myne#908 item 6 — a truncated tab title reveals itself in place.
//
// The marquee decision and the reduced-motion switch are the two pieces that
// can be held to their rule without layout. The reveal itself is a DOM animation
// and stays manual (a Linux container cannot judge motion quality).

import { describe, expect, it } from "vitest";
import {
  centreScrollLeft,
  marqueeShift,
  marqueeTiming,
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

describe("marqueeTiming", () => {
  it("holds, travels, holds and travels back in that order", () => {
    const { frames, duration } = marqueeTiming(90);
    expect(frames).toHaveLength(5);
    // Monotonic offsets, or the browser refuses the keyframe list.
    const offsets = frames.map((f) => f.offset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(offsets[0]).toBe(0);
    expect(offsets[4]).toBe(1);
    // The two holds are the still frames: unchanged transform between 0 -> 1
    // and between 2 -> 3.
    expect(frames[0]!.transform).toBe(frames[1]!.transform);
    expect(frames[2]!.transform).toBe(frames[3]!.transform);
    // And the two moves are the opposite ones.
    expect(frames[1]!.transform).not.toBe(frames[2]!.transform);
    expect(frames[3]!.transform).not.toBe(frames[4]!.transform);
    expect(frames[2]!.transform).toBe("translateX(-90px)");
    expect(duration).toBeGreaterThan(0);
  });

  it("travels at a CONSTANT speed, so a longer title takes proportionally longer", () => {
    // The defect this replaces: a distance-proportional duration with an
    // `ease-in-out` curve, which made every title accelerate through the middle
    // and changed the pace with its length. Here the travel fraction of the
    // cycle is exactly `pause + distance/speed`, so doubling the distance
    // doubles the moving time and leaves the holds untouched.
    const short = marqueeTiming(45);
    const long = marqueeTiming(90);
    const travelOf = (t: ReturnType<typeof marqueeTiming>) =>
      (t.frames[2]!.offset - t.frames[1]!.offset) * t.duration;
    expect(travelOf(long)).toBeCloseTo(travelOf(short) * 2, 0);
    // The start hold is the same wall-clock in both, which is what "constant
    // speed, fixed pauses" means.
    expect(short.frames[1]!.offset * short.duration).toBeCloseTo(
      long.frames[1]!.offset * long.duration,
      0,
    );
  });

  it("waits longer at the start than at the end, and never negatively", () => {
    const { frames, duration } = marqueeTiming(60);
    const startHold = frames[1]!.offset * duration;
    const endHold = (frames[3]!.offset - frames[2]!.offset) * duration;
    expect(startHold).toBeGreaterThan(endHold);
    const zero = marqueeTiming(0);
    expect(zero.frames[2]!.transform).toBe("translateX(-0px)");
  });
});

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
