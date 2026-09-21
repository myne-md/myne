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
  /** Whether edge-direction arrowheads may appear, on the HOVERED node's own
   *  edges, still LOD-gated by zoom (myne-md/myne#727). Hover-only because a
   *  picture whose every edge carries a head is a diagram, and at overview zoom
   *  the heads were most of the ink; the question a user actually asks of a
   *  direction is "which way does THIS note's link go", which is about one
   *  node. Default `true`, so the setting reads as a permission rather than as
   *  a feature nobody has: on, the heads answer on hover; off, never. */
  showArrows: boolean;
  /** Zoom level (view scale `k`) at which node labels start rendering — the
   *  LOD threshold `GraphCanvas` had hardcoded before task 6 (1.4 non-coarse /
   *  2.2 coarse-pointer, a ×1.571 scale-up). Lower = labels appear more zoomed
   *  out; higher = need more zoom first. Default `1.4` matches the pre-feature
   *  non-coarse threshold; the coarse-pointer scale-up is preserved on top of
   *  whatever value is set here, so it is not a second persisted field. */
  labelFadeZoom: number;
  /** Base node radius, in graph-space px. Default `6`. The pre-feature fixed
   *  constant was `5`, and it moved to `6` with myne-md/myne#727's curation
   *  pass: at the zoom a few-hundred-note vault fits at, a 5px radius reads as
   *  a speck rather than as a note, and the whole graph reads as zoomed out. */
  nodeSize: number;
  /** How strongly a note's connection count (degree) grows its radius beyond
   *  `nodeSize`, `0` (off, every node the same size) up to
   *  `NODE_SIZE_STRENGTH_RANGE.max`. Default `1.2`, which with the
   *  `MAX_DEGREE_FOR_SIZE` cap of 20 spans 6-30px: the range the mobile renderer
   *  hardcoded before the two clients converged on one (myne-md/myne#200). A hub
   *  note reading MUCH bigger than a leaf is most of what makes a graph
   *  legible, and it is the property the reference implementation is read for:
   *  it scales the most connected nodes up hard enough that the eye finds them
   *  before it reads anything.
   *
   *  It also feeds a TAG node's degree dose, at half the rate, see
   *  `TAG_NODE_DEGREE_DOSE`. One control for "how much does connectivity show in
   *  size" is the right number of controls; a second one for tags would be a
   *  knob nobody could set without seeing both kinds of node at once.
   *
   *  Migration wrinkle, stated rather than buried: the field is
   *  omit-when-default, so a user who deliberately set "no scaling" persisted
   *  NOTHING, and now decodes to `1.2`. Device-local and cosmetic, the control
   *  is one slider away, but it is a silent re-interpretation. */
  nodeSizeStrength: number;
  /** Edge line-width multiplier. Default `1` matches the pre-feature fixed
   *  `1 / v.k` stroke width. */
  lineThickness: number;
  /** d3-force `forceCenter` strength. Default `1` matches d3's own default
   *  (the pre-feature sim never called `.strength()` on this force). */
  forceCenterStrength: number;
  /** d3-force `forceManyBody` repel magnitude — a positive number, negated
   *  internally before reaching d3 (its charge is negative for repulsion).
   *  Default `70`, tightened from `120` with myne-md/myne#727: the settled cloud
   *  used to expand to several times `LAYOUT_BOX`, and the camera fits the
   *  cloud, so a few-hundred-note vault rendered at roughly a third of a
   *  sensible zoom. */
  // (Kept at 70 for the second pass: the spacing ask is answered by the link
  // distance and the collision padding, which change the picture without
  // re-opening the sprawl this constant closed.)
  forceRepelStrength: number;
  /** d3-force `forceLink` strength. Default `1` — the closest fixed
   *  approximation to d3's own per-edge default (a degree-based fraction ≤ 1)
   *  a single slider can offer; only diverges from it for higher-degree hub
   *  nodes, and only once this control is touched. */
  forceLinkStrength: number;
  /** d3-force `forceLink` distance. Default `48`, tightened from the
   *  pre-feature `60` and then raised from `40` with myne-md/myne#727: at 40 a
   *  hub's leaves sat against the collision floor rather than at the link's own
   *  distance, so the link control had nothing left to do at the low end and the
   *  fan read as a ring of beads. */
  forceLinkDistance: number;
}

export const DEFAULT_GRAPH_SETTINGS: Readonly<GraphSettings> = {
  showArrows: true,
  labelFadeZoom: 1.4,
  nodeSize: 6,
  nodeSizeStrength: 1.2,
  lineThickness: 1,
  forceCenterStrength: 1,
  forceRepelStrength: 70,
  forceLinkStrength: 1,
  forceLinkDistance: 48,
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

/**
 * The degree at which a node's radius stops growing (myne-md/myne#727).
 *
 * Lives here, beside the radius formula, because three places need the SAME
 * number and each one is a different kind of wrong if it drifts: the renderer
 * sizes a disc with it, the layout reserves collision room with it, and the
 * reserved-radius formula is evaluated at it. Raised 10 -> 20 with the curation
 * pass, which is what lets a well-connected note read as a landmark rather than
 * as a slightly larger dot.
 */
export const MAX_DEGREE_FOR_SIZE = 20;

/** The bounds the settings panel offers for {@link GraphSettings.nodeSize} and
 *  {@link GraphSettings.nodeSizeStrength}, exported so the panel's sliders and
 *  {@link resolveReservedRadius} cannot disagree about the largest radius this
 *  interface can draw. Two copies is how a slider's max would creep past the
 *  room the layout reserved, and the symptom would be nodes overlapping again
 *  with nothing in the code saying why.
 *
 *  The strength ceiling is 1.5 and not 1, and that is a bug fix rather than a
 *  retune: the default was 1.2 while the slider stopped at 1, so the control
 *  could not reach its own default and dragging it to the end made every node
 *  SMALLER. A setting whose range excludes its default is a setting that
 *  reports success while doing the opposite of what its label says. */
export const NODE_SIZE_RANGE = { min: 3, max: 10 } as const;
export const NODE_SIZE_STRENGTH_RANGE = { min: 0, max: 1.5 } as const;

/**
 * The radius the LAYOUT must reserve for a note of this degree, so that two
 * nodes can never touch (myne-md/myne#727).
 *
 * This is not the drawn radius, it is the LARGEST radius the panel can produce
 * for this degree, over the whole range of both size controls. Reserving the
 * maximum is what lets the collision floor be a property of the LAYOUT while
 * the drawn radius stays a REPAINT-ONLY setting: a user who drags node size to
 * its maximum cannot make a node grow past the room already reserved for it, so
 * nothing overlaps and no re-layout is needed. Reserving the drawn radius
 * instead would tie the two together, and every size-slider drag would have to
 * re-run the layout, which is the contract `graph-settings` pins as never
 * happening.
 *
 * The cost is stated: at low degrees this reserves a few units more than a
 * default-styled node is drawn at (a degree-0 note reserves 10 and is drawn at
 * 6), so the default graph is a little looser than its ink requires. That is
 * the price of a hard "never touch" guarantee, and it is the right side to err
 * on: a graph that is slightly loose reads; two nodes merged into one blob
 * does not.
 */
export function resolveReservedRadius(degree: number, maxDegree: number): number {
  return resolveNodeRadius(
    NODE_SIZE_RANGE.max,
    NODE_SIZE_STRENGTH_RANGE.max,
    degree,
    maxDegree,
  );
}

/**
 * How much larger a TAG node is than the base node radius (myne-md/myne#727).
 *
 * A tag node's degree is its note count, which is a different quantity from a
 * note's link count: a tag over sixty notes is ordinary, a note with sixty links
 * is a landmark. So a tag hub must NOT grow at the note rate, or the biggest tag
 * in a vault would be the largest object on screen by an order of magnitude,
 * the "planet" the tag-node plan warned about.
 *
 * It must still grow, though, and that is the correction this constant set
 * carries. The first version gave a tag node a size that ignored its degree
 * ENTIRELY (`nodeSize * 1.6`), so a tag over sixty notes drew at 9.6 against
 * leaves at 8.4, a hub indistinguishable from its own spokes, which is exactly
 * what a user reported. The answer was never "no degree term"; it was a GENTLER
 * one with a LOWER cap, which is what these three constants are.
 *
 * At the shipped defaults (nodeSize 6, strength 1.2) that is 9.6 at degree 0 and
 * 16.8 from degree 12 up: a tag hub reads as roughly twice a leaf's diameter,
 * stays smaller than a well-connected NOTE (which reaches 30), and cannot run
 * away. `TAG_NODE_DEGREE_DOSE` is expressed as a fraction of the note dose so
 * the relationship between the two is readable at the definition.
 */
export const TAG_NODE_RADIUS_FACTOR = 1.6;
export const TAG_NODE_DEGREE_DOSE = 0.5;
export const TAG_NODE_MAX_DEGREE = 12;

/** The radius of a tag node. Same shape as {@link resolveNodeRadius}, a base
 *  plus a capped degree term, with its own gentler dose and lower cap; see
 *  {@link TAG_NODE_RADIUS_FACTOR} for why it must not use the note's. */
export function resolveTagNodeRadius(
  nodeSize: number,
  nodeSizeStrength: number,
  degree: number,
): number {
  return (
    nodeSize * TAG_NODE_RADIUS_FACTOR +
    nodeSizeStrength *
      TAG_NODE_DEGREE_DOSE *
      Math.min(degree, TAG_NODE_MAX_DEGREE)
  );
}

/** What the layout reserves for a tag node, the largest radius
 *  {@link resolveTagNodeRadius} can produce over the panel's whole range, for
 *  the same reason {@link resolveReservedRadius} reserves the largest for a
 *  note. Evaluated at `TAG_NODE_MAX_DEGREE` because the drawn radius is capped
 *  there, so a tag with ten thousand notes reserves no more than one with
 *  twelve. */
export function resolveReservedTagNodeRadius(): number {
  return resolveTagNodeRadius(
    NODE_SIZE_RANGE.max,
    NODE_SIZE_STRENGTH_RANGE.max,
    TAG_NODE_MAX_DEGREE,
  );
}
