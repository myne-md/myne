// Vault-wide imported-block-anchor set for the `[[^^` autocomplete (MYND-382).
//
// The `[[^^` picker searches `^block-id` markers ACROSS the vault (enumerate-
// only — it surfaces markers that already exist, e.g. imported from Obsidian;
// Myne mints none). Unlike `useVaultHeadings` (which reads every note body to
// derive headings), this reads the PERSISTED vault-indices `[[^^` index via one
// IPC query (`vaultBlockAnchors`) — the index is fed on the rebuild-on-unlock
// sweep + every live re-index, so no per-note body read is needed here.
//
// Async + best-effort: the picker simply finds nothing until the first query
// settles; a query failure leaves the last set (or empty) rather than throwing.
// Rebuilds on the SYNC-5 index nonce so a note whose anchors changed refreshes.

import { useEffect, useRef, useState } from "react";
import type { VaultBlockAnchor as EditorVaultBlockAnchor } from "../editor/wikilink/vault-block-anchors";
import { useIndexNonce } from "./indexNonce";
import { vaultBlockAnchors } from "./vaultIndices";

/**
 * The vault-wide imported block-anchor set, refetched when the SYNC-5 index
 * nonce changes (a note create/edit/delete bumps it). Empty until the first
 * async query settles. Maps the Rust `VaultBlockAnchor` (noteId/noteTitle/
 * noteFolder) onto the editor facet shape (noteUuid/title/folder).
 */
export function useVaultBlockAnchors(): readonly EditorVaultBlockAnchor[] {
  const indexNonce = useIndexNonce();
  const [anchors, setAnchors] = useState<readonly EditorVaultBlockAnchor[]>([]);
  // Guard so a query that resolves after a newer one is dropped.
  const fetchSeq = useRef(0);

  useEffect(() => {
    const seq = ++fetchSeq.current;
    let cancelled = false;
    void (async () => {
      let rows;
      try {
        rows = await vaultBlockAnchors();
      } catch {
        return; // best-effort — leave the prior set
      }
      const mapped: EditorVaultBlockAnchor[] = rows.map((r) => ({
        noteUuid: r.noteId,
        title: r.noteTitle,
        folder: r.noteFolder,
        blockId: r.blockId,
        preview: r.preview,
      }));
      if (!cancelled && seq === fetchSeq.current) setAnchors(mapped);
    })();
    return () => {
      cancelled = true;
    };
  }, [indexNonce]);

  return anchors;
}
