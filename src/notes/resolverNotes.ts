// The canonical resident note-set for resolver-driven reader surfaces
// (backlinks, graph, tag-browser). Derived ONCE from the live sidebar cache so
// trash/template exclusion can never drift between surfaces (SYNC-1, knowledge-
// graph-ux epic). The Rust index is trash-blind; exclusion is entirely TS-side
// via `liveCache`.

import { useMemo } from "react";
import type { TitleRecord } from "./loadNoteBatch";
import type { ResolverNote } from "./resolveWikilink";
import { liveCache, useSelectedNote, type NoteId } from "./sidebarState";

/**
 * Map the live (non-trashed, non-template) cache to the resolver's note-set
 * shape ({@link ResolverNote}). `TitleRecord` is a superset of `ResolverNote`
 * (it already carries `noteUuid`/`title`/`folder`), so this is a projection of
 * `liveCache`. Pure — unit-testable without React.
 */
export function resolverNotesFromCache(
  cache: ReadonlyMap<NoteId, TitleRecord>,
): ResolverNote[] {
  const out: ResolverNote[] = [];
  for (const r of liveCache(cache).values()) {
    out.push({ noteUuid: r.noteUuid, title: r.title, folder: r.folder });
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
