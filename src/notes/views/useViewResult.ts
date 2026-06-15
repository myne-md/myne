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
import { deriveFolderTree } from "../folderTree";
import { liveCache, sortBatchIds, useSelectedNote } from "../sidebarState";
import { searchNotes } from "../searchNotes";
import { byTag, vaultIndicesPropertyValues } from "../vaultIndices";
import {
  folderSubtreeNoteIds,
  runView,
  stabilizeViewResult,
  type RunViewContext,
  type ViewResult,
} from "../queryEngine";

export type UseViewResult = {
  def: SavedView | null;
  result: ViewResult | null;
};

export function useViewResult(viewId: string): UseViewResult {
  const { cache } = useSelectedNote();
  const { prefs } = usePrefs();
  const indexNonce = useIndexNonce();

  // Resolve the def from the persisted saved-views list. `null` when the id is
  // unknown (a stale tab pointing at a deleted view) → the host renders empty.
  const def = useMemo<SavedView | null>(
    () => prefs.saved_views.find((v) => v.id === viewId) ?? null,
    [prefs.saved_views, viewId],
  );

  // The live (non-trashed, non-template) working set — the single trash/template
  // gate the engine intersects every leaf with.
  const live = useMemo(() => liveCache(cache), [cache]);

  // The folder tree (each live note's `folder:` ∪ deliberate_folders) backs the
  // subtree-inclusive `inFolder` resolver — same derivation the sidebar uses.
  const tree = useMemo(
    () =>
      deriveFolderTree(
        [...live.values()].map((r) => ({
          noteUuid: r.noteUuid,
          folder: r.folder,
        })),
        prefs.deliberate_folders,
      ),
    [live, prefs.deliberate_folders],
  );

  const ctx = useMemo<RunViewContext>(() => {
    const liveIds = new Set(live.keys());
    return {
      liveIds,
      resolvers: {
        hasTag: (tag) => byTag(tag, liveIds),
        inFolder: async (path) => folderSubtreeNoteIds(tree, path),
        search: async (query) => {
          const hits = await searchNotes(query);
          return hits.map((h) => h.note_id);
        },
        propertyValues: (key) => vaultIndicesPropertyValues(key),
      },
      rowFor: (id) => {
        const record = live.get(id);
        return {
          title: record?.title ?? null,
          folder: record?.folder ?? null,
        };
      },
      recencyFallback: (ids) => sortBatchIds(ids, live),
    };
  }, [live, tree]);

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
