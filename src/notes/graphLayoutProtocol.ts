// Message protocol + the pure layout kernel for the off-main-thread graph
// layout (Phase A4 / Tier 1). The d3-force n-body simulation is the genuinely
// CPU-heavy part of the graph (O(n log n) per tick × TICKS); running it on the
// WebView main thread froze the UI and, repeated on every re-render, pegged a
// core until the watchdog killed the app. It now runs in a Web Worker
// (`graphLayout.worker.ts`). IPC (the edge dump) stays on the main thread —
// only this pure, already-resolved model + warm-start seed crosses into the
// worker, and only positions come back.
//
// `computeGraphLayout` is extracted here (rather than inlined in the worker) so
// it is unit-testable WITHOUT a Worker: call it directly with a fully-seeded
// request and it is deterministic.

import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
} from "d3-force";
import { seedInitialPosition, type GraphPosition } from "./graphLayoutStore";

/** Force-simulation tuning (graph-connection-ux-polish task 6's four force
 *  controls in the graph settings panel). Omitted → the pre-task-6 fixed
 *  constants (charge -120, link distance 60, center strength 1 — d3's own
 *  default). `repelStrength` is a positive magnitude, negated internally
 *  before reaching d3 (its charge force is negative for repulsion). */
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

/** A resolved model + warm-start seed + canvas box, posted INTO the worker. */
export interface LayoutRequest {
  /** Nodes to place (already resolved; title not needed for layout). */
  nodes: ReadonlyArray<{ id: string }>;
  /** Directed weighted edges among `nodes`. */
  edges: ReadonlyArray<{ source: string; target: string; weight: number }>;
  /** Previous positions (warm start): a node present here keeps its place;
   *  absent nodes are seeded fresh (center + jitter). */
  seed: Record<string, GraphPosition>;
  width: number;
  height: number;
  /** See {@link LayoutForces}. Optional — a caller that never wires the
   *  settings panel gets the pre-task-6 fixed constants. */
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

// Matches the previous on-thread budget: bounded ticks → freeze (no perpetual
// rAF; the calm-app posture, SYNC-12).
const TICKS = 240;

type SimNode = { id: string; x: number; y: number };
type SimLink = { source: SimNode; target: SimNode; weight: number };

/**
 * Run the bounded d3-force layout and return final node positions. Pure w.r.t.
 * its inputs EXCEPT the fresh jitter given to un-seeded nodes (`Math.random`) —
 * a fully-seeded request is deterministic. `forces` defaults to the original
 * fixed `GraphCanvas` sim tuning (charge -120, link distance 60, centered) so
 * a caller that never wires the settings panel sees the same layout as before
 * task 6; a caller that does gets a live re-run under the new tuning.
 */
export function computeGraphLayout(req: LayoutRequest): LayoutResponse {
  const { nodes, edges, seed, width, height, forces = DEFAULT_FORCES } = req;
  const cx = width / 2;
  const cy = height / 2;

  const simNodes: SimNode[] = nodes.map((n) => {
    const p = seedInitialPosition(seed[n.id], cx, cy, width, height);
    return { id: n.id, x: p.x, y: p.y };
  });

  const byId = new Map(simNodes.map((n) => [n.id, n]));
  const simLinks: SimLink[] = [];
  for (const e of edges) {
    const source = byId.get(e.source);
    const target = byId.get(e.target);
    if (source && target) simLinks.push({ source, target, weight: e.weight });
  }

  const sim: Simulation<SimNode, undefined> = forceSimulation(simNodes)
    .force("charge", forceManyBody().strength(-forces.repelStrength))
    .force(
      "link",
      forceLink<SimNode, SimLink>(simLinks)
        .distance(forces.linkDistance)
        .strength(forces.linkStrength),
    )
    .force("center", forceCenter(cx, cy).strength(forces.centerStrength))
    .stop();
  sim.tick(TICKS);
  sim.stop();

  return { positions: simNodes.map((n) => ({ id: n.id, x: n.x, y: n.y })) };
}
