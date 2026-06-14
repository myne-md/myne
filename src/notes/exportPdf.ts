// IPC wrapper for the `pdf-export` plugin's render command (MYND-255).
//
// Deliberate, user-initiated plaintext egress across TB3 (the `.md`
// export posture): the backend stashes the ALREADY-EMITTED HTML
// projection, drives a hidden render window through the platform's
// native print-to-PDF, and atomically publishes the verified `%PDF`
// output at a user-chosen path. `targetPath` must come from the OS save
// dialog (`dialog:allow-save`) — the dialog IS the consent source, and
// its "Replace" confirmation is what authorizes `overwrite=true`.
//
// The caller (task 5's flow function) composes the projection first:
//
// ```ts
// const { emitNoteHtml } = await import("../dialect/html/emitNoteHtml");
// const { html, title } = await emitNoteHtml(plaintext); // mermaid "auto"
// await exportNotePdf(html, title, targetPath, overwrite);
// ```
//
// (`emitNoteHtml` runs in the MAIN window — KaTeX/mermaid/highlight need
// a real WebView and the plaintext already lives there; the hidden
// window only renders, see `src/pdf-export/main.ts`.)

import { invoke } from "@tauri-apps/api/core";

/**
 * Render an emitted note-HTML projection to a PDF at `targetPath` via
 * the hidden export window + native print-to-PDF, atomically (full
 * success or nothing at the destination — no temp residue).
 *
 * `html` is the body markup from `emitNoteHtml` (no `<html>/<head>`
 * shell — the hidden page composes the document); `title` feeds the
 * PDF's metadata title (`null` for an untitled note). One export runs
 * at a time; a second call while in flight rejects with
 * `ExportInProgress`.
 *
 * Rejects with a `PdfExportError` (see `src/types/pdf-export-error.ts`).
 */
export async function exportNotePdf(
  html: string,
  title: string | null,
  targetPath: string,
  overwrite: boolean,
): Promise<void> {
  await invoke<void>("plugin:pdf-export|pdf_export_render", {
    html,
    title,
    targetPath,
    overwrite,
  });
}
