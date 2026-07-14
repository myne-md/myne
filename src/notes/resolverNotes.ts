// The canonical resident note-set for resolver-driven reader surfaces
// (backlinks, graph, tag-browser). Derived ONCE from the resolver cache so
// trash/template exclusion can never drift between surfaces (SYNC-1, knowledge-
// graph-ux epic). The Rust index is trash-blind; exclusion is entirely TS-side
// via `resolverCache`. NOTE (note-archive / MYND-331 Q3/B): this uses
// `resolverCache`, NOT `liveCache` — an archived note is excluded from the
// working-set tree/favorites but must STILL resolve as a backlink target and show
// in the graph/tag-browser. The two-axis split lives here: tree → `liveCache`
// (archived out), resolver → `resolverCache` (archived in).

import { useMemo } from "react";
import type { TitleRecord } from "./loadNoteBatch";
import type { ResolverNote } from "./resolveWikilink";
import { resolverCache, useSelectedNote, type NoteId } from "./sidebarState";

/**
 * Map the resolver (non-trashed, non-template; archived-inclusive) cache to the
 * resolver's note-set shape ({@link ResolverNote}). `TitleRecord` is a superset
 * of `ResolverNote` (it already carries `noteUuid`/`title`/`folder`), so this is
 * a projection of `resolverCache`. Pure — unit-testable without React.
 */
export function resolverNotesFromCache(
  cache: ReadonlyMap<NoteId, TitleRecord>,
): ResolverNote[] {
  const out: ResolverNote[] = [];
  for (const r of resolverCache(cache).values()) {
    // `folderIndex` is carried so folder-target wikilinks (`[[Projects/]]`)
    // resolve to the folder's index note (MYND-370). A folder note is neither
    // trashed nor a template, so it survives `liveCache`'s exclusion.
    out.push({
      noteUuid: r.noteUuid,
      title: r.title,
      folder: r.folder,
      folderIndex: r.folderIndex,
      // SF6 inline-embed reads this to pick a drawing-thumbnail widget over a
      // text chip synchronously from the note-set (drawing-notes SF2, MYND-499).
      isDrawing: r.kind === "drawing",
    });
  }
  return out;
}

/**
 * Hook form: the resident `ResolverNote[]` derived from the sidebar cache,
 * memoized on the cache identity. The single selector every reader surface
 * imports instead of re-deriving (SYNC-1).
 */
export function useResolverNotes(): ResolverNote[] {
  const { cache } = useSelectedNote();
  return useMemo(() => resolverNotesFromCache(cache), [cache]);
}
