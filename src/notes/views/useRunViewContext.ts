// `useRunViewContext` — assembles the impure `RunViewContext` the query engine
// needs (live working set + leaf resolvers + row/recency accessors) from the
// existing wiring surfaces, with NO new Tauri command. Extracted so both the
// saved-view render (`useViewResult`) and the filter builder's live count
// (`useFilterCount`, MYND-282) run against one identical context.
//
// Wiring surfaces (all pre-existing):
//   - liveIds + rowFor + recencyFallback ← the sidebar cache (`useSelectedNote`)
//   - hasTag        ← `byTag`        (vaultIndices)
//   - search        ← `searchNotes`  (mapped to note ids)
//   - propertyValues← `vaultIndicesPropertyValues`
//   - inFolder      ← `folderSubtreeNoteIds` over the derived folder tree

import { useMemo } from "react";
import { usePrefs } from "../../hooks/usePrefs";
import { deriveFolderTree } from "../folderTree";
import { liveCache, sortBatchIds, useSelectedNote } from "../sidebarState";
import { searchNotes } from "../searchNotes";
import { byTag, vaultIndicesPropertyValues } from "../vaultIndices";
import { folderSubtreeNoteIds, type RunViewContext } from "../queryEngine";

export function useRunViewContext(): RunViewContext {
  const { cache } = useSelectedNote();
  const { prefs } = usePrefs();

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

  return useMemo<RunViewContext>(() => {
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
}
