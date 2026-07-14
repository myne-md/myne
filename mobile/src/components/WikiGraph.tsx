import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NoteGraph } from "../lib/wikilinks";

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

type SimNode = {
  id: string;
  title: string;
  degree: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Pinned to the finger while dragging (excluded from integration). */
  fixed: boolean;
};

// Force constants — tuned for a phone-sized graph. Repulsion pushes every pair
// apart, links pull connected notes toward a rest length, a weak centre pull
// keeps the cloud on screen; velocity is damped and the whole thing cools so it
// settles (and reheats on drag).
const REPULSION = 5200;
const SPRING_K = 0.016;
const SPRING_LEN = 92;
const CENTER_K = 0.022;
const DAMPING = 0.86;

/**
 * A force-directed wikilink graph — connected notes repel, links pull them
 * together, so the layout is organic (Obsidian-style) rather than a rigid ring.
 * Nodes are DRAGGABLE (drag to rearrange, the rest reacts); a tap opens the note.
 * Notes with no links are omitted (surfaced as a count). The sim cools to idle to
 * save battery and reheats whenever you touch it.
 */
export function WikiGraph({ graph, onOpen }: { graph: NoteGraph; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const connected = graph.nodes.filter((n) => n.degree > 0);

  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const byId = useRef<Map<string, SimNode>>(new Map());
  const alphaRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const dragRef = useRef<{ id: string; moved: boolean } | null>(null);
  const [, tick] = useReducer((x: number) => (x + 1) % 1_000_000, 0);
  const [size, setSize] = useState({ w: 340, h: 480 });

  // Measure the available area so the sim runs in real pixels (1 svg unit = 1px).
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth || 340, h: el.clientHeight || 480 });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const idsKey = connected.map((n) => n.id).join(",");

  // (Re)seed the simulation when the node set or canvas size changes. Deterministic
  // spread on a jittered ring so it never starts perfectly regular.
  useEffect(() => {
    const { w, h } = size;
    const cx = w / 2, cy = h / 2;
    const R = Math.max(40, Math.min(w, h) / 2 - 60);
    const prev = byId.current;
    const seeded = connected.map((n, i) => {
      const keep = prev.get(n.id);
      const a = (2 * Math.PI * i) / connected.length - Math.PI / 2;
      // deterministic pseudo-jitter from the id so it looks scattered, not a ring
      const j = ((n.id.charCodeAt(0) + n.id.charCodeAt(n.id.length - 1)) % 37) / 37;
      return keep ?? {
        id: n.id, title: n.title, degree: n.degree,
        x: cx + (R * (0.55 + 0.45 * j)) * Math.cos(a),
        y: cy + (R * (0.55 + 0.45 * j)) * Math.sin(a),
        vx: 0, vy: 0, fixed: false,
      };
    });
    // refresh degree/title on kept nodes
    for (const s of seeded) {
      const src = connected.find((n) => n.id === s.id);
      if (src) { s.degree = src.degree; s.title = src.title; }
    }
    nodesRef.current = seeded;
    byId.current = new Map(seeded.map((s) => [s.id, s]));
    reheat(0.9);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, size.w, size.h]);

  function reheat(a: number) {
    alphaRef.current = Math.max(alphaRef.current, a);
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(step);
  }

  function step() {
    const nodes = nodesRef.current;
    const { w, h } = size;
    const cx = w / 2, cy = h / 2;
    let alpha = alphaRef.current;

    // pairwise repulsion
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let k = i + 1; k < nodes.length; k++) {
        const b = nodes[k];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { d2 = 1; dx = (Math.random() - 0.5) || 0.5; dy = Math.random() - 0.5; }
        const d = Math.sqrt(d2);
        const f = (REPULSION / d2) * alpha;
        const ux = dx / d, uy = dy / d;
        a.vx += ux * f; a.vy += uy * f;
        b.vx -= ux * f; b.vy -= uy * f;
      }
    }
    // link springs
    for (const e of graph.edges) {
      const a = byId.current.get(e.from);
      const b = byId.current.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - SPRING_LEN) * SPRING_K * alpha;
      const ux = dx / d, uy = dy / d;
      a.vx += ux * f; a.vy += uy * f;
      b.vx -= ux * f; b.vy -= uy * f;
    }
    // centring + integrate
    for (const n of nodes) {
      if (n.fixed) { n.vx = 0; n.vy = 0; continue; }
      n.vx += (cx - n.x) * CENTER_K * alpha;
      n.vy += (cy - n.y) * CENTER_K * alpha;
      n.vx *= DAMPING; n.vy *= DAMPING;
      n.x += n.vx; n.y += n.vy;
      n.x = Math.max(16, Math.min(w - 16, n.x));
      n.y = Math.max(16, Math.min(h - 22, n.y));
    }

    alpha *= 0.986;
    alphaRef.current = alpha;
    tick();
    if (alpha > 0.02 || dragRef.current) {
      rafRef.current = requestAnimationFrame(step);
    } else {
      rafRef.current = null;
    }
  }

  // Pointer → svg-pixel coords (viewBox == measured px, so it's a plain offset).
  function toLocal(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  useEffect(() => () => { if (rafRef.current != null) cancelAnimationFrame(rafRef.current); }, []);

  if (connected.length === 0) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 44px", textAlign: "center", gap: 10 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-1)" }}>{t("wikiGraph.emptyTitle")}</div>
        <div style={{ fontSize: 14, lineHeight: 1.55, color: "var(--fg-3)" }}>
          {t("wikiGraph.emptyBodyBefore")}<span style={{ fontFamily: "var(--font-mono)" }}>[[Note title]]</span>{t("wikiGraph.emptyBodyAfter")}
        </div>
      </div>
    );
  }

  const nodes = nodesRef.current;
  const maxDeg = Math.max(1, ...connected.map((n) => n.degree));

  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      <div ref={wrapRef} style={{ flex: 1, minHeight: 0, position: "relative", touchAction: "none", overflow: "hidden" }}>
        <svg ref={svgRef} width="100%" height="100%" viewBox={`0 0 ${size.w} ${size.h}`} style={{ display: "block" }}>
          {graph.edges.map((e, i) => {
            const a = byId.current.get(e.from);
            const b = byId.current.get(e.to);
            if (!a || !b) return null;
            return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--line-2)" strokeWidth={1} strokeOpacity={0.8} />;
          })}
          {nodes.map((n) => {
            const r = 5 + (n.degree / maxDeg) * 8;
            return (
              <g
                key={n.id}
                style={{ cursor: "pointer", touchAction: "none" }}
                onPointerDown={(ev) => {
                  ev.stopPropagation();
                  (ev.currentTarget as SVGGElement).setPointerCapture?.(ev.pointerId);
                  dragRef.current = { id: n.id, moved: false };
                  n.fixed = true;
                  reheat(0.5);
                }}
                onPointerMove={(ev) => {
                  const d = dragRef.current;
                  if (!d || d.id !== n.id) return;
                  const p = toLocal(ev);
                  if (Math.abs(p.x - n.x) > 3 || Math.abs(p.y - n.y) > 3) d.moved = true;
                  n.x = p.x; n.y = p.y; n.vx = 0; n.vy = 0;
                  reheat(0.35);
                }}
                onPointerUp={(ev) => {
                  const d = dragRef.current;
                  dragRef.current = null;
                  n.fixed = false;
                  reheat(0.25);
                  if (d && !d.moved) onOpen(n.id);
                  (ev.currentTarget as SVGGElement).releasePointerCapture?.(ev.pointerId);
                }}
                onPointerCancel={() => { dragRef.current = null; n.fixed = false; }}
              >
                <circle cx={n.x} cy={n.y} r={r} fill="var(--accent)" />
                <text x={n.x} y={n.y + r + 12} textAnchor="middle" fontSize={10} fill="var(--fg-2)" style={{ fontFamily: "var(--font-sans)", pointerEvents: "none" }}>
                  {truncate(n.title, 14)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
