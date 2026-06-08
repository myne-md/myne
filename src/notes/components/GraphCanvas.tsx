// The d3-force graph renderer (knowledge-graph-ux #4 / MYND-198, task 2). The
// lazy-loaded chunk that carries d3-force (kept out of the initial bundle).
// PARAMETERIZED by `model` (SYNC-16) so local-graph (#5) reuses it with a
// BFS-bounded subgraph. Hand-rolled canvas: d3-force computes node POSITIONS
// only; render + pan/zoom/hit-test/drag are ours (the dep is scoped to the
// genuinely-hard n-body math — dependency-policy.md Q1).
//
// Scale posture (SYNC-12): the force sim runs a BOUNDED tick loop then FREEZES
// (no perpetual rAF loop — d3-force's default would peg a CPU core, unacceptable
// for a calm privacy-notes app). Directed edges (arrowheads) preserve
// who-links-whom. Navigation-only: click opens; node-drag is view-state, never
// persisted.

import {
  forceCenter,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
} from "d3-force";
import { useEffect, useRef } from "react";
import type { GraphEdge, GraphModel, GraphNode } from "../graphAdapter";

type SimNode = GraphNode & { x: number; y: number };
type SimLink = { source: SimNode; target: SimNode; weight: number };

const NODE_RADIUS = 5;
const TICKS = 240; // bounded → freeze; enough for a low-thousands layout to settle

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

    // Size the backing store to the element (DPR-aware).
    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
    };
    resize();

    // d3-force node/link objects (it mutates x/y). Center the layout.
    const rect = canvas.getBoundingClientRect();
    const nodes: SimNode[] = model.nodes.map((n) => ({
      ...n,
      x: rect.width / 2 + (Math.random() - 0.5) * rect.width,
      y: rect.height / 2 + (Math.random() - 0.5) * rect.height,
    }));
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

    // Run a BOUNDED simulation then STOP (static layout, no animation loop).
    const sim: Simulation<SimNode, undefined> = forceSimulation(nodes)
      .force("charge", forceManyBody().strength(-120))
      // links already carry resolved node objects (not ids), so forceLink uses
      // them directly — no `.id()` accessor needed.
      .force("link", forceLink<SimNode, SimLink>(links).distance(60))
      .force("center", forceCenter(rect.width / 2, rect.height / 2))
      .stop();
    sim.tick(TICKS);
    sim.stop();

    let raf = 0;
    const render = () => {
      raf = 0;
      const v = viewRef.current;
      ctx.save();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr, dpr);
      ctx.translate(v.x, v.y);
      ctx.scale(v.k, v.k);

      // Edges (directed: a short arrowhead near the target).
      ctx.lineWidth = 1 / v.k;
      ctx.strokeStyle = colEdge;
      ctx.fillStyle = colArrow;
      for (const l of linksRef.current) {
        ctx.beginPath();
        ctx.moveTo(l.source.x, l.source.y);
        ctx.lineTo(l.target.x, l.target.y);
        ctx.stroke();
        // Arrowhead: a small triangle just before the target node.
        const dx = l.target.x - l.source.x;
        const dy = l.target.y - l.source.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        const tipX = l.target.x - ux * (NODE_RADIUS + 1);
        const tipY = l.target.y - uy * (NODE_RADIUS + 1);
        const ah = 4 / v.k;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - ux * ah - uy * ah * 0.6, tipY - uy * ah + ux * ah * 0.6);
        ctx.lineTo(tipX - ux * ah + uy * ah * 0.6, tipY - uy * ah - ux * ah * 0.6);
        ctx.closePath();
        ctx.fill();
      }

      // Nodes.
      for (const n of nodesRef.current) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, NODE_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = colNode;
        ctx.fill();
      }

      // Labels only when zoomed in (level-of-detail, calm at overview).
      if (v.k >= 1.4) {
        ctx.fillStyle = colLabel;
        ctx.font = `${11 / v.k}px sans-serif`;
        for (const n of nodesRef.current) {
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
        // Node drag is view-state only — never persisted.
        dragNode.x += dx / viewRef.current.k;
        dragNode.y += dy / viewRef.current.k;
      }
      schedule();
    };
    const onPointerUp = (e: PointerEvent) => {
      if (mode === "drag" && dragNode && !moved) {
        const id = dragNode.id;
        if (onNodeDoubleClick) {
          // Defer: a dblclick within the window cancels this (pivot vs navigate).
          cancelPendingClick();
          clickTimer = setTimeout(() => {
            clickTimer = null;
            onNodeClick(id);
          }, 250);
        } else {
          onNodeClick(id); // whole graph: single click navigates, fire at once
        }
      }
      mode = "none";
      dragNode = null;
      canvas.releasePointerCapture(e.pointerId);
    };
    const onDblClick = (e: MouseEvent) => {
      cancelPendingClick(); // a double-click is navigate, never the pivot
      if (!onNodeDoubleClick) return;
      const g = toGraph(e.clientX, e.clientY);
      const n = hitNode(g.x, g.y);
      if (n) onNodeDoubleClick(n.id);
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
      schedule();
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("dblclick", onDblClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("resize", onResize);

    return () => {
      sim.stop();
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
  }, [model, onNodeClick, onNodeDoubleClick]);

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
