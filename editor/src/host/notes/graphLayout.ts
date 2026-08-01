// The shared, DETERMINISTIC graph layout kernel (myne-md/myne#200).
//
// One force simulation for every client. It used to be two: desktop ran
// d3-force, mobile ran a hand-rolled O(n²) pass with its own constants, so the
// same vault settled into two different shapes. The phone tuning is now a set
// of `LayoutForces` VALUES rather than a second kernel.
//
// Determinism is the point, and it is what makes parity possible without
// syncing anything: `vault.graph` is a Class 3 rebuildable cache that never
// crosses devices (`protocol.md` §9.19), so the only way two clients can agree
// on where a note sits is for both to compute the same answer independently.
// Five things make that true, and all five are load-bearing:
//
//   1. CANONICAL ORDER — nodes sorted by id, edges by (source, target). Both
//      the force accumulation and the quadtree's insertion order depend on it,
//      and the caller's order is whatever the note cache happened to iterate.
//   2. DETERMINISTIC SEEDING — no `Math.random()`. An unplaced node takes a
//      ring slot by index with an id-hashed radius jitter (`graphLayoutStore`).
//   3. A FIXED VIRTUAL BOX — the simulation runs in `LAYOUT_BOX`, never the
//      measured viewport, so a phone and a desktop window produce identical
//      coordinates. The camera fits afterwards; geometry is not its business.
//   4. A PINNED `alphaDecay` — see ALPHA_DECAY below. Subtle, and the whole
//      cross-engine story hangs on it.
//   5. A FIXED TICK COUNT — bounded ticks then freeze (no perpetual rAF; the
//      calm-app posture, SYNC-12).
//
// The heavy run lives here rather than inside a worker so it is testable
// WITHOUT one: call it directly and it is reproducible. `graphLayoutRun.ts` is
// the entry point that prefers a worker and falls back to this.

import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
} from "d3-force";
import {
  LAYOUT_BOX,
  seedInitialPosition,
  type GraphPosition,
} from "./graphLayoutStore";

export { LAYOUT_BOX };

/** Force-simulation tuning (the four force controls in the graph settings
 *  panel). Omitted → the fixed constants the desktop graph shipped with
 *  (charge -120, link distance 60, center strength 1 — d3's own default).
 *  `repelStrength` is a positive magnitude, negated internally before reaching
 *  d3 (its charge force is negative for repulsion). */
export interface LayoutForces {
  centerStrength: number;
  repelStrength: number;
  linkStrength: number;
  linkDistance: number;
}

const DEFAULT_FORCES: LayoutForces = {
  centerStrength: 1,
  repelStrength: 120,
  linkStrength: 1,
  linkDistance: 60,
};

/** A resolved model + warm-start seed, posted INTO the worker. Carries no
 *  viewport: see {@link LAYOUT_BOX}. */
export interface LayoutRequest {
  /** Nodes to place (already resolved; title not needed for layout). */
  nodes: ReadonlyArray<{ id: string }>;
  /** Directed edges among `nodes`. The model's `weight` is deliberately NOT an
   *  input: it is a render-time signal (how many occurrences collapsed into the
   *  pair), and feeding it to the springs would move every existing desktop
   *  layout for a reason parity does not require — both clients agree either
   *  way, and this change is already re-laying everything out once. */
  edges: ReadonlyArray<{ source: string; target: string }>;
  /** Previous positions (warm start): a node present here keeps its place;
   *  absent nodes are seeded on the deterministic ring. */
  seed: Record<string, GraphPosition>;
  /** See {@link LayoutForces}. Optional — a caller that never wires the
   *  settings panel gets the fixed defaults. */
  forces?: LayoutForces;
}

export interface LaidOutNode {
  id: string;
  x: number;
  y: number;
}

/** Final positions, posted back OUT of the worker. */
export interface LayoutResponse {
  positions: LaidOutNode[];
}

/** Bounded tick budget — then freeze. */
const TICKS = 240;

/**
 * d3's own default is `1 - Math.pow(alphaMin, 1 / 300)`, evaluated when the
 * simulation is constructed (`d3-force/src/simulation.js`). `Math.pow` is NOT
 * required to be correctly rounded, so JavaScriptCore (iOS WKWebView) and V8
 * may differ by one ulp — and a one-ulp difference in the cooling rate
 * compounds over 240 ticks of a chaotic n-body system into a visibly different
 * layout. Pinned to the literal that expression evaluates to, the run uses only
 * `+ - * /` and `Math.sqrt`, which IEEE-754 requires to be correctly rounded,
 * so the result is bit-identical across engines. (d3-force's `jiggle` uses a
 * seeded LCG, not `Math.random` — that part was already safe.)
 */
const ALPHA_DECAY = 0.022806515038674378;

type SimNode = { id: string; x: number; y: number };
type SimLink = { source: SimNode; target: SimNode };

/** Lexicographic compare — one helper so the node and edge sorts cannot drift
 *  into two different collations (`localeCompare` is locale-dependent and would
 *  break determinism across devices; this is byte order). */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Run the bounded force layout and return final node positions. Deterministic
 * for a given `(nodes, edges, seed, forces)` — the same inputs yield the same
 * output on any engine, which is what lets two clients agree without syncing.
 */
export function computeGraphLayout(req: LayoutRequest): LayoutResponse {
  const { seed, forces = DEFAULT_FORCES } = req;
  const centre = LAYOUT_BOX / 2;

  const ordered = [...req.nodes].sort((a, b) => compare(a.id, b.id));
  const simNodes: SimNode[] = ordered.map((n, index) => {
    const p = seedInitialPosition(seed[n.id], n.id, index, ordered.length);
    return { id: n.id, x: p.x, y: p.y };
  });

  const byId = new Map(simNodes.map((n) => [n.id, n]));
  const orderedEdges = [...req.edges].sort(
    (a, b) => compare(a.source, b.source) || compare(a.target, b.target),
  );
  const simLinks: SimLink[] = [];
  for (const e of orderedEdges) {
    const source = byId.get(e.source);
    const target = byId.get(e.target);
    if (source && target) simLinks.push({ source, target });
  }

  const sim: Simulation<SimNode, undefined> = forceSimulation(simNodes)
    .alphaDecay(ALPHA_DECAY)
    .force("charge", forceManyBody().strength(-forces.repelStrength))
    .force(
      "link",
      forceLink<SimNode, SimLink>(simLinks)
        .distance(forces.linkDistance)
        .strength(forces.linkStrength),
    )
    .force("center", forceCenter(centre, centre).strength(forces.centerStrength))
    .stop();
  sim.tick(TICKS);
  sim.stop();

  return { positions: simNodes.map((n) => ({ id: n.id, x: n.x, y: n.y })) };
}
