// THE graph renderer — one canvas for every client (myne-md/myne#200).
//
// It used to be two: this Canvas 2D renderer on desktop and an SVG one on
// mobile, which is why the two clients disagreed on node colour, radius, label
// placement, arrowheads, zoom limits and opening camera. SVG also stopped
// scaling once #199 made mobile render orphans too — one `<g>`, `<circle>` and
// `<text>` per note, with nothing culled at fit zoom.
//
// PARAMETERIZED by `model` (SYNC-16) so local-graph (#5) reuses it with a
// BFS-bounded subgraph. Layout computes node POSITIONS only; render, pan/zoom,
// hit-test and drag are ours (the d3 dependency is scoped to the genuinely-hard
// n-body math — dependency-policy.md Q1).
//
// Scale posture (SYNC-12): the layout runs a BOUNDED tick budget then FREEZES
// (no perpetual rAF loop), OFF the main thread in a Worker — the WebView never
// blocks on it — and positions WARM-START from `graphLayoutStore` so a re-layout
// settles instead of re-scattering (the "flashbang" cause). Directed edges
// (arrowheads) preserve who-links-whom. Navigation-only: click opens; node-drag
// is persisted so a manual arrangement survives filter switches / reopens.
//
// TWO THINGS ARE INJECTED because they cannot be shared:
//   - `makeWorker`, because `new Worker(new URL(…, import.meta.url))` has to be
//     statically analysable by the bundler compiling each client;
//   - `onPositionsChanged`, because persistence is per-client (desktop flushes
//     through the platform seam, mobile straight to Tauri). The layout STORE is
//     shared — it is a module singleton — so only the flush trigger crosses.

import { useEffect, useMemo, useRef, useState } from "react";
import type { GraphEdge, GraphModel, GraphNode } from "./graphModel";
import {
  getGraphPosition,
  seedInitialPosition,
  seedPositions,
  setGraphPositions,
  type GraphPosition,
} from "./graphLayoutStore";
import {
  DEFAULT_GRAPH_SETTINGS,
  MAX_DEGREE_FOR_SIZE,
  resolveNodeRadius,
  resolveReservedRadius,
  resolveReservedTagNodeRadius,
  resolveTagNodeRadius,
} from "./graphSettings";
import type { LaidOutNode, LayoutRequest } from "./graphLayout";
import {
  startLayout,
  type LayoutHandle,
  type LayoutStreamHandlers,
} from "./graphLayoutRun";
import {
  classifyRelease,
  crossedDragThreshold,
} from "./graphPointerPolicy";
import {
  buildHoverHighlight,
  edgeIsLit,
  highlightAlpha,
  nodeIsLit,
  type HoverHighlight,
} from "./graphHover";
import { CAMERA_TWEEN_MS, tweenTransform } from "./graphCameraTween";
import { clampK, fitTransform } from "./graphCamera";
import { isEdgeVisible, isNodeVisible, visibleBounds } from "./graphCulling";

/** A model's content as one string: ids and kinds in order, plus the edges. The
 *  canvas rebuilds on this and not on the prop's identity. */
function graphModelContentKey(model: GraphModel): string {
  return (
    model.nodes.map((n) => `${n.id}:${n.kind ?? "note"}`).join(",") +
    "|" +
    model.edges.map((e) => `${e.source}>${e.target}`).join(",")
  );
}

type SimNode = GraphNode & { x: number; y: number };
type SimLink = { source: SimNode; target: SimNode; weight: number };

// A color-group key is a bare design-token name (`group-teal`), resolved as
// `--group-teal` off the canvas's own computed style — so group colors follow
// the theme, dark mode and a custom theme's token override exactly like the
// neutral node color does. The shape check keeps a rule authored by a future
// (or malformed) client from reaching the CSSOM lookup as an arbitrary string;
// anything it rejects — or any token that resolves empty — falls back to the
// neutral color, which is the same forward-compat degrade the rule evaluator
// applies to an unsupported filter leaf.
const COLOR_KEY_SHAPE = /^[a-z0-9][a-z0-9-]*$/;

/** How long the arrival reveal takes, in ms (myne-md/myne#727). Short and
 *  deliberately below the ~700ms where an entrance starts to read as waiting:
 *  the point is that the graph ARRIVES rather than appearing, not that anyone
 *  watches it arrive. */
const REVEAL_MS = 520;
/** How much of the reveal window is spent staggering node start times, as a
 *  fraction. At 0.55 the first node starts immediately and the last starts just
 *  past the midpoint, so the fill-in reads as a wave without any node being
 *  visibly late. */
const REVEAL_STAGGER = 0.55;
/** How a node's radius eases in: `t^2` out of zero, so a node grows fast once it
 *  starts and settles gently. A linear ramp reads as a zoom, this reads as a
 *  pop. */
const revealEase = (t: number): number => t * t * (3 - 2 * t);
/**
 * Where a label's fade-IN starts, as a fraction of `labelFadeZoom`.
 *
 * A reference implementation fades its note titles in over a zoom range rather
 * than snapping them on at a threshold, and the snap is what made ours read as a
 * mode change instead of an approach (myne-md/myne#727). The shape matters: the
 * fade runs UP TO the setting rather than starting at it, so `labelFadeZoom`
 * keeps meaning exactly what it always meant, "labels are fully on at this
 * zoom", and the fade is a lead-in below it. Starting the fade AT the threshold
 * would have made the shipped default (1.4) draw labels at 12% opacity on a
 * small vault, where the camera's fit-to-content zoom lands at the 1.5 cap: a
 * threshold and a band that overlap is how a setting stops describing anything.
 *
 * At 0.5 the fade spans from half the threshold to the threshold, which at the
 * default 1.4 is a wide, gradual 0.7-to-1.4 approach.
 */
const LABEL_FADE_LEAD_IN = 0.5;

export default function GraphCanvas({
  model,
  makeWorker,
  onPositionsChanged,
  onNodeClick,
  onNodeDoubleClick,
  nodeColors,
  arrowsEnabled = DEFAULT_GRAPH_SETTINGS.showArrows,
  labelFadeZoom = DEFAULT_GRAPH_SETTINGS.labelFadeZoom,
  nodeSize = DEFAULT_GRAPH_SETTINGS.nodeSize,
  nodeSizeStrength = DEFAULT_GRAPH_SETTINGS.nodeSizeStrength,
  lineThickness = DEFAULT_GRAPH_SETTINGS.lineThickness,
  forceCenterStrength = DEFAULT_GRAPH_SETTINGS.forceCenterStrength,
  forceRepelStrength = DEFAULT_GRAPH_SETTINGS.forceRepelStrength,
  forceLinkStrength = DEFAULT_GRAPH_SETTINGS.forceLinkStrength,
  forceLinkDistance = DEFAULT_GRAPH_SETTINGS.forceLinkDistance,
  ariaLabel,
}: {
  model: GraphModel;
  /** Construct the layout worker. Injected: only the client's own bundler can
   *  resolve `new URL("./x.worker.ts", import.meta.url)`. */
  makeWorker: () => Worker;
  /** Called after positions were written to the shared store (a completed
   *  layout, or a node drag). Each client wires its own debounced flush to
   *  `vault.graph`; the store itself is shared. */
  onPositionsChanged?: () => void;
  /** Single click on a node — navigate (whole graph) or pivot (local graph). */
  onNodeClick: (id: string) => void;
  /** Double click — the terminal navigate in local-graph (pivot vs navigate,
   *  SYNC-6: a pivot must NOT carry ctx.open's side-effects). Omit in the whole
   *  graph (where a single click already navigates). */
  onNodeDoubleClick?: (id: string) => void;
  /** Color groups (graph-connection-ux-polish task 8): note id → color-group
   *  KEY (a bare `--group-*` token name), as resolved by
   *  `resolveGraphColorGroups`. A node absent from the map keeps the neutral
   *  color, so unclassified notes recede.
   *
   *  Load-bearing: color is a RENDER-TIME LAYER, never part of the layout
   *  model. `GraphNode` stays `{id,title}`, this map is read live via a ref,
   *  and a rule edit repaints through the settings-keyed effect below — it
   *  never touches `model`, so it can never re-run the layout. */
  nodeColors?: ReadonlyMap<string, string>;
  /** Edge-direction arrows toggle (graph settings panel, graph-connection-ux-
   *  polish task 5). Gates the existing zoom-LOD arrow check entirely — off
   *  means never, on means "when zoomed in enough", matching the pre-feature
   *  behavior (default `true`). RENDER-TIME ONLY: toggling schedules one
   *  repaint via the `arrowsEnabled`-keyed effect below; it never touches
   *  `model` and so never re-runs the layout/worker. */
  arrowsEnabled?: boolean;
  /** Appearance controls (graph settings panel, task 6). All four are
   *  RENDER-TIME ONLY, exactly like `arrowsEnabled` — read live via refs and
   *  repainted by the single settings-keyed effect below, never touching
   *  `model` and so never re-running the layout/worker. */
  labelFadeZoom?: number;
  nodeSize?: number;
  nodeSizeStrength?: number;
  lineThickness?: number;
  /** Force controls (graph settings panel, task 6). Changing one DOES re-run
   *  the bounded layout — the user is explicitly asking for a different
   *  arrangement — warm-started from the nodes' current positions (see the
   *  dedicated effect below), then freezes like every other layout run. */
  forceCenterStrength?: number;
  forceRepelStrength?: number;
  forceLinkStrength?: number;
  forceLinkDistance?: number;
  /** Accessible name for the canvas (myne-md/myne#727). Supplied by the client
   *  because the string is localized, and this component deliberately carries no
   *  i18n of its own. With it the canvas is announced as a picture; WITHOUT it
   *  the element is a blank region that assistive technology has to walk into
   *  and find nothing, which is why the clients that render this are expected to
   *  pass one. The readable alternative to the picture is the graph's list
   *  view, which is a separate rendering of the same model. */
  ariaLabel?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Pan/zoom view transform + the laid-out nodes, in refs so the render loop and
  // pointer handlers share them without re-rendering React.
  const viewRef = useRef({ x: 0, y: 0, k: 1 });
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  // The click callbacks in a ref so the layout/render effect does NOT re-run
  // (and re-scatter the graph) every time the parent re-renders and hands down
  // fresh callback identities — the effect keys on `model` ALONE.
  const cbRef = useRef({ onNodeClick, onNodeDoubleClick, onPositionsChanged });
  cbRef.current = { onNodeClick, onNodeDoubleClick, onPositionsChanged };
  // `arrowsEnabled` read live by the render loop via this ref (same reason as
  // `cbRef`), and a SEPARATE effect below schedules a repaint when it changes
  // — without re-running the `[model]` effect that owns the worker/simulation.
  const arrowsEnabledRef = useRef(arrowsEnabled);
  arrowsEnabledRef.current = arrowsEnabled;
  // The four appearance controls, same "read via ref, repaint via a sibling
  // effect" shape as `arrowsEnabledRef` above — RENDER-TIME ONLY, never
  // re-entering the `[model]` effect.
  const labelFadeZoomRef = useRef(labelFadeZoom);
  labelFadeZoomRef.current = labelFadeZoom;
  const nodeSizeRef = useRef(nodeSize);
  nodeSizeRef.current = nodeSize;
  const nodeSizeStrengthRef = useRef(nodeSizeStrength);
  nodeSizeStrengthRef.current = nodeSizeStrength;
  const lineThicknessRef = useRef(lineThickness);
  lineThicknessRef.current = lineThickness;
  // The color-group map, same ref-read/sibling-effect-repaint shape — so a rule
  // edit repaints without re-entering the `[model]` effect.
  const nodeColorsRef = useRef(nodeColors);
  nodeColorsRef.current = nodeColors;
  // The resolved hover highlight (myne-md/myne#727), read live by the render
  // pass through this ref for the same reason as `nodeColorsRef`: a hover is a
  // repaint, and it must never re-enter the `[model]` effect (which would
  // re-run the layout) or commit React state per mouse move.
  const hoverRef = useRef<HoverHighlight | null>(null);
  // Whether the user asked the operating system for reduced motion. A ref,
  // because the camera paths inside the `[model]` effect read it and must not
  // re-run that effect when the preference changes. The gate has to be here
  // rather than in CSS: a media query cannot reach a canvas, which is drawn by
  // script, so the global reduced-motion rule does not cover any of this.
  const reduceMotionRef = useRef(false);
  const scheduleRef = useRef<(() => void) | null>(null);
  // Bumped whenever the canvas re-resolves its design tokens (mount + every
  // theme change). Reflected onto `data-palette-nonce` as bounded E2E
  // observability for "the colors followed the theme" — a monotonic counter,
  // never a note id or a coordinate (SYNC-8 DENY-list clean).
  const [paletteNonce, setPaletteNonce] = useState(0);
  // The force-relayout contract's two observable halves (task 6), same bounded
  // shape as `paletteNonce` above — integers only, never an id or a coordinate:
  //   runs   — how many force-driven re-layouts have COMPLETED. A force change
  //            must take it up by exactly ONE and then stop; an appearance
  //            change must never move it at all.
  //   seeded — how many nodes the LATEST force re-layout warm-started from
  //            their live positions. Equal to the node count means every node
  //            carried its place into the run; `seedInitialPosition` only
  //            randomizes a node the request did NOT seed, so this is the
  //            warm-start-vs-re-scatter question in one number.
  const [forceRelayoutRuns, setForceRelayoutRuns] = useState(0);
  const [forceRelayoutSeeded, setForceRelayoutSeeded] = useState(0);
  // Whether a layout run is outstanding. `false` while the kernel is working,
  // `true` once its positions are applied — and immediately `true` for a fully
  // restored layout, which runs nothing at all. One boolean, no coordinates:
  // the SYNC-8 shape (myne-md/myne#200).
  const [layoutSettled, setLayoutSettled] = useState(false);
  // How many times the `[model]` effect has run, i.e. how many times this
  // canvas has been TORN DOWN and rebuilt (worker, listeners, camera). An
  // appearance or color change must never move it; a force change must not
  // either (that is the separate effect below). It exists because the pane's
  // own `data-layout-nonce` counts GraphView's BUILD effect, which is a
  // different event, and the two came apart with task 18: a tag node arriving
  // changes the canvas's model without changing what the pane built.
  //
  // Written IMPERATIVELY onto the element, like `data-view-x/y/k` below and for
  // the same reason: it is a diagnostic that changes once per model, and
  // committing React state for it would re-render this component for nothing.
  const modelNonceRef = useRef(0);
  // Per-node degree (in + out), computed once per model build — the input to
  // `radiusOf` alongside the live `nodeSize`/`nodeSizeStrength` refs.
  const degreeRef = useRef<Map<string, number>>(new Map());
  // Whether the camera has been framed for this set of NOTES. A ref rather than
  // a closure local inside the `[model]` effect, and the distinction is
  // load-bearing since task 18: adding a TAG node rebuilds the model, same
  // notes, one more hub, and refitting then would move the view out from under
  // a user who is looking at it. A genuine filter change changes the NOTE set,
  // and that IS a new picture worth framing. Only tag nodes are ignored here; a
  // note arriving (a re-layout after an import) refits, as it always did.
  //
  // It is declared HERE, in the component's hook block, rather than beside the
  // code that reads it: a hook called inside an effect callback is a
  // Rules-of-Hooks violation, and React throws "Invalid hook call" at runtime
  // the moment the effect runs. Nothing static catches that, tsc, the build
  // and every pure unit test stay green, and the throw lands on the app-root
  // error boundary, which is the whole-workspace fail-closed card. Only a real
  // mount of this component reaches it.
  const fittedKeyRef = useRef<string | null>(null);
  // How many times this instance has framed the camera. A bounded count, never
  // a note id (SYNC-8 class, same as the nonces), written to `data-fit-count`
  // so a canvas test can hold the note-set keying contract: adding a hub must
  // NOT bump it, adding a note must. jsdom's zero-size canvas makes the fitted
  // transform itself unobservable (it clamps to the floor), so the count is the
  // only fixture that can hold that defect.
  const fitCountRef = useRef(0);
  // The four force settings the model effect's `requestFrom` must read. That
  // effect deliberately does NOT depend on them (a slider drag would tear the
  // whole canvas down and rebuild it), so it reads them through a ref instead
  // of closing over the values it saw when the model first built. Without this
  // a drag re-heat after a force change re-heated under the OLD constants,
  // because `ensureLiveLayout` was created in the `[modelKey]` run.
  const forcesRef = useRef({
    forceCenterStrength,
    forceRepelStrength,
    forceLinkStrength,
    forceLinkDistance,
  });
  forcesRef.current = {
    forceCenterStrength,
    forceRepelStrength,
    forceLinkStrength,
    forceLinkDistance,
  };
  // Whether the arrival reveal has already played on this component instance.
  // See the reveal block in the `[model]` effect: the entrance is for the FIRST
  // model only, so switching a filter does not replay it.
  const revealedRef = useRef(false);

  // The canvas's current CSS box, kept live so the forces-relayout effect
  // (below) can size a fresh `LayoutRequest` without re-reading the DOM.
  const sizeRef = useRef({ width: 0, height: 0 });
  // The model's CONTENT, as one string, and the model itself behind it.
  //
  // The `[modelKey]` effect below is the only thing that tears this canvas down
  // and re-runs the layout, and it is keyed on CONTENT rather than on the prop's
  // identity. That is deliberate and it is the canvas's call to make: the layout
  // is what a rebuild costs, so the canvas, not its caller, should decide when
  // the model has changed. A caller that re-renders with an equal-but-new object
  // (a colour-rule edit that rebuilt the node list, a state object replaced
  // wholesale) used to cost a full teardown and a re-layout, which is the
  // repaint-only contract `gc1` pins as never happening (myne-md/myne#727).
  const modelKey = useMemo(() => graphModelContentKey(model), [model]);
  const latestModelRef = useRef(model);
  latestModelRef.current = model;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;
    const model = latestModelRef.current;
    modelNonceRef.current += 1;
    canvas.dataset["canvasModelNonce"] = String(modelNonceRef.current);

    // A rebuilt model invalidates any highlight resolved against the old link
    // set, so it starts clear. (`hoveredId` is a fresh local on every run.)
    hoverRef.current = null;

    // Resolve design tokens for the canvas (2D context needs concrete color
    // strings, not CSS vars) — so the graph follows the palette + dark mode
    // instead of hardcoded hex. `cs` is LIVE (getComputedStyle returns a view,
    // not a snapshot), so a re-read after a theme change yields the new values;
    // only the memoized strings below need invalidating, which is what the
    // theme observer at the end of this effect does.
    const cs = getComputedStyle(canvas);
    const token = (name: string, fallback: string) =>
      cs.getPropertyValue(name).trim() || fallback;
    let colNode = token("--fg-2", "#7a7a7a");
    // The edge colour is `--line-3`, not `--line-1`. `--line-1` is the hairline
    // BORDER colour: in dark mode that is #2c2b28, which reads as texture rather
    // than as a link, and the graph stops looking like a network (myne-md/myne#727).
    // `--line-3` is the strongest of the line ramp (#5a5852 dark, #a3a29c light)
    // and lands where a reference implementation's edges sit: clearly visible,
    // still quieter than the labels.
    let colEdge = token("--line-3", "#5a5852");
    let colLabel = token("--fg-3", "#bdbdbd");
    // The vault's accent, used for a hover's own edges and the ring on the
    // hovered node. It is a token rather than a literal so a custom theme
    // repaints the highlight with the rest of the interface. Its fallback is
    // another resolved token rather than a hex of its own: a missing accent
    // means the token sheet did not load, in which case every colour here is
    // already a fallback and one more literal would only be counted by
    // `check-token-adoption` for a value that is not a colour choice.
    let colAccent = token("--accent", colNode);
    // Labels are drawn in the interface's own family rather than in a generic
    // `sans-serif`, so the graph reads as part of the app. Read off the canvas's
    // computed style, which inherits the app font.
    let labelFont = cs.fontFamily.trim() || "sans-serif";
    // Group-color keys resolve lazily and are memoized per theme — only the
    // handful of keys the current rule set actually uses is ever looked up.
    const groupColors = new Map<string, string | null>();
    const groupColor = (key: string): string | null => {
      const cached = groupColors.get(key);
      if (cached !== undefined) return cached;
      const resolved = COLOR_KEY_SHAPE.test(key)
        ? cs.getPropertyValue(`--${key}`).trim() || null
        : null;
      groupColors.set(key, resolved);
      return resolved;
    };
    const resolveTokens = () => {
      colNode = token("--fg-2", "#7a7a7a");
      colEdge = token("--line-3", "#5a5852");
      colLabel = token("--fg-3", "#bdbdbd");
      colAccent = token("--accent", colNode);
      labelFont = cs.fontFamily.trim() || "sans-serif";
      groupColors.clear();
      setPaletteNonce((n) => n + 1);
    };

    // Coarse-pointer (touch / mobile) → tighter LOD thresholds (less to draw).
    const coarse =
      window.matchMedia?.("(pointer: coarse)")?.matches === true;

    // Size the backing store to the element (DPR-aware) and cache the CSS box.
    // Culling reads that box every frame, so never call getBoundingClientRect in
    // the render loop; it forces a layout reflow.
    //
    // `dpr` is re-read here rather than frozen at mount, and `render()` reads
    // this same binding for its `ctx.scale`, so the two can never disagree. It
    // is insurance rather than a guarantee: a move to a display of a different
    // density that leaves the element's box alone fires no resize notification
    // at all, so the new ratio is picked up by whatever resizes the canvas next.
    //
    // The boolean return is an OPTIMISATION, not a correctness condition. Two
    // notifications arrive on a box this function has already measured (the one
    // `observe()` delivers immediately, and a transition's tail frame at the
    // settled size), and each would otherwise reallocate the backing store, a
    // zero-fill of the whole surface, and queue a pixel-identical repaint.
    // Nothing depends on it being here: what makes those notifications SAFE is
    // that `onResize` only ever repaints, never refits.
    //
    // **The early return also skips the `sizeRef` write, which is the one side
    // effect here that is not a repaint**, so "optimisation" is not the whole
    // story and the case worth naming is the one where the two disagree.
    // `cssW`/`cssH` are closure-local and reset to 0 on every `[model]` re-run,
    // while `sizeRef` is a component ref only this function writes. A re-run
    // that measures the canvas at 0x0 therefore returns early, and `sizeRef`
    // keeps the PREVIOUS run's box while this closure believes 0x0. Culling and
    // pointer hit-testing read `sizeRef`, so for that window they use the older
    // box. It is left that way deliberately: writing before the return would
    // put {0,0} there instead, which is what the unconditional version did and
    // is not the better of the two, and the next notification corrects it
    // either way.
    let dpr = window.devicePixelRatio || 1;
    let cssW = 0;
    let cssH = 0;
    const resize = (): boolean => {
      const nextDpr = window.devicePixelRatio || 1;
      const r = canvas.getBoundingClientRect();
      if (r.width === cssW && r.height === cssH && nextDpr === dpr) return false;
      dpr = nextDpr;
      cssW = r.width;
      cssH = r.height;
      sizeRef.current = { width: cssW, height: cssH };
      canvas.width = Math.max(1, Math.floor(r.width * dpr));
      canvas.height = Math.max(1, Math.floor(r.height * dpr));
      return true;
    };
    resize();

    // Node objects for render/hit-test. WARM-START from the layout store: a
    // node keeps its last position (continuity, no re-scatter); a brand-new
    // node seeds onto the deterministic ring until the layout settles it. The
    // seed runs in the kernel's fixed virtual box, NOT the canvas box — the
    // camera below is what maps that geometry onto this screen.
    const nodes: SimNode[] = model.nodes.map((n) => {
      const p = seedInitialPosition(getGraphPosition(n.id), n.id);
      return { ...n, x: p.x, y: p.y };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: SimLink[] = model.edges
      .map((e: GraphEdge) => {
        const source = byId.get(e.source);
        const target = byId.get(e.target);
        return source && target
          ? { source, target, weight: e.weight }
          : null;
      })
      .filter((l): l is SimLink => l !== null);
    nodesRef.current = nodes;
    linksRef.current = links;

    // Degree (in + out) per node — the input to `radiusOf`'s connectivity
    // term. Computed once per model build; unaffected by appearance-setting
    // changes (only their weight, `nodeSizeStrengthRef`, changes live).
    const degree = new Map<string, number>();
    for (const l of links) {
      degree.set(l.source.id, (degree.get(l.source.id) ?? 0) + 1);
      degree.set(l.target.id, (degree.get(l.target.id) ?? 0) + 1);
    }
    degreeRef.current = degree;
    // --- Arrival reveal (myne-md/myne#727) -------------------------------
    // The graph should ARRIVE, not appear. Only on this component instance's
    // FIRST model: a filter change is a different view of the same graph, and
    // replaying an entrance every time the user switches a filter would be the
    // distracting thing this is meant not to be.
    const revealRank = new Map(nodesRef.current.map((n, i) => [n.id, i]));
    const nodeTotal = Math.max(1, nodesRef.current.length);
    let reveal = revealedRef.current ? 1 : 0;
    const revealStart = performance.now();
    /** How far a single node has come in, 0..1. Staggered by the node's rank so
     *  the graph fills in rather than switching on; reduced motion skips it. */
    const revealOf = (id: string): number => {
      if (reveal >= 1) return 1;
      const start = ((revealRank.get(id) ?? 0) / nodeTotal) * REVEAL_STAGGER;
      return revealEase(Math.min(1, Math.max(0, (reveal - start) / (1 - REVEAL_STAGGER))));
    };
    /** The radius actually drawn, which is the full one once revealed. The
     *  HIT radius stays the full one, so a click during the half-second
     *  entrance lands where the user aimed rather than on a shrunken target. */
    const drawnRadiusOf = (n: SimNode) => radiusOf(n) * revealOf(n.id);
    // A tag node has its own radius rather than the degree-scaled one: its
    // degree is its note count, so the degree term would make a popular tag a
    // planet (see `TAG_NODE_RADIUS_FACTOR`). Every drawn radius and every hit
    // radius goes through here, so a tag's click target matches its disc.
    const radiusOf = (n: SimNode) =>
      n.kind === "tag"
        ? // A tag node's degree is its note count, so it grows at its own
          // gentler dose and lower cap, see `TAG_NODE_RADIUS_FACTOR`.
          resolveTagNodeRadius(
            nodeSizeRef.current,
            nodeSizeStrengthRef.current,
            degreeRef.current.get(n.id) ?? 0,
          )
        : resolveNodeRadius(
            nodeSizeRef.current,
            nodeSizeStrengthRef.current,
            degreeRef.current.get(n.id) ?? 0,
            MAX_DEGREE_FOR_SIZE,
          );
    // The space the layout must reserve around each node so no two can touch
    // (myne-md/myne#727). Deliberately NOT `radiusOf`: this is the largest
    // radius the settings panel can produce, so it stays true for any
    // node-size setting, which is what keeps an appearance change a repaint
    // rather than a re-layout. See `resolveReservedRadius`.
    const reservedRadiusOf = (n: SimNode) =>
      n.kind === "tag"
        ? resolveReservedTagNodeRadius()
        : resolveReservedRadius(
            degreeRef.current.get(n.id) ?? 0,
            MAX_DEGREE_FOR_SIZE,
          );

    // Render immediately at warm-start positions (never a blank frame), then
    // compute the settled layout OFF the main thread. The worker cannot call
    // Tauri IPC, so it only receives this already-resolved model + seed.
    let raf = 0;
    let layoutCancelled = false;
    let layout: LayoutHandle | null = null;
    const nodeIds = model.nodes.map((n) => n.id);
    const seed = seedPositions(nodeIds);

    // Write a frame's positions onto the live node objects. The simulation
    // streams while it is hot, so this runs many times per settle; it never
    // allocates node objects, because the renderer and the pointer handlers
    // hold references into `nodesRef.current`.
    //
    // A node the user is currently dragging is SKIPPED. The pointer is the
    // authority for where that node is while it is held, and a frame that was
    // computed before the hold reached the worker would otherwise snap it back
    // under the finger. The worker's own frames agree with the pointer once the
    // hold lands, so nothing is lost by ignoring them in the meantime.
    const applyPositions = (positions: LaidOutNode[]) => {
      const pos = new Map(positions.map((p) => [p.id, p]));
      for (const n of nodesRef.current) {
        if (n.id === draggingId) continue;
        const p = pos.get(n.id);
        if (p !== undefined) {
          n.x = p.x;
          n.y = p.y;
        }
      }
    };

    // The node the pointer is currently holding, if any. Set on the first
    // movement that crosses the drag threshold and cleared on pointer up.
    let draggingId: string | null = null;
    // Whether this run should frame the camera. See `fittedKeyRef` in the hook
    // block above for why the key is the NOTE set rather than the node set.
    const noteKey = model.nodes
      .filter((n) => n.kind !== "tag")
      .map((n) => n.id)
      .join("\u0000");
    const shouldFit = fittedKeyRef.current !== noteKey;
    if (shouldFit) {
      fittedKeyRef.current = noteKey;
      fitCountRef.current += 1;
      canvas.dataset["fitCount"] = String(fitCountRef.current);
    }

    /** The request for a run seeded from a given position map. */
    const requestFrom = (from: Record<string, GraphPosition>): LayoutRequest => ({
      nodes: nodesRef.current.map((n) => ({
        id: n.id,
        radius: reservedRadiusOf(n),
      })),
      edges: model.edges.map((e) => ({ source: e.source, target: e.target })),
      seed: from,
      // Force settings as of NOW, not as of this effect's own run: a LIVE change
      // to one of them is handled by the separate `[forceCenterStrength, ...]`
      // effect below, and a drag re-heat started later must use the values in
      // force, not the ones captured when the model first built. Read through a
      // ref for that reason (`forcesRef`).
      forces: {
        centerStrength: forcesRef.current.forceCenterStrength,
        repelStrength: forcesRef.current.forceRepelStrength,
        linkStrength: forcesRef.current.forceLinkStrength,
        linkDistance: forcesRef.current.forceLinkDistance,
      },
    });

    /**
     * The stream callbacks a run needs. `fit` is the only thing that differs
     * between callers: the first cold layout frames its result, and a layout
     * woken by an interaction must never move the camera, because the user is
     * looking at it.
     */
    const streamHandlers = (fit: boolean): LayoutStreamHandlers => ({
      // Repaint at the simulation's pace, so the settle is visible rather than
      // appearing all at once.
      onFrame: (positions) => {
        if (layoutCancelled) return;
        applyPositions(positions);
        schedule();
      },
      onSettled: (positions) => {
        if (layoutCancelled) return;
        applyPositions(positions);
        setGraphPositions(positions); // persist for warm-start next open
        cbRef.current.onPositionsChanged?.(); // debounced flush to the encrypted vault.graph
        if (fit && shouldFit) {
          fitToContent();
        }
        schedule();
        setLayoutSettled(true);
      },
    });

    /**
     * Start a run if the graph has none. A FULLY restored graph deliberately
     * mounts without one, which is what stops a write on every open; the first
     * interaction is what wakes the simulation, seeded from the positions on
     * screen so it continues the arrangement rather than re-scattering it. A
     * caller gets a handle either way, so it never has to know which path
     * produced it.
     */
    const ensureLiveLayout = (): LayoutHandle | null => {
      if (layout !== null) return layout;
      const live: Record<string, GraphPosition> = {};
      for (const n of nodesRef.current) live[n.id] = { x: n.x, y: n.y };
      layout = startLayout(requestFrom(live), makeWorker, streamHandlers(false));
      return layout;
    };

    // A FULLY restored layout does not run at all. That is the persistence
    // feature actually working: the arrangement the user left is the one they
    // come back to, unchanged, and `vault.graph` is not rewritten just because
    // the pane was opened. This client used to re-run unconditionally — every
    // node was seeded, so it did not flashbang, but the forces still nudged
    // everything a little and a write followed, on every single open. The
    // mobile renderer had the better rule; it is now the shared one
    // (myne-md/myne#200).
    const fullyRestored = nodeIds.length > 0 && Object.keys(seed).length === nodeIds.length;
    if (fullyRestored) {
      setLayoutSettled(true);
    } else {
      setLayoutSettled(false);
      layout = startLayout(requestFrom(seed), makeWorker, streamHandlers(true));
    }

    // Cull bookkeeping reused across frames (reset per render, never
    // re-allocated) and filled ONLY when its LOD consumer is active — so an
    // overview pan (arrows + labels off) does zero per-frame array work.
    const visibleLinks: SimLink[] = [];
    const visibleNodes: SimNode[] = [];
    // One bucket per group color in play (≤ the palette size), reused across
    // frames like the two arrays above. Keeps the node pass to a bounded number
    // of batched fills instead of one path per node.
    const colorBuckets = new Map<string, SimNode[]>();
    const render = () => {
      raf = 0;
      visibleLinks.length = 0;
      visibleNodes.length = 0;
      for (const bucket of colorBuckets.values()) bucket.length = 0;
      const v = viewRef.current;
      // Read once at the top of the frame: the LOD block below needs it (the
      // arrows are hover-only now) as much as the passes further down do.
      const hover = hoverRef.current;
      // The camera, as three bounded numbers — same SYNC-8 class as the nonces
      // on the element (post-unlock, never a note id, never a note's
      // coordinate). It is what makes a canvas testable at all: a scenario
      // reads the transform, computes where a node landed (the layout is
      // deterministic now, so it CAN), and clicks that pixel. Replaced the
      // mobile SVG renderer's `<g transform>` assertions (myne-md/myne#200).
      canvas.dataset["viewX"] = String(v.x);
      canvas.dataset["viewY"] = String(v.y);
      canvas.dataset["viewK"] = String(v.k);

      if (reveal < 1) {
        reveal = reduceMotionRef.current
          ? 1
          : Math.min(1, (performance.now() - revealStart) / REVEAL_MS);
        if (reveal >= 1) revealedRef.current = true;
      }

      ctx.save();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);
      ctx.translate(v.x, v.y);
      ctx.scale(v.k, v.k);

      // Cull to the visible graph box (margin = a few max-radii so partly-
      // visible nodes/labels aren't clipped, even at the largest node size).
      // At high zoom this drops most of a large graph; at overview everything
      // is visible and batching carries the load.
      const maxRadius = resolveNodeRadius(
        nodeSizeRef.current,
        nodeSizeStrengthRef.current,
        MAX_DEGREE_FOR_SIZE,
        MAX_DEGREE_FOR_SIZE,
      );
      const bounds = visibleBounds(v, cssW, cssH, maxRadius * 4);
      // Level-of-detail thresholds. The label one is exactly `labelFadeZoom`
      // on every device: there used to be a hidden ×(2.2/1.4) multiplier for
      // coarse pointers, a second invisible answer to a question the setting
      // already answers — and one that put the phone's threshold at 2.2 while
      // the mobile renderer used 0.9 (myne-md/myne#200).
      // Labels FADE in over a zoom range instead of snapping on at a threshold
      // (myne-md/myne#727), see `LABEL_FADE_LEAD_IN`.
      const labelFullAt = labelFadeZoomRef.current;
      const labelFadeStart = labelFullAt * LABEL_FADE_LEAD_IN;
      const labelAlpha = Math.min(
        1,
        Math.max(
          0,
          (v.k - labelFadeStart) / Math.max(1e-6, labelFullAt - labelFadeStart),
        ),
      );
      const showLabels = labelAlpha > 0;
      // Arrowheads are HOVER-ONLY ON A POINTER CLIENT (myne-md/myne#727). A
      // picture whose every edge carries an arrowhead is a diagram, and at
      // overview zoom the heads were most of the ink; what a user actually asks
      // of a direction is "which way does THIS note's link go", which is a
      // question about one node.
      //
      // On a COARSE pointer there is no hover, so hover-only would mean NEVER,
      // and the direction of a link is worth as much on a phone as on a desktop.
      // A touch client therefore keeps the old always-on-at-zoom behaviour and
      // the setting reads as a plain on/off there.
      const arrowsAllowed =
        arrowsEnabledRef.current && v.k >= (coarse ? 1.2 : 0.6);
      const showArrows = arrowsAllowed && (coarse || hover !== null);

      // --- Edges: ONE batched stroke path per alpha band (was a
      // beginPath+stroke PER edge — the dominant Canvas cost at scale). Collect
      // the drawn edges for the arrowhead pass ONLY when arrows are shown.
      //
      // A hover splits each batched pass in two: the dimmed elements in one
      // pass and the highlighted ones in another, so the batching survives the
      // highlight instead of degrading to one draw call per edge. With nothing
      // hovered, which is every touch client and every unhovered desktop, the
      // band list is a single entry and this is the pass it always was. ---
      const bands = hover === null ? [true] : [false, true];
      ctx.lineWidth = (1 / v.k) * lineThicknessRef.current;
      ctx.strokeStyle = colEdge;
      for (const lit of bands) {
        // A hovered note's own edges take the vault's accent rather than the
        // neutral edge colour, so the highlight reads as "these are THIS note's
        // connections" instead of as "these lines are brighter".
        ctx.strokeStyle = hover !== null && lit ? colAccent : colEdge;
        ctx.globalAlpha = highlightAlpha(hover, lit) * reveal;
        ctx.beginPath();
        for (const l of linksRef.current) {
          if (!isEdgeVisible(l.source, l.target, bounds)) continue;
          if (edgeIsLit(hover, l.source.id, l.target.id) !== lit) continue;
          if (showArrows) visibleLinks.push(l);
          ctx.moveTo(l.source.x, l.source.y);
          ctx.lineTo(l.target.x, l.target.y);
        }
        ctx.stroke();
      }
      ctx.stroke();

      // --- Arrowheads: ONE batched fill path per band (LOD: only when zoomed
      // enough, sub-pixel at overview). Directed edges keep who-links-whom. ---
      if (showArrows) {
        // 6, up from 4: hover-only means the head no longer has to survive
        // being one of hundreds on screen, so it can be the size that answers
        // the question at a glance.
        const ah = 6 / v.k;
        ctx.fillStyle = colAccent;
        ctx.globalAlpha = reveal;
        ctx.beginPath();
        for (const l of visibleLinks) {
          // A hover dims the heads to the hovered node's own edges; a coarse
          // pointer has no hover, so every visible head is drawn.
          if (hover !== null && !edgeIsLit(hover, l.source.id, l.target.id)) continue;
          const dx = l.target.x - l.source.x;
          const dy = l.target.y - l.source.y;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len;
          const uy = dy / len;
          const tipX = l.target.x - ux * (drawnRadiusOf(l.target) + 1);
          const tipY = l.target.y - uy * (drawnRadiusOf(l.target) + 1);
          ctx.moveTo(tipX, tipY);
          ctx.lineTo(tipX - ux * ah - uy * ah * 0.6, tipY - uy * ah + ux * ah * 0.6);
          ctx.lineTo(tipX - ux * ah + uy * ah * 0.6, tipY - uy * ah - ux * ah * 0.6);
          ctx.closePath();
        }
        ctx.fill();
      }

      // --- Nodes: ONE batched fill path per color PER BAND. `moveTo` to each
      // arc's start first so consecutive circles aren't joined by a line.
      // Collect the drawn nodes for the label pass ONLY when labels are shown,
      // and the color-grouped ones into their bucket for the pass below, a node
      // whose rule color is absent, unresolvable or simply unset stays in the
      // neutral batch, so unclassified notes recede exactly as before. ---
      const colorMap = nodeColorsRef.current;
      const neutral: SimNode[] = [];
      for (const n of nodesRef.current) {
        if (!isNodeVisible(n, bounds)) continue;
        if (showLabels) visibleNodes.push(n);
        const key = colorMap?.get(n.id);
        if (key !== undefined && groupColor(key) !== null) {
          let bucket = colorBuckets.get(key);
          if (bucket === undefined) {
            bucket = [];
            colorBuckets.set(key, bucket);
          }
          bucket.push(n);
          continue;
        }
        neutral.push(n);
      }
      const fillNodes = (nodes: SimNode[], color: string, lit: boolean) => {
        ctx.globalAlpha = highlightAlpha(hover, lit);
        ctx.fillStyle = color;
        ctx.beginPath();
        let drew = false;
        for (const n of nodes) {
          if (nodeIsLit(hover, n.id) !== lit) continue;
          const r = drawnRadiusOf(n);
          if (r <= 0) continue; // not yet revealed
          ctx.moveTo(n.x + r, n.y);
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
          drew = true;
        }
        if (drew) ctx.fill();
      };
      for (const lit of bands) fillNodes(neutral, colNode, lit);
      // --- Group-colored nodes: one batched fill per color in play, per band. ---
      for (const [key, bucket] of colorBuckets) {
        if (bucket.length === 0) continue;
        const color = groupColor(key);
        if (color === null) continue;
        for (const lit of bands) fillNodes(bucket, color, lit);
      }

      // --- Tag nodes: a ring around each, in the neutral ink so it reads
      // against any group colour. A tag is a category rather than a note, and an
      // outline is the cheapest thing that says so at a glance, one stroke
      // pass for all of them, and it dims with its neighbours exactly like a
      // fill does. ---
      ctx.strokeStyle = colNode;
      ctx.lineWidth = 1.5 / v.k;
      for (const lit of bands) {
        ctx.globalAlpha = highlightAlpha(hover, lit);
        ctx.beginPath();
        let drewRing = false;
        for (const n of nodesRef.current) {
          if (n.kind !== "tag" || !isNodeVisible(n, bounds)) continue;
          if (nodeIsLit(hover, n.id) !== lit) continue;
          const r = drawnRadiusOf(n);
          if (r <= 0) continue; // not yet revealed
          ctx.moveTo(n.x + r, n.y);
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
          drewRing = true;
        }
        if (drewRing) ctx.stroke();
      }

      // --- Labels: only when zoomed in (calm at overview) and only for the
      // visible nodes. A dimmed node's label dims with it. ---
      if (showLabels) {
        ctx.fillStyle = colLabel;
        ctx.font = `${13 / v.k}px ${labelFont}`;
        for (const n of visibleNodes) {
          if (!n.title) continue;
          // A name waits for its node: the reveal is staged as structure, then
          // discs, then names, and a label beside a not-yet-there disc is the
          // one order that reads as a glitch.
          if (revealOf(n.id) < 1) continue;
          ctx.globalAlpha =
            labelAlpha * highlightAlpha(hover, nodeIsLit(hover, n.id));
          ctx.fillText(n.title, n.x + radiusOf(n) + 2, n.y + 3);
        }
      }

      // --- The hovered node's own ring, drawn last so it sits above its
      // neighbours: with several nodes the same size, the anchor of the
      // highlight has to be unmistakable. ---
      if (hover !== null) {
        const anchor = nodesRef.current.find((n) => n.id === hover.id);
        if (anchor !== undefined && isNodeVisible(anchor, bounds)) {
          ctx.globalAlpha = 1;
          ctx.strokeStyle = colAccent;
          ctx.lineWidth = 2 / v.k;
          ctx.beginPath();
          ctx.arc(anchor.x, anchor.y, drawnRadiusOf(anchor) + 3 / v.k, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      ctx.restore();
      // The entrance is a render-loop animation, so the loop has to stay awake
      // for it even when nothing else is moving (a fully restored layout runs
      // no simulation at all, and the reveal would freeze at whatever frame the
      // restore happened to schedule).
      if (reveal < 1) schedule();
    };
    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(render);
    };
    scheduleRef.current = schedule;
    // Frame the laid-out cloud. Not cosmetic: the layout is computed in a fixed
    // virtual box (`LAYOUT_BOX`) so every client produces identical geometry,
    // which means the camera — not the geometry — is what adapts to this
    // window. Run on mount (warm-start positions) and again when a fresh layout
    // lands. It also fixes the old failure where a layout persisted under a
    // different window size opened off-screen with no way back.
    // The camera's PROGRAMMATIC moves animate; direct gestures do not. Dragging
    // the background or spinning the wheel has to stay 1:1 with the hand, and a
    // tween there would read as the interface lagging behind it. What reads as a
    // teleport is the camera being assigned, which only ever happens on a fit.
    let cameraRaf = 0;
    const cancelCameraTween = () => {
      if (cameraRaf !== 0) {
        cancelAnimationFrame(cameraRaf);
        cameraRaf = 0;
      }
    };
    const fitToContent = (animate = true) => {
      const to = fitTransform(nodesRef.current, cssW, cssH);
      cancelCameraTween();
      if (!animate || reduceMotionRef.current) {
        viewRef.current = to;
        return;
      }
      const from = { ...viewRef.current };
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / CAMERA_TWEEN_MS);
        viewRef.current = tweenTransform(from, to, t);
        schedule();
        cameraRaf = t < 1 ? requestAnimationFrame(step) : 0;
      };
      cameraRaf = requestAnimationFrame(step);
    };
    // The opening framing is applied immediately: a graph should ARRIVE framed,
    // not drift into frame while the user waits for it. Skipped when this model
    // is the same note-set with tag nodes added, the camera is already right.
    if (shouldFit) fitToContent(false);
    schedule();

    // Convert a client point to graph (pre-transform) coordinates.
    const toGraph = (clientX: number, clientY: number) => {
      const r = canvas.getBoundingClientRect();
      const v = viewRef.current;
      return {
        x: (clientX - r.left - v.x) / v.k,
        y: (clientY - r.top - v.y) / v.k,
      };
    };
    const hitNode = (gx: number, gy: number): SimNode | null => {
      // Per-node hit radius tracks `radiusOf` (the drawn radius) so the click
      // target stays consistent with what is rendered at every size setting.
      for (const n of nodesRef.current) {
        const rr = (radiusOf(n) + 3) ** 2;
        if ((n.x - gx) ** 2 + (n.y - gy) ** 2 <= rr) return n;
      }
      return null;
    };

    // The id the pointer is over, tracked separately from the resolved
    // highlight so a move WITHIN the same node costs nothing: `pointermove`
    // fires continuously, and rebuilding the highlight on every one of them
    // would allocate and repaint for no visible change.
    let hoveredId: string | null = null;
    /**
     * Set the hovered node and repaint. Passing the id already hovered, or
     * `null` when nothing is hovered, is a no-op.
     */
    const setHover = (id: string | null) => {
      if (id === hoveredId) return;
      hoveredId = id;
      hoverRef.current =
        id === null
          ? null
          : buildHoverHighlight(
              id,
              linksRef.current.map((l) => ({ source: l.source.id, target: l.target.id })),
            );
      schedule();
    };

    // Pointer state: panning the canvas vs dragging a node.
    let mode: "none" | "pan" | "drag" | "pinch" = "none";
    let dragNode: SimNode | null = null;
    let last = { x: 0, y: 0 };
    let moved = false;
    // Single-click deferral: when a double-click handler exists (local-graph
    // pivot-vs-navigate), a click is held briefly so a following dblclick can
    // cancel it — otherwise the two pointerups of a double-click would fire
    // onNodeClick (pivot) twice before onNodeDoubleClick (navigate).
    let clickTimer: ReturnType<typeof setTimeout> | null = null;
    const cancelPendingClick = () => {
      if (clickTimer !== null) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
    };

    // Live pointers, so a second finger can start a pinch (ported from the
    // retired mobile SVG renderer along with the double-tap refit — a touch
    // client needs both, and a shared renderer has to serve one).
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchDistance = 0;
    let lastTap: { t: number; x: number; y: number } | null = null;

    const onPointerDown = (e: PointerEvent) => {
      // A fresh gesture starts with nothing held. A previous gesture that ended
      // without a pointer-up (a cancelled touch, a pinch that took over) would
      // otherwise leave a node held in the simulation forever.
      if (draggingId !== null) {
        layout?.release(draggingId);
        draggingId = null;
      }
      // A press means the user is acting rather than reading, so the hover
      // layer clears. It comes back when the pointer moves without a button.
      setHover(null);
      // A direct gesture takes the camera over: an in-flight programmatic move
      // must not keep writing a target the hand is now contradicting.
      cancelCameraTween();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        // Second finger down: abandon whatever single-pointer gesture was in
        // flight and pinch instead.
        const [a, b] = [...pointers.values()];
        pinchDistance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        mode = "pinch";
        dragNode = null;
        return;
      }
      moved = false;
      last = { x: e.clientX, y: e.clientY };
      const g = toGraph(e.clientX, e.clientY);
      dragNode = hitNode(g.x, g.y);
      mode = dragNode ? "drag" : "pan";
      canvas.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (mode === "none") {
        // No gesture in flight, so the pointer is only hovering. Mouse only:
        // a touch pointer moving without a gesture is not something the user
        // can perceive, and the layer would flash on every scroll swipe.
        if (e.pointerType === "mouse") {
          const g = toGraph(e.clientX, e.clientY);
          const n = hitNode(g.x, g.y);
          setHover(n === null ? null : n.id);
        }
        return;
      }
      if (pointers.has(e.pointerId)) {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (mode === "pinch") {
        if (pointers.size < 2) return;
        const [a, b] = [...pointers.values()];
        const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        const v = viewRef.current;
        const k2 = clampK(v.k * (distance / Math.max(pinchDistance, 1e-6)));
        pinchDistance = distance;
        // Zoom about the midpoint between the fingers.
        const r = canvas.getBoundingClientRect();
        const mx = (a!.x + b!.x) / 2 - r.left;
        const my = (a!.y + b!.y) / 2 - r.top;
        v.x = mx - ((mx - v.x) * k2) / v.k;
        v.y = my - ((my - v.y) * k2) / v.k;
        v.k = k2;
        moved = true;
        schedule();
        return;
      }
      const dx = e.clientX - last.x;
      const dy = e.clientY - last.y;
      if (crossedDragThreshold(dx, dy)) moved = true;
      last = { x: e.clientX, y: e.clientY };
      if (mode === "pan") {
        viewRef.current.x += dx;
        viewRef.current.y += dy;
      } else if (mode === "drag" && dragNode) {
        dragNode.x += dx / viewRef.current.k;
        dragNode.y += dy / viewRef.current.k;
        if (moved) {
          // Past the threshold the press has become a PLACEMENT. Hold the node
          // where the pointer put it and re-heat the simulation, so its
          // neighbours follow it around and the graph reads as one connected
          // object rather than an icon being slid over a picture. Re-heating on
          // every move is what keeps it hot for the whole gesture; the tick
          // budget restarts with each one, and it starts counting down again
          // the moment the pointer stops.
          draggingId = dragNode.id;
          const live = ensureLiveLayout();
          live?.hold(dragNode.id, dragNode.x, dragNode.y);
          live?.reheat();
        }
      }
      schedule();
    };
    const onPointerUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (mode === "pinch") {
        // Stay out of the way until every finger is off — otherwise lifting
        // one of two fingers would resume a pan from a jumped position.
        if (pointers.size === 0) mode = "none";
        canvas.releasePointerCapture?.(e.pointerId);
        return;
      }
      if (mode === "none") {
        // Nothing was in flight, a cancelled gesture already reset the mode,
        // so this pointer-up means nothing and must not be counted as a tap.
        canvas.releasePointerCapture(e.pointerId);
        return;
      }
      // What this gesture MEANS is the pointer policy's call rather than this
      // handler's: a press on a node that did not move is a click, one that did
      // is a placement, and a press on empty space is a tap or a pan.
      const intent = classifyRelease(dragNode === null ? null : dragNode.id, moved);
      if (intent.kind === "background-tap") {
      // A clean background tap, twice in quick succession, refits — the touch
        // equivalent of "I have lost the graph, put it back on screen".
        const now = performance.now();
        if (lastTap && now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
          lastTap = null;
          fitToContent();
          schedule();
        } else {
          lastTap = { t: now, x: e.clientX, y: e.clientY };
        }
      } else if (intent.kind === "node-click") {
        if (cbRef.current.onNodeDoubleClick) {
          // Defer: a dblclick within the window cancels this (pivot vs navigate).
          cancelPendingClick();
          clickTimer = setTimeout(() => {
            clickTimer = null;
            cbRef.current.onNodeClick(intent.id);
          }, 250);
        } else {
          cbRef.current.onNodeClick(intent.id); // whole graph: single click navigates
        }
      } else if (intent.kind === "node-place") {
        // Let go. The node is NOT pinned: the link force pulls it back through
        // its connections, which is the whole point of a live simulation, and
        // there is deliberately no arrangement to save. The settled positions
        // are persisted by the run's own settle callback, so nothing is written
        // from here.
        layout?.release(intent.id);
        draggingId = null;
      }
      mode = "none";
      dragNode = null;
      canvas.releasePointerCapture(e.pointerId);
    };
    const onDblClick = (e: MouseEvent) => {
      cancelPendingClick(); // a double-click is navigate, never the pivot
      if (!cbRef.current.onNodeDoubleClick) return;
      const g = toGraph(e.clientX, e.clientY);
      const n = hitNode(g.x, g.y);
      if (n) cbRef.current.onNodeDoubleClick(n.id);
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelCameraTween(); // the wheel is 1:1 with the hand, so it wins
      const v = viewRef.current;
      const r = canvas.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      const factor = Math.exp(-e.deltaY * 0.001);
      // Shared clamp: the floor has to be low enough for `fitTransform` to fit
      // a large vault's cloud into a small box, which the old 0.15 fought.
      const k2 = clampK(v.k * factor);
      // Zoom toward the cursor.
      v.x = cx - (cx - v.x) * (k2 / v.k);
      v.y = cy - (cy - v.y) * (k2 / v.k);
      v.k = k2;
      schedule();
    };

    const onResize = () => {
      if (!resize()) return; // same box, same ratio: nothing to redraw.
      // A camera move in flight was aimed at a box that no longer exists, so it
      // is dropped rather than completed. The transform stays where it is, which
      // keeps the graph on screen; finishing a stale fit is what would lose it.
      cancelCameraTween();
      schedule(); // re-render at current positions — never re-layout on resize.
    };

    // Theme reactivity: the 2D context holds resolved color STRINGS, so a
    // theme switch has to invalidate them explicitly (a CSS var change repaints
    // the DOM for free, a canvas never). Both switch mechanisms mutate
    // `<html>` — `applyTheme` sets/removes `data-theme`, `applyCustomTheme`
    // writes `--*` properties onto its inline style (`src/lib/theme.ts`) — so
    // one attribute observer catches both, and the media listener covers the
    // System choice (no attribute at all) following the OS live. Repaint only:
    // this never touches `model`, so the layout is not re-run.
    const onThemeChange = () => {
      resolveTokens();
      schedule();
    };
    const themeObserver = new MutationObserver(onThemeChange);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });
    const colorScheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    colorScheme?.addEventListener?.("change", onThemeChange);
    // The reduced-motion gate. Read once and then watched, so turning the OS
    // setting on mid-session stops the camera moving without a reload.
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const readReduceMotion = () => {
      reduceMotionRef.current = reduceMotion?.matches === true;
    };
    readReduceMotion();
    reduceMotion?.addEventListener?.("change", readReduceMotion);

    const onPointerCancel = (e: PointerEvent) => {
      // A cancelled touch never sends pointerup; without this the pointer would
      // stay in the map and the next finger down would look like a pinch.
      pointers.delete(e.pointerId);
      if (pointers.size === 0) {
        mode = "none";
        // A held node must be let go here too: the gesture ended without a
        // pointer-up, so nothing else will release it and it would stay pinned
        // in the simulation for the rest of the session.
        if (draggingId !== null) {
          layout?.release(draggingId);
          draggingId = null;
        }
      }
    };
    /** The pointer left the canvas, so there is nothing under it any more. */
    const onPointerLeave = () => setHover(null);

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("dblclick", onDblClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    // Observe the ELEMENT, not the window (myne#534). Most of what resizes this
    // canvas never resizes the window: toggling a sidebar, splitting a pane,
    // the tab strip stacking. A window-only listener left the backing store at
    // the old box after every one of those, which is a blurred render plus
    // `sizeRef` (culling and pointer hit-testing read it) describing a box that
    // is no longer there. The observer subsumes the window case, since a window
    // resize changes this element's box too.
    //
    // It fires once on `observe()`, which `window.resize` never did. Safe
    // because `onResize` only repaints: a refit here would move the camera at
    // mount and break the fitted-view and no-rewrite guarantees the mobile flow
    // specs pin. Keep it that way. (`resize()`'s changed-check makes that first
    // notification free as well, but free is not what makes it safe.)
    //
    // The window listener is KEPT as the fallback rather than degraded to
    // nothing. The shared package's other observers (`scroll-slack.ts`,
    // `attachments/widgets.ts`) do degrade to nothing, and correctly so: they
    // never had a second mechanism to lose. This one did, and dropping it would
    // mean a host without `ResizeObserver` silently renders a stretched canvas
    // with its hit-testing pointing somewhere else, which is a failure that
    // reports success. Three lines is a cheap price for that not being possible,
    // and mobile compiles this same file onto the least predictable WebView
    // floor of the three clients.
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", onResize);
    } else {
      resizeObserver = new ResizeObserver(onResize);
      resizeObserver.observe(canvas);
    }

    return () => {
      scheduleRef.current = null;
      // The handle owns the worker's lifetime; `layoutCancelled` only stops a
      // frame that was already in flight from writing into a torn-down node
      // array.
      layoutCancelled = true;
      layout?.stop();
      if (raf !== 0) cancelAnimationFrame(raf);
      cancelCameraTween();
      cancelPendingClick();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("dblclick", onDblClick);
      canvas.removeEventListener("wheel", onWheel);
      // Both teardowns run unconditionally: exactly one of the two was ever
      // registered, and removing a listener that was never added is a no-op.
      // Whichever it was is created per `[model]` effect run, so a missed
      // teardown accumulates one per filter change, which is the leak the
      // anonymous window listener here used to have.
      resizeObserver?.disconnect();
      window.removeEventListener("resize", onResize);
      themeObserver.disconnect();
      colorScheme?.removeEventListener?.("change", onThemeChange);
      reduceMotion?.removeEventListener?.("change", readReduceMotion);
    };
  }, [modelKey]);

  // Repaint-only reaction to the appearance controls and the color-group map —
  // deliberately a SEPARATE effect from the `[model]` one above so tuning any
  // of these never re-enters it (which would re-create the worker and re-run
  // the layout). All are read live via refs during render; this effect only has
  // to schedule the one repaint that picks up the new ref values. `nodeColors`
  // sits here, not in `[model]`, because that is the whole point of task 8:
  // editing a color-group rule REPAINTS, it does not re-lay-out.
  useEffect(() => {
    scheduleRef.current?.();
  }, [
    arrowsEnabled,
    labelFadeZoom,
    nodeSize,
    nodeSizeStrength,
    lineThickness,
    nodeColors,
  ]);

  // Bounded-relayout reaction to the force controls (task 6) — the opposite
  // contract from appearance: a force change DOES re-run the layout, because
  // the user is explicitly asking for a different arrangement. Deliberately a
  // SEPARATE effect from `[model]` so a force tweak re-runs ONLY the layout
  // (warm-started from the nodes' current live positions, via a fresh
  // short-lived worker) rather than tearing down and rebuilding the whole
  // canvas/pointer-handler setup. Skips the mount run — the `[model]` effect's
  // own initial request already used the force values as of mount.
  //
  // The skip compares the VALUES rather than flipping a "have I run yet" ref,
  // and that matters: StrictMode invokes a mount effect twice, so a boolean
  // guard is spent by the first invocation and the second one re-lays-out the
  // graph nobody asked to change. Invisible while the mount always ran a
  // layout anyway; very visible once a fully-restored layout runs none, since
  // the spurious pass rewrites `vault.graph` on every open (myne-md/myne#200).
  const appliedForces = useRef({
    forceCenterStrength,
    forceRepelStrength,
    forceLinkStrength,
    forceLinkDistance,
  });
  useEffect(() => {
    const prev = appliedForces.current;
    if (
      prev.forceCenterStrength === forceCenterStrength &&
      prev.forceRepelStrength === forceRepelStrength &&
      prev.forceLinkStrength === forceLinkStrength &&
      prev.forceLinkDistance === forceLinkDistance
    ) {
      return;
    }
    appliedForces.current = {
      forceCenterStrength,
      forceRepelStrength,
      forceLinkStrength,
      forceLinkDistance,
    };
    const nodes = nodesRef.current;
    if (nodes.length === 0) return;
    const seed: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) seed[n.id] = { x: n.x, y: n.y };
    const edges = linksRef.current.map((l) => ({
      source: l.source.id,
      target: l.target.id,
    }));
    let cancelled = false;
    setForceRelayoutSeeded(Object.keys(seed).length);
    // A fresh layout rather than a re-heat of the running one: the four force
    // values reach d3 through the link force's distance and strength, which are
    // set when the simulation is constructed. The new run is warm-started from
    // the live positions, so it settles into the new shape instead of
    // re-scattering. The camera is deliberately NOT refitted here: the user is
    // tuning a graph they are looking at, and yanking the view under them is
    // the one thing a control must not do.
    const handle = startLayout(
      {
        nodes: nodes.map((n) => ({
          id: n.id,
          // The reserved radius, not the drawn one: see `resolveReservedRadius`.
          radius:
            n.kind === "tag"
              ? resolveReservedTagNodeRadius()
              : resolveReservedRadius(
                  degreeRef.current.get(n.id) ?? 0,
                  MAX_DEGREE_FOR_SIZE,
                ),
        })),
        edges,
        seed,
        forces: {
          centerStrength: forceCenterStrength,
          repelStrength: forceRepelStrength,
          linkStrength: forceLinkStrength,
          linkDistance: forceLinkDistance,
        },
      } satisfies LayoutRequest,
      makeWorker,
      {
        onFrame: (positions) => {
          if (cancelled) return;
          const pos = new Map(positions.map((p) => [p.id, p]));
          for (const n of nodesRef.current) {
            const p = pos.get(n.id);
            if (p !== undefined) {
              n.x = p.x;
              n.y = p.y;
            }
          }
          scheduleRef.current?.();
        },
        onSettled: (positions) => {
          if (cancelled) return;
          const pos = new Map(positions.map((p) => [p.id, p]));
          for (const n of nodesRef.current) {
            const p = pos.get(n.id);
            if (p !== undefined) {
              n.x = p.x;
              n.y = p.y;
            }
          }
          setGraphPositions(positions);
          cbRef.current.onPositionsChanged?.();
          scheduleRef.current?.();
          setForceRelayoutRuns((n) => n + 1);
        },
      },
    );
    // Bounded by construction (the kernel's heat cycle has a tick ceiling and
    // an idle stop), no perpetual loop. If the effect re-fires before the
    // stream finishes (a rapid slider drag), the previous run is stopped here
    // and its frames are dropped.
    return () => {
      cancelled = true;
      handle.stop();
    };
  }, [forceCenterStrength, forceRepelStrength, forceLinkStrength, forceLinkDistance]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="editor.graph-canvas"
      // `role="img"` rather than a container role: the canvas holds pixels, not
      // readable content, so the honest description is "a picture of this graph"
      // and the honest label says how big it is. The list view is the surface
      // that carries the same information as text.
      role={ariaLabel === undefined ? undefined : "img"}
      aria-label={ariaLabel}
      data-palette-nonce={String(paletteNonce)}
      data-force-relayout-count={String(forceRelayoutRuns)}
      data-force-relayout-seeded={String(forceRelayoutSeeded)}
      data-layout-settled={layoutSettled ? "true" : "false"}
      // NOTE: `data-view-x/y/k` are written IMPERATIVELY by the render loop
      // (see `render()`), deliberately not declared here — the view transform
      // lives in a ref precisely so a pan does not commit React state, and
      // declaring them would undo that.
      // `flex` AND the two percentages are all load-bearing, and none is slop:
      // the two hosts frame this element differently. Mobile's ancestry is an
      // unbroken flex column (`WikiGraph` → `flex: 1; minHeight: 0`), desktop's
      // resolves a percentage height off the pane body's explicit-height frame
      // (`PaneView`'s full-bleed wrapper). Drop either and one client's canvas
      // collapses to its intrinsic 2:1 ratio, which is myne#534.
      style={{
        flex: 1,
        width: "100%",
        height: "100%",
        display: "block",
        cursor: "grab",
        touchAction: "none",
      }}
    />
  );
}
