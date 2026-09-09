import { describe, expect, it } from "vitest";
import { clampDetachedGeometry } from "../../src/notes/detachedGeometry";

const PRIMARY = { x: 0, y: 0, width: 1440, height: 900 };
const SECOND = { x: 1440, y: 0, width: 1920, height: 1080 };

describe("clampDetachedGeometry", () => {
  it("keeps a geometry that still overlaps a current display", () => {
    const g = { x: 100, y: 100, width: 700, height: 500 };
    expect(clampDetachedGeometry(g, [PRIMARY, SECOND], PRIMARY)).toEqual(g);
  });

  it("keeps a geometry on a still-connected second monitor", () => {
    const g = { x: 1600, y: 200, width: 800, height: 600 };
    expect(clampDetachedGeometry(g, [PRIMARY, SECOND], PRIMARY)).toEqual(g);
  });

  it("clamps onto the primary when the saved monitor is gone", () => {
    // Saved on the second monitor, which is now unplugged (only PRIMARY left).
    const g = { x: 1600, y: 200, width: 800, height: 600 };
    const out = clampDetachedGeometry(g, [PRIMARY], PRIMARY);
    expect(out.width).toBe(800);
    expect(out.height).toBe(600);
    // Centred within the primary, fully on-screen.
    expect(out.x).toBe(320);
    expect(out.y).toBe(150);
    expect(out.x + out.width).toBeLessThanOrEqual(PRIMARY.width);
    expect(out.y + out.height).toBeLessThanOrEqual(PRIMARY.height);
  });

  it("caps an over-large saved window to the primary and pins it on-screen", () => {
    const g = { x: 5000, y: 5000, width: 3000, height: 2000 };
    const out = clampDetachedGeometry(g, [PRIMARY], PRIMARY);
    expect(out.width).toBe(PRIMARY.width);
    expect(out.height).toBe(PRIMARY.height);
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
  });
});
