// Extract a note's vault-indices contribution TS-side (the sweep that feeds the
// backend `vault_indices_apply`). Wikilink edges + folded tags + the note's own
// folded title-key, all folded with `foldSegment` (Turkish-correct) — the same
// model the backend index resolves against.

import { foldSegment } from "../dialect/folderPath";
import { parseTags } from "./tags";
import type { WikilinkEdge, TagEntry, IndexRecord } from "./vault-indices";

const enc = new TextEncoder();

// `[[Target]]` / `![[Target|alias]]`, target may carry `#anchor` / `^block`.
const WIKILINK_RE = /(!?)\[\[([^\]\n]+?)\]\]/g;

/** Outbound wikilink edges (attachment `att:` embeds excluded — not note links).
 *  Matches arrive in ascending order, so byte offsets are accumulated with a
 *  running cursor (one linear encode pass, not a full re-encode per match). */
export function extractWikilinks(body: string): WikilinkEdge[] {
  const out: WikilinkEdge[] = [];
  let charCursor = 0;
  let byteCursor = 0;
  for (let m = WIKILINK_RE.exec(body); m !== null; m = WIKILINK_RE.exec(body)) {
    const embed = m[1] === "!";
    const inner = m[2];
    const pipe = inner.indexOf("|");
    const alias = pipe >= 0 ? inner.slice(pipe + 1).trim() || null : null;
    let ref = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
    if (ref.startsWith("att:")) continue;
    let anchor: string | null = null;
    let blockId: string | null = null;
    const caret = ref.indexOf("^");
    if (caret >= 0) {
      blockId = ref.slice(caret + 1).trim() || null;
      ref = ref.slice(0, caret);
    }
    const hash = ref.indexOf("#");
    if (hash >= 0) {
      anchor = ref.slice(hash + 1).trim() || null;
      ref = ref.slice(0, hash);
    }
    const target = ref.trim();
    if (!target) continue;
    byteCursor += enc.encode(body.slice(charCursor, m.index)).length;
    charCursor = m.index;
    const byteStart = byteCursor;
    out.push({
      target,
      targetKind: "title",
      titleKey: foldSegment(target),
      anchor,
      blockId,
      alias,
      embed,
      byteStart,
      byteEnd: byteStart + enc.encode(m[0]).length,
    });
  }
  return out;
}

/** Folded tags (deduped by folded key). */
export function extractTagEntries(body: string): TagEntry[] {
  const seen = new Set<string>();
  const out: TagEntry[] = [];
  for (const t of parseTags(body)) {
    const folded = foldSegment(t);
    if (seen.has(folded)) continue;
    seen.add(folded);
    out.push({ folded, display: t });
  }
  return out;
}

/** Full apply payload for one note. `title` is the display title (fm or first
 *  line); `body` is the raw note plaintext. */
export function extractRecord(noteId: string, title: string, folder: string | null, body: string): IndexRecord {
  return {
    noteId,
    title: title || null,
    folder,
    titleKey: title ? foldSegment(title) : null,
    wikilinks: extractWikilinks(body),
    tags: extractTagEntries(body),
  };
}
