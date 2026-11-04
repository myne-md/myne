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
import {
  MAX_DEGREE_FOR_SIZE,
  NODE_SIZE_RANGE,
  NODE_SIZE_STRENGTH_RANGE,
  resolveNodeRadius,
  resolveReservedRadius,
  resolveReservedTagNodeRadius,
  resolveTagNodeRadius,
  TAG_NODE_MAX_DEGREE,
} from "../../src/notes/graphSettings";

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
      forces: { centerStrength: 1, repelStrength: 70, linkStrength: 1, linkDistance: 48 },
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

// The property the "everything is tiny" complaint turned out to be about
// (myne-md/myne#727). The kernel used to let a few-hundred-node vault sprawl to
// several times `LAYOUT_BOX`, and the camera fits the CLOUD rather than the box,
// so every node rendered as a speck no matter how large the radius setting was.
// The cause was that `forceCenter` cannot compact anything (it translates every
// node equally) and an orphan felt no force at all; the fix is per-node gravity
// toward the centre. This asserts the OUTCOME, because the outcome is what the
// user sees.
describe("settled extent stays bounded", () => {
  const extentOf = (positions: ReadonlyArray<{ x: number; y: number }>): number => {
    const xs = positions.map((p) => p.x);
    const ys = positions.map((p) => p.y);
    return Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  };

  /** A connected backbone with a quarter of its nodes orphaned, the shape a
   *  real vault has, and the shape that used to sprawl worst because orphans
   *  had nothing pulling them in. */
  const vaultLike = (n: number): LayoutRequest => {
    const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${String(i).padStart(4, "0")}` }));
    const edges: Array<{ source: string; target: string }> = [];
    for (let i = 1; i < n; i += 1) {
      if (i % 4 === 0) continue; // every fourth note is an orphan
      edges.push({ source: nodes[i - 1]!.id, target: nodes[i]!.id });
    }
    return { nodes, edges, seed: {} };
  };

  it("a 500-note vault settles inside a small multiple of LAYOUT_BOX", () => {
    const { positions } = computeGraphLayout(vaultLike(500));
    // MEASURED at 1373.2 units against LAYOUT_BOX = 1000, so 1.37x. (The
    // collide floor of task 19 moved this from 1374.9, no growth at all, which
    // is the point: the floor is bought out of the crowding it removes, not out
    // of the cloud's size. The second spacing pass, a longer default link
    // distance and a wider padding, moved it to 1373.2: a chain folds more when
    // its links are longer, so more air per pair costs nothing overall.) The bound is 1.5x so a
    // regression that removes the gravity fails loudly while ordinary tuning of
    // the force constants has room to move.
    expect(extentOf(positions)).toBeLessThan(LAYOUT_BOX * 1.5);
    // 500 nodes of force simulation is about half a second here and past the
    // suite's 5 s default on a loaded CI runner, where it timed out three
    // pipelines in a row while asserting nothing wrong (v0.13.0). The claim is
    // the bound above, not how fast the machine is.
  }, 30_000);

  it("never lets two nodes touch, even at the largest node size the panel offers", () => {
    // The user-visible property, and the one that has to hold unconditionally:
    // two nodes must never overlap, no matter how heavy the connection between
    // them (myne-md/myne#727). The shape below is the one that made it visible,
    // a hub with sixty leaves, plus a tag node over the same leaves, which is
    // what "a big green blob" was.
    //
    // The radii asserted against are the DRAWN ones at BOTH panel maxima, which
    // is the largest a node can ever be. If the floor holds there it holds at
    // every setting, which is exactly why the layout reserves the maximum
    // rather than what is currently drawn.
    const leaves = Array.from({ length: 60 }, (_, i) => `leaf${String(i).padStart(3, "0")}`);
    const nodes = [{ id: "hub" }, ...leaves.map((id) => ({ id })), { id: "tag:work" }];
    const edges = [
      ...leaves.map((id) => ({ source: "hub", target: id })),
      ...leaves.map((id) => ({ source: "tag:work", target: id })),
    ];
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const reserved = (id: string) =>
      id.startsWith("tag:")
        ? resolveReservedTagNodeRadius()
        : resolveReservedRadius(degree.get(id) ?? 0, MAX_DEGREE_FOR_SIZE);
    const drawnAtMax = (id: string) =>
      id.startsWith("tag:")
        ? resolveTagNodeRadius(
            NODE_SIZE_RANGE.max,
            NODE_SIZE_STRENGTH_RANGE.max,
            TAG_NODE_MAX_DEGREE,
          )
        : resolveNodeRadius(
            NODE_SIZE_RANGE.max,
            NODE_SIZE_STRENGTH_RANGE.max,
            degree.get(id) ?? 0,
            MAX_DEGREE_FOR_SIZE,
          );

    // The tag node MUST participate. A wrong-arity call here once made it
    // `NaN`, and every pair touching it was silently dropped from the minimum:
    // the assertion then passed for a fixture that could not reach the defect it
    // is named for (deleting the tag node's reserved radius would not fail it).
    expect(Number.isFinite(drawnAtMax("tag:work"))).toBe(true);
    expect(Number.isFinite(drawnAtMax("hub"))).toBe(true);

    const { positions } = computeGraphLayout({
      nodes: nodes.map((n) => ({ id: n.id, radius: reserved(n.id) })),
      edges,
      seed: {},
    });
    let closest = Infinity;
    let tagPairs = 0;
    for (let i = 0; i < positions.length; i += 1) {
      for (let j = i + 1; j < positions.length; j += 1) {
        const a = positions[i]!;
        const b = positions[j]!;
        const gap =
          Math.hypot(a.x - b.x, a.y - b.y) - (drawnAtMax(a.id) + drawnAtMax(b.id));
        if (a.id === "tag:work" || b.id === "tag:work") tagPairs += 1;
        if (gap < closest) closest = gap;
      }
    }
    // Non-vacuity: the tag node's pairs really were in the minimum.
    expect(tagPairs).toBe(nodes.length - 1);
    // MEASURED at 13.86 units clear, against a `COLLIDE_PADDING` floor of 14.
    // The bound is 0, the guarantee, rather than the measured value, because
    // the point of this test is "never", and a constant tweak that makes the
    // picture slightly tighter should not redden it.
    expect(closest).toBeGreaterThan(0);
  });

  it("scatters its orphans across a RANGE of distances, not onto one ring", () => {
    // The defect this pins: the seed used to place every unplaced node on the
    // same annulus, and because gravity is proportional to distance a node's
    // equilibrium radius is set by where it started. The whole orphan
    // population therefore settled onto one evenly spaced ring of beads around
    // the cloud, with no gradient between orphans and connected notes.
    const req = vaultLike(200);
    const { positions } = computeGraphLayout(req);
    const centre = LAYOUT_BOX / 2;
    const orphanIds = new Set(req.nodes.map((n) => n.id).filter((id) => Number(id.slice(1)) % 4 === 0));
    const radii = positions
      .filter((p) => orphanIds.has(p.id))
      .map((p) => Math.hypot(p.x - centre, p.y - centre));
    expect(radii.length).toBeGreaterThan(10);
    const spread = Math.max(...radii) - Math.min(...radii);
    expect(spread).toBeGreaterThan(LAYOUT_BOX * 0.2); // MEASURED 376.6
  });

  it("and its orphans are inside the cloud rather than on the rim", () => {
    // An orphan is `n0004`, `n0008`, … The rim is `LAYOUT_BOX / 2` from the
    // centre; the whole point of the gravity is that nothing sits out there.
    const req = vaultLike(200);
    const { positions } = computeGraphLayout(req);
    const centre = LAYOUT_BOX / 2;
    const orphanIds = new Set(req.nodes.map((n) => n.id).filter((id) => Number(id.slice(1)) % 4 === 0));
    const orphans = positions.filter((p) => orphanIds.has(p.id));
    expect(orphans.length).toBeGreaterThan(10);
    const farthest = Math.max(
      ...orphans.map((p) => Math.hypot(p.x - centre, p.y - centre)),
    );
    expect(farthest).toBeLessThan(LAYOUT_BOX / 2);
  });
});
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
