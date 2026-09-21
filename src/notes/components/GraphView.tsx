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
  tagKeyFromNodeId,
  type GraphModel,
} from "../graphAdapter";
import { usePrefs } from "../../hooks/usePrefs";
import { prefsRead, setColorGroups } from "../../lib/prefs";
import {
  collectRuleTags,
  defaultTagGroupsAsRules,
} from "../graphColorGroups";
import { buildGraphOverlay, type GraphOverlay } from "../graphOverlay";
import {
  consumeGraphViewFilter,
  subscribeGraphViewFilter,
  type GraphViewFilter,
} from "../graphViewFilter";
import { DEFAULT_GRAPH_SETTINGS } from "../graphSettings";
import { getIndexNonce, useIndexNonce } from "../indexNonce";
import { loadGraphLayoutFromDisk } from "../graphLayoutPersist";
import { clearGraphLayout } from "../graphLayoutStore";
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
import { GraphList } from "./GraphList";
import { VISUALLY_HIDDEN } from "../../components/primitives/visuallyHidden";
import { Icon } from "../../components/primitives/Icon";
import type { IconName } from "../../lib/icons";

// Lazy-loaded so the d3-force + canvas-renderer chunk stays OUT of the initial
// bundle (vision.md "separate, lazy-loaded"; SYNC-8 TB9 posture). The app's
// first React.lazy boundary.
const GraphCanvas = lazy(() => import("./GraphCanvas"));

type Filter = GraphViewFilter;

// One stable identity for "no node is colored", so the no-rules case hands
// `GraphCanvas` the same map on every render and never schedules a repaint.
const NO_NODE_COLORS: ReadonlyMap<string, string> = new Map();
// The same for "no tag nodes", so the notes-only case hands the model builder
// the same array on every render and the built model keeps its identity.
/** A model's content as one string, for the identity check in the overlay
 *  effect. Ids and kinds in order, plus the edges: everything the canvas reads.
 *  The canvas tears itself down and re-runs the layout when the model it is
 *  handed is a new OBJECT, so a colour edit must leave this identical. */
function modelIdentity(model: GraphModel | null): string {
  if (model === null) return "";
  return (
    model.nodes.map((n) => `${n.id}:${n.kind ?? "note"}`).join(",") +
    "|" +
    model.edges.map((e) => `${e.source}>${e.target}`).join(",")
  );
}

/** A colour map's content as one string. */
function colorIdentity(colors: ReadonlyMap<string, string>): string {
  return [...colors.entries()].map(([id, key]) => `${id}=${key}`).join(",");
}

/** The filter dropdown's value for "the open note's neighbourhood". A sentinel
 *  rather than a real tag key, so it cannot collide with one; the tag options
 *  carry a `tag:` prefix for the same reason (myne-md/myne#727). */
const LOCAL_FILTER_VALUE = "@local";
/** …and for the isolated view, for the same reason. Never a selectable option:
 *  it is rendered only while it is already the value. */
const ORPHANS_FILTER_VALUE = "@isolated";

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
  // Whether the pane body renders the canvas or the accessible list of the same
  // model (myne-md/myne#727). Local state on purpose: it is a reading mode for
  // this sitting, not vault state, and nothing about it should sync.
  const [asList, setAsList] = useState(false);
  const [model, setModel] = useState<GraphModel | null>(null);
  const [tags, setTags] = useState<TagTreeNode[]>([]);
  // The tag nodes for the whole-vault view (myne-md/myne#727). Written by the
  // SAME effect that resolves the color groups, because they are the same
  // answer read twice: a tag node exists exactly when an enabled bare-`hasTag`
  // rule claims it, and its colour is that rule's colour. Kept as state rather
  // than derived at render time so its identity only moves when its CONTENT
  // does, see the effect for why that is load-bearing.
  // The gear's open/closed state, lifted here by task 13: the button now lives
  // in the pane's header row and the panel stays a floating overlay.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Whether the "make these editable" write failed. Local and transient: it is
  // an outcome to report, not state worth keeping (myne-md/myne#727).
  const [materializeFailed, setMaterializeFailed] = useState(false);
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
  const [overlay, setOverlay] = useState<GraphOverlay>({
    model: null,
    colors: NO_NODE_COLORS,
    derivedGroupCount: 0,
  });
  const nodeColors = overlay.colors;

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

  // A filter request from outside the pane, the **Open isolated graph** palette
  // command (task 14). Consumed once, and it covers both orderings: the mount
  // call picks up a request made before this pane existed, and the subscription
  // picks up one made while it is already on screen.
  useEffect(() => {
    const apply = () => {
      const request = consumeGraphViewFilter();
      if (request !== null) setFilter(request);
    };
    apply();
    return subscribeGraphViewFilter(apply);
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
  // The tag tree, for the DISPLAY half of a tag node's label. Read through a ref
  // for the same reason as the rules above: this effect keys on content, not on
  // the identity of an array that a prefs reload replaces wholesale.
  const tagsRef = useRef(tags);
  tagsRef.current = tags;
  // The display half of a tag node's label, as a content key. The tag tree and
  // the graph model are two independent IPC calls issued at mount, so the tree
  // can land AFTER the first hub set is computed, and without this the hubs
  // would keep the folded key as their label (`#work`) for the session, because
  // a ref read is not a dependency. Content rather than identity, for the same
  // reason as `colorRulesKey`: a prefs reload replaces the array wholesale.
  const tagDisplayKey = useMemo(
    () => tags.map((tag) => `${tag.key}=${tag.display}`).join("|"),
    [tags],
  );
  // Every tag the client knows, in the shape the overlay builder wants. It is
  // the derived default grouping's input AND the panel's count, computed once.
  const derivedGroups = useMemo(
    () =>
      tags.map((tag) => ({
        key: tag.key,
        display: tag.display,
        subtreeCount: tag.subtreeCount,
      })),
    [tags],
  );
  const colorRulesKey = useMemo(
    () => JSON.stringify(prefs.color_groups),
    [prefs.color_groups],
  );
  useEffect(() => {
    if (model === null) {
      setOverlay({ model: null, colors: NO_NODE_COLORS, derivedGroupCount: 0 });
      return;
    }
    const colorRules = colorRulesRef.current;
    // The tags the ENABLED rules reference, plus every tag for the derived
    // default. One `byTag` query each, O(rules + tags) rather than O(notes).
    const wanted = new Set([
      ...collectRuleTags(colorRules),
      ...(colorRules.length === 0 ? derivedGroups.map((g) => g.key) : []),
    ]);
    const notes = notesRef.current;
    const liveIds = liveIdSet(notes);
    let cancelled = false;
    const run = async () => {
      const answered = await Promise.all(
        [...wanted].map((tag) =>
          byTag(tag, liveIds).then(
            (ids) => [tag, new Set(ids)] as const,
            // One unavailable tag must not blank the whole palette; an empty
            // membership set simply leaves that leaf unmatched.
            () => [tag, new Set<string>()] as const,
          ),
        ),
      );
      if (cancelled) return;
      const next = buildGraphOverlay({
        model,
        colorGroups: colorRules,
        tags: derivedGroups,
        members: new Map(answered),
        folderById: new Map(notes.map((n) => [n.noteUuid, n.folder])),
        // The local-graph, tag-filter and orphan views stay notes-only: a hub
        // has no place in a neighbourhood BFS or in a list of notes with no
        // links.
        wholeVault: filter.kind === "all",
      });
      // Keep BOTH identities stable when only one of them moved. The canvas
      // tears itself down and re-runs the layout when the model it is handed is
      // a new OBJECT, so handing it a freshly-built one on every colour change
      // would re-lay-out the graph, which is the contract `gc1` pins as never
      // happening. A colour edit must therefore leave the model identical, and a
      // hub arriving must leave the colours identical.
      setOverlay((prev) => {
        const modelMoved = modelIdentity(prev.model) !== modelIdentity(next.model);
        const colorsMoved = colorIdentity(prev.colors) !== colorIdentity(next.colors);
        if (
          !modelMoved &&
          !colorsMoved &&
          prev.derivedGroupCount === next.derivedGroupCount
        ) {
          return prev;
        }
        return {
          model: modelMoved ? next.model : prev.model,
          colors: colorsMoved ? next.colors : prev.colors,
          derivedGroupCount: next.derivedGroupCount,
        };
      });
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [model, colorRulesKey, tagDisplayKey, derivedGroups, filter.kind]);

  // The model the pane actually renders: the built notes-only model, plus a node
  // per tag when the WHOLE-VAULT view is showing. Deliberately here rather than
  // inside the adapter's builders: the local-graph and orphan paths must stay
  // notes-only (a tag node has no place in a neighbourhood BFS or in a list of
  // notes with no links), and this is the one place that knows which filter is
  // on screen.
  // SYNC-14: stale when the index changed since the layout was built. The
  // expensive re-layout is gated to an explicit refresh, never the nonce.
  const stale = indexNonce !== buildNonce;

  // --- Bootstrapping the first model (myne-md/myne#727) ------------------
  // Reported twice as "the graph pane opens and never loads": the first time as
  // "empty until you touch a filter", and again as "it only hangs when the app
  // was frozen and came back".
  //
  // The build effect deliberately does NOT depend on the note cache (SYNC-14: a
  // frozen graph must not re-jumble when the vault changes), so a mount that
  // happens BEFORE the note cache has populated builds an EMPTY model and
  // nothing ever rebuilds it. The previous attempt keyed the recovery on
  // `indexNonce`, which is the signal for the async populate, but it is only a
  // signal if it CHANGES after the pane mounted, and a pane opened after the
  // index was already built never sees a bump. That is exactly the frozen-app
  // case: the WebView throttles in the background, the populate lands late, and
  // the pane that mounted in the meantime is stuck.
  //
  // So the trigger is the NOTE SET itself, and the state machine has three
  // cases rather than two:
  //   - a non-empty model exists -> bootstrapping is over, and this never runs
  //     again for the rest of the mount. That is what keeps SYNC-14: an
  //     established graph is frozen and a later vault change does NOT re-jumble
  //     it (Refresh is still the way to adopt one).
  //   - the model is empty and notes exist -> rebuild. It fires again if the
  //     cache grows, which is what stops a partially-populated cache from
  //     freezing a partial graph.
  //   - the model is empty and there are NO notes -> do nothing. A vault that
  //     genuinely has no notes, or a filter that legitimately matches nothing,
  //     stays empty instead of spinning.
  const noteCount = notes.length;
  const bootstrappedRef = useRef(false);
  // The note count an empty model was last built from. It is what makes this
  // terminate: a filter that LEGITIMATELY matches nothing (the isolated view on
  // a fully-connected vault, whose empty state exists) produces an empty model
  // forever, and re-arming on emptiness alone spun: empty, bump, rebuild, empty.
  // Re-arming only when the note set has GROWN since the last empty build gives
  // the cold-open fix its purpose (a cache that fills in late) without giving a
  // genuinely empty view a loop.
  const emptyBuiltAtRef = useRef(-1);
  useEffect(() => {
    if (bootstrappedRef.current) return;
    if (model === null) return;
    if (model.nodes.length > 0) {
      bootstrappedRef.current = true;
      return;
    }
    if (noteCount > emptyBuiltAtRef.current) {
      emptyBuiltAtRef.current = noteCount;
      setBuildTrigger((n) => n + 1);
    }
  }, [noteCount, model]);
  // A node opens its note in a NEW tab so the graph tab stays put (the
  // persistent-explorer UX) — the graph remains a peer tab to navigate from.
  const onOpenNode = (id: string) => {
    ws.openNewTabInFocused(id);
  };

  // What a node click MEANS depends on what the node IS (task 18). A tag node
  // has no note to open, and `openNewTabInFocused` on a `tag:…` id would ask
  // the workspace for a note that cannot exist. The useful answer, and the one
  // the reference implementation gives, is to filter to that tag, which lands
  // on the tag view, where the hub's own notes are shown as the induced
  // subgraph among them.
  const onNodeClick = (id: string) => {
    const tagKey = tagKeyFromNodeId(id);
    if (tagKey !== null) {
      setFilter({ kind: "tag", key: tagKey });
      return;
    }
    if (filter.kind === "local") {
      setFilter({ kind: "local", seed: id, depth: filter.depth });
      return;
    }
    onOpenNode(id);
  };

  let content: ReactNode;
  if (overlay.model === null) {
    content = <div style={MESSAGE_STYLE}>{t("notes.graph.building")}</div>;
  } else if (overlay.model.nodes.length === 0) {
    content = (
      <div style={MESSAGE_STYLE}>
        {filter.kind === "orphans"
          ? t("notes.graph.allConnected")
          : t("notes.graph.noNotes")}
      </div>
    );
  } else if (asList) {
    content = (
      <GraphList
        model={overlay.model}
        onOpen={onOpenNode}
        onOpenTag={(key) => setFilter({ kind: "tag", key })}
      />
    );
  } else {
    content = (
      <Suspense fallback={<div style={MESSAGE_STYLE}>{t("notes.graph.loading")}</div>}>
        <GraphCanvas
          model={overlay.model}
          // The canvas is a picture, so it gets a name and nothing else: the
          // text alternative is the list above, which is generated from the same
          // model. Note the ordering benefit: list mode never mounts the lazy
          // canvas chunk, so a reader who wants text never downloads d3.
          ariaLabel={t("notes.graph.canvasLabel", { count: overlay.model.nodes.length })}
          // Whole/orphans/tag: a click navigates (or filters, for a tag node).
          // Local: a click PIVOTS (re-center, no ctx.open side-effect, SYNC-6);
          // double-click navigates.
          onNodeClick={onNodeClick}
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
      data-node-count={String(overlay.model?.nodes.length ?? 0)}
      // How many of the rendered nodes are TAG nodes (task 18), a bounded
      // count, so a scenario can assert "the hubs are here" without depending
      // on any note id.
      data-tag-node-count={String(
        overlay.model?.nodes.filter((n) => n.kind === "tag").length ?? 0,
      )}
      data-layout-hydrated={String(layoutHydrated)}
      data-layout-nonce={String(layoutNonce)}
      // How many of the rendered NOTE nodes a color-group rule matched (task 8).
      // A bounded count, never an id — the E2E probe for "the rule painted",
      // paired with `data-layout-nonce` for "and it did NOT re-run the layout".
      // TAG nodes are painted from this same map and are deliberately NOT
      // counted here (task 18): the count's whole job is "did the rule reach the
      // notes", and a hub appearing alongside the note it groups would move a
      // number a scenario reads for the note half.
      data-colored-node-count={String(
        [...nodeColors.keys()].filter((id) => tagKeyFromNodeId(id) === null).length,
      )}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 0,
      }}
    >
      {/* Announced, not shown: the visible count is already in the header's
          chips (`data-node-count` is the E2E half), and what a screen reader
          needs is the CHANGE. A filter that silently swaps 400 nodes for 6
          leaves the user with no idea anything happened. */}
      <div
        data-testid="editor.graph-announce"
        role="status"
        aria-live="polite"
        style={VISUALLY_HIDDEN}
      >
        {t("notes.graph.showingCount", { count: overlay.model?.nodes.length ?? 0 })}
      </div>
      <div
        // The floating panel lives in THIS wrapper, not the outer pane div, so
        // it overlays the canvas only, positioned relative to it, and
        // (load-bearing) never changes the canvas's own width/height: the panel
        // is `position: absolute`, so opening it never re-runs layout.
        style={{
          position: "relative",
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
        }}
      >
        <div
          data-testid="editor.graph-controls"
          style={
            asList
              ? {
                  // IN LIST MODE THE CONTROLS ARE A ROW, not an overlay. A
                  // floating cluster over a picture is a control surface on the
                  // thing being looked at; over a scrolling LIST it is a set of
                  // buttons sitting on top of the first rows, and the rows slide
                  // under them as you scroll (myne-md/myne#727). The list is a
                  // document, so its controls get their own line above it.
                  flex: "0 0 auto",
                  position: "relative",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "var(--space-2)",
                  padding: "var(--space-2) var(--space-3)",
                  borderBottom: "1px solid var(--line-1)",
                }
              : {
                  position: "absolute",
                  inset: 0,
                  zIndex: 4,
                  pointerEvents: "none",
                }
          }
        >
          <div
            style={{
              ...(asList ? {} : { position: "absolute" as const, top: 8, insetInlineStart: 8 }),
              display: "flex",
              alignItems: "center",
              gap: "var(--space-1)",
              pointerEvents: "auto",
            }}
          >
        {/* ONE filter control, not a chip plus a dropdown. "All" and the
            dropdown's empty option were two controls doing the same thing, and
            the chip won by being closer to hand, so the dropdown now OPENS on
            All and the chip is gone (myne-md/myne#727). It sits leftmost
            because it is the outermost decision: what the picture is OF, before
            how it is drawn. */}
        <select
          value={
            filter.kind === "tag"
              ? `tag:${filter.key}`
              : filter.kind === "local"
                ? LOCAL_FILTER_VALUE
                : filter.kind === "orphans"
                  ? ORPHANS_FILTER_VALUE
                  : ""
          }
          onChange={(e) => {
            const value = e.target.value;
            if (value === "") setFilter({ kind: "all" });
            else if (value === LOCAL_FILTER_VALUE) {
              if (ctx.selectedId !== null) {
                setFilter({ kind: "local", seed: ctx.selectedId, depth: 1 });
              }
            } else setFilter({ kind: "tag", key: value.slice("tag:".length) });
          }}
          aria-label={t("notes.graph.filterSelectAriaLabel")}
          data-testid="editor.graph-filter"
          style={{
            fontSize: 12,
            maxWidth: 190,
            padding: "3px 6px",
            background: "var(--bg-1)",
            color: "var(--fg-2)",
            border: "1px solid var(--line-1)",
            borderRadius: "var(--radius-2)",
          }}
        >
          <option value="">{t("notes.graph.filterAll")}</option>
          {/* The isolated view has no entry here, because task 14 moved it to
              the palette and the header is not where a once-in-a-while view
              lives. But a `<select>` cannot display a value with no matching
              option, it silently falls back to the first one, so opening that
              view from the palette would leave this control reading "All" while
              the picture showed something else. The option is rendered ONLY
              while it is the current value: the control tells the truth, and it
              still cannot be used to ENTER the view. */}
          {filter.kind === "orphans" && (
            <option value={ORPHANS_FILTER_VALUE}>
              {t("notes.graph.filterIsolated")}
            </option>
          )}
          {ctx.selectedId !== null && (
            <option value={LOCAL_FILTER_VALUE}>
              {t("notes.graph.filterAroundNote")}
            </option>
          )}
          {tags.map((tag) => (
            <option key={tag.key} value={`tag:${tag.key}`}>
              {`#${tag.display} (${tag.subtreeCount})`}
            </option>
          ))}
        </select>
        {filter.kind === "local" && (
          <button
            type="button"
            onClick={() => setFilter({ ...filter, depth: filter.depth === 1 ? 2 : 1 })}
            title={t("notes.graph.depthToggleTitle")}
            data-testid="editor.graph-hop"
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
          </div>
          <div
            style={{
              ...(asList ? {} : { position: "absolute" as const, top: 8, insetInlineEnd: 8 }),
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: "var(--space-2)",
              pointerEvents: "auto",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-1)",
              }}
            >
            {/* The picture and the list are two renderings of ONE model, so this
                is a reading mode rather than a filter: it narrows nothing.
                NOT the repo's `<Segmented>`, and the reason is a measured
                defect rather than a preference: `Segmented` paints its
                selection as an absolutely-positioned thumb sized from
                `offsetWidth`, and inside a graph pane that mounts BEFORE its
                tab is visible that measurement is 0. The selected label then
                takes `--accent-on` (`#0b0b09` in the dark themes) with no thumb
                behind it, so the ACTIVE half renders invisible, which is exactly
                what it did. Painting the accent directly has no measurement in
                it and cannot fail that way. */}
            <div
              role="group"
              aria-label={t("notes.graph.viewToggleAriaLabel")}
              style={{
                display: "flex",
                alignItems: "center",
                border: "1px solid var(--line-1)",
                borderRadius: "var(--radius-2)",
                overflow: "hidden",
              }}
            >
              <ViewHalf
                testId="editor.graph-view-graph"
                icon="share-2"
                label={t("notes.graph.viewGraph")}
                active={!asList}
                onClick={() => setAsList(false)}
              />
              <ViewHalf
                testId="editor.graph-view-list"
                icon="list"
                label={t("notes.graph.viewList")}
                active={asList}
                onClick={() => setAsList(true)}
              />
            </div>
            {/* ALWAYS rendered, and that is the fix for a dead end rather than a
            cosmetic choice. It used to appear only while the index was stale,
            so on a vault whose index had not changed there was NO way to re-run
            the layout at all: the saved arrangement warm-starts forever, which
            meant a change to the layout's own defaults (the force values, the
            seed ring) could never reach a graph that had already been laid out
            once. A user looking at a graph they did not like had nothing to
            press. Clearing the warm-start store first is what makes this a
            re-layout rather than a nudge of what is already there.
            Icon-only since the cluster has to stay narrow enough to sit on the
            picture: the tooltip carries the word, and the glyph is the circular
            arrow that means "again". */}
        <IconButton
          testId="editor.graph-relayout"
          icon="refresh-cw"
          label={stale ? t("notes.graph.refreshTitle") : t("notes.graph.relayoutTitle")}
          onClick={() => {
            clearGraphLayout();
            setBuildTrigger((n) => n + 1);
          }}
        />
        {/* The settings gear, moved out of the canvas (task 13) and into the
            cluster beside the other controls for the pane. The PANEL still
            floats over the canvas, that half is load-bearing, because a panel
            that took width from the canvas would resize it and re-run the
            layout. */}
        <IconButton
          testId="editor.graph-settings-gear"
          icon="settings"
          label={t("notes.graph.settings.openTitle")}
          active={settingsOpen}
          expanded={settingsOpen}
          onClick={() => setSettingsOpen((open) => !open)}
        />
            </div>
            {asList && (
              <div
                style={{
                  position: "absolute",
                  top: "100%",
                  insetInlineEnd: 0,
                  zIndex: 5,
                  marginTop: "var(--space-2)",
                }}
              >
                <GraphSettingsPanel
                  open={settingsOpen}
                  onClose={() => setSettingsOpen(false)}
                  settings={ws.graphSettings}
                  onChange={ws.setGraphSettings}
                  onReset={() => ws.setGraphSettings(DEFAULT_GRAPH_SETTINGS)}
                  derivedGroupCount={
                    prefs.color_groups.length > 0 ? 0 : derivedGroups.length
                  }
                  derivedMaterializeFailed={materializeFailed}
                  onMaterializeDerived={() => {
                    setMaterializeFailed(false);
                    void prefsRead()
                      .then((current) => {
                        if (current.color_groups.length > 0) return undefined;
                        return setColorGroups(defaultTagGroupsAsRules(tags));
                      })
                      .catch(() => {
                        setMaterializeFailed(true);
                      });
                  }}
                />
              </div>
            )}
            {!asList && (
            <GraphSettingsPanel
              open={settingsOpen}
              onClose={() => setSettingsOpen(false)}
              settings={ws.graphSettings}
              onChange={ws.setGraphSettings}
              onReset={() => ws.setGraphSettings(DEFAULT_GRAPH_SETTINGS)}
              // The derived default is shown to the user as a COUNT and a
              // one-click materialise, so the panel never says "no rules"
              // while the picture is coloured.
              derivedGroupCount={
                prefs.color_groups.length > 0 ? 0 : derivedGroups.length
              }
              derivedMaterializeFailed={materializeFailed}
              onMaterializeDerived={() => {
                setMaterializeFailed(false);
                // Re-read DISK TRUTH and write only if it is STILL empty. The
                // button's precondition is an emptiness sentinel, and `usePrefs`
                // reports `DEFAULT_PREFS` (also empty) before its read resolves,
                // so a click inside that window would otherwise replace rules
                // that are about to arrive from disk. The backend already refuses
                // a write over a DEGRADED prefs read; this closes the in-flight
                // window, which is the one it cannot see.
                void prefsRead()
                  .then((current) => {
                    if (current.color_groups.length > 0) return undefined;
                    return setColorGroups(defaultTagGroupsAsRules(tags));
                  })
                  .catch(() => {
                    // Reported, not swallowed: the button promises the defaults
                    // became editable, and a silent failure leaves the panel
                    // showing "N derived groups" as if nothing was pressed.
                    setMaterializeFailed(true);
                  });
              }}
            />
            )}
          </div>
        </div>
        {content}
        {/* Two overlay groups at the canvas's opposite top corners, with the
            settings panel in the right one so it opens directly under the gear
            (myne-md/myne#727). They are separate groups rather than one box
            because they answer different questions, the filter says what the
            picture is OF, the rest say how it is drawn, and a box around both
            made them read as one control surface that happened to have five
            buttons in it.
            The overlay itself is `pointer-events: none` so the canvas stays
            interactive everywhere its children are not; each group re-enables
            them. */}
      </div>
    </div>
  );
}

/** The floating cluster's controls are ONE control vocabulary, so they are one
 *  style object: a chip, a switch half and an icon button differ only in what
 *  they act on, and a second copy of these properties is how they drift apart. */
const CONTROL_BASE_STYLE = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: "var(--space-1)",
  fontSize: 12,
  padding: "3px 8px",
  border: 0,
  background: "transparent",
  cursor: "pointer",
  color: "var(--fg-3)",
} as const;

/**
 * One half of the picture-versus-list switch.
 *
 * The accent is painted DIRECTLY on the active half rather than as a sliding
 * thumb behind it, and that is a bug fix rather than a style choice: the repo's
 * `<Segmented>` sizes its thumb from `offsetWidth`, and a graph pane that mounts
 * before its tab is visible measures 0, so the selected label took
 * `--accent-on` with nothing behind it and the active half rendered invisible
 * (myne-md/myne#727). Nothing here is measured, so nothing here can fail that
 * way.
 */
function ViewHalf({
  testId,
  icon,
  label,
  active,
  onClick,
}: {
  testId: string;
  icon: IconName;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "var(--space-1)",
        fontSize: "var(--text-xs)",
        padding: "5px var(--space-2)",
        border: 0,
        cursor: "pointer",
        background: active ? "var(--accent)" : "transparent",
        color: active ? "var(--accent-on)" : "var(--fg-2)",
      }}
    >
      <Icon name={icon} size={12} />
      {label}
    </button>
  );
}

/** An icon-only control in the cluster. The word lives in the tooltip and the
 *  accessible name, because the cluster has to stay narrow enough to float on
 *  the picture. */
function IconButton({
  testId,
  icon,
  label,
  onClick,
  active,
  expanded,
}: {
  testId: string;
  icon: IconName;
  label: string;
  onClick: () => void;
  active?: boolean;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      onClick={onClick}
      aria-pressed={active}
      style={{
        ...CONTROL_BASE_STYLE,
        width: 28,
        height: 28,
        padding: 0,
        // Its OWN border, now that the group's surrounding box is gone: three
        // separately-bounded controls read as three controls, where one box
        // around them read as a single surface with buttons in it
        // (myne-md/myne#727).
        border: "1px solid var(--line-1)",
        borderRadius: "var(--radius-2)",
        background: active ? "var(--paper-3)" : "var(--bg-1)",
        color: active ? "var(--fg-1)" : "var(--fg-2)",
      }}
    >
      <Icon name={icon} size={14} />
    </button>
  );
}
