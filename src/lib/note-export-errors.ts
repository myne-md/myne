// Per-note export closed-enum → user-facing copy mapping (MYND-116;
// backup-errors.ts is the convention precedent).
//
// Honest copy discipline: strings stay inside threat-model §7 — plain
// statements of what happened, no "tamper-proof"/"safe forever". The enum
// is closed on the Rust side (`src-tauri/src/plugins/notes/error.rs`); the
// exhaustive switch makes a new variant a compile error here, and
// `tests/notes/exportFlow.test.ts` pins non-empty, pairwise-distinct copy
// per variant at runtime.

import type {
  NoteExportAttachmentsError,
  NoteExportError,
} from "../types/note-export-error";
import type { PdfExportError } from "../types/pdf-export-error";
import type { IoFailureKind } from "../types/vault-unlock-error";

// Shared sentences — one export vocabulary across the markdown /
// attachments / PDF / vault tables (each table's switch stays exhaustive;
// only the copy is single-sourced here).

export const EXPORT_DESTINATION_UNUSABLE_MESSAGE =
  "That destination folder is not usable.";
export const EXPORT_TARGET_EXISTS_MESSAGE =
  "A file with that name already exists at the destination.";
/** Out-of-contract rejection shapes (and JoinFailure) fall back to this
 *  generic line in both per-note flows. */
export const EXPORT_FALLBACK_MESSAGE = "Export failed unexpectedly. Try again.";

/** `Io` variant → copy, shared by every export error table. The space /
 *  permission sentences are common; the residual write line differs per
 *  flow (`fallback`). */
export function ioWriteErrorMessage(
  kind: IoFailureKind,
  fallback = "Could not write the exported file.",
): string {
  return kind === "NoSpace"
    ? "Not enough space at the destination."
    : kind === "PermissionDenied"
      ? "No permission to write at the destination."
      : fallback;
}

/** `note_export_as_markdown` failure → toast copy (the shared export flow
 *  in `src/notes/exportFlow.ts` renders it). Hardcoded English (v1).
 *  The `e?.kind` access is deliberate: a null/undefined out-of-contract
 *  rejection must fall off the switch (→ the caller's `??` fallback),
 *  never throw inside the flow's catch (the never-throws contract). */
export function noteExportErrorMessage(e: NoteExportError): string {
  switch (e?.kind) {
    case "VaultNotUnlocked":
      return "The vault is locked. Unlock it, then try again.";
    case "InvalidNoteId":
      // Bug-canary on the Rust side — the UI should never produce a
      // malformed id. Surfaced as a generic failure, nothing was written.
      return "This note could not be identified, so nothing was exported.";
    case "NoteNotFound":
      // Normal user-flow outcome: the note was deleted between the
      // context-menu open and the dialog confirm.
      return "This note no longer exists — it may have been deleted.";
    case "CannotDecrypt":
      // Deterministic fail (protocol.md §6.4 non-distinguishing) — no
      // "try again" CTA.
      return "This note could not be read.";
    case "InvalidPlaintextEncoding":
      return "This note's content looks damaged, so nothing was exported. Restore it from a backup.";
    case "InvalidDestination":
      return EXPORT_DESTINATION_UNUSABLE_MESSAGE;
    case "TargetAlreadyExists":
      // Only reachable with overwrite=false — the context-menu/palette flow
      // passes overwrite=true (the OS Replace prompt is the consent).
      return EXPORT_TARGET_EXISTS_MESSAGE;
    case "Io":
      return ioWriteErrorMessage(e.detail.io_error_kind);
    case "JoinFailure":
      return EXPORT_FALLBACK_MESSAGE;
  }
}

/** `note_export_attachments` failure → toast copy (the attachments-
 *  included branch of the shared export flow). The variants shared with
 *  `NoteExportError` reuse its copy verbatim — the user sees one export
 *  vocabulary regardless of branch; only the attachments-specific
 *  variants get their own lines. All-or-nothing contract: every
 *  attachments-specific failure left the destination untouched. */
export function noteExportAttachmentsErrorMessage(
  e: NoteExportAttachmentsError,
): string {
  switch (e?.kind) {
    case "InvalidNoteFilename":
      // Bug-canary — the UI passes the OS dialog's final path component
      // verbatim; surfaced as a generic failure, nothing was written.
      return "That file name is not usable, so nothing was exported.";
    case "InvalidVaultMeta":
      return "The vault's attachment catalog could not be read, so nothing was exported.";
    case "AttachmentMissing":
      return "An attachment referenced by this note is missing, so nothing was exported.";
    case "AttachmentCorrupt":
      return "An attachment referenced by this note could not be read, so nothing was exported.";
    default:
      // Every remaining variant is shape-identical to its NoteExportError
      // twin — delegating keeps the copy single-sourced, and a future
      // attachments-only variant fails this assignment at compile time.
      return noteExportErrorMessage(e);
  }
}

/** `pdf_export_render` failure → toast copy (the PDF branch of the
 *  shared export flow, MYND-255). The destination/IO variants reuse the
 *  markdown export's copy verbatim — one export vocabulary regardless
 *  of format; only the pipeline-specific variants get their own lines.
 *  The closed `CaptureFailureKind` deliberately collapses into one
 *  sentence: the kinds exist for DENY-list-safe logging, not for the
 *  user (none of them is actionable differently). */
export function notePdfExportErrorMessage(e: PdfExportError): string {
  switch (e?.kind) {
    case "ExportInProgress":
      // Bug-canary (the UI serializes exports), but still honest copy.
      return "A PDF export is already running. Wait for it to finish, then try again.";
    case "InvalidDestination":
      return EXPORT_DESTINATION_UNUSABLE_MESSAGE;
    case "TargetAlreadyExists":
      // Only reachable with overwrite=false — the flow passes
      // overwrite=true (the OS Replace prompt is the consent).
      return EXPORT_TARGET_EXISTS_MESSAGE;
    case "WindowCreateFailed":
      return "The export window could not be opened, so nothing was exported.";
    case "RenderTimeout":
      return "The note took too long to render, so nothing was exported.";
    case "PayloadMissing":
      // Lock-during-export lands here (teardown cancels the session).
      return "The export was interrupted — if the vault locked, unlock it and try again.";
    case "CaptureFailed":
      return "The PDF could not be generated, so nothing was exported.";
    case "Io":
      return ioWriteErrorMessage(e.detail.io_error_kind);
    case "JoinFailure":
      return EXPORT_FALLBACK_MESSAGE;
  }
}
