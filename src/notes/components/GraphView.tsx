// Whole-vault graph view (knowledge-graph-ux #4 / MYND-198). Renders as a
// first-class workspace TAB (a `{kind:"graph"}` WorkspaceItem) — the editor's
// pane body, alongside note and saved-view tabs — not a modal carve-out. Opened
// via `ws.openGraph()` from a command-palette action, a persistent BottomBar
// affordance (SYNC-7 — graph is wedge-first-class), and the ⌘⇧G shortcut.

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  isolatedModel,
  loadNeighborhood,
  loadSubgraphForNotes,
  loadWholeVaultGraph,
  type GraphModel,
} from "../graphAdapter";
import { usePrefs } from "../../hooks/usePrefs";
import {
  buildColorGroupNoteMeta,
  collectRuleTags,
  resolveGraphColorGroups,
} from "../graphColorGroups";
import { DEFAULT_GRAPH_SETTINGS } from "../graphSettings";
import { getIndexNonce, useIndexNonce } from "../indexNonce";
import { loadGraphLayoutFromDisk } from "../graphLayoutPersist";
import { useResolverNotes } from "../resolverNotes";
import { liveIdSet } from "../resolveWikilink";
import { useSelectedNote } from "../sidebarState";
import {
  byTag,
  tagTree,
  vaultIndicesOrphans,
  type TagTreeNode,
} from "../vaultIndices";
import { useWorkspace } from "../workspaceContext";
import { GraphSettingsPanel } from "./GraphSettingsPanel";

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

// One stable identity for "no node is colored", so the no-rules case hands
// `GraphCanvas` the same map on every render and never schedules a repaint.
const NO_NODE_COLORS: ReadonlyMap<string, string> = new Map();

const MESSAGE_STYLE = {
  flex: 1,
  display: "grid",
  placeItems: "center",
  color: "var(--fg-3)",
  fontSize: "var(--text-sm)",
  padding: "var(--space-5)",
  textAlign: "center" as const,
};

export function GraphPane() {
  const { t } = useTranslation();
  const notes = useResolverNotes();
  // `notes` identity changes on EVERY sidebar-cache update (every note applied
  // during a sync / initial index). Read it through a ref inside the build
  // effect so that churn does NOT re-run the build and re-jumble the layout —
  // the graph freezes until the user explicitly Refreshes (SYNC-14 intent). The
  // build still captures the LATEST notes whenever it does run (filter change /
  // Refresh), because the ref is updated every render.
  const notesRef = useRef(notes);
  notesRef.current = notes;
  // Whether the persisted layout has been hydrated this mount (Tier 3). One
  // disk read per GraphPane mount, before the first build.
  const hydratedRef = useRef(false);
  const ctx = useSelectedNote();
  const ws = useWorkspace();
  const { prefs } = usePrefs();
  const indexNonce = useIndexNonce();
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [model, setModel] = useState<GraphModel | null>(null);
  const [tags, setTags] = useState<TagTreeNode[]>([]);
  // E2E test-observability (SYNC-8; modeled on AiHydrationProbe). Reflected onto
  // `data-*` on the graph pane — bounded totals + a boolean + an opaque monotonic
  // nonce, all post-unlock and DENY-list clean (never a note id or x/y coord):
  //   layoutHydrated — the disk-hydrate path ran this mount (Tier 3 restore);
  //   layoutNonce    — bumped ONLY when the model is (re)built, so a test can
  //                    prove the layout did NOT re-run on an ordinary re-render
  //                    (the flashbang-free property).
  const [layoutHydrated, setLayoutHydrated] = useState(false);
  const [layoutNonce, setLayoutNonce] = useState(0);
  const [buildNonce, setBuildNonce] = useState(0);
  const [buildTrigger, setBuildTrigger] = useState(0);
  const [nodeColors, setNodeColors] =
    useState<ReadonlyMap<string, string>>(NO_NODE_COLORS);

  // Tag list for the filter (fetched on mount).
  useEffect(() => {
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
  }, []);

  // Build the model for the current filter. DELIBERATELY does NOT depend on
  // indexNonce (SYNC-14: the frozen graph does NOT auto-rejumble on a vault
  // change — the user refreshes explicitly). `buildTrigger` forces a rebuild.
  useEffect(() => {
    let cancelled = false;
    setModel(null);
    // Snapshot the note-set at build time (see `notesRef` note above).
    const notes = notesRef.current;
    const liveIds = liveIdSet(notes);
    const build = async (): Promise<GraphModel> => {
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
      return loadWholeVaultGraph(notes); // "all" — whole vault, no cap
    };
    const run = async () => {
      // Hydrate persisted positions ONCE per mount so the layout warm-starts
      // from the last session's arrangement (Tier 3) instead of a fresh random
      // scatter; clears the store first (cross-vault safety). The disk read and
      // the model build are INDEPENDENT IPCs (the build never reads the store),
      // so overlap them — both still resolve before `setModel`, so GraphCanvas
      // sees the restored positions on mount. Filter changes reuse the store.
      const hydrate = hydratedRef.current
        ? Promise.resolve()
        : loadGraphLayoutFromDisk().then(() => {
            hydratedRef.current = true;
            if (!cancelled) setLayoutHydrated(true);
          });
      const [, m] = await Promise.all([hydrate, build()]);
      if (cancelled) return;
      setBuildNonce(getIndexNonce());
      setModel(m);
      setLayoutNonce((n) => n + 1); // one bump per (re)build — the flashbang probe
    };
    void run().catch(() => {
      if (!cancelled) setBuildNonce(getIndexNonce());
    });
    return () => {
      cancelled = true;
    };
    // Deliberately NOT depending on `notes`: a vault-cache update must not
    // rebuild the frozen graph (SYNC-14). Rebuild only on filter change or an
    // explicit Refresh (`buildTrigger`).
  }, [filter, buildTrigger]);

  // --- Color groups (task 8) -------------------------------------------
  // The note-id → color-key map the renderer paints with. Deliberately its own
  // state + effect: `model` is NOT in what this writes, so a rule edit updates
  // only this map, `GraphCanvas`'s `[model]` effect never re-runs, and
  // `layoutNonce` never bumps. Color is a render-time layer, never part of the
  // layout model (`GraphNode` stays `{id,title}`).
  //
  // `usePrefs` hands back a FRESH `color_groups` array on every prefs reload,
  // and every prefs write in the app bumps the shared nonce — so keying this
  // effect on the array identity would re-query the tag index whenever an
  // unrelated preference changed. Key it on the rules' content instead and read
  // the array itself through a ref (the same discipline `notesRef` above uses
  // for the build effect).
  const colorRulesRef = useRef(prefs.color_groups);
  colorRulesRef.current = prefs.color_groups;
  const colorRulesKey = useMemo(
    () => JSON.stringify(prefs.color_groups),
    [prefs.color_groups],
  );
  useEffect(() => {
    if (model === null) {
      setNodeColors(NO_NODE_COLORS);
      return;
    }
    const colorRules = colorRulesRef.current;
    // The tags the ENABLED rules reference — the exact set of index queries
    // owed, O(rules) rather than O(tags) or O(notes), and the same
    // `hasTag → byTag(tag)` resolution Saved Views uses, so the two surfaces
    // agree on tag membership by construction.
    const tags = collectRuleTags(colorRules);
    const notes = notesRef.current;
    const liveIds = liveIdSet(notes);
    let cancelled = false;
    const run = async () => {
      const members = await Promise.all(
        tags.map((tag) =>
          byTag(tag, liveIds).then(
            (ids) => [tag, new Set(ids)] as const,
            // One unavailable tag must not blank the whole palette — an empty
            // membership set simply leaves that leaf unmatched.
            () => [tag, new Set<string>()] as const,
          ),
        ),
      );
      if (cancelled) return;
      const folderById = new Map(notes.map((n) => [n.noteUuid, n.folder]));
      const meta = buildColorGroupNoteMeta(
        model.nodes.map((n) => n.id),
        folderById,
        new Map(members),
      );
      const resolved = resolveGraphColorGroups(colorRules, meta);
      setNodeColors(resolved.size === 0 ? NO_NODE_COLORS : resolved);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [model, colorRulesKey]);

  // SYNC-14: stale when the index changed since the layout was built. The
  // expensive re-layout is gated to an explicit refresh, never the nonce.
  const stale = indexNonce !== buildNonce;
  // A node opens its note in a NEW tab so the graph tab stays put (the
  // persistent-explorer UX) — the graph remains a peer tab to navigate from.
  const onOpenNode = (id: string) => {
    ws.openNewTabInFocused(id);
  };

  let content: ReactNode;
  if (model === null) {
    content = <div style={MESSAGE_STYLE}>{t("notes.graph.building")}</div>;
  } else if (model.nodes.length === 0) {
    content = (
      <div style={MESSAGE_STYLE}>
        {filter.kind === "orphans"
          ? t("notes.graph.allConnected")
          : t("notes.graph.noNotes")}
      </div>
    );
  } else {
    content = (
      <Suspense fallback={<div style={MESSAGE_STYLE}>{t("notes.graph.loading")}</div>}>
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
          // Same map for the whole-vault, tag, orphan AND local-graph filters —
          // one renderer, so color groups apply identically in every view.
          nodeColors={nodeColors}
          arrowsEnabled={ws.graphSettings.showArrows}
          labelFadeZoom={ws.graphSettings.labelFadeZoom}
          nodeSize={ws.graphSettings.nodeSize}
          nodeSizeStrength={ws.graphSettings.nodeSizeStrength}
          lineThickness={ws.graphSettings.lineThickness}
          forceCenterStrength={ws.graphSettings.forceCenterStrength}
          forceRepelStrength={ws.graphSettings.forceRepelStrength}
          forceLinkStrength={ws.graphSettings.forceLinkStrength}
          forceLinkDistance={ws.graphSettings.forceLinkDistance}
        />
      </Suspense>
    );
  }

  return (
    <div
      data-testid="editor.graph-pane"
      data-node-count={String(model?.nodes.length ?? 0)}
      data-layout-hydrated={String(layoutHydrated)}
      data-layout-nonce={String(layoutNonce)}
      // How many of the rendered nodes a color-group rule matched (task 8).
      // A bounded count, never an id — the E2E probe for "the rule painted",
      // paired with `data-layout-nonce` for "and it did NOT re-run the layout".
      data-colored-node-count={String(nodeColors.size)}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div
        style={{
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          padding: "8px 12px",
          borderBottom: "1px solid var(--line-1)",
          fontSize: 12,
        }}
      >
        <FilterChip
          label={t("notes.graph.filterAll")}
          active={filter.kind === "all"}
          onClick={() => setFilter({ kind: "all" })}
        />
        <FilterChip
          label={t("notes.graph.filterIsolated")}
          active={filter.kind === "orphans"}
          onClick={() => setFilter({ kind: "orphans" })}
        />
        {ctx.selectedId !== null && (
          <FilterChip
            label={t("notes.graph.filterAroundNote")}
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
            title={t("notes.graph.depthToggleTitle")}
            style={{
              fontSize: 12,
              padding: "3px 8px",
              background: "var(--bg-1)",
              color: "var(--fg-2)",
              border: "1px solid var(--line-1)",
              borderRadius: "var(--radius-2)",
              cursor: "pointer",
            }}
          >
            {t("notes.graph.hop", { depth: filter.depth })}
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
            aria-label={t("notes.graph.filterByTag")}
            style={{
              fontSize: 12,
              padding: "3px 6px",
              background: "var(--bg-1)",
              color: "var(--fg-2)",
              border: "1px solid var(--line-1)",
              borderRadius: "var(--radius-2)",
            }}
          >
            <option value="">{t("notes.graph.tagPlaceholder")}</option>
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
            title={t("notes.graph.refreshTitle")}
            style={{
              fontSize: 12,
              padding: "3px 8px",
              background: "var(--bg-1)",
              color: "var(--fg-2)",
              border: "1px solid var(--line-1)",
              borderRadius: "var(--radius-2)",
              cursor: "pointer",
            }}
          >
            {t("notes.graph.refresh")}
          </button>
        )}
      </div>
      <div
        // The gear + floating panel live in THIS wrapper, not the outer pane
        // div — so they overlay the canvas only, positioned relative to it,
        // and (load-bearing) never change the canvas's own width/height: the
        // panel is `position: absolute`, so opening it never re-runs layout.
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        {content}
        <GraphSettingsPanel
          settings={ws.graphSettings}
          onChange={ws.setGraphSettings}
          onReset={() => ws.setGraphSettings(DEFAULT_GRAPH_SETTINGS)}
        />
      </div>
    </div>
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
        borderRadius: "var(--radius-2)",
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}
