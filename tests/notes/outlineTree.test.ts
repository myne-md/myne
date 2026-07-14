import { describe, expect, it } from "vitest";
import { computeOutlineMeta } from "../../src/notes/outlineTree";

// Levels model a document-order heading list (1..6). `computeOutlineMeta` derives
// per-row `hasChildren` (the next heading is deeper), `hidden` (a collapsed
// ancestor is folding it away), and `collapsedUnder` (which ancestor).
describe("computeOutlineMeta", () => {
  const hidden = (levels: number[], collapsed: number[]) =>
    computeOutlineMeta(levels, new Set(collapsed)).map((m) => m.hidden);

  it("marks a heading as a parent only when the next one is deeper", () => {
    // H1, H2, H2, H3, H1
    const meta = computeOutlineMeta([1, 2, 2, 3, 1], new Set());
    expect(meta.map((m) => m.hasChildren)).toEqual([true, false, true, false, false]);
  });

  it("nothing is hidden when nothing is collapsed", () => {
    expect(hidden([1, 2, 3, 2, 1], [])).toEqual([false, false, false, false, false]);
  });

  it("collapsing a parent hides its deeper subtree until a same-or-higher heading", () => {
    // Collapse the first H2 (index 1): its H3 child (index 3) hides; the sibling
    // H2 (index 4) and the H1s stay visible.
    // levels: H1 H2 H2 H3 H2 H1  (index 1 has no deeper child; use a real parent)
    const levels = [1, 2, 3, 2, 1];
    expect(hidden(levels, [1])).toEqual([false, false, true, false, false]);
  });

  it("collapsing an H1 folds every deeper heading beneath it", () => {
    const levels = [1, 2, 3, 2, 1];
    expect(hidden(levels, [0])).toEqual([false, true, true, true, false]);
  });

  it("nested collapse: the outer floor persists across an inner collapsed parent", () => {
    // Collapsing the H1 (0) hides the H2 (1) even though it too is collapsed.
    const levels = [1, 2, 3, 2, 1];
    const meta = computeOutlineMeta(levels, new Set([0, 1]));
    expect(meta.map((m) => m.hidden)).toEqual([false, true, true, true, false]);
    // Every hidden row points at the outer H1 as its collapsing ancestor.
    expect(meta.map((m) => m.collapsedUnder)).toEqual([-1, 0, 0, 0, -1]);
  });

  it("collapsing a leaf-level heading (no children) hides nothing", () => {
    // Index 2 is an H3 leaf; collapsing it is a no-op for visibility.
    const levels = [1, 2, 3, 1];
    expect(hidden(levels, [2])).toEqual([false, false, false, false]);
  });

  it("collapsedUnder names the nearest collapsed ancestor for hidden rows", () => {
    const meta = computeOutlineMeta([1, 2, 3], new Set([1]));
    expect(meta.map((m) => m.collapsedUnder)).toEqual([-1, -1, 1]);
  });
});
