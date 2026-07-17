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

import { useEffect, useRef } from "react";
import type { GraphEdge, GraphModel, GraphNode } from "../graphAdapter";
import {
  getGraphPosition,
  seedInitialPosition,
  seedPositions,
  setGraphPositions,
} from "../graphLayoutStore";
import type {
  LayoutRequest,
  LayoutResponse,
} from "../graphLayoutProtocol";
import { isEdgeVisible, isNodeVisible, visibleBounds } from "../graphCulling";
import { scheduleGraphLayoutFlush } from "../graphLayoutPersist";

type SimNode = GraphNode & { x: number; y: number };
type SimLink = { source: SimNode; target: SimNode; weight: number };

const NODE_RADIUS = 5;

export default function GraphCanvas({
  model,
  onNodeClick,
  onNodeDoubleClick,
}: {
  model: GraphModel;
  /** Single click on a node — navigate (whole graph) or pivot (local graph). */
  onNodeClick: (id: string) => void;
  /** Double click — the terminal navigate in local-graph (pivot vs navigate,
   *  SYNC-6: a pivot must NOT carry ctx.open's side-effects). Omit in the whole
   *  graph (where a single click already navigates). */
  onNodeDoubleClick?: (id: string) => void;
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return;

    // Resolve design tokens for the canvas (2D context needs concrete color
    // strings, not CSS vars) — so the graph follows the palette + dark mode
    // instead of hardcoded hex. Resolved once per open (the modal is transient).
    const cs = getComputedStyle(canvas);
    const token = (name: string, fallback: string) =>
      cs.getPropertyValue(name).trim() || fallback;
    const colNode = token("--fg-2", "#7a7a7a");
    const colEdge = token("--line-1", "#444");
    const colArrow = token("--fg-3", "#888");
    const colLabel = token("--fg-3", "#bdbdbd");

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
    } satisfies LayoutRequest);

    // Cull bookkeeping reused across frames (reset per render, never
    // re-allocated) and filled ONLY when its LOD consumer is active — so an
    // overview pan (arrows + labels off) does zero per-frame array work.
    const visibleLinks: SimLink[] = [];
    const visibleNodes: SimNode[] = [];
    const render = () => {
      raf = 0;
      visibleLinks.length = 0;
      visibleNodes.length = 0;
      const v = viewRef.current;
      ctx.save();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);
      ctx.translate(v.x, v.y);
      ctx.scale(v.k, v.k);

      // Cull to the visible graph box (margin = a few radii so partly-visible
      // nodes/labels aren't clipped). At high zoom this drops most of a large
      // graph; at overview everything is visible and batching carries the load.
      const bounds = visibleBounds(v, cssW, cssH, NODE_RADIUS * 4);
      // Level-of-detail thresholds — tighter on coarse pointers (mobile).
      const showLabels = v.k >= (coarse ? 2.2 : 1.4);
      const showArrows = v.k >= (coarse ? 1.2 : 0.6);

      // --- Edges: ONE batched stroke path for every visible line (was a
      // beginPath+stroke PER edge — the dominant Canvas cost at scale). Collect
      // the drawn edges for the arrowhead pass ONLY when arrows are shown. ---
      ctx.lineWidth = 1 / v.k;
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
          const tipX = l.target.x - ux * (NODE_RADIUS + 1);
          const tipY = l.target.y - uy * (NODE_RADIUS + 1);
          ctx.moveTo(tipX, tipY);
          ctx.lineTo(tipX - ux * ah - uy * ah * 0.6, tipY - uy * ah + ux * ah * 0.6);
          ctx.lineTo(tipX - ux * ah + uy * ah * 0.6, tipY - uy * ah - ux * ah * 0.6);
          ctx.closePath();
        }
        ctx.fill();
      }

      // --- Nodes: ONE batched fill path for every visible disc. `moveTo` to
      // each arc's start first so consecutive circles aren't joined by a line.
      // Collect the drawn nodes for the label pass ONLY when labels are shown. ---
      ctx.fillStyle = colNode;
      ctx.beginPath();
      for (const n of nodesRef.current) {
        if (!isNodeVisible(n, bounds)) continue;
        if (showLabels) visibleNodes.push(n);
        ctx.moveTo(n.x + NODE_RADIUS, n.y);
        ctx.arc(n.x, n.y, NODE_RADIUS, 0, Math.PI * 2);
      }
      ctx.fill();

      // --- Labels: only when zoomed in (calm at overview) and only for the
      // visible nodes. ---
      if (showLabels) {
        ctx.fillStyle = colLabel;
        ctx.font = `${11 / v.k}px sans-serif`;
        for (const n of visibleNodes) {
          if (n.title) ctx.fillText(n.title, n.x + NODE_RADIUS + 2, n.y + 3);
        }
      }
      ctx.restore();
    };
    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(render);
    };
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
      const rr = (NODE_RADIUS + 3) ** 2;
      for (const n of nodesRef.current) {
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

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("dblclick", onDblClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", onResize);

    return () => {
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
    };
  }, [model]);

  return (
    <canvas
      ref={canvasRef}
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
