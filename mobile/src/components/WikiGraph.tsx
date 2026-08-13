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
// equivalent for. Graph SETTINGS stay at their defaults — this client has no
// settings panel yet, and making the values cross devices is #201.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GraphModel } from "@myne/editor/host/notes/graphModel";
import GraphCanvas from "@myne/editor/host/notes/GraphCanvas";
import { hasGraphLayout } from "@myne/editor/host/notes/graphLayoutStore";
import {
  ensureGraphLayoutHydrated,
  flushGraphLayoutNow,
  scheduleGraphLayoutFlush,
} from "../lib/graph-layout-persist";

const makeLayoutWorker = () =>
  new Worker(new URL("../lib/graph-layout.worker.ts", import.meta.url), {
    type: "module",
  });

export function WikiGraph({ model, onOpen }: { model: GraphModel; onOpen: (id: string) => void }) {
  const { t } = useTranslation();
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
  const canvasModel = stableModel.current;
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
        />
      )}
    </div>
  );
}
