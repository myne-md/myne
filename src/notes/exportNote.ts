// IPC wrapper for the `note_export_as_markdown` Tauri command (MYND-115).
//
// Deliberate, user-initiated plaintext egress across TB3: the backend
// decrypts one note and writes its FULL plaintext byte-for-byte verbatim
// (frontmatter included, zero post-processing) to a user-chosen path via
// the canonical atomic_write helper. `targetPath` must come from the OS
// save dialog (`dialog:allow-save`) — the dialog IS the consent source,
// and its "Replace" confirmation is what authorizes `overwrite=true`.
// Callers without that consent pass `overwrite=false` and surface the
// distinct `TargetAlreadyExists` rejection instead of clobbering.

import { invoke } from "@tauri-apps/api/core";

/**
 * Decrypt a note and write its full plaintext verbatim to `targetPath`,
 * atomically (full success or nothing left behind — no half-written
 * file, no stray temp).
 *
 * Rejects with a `NoteExportError` (see `src/types/note-export-error.ts`).
 */
export async function noteExportAsMarkdown(
  noteId: string,
  targetPath: string,
  overwrite: boolean,
): Promise<void> {
  await invoke<void>("plugin:notes|note_export_as_markdown", {
    noteId,
    targetPath,
    overwrite,
  });
}

/**
 * Opt-in attachments-included export (MYND-115 task 4): decrypt one
 * note plus every form-C-referenced attachment and write them
 * side-by-side into `targetDir` — the note as `noteFilename`, each
 * attachment under its catalog display name with deterministic
 * `" (1)"`-style suffix-dedup on collision (attachments NEVER overwrite
 * anything). The exported note's `![[att:<id>|name]]` embeds are
 * rewritten to `![[<final-filename>]]` (the markdown-dialect §6
 * sanctioned export transform — it inverts the importer rewrite's
 * form-C step; refs originally ingested from markdown-image form
 * converge to the wikilink form rather than byte-reverting, so the
 * round-trip converges without being byte-inverse); a note with no
 * embeds exports byte-verbatim. The vault's stored blob is never
 * modified.
 *
 * `noteFilename` must be the bare final path component the OS save
 * dialog produced; `overwrite` governs the NOTE file only and carries
 * the dialog's "Replace" consent (SYNC-2).
 *
 * All-or-nothing: a missing/corrupt referenced attachment (or an
 * `overwrite=false` note-file collision) rejects with the destination
 * untouched.
 *
 * Resolves with the number of attachment files written. Rejects with a
 * `NoteExportAttachmentsError` (see `src/types/note-export-error.ts`).
 */
export async function noteExportAttachments(
  noteId: string,
  targetDir: string,
  noteFilename: string,
  overwrite: boolean,
): Promise<number> {
  return invoke<number>("plugin:notes|note_export_attachments", {
    noteId,
    targetDir,
    noteFilename,
    overwrite,
  });
}

/**
 * Write a standalone HTML projection of one note (note-export MYND-340)
 * — the no-attachments path. The `html` document is composed WebView-side
 * (`emitStandaloneHtml`, the PDF-export precedent: KaTeX/mermaid/highlight
 * need a real WebView) and written byte-for-byte to `targetPath` via the
 * canonical atomic helper. Deliberate user-initiated plaintext egress
 * across TB3 — `targetPath` must come from the OS save dialog
 * (`dialog:allow-save`); its "Replace" confirmation authorizes
 * `overwrite=true`.
 *
 * Rejects with a `NoteExportError` (the verbatim-write error surface;
 * note-decrypt variants are never produced on this string-write path).
 */
export async function noteExportHtml(
  html: string,
  targetPath: string,
  overwrite: boolean,
): Promise<void> {
  await invoke<void>("plugin:notes|note_export_html", {
    html,
    targetPath,
    overwrite,
  });
}

/**
 * Opt-in attachments-included HTML export (note-export MYND-340): write
 * the composed `html` document plus every image attachment it references
 * (`attachment://<id>`) as relative sidecar files into `targetDir` — the
 * `.html` as `noteFilename`, each image under its catalog display name
 * with deterministic `" (1)"`-style suffix-dedup on collision
 * (attachments NEVER overwrite). Each `attachment://<id>` `<img src>` in
 * the exported HTML is rewritten to its final relative filename (the
 * markdown-dialect §6 sanctioned export transform, HTML arm). The vault's
 * stored blob is never modified.
 *
 * `noteFilename` must be the bare final path component the OS save dialog
 * produced; `overwrite` governs the HTML file only (the dialog's
 * "Replace" consent, SYNC-2). All-or-nothing: a missing/corrupt
 * referenced attachment (or an `overwrite=false` HTML-file collision)
 * rejects with the destination untouched.
 *
 * Resolves with the number of sidecar files written. Rejects with a
 * `NoteExportAttachmentsError`.
 */
export async function noteExportHtmlAttachments(
  noteId: string,
  html: string,
  targetDir: string,
  noteFilename: string,
  overwrite: boolean,
): Promise<number> {
  return invoke<number>("plugin:notes|note_export_html_attachments", {
    noteId,
    html,
    targetDir,
    noteFilename,
    overwrite,
  });
}
