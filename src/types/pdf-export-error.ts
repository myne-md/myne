// TODO(Phase-1-end): Replace this hand-written file with a `ts-rs`
// auto-generated artifact + a CI drift check. The Rust types live in:
//   - core/src/io_failure_kind.rs                       (IoFailureKind)
//   - src-tauri/src/plugins/pdf_export/error.rs         (PdfExportError)

import type { IoFailureKind } from "./vault-unlock-error";

/**
 * Closed failure classes for the per-OS native print-to-PDF capture arm
 * — mirror of `pdf_export::error::CaptureFailureKind`. Bounded and
 * DENY-list-safe by construction: native error payloads (NSError /
 * GError / HRESULT) never cross IPC; they collapse into these names.
 */
export type PdfCaptureFailureKind =
  /** The main-thread dispatch failed (event loop gone — shutdown race). */
  | "Dispatch"
  /**
   * The capture completion channel closed without a result (native arm
   * panicked, or the window was destroyed mid-capture — e.g. a lock
   * teardown).
   */
  | "ChannelClosed"
  /** The native print operation missed the capture deadline. */
  | "Timeout"
  /** The native print API reported failure. */
  | "NativePrintFailed"
  /**
   * The native print API claimed success but the output is absent,
   * empty, or not a `%PDF` document.
   */
  | "OutputMissing"
  /**
   * No native capture arm exists for this platform, or the platform
   * WebView lacks the required API (Windows: pre-PrintToPdf runtime).
   */
  | "Unsupported";

/**
 * Single error type returned across the IPC boundary by the
 * `pdf-export` Tauri plugin's commands (MYND-255).
 *
 * Wire shape: `#[serde(tag = "kind", content = "detail")]` — payload-
 * carrying variants nest as `{"kind": "<Outer>", "detail": <inner>}`;
 * unit variants serialize as `{"kind": "<VariantName>"}` only.
 *
 * Variant set is closed; adding a variant is an IPC contract change
 * that requires updating both the Rust enum and this mirror in the
 * same change.
 *
 * **No `VaultNotUnlocked` variant, deliberately** — the render command
 * receives already-emitted HTML from the main window (no decrypt
 * happens Rust-side); a lock mid-export surfaces as `PayloadMissing`
 * via the teardown cancellation.
 */
export type PdfExportError =
  /**
   * A PDF export is already in flight (single-slot session). The UI
   * serializes exports, so this is a double-trigger bug-canary.
   */
  | { kind: "ExportInProgress" }
  /**
   * The chosen destination is not usable: its parent directory does
   * not exist / is not a directory, or the target itself is a
   * directory. The OS save dialog normally guarantees a valid parent;
   * this fires when it vanished between confirm and write.
   */
  | { kind: "InvalidDestination" }
  /**
   * `overwrite=false` and a file already exists at the target path.
   * The existing file is untouched. Re-invoke with `overwrite=true`
   * only with the user's explicit "Replace" consent from the OS save
   * dialog (SYNC-2).
   */
  | { kind: "TargetAlreadyExists" }
  /** The hidden `pdf-export` WebviewWindow could not be created. */
  | { kind: "WindowCreateFailed" }
  /**
   * The hidden window never signalled readiness within the deadline —
   * renderer hang, asset-load stall, or a page-side script failure.
   * The window is destroyed; nothing was written.
   */
  | { kind: "RenderTimeout" }
  /**
   * No staged payload exists for the session: a stale hidden window
   * asked for it, or a lock-teardown cleared it mid-flight (the lock-
   * during-export outcome — re-unlock and retry).
   */
  | { kind: "PayloadMissing" }
  /**
   * The native print-to-PDF capture failed; the closed
   * `PdfCaptureFailureKind` names the failure class.
   */
  | {
      kind: "CaptureFailed";
      detail: { capture_failure_kind: PdfCaptureFailureKind };
    }
  /**
   * Residual file-system IO failure (capture-output read or the
   * destination write). `AlreadyExists` on the destination write is
   * special-cased upstream as `TargetAlreadyExists`.
   */
  | { kind: "Io"; detail: { io_error_kind: IoFailureKind } }
  /**
   * `tokio::task::spawn_blocking` join handle returned an error.
   * User-facing CTA is "try again".
   */
  | { kind: "JoinFailure" };

/** Type-narrowing helper for the `CaptureFailed` variant. */
export function isPdfCaptureError(e: PdfExportError): e is {
  kind: "CaptureFailed";
  detail: { capture_failure_kind: PdfCaptureFailureKind };
} {
  return e.kind === "CaptureFailed";
}

/** Type-narrowing helper for the `Io` variant. */
export function isPdfExportIoError(
  e: PdfExportError,
): e is { kind: "Io"; detail: { io_error_kind: IoFailureKind } } {
  return e.kind === "Io";
}
