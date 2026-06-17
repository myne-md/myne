// Shared per-note export flows — markdown (MYND-116, `runNoteExportFlow`)
// and PDF (MYND-255, `runNotePdfExportFlow`) — each the single entry
// point both of its trigger surfaces call with zero divergence: the
// sidebar note-row context menu (NoteList.tsx) and the command-palette
// action (`note.export-markdown` / `note.export-pdf` → Editor.tsx
// handlers).
//
// Flow: pre-flight attachment scan (pure `extractAttachmentIds` over the
// note body; the modal question is asked through the caller-supplied
// `confirmAttachments` hook ONLY when the note references attachments —
// a note without them goes straight to the dialog) → OS save dialog
// (default filename derived from the note title; when the pre-flight
// modal did NOT show, the dialog's title carries the load-bearing
// egress sentence so it is still said once at the decision point) →
// either
// `note_export_as_markdown(id, path, overwrite=true)` or — attachments
// opted in — `note_export_attachments(id, dir, filename, overwrite=true)`.
// The dialog's "Replace" confirmation IS the overwrite consent (SYNC-2).
// Success → toast "Exported to <filename>" (basename only; the full path
// never reaches the toast TEXT — it rides `ExportToast.revealPath` for
// the "Show in folder" action instead) or a mapped plain-English error
// toast (`src/lib/note-export-errors.ts`). Modal cancel or dialog
// dismissed → silent no-op: backing out is free, nothing written,
// nothing shown.

import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  EXPORT_PDF_PLAIN_SENTENCE,
  EXPORT_PLAIN_HTML_SENTENCE,
  EXPORT_PLAIN_MARKDOWN_SENTENCE,
  EXPORT_PLAIN_TEXT_SENTENCE,
} from "../lib/load-bearing-copy";
import {
  noteExportAsMarkdown,
  noteExportAttachments,
  noteExportHtml,
  noteExportHtmlAttachments,
} from "./exportNote";
import { exportNotePdf } from "./exportPdf";
import { noteRead } from "./readNote";
import { extractAttachmentIds } from "./attachmentRef";
import {
  EXPORT_FALLBACK_MESSAGE,
  noteExportAttachmentsErrorMessage,
  noteExportErrorMessage,
  notePdfExportErrorMessage,
} from "../lib/note-export-errors";
import type {
  NoteExportAttachmentsError,
  NoteExportError,
} from "../types/note-export-error";
import type { PdfExportError } from "../types/pdf-export-error";
import {
  scanExcludedAttachments,
  scanImageAttachments,
  type ExcludedAttachment,
} from "../dialect/html/attachment-classification";
import type { ToastAction } from "../components/Toast";

/**
 * Default filename for the save dialog, derived from the note title the
 * UI already holds (sidebar `TitleRecord` / editor cache). Untitled
 * (null/empty) → `"Untitled.<ext>"`. The only sanitization is replacing
 * path separators (`/`, `\`) with `_` — the OS dialog owns everything
 * else. `ext` defaults to `"md"` (the markdown flow); the PDF flow
 * passes `"pdf"`.
 */
export function defaultExportFilename(
  title: string | null | undefined,
  ext: "md" | "pdf" | "html" | "txt" = "md",
): string {
  const trimmed = (title ?? "").trim();
  if (trimmed === "") return `Untitled.${ext}`;
  return `${trimmed.replace(/[/\\]/g, "_")}.${ext}`;
}

/** Final path component of `path` (both `/` and `\` separators) — the
 *  only slice of the destination that may appear in the success toast.
 *  The filename half of `splitExportPath` (one separator scanner). */
export function exportedBasename(path: string): string {
  return splitExportPath(path).filename;
}

/**
 * Split an OS-save-dialog path into the `targetDir` + bare `noteFilename`
 * pair `note_export_attachments` expects. The separator is kept only when
 * the parent IS a filesystem root (`/Note.md` → `/`, `C:\Note.md` →
 * `C:\`); otherwise it is dropped (`/a/b/Note.md` → `/a/b`).
 */
export function splitExportPath(path: string): {
  dir: string;
  filename: string;
} {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (cut === -1) return { dir: "", filename: path };
  const keepSeparator = cut === 0 || path[cut - 1] === ":";
  return {
    dir: path.slice(0, keepSeparator ? cut + 1 : cut),
    filename: path.slice(cut + 1),
  };
}

/** What the flow hands the toast sink. `revealPath` is present only on
 *  success and is NEVER rendered as text — the toast site turns it into
 *  the "Show in folder" action via `exportToastAction`. */
export interface ExportToast {
  message: string;
  revealPath?: string;
}

/** The user's answer to the pre-flight "Include N attachments" modal. */
export interface AttachmentPreflightChoice {
  includeAttachments: boolean;
}

/** The UI hooks the Editor supplies to both trigger surfaces (the
 *  context-menu path receives them as one threaded prop). */
export interface NoteExportUiHooks {
  /** Toast sink — both success and mapped-error copy go through it. */
  showToast: (toast: ExportToast) => void;
  /** Ask the "Include N attachments" question (count > 0 guaranteed).
   *  Resolves the user's choice, or `null` on cancel — a free exit. */
  confirmAttachments: (count: number) => Promise<AttachmentPreflightChoice | null>;
  /** PDF flow (MYND-255): show the pre-export exclusion notice for the
   *  attachments the projection cannot include (non-empty guaranteed).
   *  Resolves `true` to continue to the save dialog, `false` on cancel
   *  — a free exit. There is no toggle: exclusions aren't optional. */
  confirmPdfExclusions: (
    excluded: readonly ExcludedAttachment[],
  ) => Promise<boolean>;
}

export interface NoteExportFlowOptions {
  /** Canonical note id (lowercase-hyphenated v7 UUID string). */
  noteId: string;
  /** Note title as the caller knows it; null/empty → "Untitled.md". */
  noteTitle: string | null;
  /** Toast sink — both success and mapped-error copy go through it. */
  showToast: (toast: ExportToast) => void;
  /**
   * Pre-flight modal hook. Omitted → the attachment scan is skipped
   * entirely (no body read) and the export is note-only — the inert
   * degrade for isolated renders without the Editor's modal mount.
   */
  confirmAttachments?: (count: number) => Promise<AttachmentPreflightChoice | null>;
  /** Note-body provider for the attachment scan (default: the `note_read`
   *  IPC — the context-menu path has no body loaded). Read failure
   *  degrades to a note-only export; the export IPC surfaces the real
   *  error if one exists. */
  getBody?: (noteId: string) => Promise<string>;
}

/**
 * Compose the options both per-note flows take from a note row + the
 * Editor's UI hooks — the one builder all four trigger sites share
 * (sidebar context-menu + palette, markdown + PDF). Hooks may be absent
 * (isolated renders without the Editor's modal mount): the toast sink
 * degrades to inert once here, the modal hooks stay undefined (each
 * flow's documented degrade).
 */
export function noteExportOptions(
  noteId: string,
  noteTitle: string | null,
  hooks?: NoteExportUiHooks,
): NoteExportFlowOptions &
  NotePdfExportFlowOptions &
  NoteHtmlExportFlowOptions &
  NoteTxtExportFlowOptions {
  return {
    noteId,
    noteTitle,
    showToast: hooks?.showToast ?? (() => {}),
    confirmAttachments: hooks?.confirmAttachments,
    confirmPdfExclusions: hooks?.confirmPdfExclusions,
  };
}

/**
 * Run the per-note markdown export flow. Resolves after the toast is
 * shown (or immediately on modal cancel / dialog dismissal). Never
 * throws: every failure is mapped to copy and surfaced via `showToast`.
 */
export async function runNoteExportFlow({
  noteId,
  noteTitle,
  showToast,
  confirmAttachments,
  getBody = noteRead,
}: NoteExportFlowOptions): Promise<void> {
  // Pre-flight: only when a modal hook exists AND the body references
  // attachments. The scanner is pure (`extractAttachmentIds`); the only
  // IPC before the dialog is the body read, and cancel costs nothing.
  let includeAttachments = false;
  let egressSentenceShown = false;
  if (confirmAttachments !== undefined) {
    const body = await getBody(noteId).catch(() => null);
    const count = body === null ? 0 : extractAttachmentIds(body).length;
    if (count > 0) {
      // The pre-flight modal renders EXPORT_PLAIN_MARKDOWN_SENTENCE.
      egressSentenceShown = true;
      const choice = await confirmAttachments(count);
      if (choice === null) return; // cancelled — free exit, nothing invoked
      includeAttachments = choice.includeAttachments;
    }
  }

  const destination = await saveFileDialog({
    // The load-bearing egress sentence rides the save dialog's title on
    // the common no-modal path (SYNC-6: said once, at the decision
    // point); when the pre-flight modal already showed it, the title is
    // omitted so the sentence is never said twice. Desktop-only option —
    // exactly where this flow runs.
    ...(egressSentenceShown ? {} : { title: EXPORT_PLAIN_MARKDOWN_SENTENCE }),
    defaultPath: defaultExportFilename(noteTitle),
    filters: [{ name: "Markdown", extensions: ["md"] }],
  }).catch(() => null);
  if (typeof destination !== "string") return; // dismissed — silent no-op

  if (includeAttachments) {
    const { dir, filename } = splitExportPath(destination);
    try {
      // overwrite=true governs the NOTE file only (the OS dialog's
      // "Replace" prompt was the consent); attachments never overwrite —
      // the backend suffix-dedups them.
      const written = await noteExportAttachments(noteId, dir, filename, true);
      showToast({
        message:
          written === 0
            ? `Exported to ${filename}`
            : `Exported to ${filename} + ${written} attachment${written === 1 ? "" : "s"}`,
        revealPath: destination,
      });
    } catch (raw) {
      showToast({
        message:
          noteExportAttachmentsErrorMessage(raw as NoteExportAttachmentsError) ??
          EXPORT_FALLBACK_MESSAGE,
      });
    }
    return;
  }

  try {
    // overwrite=true: the OS dialog's "Replace" prompt was the consent.
    await noteExportAsMarkdown(noteId, destination, true);
    showToast({
      message: `Exported to ${exportedBasename(destination)}`,
      revealPath: destination,
    });
  } catch (raw) {
    // The notes plugin rejects with the closed NoteExportError enum; an
    // out-of-contract rejection shape falls back to the generic line.
    showToast({
      message:
        noteExportErrorMessage(raw as NoteExportError) ?? EXPORT_FALLBACK_MESSAGE,
    });
  }
}

export interface NotePdfExportFlowOptions {
  /** Canonical note id (lowercase-hyphenated v7 UUID string). */
  noteId: string;
  /** Note title as the caller knows it; null/empty → "Untitled.pdf". */
  noteTitle: string | null;
  /** Toast sink — both success and mapped-error copy go through it. */
  showToast: (toast: ExportToast) => void;
  /**
   * Pre-export exclusion-notice hook (called only when the projection
   * excluded attachments). Omitted → the notice is skipped and the
   * export proceeds — the inert degrade for isolated renders without
   * the Editor's modal mount (mirrors `confirmAttachments`).
   */
  confirmPdfExclusions?: (
    excluded: readonly ExcludedAttachment[],
  ) => Promise<boolean>;
  /** Note-body provider (default: the `note_read` IPC). Unlike the
   *  markdown flow there is no degrade: the body IS the export input,
   *  so a read failure ends the flow with an error toast. */
  getBody?: (noteId: string) => Promise<string>;
}

/**
 * Run the per-note PDF export flow (MYND-255) — the single entry point
 * both trigger surfaces call (sidebar context-menu "Export as PDF…" +
 * palette `note.export-pdf`), mirroring `runNoteExportFlow`'s shape.
 *
 * Flow: read the body → cheap exclusion scan (the emitter's own
 * classification via `attachment-classification.ts` — no heavy import)
 * → if the projection will exclude attachments (PDF / other non-image
 * embeds), show the pre-export notice (egress sentence + exclusion
 * sentence; cancel is a free exit) → OS save dialog (title-derived
 * `.pdf`; the "Replace" confirmation IS the overwrite consent, SYNC-2;
 * when the notice did NOT show, the dialog's title carries the egress
 * sentence so it is still said once at the decision point)
 * → ONLY NOW project the body to HTML via the dialect emitter
 * (lazy-imported — it pulls the heavy renderers, and it must run in the
 * MAIN window where KaTeX/mermaid have a real WebView; deferring it
 * means a dismissal costs nothing) → `pdf_export_render` with the
 * emitted html/title → success toast "Exported to <basename>" with
 * "Show in folder", or mapped `PdfExportError` copy. Never throws.
 */
export async function runNotePdfExportFlow({
  noteId,
  noteTitle,
  showToast,
  confirmPdfExclusions,
  getBody = noteRead,
}: NotePdfExportFlowOptions): Promise<void> {
  // Body read — surfaced with the markdown flow's read-failure line.
  let body: string;
  try {
    body = await getBody(noteId);
  } catch {
    showToast({ message: "This note could not be read." });
    return;
  }

  // Pre-export notice — BEFORE the dialog (and before any heavy work),
  // only when the projection will exclude something and a modal hook
  // exists. The scan shares the emitter's classification, so the listed
  // filenames match what the projection later reports.
  let egressSentenceShown = false;
  if (confirmPdfExclusions !== undefined) {
    const excluded = scanExcludedAttachments(body);
    if (excluded.length > 0) {
      // The notice renders EXPORT_PDF_PLAIN_SENTENCE.
      egressSentenceShown = true;
      const proceed = await confirmPdfExclusions(excluded);
      if (!proceed) return; // cancelled — free exit, nothing invoked
    }
  }

  const destination = await saveFileDialog({
    // Same SYNC-6 discipline as the markdown flow: the egress sentence
    // rides the dialog title on the common no-notice path, and is
    // omitted when the pre-export notice already said it.
    ...(egressSentenceShown ? {} : { title: EXPORT_PDF_PLAIN_SENTENCE }),
    defaultPath: defaultExportFilename(noteTitle, "pdf"),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  }).catch(() => null);
  if (typeof destination !== "string") return; // dismissed — silent no-op

  try {
    // Projection only after the destination is confirmed. `emitNoteHtml`
    // never throws on note content (renderer failures degrade
    // internally); a chunk-load failure lands in the generic fallback.
    const { emitNoteHtml } = await import("../dialect/html/emitNoteHtml");
    const emitted = await emitNoteHtml(body);
    // overwrite=true: the OS dialog's "Replace" prompt was the consent.
    // The emitted title (frontmatter `title:`) feeds the PDF metadata.
    await exportNotePdf(emitted.html, emitted.title, destination, true);
    showToast({
      message: `Exported to ${exportedBasename(destination)}`,
      revealPath: destination,
    });
  } catch (raw) {
    // The pdf-export plugin rejects with the closed PdfExportError enum;
    // an out-of-contract rejection shape falls back to the generic line.
    showToast({
      message:
        notePdfExportErrorMessage(raw as PdfExportError) ??
        EXPORT_FALLBACK_MESSAGE,
    });
  }
}

export interface NoteHtmlExportFlowOptions {
  /** Canonical note id (lowercase-hyphenated v7 UUID string). */
  noteId: string;
  /** Note title as the caller knows it; null/empty → "Untitled.html". */
  noteTitle: string | null;
  /** Toast sink — both success and mapped-error copy go through it. */
  showToast: (toast: ExportToast) => void;
  /**
   * Pre-flight modal hook (the SAME hook the markdown flow uses). Omitted
   * → the image-attachment scan is skipped and the export is HTML-only
   * (images as in-app-only `attachment://` refs) — the inert degrade for
   * isolated renders without the Editor's modal mount.
   */
  confirmAttachments?: (count: number) => Promise<AttachmentPreflightChoice | null>;
  /** Note-body provider (default: the `note_read` IPC). The body is the
   *  HTML projection input, so a read failure ends the flow with an error
   *  toast (no degrade — mirrors the PDF flow). */
  getBody?: (noteId: string) => Promise<string>;
}

/**
 * Run the per-note HTML export flow (note-export MYND-340) — the single
 * entry point both trigger surfaces call (sidebar context-menu "Export as
 * HTML…" + palette `note.export-html`), mirroring `runNoteExportFlow` /
 * `runNotePdfExportFlow`.
 *
 * Flow: read the body → cheap image-attachment scan
 * (`scanImageAttachments` — no emitter import) → if the note references
 * images AND a modal hook exists, ask the "Include N images" question
 * (the egress sentence rides the modal; cancel is a free exit) → OS save
 * dialog (`.html`; the "Replace" confirmation IS the overwrite consent,
 * SYNC-2; when the modal did NOT show, the dialog title carries the
 * egress sentence so it is said once, SYNC-6) → ONLY NOW compose the
 * standalone HTML via the dialect assembler (lazy-imported — it pulls the
 * heavy renderers and must run in the MAIN window) → either
 * `note_export_html` (no images / opted out) or `note_export_html_attachments`
 * (images opted in → sidecar files + relative refs) → success toast or
 * mapped error copy. Never throws.
 */
export async function runNoteHtmlExportFlow({
  noteId,
  noteTitle,
  showToast,
  confirmAttachments,
  getBody = noteRead,
}: NoteHtmlExportFlowOptions): Promise<void> {
  let body: string;
  try {
    body = await getBody(noteId);
  } catch {
    showToast({ message: "This note could not be read." });
    return;
  }

  // Pre-flight: only when a modal hook exists AND the body references
  // image attachments (the sidecar set). The scan is pure + cheap.
  let includeAttachments = false;
  let egressSentenceShown = false;
  if (confirmAttachments !== undefined) {
    const count = scanImageAttachments(body).length;
    if (count > 0) {
      // The pre-flight modal renders EXPORT_PLAIN_HTML_SENTENCE.
      egressSentenceShown = true;
      const choice = await confirmAttachments(count);
      if (choice === null) return; // cancelled — free exit, nothing invoked
      includeAttachments = choice.includeAttachments;
    }
  }

  const destination = await saveFileDialog({
    ...(egressSentenceShown ? {} : { title: EXPORT_PLAIN_HTML_SENTENCE }),
    defaultPath: defaultExportFilename(noteTitle, "html"),
    filters: [{ name: "HTML", extensions: ["html"] }],
  }).catch(() => null);
  if (typeof destination !== "string") return; // dismissed — silent no-op

  let document: string;
  try {
    // Projection only after the destination is confirmed — a dismissal
    // costs nothing. `emitStandaloneHtml` never throws on note content.
    const { emitStandaloneHtml } = await import("../dialect/html/htmlDocument");
    const composed = await emitStandaloneHtml(body, {
      locale:
        typeof navigator !== "undefined" ? navigator.language : "en-US",
    });
    document = composed.document;
  } catch {
    showToast({ message: EXPORT_FALLBACK_MESSAGE });
    return;
  }

  if (includeAttachments) {
    const { dir, filename } = splitExportPath(destination);
    try {
      const written = await noteExportHtmlAttachments(
        noteId,
        document,
        dir,
        filename,
        true,
      );
      showToast({
        message:
          written === 0
            ? `Exported to ${filename}`
            : `Exported to ${filename} + ${written} image${written === 1 ? "" : "s"}`,
        revealPath: destination,
      });
    } catch (raw) {
      showToast({
        message:
          noteExportAttachmentsErrorMessage(raw as NoteExportAttachmentsError) ??
          EXPORT_FALLBACK_MESSAGE,
      });
    }
    return;
  }

  try {
    // overwrite=true: the OS dialog's "Replace" prompt was the consent.
    await noteExportHtml(document, destination, true);
    showToast({
      message: `Exported to ${exportedBasename(destination)}`,
      revealPath: destination,
    });
  } catch (raw) {
    showToast({
      message:
        noteExportErrorMessage(raw as NoteExportError) ?? EXPORT_FALLBACK_MESSAGE,
    });
  }
}

export interface NoteTxtExportFlowOptions {
  /** Canonical note id (lowercase-hyphenated v7 UUID string). */
  noteId: string;
  /** Note title as the caller knows it; null/empty → "Untitled.txt". */
  noteTitle: string | null;
  /** Toast sink — both success and mapped-error copy go through it. */
  showToast: (toast: ExportToast) => void;
  /** Note-body provider (default: the `note_read` IPC). The body is the
   *  text projection input, so a read failure ends the flow with an error
   *  toast. */
  getBody?: (noteId: string) => Promise<string>;
}

/**
 * Run the per-note plain-text export flow (note-export MYND-340) — the
 * single entry point both trigger surfaces call (sidebar context-menu
 * "Export as Plain Text…" + palette `note.export-txt`).
 *
 * Flow: read the body → OS save dialog (`.txt`; the egress sentence rides
 * the dialog title, SYNC-6; "Replace" IS the overwrite consent, SYNC-2) →
 * project to stripped plain text via the dialect emitter (`emitNoteText`
 * — pure, no attachments, no sidecars) → write via `note_export_html`
 * (the shared verbatim text-write command) → success toast or mapped
 * error copy. The TXT projection never includes attachments, so there is
 * no pre-flight modal. Never throws.
 */
export async function runNoteTxtExportFlow({
  noteId,
  noteTitle,
  showToast,
  getBody = noteRead,
}: NoteTxtExportFlowOptions): Promise<void> {
  let body: string;
  try {
    body = await getBody(noteId);
  } catch {
    showToast({ message: "This note could not be read." });
    return;
  }

  const destination = await saveFileDialog({
    // The egress sentence always rides the dialog title here — TXT has no
    // pre-flight modal (no attachments), so this is the single decision
    // point (SYNC-6).
    title: EXPORT_PLAIN_TEXT_SENTENCE,
    defaultPath: defaultExportFilename(noteTitle, "txt"),
    filters: [{ name: "Plain text", extensions: ["txt"] }],
  }).catch(() => null);
  if (typeof destination !== "string") return; // dismissed — silent no-op

  let text: string;
  try {
    const { emitNoteText } = await import("../dialect/text/emitNoteText");
    // A trailing newline so the file is a well-formed POSIX text file.
    text = `${emitNoteText(body)}\n`;
  } catch {
    showToast({ message: EXPORT_FALLBACK_MESSAGE });
    return;
  }

  try {
    // overwrite=true: the OS dialog's "Replace" prompt was the consent.
    // Reuses the shared `note_export_html` text-write command (it writes
    // any composed text document verbatim — not HTML-specific).
    await noteExportHtml(text, destination, true);
    showToast({
      message: `Exported to ${exportedBasename(destination)}`,
      revealPath: destination,
    });
  } catch (raw) {
    showToast({
      message:
        noteExportErrorMessage(raw as NoteExportError) ?? EXPORT_FALLBACK_MESSAGE,
    });
  }
}

/**
 * Build the success toast's "Show in folder" action from an
 * `ExportToast` (MYND-116 task 4). Returns `undefined` when the toast
 * carries no `revealPath` (error toasts). The action reveals the
 * exported file via the opener plugin (`opener:allow-reveal-item-in-dir`
 * in the capability ACL) and dismisses the toast; reveal failure is
 * swallowed — the export itself already succeeded.
 */
export function exportToastAction(
  toast: ExportToast,
  dismiss: () => void,
): ToastAction | undefined {
  const path = toast.revealPath;
  if (path === undefined) return undefined;
  return {
    label: "Show in folder",
    onAction: () => {
      void revealItemInDir(path).catch(() => {});
      dismiss();
    },
  };
}
