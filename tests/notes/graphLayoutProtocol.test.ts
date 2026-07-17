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
});
