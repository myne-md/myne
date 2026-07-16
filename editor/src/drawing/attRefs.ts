// SYNC-8 GC-safety for drawing-note attachments (drawing-notes SF3, MYND-500).
//
// A drawing references its images by Excalidraw fileId inside the scene JSON —
// invisible to the fail-closed attachment GC (`ref_scan.rs`), which only counts
// canonical `![[att:<id>]]` form-C embeds in a note BODY. So on every save the
// drawing body regenerates a trailing block of `![[att:<id>]]` refs — a SUPERSET
// of the attachment-ids the live scene references. The GC path stays UNCHANGED
// (option A): a lingering ref only delays reclamation (safe); a MISSING ref would
// cryptographically-erase a live image (data loss) — so we always write the full
// current set. These transforms are pure; the scene→attachment-id extraction (the
// paste/import interception) is the runtime half.

// Canonical form-C attachment embed: `![[att:<64-lowercase-hex>]]`. This MUST
// mirror the GC counter's EXACT shape — `ref_scan.rs`/`reconcile.rs`
// (`extract_att_embed_spans`, `ATT_ID_HEX_LEN = 64`) count only exactly-64-hex
// ids. A ref written in any looser shape is one the fail-closed GC will not
// count → the attachment reads as unreferenced → cryptographic-erase of a live
// image (SYNC-8's only dangerous direction). So we reuse the canonical
// `isAttachmentId` (`/^[0-9a-f]{64}$/`) and a matching 64-hex strip regex.
import { isAttachmentId } from "../host/notes/attachmentRef";

const ATT_REF_LINE = (id: string): string => `![[att:${id}]]`;
const ATT_REF_RE = /^!\[\[att:[0-9a-f]{64}\]\]$/;

/**
 * The trailing att-ref block for a set of attachment-ids — sorted + de-duplicated,
 * one canonical `![[att:<64-hex>]]` per line. Non-canonical ids are dropped (a real
 * id from `attachment_import` is always 64-hex; writing a malformed one would be an
 * uncounted, erasable ref). Empty string when there are none.
 */
export function buildAttRefBlock(attachmentIds: readonly string[]): string {
  const unique = [...new Set(attachmentIds)].filter(isAttachmentId).sort();
  return unique.map(ATT_REF_LINE).join("\n");
}

/**
 * Rewrite the trailing att-ref block of a drawing body to exactly `attachmentIds`
 * (the current live set), preserving frontmatter + the ```excalidraw fence + the
 * scene byte-for-byte. Idempotent: strips any prior canonical att-ref lines first.
 * A no-op on a body with no excalidraw fence.
 */
export function upsertAttRefs(
  content: string,
  attachmentIds: readonly string[],
): string {
  const fenceStart = content.indexOf("```excalidraw");
  if (fenceStart === -1) return content;
  const closeIdx = content.indexOf("\n```", fenceStart + "```excalidraw".length);
  if (closeIdx === -1) return content;
  const afterClose = closeIdx + "\n```".length;
  const head = content.slice(0, afterClose);

  // Everything after the fence close, minus prior canonical att-refs + blank lines.
  const rest = content
    .slice(afterClose)
    .split("\n")
    .filter((l) => l.trim() !== "" && !ATT_REF_RE.test(l.trim()))
    .join("\n");

  const block = buildAttRefBlock(attachmentIds);
  let out = head;
  if (block !== "") out += "\n" + block;
  if (rest !== "") out += "\n" + rest;
  return out + "\n";
}
