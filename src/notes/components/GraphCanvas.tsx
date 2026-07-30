// The graph renderer (knowledge-graph-ux #4 / MYND-198, task 2). The
// lazy-loaded chunk (kept out of the initial bundle). PARAMETERIZED by `model`
// (SYNC-16) so local-graph (#5) reuses it with a BFS-bounded subgraph.
// Hand-rolled canvas: layout computes node POSITIONS only; render + pan/zoom/
// hit-test/drag are ours (the dep is scoped to the genuinely-hard n-body math —
// dependency-policy.md Q1).
//
// Scale posture (SYNC-12): the force sim runs a BOUNDED tick loop then FREEZES
// (no perpetual rAF loop). As of Phase A it runs OFF the main thread in a Web
// Worker (`graphLayout.worker.ts`) — the WebView never blocks on layout — and
// positions WARM-START from `graphLayoutStore` so a re-layout gently settles
// instead of re-scattering from `Math.random()` (the "flashbang" cause).
// Directed edges (arrowheads) preserve who-links-whom. Navigation-only: click
// opens; node-drag is persisted to the layout store (Phase A) so a manual
// arrangement survives filter switches / tab open-close.

import { useEffect, useRef, useState } from "react";
import type { GraphEdge, GraphModel, GraphNode } from "../graphAdapter";
import {
  getGraphPosition,
  seedInitialPosition,
  seedPositions,
  setGraphPositions,
} from "../graphLayoutStore";
import { resolveNodeRadius } from "../graphSettings";
import type {
  LayoutRequest,
  LayoutResponse,
} from "../graphLayoutProtocol";
import { isEdgeVisible, isNodeVisible, visibleBounds } from "../graphCulling";
import { scheduleGraphLayoutFlush } from "../graphLayoutPersist";

type SimNode = GraphNode & { x: number; y: number };
type SimLink = { source: SimNode; target: SimNode; weight: number };

// Coarse-pointer devices keep the same *ratio* above the label-fade zoom the
// pre-task-6 hardcoded thresholds had (2.2 / 1.4), rather than a second
// persisted field — one slider tunes both.
const COARSE_LOD_SCALE = 2.2 / 1.4;
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
const COLOR_KEY_SHAPE = /^[a-z0-9-]+$/;

export default function GraphCanvas({
  model,
  onNodeClick,
  onNodeDoubleClick,
  nodeColors,
  arrowsEnabled = true,
  labelFadeZoom = 1.4,
  nodeSize = 5,
  nodeSizeStrength = 0,
  lineThickness = 1,
  forceCenterStrength = 1,
  forceRepelStrength = 120,
  forceLinkStrength = 1,
  forceLinkDistance = 60,
}: {
  model: GraphModel;
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
  const cbRef = useRef({ onNodeClick, onNodeDoubleClick });
  cbRef.current = { onNodeClick, onNodeDoubleClick };
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

    // Size the backing store to the element (DPR-aware) and cache the CSS box
    // (culling reads it every frame — never call getBoundingClientRect in the
    // render loop; that forces a layout reflow).
    const dpr = window.devicePixelRatio || 1;
    let cssW = 0;
    let cssH = 0;
    const resize = () => {
      const r = canvas.getBoundingClientRect();
      cssW = r.width;
      cssH = r.height;
      sizeRef.current = { width: cssW, height: cssH };
      canvas.width = Math.max(1, Math.floor(r.width * dpr));
      canvas.height = Math.max(1, Math.floor(r.height * dpr));
    };
    resize();

    // Node objects for render/hit-test. WARM-START from the layout store: a
    // node keeps its last position (continuity, no re-scatter); a brand-new
    // node seeds at center + jitter until the worker settles it. Uses the
    // cached CSS box (no second getBoundingClientRect).
    const cx = cssW / 2;
    const cy = cssH / 2;
    const nodes: SimNode[] = model.nodes.map((n) => {
      const p = seedInitialPosition(getGraphPosition(n.id), cx, cy, cssW, cssH);
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
    const worker = new Worker(
      new URL("../graphLayout.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e: MessageEvent<LayoutResponse>) => {
      const pos = new Map(e.data.positions.map((p) => [p.id, p]));
      for (const n of nodesRef.current) {
        const p = pos.get(n.id);
        if (p !== undefined) {
          n.x = p.x;
          n.y = p.y;
        }
      }
      setGraphPositions(e.data.positions); // persist for warm-start next open
      scheduleGraphLayoutFlush(); // debounced flush to the encrypted vault.graph
      schedule();
    };
    const nodeIds = model.nodes.map((n) => n.id);
    worker.postMessage({
      nodes: nodeIds.map((id) => ({ id })),
      edges: model.edges,
      seed: seedPositions(nodeIds),
      width: cssW,
      height: cssH,
      // Current force settings at build time — a LIVE change to one of them
      // is handled by the separate `[forceCenterStrength, ...]` effect below,
      // not by re-running this effect (which would recreate the whole sim).
      forces: {
        centerStrength: forceCenterStrength,
        repelStrength: forceRepelStrength,
        linkStrength: forceLinkStrength,
        linkDistance: forceLinkDistance,
      },
    } satisfies LayoutRequest);

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
      // Level-of-detail thresholds — tighter on coarse pointers (mobile), and
      // the label one user-tunable via `labelFadeZoom` (task 6).
      const showLabels =
        v.k >= labelFadeZoomRef.current * (coarse ? COARSE_LOD_SCALE : 1);
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
    let mode: "none" | "pan" | "drag" = "none";
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

    const onPointerDown = (e: PointerEvent) => {
      moved = false;
      last = { x: e.clientX, y: e.clientY };
      const g = toGraph(e.clientX, e.clientY);
      dragNode = hitNode(g.x, g.y);
      mode = dragNode ? "drag" : "pan";
      canvas.setPointerCapture(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent) => {
      if (mode === "none") return;
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
        scheduleGraphLayoutFlush(); // debounced flush to disk (survives restart)
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
      const k2 = Math.min(8, Math.max(0.15, v.k * factor));
      // Zoom toward the cursor.
      v.x = cx - (cx - v.x) * (k2 / v.k);
      v.y = cy - (cy - v.y) * (k2 / v.k);
      v.k = k2;
      schedule();
    };

    const onResize = () => {
      resize();
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

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("dblclick", onDblClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", onResize);

    return () => {
      scheduleRef.current = null;
      worker.terminate();
      if (raf !== 0) cancelAnimationFrame(raf);
      cancelPendingClick();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("dblclick", onDblClick);
      canvas.removeEventListener("wheel", onWheel);
      // Was previously leaked — the anonymous resize listener accumulated one
      // per effect re-run (every model/filter change).
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
  // canvas/pointer-handler setup. Skips its first run — the `[model]` effect's
  // own initial `postMessage` already used the force values as of mount.
  const isFirstForcesRun = useRef(true);
  useEffect(() => {
    if (isFirstForcesRun.current) {
      isFirstForcesRun.current = false;
      return;
    }
    const nodes = nodesRef.current;
    if (nodes.length === 0) return;
    const seed: Record<string, { x: number; y: number }> = {};
    for (const n of nodes) seed[n.id] = { x: n.x, y: n.y };
    const edges = linksRef.current.map((l) => ({
      source: l.source.id,
      target: l.target.id,
      weight: l.weight,
    }));
    const size = sizeRef.current;
    const worker = new Worker(
      new URL("../graphLayout.worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onmessage = (e: MessageEvent<LayoutResponse>) => {
      const pos = new Map(e.data.positions.map((p) => [p.id, p]));
      for (const n of nodesRef.current) {
        const p = pos.get(n.id);
        if (p !== undefined) {
          n.x = p.x;
          n.y = p.y;
        }
      }
      setGraphPositions(e.data.positions);
      scheduleGraphLayoutFlush();
      scheduleRef.current?.();
      worker.terminate();
      setForceRelayoutRuns((n) => n + 1);
    };
    setForceRelayoutSeeded(Object.keys(seed).length);
    worker.postMessage({
      nodes: nodes.map((n) => ({ id: n.id })),
      edges,
      seed,
      width: size.width,
      height: size.height,
      forces: {
        centerStrength: forceCenterStrength,
        repelStrength: forceRepelStrength,
        linkStrength: forceLinkStrength,
        linkDistance: forceLinkDistance,
      },
    } satisfies LayoutRequest);
    // Bounded by construction (the worker runs its fixed tick budget once and
    // posts back one message) — no perpetual loop. If the effect re-fires
    // before that message arrives (a rapid slider drag), the cleanup below
    // terminates the stale worker first.
    return () => {
      worker.terminate();
    };
  }, [forceCenterStrength, forceRepelStrength, forceLinkStrength, forceLinkDistance]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="editor.graph-canvas"
      data-palette-nonce={String(paletteNonce)}
      data-force-relayout-count={String(forceRelayoutRuns)}
      data-force-relayout-seeded={String(forceRelayoutSeeded)}
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
