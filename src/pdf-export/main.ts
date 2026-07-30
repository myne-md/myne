// Hidden PDF-export render page script (MYND-255 task 4).
//
// Runs ONLY inside the invisible `pdf-export` WebviewWindow created by
// `src-tauri/src/plugins/pdf_export/commands.rs`. Its whole job:
//
//   1. fetch the staged payload (`pdf_export_payload`) — the note's
//      ALREADY-EMITTED HTML projection (the main window ran
//      `emitNoteHtml`; KaTeX/mermaid/highlight rendered THERE, so this
//      page never parses markdown and never runs a renderer),
//   2. compose the document: print stylesheet (locale-resolved `@page
//      size`, `src/dialect/html/page-geometry.ts`) + `@font-face` for
//      the bundled woff2 faces + KaTeX's CSS when the projection
//      contains math, then inject the body markup,
//   3. wait for layout to actually settle — fonts loaded, attachment
//      images decoded, two paint frames — and signal
//      `pdf_export_ready`, releasing the native print-to-PDF capture.
//
// Failure posture: fail SILENT and never signal ready — the Rust
// orchestrator's readiness deadline turns a wedged page into a clean
// `RenderTimeout` (window destroyed, stash wiped, nothing written).
// Nothing note-derived is ever logged (DENY-list discipline).
//
// The window's capability (`src-tauri/capabilities/pdf-export.json`,
// permission set `pdf-export:page`) grants exactly the two commands
// invoked here and nothing else.

import { invoke } from "../platform/core";
import { composePrintStylesheet } from "../dialect/html/page-geometry";
import { FONT_FACE_CSS } from "../dialect/html/font-face";

/** Wire mirror of `commands.rs::PdfExportPayload`. */
interface PdfExportPayload {
  readonly html: string;
  readonly title: string | null;
}

/** Explicit font-load nudges so `document.fonts.ready` deterministically
 *  covers the faces the print CSS uses (a face nothing has laid out yet
 *  would otherwise not even be loading when `ready` is sampled). */
const FONT_LOAD_PROBES = [
  '13px "Inter Variable"',
  'bold 13px "Inter Variable"',
  '11.5px "JetBrains Mono"',
] as const;

async function settleFonts(): Promise<void> {
  await Promise.all(
    FONT_LOAD_PROBES.map((probe) =>
      document.fonts.load(probe).catch(() => undefined),
    ),
  );
  await document.fonts.ready;
}

/** Wait until every image (the `attachment://` embeds) is decoded; a
 *  broken/missing attachment must stall nothing — it prints as the
 *  browser's broken-image placeholder rather than wedging the export.
 *
 *  Not stalling is right; staying SILENT was not (MYND-638). The
 *  `attachment://` handler was fenced to the `main` webview label, so every
 *  image request from this window was refused with a 403 — and because the
 *  failure was swallowed here without a trace, the export produced a PDF with
 *  no images at all and reported success. Count the failures and warn: this
 *  page's console is the only place a reader can see that a projection which
 *  asked for images printed without them. */
async function settleImages(): Promise<void> {
  const outcomes = await Promise.all(
    Array.from(document.images, (img) =>
      img.decode().then(
        () => true,
        () => false,
      ),
    ),
  );
  const failed = outcomes.filter((ok) => !ok).length;
  if (failed > 0) {
    // Count only — an attachment id is a per-note correlation tag and a
    // filename is note content, so neither belongs in a log line
    // (`src-tauri/CLAUDE.md` secret-handling discipline).
    // eslint-disable-next-line no-console
    console.warn(
      `[pdf-export] ${failed} of ${outcomes.length} images failed to load; ` +
        "the PDF will print without them",
    );
  }
}

/** Two animation frames: layout + paint with the final fonts/images —
 *  raced against a short timer because an INVISIBLE window's WebView
 *  may throttle or suspend rAF entirely (the window is `visible:
 *  false` by design); the timer keeps the page from wedging into
 *  `RenderTimeout` while still granting a paint nudge when rAF runs. */
function settleFrames(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 250);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      }),
    );
  });
}

async function run(): Promise<void> {
  const payload = await invoke<PdfExportPayload>(
    "plugin:pdf-export|pdf_export_payload",
  );

  // PDF metadata title (the engines stamp the document title into the
  // produced file). The NATIVE window title stays the static "Myne"
  // set by the Rust side — Tauri does not sync document.title to it.
  document.title = payload.title ?? "Note";

  const style = document.createElement("style");
  style.textContent =
    FONT_FACE_CSS + composePrintStylesheet(navigator.language);
  document.head.appendChild(style);

  // KaTeX markup ships its own class vocabulary + fonts; load its CSS
  // only when the projection actually contains rendered math. The
  // emitter's `.math-error` fallback needs no KaTeX CSS.
  document.body.innerHTML = payload.html;
  if (document.querySelector(".katex") !== null) {
    await import("katex/dist/katex.min.css").catch(() => undefined);
  }

  await settleFonts();
  await settleImages();
  await settleFrames();

  await invoke<void>("plugin:pdf-export|pdf_export_ready");
}

void run().catch(() => {
  // Fail silent (no note-derived data may reach a console either); the
  // orchestrator's READY_TIMEOUT surfaces this as RenderTimeout.
});
