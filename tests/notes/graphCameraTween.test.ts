// The graph camera's tween, and the JavaScript reduced-motion gate
// (myne-md/myne#727).
//
// Two separate claims are checked here. The first is arithmetic: a tween lands
// on its target, and it interpolates zoom evenly. The second is the one the
// feature actually turns on and the one no CSS rule can supply: a CSS media
// query CANNOT reach canvas animation, so a reduced-motion user would still see
// the graph's camera move unless the renderer consults the preference in
// JavaScript. That is asserted against the renderer's SOURCE, in the same style
// as `tests/a11y/focus-ring.test.ts` reading the stylesheet: the guarantee is
// about a decision existing somewhere specific, and a runtime test cannot see
// it without a real display.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAMERA_TWEEN_MS,
  easeOutCubic,
  tweenTransform,
} from "@myne/editor/host/notes/graphCameraTween";

describe("easeOutCubic", () => {
  it("pins both ends and clamps outside the range", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-5)).toBe(0);
    expect(easeOutCubic(5)).toBe(1);
  });

  it("is past halfway at half time, which is what makes it an ease-OUT", () => {
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
  });
});

describe("tweenTransform", () => {
  const from = { x: 0, y: 0, k: 1 };
  const to = { x: 200, y: -100, k: 4 };

  it("starts at the source and lands exactly on the target", () => {
    expect(tweenTransform(from, to, 0)).toEqual(from);
    expect(tweenTransform(from, to, 1)).toEqual(to);
  });

  it("interpolates zoom GEOMETRICALLY, so the perceived rate is even", () => {
    // The decision this pins: zoom is a ratio, not a distance. At the eased
    // midpoint the geometric answer is 4 ** easeOutCubic(0.5); a linear ramp
    // would be at 1 + 3 * easeOutCubic(0.5), and the eye reads that difference
    // as the zoom slowing down as it arrives.
    const eased = easeOutCubic(0.5);
    const mid = tweenTransform({ x: 0, y: 0, k: 1 }, { x: 0, y: 0, k: 4 }, 0.5);
    expect(mid.k).toBeCloseTo(4 ** eased, 6);
    expect(mid.k).not.toBeCloseTo(1 + 3 * eased, 3);
  });

  it("interpolates pan linearly, so it tracks the target without overshoot", () => {
    const mid = tweenTransform(from, { x: 100, y: 100, k: 1 }, 0.5);
    // easeOutCubic(0.5) = 0.875, so a linear pan is three quarters of the way.
    expect(mid.x).toBeCloseTo(87.5, 6);
    expect(mid.y).toBeCloseTo(87.5, 6);
  });

  it("never overshoots the target on any step", () => {
    for (let i = 0; i <= 10; i += 1) {
      const p = tweenTransform(from, to, i / 10);
      expect(p.k).toBeGreaterThanOrEqual(1);
      expect(p.k).toBeLessThanOrEqual(4);
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(200);
    }
  });

  it("the duration is in the band the design system uses for a noticed move", () => {
    expect(CAMERA_TWEEN_MS).toBeGreaterThanOrEqual(250);
    expect(CAMERA_TWEEN_MS).toBeLessThanOrEqual(350);
  });
});

describe("the reduced-motion gate lives in JavaScript", () => {
  // `process.cwd()` (repo root under vitest), not `import.meta.url`.
  const canvas = readFileSync(
    join(process.cwd(), "editor/src/host/notes/GraphCanvas.tsx"),
    "utf8",
  );

  it("the renderer consults prefers-reduced-motion itself", () => {
    // Without this the tween would animate for a user who asked for no motion,
    // and the GLOBAL CSS rule that zeroes animation cannot help: a canvas is
    // drawn by script, so the media query never reaches it.
    expect(canvas).toContain("(prefers-reduced-motion: reduce)");
  });

  it("and it listens for a change, so toggling the OS setting takes effect", () => {
    // Pinned to the reduced-motion listener specifically: the renderer already
    // has a `change` listener for the colour scheme, so a bare
    // `addEventListener?.("change"` assertion would pass on that one alone.
    expect(canvas).toMatch(/reduceMotion\?\.addEventListener\?\.\("change"/);
  });

  it("the snap path assigns the transform instead of tweening to it", () => {
    // The gate is only real if it SHORT-CIRCUITS. A gate that still ran the
    // tween would animate regardless, and the source assertion above would
    // still pass.
    expect(canvas).toMatch(/reduceMotion[\s\S]{0,400}viewRef\.current =/);
  });
});
