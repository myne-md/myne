import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NoteGraph } from "../lib/wikilinks";
import {
  ALPHA_DECAY,
  ALPHA_MIN,
  CULL_MARGIN,
  fitTransform,
  K_MAX,
  K_MIN,
  LABEL_COARSE_CHARS,
  LABEL_FINE_CHARS,
  LABEL_FINE_K,
  LABEL_LOD_K,
  ringSeed,
  stepForces,
  type KernelNode,
  type LayoutRequest,
} from "../lib/graph-layout-kernel";
import { runLayout } from "../lib/graph-layout-run";
import {
  isEdgeVisible,
  isNodeVisible,
  visibleBounds,
  type ViewTransform,
} from "../lib/graph-culling";
import {
  getGraphPosition,
  setGraphPositions,
} from "../lib/graph-layout-store";
import {
  ensureGraphLayoutHydrated,
  flushGraphLayoutNow,
  scheduleGraphLayoutFlush,
} from "../lib/graph-layout-persist";

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function clampK(k: number): number {
  return Math.max(K_MIN, Math.min(K_MAX, k));
}

/** A kernel node + the render-only fields (title drives the label, degree the
 *  radius). The force pass mutates the kernel fields in place. */
type SimNode = KernelNode & { title: string; degree: number };

/**
 * A force-directed wikilink graph — connected notes repel, links pull them
 * together, so the layout is organic (Obsidian-style) rather than a rigid ring.
 * Nodes are DRAGGABLE (drag to rearrange, the rest reacts); a tap opens the
 * note; the background pans (one finger), pinches (two), and double-taps back
 * to fit. EVERY note in the graph model is a node, including unlinked ones —
 * an orphan is a first-class result here, not something to hide (it is how you
 * find the note you forgot to link), and the desktop graph has always shown
 * them (myne-md/myne#199). The sim cools to idle to save battery and reheats
 * whenever you touch it.
 *
 * Layout lifecycle (MYND-530 — the desktop graph rework's mobile port):
 * positions hydrate from the encrypted `vault.graph` cache (once per unlock
 * session) so a remounting tab restores the previous arrangement instead of
 * recomputing; a fully-restored layout mounts SETTLED (alpha 0 — it visibly
 * stays put); a cold vault computes its first layout off-thread via
 * `runLayout` (worker with sync fallback); positions flush back (debounced)
 * on drag-end / sim-idle / worker-apply, synchronously on unmount, and drop
 * from RAM on vault lock (`lockVault()`).
 */
export function WikiGraph({ graph, onOpen }: { graph: NoteGraph; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const graphNodes = graph.nodes;

  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const byId = useRef<Map<string, SimNode>>(new Map());
  const alphaRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const dragRef = useRef<{ id: string; moved: boolean; sx: number; sy: number } | null>(null);
  const [, tick] = useReducer((x: number) => (x + 1) % 1_000_000, 0);
  const [size, setSize] = useState({ w: 340, h: 480 });
  const [measured, setMeasured] = useState(false);

  // The rAF chains (sim + render) outlive any single render, so everything
  // they touch lives in refs — a stale closure can never integrate against an
  // old box size or edge set.
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const edgesRef = useRef(graph.edges);
  edgesRef.current = graph.edges;

  // Pan/zoom view transform (screen = graph * k + translate). Ref, not state:
  // gestures mutate it and coalesce a render — no per-move React commit.
  const viewRef = useRef<ViewTransform>({ x: 0, y: 0, k: 1 });
  const renderRafRef = useRef<number | null>(null);
  // Background gesture pointers (node drags never land here — the node
  // handlers stopPropagation). pointerId → last svg-local position.
  const svgPtrs = useRef<Map<number, { x: number; y: number }>>(new Map());
  const tapRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const lastTapRef = useRef<{ t: number; x: number; y: number } | null>(null);

  // Flow-test observability (mirrors the desktop E2E contract, SYNC-8 —
  // bounded values only, never a note id or coordinate).
  const layoutNonceRef = useRef(0);
  const hydratedRef = useRef(false);
  const settledRef = useRef(false);

  // Measure the available area so the sim runs in real pixels (1 svg unit =
  // 1px at k=1). The first real measurement opens the `measured` gate the
  // layout effect waits behind — seeding against the default box would bake
  // wrong geometry into the persisted layout.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => {
      setSize({ w: el.clientWidth || 340, h: el.clientHeight || 480 });
      setMeasured(true);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const idsKey = graphNodes.map((n) => n.id).join(",");

  // (Re)build the simulation when the node set changes (NOT on resize —
  // desktop parity: a rotation/box change re-renders at current positions,
  // never re-layouts). Positions come from, in precedence order: the live sim
  // (tab still mounted), the hydrated `vault.graph` store, or the
  // deterministic jittered ring. The classification decides motion:
  // fully-restored → settled at alpha 0; partially → gentle settle; cold →
  // off-thread layout, then frozen.
  useEffect(() => {
    if (!measured) return;
    let cancelled = false;
    layoutNonceRef.current += 1;

    void (async () => {
      await ensureGraphLayoutHydrated();
      if (cancelled) return;

      const { w, h } = sizeRef.current;
      const prev = byId.current;
      let persisted = 0;
      const seeded = graphNodes.map((n, i) => {
        const keep = prev.get(n.id);
        const stored = keep ? undefined : getGraphPosition(n.id);
        if (keep || stored) persisted += 1;
        const p = keep ?? stored ?? ringSeed(n.id, i, graphNodes.length, w, h);
        const node: SimNode =
          keep ??
          ({ id: n.id, title: n.title, degree: n.degree, x: p.x, y: p.y, vx: 0, vy: 0, fixed: false } as SimNode);
        node.degree = n.degree;
        node.title = n.title;
        return node;
      });
      nodesRef.current = seeded;
      byId.current = new Map(seeded.map((s) => [s.id, s]));
      hydratedRef.current = persisted > 0;

      const fitAndRender = () => {
        viewRef.current = fitTransform(nodesRef.current, sizeRef.current.w, sizeRef.current.h);
        tick();
      };

      if (seeded.length === 0 || persisted === seeded.length) {
        // Fully restored (or empty): the arrangement stays put — that IS the
        // persistence feature. No sim, no write (nothing changed).
        alphaRef.current = 0;
        settledRef.current = true;
        fitAndRender();
      } else if (persisted > 0) {
        // Partial: warm-started nodes keep their place, fresh nodes settle in.
        fitAndRender();
        reheat(0.3);
      } else {
        // Cold: paint the deterministic ring immediately (never a blank
        // frame), compute the real layout off-thread, then stay frozen — the
        // kernel already ran to convergence.
        fitAndRender();
        const req: LayoutRequest = {
          nodes: seeded.map((n) => ({ id: n.id })),
          edges: edgesRef.current.map((e) => ({ source: e.from, target: e.to, weight: 1 })),
          seed: {},
          width: w,
          height: h,
        };
        const res = await runLayout(req);
        if (cancelled) return;
        for (const p of res.positions) {
          const n = byId.current.get(p.id);
          if (n && !n.fixed) {
            n.x = p.x;
            n.y = p.y;
            n.vx = 0;
            n.vy = 0;
          }
        }
        setGraphPositions(res.positions);
        scheduleGraphLayoutFlush();
        alphaRef.current = 0;
        settledRef.current = true;
        fitAndRender();
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, measured]);

  function reheat(a: number) {
    alphaRef.current = Math.max(alphaRef.current, a);
    settledRef.current = false;
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(step);
  }

  function step() {
    const nodes = nodesRef.current;
    const { w, h } = sizeRef.current;
    let alpha = alphaRef.current;

    stepForces(nodes, byId.current, edgesRef.current, alpha, w / 2, h / 2);

    alpha *= ALPHA_DECAY;
    alphaRef.current = alpha;
    if (alpha > ALPHA_MIN || dragRef.current) {
      tick();
      rafRef.current = requestAnimationFrame(step);
    } else {
      // Sim idle: the cooled arrangement is the authoritative one — persist it
      // (the drag-end write only captured positions mid-settle).
      rafRef.current = null;
      settledRef.current = true;
      setGraphPositions(nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })));
      scheduleGraphLayoutFlush();
      tick();
    }
  }

  /** One coalesced render for gesture-driven view changes (single rAF). */
  function scheduleRender() {
    if (renderRafRef.current != null) return;
    renderRafRef.current = requestAnimationFrame(() => {
      renderRafRef.current = null;
      tick();
    });
  }

  // Pointer → svg-local pixel coords.
  function toLocal(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // svg-local → graph-space (inverse of screen = graph * k + translate).
  function toGraph(p: { x: number; y: number }): { x: number; y: number } {
    const v = viewRef.current;
    return { x: (p.x - v.x) / v.k, y: (p.y - v.y) / v.k };
  }

  function fitToContent() {
    viewRef.current = fitTransform(nodesRef.current, sizeRef.current.w, sizeRef.current.h);
    scheduleRender();
  }

  // Background gestures: one pointer pans, two pinch (zoom about the
  // midpoint), a quick double-tap refits. Ignored entirely while a node drag
  // is active.
  function onSvgPointerDown(ev: React.PointerEvent<SVGSVGElement>) {
    if (dragRef.current) return;
    svgRef.current?.setPointerCapture?.(ev.pointerId);
    const p = toLocal(ev);
    svgPtrs.current.set(ev.pointerId, p);
    tapRef.current = svgPtrs.current.size === 1 ? { x: p.x, y: p.y, moved: false } : null;
  }

  function onSvgPointerMove(ev: React.PointerEvent<SVGSVGElement>) {
    const pts = svgPtrs.current;
    const prev = pts.get(ev.pointerId);
    if (!prev) return;
    const cur = toLocal(ev);
    const v = viewRef.current;
    if (pts.size === 1) {
      if (tapRef.current && Math.hypot(cur.x - tapRef.current.x, cur.y - tapRef.current.y) > 8) {
        tapRef.current.moved = true;
      }
      v.x += cur.x - prev.x;
      v.y += cur.y - prev.y;
      pts.set(ev.pointerId, cur);
      scheduleRender();
    } else if (pts.size === 2) {
      tapRef.current = null;
      const otherEntry = [...pts.entries()].find(([id]) => id !== ev.pointerId);
      if (!otherEntry) return;
      const other = otherEntry[1];
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
      const d1 = Math.hypot(cur.x - other.x, cur.y - other.y);
      pts.set(ev.pointerId, cur);
      const k2 = clampK(v.k * (d1 / Math.max(d0, 1e-6)));
      const m0 = { x: (prev.x + other.x) / 2, y: (prev.y + other.y) / 2 };
      const m1 = { x: (cur.x + other.x) / 2, y: (cur.y + other.y) / 2 };
      // Zoom about the old midpoint, then pan by the midpoint's travel.
      v.x = m0.x - ((m0.x - v.x) * k2) / v.k;
      v.y = m0.y - ((m0.y - v.y) * k2) / v.k;
      v.k = k2;
      v.x += m1.x - m0.x;
      v.y += m1.y - m0.y;
      scheduleRender();
    }
  }

  function onSvgPointerUp(ev: React.PointerEvent<SVGSVGElement>) {
    const p = svgPtrs.current.get(ev.pointerId);
    svgPtrs.current.delete(ev.pointerId);
    svgRef.current?.releasePointerCapture?.(ev.pointerId);
    if (!p || !tapRef.current || tapRef.current.moved) {
      tapRef.current = null;
      return;
    }
    // A clean background tap — double-tap (<300 ms, <30 px apart) refits.
    const now = performance.now();
    const last = lastTapRef.current;
    if (last && now - last.t < 300 && Math.hypot(p.x - last.x, p.y - last.y) < 30) {
      lastTapRef.current = null;
      fitToContent();
    } else {
      lastTapRef.current = { t: now, x: p.x, y: p.y };
    }
    tapRef.current = null;
  }

  function onSvgPointerCancel(ev: React.PointerEvent<SVGSVGElement>) {
    svgPtrs.current.delete(ev.pointerId);
    tapRef.current = null;
  }

  // Unmount: stop both rAF chains and flush the freshest positions — the tab
  // unmounts on every navigation, so this is the hot persistence seam. NO
  // store write here: after a lock reset this must stay a no-op (the
  // `hasGraphLayout()` guard inside the flush), never re-populating the store
  // with the locked vault's positions.
  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      if (renderRafRef.current != null) cancelAnimationFrame(renderRafRef.current);
      void flushGraphLayoutNow();
    },
    [],
  );

  const paneAttrs = {
    "data-testid": "editor.graph-pane",
    "data-node-count": graphNodes.length,
    "data-layout-hydrated": hydratedRef.current ? "true" : "false",
    "data-layout-nonce": String(layoutNonceRef.current),
    "data-layout-settled": settledRef.current ? "true" : "false",
  } as const;

  if (graphNodes.length === 0) {
    return (
      <div {...paneAttrs} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 44px", textAlign: "center", gap: 10 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-1)" }}>{t("wikiGraph.emptyTitle")}</div>
        <div style={{ fontSize: 14, lineHeight: 1.55, color: "var(--fg-3)" }}>
          {t("wikiGraph.emptyBodyBefore")}<span style={{ fontFamily: "var(--font-mono)" }}>[[Note title]]</span>{t("wikiGraph.emptyBodyAfter")}
        </div>
      </div>
    );
  }

  const nodes = nodesRef.current;
  const maxDeg = Math.max(1, ...graphNodes.map((n) => n.degree));
  const view = viewRef.current;
  // Cull before mapping to SVG elements — off-screen notes never become DOM
  // nodes, which is what keeps a large vault's graph responsive when zoomed in.
  const bounds = visibleBounds(view, size.w, size.h, CULL_MARGIN);
  const showLabels = view.k >= LABEL_LOD_K;
  const labelChars = view.k >= LABEL_FINE_K ? LABEL_FINE_CHARS : LABEL_COARSE_CHARS;

  return (
    <div {...paneAttrs} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div ref={wrapRef} style={{ flex: 1, minHeight: 0, position: "relative", touchAction: "none", overflow: "hidden" }}>
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          viewBox={`0 0 ${size.w} ${size.h}`}
          style={{ display: "block", touchAction: "none" }}
          onPointerDown={onSvgPointerDown}
          onPointerMove={onSvgPointerMove}
          onPointerUp={onSvgPointerUp}
          onPointerCancel={onSvgPointerCancel}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            {graph.edges.map((e) => {
              const a = byId.current.get(e.from);
              const b = byId.current.get(e.to);
              if (!a || !b || !isEdgeVisible(a, b, bounds)) return null;
              return (
                <line
                  key={`${e.from}:${e.to}`}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  stroke="var(--line-2)"
                  strokeWidth={1}
                  strokeOpacity={0.8}
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
            {nodes.map((n) => {
              if (!isNodeVisible(n, bounds)) return null;
              const r = 5 + (n.degree / maxDeg) * 8;
              return (
                <g
                  key={n.id}
                  style={{ cursor: "pointer", touchAction: "none" }}
                  onPointerDown={(ev) => {
                    ev.stopPropagation();
                    (ev.currentTarget as SVGGElement).setPointerCapture?.(ev.pointerId);
                    const p = toLocal(ev);
                    dragRef.current = { id: n.id, moved: false, sx: p.x, sy: p.y };
                    n.fixed = true;
                    reheat(0.5);
                  }}
                  onPointerMove={(ev) => {
                    const d = dragRef.current;
                    if (!d || d.id !== n.id) return;
                    const p = toLocal(ev);
                    // Tap-vs-drag threshold in SCREEN px so a tap opens the
                    // note at any zoom level.
                    if (Math.abs(p.x - d.sx) + Math.abs(p.y - d.sy) > 4) d.moved = true;
                    const g = toGraph(p);
                    n.x = g.x;
                    n.y = g.y;
                    n.vx = 0;
                    n.vy = 0;
                    reheat(0.35);
                  }}
                  onPointerUp={(ev) => {
                    const d = dragRef.current;
                    dragRef.current = null;
                    n.fixed = false;
                    reheat(0.25);
                    if (d && !d.moved) {
                      onOpen(n.id);
                    } else if (d) {
                      // Drag-end with movement: persist the rearrangement
                      // (the sim-idle write will refine it as things settle).
                      setGraphPositions(nodesRef.current.map((s) => ({ id: s.id, x: s.x, y: s.y })));
                      scheduleGraphLayoutFlush();
                    }
                    (ev.currentTarget as SVGGElement).releasePointerCapture?.(ev.pointerId);
                  }}
                  onPointerCancel={() => { dragRef.current = null; n.fixed = false; }}
                >
                  <circle cx={n.x} cy={n.y} r={r} fill="var(--accent)" />
                  {showLabels && (
                    <text x={n.x} y={n.y + r + 12} textAnchor="middle" fontSize={10} fill="var(--fg-2)" style={{ fontFamily: "var(--font-sans)", pointerEvents: "none" }}>
                      {truncate(n.title, labelChars)}
                    </text>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
}
