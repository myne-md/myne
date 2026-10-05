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

import { useEffect, useMemo, useRef, useState } from "react";
import type { VaultBlockAnchor as EditorVaultBlockAnchor } from "../editor/wikilink/vault-block-anchors";
import {
  joinVaultBlockAnchors,
  type VaultBlockAnchor,
} from "@myne/editor/host/notes/blockAnchors";
import { useIndexNonce } from "./indexNonce";
import { useResolverNotes } from "./resolverNotes";
import { rowsEqual } from "./rowsEqual";
import { vaultBlockAnchors } from "./vaultIndices";

/**
 * The vault-wide imported block-anchor set. Refetched when the SYNC-5 index
 * nonce changes (a note create/edit/delete bumps it); rejoined when the resident
 * note-set changes, since a rename changes a row's emitted path without touching
 * the index. Empty until the first async query settles.
 *
 * It JOINS rather than maps (myne-md/myne#452). The Rust dump is trash-blind, so
 * the join is what keeps trashed, template and conflict-copy notes out of a
 * picker whose rows are deep links, and it takes each row's title and folder
 * from the resident note rather than from the row, which is the copy a rename
 * updates.
 */
export function useVaultBlockAnchors(): readonly EditorVaultBlockAnchor[] {
  const notes = useResolverNotes();
  const indexNonce = useIndexNonce();
  const [rows, setRows] = useState<readonly VaultBlockAnchor[]>([]);
  // Guard so a query that resolves after a newer one is dropped.
  const fetchSeq = useRef(0);

  useEffect(() => {
    const seq = ++fetchSeq.current;
    let cancelled = false;
    void (async () => {
      let fetched: VaultBlockAnchor[];
      try {
        fetched = await vaultBlockAnchors();
      } catch {
        return; // best-effort — leave the prior set
      }
      if (!cancelled && seq === fetchSeq.current) {
        // Identity-stable when unchanged (the same per-autosave churn the
        // heading twin carries; see `rowsEqual`).
        setRows((prev) =>
          rowsEqual(prev, fetched, [
            "noteId",
            "noteTitle",
            "noteFolder",
            "blockId",
            "preview",
          ])
            ? prev
            : fetched,
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [indexNonce]);

  // myne-md/myne#452: this used to MAP the rows straight onto the facet shape,
  // which shipped the trash-blind index verbatim into the picker: `[[^^` listed
  // anchors in trashed, template and conflict-copy notes, and selecting one
  // emitted a deep link INTO a trashed note. `useVaultHeadings` beside this file
  // has always joined for exactly that reason, and the join is shared now, so
  // both pickers and both clients answer it once. Rejoined when the resident
  // note-set changes, since a rename changes a row's emitted path without
  // touching the index.
  return useMemo(() => joinVaultBlockAnchors(rows, notes), [rows, notes]);
}
