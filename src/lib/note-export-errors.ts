// Per-note export closed-enum → user-facing copy mapping (MYND-116;
// backup-errors.ts is the convention precedent).
//
// Honest copy discipline: strings stay inside threat-model §7 — plain
// statements of what happened, no "tamper-proof"/"safe forever". The enum
// is closed on the Rust side (`core/src/plugins/notes/error.rs`); the
// exhaustive switch makes a new variant a compile error here, and
// `tests/notes/exportFlow.test.ts` pins non-empty, pairwise-distinct copy
// per variant at runtime.

import i18n from "../i18n";
import type {
  NoteExportAttachmentsError,
  NoteExportError,
} from "../types/note-export-error";
import type { PdfExportError } from "../types/pdf-export-error";
import type { IoFailureKind } from "../types/vault-unlock-error";

// Shared sentences — one export vocabulary across the markdown /
// attachments / PDF / vault tables (each table's switch stays exhaustive;
// only the copy is single-sourced here). Resolved through i18n at CALL
// time (functions, not module-scope constants) so a language switch is
// reflected — a frozen `const i18n.t(...)` would capture the boot locale.

export function exportDestinationUnusableMessage(): string {
  return i18n.t("export.note.errors.destinationUnusable");
}
export function exportTargetExistsMessage(): string {
  return i18n.t("export.note.errors.targetExists");
}
/** Out-of-contract rejection shapes (and JoinFailure) fall back to this
 *  generic line in both per-note flows. */
export function exportFallbackMessage(): string {
  return i18n.t("export.note.errors.fallback");
}

/** `Io` variant → copy, shared by every export error table. The space /
 *  permission sentences are common; the residual write line differs per
 *  flow (`fallback`). */
export function ioWriteErrorMessage(
  kind: IoFailureKind,
  fallback: string = i18n.t("export.note.errors.ioWriteDefault"),
): string {
  return kind === "NoSpace"
    ? i18n.t("export.note.errors.ioNoSpace")
    : kind === "PermissionDenied"
      ? i18n.t("export.note.errors.ioPermissionDenied")
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
      return i18n.t("export.note.errors.vaultLocked");
    case "InvalidNoteId":
      // Bug-canary on the Rust side — the UI should never produce a
      // malformed id. Surfaced as a generic failure, nothing was written.
      return i18n.t("export.note.errors.invalidNoteId");
    case "NoteNotFound":
      // Normal user-flow outcome: the note was deleted between the
      // context-menu open and the dialog confirm.
      return i18n.t("export.note.errors.noteNotFound");
    case "CannotDecrypt":
      // Deterministic fail (protocol.md §6.4 non-distinguishing) — no
      // "try again" CTA.
      return i18n.t("export.note.errors.cannotDecrypt");
    case "InvalidPlaintextEncoding":
      return i18n.t("export.note.errors.invalidPlaintextEncoding");
    case "InvalidDestination":
      return exportDestinationUnusableMessage();
    case "TargetAlreadyExists":
      // Only reachable with overwrite=false — the context-menu/palette flow
      // passes overwrite=true (the OS Replace prompt is the consent).
      return exportTargetExistsMessage();
    case "Io":
      return ioWriteErrorMessage(e.detail.io_error_kind);
    case "JoinFailure":
      return exportFallbackMessage();
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
      return i18n.t("export.note.errors.invalidNoteFilename");
    case "InvalidVaultMeta":
      return i18n.t("export.note.errors.invalidAttachmentCatalog");
    case "AttachmentMissing":
      return i18n.t("export.note.errors.attachmentMissing");
    case "AttachmentCorrupt":
      return i18n.t("export.note.errors.attachmentCorrupt");
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
      return i18n.t("export.note.errors.pdfExportInProgress");
    case "InvalidDestination":
      return exportDestinationUnusableMessage();
    case "TargetAlreadyExists":
      // Only reachable with overwrite=false — the flow passes
      // overwrite=true (the OS Replace prompt is the consent).
      return exportTargetExistsMessage();
    case "WindowCreateFailed":
      return i18n.t("export.note.errors.pdfWindowCreateFailed");
    case "RenderTimeout":
      return i18n.t("export.note.errors.pdfRenderTimeout");
    case "PayloadMissing":
      // Lock-during-export lands here (teardown cancels the session).
      return i18n.t("export.note.errors.pdfPayloadMissing");
    case "CaptureFailed":
      return i18n.t("export.note.errors.pdfCaptureFailed");
    case "Io":
      return ioWriteErrorMessage(e.detail.io_error_kind);
    case "JoinFailure":
      return exportFallbackMessage();
  }
}
