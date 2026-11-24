// The shared graph layout kernel (myne-md/myne#200), now with a RUN CONTRACT
// rather than a fixed tick budget (myne-md/myne#727).
//
// One force simulation for every client. It used to be two: desktop ran
// d3-force, mobile ran a hand-rolled O(n²) pass with its own constants, so the
// same vault settled into two different shapes. The phone tuning is now a set
// of `LayoutForces` VALUES rather than a second kernel.
//
// The run contract is what changed here. The kernel used to advance a fixed
// number of ticks and then stop permanently, which meant a settled graph was
// inert: nothing pulled a dragged node back, so dragging one felt like moving an
// icon rather than displacing something with links. It now runs while it has
// energy, cools by alpha decay, and stops on its own once it has settled, and an
// interaction re-heats it. That is the "bounded heat" posture recorded in
// `decisions/ui/0600`; the idle stop is the half that keeps it affordable,
// and `decisions/sync/0601` records why nothing about the result crosses a
// device boundary, which is what makes the loss of cross-engine bit-identity
// acceptable.
//
// What is deliberately KEPT from the old kernel, because a cold start still has
// to be stable and cheap:
//
//   1. CANONICAL ORDER — nodes sorted by id, edges by (source, target). Both
//      the force accumulation and the quadtree's insertion order depend on it,
//      and the caller's order is whatever the note cache happened to iterate.
//   2. DETERMINISTIC SEEDING — no `Math.random()`. An unplaced node takes a
//      ring slot by index with an id-hashed radius jitter (`graphLayoutStore`).
//   3. A FIXED VIRTUAL BOX — the simulation runs in `LAYOUT_BOX`, never the
//      measured viewport, so geometry is not the camera's business.
//   4. A PINNED `alphaDecay`, see ALPHA_DECAY below. No longer needed for
//      cross-engine agreement, but a fixed cooling rate is what makes a settle
//      take a predictable number of ticks, which is what bounds the heat.
//
// The heavy run lives here rather than inside a worker so it is testable
// WITHOUT one: call it directly and it is reproducible. `graphLayoutRun.ts` is
// the main-thread entry point that prefers a worker, and `graphLayoutServe.ts`
// is the worker-side driver that streams frames out of this kernel.

import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
} from "d3-force";
import {
  MAX_DEGREE_FOR_SIZE,
  resolveReservedRadius,
} from "./graphSettings";
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
  // Tightened 120 -> 70 for the repel strength (myne-md/myne#727). The settled
  // cloud used to expand to several times `LAYOUT_BOX`, and since the camera
  // fits the cloud rather than the box, a few-hundred-note vault was rendered at
  // roughly a third of a sensible zoom: every node a speck, the whole picture
  // reading as dust. A tighter equilibrium is what puts the picture back at a
  // legible scale, and it is also what makes the clusters read as clusters
  // rather than as a uniform haze.
  repelStrength: 70,
  linkStrength: 1,
  // The link distance went 60 -> 40 -> 48. The first tightening came with the
  // repel reduction above; the second is the spacing pass, where 40 turned out
  // to be BELOW the distance the collision floor already forced between a hub
  // and its leaves, so the link force had nothing left to say at the low end and
  // every fan settled as a ring of beads at the floor's radius instead of at the
  // link's. 48 sits just above the floor for the common case, which gives the
  // control room at both ends.
  linkDistance: 48,
};

/** A resolved model + warm-start seed, posted INTO the worker. Carries no
 *  viewport: see {@link LAYOUT_BOX}. */
export interface LayoutRequest {
  /** Nodes to place (already resolved; title not needed for layout).
   *
   *  `radius` is the space the LAYOUT must reserve around this node so that no
   *  two nodes can touch, the largest radius the client can DRAW it at, not
   *  the radius it is drawing right now (myne-md/myne#727). Optional: a caller
   *  that omits it gets a degree-based default matching what the settings panel
   *  can produce, which is what the layout's own tests rely on. It is a
   *  per-node field rather than a size setting because a TAG node's radius is a
   *  property of its kind rather than of its degree, and the kernel has no way
   *  to know which nodes those are. */
  nodes: ReadonlyArray<{ id: string; radius?: number }>;
  /** Directed edges among `nodes`. The model's `weight` is deliberately NOT an
   *  input: it is a render-time signal (how many occurrences collapsed into the
   *  pair), and `decisions/sync/0601` records the decision to leave it out
   *  of both the physics and the edge thickness. */
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

/** Final positions, for a caller that only wants the settled answer. */
export interface LayoutResponse {
  positions: LaidOutNode[];
}

/**
 * d3's own default is `1 - Math.pow(alphaMin, 1 / 300)`, evaluated when the
 * simulation is constructed (`d3-force/src/simulation.js`). It is written here
 * as the literal that expression evaluates to, so the cooling rate does not
 * depend on an engine's `Math.pow`. Cross-engine bit-identity is no longer
 * load-bearing (nothing about a layout crosses a device), but a fixed cooling
 * rate is what makes a settle take a predictable number of ticks, which is what
 * gives {@link MAX_TICKS_PER_CYCLE} something to bound.
 */
const ALPHA_DECAY = 0.022806515038674378;

/** d3's own `alphaMin` default. Below it the simulation is considered settled,
 *  and it is the same threshold `forceSimulation`'s own timer loop stops at, so
 *  a manual tick loop settles at the same point the automatic one would. */
export const ALPHA_MIN = 0.001;

/** Ticks advanced per streamed frame. Small enough that the motion reads as
 *  continuous rather than stepped, large enough that a stream of ~1k nodes does
 *  not spend its time on message overhead instead of physics. */
export const TICKS_PER_BURST = 2;

/** Hard ceiling on the ticks one heat cycle may run. A normal settle reaches
 *  {@link ALPHA_MIN} in roughly 300 ticks from cold and fewer from a re-heat;
 *  this is the backstop that makes "a re-heat is bounded" true by construction
 *  rather than by observation. */
export const MAX_TICKS_PER_CYCLE = 600;

/**
 * How much of the "Center pull" setting becomes per-node gravity toward the
 * centre.
 *
 * **This is the fix for a control that could not do what its label promised.**
 * The setting used to drive `forceCenter` alone, and `forceCenter` only
 * re-centres the whole cloud's centroid: it applies the SAME translation to
 * every node, so it cannot compact anything and it cannot move a node relative
 * to its neighbours. A vault therefore sprawled to several times `LAYOUT_BOX`
 * no matter where that slider sat, and the camera, which fits the cloud, zoomed
 * out until every node was a speck.
 *
 * `forceX`/`forceY` are per-node springs toward a coordinate, which is what
 * "center pull" means to a reader. They are also the ONLY force acting on a
 * node with no links at all: an orphan feels no spring, so without this it
 * stays wherever it was seeded, which is why orphans read as debris on the rim
 * rather than as notes in the same picture.
 *
 * `forceCenter` is kept alongside them because it holds the centroid still
 * while the springs do their work, and the two together are what the reference
 * implementation's "Center force" slider actually moves.
 */
const CENTER_GRAVITY = 0.07;

/**
 * The gap the collision floor leaves BEYOND the radius it reserved
 * (myne-md/myne#727 task 19).
 *
 * The floor itself is not invented here: each node's reserved radius comes from
 * the caller (see `LayoutRequest.nodes[].radius`), because only the caller knows
 * how large it will DRAW a node. What this constant adds is the visible space
 * between two discs, so "not overlapping" does not mean "touching".
 */
export const COLLIDE_PADDING = 7;

/**
 * The strength of the collision floor. Full, deliberately: this is the one
 * force in the simulation that is a CONSTRAINT rather than a preference. Two
 * nodes whose reserved radii sum to more than their distance is a defect the
 * user can see, so nothing here should be traded away for a looser picture,
 * every other force keeps its own tuning knob, and this one does not.
 */
export const COLLIDE_STRENGTH = 1;

/**
 * How many times per tick the collision floor is enforced.
 *
 * `d3-force`'s collide is velocity-based, so one pass per tick can leave a
 * residual overlap once the simulation cools and the nodes stop moving: the
 * force is still pushing, but there is no tick left for the push to take
 * effect. Measured on a 60-leaf hub-and-tag fixture, one pass settled with the
 * closest pair 5 units clear of touching, positive, but a number rather than a
 * guarantee. Each extra pass is another chance to resolve the same overlap
 * within the same tick, and it is cheap: the quadtree is built once and reused.
 */
export const COLLIDE_ITERATIONS = 3;

/** The radius assumed for a node the request did not give one for. Degree-based
 *  and matching what the panel can draw, so a caller that omits the field (the
 *  layout's own tests) still gets the real collision shape rather than a flat
 *  approximation of it. */
const fallbackReservedRadius = (degree: number): number =>
  resolveReservedRadius(degree, MAX_DEGREE_FOR_SIZE);
/** The alpha a re-heat raises the simulation to. Enough to visibly move the
 *  neighbourhood around a dragged node, well below a cold start, so a drag
 *  never costs a full re-settle. */
export const REHEAT_ALPHA = 0.3;

/** Ceiling on the alpha a re-heat may reach, so repeated drags cannot wind the
 *  simulation up towards a permanent full-energy state. */
export const REHEAT_ALPHA_MAX = 0.8;

/**
 * The alpha the simulation is HELD at for the duration of a drag.
 *
 * A drag used to call `reheat()` on every pointermove, which raised alpha to
 * `REHEAT_ALPHA` and reset the tick budget each time. Between moves it decayed
 * again, so the neighbours advanced in pulses — the graph lurched after the
 * pointer instead of following it, which is what reads as staggering.
 *
 * Holding a floor is d3's own `alphaTarget` pattern: the simulation stays warm
 * at a constant, modest temperature for the whole gesture, so every frame
 * advances the neighbours by a similar amount and the motion is continuous.
 * Lower than `REHEAT_ALPHA` deliberately — this is a sustained warmth, not a
 * kick, and a kick repeated sixty times a second is the bug.
 */
export const DRAG_ALPHA = 0.12;

/**
 * How far the held node moves toward the pointer each tick, 0..1.
 *
 * It used to be pinned EXACTLY to the pointer, which makes it infinitely stiff:
 * its neighbours are yanked by the link force rather than pulled, and the node
 * itself has no weight. Easing it means the node trails the cursor slightly and
 * catches up when you slow down — the grabbed thing has mass, and the rest of
 * the graph is drawn along instead of snapped.
 *
 * 0.28 is roughly a 3-frame lag at 60Hz: enough to feel like something is being
 * pulled, short enough that the node is never far from where you are pointing.
 */
export const DRAG_FOLLOW = 0.28;

type SimNode = {
  id: string;
  /** See `LayoutRequest.nodes[].radius`. Absent when the request omitted it;
   *  the collide force resolves the degree-based default once, at initialize. */
  reservedRadius?: number;
  x: number;
  y: number;
  fx: number | null;
  fy: number | null;
};
type SimLink = { source: SimNode; target: SimNode };

/** Lexicographic compare — one helper so the node and edge sorts cannot drift
 *  into two different collations (`localeCompare` is locale-dependent; this is
 *  byte order). */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A running layout: the simulation plus the canonical id order its flat frames
 * are expressed in. `step` advances it, `settled` says whether it has cooled or
 * exhausted its budget, and `reheat`/`hold`/`release` are the three things an
 * interaction can do to it.
 */
export interface LayoutSimulation {
  /** The canonical node order every {@link LayoutSimulation.flat} frame uses. */
  ids: readonly string[];
  /** Advance the simulation by `ticks`. */
  step(ticks: number): void;
  /** Ticks advanced in the current heat cycle (reset by `reheat`). */
  ticks(): number;
  /** Current simulation alpha. */
  alpha(): number;
  /** Whether this cycle is done: cooled below {@link ALPHA_MIN}, or out of
   *  budget. A settled simulation can still be re-heated. */
  settled(): boolean;
  /** Raise the energy so the layout moves again. Never lowers alpha, and never
   *  exceeds {@link REHEAT_ALPHA_MAX}. Resets the cycle's tick budget. */
  reheat(): void;
  /** Hold a node where an interaction put it (d3's `fx`/`fy`), so the rest of
   *  the simulation moves around it. */
  hold(id: string, x: number, y: number): void;
  /**
   * Hold the simulation warm for the duration of a gesture (or let it cool).
   *
   * Separate from `reheat` because they are different shapes: a reheat is an
   * impulse for a discrete event, this is a sustained floor for a continuous
   * one. Calling reheat every frame — which is what a drag used to do — is an
   * impulse train, and it lurches.
   */
  dragWarm(on: boolean): void;
  /** Release a held node, so the link force pulls it back through its
   *  connections. This is what makes a drag a spring rather than a placement. */
  release(id: string): void;
  /** Current positions, in canonical order. */
  positions(): LaidOutNode[];
  /** Current positions as `[x0, y0, x1, y1, …]` in {@link LayoutSimulation.ids}
   *  order, as a FRESH array each call so the caller may transfer its buffer. */
  flat(): Float32Array;
  /** Stop the simulation. */
  stop(): void;
}

/**
 * Build the simulation for `req`. Deterministic for a given
 * `(nodes, edges, seed, forces)`.
 */
export function createLayoutSimulation(req: LayoutRequest): LayoutSimulation {
  const { seed, forces = DEFAULT_FORCES } = req;
  const centre = LAYOUT_BOX / 2;

  const ordered = [...req.nodes].sort((a, b) => compare(a.id, b.id));
  const simNodes: SimNode[] = ordered.map((n) => {
    const p = seedInitialPosition(seed[n.id], n.id);
    return {
      id: n.id,
      reservedRadius: n.radius,
      x: p.x,
      y: p.y,
      fx: null,
      fy: null,
    };
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

  // --- Collide: a hard floor between nodes, which is also what opens the
  // cluster gaps (myne-md/myne#727 task 19) -------------------------------
  //
  // Two jobs, one force, and they turn out to want the same thing. The floor
  // stops two nodes ever touching, which is a property the user can SEE and
  // should never have to ask for. And because the floor grows with degree, a
  // hub, which sits at the middle of its own cluster, insists on room that
  // lands between its cluster and the next one, so tightening the gravity
  // (task 15) no longer costs the clusters their separation.
  //
  // It is a CONSTRAINT rather than a preference, so it runs at full strength
  // and takes the radius from the request instead of inventing one: see
  // `LayoutRequest.nodes[].radius`. The honest community-aware fix is still
  // ForceAtlas2's linLogMode or a Louvain pass, which is a different kernel.
  const degree = new Map<string, number>();
  for (const l of simLinks) {
    degree.set(l.source.id, (degree.get(l.source.id) ?? 0) + 1);
    degree.set(l.target.id, (degree.get(l.target.id) ?? 0) + 1);
  }
  // The floor between two nodes is the sum of their reserved radii plus the
  // padding, which is exactly "two discs that do not touch", and because the
  // caller reserves the LARGEST radius it can draw, it holds for any node-size
  // setting without the layout having to run again.
  const collideRadius = (n: SimNode): number =>
    (n.reservedRadius ?? fallbackReservedRadius(degree.get(n.id) ?? 0)) +
    COLLIDE_PADDING;

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
    // The collision floor, see the comment above.
    .force(
      "collide",
      forceCollide<SimNode>(collideRadius)
        .strength(COLLIDE_STRENGTH)
        .iterations(COLLIDE_ITERATIONS),
    )
    // Per-node gravity toward the centre. See CENTER_GRAVITY: without it the
    // "Center pull" control is inert and an orphan has no force acting on it.
    .force(
      "x",
      forceX<SimNode>(centre).strength(forces.centerStrength * CENTER_GRAVITY),
    )
    .force(
      "y",
      forceY<SimNode>(centre).strength(forces.centerStrength * CENTER_GRAVITY),
    )
    .stop();

  const ids: readonly string[] = ordered.map((n) => n.id);
  let cycleTicks = 0;
  let dragging = false;

  return {
    ids,
    step(ticks) {
      sim.tick(ticks);
      cycleTicks += ticks;
      // Re-assert the floor AFTER ticking: `sim.tick` applies `alphaDecay`, so
      // without this the temperature sags across a long gesture and the graph
      // grows sluggish exactly as the user keeps dragging.
      if (dragging) sim.alpha(Math.max(sim.alpha(), DRAG_ALPHA));
    },
    ticks: () => cycleTicks,
    alpha: () => sim.alpha(),
    // Never settled mid-gesture: the budget exists to stop a runaway cycle, and
    // a drag the user is still performing is not one. Without this the tick
    // budget expires partway through a long drag and the neighbours simply stop
    // following, which reads as the graph going dead in your hand.
    settled: () =>
      !dragging && (sim.alpha() < ALPHA_MIN || cycleTicks >= MAX_TICKS_PER_CYCLE),
    reheat() {
      const raised = Math.max(sim.alpha(), REHEAT_ALPHA);
      sim.alpha(Math.min(raised, REHEAT_ALPHA_MAX));
      cycleTicks = 0;
    },
    hold(id, x, y) {
      const n = byId.get(id);
      if (!n) return;
      // EASE toward the pointer rather than snapping onto it. A node pinned
      // exactly to the cursor is infinitely stiff: the link force yanks its
      // neighbours instead of pulling them, and the node itself reads as
      // weightless. See DRAG_FOLLOW.
      //
      // The first call of a gesture has no previous hold to ease from, so it
      // lands exactly — otherwise the node would visibly slide in from
      // wherever it last sat.
      if (n.fx == null || n.fy == null) {
        n.fx = x;
        n.fy = y;
        return;
      }
      n.fx += (x - n.fx) * DRAG_FOLLOW;
      n.fy += (y - n.fy) * DRAG_FOLLOW;
    },
    dragWarm(on) {
      dragging = on;
      if (on) {
        // Enter at the floor rather than below it, so the first frame of a
        // gesture moves as much as the last.
        sim.alpha(Math.max(sim.alpha(), DRAG_ALPHA));
        cycleTicks = 0;
      }
    },
    release(id) {
      const n = byId.get(id);
      if (n) {
        n.fx = null;
        n.fy = null;
      }
    },
    positions() {
      return simNodes.map((n) => ({ id: n.id, x: n.x, y: n.y }));
    },
    flat() {
      const out = new Float32Array(simNodes.length * 2);
      for (let i = 0; i < simNodes.length; i += 1) {
        out[i * 2] = simNodes[i]!.x;
        out[i * 2 + 1] = simNodes[i]!.y;
      }
      return out;
    },
    stop() {
      sim.stop();
    },
  };
}

/**
 * Run to a settled state and return the final positions. This is the
 * SYNCHRONOUS path, kept for the fallback a host without module workers takes
 * and for tests that want the settled answer in one call; it does not stream
 * and it cannot be re-heated, because it has already stopped by the time it
 * returns. A caller that wants motion uses {@link createLayoutSimulation}.
 */
export function computeGraphLayout(req: LayoutRequest): LayoutResponse {
  const sim = createLayoutSimulation(req);
  while (!sim.settled()) sim.step(TICKS_PER_BURST);
  sim.stop();
  return { positions: sim.positions() };
}

// --- The worker protocol -------------------------------------------------
//
// Shared by both clients' worker entries through `graphLayoutServe.ts`, so the
// message shape has exactly one definition. Positions travel as a transferable
// `Float32Array` in the canonical id order the worker announces once, which is
// what keeps a per-frame message from allocating a string per node.

/** Worker → main thread. */
export type LayoutWorkerMessage =
  | { kind: "ids"; ids: readonly string[] }
  | { kind: "frame"; flat: Float32Array; alpha: number }
  | { kind: "settled"; flat: Float32Array };

/** Main thread → worker. There is deliberately no `stop` variant: the main
 *  thread tears a layout down by terminating the worker, which discards
 *  anything still queued, so a command for it would be dead weight. */
export type LayoutWorkerCommand =
  | { kind: "start"; request: LayoutRequest }
  | { kind: "reheat" }
  | { kind: "hold"; id: string; x: number; y: number }
  | { kind: "release"; id: string }
  | { kind: "dragWarm"; on: boolean };
