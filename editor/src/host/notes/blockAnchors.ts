// The vault-wide `[[^^` block-anchor set's shared half: the two wire types and
// the per-note extraction that feeds `vault_indices_apply` (myne-md/myne#452).
//
// Here for the reason `vaultHeadings.ts` beside it is here. The extraction is
// pure and host-free, both clients owe the index the same entries, and a second
// copy under `mobile/src/lib/` would be a drift pair at a different relative
// path, which every twin guard is blind to. The marker grammar itself is NOT
// re-stated: it comes from the one dialect scanner `extractBlockAnchors`, and
// the only regex below strips a suffix that scanner already located.

import { extractBlockAnchors } from "../../wikilink/anchor";
import type { VaultBlockAnchor as PickerBlockAnchor } from "../../wikilink/vault-block-anchors";
import type { ResolverNote } from "./resolveWikilink";

/** One imported `^block-id` anchor — TS mirror of the Rust `BlockAnchor`
 *  (MYND-382). Enumerate-only: surfaces markers that already exist (import),
 *  never mints one. `preview` is the tagged block's first-line text (picker
 *  secondary line). serde camelCase. */
export type BlockAnchorEntry = {
  blockId: string;
  preview: string;
};

/** One resolved vault-wide block anchor — TS mirror of the Rust
 *  `VaultBlockAnchor` (MYND-382). The `[[^^` picker row: which note carries the
 *  anchor (id + title) + the block id + preview. Opening inserts a
 *  `[[<note>^blockId]]` deep-link.
 *
 *  This is the WIRE shape. `wikilink/vault-block-anchors.ts` declares a
 *  same-named FACET shape (`noteUuid`/`title`/`folder`), which is what the
 *  picker reads; `joinVaultBlockAnchors` below is the one conversion between
 *  them. Neither is assignable to the other, so a mixed-up import fails to
 *  compile rather than rendering the wrong field. */
export type VaultBlockAnchor = {
  noteId: string;
  noteTitle: string | null;
  noteFolder: string | null;
  blockId: string;
  preview: string;
};

/** Max characters of block text kept as the picker preview line. */
const BLOCK_ANCHOR_PREVIEW_CAP = 120;

/** The line-tail marker grammar (mirrors `extractBlockAnchors`) — used only to
 *  strip the ` ^id` suffix from a preview line. */
const BLOCK_MARKER_TAIL = /(?:^|[ \t])\^[A-Za-z0-9-]+[ \t]*$/;

/**
 * Enumerate a note's imported `^block-id` anchors as `{blockId, preview}`
 * entries for the vault-wide `[[^^` index (MYND-382). Reuses the single dialect
 * scanner `extractBlockAnchors` for the marker grammar, then derives each
 * preview from the tagged block's line (marker stripped, whitespace-collapsed,
 * capped). Enumerate-only — mints nothing.
 */
export function extractBlockAnchorEntries(body: string): BlockAnchorEntry[] {
  return extractBlockAnchors(body).map(({ blockId, from }) => {
    const nl = body.indexOf("\n", from);
    const line = body.slice(from, nl === -1 ? undefined : nl);
    let preview = line.replace(BLOCK_MARKER_TAIL, "").replace(/\s+/g, " ").trim();
    // An own-line marker (`^id` alone on its line) is Obsidian's form for a
    // NON-paragraph block (table / list / callout / code): the marker refers to
    // the PRECEDING block, so the marker line strips to empty. Fall back to the
    // nearest preceding non-empty line so the picker still shows a real preview.
    if (preview === "") preview = precedingNonEmptyLine(body, from);
    return { blockId, preview: preview.slice(0, BLOCK_ANCHOR_PREVIEW_CAP) };
  });
}

/** The nearest non-empty line strictly before offset `from` (a marker line's
 *  start), whitespace-collapsed — the preview for an own-line block marker. */
function precedingNonEmptyLine(body: string, from: number): string {
  const before = body.slice(0, from > 0 ? from - 1 : 0);
  const lines = before.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.replace(/\s+/g, " ").trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

/**
 * Join raw index rows against the resident note-set into the picker's shape.
 *
 * The twin of `joinVaultHeadings`, and it is a join rather than a map for the
 * same reason: the Rust index is trash-blind, so rows arrive for trashed,
 * template and conflict-copy notes too, and dropping the ones whose note is
 * absent from `notes` is the only thing that keeps them out of the picker. It
 * matters more here than for headings, because a `[[^^` row is a DEEP LINK: an
 * unfiltered row offers to point a live note at a trashed one.
 *
 * The rows carry `noteTitle` and `noteFolder` of their own, unlike heading rows,
 * and those are deliberately NOT used. The resident note-set's copy is the fresh
 * one: an index row still holds whatever title the note had at its last apply,
 * so a rename between the apply and the picker opening would emit a stale path.
 *
 * Output order follows `notes`, then row order within each note, so the result
 * is deterministic even though the index returns rows in hash order. Pure.
 */
export function joinVaultBlockAnchors(
  rows: readonly VaultBlockAnchor[],
  notes: readonly ResolverNote[],
): PickerBlockAnchor[] {
  const byNote = new Map<string, VaultBlockAnchor[]>();
  for (const row of rows) {
    const bucket = byNote.get(row.noteId);
    if (bucket === undefined) byNote.set(row.noteId, [row]);
    else bucket.push(row);
  }
  const out: PickerBlockAnchor[] = [];
  for (const note of notes) {
    for (const row of byNote.get(note.noteUuid) ?? []) {
      out.push({
        noteUuid: note.noteUuid,
        title: note.title,
        folder: note.folder,
        blockId: row.blockId,
        preview: row.preview,
      });
    }
  }
  return out;
}
