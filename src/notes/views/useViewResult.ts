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
//
// **It refuses to run an unapproved view, and this hook is where that belongs.**
// Approval is per device and keyed by version (view-manifests): a definition that
// arrived by import or by sync renders only once the person at this device has
// approved it. This hook is the ONLY place a saved view is run for rendering, so
// making the refusal here makes it structural rather than a rule each surface
// remembers: a pending view's tab, a restored tab, and the sidebar flyout all
// reach this one gate, and the query that reads the vault never fires. A gate in
// the manager modal alone would have been bypassed by every other door, which is
// the difference between a product promise and a disabled button.
//
// `approved` is returned rather than folded into `result` so the host can say
// WHY there is nothing to show. `isViewApproved` is the mirror of the Rust rule
// (a version-less view is approved); the host still re-checks approval on every
// field write, so this reading is a render decision and never an authority.

import { useEffect, useMemo, useRef, useState } from "react";
import type { SavedView } from "../../lib/prefs";
import { usePrefs } from "../../hooks/usePrefs";
import { useIndexNonce } from "../indexNonce";
import { useRunViewContext } from "./useRunViewContext";
import { runView, stabilizeViewResult, type ViewResult } from "../queryEngine";
import { isViewApproved } from "./viewApproval";

export type UseViewResult = {
  def: SavedView | null;
  result: ViewResult | null;
  /** Whether this device has approved the definition it holds. `false` also
   *  covers "no definition": a stale tab pointing at a deleted view is not a
   *  pending approval, and the host tells the two apart by `def`. */
  approved: boolean;
  /** Record this device's approval of the version it was shown. Returned from
   *  the same `usePrefs` instance the hook already reads, so the pending surface
   *  does not open a second prefs read just to answer its one question. */
  approve: (viewId: string, version: number | undefined) => Promise<void>;
};

export function useViewResult(viewId: string): UseViewResult {
  const { prefs, approveView } = usePrefs();
  const indexNonce = useIndexNonce();
  const ctx = useRunViewContext();

  // Resolve the def from the persisted saved-views list. `null` when the id is
  // unknown (a stale tab pointing at a deleted view) → the host renders empty.
  const def = useMemo<SavedView | null>(
    () => prefs.saved_views.find((v) => v.id === viewId) ?? null,
    [prefs.saved_views, viewId],
  );

  const approved = useMemo(
    () => def !== null && isViewApproved(def, prefs.view_approvals),
    [def, prefs.view_approvals],
  );

  const [result, setResult] = useState<ViewResult | null>(null);
  // Hold the previous result so a value-equal re-run bails the render.
  const prevRef = useRef<ViewResult | null>(null);

  useEffect(() => {
    // Unapproved (or unknown) means the query does not run at all: not a query
    // whose output is hidden, which would still read the vault the reader has
    // not agreed to hand to this definition.
    if (def === null || !approved) {
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
  }, [def, approved, ctx, indexNonce]);

  return { def, result, approved, approve: approveView };
}
