// Viewport culling math (Phase B). Pure — exercised without a canvas.

import { describe, it, expect } from "vitest";
import {
  isEdgeVisible,
  isNodeVisible,
  visibleBounds,
  type Bounds,
} from "../../src/notes/graphCulling";

describe("visibleBounds", () => {
  it("identity view maps the canvas box to the same graph box", () => {
    const b = visibleBounds({ x: 0, y: 0, k: 1 }, 800, 600, 0);
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 800, maxY: 600 });
  });

  it("a pan shifts the visible graph box the opposite way", () => {
    // Panning content right by 100px (translate x=100) reveals graph x∈[-100,700].
    const b = visibleBounds({ x: 100, y: 0, k: 1 }, 800, 600, 0);
    expect(b.minX).toBe(-100);
    expect(b.maxX).toBe(700);
  });

  it("zooming in (k>1) narrows the visible graph box", () => {
    const b = visibleBounds({ x: 0, y: 0, k: 2 }, 800, 600, 0);
    expect(b).toEqual({ minX: 0, minY: 0, maxX: 400, maxY: 300 });
  });

  it("margin grows the box on every side", () => {
    const b = visibleBounds({ x: 0, y: 0, k: 1 }, 100, 100, 10);
    expect(b).toEqual({ minX: -10, minY: -10, maxX: 110, maxY: 110 });
  });
});

describe("isNodeVisible / isEdgeVisible", () => {
  const bounds: Bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };

  it("keeps a node inside the box, culls one outside", () => {
    expect(isNodeVisible({ x: 50, y: 50 }, bounds)).toBe(true);
    expect(isNodeVisible({ x: 150, y: 50 }, bounds)).toBe(false);
    expect(isNodeVisible({ x: 50, y: -1 }, bounds)).toBe(false);
  });

  it("includes the boundary (inclusive)", () => {
    expect(isNodeVisible({ x: 0, y: 100 }, bounds)).toBe(true);
  });

  it("keeps an edge with either endpoint inside", () => {
    expect(isEdgeVisible({ x: 50, y: 50 }, { x: 999, y: 999 }, bounds)).toBe(true);
    expect(isEdgeVisible({ x: 999, y: 999 }, { x: 50, y: 50 }, bounds)).toBe(true);
  });

  it("culls an edge with both endpoints outside", () => {
    expect(isEdgeVisible({ x: 200, y: 200 }, { x: 300, y: 300 }, bounds)).toBe(false);
  });
});
