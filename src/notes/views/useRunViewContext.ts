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
import { archivedFolderKeys } from "../archivedFolders";
import { deriveFolderTree } from "../folderTree";
import { liveCache, sortBatchIds, useSelectedNote } from "../sidebarState";
import { searchNotes } from "../searchNotes";
import { noteIdsWithTask } from "../taskIndex";
import { byTag, vaultHeadings, vaultIndicesPropertyValues } from "../vaultIndices";
import { noteRead } from "../readNote";
import { folderSubtreeNoteIds, type RunViewContext } from "../queryEngine";

// Bounds for the two content-reading leaves (#208). A phrase check reads only the
// BM25 candidates (already narrow); a regex scans the live set, so it is capped
// harder and recency-ordered — a huge vault scans its most-recent slice, never
// every note on every keystroke.
const PHRASE_SCAN_CAP = 60;
const REGEX_SCAN_CAP = 150;
const READ_CONCURRENCY = 8;

/** Lowercase + collapse runs of whitespace to one space — the normalization for
 *  exact-phrase adjacency: `"release   notes"` matches "Release Notes". */
function normalizePhrase(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Concurrency-limited, order-preserving async map — so a phrase/regex scan
 *  reads at most `limit` notes at once instead of firing hundreds of parallel
 *  `note_read` decrypts. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return out;
}

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
  // `deriveFolderTree` applies the folder-archive filter itself, so an archived
  // folder can't re-surface as an empty `inFolder` target.
  const tree = useMemo(
    () =>
      deriveFolderTree(
        [...live.values()].map((r) => ({
          noteUuid: r.noteUuid,
          folder: r.folder,
        })),
        prefs.deliberate_folders,
        prefs.archived_folders,
      ),
    [live, prefs.deliberate_folders, prefs.archived_folders],
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
        // `section:` — notes with a HEADING matching the query (case-insensitive
        // substring), from the RAM heading index. No note read (#207).
        sectionMatch: async (query) => {
          const needle = query.toLowerCase();
          const rows = await vaultHeadings();
          const ids = new Set<string>();
          for (const row of rows) {
            if (row.text.toLowerCase().includes(needle)) ids.add(row.noteId);
          }
          return [...ids];
        },
        // `"exact phrase"` — BM25 gives candidates with all the words; a bounded
        // content read then keeps only those where they are ADJACENT (#208).
        // Rank order preserved (the palette ranks the survivors).
        phrase: async (phrase) => {
          const needle = normalizePhrase(phrase);
          if (needle === "") return [];
          const hits = await searchNotes(phrase);
          const candidates = hits.map((h) => h.note_id).slice(0, PHRASE_SCAN_CAP);
          const ok = await mapLimit(candidates, READ_CONCURRENCY, async (id) => {
            try {
              return normalizePhrase(await noteRead(id)).includes(needle);
            } catch {
              return false;
            }
          });
          return candidates.filter((_, i) => ok[i]);
        },
        // `/regex/` — a linear scan of title + content against the pattern
        // (case-insensitive), bounded + recency-ordered so a large vault scans its
        // most-recent slice rather than every note (#208). An invalid pattern
        // matches nothing (the search box must not throw on a half-typed regex).
        regex: async (source) => {
          let re: RegExp;
          try {
            re = new RegExp(source, "i");
          } catch {
            return [];
          }
          const ids = sortBatchIds([...live.keys()], live).slice(0, REGEX_SCAN_CAP);
          const ok = await mapLimit(ids, READ_CONCURRENCY, async (id) => {
            const title = live.get(id)?.title;
            if (title != null && re.test(title)) return true;
            try {
              return re.test(await noteRead(id));
            } catch {
              return false;
            }
          });
          return ids.filter((_, i) => ok[i]);
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
