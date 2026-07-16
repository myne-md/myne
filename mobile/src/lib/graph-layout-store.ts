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

/** Previous position of a node, or `undefined` if it has never been laid out. */
export function getGraphPosition(id: string): GraphPosition | undefined {
  return positions.get(id);
}

/**
 * The starting position for a node in a (re)layout: its last position
 * (`prev`, a warm start) or a fresh center + full-box jitter. The single home
 * for the seed math so the render-time warm start (`GraphCanvas`) and the
 * off-thread layout kernel (`graphLayoutProtocol`) can never drift.
 */
export function seedInitialPosition(
  prev: GraphPosition | undefined,
  cx: number,
  cy: number,
  width: number,
  height: number,
): GraphPosition {
  return prev !== undefined
    ? { x: prev.x, y: prev.y }
    : {
        x: cx + (Math.random() - 0.5) * width,
        y: cy + (Math.random() - 0.5) * height,
      };
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
