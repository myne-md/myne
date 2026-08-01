// Why an import stopped, or why one file did not come across.
//
// The importer's read seam rejects with the SERIALIZED Rust error struct, not
// an `Error` — `src/platform/core.ts` re-exports Tauri's `invoke` verbatim and
// the web Worker host rejects with the backend's own value for the same reason.
// So `err instanceof Error ? err.message : <generic>` always takes the generic
// branch on a real failure, and the import error screen used to render the
// literal string "Import failed." underneath a header already reading "Import
// failed" (myne-md/myne#223).
//
// Two consumers with different needs, hence two functions: the engine wants a
// stable REASON CODE to record per file, and the UI wants an i18n key to
// render. Per `src/CLAUDE.md`, the key is returned and resolved at the call
// site — never a `t()` frozen at module level, which would capture the boot
// language.

import { ioKindOf } from "./storage-pressure";
import { isImportReadError } from "../types/import-read-error";

/**
 * Why one file, or one whole import, failed. Closed set: a reason maps 1:1 to
 * a user-facing sentence, so an unmapped shape lands on `unknown` rather than
 * putting a raw error object in front of the user.
 */
export type ImportFailureReason =
  /** Not valid UTF-8 — a legacy-encoded file, or not text at all. */
  | "not-utf8"
  /** Refused by the read seam: outside the picked folder, or unreadable. */
  | "path-rejected"
  | "permission-denied"
  | "not-found"
  | "no-space"
  | "unknown";

/** Classify an arbitrary rejection from the import path. Never throws. */
export function importFailureReason(error: unknown): ImportFailureReason {
  if (isImportReadError(error)) {
    if (error.kind === "NotUtf8") return "not-utf8";
    if (error.kind === "PathRejected") return "path-rejected";
  }
  switch (ioKindOf(error)) {
    case "PermissionDenied":
      return "permission-denied";
    case "NotFound":
      return "not-found";
    case "NoSpace":
      return "no-space";
    default:
      return "unknown";
  }
}

/**
 * The i18n key describing a reason. Resolve with `t()` at the render site.
 *
 * Exhaustive over {@link ImportFailureReason} with a `never` default, so a new
 * reason cannot ship without its sentence.
 */
export function importFailureReasonKey(reason: ImportFailureReason): string {
  switch (reason) {
    case "not-utf8":
      return "notes.import.modal.reasonNotUtf8";
    case "path-rejected":
      return "notes.import.modal.reasonPathRejected";
    case "permission-denied":
      return "notes.import.modal.reasonPermissionDenied";
    case "not-found":
      return "notes.import.modal.reasonNotFound";
    case "no-space":
      return "notes.import.modal.reasonNoSpace";
    case "unknown":
      return "notes.import.modal.reasonUnknown";
    default: {
      const exhaustive: never = reason;
      return exhaustive;
    }
  }
}
