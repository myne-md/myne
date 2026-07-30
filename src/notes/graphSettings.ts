// Graph pane settings (graph-connection-ux-polish, task 5) — the physics +
// appearance controls behind the gear in the graph pane. Device-local: lives
// as an additional top-level key on the `NamedWorkspaces` container
// (`src/notes/workspaceState.ts`), NOT in `vault.prefs` (which syncs) and NOT
// in `vault.graph` (a rebuildable, never-synced layout cache) — see the PRD's
// "Persistence split" decision. Mirrors the `expandedFolders` (MYND-455)
// container-level field: window-global, omit-when-default, riding the
// existing MYW1 blob with no format bump.
//
// Task 5 shipped the first control (edge-direction arrows); task 6 extends
// this same shape with the appearance (label fade, node size + strength, line
// thickness) and forces (center, repel, link strength, link distance)
// controls. Each field is independently omit-when-default so a user who only
// ever touches one control still serializes the smallest possible diff from a
// pre-feature descriptor.

export interface GraphSettings {
  /** Render edge-direction arrowheads (still LOD-gated by zoom — this only
   *  gates whether the LOD check runs at all). Default `true`: matches the
   *  graph's pre-feature (always-on) rendering, so a user who never opens the
   *  settings panel sees no visual change. */
  showArrows: boolean;
  /** Zoom level (view scale `k`) at which node labels start rendering — the
   *  LOD threshold `GraphCanvas` had hardcoded before task 6 (1.4 non-coarse /
   *  2.2 coarse-pointer, a ×1.571 scale-up). Lower = labels appear more zoomed
   *  out; higher = need more zoom first. Default `1.4` matches the pre-feature
   *  non-coarse threshold; the coarse-pointer scale-up is preserved on top of
   *  whatever value is set here, so it is not a second persisted field. */
  labelFadeZoom: number;
  /** Base node radius, in graph-space px. Default `5` matches the pre-feature
   *  fixed `NODE_RADIUS` constant. */
  nodeSize: number;
  /** How strongly a note's connection count (degree) grows its radius beyond
   *  `nodeSize` — `0` (off, every node the same size) to `1` (max). Default
   *  `0`: pre-feature rendering had no degree-based sizing. */
  nodeSizeStrength: number;
  /** Edge line-width multiplier. Default `1` matches the pre-feature fixed
   *  `1 / v.k` stroke width. */
  lineThickness: number;
  /** d3-force `forceCenter` strength. Default `1` matches d3's own default
   *  (the pre-feature sim never called `.strength()` on this force). */
  forceCenterStrength: number;
  /** d3-force `forceManyBody` repel magnitude — a positive number, negated
   *  internally before reaching d3 (its charge is negative for repulsion).
   *  Default `120` matches the pre-feature fixed charge of `-120`. */
  forceRepelStrength: number;
  /** d3-force `forceLink` strength. Default `1` — the closest fixed
   *  approximation to d3's own per-edge default (a degree-based fraction ≤ 1)
   *  a single slider can offer; only diverges from it for higher-degree hub
   *  nodes, and only once this control is touched. */
  forceLinkStrength: number;
  /** d3-force `forceLink` distance. Default `60` matches the pre-feature
   *  fixed link distance. */
  forceLinkDistance: number;
}

export const DEFAULT_GRAPH_SETTINGS: Readonly<GraphSettings> = {
  showArrows: true,
  labelFadeZoom: 1.4,
  nodeSize: 5,
  nodeSizeStrength: 0,
  lineThickness: 1,
  forceCenterStrength: 1,
  forceRepelStrength: 120,
  forceLinkStrength: 1,
  forceLinkDistance: 60,
};

/**
 * Encode to a plain object holding ONLY the fields that differ from default
 * (omit-when-default, per field — the same discipline as the tab-modes
 * `pinned`/`stacked`/`viewMode` fields in `workspace-persist.ts`). Returns
 * `undefined` when every field is default, so the caller can drop the whole
 * `graphSettings` key and stay byte-identical to a pre-feature descriptor.
 */
export function encodeGraphSettings(settings: GraphSettings): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  if (settings.showArrows !== DEFAULT_GRAPH_SETTINGS.showArrows) {
    out.showArrows = settings.showArrows;
  }
  if (settings.labelFadeZoom !== DEFAULT_GRAPH_SETTINGS.labelFadeZoom) {
    out.labelFadeZoom = settings.labelFadeZoom;
  }
  if (settings.nodeSize !== DEFAULT_GRAPH_SETTINGS.nodeSize) {
    out.nodeSize = settings.nodeSize;
  }
  if (settings.nodeSizeStrength !== DEFAULT_GRAPH_SETTINGS.nodeSizeStrength) {
    out.nodeSizeStrength = settings.nodeSizeStrength;
  }
  if (settings.lineThickness !== DEFAULT_GRAPH_SETTINGS.lineThickness) {
    out.lineThickness = settings.lineThickness;
  }
  if (settings.forceCenterStrength !== DEFAULT_GRAPH_SETTINGS.forceCenterStrength) {
    out.forceCenterStrength = settings.forceCenterStrength;
  }
  if (settings.forceRepelStrength !== DEFAULT_GRAPH_SETTINGS.forceRepelStrength) {
    out.forceRepelStrength = settings.forceRepelStrength;
  }
  if (settings.forceLinkStrength !== DEFAULT_GRAPH_SETTINGS.forceLinkStrength) {
    out.forceLinkStrength = settings.forceLinkStrength;
  }
  if (settings.forceLinkDistance !== DEFAULT_GRAPH_SETTINGS.forceLinkDistance) {
    out.forceLinkDistance = settings.forceLinkDistance;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Decode an untrusted value into a full `GraphSettings`, defaulting any
 * missing or malformed field rather than rejecting the whole payload — a
 * settings blob is tuning, not integrity-sensitive content, so it fails
 * closed to defaults field-by-field instead of all-or-nothing.
 */
function decodeNumberField(o: Record<string, unknown>, key: keyof GraphSettings): number {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : (DEFAULT_GRAPH_SETTINGS[key] as number);
}

export function decodeGraphSettings(raw: unknown): GraphSettings {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_GRAPH_SETTINGS };
  const o = raw as Record<string, unknown>;
  return {
    showArrows: typeof o.showArrows === "boolean" ? o.showArrows : DEFAULT_GRAPH_SETTINGS.showArrows,
    labelFadeZoom: decodeNumberField(o, "labelFadeZoom"),
    nodeSize: decodeNumberField(o, "nodeSize"),
    nodeSizeStrength: decodeNumberField(o, "nodeSizeStrength"),
    lineThickness: decodeNumberField(o, "lineThickness"),
    forceCenterStrength: decodeNumberField(o, "forceCenterStrength"),
    forceRepelStrength: decodeNumberField(o, "forceRepelStrength"),
    forceLinkStrength: decodeNumberField(o, "forceLinkStrength"),
    forceLinkDistance: decodeNumberField(o, "forceLinkDistance"),
  };
}

/** Effective node radius from base size + degree-based growth — the SINGLE
 *  formula `GraphCanvas` calls for both drawing a node and hit-testing it, so
 *  a click target can never diverge from what is drawn at any size setting
 *  (task 6 acceptance: "hit-testing matches drawn node size at every size
 *  setting"). `degree` is the node's in+out edge count; its contribution is
 *  capped at `maxDegree` so one hub note can't grow (or enlarge its neighbours'
 *  hit targets) without bound. */
export function resolveNodeRadius(
  nodeSize: number,
  nodeSizeStrength: number,
  degree: number,
  maxDegree: number,
): number {
  return nodeSize + nodeSizeStrength * Math.min(degree, maxDegree);
}
