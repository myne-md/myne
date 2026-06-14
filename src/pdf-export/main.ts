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

import { invoke } from "@tauri-apps/api/core";
import { composePrintStylesheet } from "../dialect/html/page-geometry";

/** Wire mirror of `commands.rs::PdfExportPayload`. */
interface PdfExportPayload {
  readonly html: string;
  readonly title: string | null;
}

// The bundled self-hosted faces (public/fonts/ — see src/CLAUDE.md
// "Design tokens"). PRINT_CSS references the family NAMES only (both
// the "… Variable" and plain forms, mirroring colors_and_type.css);
// this standalone document serves the faces itself. Both names map to
// the same variable-font file.
const FONT_FACE_CSS = `
@font-face {
  font-family: "Inter Variable";
  font-style: normal;
  font-weight: 100 900;
  font-display: block;
  src: url("/fonts/InterVariable.woff2") format("woff2");
}
@font-face {
  font-family: "Inter";
  font-style: normal;
  font-weight: 100 900;
  font-display: block;
  src: url("/fonts/InterVariable.woff2") format("woff2");
}
@font-face {
  font-family: "JetBrains Mono Variable";
  font-style: normal;
  font-weight: 100 800;
  font-display: block;
  src: url("/fonts/JetBrainsMono.woff2") format("woff2");
}
@font-face {
  font-family: "JetBrains Mono";
  font-style: normal;
  font-weight: 100 800;
  font-display: block;
  src: url("/fonts/JetBrainsMono.woff2") format("woff2");
}
`;

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
 *  browser's broken-image placeholder rather than wedging the export. */
async function settleImages(): Promise<void> {
  await Promise.all(
    Array.from(document.images, (img) => img.decode().catch(() => undefined)),
  );
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
