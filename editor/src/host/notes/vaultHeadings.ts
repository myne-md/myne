// The vault-wide heading set's shared half: the two wire types and the pure
// join, answered once for every client (myne-md/myne#452).
//
// Each client keeps its own IPC wrapper around `vault_indices_headings`,
// because the seam differs; what does NOT differ is the shape of a row and what
// a consumer must do with one before showing it. Both were desktop-only until
// mobile needed them, and the alternative was a second copy under
// `mobile/src/lib/`, which would be a drift pair no twin guard can see: the two
// files sit at different relative paths, so `check-twin-inventory.mjs` and
// `check-twin-drift-ratchet.mjs` would never pair them. `graphModel`,
// `propertyTyping` and `queryEngine` beside this file are here for the same
// reason, and after myne-md/myne#199 the rule this package states about itself is
// that a second declaration of a wire type is a second answer waiting to drift.

import type { VaultHeading } from "../../wikilink/vault-headings";
import type { ResolverNote } from "./resolveWikilink";

/** One heading — TS mirror of the Rust `HeadingEntry` (myne#216). Text + level
 *  only; the byte offsets `headingSections` also produces serve FOLDING, which
 *  runs against the open note's own parse and needs no vault-wide copy.
 *  serde camelCase. */
export type HeadingEntry = {
  text: string;
  level: number;
};

/** One vault-wide heading row — TS mirror of the Rust `VaultHeadingRow`
 *  (myne#216). Deliberately carries no note title/folder: the consumer joins
 *  against the resident note-set anyway (that join is where trashed/template
 *  exclusion lives), and a second copy here would go stale between a rename and
 *  the re-apply that follows it. */
export type VaultHeadingRow = {
  noteId: string;
  text: string;
  level: number;
};

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
