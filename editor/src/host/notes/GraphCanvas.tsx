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

import { useEffect, useRef, useState } from "react";
import type { GraphEdge, GraphModel, GraphNode } from "./graphModel";
import {
  getGraphPosition,
  seedInitialPosition,
  seedPositions,
  setGraphPositions,
} from "./graphLayoutStore";
import { DEFAULT_GRAPH_SETTINGS, resolveNodeRadius } from "./graphSettings";
import type { LayoutRequest } from "./graphLayout";
import { runLayout } from "./graphLayoutRun";
import { clampK, fitTransform } from "./graphCamera";
import { isEdgeVisible, isNodeVisible, visibleBounds } from "./graphCulling";

type SimNode = GraphNode & { x: number; y: number };
type SimLink = { source: SimNode; target: SimNode; weight: number };

// A node's degree contribution to its radius is capped so one hub note can't
// make itself (or its neighbours' hit targets) absurdly large.
const MAX_DEGREE_FOR_SIZE = 10;
// A color-group key is a bare design-token name (`group-teal`), resolved as
// `--group-teal` off the canvas's own computed style — so group colors follow
// the theme, dark mode and a custom theme's token override exactly like the
// neutral node color does. The shape check keeps a rule authored by a future
// (or malformed) client from reaching the CSSOM lookup as an arbitrary string;
// anything it rejects — or any token that resolves empty — falls back to the
// neutral color, which is the same forward-compat degrade the rule evaluator
// applies to an unsupported filter leaf.
const COLOR_KEY_SHAPE = /^[a-z0-9][a-z0-9-]*$/;

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
  // Per-node degree (in + out), computed once per model build — the input to
  // `radiusOf` alongside the live `nodeSize`/`nodeSizeStrength` refs.
  const degreeRef = useRef<Map<string, number>>(new Map());
  // The canvas's current CSS box, kept live so the forces-relayout effect
  // (below) can size a fresh `LayoutRequest` without re-reading the DOM.
  const sizeRef = useRef({ width: 0, height: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

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
    let colEdge = token("--line-1", "#444");
    let colArrow = token("--fg-3", "#888");
    let colLabel = token("--fg-3", "#bdbdbd");
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
      colEdge = token("--line-1", "#444");
      colArrow = token("--fg-3", "#888");
      colLabel = token("--fg-3", "#bdbdbd");
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
    const nodes: SimNode[] = model.nodes.map((n, index) => {
      const p = seedInitialPosition(
        getGraphPosition(n.id),
        n.id,
        index,
        model.nodes.length,
      );
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
    const radiusOf = (n: SimNode) =>
      resolveNodeRadius(
        nodeSizeRef.current,
        nodeSizeStrengthRef.current,
        degreeRef.current.get(n.id) ?? 0,
        MAX_DEGREE_FOR_SIZE,
      );

    // Render immediately at warm-start positions (never a blank frame), then
    // compute the settled layout OFF the main thread. The worker cannot call
    // Tauri IPC, so it only receives this already-resolved model + seed.
    let raf = 0;
    let layoutCancelled = false;
    const nodeIds = model.nodes.map((n) => n.id);
    const seed = seedPositions(nodeIds);

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
      void runLayout(
        {
          nodes: nodeIds.map((id) => ({ id })),
          edges: model.edges.map((e) => ({ source: e.source, target: e.target })),
          seed,
          // Current force settings at build time — a LIVE change to one of them
          // is handled by the separate `[forceCenterStrength, ...]` effect below,
          // not by re-running this effect (which would recreate the whole sim).
          forces: {
            centerStrength: forceCenterStrength,
            repelStrength: forceRepelStrength,
            linkStrength: forceLinkStrength,
            linkDistance: forceLinkDistance,
          },
        } satisfies LayoutRequest,
        makeWorker,
      ).then((res) => {
        if (layoutCancelled) return;
        const pos = new Map(res.positions.map((p) => [p.id, p]));
        for (const n of nodesRef.current) {
          const p = pos.get(n.id);
          if (p !== undefined) {
            n.x = p.x;
            n.y = p.y;
          }
        }
        setGraphPositions(res.positions); // persist for warm-start next open
        cbRef.current.onPositionsChanged?.(); // debounced flush to the encrypted vault.graph
        fitToContent();
        schedule();
        setLayoutSettled(true);
      });
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
      // The camera, as three bounded numbers — same SYNC-8 class as the nonces
      // on the element (post-unlock, never a note id, never a note's
      // coordinate). It is what makes a canvas testable at all: a scenario
      // reads the transform, computes where a node landed (the layout is
      // deterministic now, so it CAN), and clicks that pixel. Replaced the
      // mobile SVG renderer's `<g transform>` assertions (myne-md/myne#200).
      canvas.dataset["viewX"] = String(v.x);
      canvas.dataset["viewY"] = String(v.y);
      canvas.dataset["viewK"] = String(v.k);

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
      const showLabels = v.k >= labelFadeZoomRef.current;
      const showArrows = arrowsEnabledRef.current && v.k >= (coarse ? 1.2 : 0.6);

      // --- Edges: ONE batched stroke path for every visible line (was a
      // beginPath+stroke PER edge — the dominant Canvas cost at scale). Collect
      // the drawn edges for the arrowhead pass ONLY when arrows are shown. ---
      ctx.lineWidth = (1 / v.k) * lineThicknessRef.current;
      ctx.strokeStyle = colEdge;
      ctx.beginPath();
      for (const l of linksRef.current) {
        if (!isEdgeVisible(l.source, l.target, bounds)) continue;
        if (showArrows) visibleLinks.push(l);
        ctx.moveTo(l.source.x, l.source.y);
        ctx.lineTo(l.target.x, l.target.y);
      }
      ctx.stroke();

      // --- Arrowheads: ONE batched fill path (LOD: only when zoomed enough —
      // sub-pixel at overview). Directed edges keep who-links-whom. ---
      if (showArrows) {
        const ah = 4 / v.k;
        ctx.fillStyle = colArrow;
        ctx.beginPath();
        for (const l of visibleLinks) {
          const dx = l.target.x - l.source.x;
          const dy = l.target.y - l.source.y;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len;
          const uy = dy / len;
          const tipX = l.target.x - ux * (radiusOf(l.target) + 1);
          const tipY = l.target.y - uy * (radiusOf(l.target) + 1);
          ctx.moveTo(tipX, tipY);
          ctx.lineTo(tipX - ux * ah - uy * ah * 0.6, tipY - uy * ah + ux * ah * 0.6);
          ctx.lineTo(tipX - ux * ah + uy * ah * 0.6, tipY - uy * ah - ux * ah * 0.6);
          ctx.closePath();
        }
        ctx.fill();
      }

      // --- Nodes: ONE batched fill path per color. `moveTo` to each arc's
      // start first so consecutive circles aren't joined by a line. Collect the
      // drawn nodes for the label pass ONLY when labels are shown, and the
      // color-grouped ones into their bucket for the pass below — a node whose
      // rule color is absent, unresolvable or simply unset stays in the neutral
      // batch, so unclassified notes recede exactly as before. ---
      const colorMap = nodeColorsRef.current;
      ctx.fillStyle = colNode;
      ctx.beginPath();
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
        const r = radiusOf(n);
        ctx.moveTo(n.x + r, n.y);
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
      }
      ctx.fill();

      // --- Group-colored nodes: one batched fill per color in play. ---
      for (const [key, bucket] of colorBuckets) {
        if (bucket.length === 0) continue;
        const color = groupColor(key);
        if (color === null) continue;
        ctx.fillStyle = color;
        ctx.beginPath();
        for (const n of bucket) {
          const r = radiusOf(n);
          ctx.moveTo(n.x + r, n.y);
          ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
        }
        ctx.fill();
      }

      // --- Labels: only when zoomed in (calm at overview) and only for the
      // visible nodes. ---
      if (showLabels) {
        ctx.fillStyle = colLabel;
        ctx.font = `${11 / v.k}px sans-serif`;
        for (const n of visibleNodes) {
          if (n.title) ctx.fillText(n.title, n.x + radiusOf(n) + 2, n.y + 3);
        }
      }
      ctx.restore();
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
    const fitToContent = () => {
      viewRef.current = fitTransform(nodesRef.current, cssW, cssH);
    };
    fitToContent();
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
      if (mode === "none") return;
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
      if (Math.abs(dx) + Math.abs(dy) > 2) moved = true;
      last = { x: e.clientX, y: e.clientY };
      if (mode === "pan") {
        viewRef.current.x += dx;
        viewRef.current.y += dy;
      } else if (mode === "drag" && dragNode) {
        dragNode.x += dx / viewRef.current.k;
        dragNode.y += dy / viewRef.current.k;
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
      // A clean background tap, twice in quick succession, refits — the touch
      // equivalent of "I have lost the graph, put it back on screen".
      if (mode === "pan" && !moved) {
        const now = performance.now();
        if (lastTap && now - lastTap.t < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
          lastTap = null;
          fitToContent();
          schedule();
        } else {
          lastTap = { t: now, x: e.clientX, y: e.clientY };
        }
      }
      if (mode === "drag" && dragNode && !moved) {
        const id = dragNode.id;
        if (cbRef.current.onNodeDoubleClick) {
          // Defer: a dblclick within the window cancels this (pivot vs navigate).
          cancelPendingClick();
          clickTimer = setTimeout(() => {
            clickTimer = null;
            cbRef.current.onNodeClick(id);
          }, 250);
        } else {
          cbRef.current.onNodeClick(id); // whole graph: single click navigates
        }
      } else if (mode === "drag" && dragNode && moved) {
        // A real node drag — persist the new arrangement so it survives a
        // filter switch / reopen (warm-start), instead of being discarded.
        setGraphPositions(
          nodesRef.current.map((n) => ({ id: n.id, x: n.x, y: n.y })),
        );
        cbRef.current.onPositionsChanged?.(); // debounced flush to disk (survives restart)
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

    const onPointerCancel = (e: PointerEvent) => {
      // A cancelled touch never sends pointerup; without this the pointer would
      // stay in the map and the next finger down would look like a pinch.
      pointers.delete(e.pointerId);
      if (pointers.size === 0) mode = "none";
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
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
      // `runLayout` owns the worker's lifetime (it terminates on message or
      // error); this only stops a late result from writing into a torn-down
      // node array.
      layoutCancelled = true;
      if (raf !== 0) cancelAnimationFrame(raf);
      cancelPendingClick();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
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
    };
  }, [model]);

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
    void runLayout(
      {
        nodes: nodes.map((n) => ({ id: n.id })),
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
    ).then((res) => {
      if (cancelled) return;
      const pos = new Map(res.positions.map((p) => [p.id, p]));
      for (const n of nodesRef.current) {
        const p = pos.get(n.id);
        if (p !== undefined) {
          n.x = p.x;
          n.y = p.y;
        }
      }
      setGraphPositions(res.positions);
      cbRef.current.onPositionsChanged?.();
      scheduleRef.current?.();
      setForceRelayoutRuns((n) => n + 1);
    });
    // Bounded by construction (the kernel runs its fixed tick budget once and
    // resolves) — no perpetual loop. If the effect re-fires before that
    // resolves (a rapid slider drag), the stale result is dropped below.
    return () => {
      cancelled = true;
    };
  }, [forceCenterStrength, forceRepelStrength, forceLinkStrength, forceLinkDistance]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="editor.graph-canvas"
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
