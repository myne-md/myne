// @vitest-environment jsdom
//
// The motion page's curve arithmetic (myne-md/myne#847 task 12).
//
// Four numbers are not a shape. The whole point of an easing curve is how it
// leaves and arrives, so the page draws it; this asserts the drawing rather than
// leaving it to an eyeball.

import { describe, expect, it } from "vitest";
import { curvePath } from "../../stories/src/stories/foundations";

describe("the easing curve", () => {
  it("draws a linear curve as a straight line", () => {
    expect(curvePath("cubic-bezier(0, 0, 1, 1)")).toBe("M 0 100 C 0 100, 100 0, 100 0");
  });

  it("flips the y axis, because SVG grows downward and a curve is plotted upward", () => {
    // A control point at y=1 must land at the TOP of the box, not the bottom.
    const path = curvePath("cubic-bezier(0.2, 0, 0, 1)");
    expect(path).toBe("M 0 100 C 20 100, 0 0, 100 0");
  });

  it("accepts a negative control point", () => {
    // An overshoot curve has one, and rejecting it would silently drop a token.
    expect(curvePath("cubic-bezier(0.34, -0.4, 0.2, 1.2)")).toBe(
      "M 0 100 C 34 140, 20 -20, 100 0",
    );
  });

  it("returns null for a value that is not a cubic-bezier", () => {
    // `--ease-spring` upgrades to a `linear()` sampled spring on some engines,
    // which this cannot draw. Saying so beats drawing a wrong curve.
    expect(curvePath("linear(0, 0.5 50%, 1)")).toBeNull();
    expect(curvePath("ease-in-out")).toBeNull();
  });
});
