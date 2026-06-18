// Vault-wide heading set for the `[[##` autocomplete (MYND-305).
//
// The `[[##` picker searches headings ACROSS the vault, but the resident
// note-set (titles/folders) doesn't carry headings. This hook derives the set
// LAZILY by reading each live note's body and running the canonical
// `headingSections` surface (SYNC-1 — one heading model, one parser; no block
// index, §9). It is async + best-effort: the picker simply finds nothing until
// the first build settles, and a per-note read failure drops that note's
// headings rather than failing the whole set.
//
// Cost note: this reads every live note body once per (re)build. It is gated to
// build only when the editor actually mounts the picker surface (the hook is
// only used by `PaneView`, which hosts the editor), and rebuilds on the SYNC-5
// index nonce so a renamed/added note's headings refresh. For Phase-1 vault
// sizes this matches the existing convert-command / full-text-search posture of
// reading bodies on demand. A persisted heading index is a future optimization,
// not a Phase-1 requirement.

import { useEffect, useRef, useState } from "react";
import { headingSections } from "../dialect";
import type { VaultHeading } from "../editor/wikilink/vault-headings";
import { noteRead } from "./readNote";
import { useResolverNotes } from "./resolverNotes";
import { useIndexNonce } from "./indexNonce";
import type { ResolverNote } from "./resolveWikilink";

/** Build the vault-wide heading set for `notes` by reading each body. Resolves
 *  to the flattened `VaultHeading[]`; a `cancelled` ref lets the caller drop a
 *  stale build. Pure-ish (only IO is `noteRead`); exported for direct testing. */
export async function buildVaultHeadings(
  notes: readonly ResolverNote[],
): Promise<VaultHeading[]> {
  const out: VaultHeading[] = [];
  for (const n of notes) {
    let body: string;
    try {
      body = await noteRead(n.noteUuid);
    } catch {
      continue; // a single unreadable note never sinks the whole set
    }
    for (const s of headingSections(body)) {
      out.push({
        noteUuid: n.noteUuid,
        title: n.title,
        folder: n.folder,
        heading: s.text,
        level: s.level,
      });
    }
  }
  return out;
}

/**
 * The vault-wide heading set, rebuilt when the live note-set identity or the
 * SYNC-5 index nonce changes. Empty until the first async build settles.
 */
export function useVaultHeadings(): readonly VaultHeading[] {
  const notes = useResolverNotes();
  const indexNonce = useIndexNonce();
  const [headings, setHeadings] = useState<readonly VaultHeading[]>([]);
  // Guard so a build that resolves after a newer one is dropped.
  const buildSeq = useRef(0);

  useEffect(() => {
    const seq = ++buildSeq.current;
    let cancelled = false;
    void (async () => {
      const built = await buildVaultHeadings(notes);
      if (!cancelled && seq === buildSeq.current) setHeadings(built);
    })();
    return () => {
      cancelled = true;
    };
    // `notes` identity changes on a cache update; `indexNonce` covers the async
    // post-unlock populate that doesn't change the cache ref (same rationale as
    // PaneView's `notes` memo).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, indexNonce]);

  return headings;
}
