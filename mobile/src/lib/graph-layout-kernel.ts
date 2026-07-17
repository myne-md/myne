// The pure force kernel behind the mobile wikilink graph — extracted from
// `WikiGraph.tsx` so the SAME pass drives both the component's interactive
// rAF sim and the off-thread cold-start layout (`graph-layout.worker.ts`).
// Because both callers share `stepForces`, the worker's converged layout and
// the live sim's look cannot diverge.
//
// Message shapes (`LayoutRequest` / `LayoutResponse`) mirror the desktop
// `src/notes/graphLayoutProtocol.ts` verbatim for protocol parity — but the
// kernel is NOT d3-force: it is the phone-tuned hand-rolled sim (pairwise
// repulsion + link springs + center pull, cooled). Mobile edges are unweighted;
// the `weight` field is accepted and ignored.

import type { GraphPosition } from "./graph-layout-store";
import type { ViewTransform } from "./graph-culling";

// Force constants — tuned for a phone-sized graph. Repulsion pushes every pair
// apart, links pull connected notes toward a rest length, a weak centre pull
// keeps the cloud on screen; velocity is damped and the whole thing cools so it
// settles (and reheats on drag).
export const REPULSION = 5200;
export const SPRING_K = 0.016;
export const SPRING_LEN = 92;
export const CENTER_K = 0.022;
export const DAMPING = 0.86;

/** Per-step cooling factor and the idle threshold the rAF sim parks below. */
export const ALPHA_DECAY = 0.986;
export const ALPHA_MIN = 0.02;
/** The cold-start alpha (a fresh, unpersisted layout). */
export const ALPHA_COLD = 0.9;
/** Hard tick cap for the off-thread cold-start run (converges long before). */
export const MAX_TICKS = 400;

// Render tuning shared by the culling/LOD pass in `WikiGraph.tsx`.
/** Cull margin in graph units — covers the max node radius (13) + label row. */
export const CULL_MARGIN = 48;
/** Below this zoom, labels are hidden (zoomed-out = the calm overview). */
export const LABEL_LOD_K = 0.9;
/** At/above this zoom, labels widen to the fine truncation. */
export const LABEL_FINE_K = 2.2;
/** Label truncation lengths at the coarse / fine LOD tiers. */
export const LABEL_COARSE_CHARS = 14;
export const LABEL_FINE_CHARS = 28;
/** Pinch/pan zoom clamp. The floor is low enough that `fitTransform` can fit a
 *  large vault's cloud on a phone box (a 0.3-style floor would fight it). */
export const K_MIN = 0.05;
export const K_MAX = 6;

/** The mutable node the force pass integrates. `fixed` pins a node to the
 *  finger while dragging (excluded from integration). */
export interface KernelNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fixed: boolean;
}

/** An unweighted directed edge between note ids (the mobile `NoteGraph` form). */
export interface KernelEdge {
  from: string;
  to: string;
}

/** A resolved model + warm-start seed + box, posted INTO the worker.
 *  Shape-identical to the desktop `graphLayoutProtocol.ts` `LayoutRequest`. */
export interface LayoutRequest {
  nodes: ReadonlyArray<{ id: string }>;
  edges: ReadonlyArray<{ source: string; target: string; weight: number }>;
  /** Previous positions (warm start): a node present here keeps its place;
   *  absent nodes are seeded on the deterministic jittered ring. */
  seed: Record<string, GraphPosition>;
  width: number;
  height: number;
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

/**
 * One force pass over `nodes` at the given `alpha`: O(n²) pairwise repulsion,
 * link springs, centre pull, damping + integration. Mutates node x/y/vx/vy in
 * place; a `fixed` node's velocity is zeroed and its position untouched.
 * NO position clamping — callers own any box constraint (the interactive sim
 * dropped its clamp when pan/zoom landed; positions are graph-space).
 */
export function stepForces(
  nodes: KernelNode[],
  byId: ReadonlyMap<string, KernelNode>,
  edges: ReadonlyArray<KernelEdge>,
  alpha: number,
  cx: number,
  cy: number,
): void {
  // pairwise repulsion
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let k = i + 1; k < nodes.length; k++) {
      const b = nodes[k];
      let dx = a.x - b.x,
        dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        d2 = 1;
        dx = Math.random() - 0.5 || 0.5;
        dy = Math.random() - 0.5;
      }
      const d = Math.sqrt(d2);
      const f = (REPULSION / d2) * alpha;
      const ux = dx / d,
        uy = dy / d;
      a.vx += ux * f;
      a.vy += uy * f;
      b.vx -= ux * f;
      b.vy -= uy * f;
    }
  }
  // link springs
  for (const e of edges) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) continue;
    const dx = b.x - a.x,
      dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = (d - SPRING_LEN) * SPRING_K * alpha;
    const ux = dx / d,
      uy = dy / d;
    a.vx += ux * f;
    a.vy += uy * f;
    b.vx -= ux * f;
    b.vy -= uy * f;
  }
  // centring + integrate
  for (const n of nodes) {
    if (n.fixed) {
      n.vx = 0;
      n.vy = 0;
      continue;
    }
    n.vx += (cx - n.x) * CENTER_K * alpha;
    n.vy += (cy - n.y) * CENTER_K * alpha;
    n.vx *= DAMPING;
    n.vy *= DAMPING;
    n.x += n.vx;
    n.y += n.vy;
  }
}

/**
 * Deterministic jittered-ring seed for a node with no previous position —
 * angle by index, radius jitter from the id's char codes, so a cold layout
 * looks scattered (not a rigid ring) yet is fully reproducible.
 */
export function ringSeed(
  id: string,
  index: number,
  count: number,
  width: number,
  height: number,
): GraphPosition {
  const cx = width / 2,
    cy = height / 2;
  const R = Math.max(40, Math.min(width, height) / 2 - 60);
  const a = (2 * Math.PI * index) / Math.max(1, count) - Math.PI / 2;
  const j = ((id.charCodeAt(0) + id.charCodeAt(id.length - 1)) % 37) / 37;
  return {
    x: cx + R * (0.55 + 0.45 * j) * Math.cos(a),
    y: cy + R * (0.55 + 0.45 * j) * Math.sin(a),
  };
}

/**
 * Run the bounded cold-start layout and return final positions. Seeded nodes
 * warm-start from `seed`; the rest take the deterministic ring — so (unlike
 * the desktop d3 kernel's random jitter) ANY request is deterministic. Cools
 * from `ALPHA_COLD` with the same decay the interactive sim uses, hard-capped
 * at `MAX_TICKS`.
 */
export function computeGraphLayout(req: LayoutRequest): LayoutResponse {
  const { nodes, edges, seed, width, height } = req;
  const cx = width / 2,
    cy = height / 2;

  const kernelNodes: KernelNode[] = nodes.map((n, i) => {
    const p = seed[n.id] ?? ringSeed(n.id, i, nodes.length, width, height);
    return { id: n.id, x: p.x, y: p.y, vx: 0, vy: 0, fixed: false };
  });
  const byId = new Map(kernelNodes.map((n) => [n.id, n]));
  // The kernel walks the mobile edge shape; weight is protocol-parity only.
  const kernelEdges: KernelEdge[] = edges.map((e) => ({
    from: e.source,
    to: e.target,
  }));

  let alpha = ALPHA_COLD;
  for (let tick = 0; tick < MAX_TICKS && alpha > ALPHA_MIN; tick++) {
    stepForces(kernelNodes, byId, kernelEdges, alpha, cx, cy);
    alpha *= ALPHA_DECAY;
  }

  return {
    positions: kernelNodes.map((n) => ({ id: n.id, x: n.x, y: n.y })),
  };
}

/**
 * The view that fits the bounding box of `positions` into a `width`×`height`
 * box with `padding` screen-px on every side, zoom capped at `maxK` (so a
 * two-node graph doesn't fill the screen) and floored at `K_MIN`. Run when a
 * layout becomes ready (hydrated / worker-applied / cold seed) and on
 * double-tap — it makes a layout persisted under a different orientation or
 * box size (rotation, tablet⇄phone window) reachable without hunting.
 */
export function fitTransform(
  positions: ReadonlyArray<{ x: number; y: number }>,
  width: number,
  height: number,
  padding = 32,
  maxK = 1.5,
): ViewTransform {
  if (positions.length === 0) return { x: 0, y: 0, k: 1 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of positions) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const bw = maxX - minX,
    bh = maxY - minY;
  const k =
    bw === 0 && bh === 0
      ? 1
      : Math.max(
          K_MIN,
          Math.min(
            maxK,
            (width - 2 * padding) / Math.max(bw, 1e-6),
            (height - 2 * padding) / Math.max(bh, 1e-6),
          ),
        );
  // Center the scaled bbox in the screen box: screen = graph * k + translate.
  const bcx = (minX + maxX) / 2,
    bcy = (minY + maxY) / 2;
  return { x: width / 2 - bcx * k, y: height / 2 - bcy * k, k };
}
