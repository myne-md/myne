// Mobile binding for the SHARED graph renderer (myne-md/myne#200).
//
// What used to be here was a second renderer: ~470 lines of SVG with its own
// node colour, radius formula, label placement, zoom clamp and gesture code —
// which is why the two clients drew visibly different pictures of the same
// vault. It also stopped scaling once #199 made this client render unlinked
// notes too: one `<g>`, `<circle>` and `<text>` per note, and nothing culled at
// fit zoom. The shared canvas batches its draw calls and culls off-screen.
//
// Everything left here is genuinely per-client: the worker constructor (its URL
// has to be statically analysable by THIS bundler) and the `vault.graph` flush,
// which on mobile carries a once-per-unlock hydration latch desktop has no
// equivalent for.
//
// The OVERLAY is NOT per-client any more (myne-md/myne#727): tag nodes and the
// colour rules come from `buildGraphOverlay`, the same function the desktop pane
// calls, so the two clients draw the same picture of the same vault by
// construction rather than by two implementations agreeing. What each client
// supplies is only what only it knows: this one derives tags in the WebView
// (`TagIndex`) where desktop asks the Rust tag tree.
//
// Graph SETTINGS still stay at their defaults here — this client has no settings
// panel, and making the values cross devices is #201. That is why the force,
// size and label numbers on a phone are the shipped ones.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GraphModel } from "@myne/editor/host/notes/graphModel";
import { buildGraphOverlay } from "@myne/graph-overlay";
import GraphCanvas from "@myne/editor/host/notes/GraphCanvas";
import { hasGraphLayout } from "@myne/editor/host/notes/graphLayoutStore";
import { usePrefs } from "../lib/use-prefs";
import type { GraphTag } from "@myne/graph-overlay";
import {
  ensureGraphLayoutHydrated,
  flushGraphLayoutNow,
  scheduleGraphLayoutFlush,
} from "../lib/graph-layout-persist";

/** Stable identities for the two optional inputs, so a caller that has neither
 *  hands the same values on every render and the overlay memo does not re-run. */
const EMPTY_MEMBERS: ReadonlyMap<string, ReadonlySet<string>> = new Map();
const EMPTY_FOLDERS: ReadonlyMap<string, string | null> = new Map();

const makeLayoutWorker = () =>
  new Worker(new URL("../lib/graph-layout.worker.ts", import.meta.url), {
    type: "module",
  });

export function WikiGraph({
  model,
  onOpen,
  tags = [],
  members = EMPTY_MEMBERS,
}: {
  model: GraphModel;
  onOpen: (id: string) => void;
  /** Every tag this vault carries, and which notes carry each — the two things
   *  the derived default grouping and the tag nodes need, and the two things
   *  only this client can supply (it derives tags in the WebView; desktop asks
   *  the Rust tag tree). */
  tags?: ReadonlyArray<GraphTag>;
  members?: ReadonlyMap<string, ReadonlySet<string>>;
}) {
  const { t } = useTranslation();
  const { prefs } = usePrefs();
  // The shared canvas keys its layout effect on the model's IDENTITY, and this
  // client rebuilds the model on every `bodies` change — i.e. every save. Left
  // alone, editing a note with the graph open would tear down and re-seed the
  // canvas on each keystroke's save. Hold the model steady until its CONTENT
  // actually changes (the `idsKey` discipline the retired renderer used, plus
  // titles, which drive the labels).
  const contentKey = useMemo(
    () =>
      model.nodes.map((n) => `${n.id}${n.title ?? ""}`).join("") +
      "" +
      model.edges.map((e) => `${e.source}${e.target}`).join(""),
    [model],
  );
  const stableModel = useRef(model);
  const stableKey = useRef(contentKey);
  if (stableKey.current !== contentKey) {
    stableKey.current = contentKey;
    stableModel.current = model;
  }
  const builtModel = stableModel.current;
  // The overlay: tag nodes and the colour rules, from the SAME builder the
  // desktop pane calls. `wholeVault` is true here because this client's graph
  // tab has no filters, so it always shows the whole vault.
  const overlay = useMemo(
    () =>
      buildGraphOverlay({
        model: builtModel,
        colorGroups: prefs.color_groups,
        tags,
        members,
        // This client has no folder map in hand for the graph, and a folder rule
        // therefore matches nothing rather than matching wrongly. Stated rather
        // than left to be discovered: a `inFolder` colour group is a no-op on a
        // phone until a folder map is threaded here.
        folderById: EMPTY_FOLDERS,
        wholeVault: true,
      }),
    [builtModel, prefs.color_groups, tags, members],
  );
  const canvasModel = overlay.model ?? builtModel;
  // Hydrate `vault.graph` before the canvas mounts, so its first layout
  // warm-starts from the persisted arrangement instead of computing a cold one
  // and overwriting it. The latch inside makes every later mount a no-op.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void ensureGraphLayoutHydrated().then(() => {
      if (!cancelled) setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The tab unmounts on every navigation, so this is the hot persistence seam:
  // flush synchronously rather than leaving a drag inside the debounce window.
  // The `hasGraphLayout()` guard inside makes a post-lock call a no-op, so it
  // can never re-write a locked vault's positions.
  useEffect(() => () => void flushGraphLayoutNow(), []);

  const paneAttrs = {
    "data-testid": "editor.graph-pane",
    "data-node-count": model.nodes.length,
    // Whether the persisted `vault.graph` held anything for this vault. The
    // per-run observability (`data-layout-settled`, the force-relayout
    // counters, the camera) lives on the canvas itself, where the runs happen.
    "data-layout-hydrated": hasGraphLayout() ? "true" : "false",
  } as const;

  if (model.nodes.length === 0) {
    return (
      <div {...paneAttrs} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 44px", textAlign: "center", gap: 10 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: "var(--fg-1)" }}>{t("wikiGraph.emptyTitle")}</div>
        <div style={{ fontSize: 14, lineHeight: 1.55, color: "var(--fg-3)" }}>
          {t("wikiGraph.emptyBodyBefore")}<span style={{ fontFamily: "var(--font-mono)" }}>[[Note title]]</span>{t("wikiGraph.emptyBodyAfter")}
        </div>
      </div>
    );
  }

  return (
    <div {...paneAttrs} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
      {hydrated && (
        <GraphCanvas
          model={canvasModel}
          makeWorker={makeLayoutWorker}
          onPositionsChanged={scheduleGraphLayoutFlush}
          onNodeClick={onOpen}
          // Tag nodes are painted from the same map the notes are, so a hub and
          // its notes cannot disagree about the group they belong to.
          nodeColors={overlay.colors}
          // Arrows are hover-only on a pointer client and ALWAYS ON here: this
          // client has no hover at all, so hover-only would mean never, and the
          // direction of a link is worth as much on a phone as on a desktop
          // (myne-md/myne#727).
          arrowsEnabled
          // The canvas is a picture, so it is named rather than left as a blank
          // region for a screen reader to walk into (myne-md/myne#727). This
          // client has no list view yet; the name at least says what is here.
          ariaLabel={t("wikiGraph.canvasLabel", { count: model.nodes.length })}
        />
      )}
    </div>
  );
}
