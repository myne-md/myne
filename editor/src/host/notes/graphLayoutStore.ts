// Module-level graph layout store (Phase A5 / Tier 3 in-memory tier).
//
// Node positions live OUTSIDE the React render cycle and OUTSIDE the GraphPane
// component lifecycle, so:
//   1. reopening the graph tab (or switching filters) does NOT re-scatter every
//      node — the layout is recognizable, not a fresh random arrangement;
//   2. every (re)layout WARM-STARTS from the previous positions instead of
//      `Math.random()`, so a rebuild gently settles rather than flashing to a
//      brand-new layout (the "flashbang" cause, D in the graph audit).
//
// Keyed by note id (UUID), so a note keeps its place across every graph view
// (whole / tag / local) of the same vault. Cleared on vault lock / switch via
// `clearGraphLayout()` — the Tier 3 disk-persist layer will hydrate this same
// map on unlock and flush it on lock, so this module is the single in-memory
// home for graph positions.

export interface GraphPosition {
  x: number;
  y: number;
}

const positions = new Map<string, GraphPosition>();

/**
 * The virtual box the layout is computed in — a CONSTANT, deliberately not any
 * canvas size, so a phone and a desktop window seed and settle identically
 * (myne-md/myne#200). Lives here because this module owns the seed geometry;
 * `graphLayout.ts` imports it rather than the other way round, which keeps the
 * two files acyclic.
 */
export const LAYOUT_BOX = 1000;

/** Previous position of a node, or `undefined` if it has never been laid out. */
export function getGraphPosition(id: string): GraphPosition | undefined {
  return positions.get(id);
}

/** FNV-1a over the id, as an unsigned 32-bit int. Used only to pick a stable
 *  radius jitter per node — not a hash with any security duty. */
function hashId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The starting position for a node in a (re)layout: its last position (`prev`,
 * a warm start) or a deterministic slot on a jittered ring — angle by index,
 * radius by an id hash, so a cold layout looks scattered rather than like a
 * rigid ring yet is fully reproducible.
 *
 * This used to be `centre + (Math.random() - 0.5) * box`, which had two costs:
 * the same vault re-scattered on every cold layout (so not even two desktops
 * agreed), and no client could ever match another. The single home for the seed
 * math, so the render-time warm start (`GraphCanvas`) and the off-thread kernel
 * (`graphLayout`) can never drift.
 */
export function seedInitialPosition(
  prev: GraphPosition | undefined,
  id: string,
): GraphPosition {
  if (prev !== undefined) return { x: prev.x, y: prev.y };
  const centre = LAYOUT_BOX / 2;
  // A QUARTER of the box, not the rim, and a UNIFORM DISC rather than an
  // annulus (myne-md/myne#727).
  //
  // The old form took the angle from the node's INDEX and jittered the radius
  // between 0.55 and 1.0 of a fixed ring, so every unplaced node started on the
  // same circle. Gravity is proportional to distance, which means a node's
  // equilibrium radius is set by where it started: the entire orphan
  // population then settled onto ONE visible ring around the cloud, evenly
  // spaced like beads, which is the "absurdly even spacing" the maintainer saw.
  // Orphans and connected notes also sat at the same distances, so the picture
  // had no gradient at all.
  //
  // Two independent deterministic draws fix it: the angle from one salt, and
  // `sqrt(u)` for the radius, which is the uniform-area distribution of a disc
  // (a uniform draw in r would pile nodes at the centre). Nothing here uses
  // `Math.random`, so a cold layout is still reproducible.
  const angle = 2 * Math.PI * draw(id, "#angle");
  const r = (LAYOUT_BOX / 4) * Math.sqrt(draw(id, "#radius"));
  return { x: centre + r * Math.cos(angle), y: centre + r * Math.sin(angle) };
}

/** A deterministic 0..1 draw from the id and a salt. The salt is what makes two
 *  properties of one node independent while both stay reproducible. */
function draw(id: string, salt: string): number {
  return (hashId(id + salt) % 1024) / 1024;
}

/**
 * Seed positions for a set of node ids — the warm-start input to a layout run.
 * Only ids with a known previous position are included; a brand-new node is
 * absent (the layout seeds it fresh, e.g. near its neighbours or center+jitter).
 */
export function seedPositions(
  ids: Iterable<string>,
): Record<string, GraphPosition> {
  const seed: Record<string, GraphPosition> = {};
  for (const id of ids) {
    const p = positions.get(id);
    if (p) seed[id] = p;
  }
  return seed;
}

/** Persist laid-out positions after a layout run completes (bulk upsert). */
export function setGraphPositions(
  laid: ReadonlyArray<{ id: string; x: number; y: number }>,
): void {
  for (const n of laid) positions.set(n.id, { x: n.x, y: n.y });
}

/** Whether any positions are currently held (a layout has run this session). */
export function hasGraphLayout(): boolean {
  return positions.size > 0;
}

/**
 * Drop all positions — call on vault lock / switch so vault A's layout never
 * seeds vault B, and so a long session's accumulated positions are released.
 * (Tier 3 flushes to `vault.graph` before clearing.)
 */
export function clearGraphLayout(): void {
  positions.clear();
}

/**
 * Serialize the current positions to the opaque payload string persisted in the
 * encrypted `vault.graph` blob (Tier 3). Compact `[id, x, y]` triples under a
 * schema version so a future format can be recognized and dropped.
 */
export function serializeGraphLayout(): string {
  const pos: Array<[string, number, number]> = [];
  for (const [id, p] of positions) pos.push([id, p.x, p.y]);
  return JSON.stringify({ v: 1, pos });
}

/**
 * Replace the store from a persisted payload (or clear it when `payload` is
 * `null` / malformed). ALWAYS clears first, so hydrating vault B's blob can
 * never leave vault A's positions behind (cross-vault safety). A brand-new node
 * absent from the payload is simply not seeded here — the layout seeds it fresh.
 */
export function hydrateGraphLayout(payload: string | null): void {
  positions.clear();
  if (payload === null) return;
  try {
    const parsed = JSON.parse(payload) as { v?: number; pos?: unknown };
    if (parsed?.v !== 1 || !Array.isArray(parsed.pos)) return;
    for (const entry of parsed.pos) {
      if (
        Array.isArray(entry) &&
        entry.length === 3 &&
        typeof entry[0] === "string" &&
        typeof entry[1] === "number" &&
        typeof entry[2] === "number" &&
        Number.isFinite(entry[1]) &&
        Number.isFinite(entry[2])
      ) {
        positions.set(entry[0], { x: entry[1], y: entry[2] });
      }
    }
  } catch {
    // Malformed payload → leave the store empty (recompute the layout).
  }
}

/** Test-only reset of the module singleton. */
export function __resetGraphLayoutForTest(): void {
  positions.clear();
}
