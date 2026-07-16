// The pure force kernel: the extracted WikiGraph force pass + the bounded
// cold-start layout the worker runs + the fit-to-content view math.

import { describe, expect, it } from "vitest";
import {
  ALPHA_COLD,
  computeGraphLayout,
  fitTransform,
  K_MIN,
  ringSeed,
  stepForces,
  type KernelNode,
  type LayoutRequest,
} from "../src/lib/graph-layout-kernel";

function req(partial: Partial<LayoutRequest> = {}): LayoutRequest {
  return {
    nodes: [{ id: "a" }, { id: "b" }, { id: "c" }],
    edges: [
      { source: "a", target: "b", weight: 1 },
      { source: "b", target: "c", weight: 1 },
    ],
    seed: {},
    width: 390,
    height: 700,
    ...partial,
  };
}

describe("computeGraphLayout", () => {
  it("returns a finite position for every node", () => {
    const res = computeGraphLayout(req());
    expect(res.positions).toHaveLength(3);
    for (const p of res.positions) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("is deterministic — ring seed carries no randomness", () => {
    // Unlike the desktop d3 kernel (random jitter for un-seeded nodes), the
    // mobile ring seed is id/index-derived, so even a zero-seed request must
    // reproduce byte-identical positions.
    const a = computeGraphLayout(req());
    const b = computeGraphLayout(req());
    expect(a).toEqual(b);
  });

  it("warm-started nodes converge near their seed under a settled layout", () => {
    // A fully-seeded request with a pre-settled arrangement should not fling
    // nodes far away: the run starts at ALPHA_COLD but forces shrink with
    // distance-to-equilibrium. Sanity-bound the drift rather than pin exact
    // coordinates (the sim still integrates).
    const seed = {
      a: { x: 100, y: 100 },
      b: { x: 180, y: 100 },
      c: { x: 260, y: 100 },
    };
    const res = computeGraphLayout(req({ seed }));
    for (const p of res.positions) {
      const s = seed[p.id as keyof typeof seed];
      expect(Math.hypot(p.x - s.x, p.y - s.y)).toBeLessThan(300);
    }
  });

  it("ignores an edge with an unknown endpoint (no crash)", () => {
    const res = computeGraphLayout(
      req({ edges: [{ source: "a", target: "ghost", weight: 1 }] }),
    );
    expect(res.positions).toHaveLength(3);
  });

  it("handles an isolated single node", () => {
    const res = computeGraphLayout(req({ nodes: [{ id: "solo" }], edges: [] }));
    expect(res.positions).toHaveLength(1);
    expect(Number.isFinite(res.positions[0].x)).toBe(true);
  });
});

describe("stepForces", () => {
  it("a fixed node never moves; a free node integrates", () => {
    const nodes: KernelNode[] = [
      { id: "pinned", x: 50, y: 50, vx: 0, vy: 0, fixed: true },
      { id: "free", x: 60, y: 50, vx: 0, vy: 0, fixed: false },
    ];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    stepForces(nodes, byId, [{ from: "pinned", to: "free" }], ALPHA_COLD, 100, 100);
    expect(nodes[0]).toMatchObject({ x: 50, y: 50, vx: 0, vy: 0 });
    expect(nodes[1].x).not.toBe(60);
  });
});

describe("ringSeed", () => {
  it("is deterministic and inside the box's ring band", () => {
    const a = ringSeed("note-id-1", 0, 10, 390, 700);
    const b = ringSeed("note-id-1", 0, 10, 390, 700);
    expect(a).toEqual(b);
    const r = Math.hypot(a.x - 195, a.y - 350);
    const R = Math.max(40, Math.min(390, 700) / 2 - 60);
    expect(r).toBeGreaterThanOrEqual(0.55 * R - 1e-9);
    expect(r).toBeLessThanOrEqual(R + 1e-9);
  });
});

describe("fitTransform", () => {
  it("fits a bbox with padding on every side", () => {
    const view = fitTransform(
      [
        { x: 0, y: 0 },
        { x: 100, y: 200 },
      ],
      500,
      500,
      50,
      10, // maxK high enough not to bind
    );
    // Height binds: k = (500-100)/200 = 2. Bbox center (50,100) → screen center.
    expect(view.k).toBeCloseTo(2);
    expect(50 * view.k + view.x).toBeCloseTo(250);
    expect(100 * view.k + view.y).toBeCloseTo(250);
    // Padding respected: content spans [screen-center ± scaled-half-extent].
    expect(0 * view.k + view.y).toBeCloseTo(50);
    expect(200 * view.k + view.y).toBeCloseTo(450);
  });

  it("caps zoom at maxK for a tiny graph", () => {
    const view = fitTransform(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      500,
      500,
      32,
      1.5,
    );
    expect(view.k).toBe(1.5);
  });

  it("floors at K_MIN for a huge graph", () => {
    const view = fitTransform(
      [
        { x: 0, y: 0 },
        { x: 1_000_000, y: 1_000_000 },
      ],
      390,
      700,
    );
    expect(view.k).toBe(K_MIN);
  });

  it("empty → identity; single point → k=1 centered", () => {
    expect(fitTransform([], 390, 700)).toEqual({ x: 0, y: 0, k: 1 });
    const one = fitTransform([{ x: 42, y: 42 }], 390, 700);
    expect(one.k).toBe(1);
    expect(42 * one.k + one.x).toBeCloseTo(195);
    expect(42 * one.k + one.y).toBeCloseTo(350);
  });
});
