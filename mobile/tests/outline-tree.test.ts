// Unit coverage for the mobile outline fold math (port of desktop
// `src/notes/outlineTree.ts`). Pure shape derivation over a flat heading-level
// list + a set of collapsed row indices.

import { describe, expect, it } from "vitest";
import { computeOutlineMeta } from "../src/lib/outlineTree";

describe("computeOutlineMeta", () => {
  // H1 > H2 > H3, then H2, then H1 — a small tree.
  const levels = [1, 2, 3, 2, 1];

  it("flags hasChildren when the next heading is deeper", () => {
    const meta = computeOutlineMeta(levels, new Set());
    expect(meta.map((m) => m.hasChildren)).toEqual([true, true, false, false, false]);
    expect(meta.every((m) => !m.hidden)).toBe(true);
  });

  it("hides the whole section under a collapsed heading", () => {
    // Collapse row 0 (the first H1): rows 1..3 (deeper) hide; row 4 (H1) ends it.
    const meta = computeOutlineMeta(levels, new Set([0]));
    expect(meta.map((m) => m.hidden)).toEqual([false, true, true, true, false]);
    expect(meta[1]!.collapsedUnder).toBe(0);
    expect(meta[3]!.collapsedUnder).toBe(0);
  });

  it("collapses an inner section only", () => {
    // Collapse row 1 (the H2): only row 2 (H3) hides; row 3 (H2) ends it.
    const meta = computeOutlineMeta(levels, new Set([1]));
    expect(meta.map((m) => m.hidden)).toEqual([false, false, true, false, false]);
  });

  it("an outer collapse subsumes inner collapsed parents", () => {
    // Collapsing both the H1 and the H2 still hides everything under the H1.
    const meta = computeOutlineMeta(levels, new Set([0, 1]));
    expect(meta.map((m) => m.hidden)).toEqual([false, true, true, true, false]);
  });

  it("a collapse on a leaf (no children) hides nothing", () => {
    const meta = computeOutlineMeta(levels, new Set([2]));
    expect(meta.every((m) => !m.hidden)).toBe(true);
  });
});
