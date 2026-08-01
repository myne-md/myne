// The canonical resident note-set for resolver-driven reader surfaces
// (backlinks, graph, tag-browser). Derived ONCE from the resolver cache so
// trash/template exclusion can never drift between surfaces (SYNC-1, knowledge-
// graph-ux epic). The Rust index is trash-blind; exclusion is entirely TS-side
// via `resolverCache`. NOTE (note-archive / MYND-331 Q3/B): this uses
// `resolverCache`, NOT `liveCache` — an archived note is excluded from the
// working-set tree/favorites but must STILL resolve as a backlink target and show
// in the graph/tag-browser. The two-axis split lives here: tree → `liveCache`
// (archived out), resolver → `resolverCache` (archived in).

import { useMemo, useRef } from "react";
import { useIndexNonce } from "./indexNonce";
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

/**
 * Do two note-sets say the same thing? Field-wise over `ResolverNote`'s five
 * scalars, in order — cheap enough to run on every index-change nonce (a few
 * hundred notes is microseconds) and the entire basis of the reference
 * stability below. Pure; exported for direct testing.
 *
 * Adding a field to `ResolverNote` means adding it here, or a change in it
 * stops re-resolving the chips that depend on it.
 */
export function sameResolverNotes(
  a: readonly ResolverNote[],
  b: readonly ResolverNote[],
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.noteUuid !== y.noteUuid ||
      x.title !== y.title ||
      x.folder !== y.folder ||
      x.folderIndex !== y.folderIndex ||
      x.isDrawing !== y.isDrawing
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The resident note-set for a surface that must re-resolve on a SYNC-5
 * index change — today the editor panes, whose wikilink chips restyle from
 * broken to resolved as notes appear (WL-5/WL-6).
 *
 * **A fresh reference means "re-resolve"**, because that is how it reaches the
 * editor: `CMEditor` dispatches `reconfigureNoteSet` when the `noteSet` prop's
 * identity changes. So this hook re-evaluates on every index nonce, and hands
 * back a NEW array only when the set actually says something different.
 *
 * `PaneView` used to do this with `liveNotes.slice()` (myne#217). That produced
 * a fresh array on every bump, which re-resolved the chips — and also defeated
 * the reference-equality bail-out `indexNonce.ts` documents, invalidating every
 * downstream memo and dispatching a facet reconfigure into a CodeMirror view the
 * user was typing into. Comparing content keeps the live re-resolution and drops
 * the churn.
 */
export function useLiveResolverNotes(): ResolverNote[] {
  const notes = useResolverNotes();
  const indexNonce = useIndexNonce();
  const stable = useRef(notes);
  return useMemo(() => {
    if (!sameResolverNotes(stable.current, notes)) stable.current = notes;
    return stable.current;
    // `indexNonce` is a dependency on purpose: the cache reference alone can
    // miss the async post-unlock populate, which is the "linked but looks
    // broken on reload" case this re-feed exists for. It only costs a compare.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, indexNonce]);
}
