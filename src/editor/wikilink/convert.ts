// R2 per-note conversion engine (`wikilink.md` §7) — pure planning of the
// rewrite of imported title-only wikilinks (forms 1–4) into Myne's canonical §3
// path form. Path-form links and embeds are left untouched (idempotent). Emits
// via the one `emitNoteWikilink` (WL-4); resolves via the one resolver (WL-2);
// ambiguous links carry their candidates (WL-3) for the inline preview picker.
// No CodeMirror imports → unit-testable without a view.

import { extractWikilinks } from "../../dialect/visitors/wikilinks";
import { titleToFilename } from "../../dialect/folderPath";
import type { ByteRange, WikilinkRef } from "../../dialect/types";
import {
  resolveWikilink,
  type ResolverNote,
} from "../../notes/resolveWikilink";
import { emitNoteWikilink } from "./emit";

export type ConversionRow =
  | { kind: "rewrite"; byteRange: ByteRange; before: string; after: string }
  | {
      kind: "ambiguous";
      byteRange: ByteRange;
      before: string;
      ref: WikilinkRef;
      candidates: readonly ResolverNote[];
    }
  | { kind: "skipped"; byteRange: ByteRange; before: string; reason: string };

/**
 * The canonical §3 form a converted link emits for `note`, preserving the
 * original ref's alias (else synthesizing from the title) and carrying its
 * `#heading` / `^block` anchors onto the path form (§8.2 / WL-10). For an
 * anchor-free link this is byte-identical to `emitNoteWikilink` (WL-4).
 */
export function convertedLink(note: ResolverNote, ref: WikilinkRef): string {
  const title = note.title ?? "";
  const display = ref.alias ?? title;
  const anchor =
    (ref.heading !== null ? `#${ref.heading}` : "") +
    (ref.blockId !== null ? `^${ref.blockId}` : "");
  if (anchor === "") return emitNoteWikilink(note.folder, title, display);
  const path = (note.folder ?? "") + titleToFilename(title);
  return `[[${path}${anchor}|${display}]]`;
}

/**
 * Plan the per-note conversion: one row per imported title-only wikilink, in
 * document order. Path-form links (`targetKind === "vault-path"`) and embeds
 * are skipped entirely (no row) so re-running is idempotent.
 */
export function planWikilinkConversion(
  body: string,
  notes: readonly ResolverNote[],
): ConversionRow[] {
  const rows: ConversionRow[] = [];
  for (const ref of extractWikilinks(body)) {
    if (ref.embed) continue; // embeds aren't authored path-form in v0.1
    if (ref.targetKind !== "title") continue; // already path-form → leave alone
    const res = resolveWikilink(ref, notes);
    if (res.status === "broken") {
      rows.push({ kind: "skipped", byteRange: ref.byteRange, before: ref.raw, reason: "no match" });
      continue;
    }
    if (res.ambiguous) {
      rows.push({
        kind: "ambiguous",
        byteRange: ref.byteRange,
        before: ref.raw,
        ref,
        candidates: res.candidates,
      });
      continue;
    }
    const note = res.candidates.find((n) => n.noteUuid === res.noteUuid) ?? res.candidates[0];
    if (note === undefined) continue;
    rows.push({
      kind: "rewrite",
      byteRange: ref.byteRange,
      before: ref.raw,
      after: convertedLink(note, ref),
    });
  }
  return rows;
}
