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

/** The display name an embed renders/reports under — the alias, or the
 *  generic fallback when the embed is malformed (alias missing/empty). */
export function attachmentEmbedDisplayName(filename: string): string {
  return filename !== "" ? filename : "attachment";
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
