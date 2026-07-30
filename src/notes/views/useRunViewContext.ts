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
import { archivedFolderKeys, filterVisibleDeliberate } from "../archivedFolders";
import { deriveFolderTree } from "../folderTree";
import { liveCache, sortBatchIds, useSelectedNote } from "../sidebarState";
import { searchNotes } from "../searchNotes";
import { noteIdsWithTask } from "../taskIndex";
import { byTag, vaultIndicesPropertyValues } from "../vaultIndices";
import { folderSubtreeNoteIds, type RunViewContext } from "../queryEngine";

export function useRunViewContext(): RunViewContext {
  const { cache } = useSelectedNote();
  const { prefs } = usePrefs();

  // Folder-archived subtrees (archived_folders) leave the working set too — the
  // saved-view results + `inFolder` resolver must not surface them, same as the
  // sidebar tree (folder-archive).
  const archivedKeys = useMemo(
    () => archivedFolderKeys(prefs.archived_folders),
    [prefs.archived_folders],
  );

  // The live (non-trashed, non-template, non-folder-archived) working set — the
  // single trash/template/archive gate the engine intersects every leaf with.
  const live = useMemo(() => liveCache(cache, archivedKeys), [cache, archivedKeys]);

  // The folder tree (each live note's `folder:` ∪ deliberate_folders) backs the
  // subtree-inclusive `inFolder` resolver — same derivation the sidebar uses.
  // Archived deliberate folders are filtered so they don't re-surface as empty
  // `inFolder` targets after `liveCache` strips their notes.
  const tree = useMemo(
    () =>
      deriveFolderTree(
        [...live.values()].map((r) => ({
          noteUuid: r.noteUuid,
          folder: r.folder,
        })),
        filterVisibleDeliberate(prefs.deliberate_folders, archivedKeys),
      ),
    [live, prefs.deliberate_folders, archivedKeys],
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
        // `file:` — full-text hits whose TITLE matched (`matched_in.title`),
        // computed by the engine's own stemmer (MYND-303).
        titleMatch: async (query) => {
          const hits = await searchNotes(query);
          return hits.filter((h) => h.matched_in.title).map((h) => h.note_id);
        },
        // `task:` — notes with a task item (optionally matching the query text).
        hasTask: (query) => noteIdsWithTask(query),
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
