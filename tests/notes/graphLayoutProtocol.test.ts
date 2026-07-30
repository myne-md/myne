// The pure layout kernel that runs inside the graph layout Web Worker
// (Phase A4). Exercised directly (no Worker) — it is a pure function of its
// request except the jitter given to un-seeded nodes.

import { describe, it, expect } from "vitest";
import {
  computeGraphLayout,
  type LayoutRequest,
} from "../../src/notes/graphLayoutProtocol";

const seededReq: LayoutRequest = {
  nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
  edges: [
    { source: "a", target: "b", weight: 1 },
    { source: "b", target: "c", weight: 1 },
  ],
  seed: { a: { x: 10, y: 10 }, b: { x: 120, y: 20 }, c: { x: 30, y: 230 } },
  width: 800,
  height: 600,
};

describe("computeGraphLayout", () => {
  it("returns a finite position for every node", () => {
    const { positions } = computeGraphLayout(seededReq);
    expect(positions.map((p) => p.id).sort()).toEqual(["a", "b", "c"]);
    for (const p of positions) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("places a node with no seed and no edges (isolated) without crashing", () => {
    const { positions } = computeGraphLayout({
      nodes: [{ id: "lonely" }],
      edges: [],
      seed: {},
      width: 400,
      height: 400,
    });
    expect(positions.length).toBe(1);
    expect(Number.isFinite(positions[0]!.x)).toBe(true);
  });

  it("ignores an edge whose endpoint is not in the node-set", () => {
    const { positions } = computeGraphLayout({
      ...seededReq,
      edges: [{ source: "a", target: "ghost", weight: 1 }],
    });
    expect(positions.length).toBe(3); // no throw, dangling edge dropped
  });

  it("omitting `forces` matches the pre-task-6 fixed constants explicitly passed", () => {
    const withoutForces = computeGraphLayout(seededReq);
    const withDefaultForces = computeGraphLayout({
      ...seededReq,
      forces: { centerStrength: 1, repelStrength: 120, linkStrength: 1, linkDistance: 60 },
    });
    expect(withoutForces.positions).toEqual(withDefaultForces.positions);
  });

  it("a custom `forces` payload produces a different (still finite) layout", () => {
    const tight = computeGraphLayout({
      ...seededReq,
      forces: { centerStrength: 1, repelStrength: 20, linkStrength: 1, linkDistance: 10 },
    });
    const loose = computeGraphLayout({
      ...seededReq,
      forces: { centerStrength: 1, repelStrength: 300, linkStrength: 1, linkDistance: 150 },
    });
    for (const p of [...tight.positions, ...loose.positions]) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
    // A much looser repel/link-distance settles the graph into a visibly
    // larger spread than a much tighter one — proves `forces` actually reaches
    // the simulation rather than being silently ignored.
    const spread = (positions: typeof tight.positions) => {
      const xs = positions.map((p) => p.x);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(spread(loose.positions)).toBeGreaterThan(spread(tight.positions));
  });
});
