// `useViewResult` — the impure seam that runs a saved view to its grouped rows
// for the render host (MYND-275, Saved Views #5, task 2).
//
// It resolves the `SavedView` definition from prefs, assembles a
// `RunViewContext` from the existing wiring surfaces (NO new Tauri command),
// runs the pure query engine (`runView`), and stabilizes the result so a re-run
// that yields a value-equal output keeps the previous reference and bails the
// React render (`stabilizeViewResult`).
//
// Wiring surfaces (all pre-existing):
//   - liveIds + rowFor + recencyFallback ← the sidebar cache (`useSelectedNote`)
//   - hasTag        ← `byTag`        (vaultIndices)
//   - search        ← `searchNotes`  (mapped to note ids)
//   - propertyValues← `vaultIndicesPropertyValues`
//   - inFolder      ← `folderSubtreeNoteIds` over the derived folder tree
//
// Re-runs when the def, the live cache, the folder tree, or the SYNC-5
// index-changed nonce moves. Guards against setState-after-unmount.

import { useEffect, useMemo, useRef, useState } from "react";
import type { SavedView } from "../../lib/prefs";
import { usePrefs } from "../../hooks/usePrefs";
import { useIndexNonce } from "../indexNonce";
import { useRunViewContext } from "./useRunViewContext";
import { runView, stabilizeViewResult, type ViewResult } from "../queryEngine";

export type UseViewResult = {
  def: SavedView | null;
  result: ViewResult | null;
};

export function useViewResult(viewId: string): UseViewResult {
  const { prefs } = usePrefs();
  const indexNonce = useIndexNonce();
  const ctx = useRunViewContext();

  // Resolve the def from the persisted saved-views list. `null` when the id is
  // unknown (a stale tab pointing at a deleted view) → the host renders empty.
  const def = useMemo<SavedView | null>(
    () => prefs.saved_views.find((v) => v.id === viewId) ?? null,
    [prefs.saved_views, viewId],
  );

  const [result, setResult] = useState<ViewResult | null>(null);
  // Hold the previous result so a value-equal re-run bails the render.
  const prevRef = useRef<ViewResult | null>(null);

  useEffect(() => {
    if (def === null) {
      prevRef.current = null;
      setResult(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      // `runView` never throws (a locked vault / index hiccup → empty groups).
      // The cover-image property (`def.image`) is fetched alongside the display
      // columns so each row carries its value for the card cover (task 4); the
      // render resolves it via `attachment://` and EXCLUDES it from the text
      // property list.
      const baseColumns = def.columns ?? [];
      const columns =
        def.image !== undefined && !baseColumns.includes(def.image)
          ? [...baseColumns, def.image]
          : baseColumns;
      const next = await runView(
        {
          filter: def.filters,
          groupBy: def.group_by,
          sort: def.sort,
          columns,
        },
        ctx,
      );
      if (cancelled) return;
      const stable = stabilizeViewResult(prevRef.current, next);
      prevRef.current = stable;
      setResult(stable);
    })();
    return () => {
      cancelled = true;
    };
    // `indexNonce` is a re-run trigger only (read at fire time via `ctx`/`live`).
  }, [def, ctx, indexNonce]);

  return { def, result };
}
