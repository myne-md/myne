// Standalone HTML-document assembler for the per-note HTML export
// (note-export, MYND-340 task 2).
//
// Wraps the `emitNoteHtml` body (the shared HTML projection — already
// escaped, scheme-allowlisted, comment/PI-omitting) in a complete
// `<html>…</html>` document, mirroring the head the PDF hidden window
// composes (`src/pdf-export/main.ts`): the print stylesheet
// (`composePrintStylesheet` — locale-resolved `@page size`), the bundled
// `@font-face` rules, and KaTeX's own CSS WHEN the projection contains
// math. CSS is INLINED (the print stylesheet is a TS string; no linked
// asset), so the produced `.html` is a single self-contained file.
//
// The body's image refs (`<img src="attachment://<id>">`) are handled by
// the caller (task 3): the default export leaves them as-is (they resolve
// only in-app), and the attachments-included export rewrites them to
// relative sidecar filenames Rust-side. This assembler is pure over the
// body it is given — but it PINS the projection to the canonical
// `attachment://<id>` form (`canonicalAttachmentUrl`), never the
// platform-aware runtime form (MYND-519): the Rust rewriter
// (`html_referenced_attachment_ids`) scans for exactly that shape, and a
// deterministic export must not vary by the platform it was written on.
//
// SYNC-2: this is a LOSSY projection (derived artifact), not the `.md`
// source — the `%%`-comment strip (SYNC-1, owned by editor-comments #5)
// hooks the shared `emitNoteHtml` this composes over, so HTML inherits the
// strip for free once #5 lands.

import i18n from "../../i18n";
import { canonicalAttachmentUrl } from "../../notes/attachmentRef";
import { emitNoteHtml, type EmitNoteHtmlOptions } from "./emitNoteHtml";
import { composePrintStylesheet } from "./page-geometry";
import { FONT_FACE_CSS } from "./font-face";
import { escapeHtml } from "./escape";

export interface EmitStandaloneHtmlOptions extends EmitNoteHtmlOptions {
  /** OS/UI locale tag for the `@page size` rule (Letter vs A4). Defaults
   *  to `"en-US"` in test/isolated contexts; production passes
   *  `navigator.language`. */
  readonly locale?: string;
}

export interface StandaloneHtmlResult {
  /** The complete `<html>…</html>` document string. */
  readonly document: string;
  /** The note's frontmatter `title:` (null when absent) — the caller
   *  reuses it for the attachments-included flow's metadata, mirroring
   *  the PDF flow. */
  readonly title: string | null;
}

/**
 * Project a note's plaintext to a complete, self-contained standalone
 * HTML document. Async because `emitNoteHtml` lazy-loads the heavy
 * renderers (KaTeX / mermaid / highlight); never throws on note content
 * (renderer-load failures degrade to escaped text inside the emitter, and
 * a KaTeX-CSS load failure degrades to math without its stylesheet).
 *
 * The `<title>` is the frontmatter `title:` (escaped) or `"Note"`.
 */
export async function emitStandaloneHtml(
  plaintext: string,
  opts: EmitStandaloneHtmlOptions = {},
): Promise<StandaloneHtmlResult> {
  // Canonical attachment srcs — the export-projection contract (see the
  // module header). A caller-supplied builder still wins if ever passed.
  const emitted = await emitNoteHtml(plaintext, {
    attachmentUrl: canonicalAttachmentUrl,
    ...opts,
  });
  const locale = opts.locale ?? "en-US";

  let css = FONT_FACE_CSS + composePrintStylesheet(locale);

  // KaTeX markup ships its own class vocabulary; inline its CSS only when
  // the projection actually rendered math (`.katex` is KaTeX's root class
  // — the emitter's `.math-error` fallback needs no KaTeX CSS). Imported
  // as a string via Vite's `?inline` so the produced `.html` carries the
  // styles inline (no linked asset). Load failure degrades silently —
  // the math still renders, just without KaTeX's spacing.
  if (emitted.html.includes('class="katex')) {
    const katexCss = await import("katex/dist/katex.min.css?inline")
      .then((m) => m.default)
      .catch(() => null);
    if (katexCss !== null) css += `\n${katexCss}`;
  }

  const titleText = emitted.title ?? i18n.t("export.note.documentTitleFallback");
  const document =
    "<!DOCTYPE html>\n" +
    '<html lang="en">\n' +
    "<head>\n" +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    `<title>${escapeHtml(titleText)}</title>\n` +
    `<style>\n${css}\n</style>\n` +
    "</head>\n" +
    // `dir="auto"` (RTL, myne#172): resolve the exported document's base
    // direction from its content, and the per-block `unicode-bidi: plaintext`
    // rule in the print stylesheet gives each block its own direction — so an
    // RTL or mixed-direction note exports/PDFs correctly even though the shell
    // is `lang="en"` (the export path does not carry the note's language).
    '<body dir="auto">\n' +
    emitted.html +
    "\n</body>\n" +
    "</html>\n";

  return { document, title: emitted.title };
}
