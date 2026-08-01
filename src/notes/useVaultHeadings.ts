// Vault-wide heading set for the `[[##` autocomplete (MYND-305).
//
// The `[[##` picker searches headings ACROSS the vault, but the resident
// note-set (titles/folders) doesn't carry headings. They come from the
// VaultIndices instead: `vaultIndicesApply` stores each note's headings off the
// parse it already runs, and this hook reads them back in ONE query.
//
// It did not always work that way, and the reason it does now is the point of
// myne#216. The set used to be derived by reading and re-parsing EVERY live note
// body on each rebuild — and the rebuild fires on the SYNC-5 index nonce, which
// every autosave bumps. On a 442-note vault that was ~0.8 s of parsing plus 442
// IPC round-trips and 442 AEAD decrypts, once per second of typing, once per
// open pane. The headings were already being extracted on the way in; nothing
// was keeping them.
//
// Two consequences of reading an index instead of the notes:
//
//   - **The join is not optional.** The Rust index is trash-blind (see
//     `resolverNotes.ts`), so rows arrive for trashed and template notes too.
//     Joining against the resident note-set is what excludes them — the same
//     single place every other reader surface excludes them — and it supplies
//     each note's title/folder, so those never go stale against a rename.
//   - **A note's headings are only as fresh as its last `apply`.** That is the
//     same staleness the backlink, tag and task surfaces already have, and the
//     same nonce refreshes all of them.

import { useEffect, useMemo, useRef, useState } from "react";
import type { VaultHeading } from "../editor/wikilink/vault-headings";
import { useIndexNonce } from "./indexNonce";
import { useResolverNotes } from "./resolverNotes";
import type { ResolverNote } from "./resolveWikilink";
import { vaultHeadings, type VaultHeadingRow } from "./vaultIndices";

/**
 * Join raw index rows against the resident note-set into the picker's shape.
 *
 * Rows whose note is absent from `notes` are DROPPED — that is how trashed and
 * template notes stay out of the picker, and it is the only exclusion this
 * function performs (`resolverCache` already decided what "resident" means).
 *
 * Output order follows `notes`, then document order within each note, so the
 * result is deterministic even though the index returns rows in hash order.
 * Pure — unit-testable without React.
 */
export function joinVaultHeadings(
  rows: readonly VaultHeadingRow[],
  notes: readonly ResolverNote[],
): VaultHeading[] {
  const byNote = new Map<string, VaultHeadingRow[]>();
  for (const row of rows) {
    const bucket = byNote.get(row.noteId);
    if (bucket === undefined) byNote.set(row.noteId, [row]);
    else bucket.push(row);
  }
  const out: VaultHeading[] = [];
  for (const note of notes) {
    for (const row of byNote.get(note.noteUuid) ?? []) {
      out.push({
        noteUuid: note.noteUuid,
        title: note.title,
        folder: note.folder,
        heading: row.text,
        level: row.level,
      });
    }
  }
  return out;
}

/**
 * The vault-wide heading set. Refetched when the SYNC-5 index nonce changes (a
 * note create/edit/delete bumps it); rejoined when the resident note-set changes
 * (a rename changes a row's displayed title without touching the index).
 * Empty until the first query settles; best-effort — a failed query leaves the
 * prior set rather than blanking the picker.
 */
export function useVaultHeadings(): readonly VaultHeading[] {
  const notes = useResolverNotes();
  const indexNonce = useIndexNonce();
  const [rows, setRows] = useState<readonly VaultHeadingRow[]>([]);
  // Guard so a query that resolves after a newer one is dropped.
  const fetchSeq = useRef(0);

  useEffect(() => {
    const seq = ++fetchSeq.current;
    let cancelled = false;
    void (async () => {
      let fetched: VaultHeadingRow[];
      try {
        fetched = await vaultHeadings();
      } catch {
        return; // best-effort — leave the prior set
      }
      if (!cancelled && seq === fetchSeq.current) setRows(fetched);
    })();
    return () => {
      cancelled = true;
    };
  }, [indexNonce]);

  return useMemo(() => joinVaultHeadings(rows, notes), [rows, notes]);
}
