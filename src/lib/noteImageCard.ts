// MYND-361 note→image: build the shareable "card" for the SELECTION export.
//
// The rasterization path is deliberately ZERO-dependency (html2canvas / jspdf
// were rejected — reproducible-build + audit surface). It has three steps:
//   1. serialize the rendered selection to XHTML — RUNTIME (needs the live DOM,
//      via XMLSerializer);
//   2. wrap it in an <svg><foreignObject> card with padding + the active-theme
//      background — THIS module (pure + unit-testable);
//   3. draw the SVG to a <canvas> and export PNG/JPG, RAM-only, final file via
//      atomic_write — RUNTIME (needs the WebView canvas + the export IPC).
//
// This module owns step 2 (+ the data-URI encode). Steps 1 and 3 are the WebView
// runtime pieces, flagged for QA.

export interface ShareCardOptions {
  /** Content width in CSS px (the rendered selection's width). */
  readonly contentWidth: number;
  /** Rendered selection height in CSS px (measured by the caller at runtime). */
  readonly contentHeight: number;
  /** Card padding around the content, px (the stylised-card breathing room). */
  readonly padding: number;
  /** Card background — a CSS color (the ACTIVE theme's paper, per the grill). */
  readonly background: string;
  /** Font stack applied to the content wrapper. */
  readonly fontFamily?: string;
}

/** Escape a string for use inside an XML attribute value (SVG is XML). */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Wrap pre-serialized XHTML content in a padded, background-filled SVG card
 * (MYND-361 stylised share-card). `contentXhtml` MUST be well-formed XHTML — the
 * runtime caller produces it via `XMLSerializer` over the rendered selection.
 * Total card size = content + 2×padding on each axis; the content sits inset by
 * `padding` inside a `<foreignObject>`.
 */
export function buildSelectionCardSvg(contentXhtml: string, opts: ShareCardOptions): string {
  const width = opts.contentWidth + opts.padding * 2;
  const height = opts.contentHeight + opts.padding * 2;
  const fontFamily = escapeXmlAttr(opts.fontFamily ?? "sans-serif");
  const bg = escapeXmlAttr(opts.background);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect width="100%" height="100%" fill="${bg}"/>` +
    `<foreignObject x="${opts.padding}" y="${opts.padding}" width="${opts.contentWidth}" height="${opts.contentHeight}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${opts.contentWidth}px;font-family:${fontFamily}">${contentXhtml}</div>` +
    `</foreignObject>` +
    `</svg>`
  );
}

/**
 * Wrap an SVG string as a same-origin object URL for an `<img>` src (the
 * canvas-draw source, and the QR image).
 *
 * # Why not a `data:` URI (phase3-web-client task 97)
 *
 * It was one, and that single call site was the only reason the web client's
 * CSP carried `img-src … data:`. Task 44's acceptance criterion for attachment
 * rendering is that the policy admit object URLs **without** admitting remote or
 * `data:` content, and the difference is not stylistic: a `blob:` URL is an
 * opaque handle to an object this origin already holds — unforgeable from a
 * string, and dead once revoked — while `data:` carries its payload inline, so
 * admitting it admits any bytes any script can construct.
 *
 * Nothing else changes. A Blob-URL SVG in an `<img>` does not execute script and
 * does not taint the canvas, so `rasterizeCardToPng`'s tainted-canvas fallback
 * keeps meaning what it meant.
 *
 * **The caller owns the URL.** An object URL is a GC root for its Blob, so a
 * caller that forgets `URL.revokeObjectURL` leaks the SVG for the life of the
 * page — the same discipline the attachment cache already follows.
 */
export function svgToObjectUrl(svg: string): string {
  return URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
}
