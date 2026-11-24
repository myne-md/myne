// SPDX-License-Identifier: AGPL-3.0-only
//! Closed error enum for the `pdf-export` plugin (MYND-255 task 4).
//!
//! Hand-mirrored on the TS side at `src/types/pdf-export-error.ts` —
//! adding a variant is an IPC contract change requiring both sides in
//! the same change (the `NoteExportError` precedent,
//! `src-tauri/src/plugins/notes/error.rs`).
//!
//! **No `VaultNotUnlocked` variant, deliberately.** The render command
//! receives the already-emitted HTML from the main window's JS (the
//! plaintext already lives in that WebView — accepted TB2/A7 posture);
//! there is no decrypt here, so a vault gate would be structurally
//! dead. The lock-lockstep guarantee rides [`PayloadMissing`] instead:
//! every lock-teardown path clears the stashed payload and cancels the
//! in-flight wait, so a lock mid-export surfaces as `PayloadMissing`
//! and the hidden window is destroyed alongside "main".

use crate::io_failure_kind::IoFailureKind;
use serde::Serialize;
use thiserror::Error;

/// Single error type returned across the IPC boundary by the
/// `pdf-export` plugin's commands.
///
/// Wire shape matches the project convention (`tag = "kind"`,
/// `content = "detail"`): unit variants serialize as
/// `{"kind": "<Name>"}`, payload variants nest under `"detail"`.
#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum PdfExportError {
    /// A PDF export is already in flight. The payload stash is a
    /// single-slot session (one hidden window label, one capture at a
    /// time); the UI serializes exports, so this is a bug-canary
    /// against double-trigger regressions.
    #[error("a pdf export is already in flight")]
    ExportInProgress,

    /// The user-chosen `target_path` is not usable: its parent
    /// directory does not exist / is not a directory, or the target
    /// itself is a directory (the `NoteExportError::InvalidDestination`
    /// precedent). The OS save dialog normally guarantees a valid
    /// parent; this fires when it vanished between confirm and write.
    #[error("invalid destination")]
    InvalidDestination,

    /// `overwrite=false` and a file already exists at the target path.
    /// The existing file is untouched. Re-invoke with `overwrite=true`
    /// only with the user's explicit "Replace" consent from the OS
    /// save dialog (SYNC-2).
    #[error("target already exists")]
    TargetAlreadyExists,

    /// The hidden `pdf-export` WebviewWindow could not be created.
    #[error("hidden export window could not be created")]
    WindowCreateFailed,

    /// The hidden window did not signal readiness (`pdf_export_ready`)
    /// within the deadline — renderer hang, asset-load stall, or a
    /// page-side script failure. The window is destroyed; nothing was
    /// written.
    #[error("hidden window did not become ready within the deadline")]
    RenderTimeout,

    /// No stashed payload exists for this session. Surfaces in two
    /// places: the hidden page invoked `pdf_export_payload` with no
    /// active session (stale window), or a lock-teardown path cleared
    /// the payload mid-flight (lock during export — the in-flight
    /// render command observes the cancellation and rejects).
    #[error("no pdf payload is staged")]
    PayloadMissing,

    /// The native print-to-PDF capture failed; the closed
    /// [`CaptureFailureKind`] names the failure class without leaking
    /// platform error strings (DENY-list discipline).
    #[error("native print-to-pdf capture failed")]
    CaptureFailed {
        capture_failure_kind: CaptureFailureKind,
    },

    /// Residual file-system IO failure (capture-output read or the
    /// destination write). `AlreadyExists` on the destination write is
    /// special-cased upstream as [`Self::TargetAlreadyExists`].
    #[error("io failure")]
    Io { io_error_kind: IoFailureKind },

    /// `tokio::task::spawn_blocking` join handle returned an error.
    #[error("worker join failure")]
    JoinFailure,
}

/// Closed failure classes for the per-OS native capture arm. Bounded
/// and DENY-list-safe by construction — native error payloads
/// (NSError descriptions, GError messages, HRESULTs) never cross IPC
/// or logs; they collapse into these variants.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum CaptureFailureKind {
    /// `with_webview` could not dispatch the closure to the main
    /// thread (event loop gone — app shutdown race).
    Dispatch,
    /// The capture completion channel closed without a result (the
    /// native arm panicked or the window was destroyed mid-capture,
    /// e.g. by a lock teardown).
    ChannelClosed,
    /// The native print operation did not complete within the capture
    /// deadline.
    Timeout,
    /// The native print API reported failure.
    NativePrintFailed,
    /// The native print API reported success but the capture temp
    /// file is absent, empty, or not a `%PDF` document.
    OutputMissing,
    /// No native capture arm exists for this platform (non-desktop
    /// target), or the platform WebView lacks the required API.
    // Constructed only by the Windows arm (ICoreWebView2_7 cast
    // failure on an old runtime) and the non-desktop fallback arm in
    // `capture.rs`; on macOS/Linux it exists solely as the closed wire
    // contract mirrored by `src/types/pdf-export-error.ts` (the same
    // cross-platform-enum posture as `capture.rs::OnDone`).
    #[cfg_attr(any(target_os = "macos", target_os = "linux"), allow(dead_code))]
    Unsupported,
}

impl From<std::io::Error> for PdfExportError {
    fn from(e: std::io::Error) -> Self {
        // `AlreadyExists` (destination write) is special-cased by the
        // calling command (mapped to `TargetAlreadyExists`); this
        // `From` handles residual unclassified `io::Error`s.
        PdfExportError::Io {
            io_error_kind: crate::io_failure_kind::from_io_error_kind(e.kind()),
        }
    }
}
