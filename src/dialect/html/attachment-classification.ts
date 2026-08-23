// Attachment-embed classification for the HTML projection (MYND-255).
//
// Deliberately split out of `emitNoteHtml.ts`: the emitter is the heavy,
// lazy-imported half (lezer parse + KaTeX/mermaid/highlight loads), while
// the PDF export flow needs the SAME image-vs-excluded classification
// CHEAPLY, before the user has even confirmed a destination
// (`runNotePdfExportFlow`'s pre-export exclusion notice). Single-sourcing
// the extension allowlist + display-name fallback here is what keeps the
// notice and the emitted placeholders from ever drifting apart.

import { extractAttachmentRefs } from "../../notes/attachmentRef";
import { parseEmbedAlias } from "@myne/dialect/embedLayout";

/** An attachment embed that could not be included in the projection. */
export interface ExcludedAttachment {
  readonly id: string;
  readonly filename: string;
}

/**
 * Image-ness is decided by a filename-extension allowlist
 * (png/jpg/jpeg/gif/webp/svg) — form-C embeds carry no content-type; the
 * capture path's `attachment://` protocol re-sniffs the real type when
 * serving bytes. Everything else (PDFs included) is NOT inlined.
 */
export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg)$/i;

/**
 * The display name an embed renders/reports under: the alias SPLIT to its
 * filename (myne#409), or the generic fallback when the embed is malformed
 * (alias missing/empty).
 *
 * The split lives here rather than at each call site because this helper is the
 * single source both halves of the projection consult, and they diverged the
 * moment it did not split: `scanExcludedAttachments` below reads a
 * pre-split filename from `extractAttachmentRefs`, while `emitNoteHtml`'s
 * `renderAttachmentEmbed` passes the RAW alias. With layout segments in the
 * alias, `photo.png|w=300` failed the anchored `IMAGE_EXT_RE`, so the emitter
 * reclassified a sized image as a non-image and replaced it with an
 * "Attachment … not included" placeholder carrying the raw segment text, while
 * the pre-flight notice still counted it as an included image. That inverts the
 * invariant stated above: the notice may name a file the projection keeps,
 * never the reverse.
 *
 * Idempotent, so passing an already-split filename is safe: a filename that
 * legitimately contains a pipe (`re|port.png`) re-splits to itself, because a
 * later unkeyed segment rejoins the filename.
 */
/**
 * What an embed with no readable filename is called.
 *
 * Exported so a caller that has ALREADY parsed the alias can apply the fallback
 * without parsing it a second time, which is the emitter's case: it needs the
 * layout off the same parse. The rule stays in one place either way, and that is
 * what this module's header insists on.
 */
export const ATTACHMENT_FALLBACK_NAME = "attachment";

export function attachmentEmbedDisplayName(filename: string): string {
  const { filename: name } = parseEmbedAlias(filename);
  return name !== "" ? name : ATTACHMENT_FALLBACK_NAME;
}

/**
 * The attachments `emitNoteHtml` will exclude from a projection of `body`
 * (non-image form-C embeds), WITHOUT running the emitter: a pure regex
 * scan (the `extractAttachmentRefs` tokenizer) + the same extension test
 * and display-name fallback the emitter applies. De-duplicated by id,
 * first occurrence's filename wins — mirroring the emitter's
 * `collectExcluded`.
 *
 * Known, accepted asymmetry (255-F7): this scan covers the WHOLE body —
 * a form-C embed inside a code fence or frontmatter raises the notice
 * even though the emitter renders it literally and never excludes it.
 * Over-warning is the safe direction (the notice can name a file the
 * projection actually keeps as literal text, never the reverse), and
 * stripping code ranges would drag parser work into the cheap path.
 */
export function scanExcludedAttachments(body: string): ExcludedAttachment[] {
  return extractAttachmentRefs(body)
    .map(({ id, filename }) => ({
      id,
      filename: attachmentEmbedDisplayName(filename),
    }))
    .filter((a) => !IMAGE_EXT_RE.test(a.filename));
}

/**
 * The distinct IMAGE attachment ids referenced by `body` — the set the
 * HTML projection inlines as `<img>` and (in an attachments-included
 * HTML export) writes as relative sidecar files. The mirror of
 * `scanExcludedAttachments` (same cheap `extractAttachmentRefs` scan +
 * the same `IMAGE_EXT_RE` test, opposite filter), so the HTML export's
 * pre-flight "Include N images" count matches what the projection
 * actually writes beside the `.html`. De-duplicated by id (first
 * occurrence wins). Used by `runNoteHtmlExportFlow` to decide whether to
 * show the attachments pre-flight modal.
 */
export function scanImageAttachments(body: string): ExcludedAttachment[] {
  const seen = new Set<string>();
  const out: ExcludedAttachment[] = [];
  for (const { id, filename } of extractAttachmentRefs(body)) {
    const name = attachmentEmbedDisplayName(filename);
    if (!IMAGE_EXT_RE.test(name)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, filename: name });
  }
  return out;
}
