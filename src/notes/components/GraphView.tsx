// Whole-vault graph view (knowledge-graph-ux #4 / MYND-198). A full-window
// modal carve-out (ModalShell + an Editor-local boolean), per the design canon
// (README.md:131 "a separate panel that replaces the editor, not a fourth
// pane") and src/CLAUDE.md (large surface = modal-class, NOT a Stage variant).
// Launched from a command-palette action AND a persistent BottomBar affordance
// (SYNC-7 — graph is wedge-first-class, not palette-only).

import { lazy, Suspense, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ModalShell } from "../../components/primitives/ModalShell";
import {
  isolatedModel,
  loadNeighborhood,
  loadSubgraphForNotes,
  loadWholeVaultGraph,
  type GraphModel,
} from "../graphAdapter";
import { getIndexNonce, useIndexNonce } from "../indexNonce";
import { useResolverNotes } from "../resolverNotes";
import { liveIdSet } from "../resolveWikilink";
import { useSelectedNote } from "../sidebarState";
import {
  byTag,
  tagTree,
  vaultIndicesOrphans,
  type TagTreeNode,
} from "../vaultIndices";

// Lazy-loaded so the d3-force + canvas-renderer chunk stays OUT of the initial
// bundle (vision.md "separate, lazy-loaded"; SYNC-8 TB9 posture). The app's
// first React.lazy boundary.
const GraphCanvas = lazy(() => import("./GraphCanvas"));

type Filter =
  | { kind: "all" }
  | { kind: "orphans" }
  | { kind: "tag"; key: string }
  // local-graph (#5): the note-relative entry mode — centered on `seed`, the
  // open note's 1-2 hop neighborhood. Pivot re-points `seed`; double-click navigates.
  | { kind: "local"; seed: string; depth: 1 | 2 };

const MESSAGE_STYLE = {
  flex: 1,
  display: "grid",
  placeItems: "center",
  color: "var(--fg-3)",
  fontSize: 13,
  padding: 24,
  textAlign: "center" as const,
};

export function GraphView({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const notes = useResolverNotes();
  const ctx = useSelectedNote();
  const indexNonce = useIndexNonce();
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [model, setModel] = useState<GraphModel | null>(null);
  const [overCap, setOverCap] = useState(false);
  const [tags, setTags] = useState<TagTreeNode[]>([]);
  const [buildNonce, setBuildNonce] = useState(0);
  const [buildTrigger, setBuildTrigger] = useState(0);

  // Tag list for the filter (fetched on open).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void tagTree().then(
      (t) => {
        if (!cancelled) setTags(t);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Build the model for the current filter. DELIBERATELY does NOT depend on
  // indexNonce (SYNC-14: the frozen graph does NOT auto-rejumble on a vault
  // change — the user refreshes explicitly). `buildTrigger` forces a rebuild.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setModel(null);
    setOverCap(false);
    const liveIds = liveIdSet(notes);
    const build = async (): Promise<GraphModel | null> => {
      if (filter.kind === "orphans") {
        // Degree-0 index query — works at any vault size, no dump (SYNC-13).
        return isolatedModel(await vaultIndicesOrphans(), notes);
      }
      if (filter.kind === "tag") {
        // The tag's notes (subtree-inclusive) → a bounded per-note subgraph.
        return loadSubgraphForNotes(await byTag(filter.key, liveIds), notes);
      }
      if (filter.kind === "local") {
        // The open-note neighborhood — bounded per-note BFS, any vault size.
        return loadNeighborhood(filter.seed, filter.depth, "both", notes);
      }
      return loadWholeVaultGraph(notes); // "all" — null when over the cap
    };
    void build().then(
      (m) => {
        if (cancelled) return;
        setBuildNonce(getIndexNonce());
        if (m === null) setOverCap(true);
        else setModel(m);
      },
      () => {
        if (!cancelled) setBuildNonce(getIndexNonce());
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, filter, notes, buildTrigger]);

  if (!open) return null;

  // SYNC-14: stale when the index changed since the layout was built. The
  // expensive re-layout is gated to an explicit refresh, never the nonce.
  const stale = indexNonce !== buildNonce;
  const onOpenNode = (id: string) => {
    onClose();
    void ctx.open(id).catch(() => {});
  };

  const width = Math.max(640, window.innerWidth - 96);
  const height = Math.max(480, window.innerHeight - 96);

  let content: ReactNode;
  if (overCap) {
    content = (
      <div style={MESSAGE_STYLE}>
        This vault is large — the whole-vault graph is capped. Filter to a tag or
        show isolated notes to explore.
      </div>
    );
  } else if (model === null) {
    content = <div style={MESSAGE_STYLE}>Building graph…</div>;
  } else if (model.nodes.length === 0) {
    content = (
      <div style={MESSAGE_STYLE}>
        {filter.kind === "orphans"
          ? "Everything is connected — no isolated notes."
          : "No notes to graph yet."}
      </div>
    );
  } else {
    content = (
      <Suspense fallback={<div style={MESSAGE_STYLE}>Loading graph…</div>}>
        <GraphCanvas
          model={model}
          // Whole/orphans/tag: a click navigates. Local: a click PIVOTS
          // (re-center, no ctx.open side-effect — SYNC-6); double-click navigates.
          onNodeClick={
            filter.kind === "local"
              ? (id) => setFilter({ kind: "local", seed: id, depth: filter.depth })
              : onOpenNode
          }
          onNodeDoubleClick={filter.kind === "local" ? onOpenNode : undefined}
        />
      </Suspense>
    );
  }

  return (
    <ModalShell
      open={open}
      title="Graph"
      labelId="graph-view-title"
      onClose={onClose}
      width={width}
      height={height}
    >
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 12px",
          borderBottom: "1px solid var(--line-1)",
          fontSize: 12,
        }}
      >
        <FilterChip
          label="All"
          active={filter.kind === "all"}
          onClick={() => setFilter({ kind: "all" })}
        />
        <FilterChip
          label="Isolated"
          active={filter.kind === "orphans"}
          onClick={() => setFilter({ kind: "orphans" })}
        />
        {ctx.selectedId !== null && (
          <FilterChip
            label="Around this note"
            active={filter.kind === "local"}
            onClick={() =>
              setFilter({ kind: "local", seed: ctx.selectedId as string, depth: 1 })
            }
          />
        )}
        {filter.kind === "local" && (
          <button
            type="button"
            onClick={() =>
              setFilter({ ...filter, depth: filter.depth === 1 ? 2 : 1 })
            }
            title="Toggle neighborhood depth (1 ↔ 2 hops)"
            style={{
              fontSize: 12,
              padding: "3px 8px",
              background: "var(--bg-1)",
              color: "var(--fg-2)",
              border: "1px solid var(--line-1)",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            {filter.depth} hop
          </button>
        )}
        {tags.length > 0 && (
          <select
            value={filter.kind === "tag" ? filter.key : ""}
            onChange={(e) =>
              setFilter(
                e.target.value === ""
                  ? { kind: "all" }
                  : { kind: "tag", key: e.target.value },
              )
            }
            aria-label="Filter by tag"
            style={{
              fontSize: 12,
              padding: "3px 6px",
              background: "var(--bg-1)",
              color: "var(--fg-2)",
              border: "1px solid var(--line-1)",
              borderRadius: 6,
            }}
          >
            <option value="">Tag…</option>
            {tags.map((t) => (
              <option key={t.key} value={t.key}>
                {`#${t.display} (${t.subtreeCount})`}
              </option>
            ))}
          </select>
        )}
        <div style={{ flex: 1 }} />
        {stale && (
          <button
            type="button"
            onClick={() => setBuildTrigger((n) => n + 1)}
            title="The vault changed — rebuild the graph"
            style={{
              fontSize: 12,
              padding: "3px 8px",
              background: "var(--bg-1)",
              color: "var(--fg-2)",
              border: "1px solid var(--line-1)",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Refresh
          </button>
        )}
      </div>
      {content}
    </ModalShell>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        fontSize: 12,
        padding: "3px 10px",
        background: active ? "var(--paper-3)" : "transparent",
        color: active ? "var(--fg-1)" : "var(--fg-3)",
        border: "1px solid var(--line-1)",
        borderRadius: 6,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
