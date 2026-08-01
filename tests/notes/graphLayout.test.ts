// The shared, deterministic layout kernel (myne-md/myne#200). Exercised
// directly (no Worker) — it is a pure function of its request, including the
// cold-start seed, which is the property the whole cross-client parity story
// rests on.

import { describe, it, expect } from "vitest";
import {
  computeGraphLayout,
  LAYOUT_BOX,
  type LayoutRequest,
} from "../../src/notes/graphLayoutProtocol";

const seededReq: LayoutRequest = {
  nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
  edges: [
    { source: "a", target: "b" },
    { source: "b", target: "c" },
  ],
  seed: { a: { x: 10, y: 10 }, b: { x: 120, y: 20 }, c: { x: 30, y: 230 } },
};

const coldReq: LayoutRequest = {
  nodes: [{ id: "n1" }, { id: "n2" }, { id: "n3" }, { id: "n4" }],
  edges: [
    { source: "n1", target: "n2" },
    { source: "n2", target: "n3" },
    { source: "n3", target: "n4" },
  ],
  seed: {},
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
    });
    expect(positions.length).toBe(1);
    expect(Number.isFinite(positions[0]!.x)).toBe(true);
  });

  it("ignores an edge whose endpoint is not in the node-set", () => {
    const { positions } = computeGraphLayout({
      ...seededReq,
      edges: [{ source: "a", target: "ghost" }],
    });
    expect(positions.length).toBe(3); // no throw, dangling edge dropped
  });

  it("omitting `forces` matches the fixed constants explicitly passed", () => {
    const withoutForces = computeGraphLayout(seededReq);
    const withDefaultForces = computeGraphLayout({
      ...seededReq,
      forces: { centerStrength: 1, repelStrength: 120, linkStrength: 1, linkDistance: 60 },
    });
    expect(withoutForces.positions).toEqual(withDefaultForces.positions);
  });

  it("warm-starts: a seeded node keeps its exact place when no force pulls it", () => {
    // The warm-start half of the force contract, isolated from the physics:
    // with every force inert, the kernel must return the seed VERBATIM. A cold
    // start would hand back the deterministic ring instead — which is exactly
    // what re-scattering (the "flashbang") looks like. The complementary half,
    // "a live force re-run seeds every node it is about to lay out", is
    // E2E-observable as `data-force-relayout-seeded`.
    const { positions } = computeGraphLayout({
      ...seededReq,
      forces: { centerStrength: 0, repelStrength: 0, linkStrength: 0, linkDistance: 60 },
    });
    const byId = new Map(positions.map((p) => [p.id, p]));
    for (const [id, at] of Object.entries(seededReq.seed)) {
      expect(byId.get(id)).toEqual({ id, x: at.x, y: at.y });
    }
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

// The properties that let two clients agree on a layout without ever exchanging
// one. Each maps to a hazard named in the kernel's header.
describe("determinism", () => {
  it("a cold run is reproducible — no Math.random anywhere in the seed", () => {
    expect(computeGraphLayout(coldReq).positions).toEqual(
      computeGraphLayout(coldReq).positions,
    );
  });

  it("is independent of the caller's node and edge order", () => {
    // The note cache iterates in whatever order it happens to hold, and both
    // the force accumulation and the quadtree's insertion order depend on it —
    // so the kernel sorts before it simulates.
    const shuffled: LayoutRequest = {
      nodes: [...coldReq.nodes].reverse(),
      edges: [...coldReq.edges].reverse(),
      seed: {},
    };
    expect(computeGraphLayout(shuffled).positions).toEqual(
      computeGraphLayout(coldReq).positions,
    );
  });

  it("lays out in the fixed virtual box, not any viewport", () => {
    // A cold layout centres on LAYOUT_BOX/2 whatever the screen: the camera is
    // what adapts to a window, not the geometry.
    const { positions } = computeGraphLayout(coldReq);
    const cx = positions.reduce((s, p) => s + p.x, 0) / positions.length;
    const cy = positions.reduce((s, p) => s + p.y, 0) / positions.length;
    expect(cx).toBeCloseTo(LAYOUT_BOX / 2, 0);
    expect(cy).toBeCloseTo(LAYOUT_BOX / 2, 0);
  });

  it("gives two different ids two different ring slots", () => {
    // The retired mobile ring keyed its jitter on the first and last char
    // modulo 37, which collides constantly over UUIDs; this one hashes the
    // whole id.
    const { positions } = computeGraphLayout(coldReq);
    const distinct = new Set(positions.map((p) => `${p.x},${p.y}`));
    expect(distinct.size).toBe(positions.length);
  });
});
