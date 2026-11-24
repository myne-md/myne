// SPDX-License-Identifier: AGPL-3.0-only
//! `pdf-export` plugin commands (MYND-255 task 4).
//!
//! Pipeline (one in-flight session at a time; see `state.rs`):
//!
//! 1. The MAIN window's JS emits the note's HTML projection
//!    (`src/dialect/html/emitNoteHtml.ts` — KaTeX/mermaid/highlight
//!    need a real WebView anyway, and the plaintext already lives in
//!    that WebView) and invokes [`pdf_export_render`] with the emitted
//!    HTML + the user-chosen destination.
//! 2. The command stashes the payload, creates the hidden
//!    `pdf-export` WebviewWindow (`visible: false`,
//!    `set_content_protected` applied before any frame could exist —
//!    the `screen_capture::init` first-frame discipline), which loads
//!    the bundled `pdf-export.html` page.
//! 3. The hidden page fetches the payload via [`pdf_export_payload`],
//!    injects it, waits for fonts/images/layout to settle, and signals
//!    [`pdf_export_ready`]. Both page-seat commands are granted ONLY
//!    to the `pdf-export` window by `capabilities/pdf-export.json`.
//! 4. The command drives the native print-to-PDF arm (`capture.rs`)
//!    to a `.capture-tmp` sibling of the destination, verifies `%PDF`
//!    magic, and publishes via the canonical `atomic_write` honoring
//!    the explicit overwrite consent (SYNC-2).
//! 5. Window destroyed + payload wiped on EVERY exit path; the five
//!    lock-teardown sites additionally call [`super::teardown_on_lock`]
//!    so a lock mid-export tears the surface down in lockstep with
//!    "main".
//!
//! TB3 egress: the produced PDF is deliberate, user-initiated
//! plaintext leaving the vault — same posture as the `.md` exports
//! (SYNC-4 spec package). The capture temp sibling lives at the
//! user-chosen destination, never inside the vault
//! (`src-tauri/AGENTS.md` "Atomic file writes", 2026-06-11 amendment).
//!
//! Logging: see `src-tauri/AGENTS.md` "Secret-handling logging
//! discipline" — stage tags + closed error kinds + coarse duration
//! only; never the HTML payload, the note title, or any path.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State, WebviewUrl, WebviewWindowBuilder};
use zeroize::Zeroizing;

use super::error::{CaptureFailureKind, PdfExportError};
use super::state::{PdfExportState, WaitOutcome};
use crate::io_failure_kind::from_io_error_kind;

/// Label of the hidden render window. Lock-stepped with
/// `capabilities/pdf-export.json` (`"windows": ["pdf-export"]`) — the
/// near-empty capability binds to this label.
pub const PDF_EXPORT_WINDOW_LABEL: &str = "pdf-export";

/// Readiness deadline: hidden-window creation → `pdf_export_ready`.
/// Covers page load + payload fetch + font/image settle; generous
/// because attachment images decrypt through the `attachment://`
/// protocol on first paint.
const READY_TIMEOUT: Duration = Duration::from_secs(30);

/// Capture deadline: native print start → completion callback. A
/// swallowed native callback (engine bug, window destroyed mid-print)
/// degrades to `CaptureFailed { Timeout }`, never a hang.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(30);

/// Payload handed to the hidden window. The `html` field is note
/// plaintext (projection) crossing IPC into the render WebView — the
/// same accepted TB2/A7 posture as `note_read` (the plaintext already
/// lives in the main WebView for hours; this copy lives for the
/// seconds the hidden window exists and dies with it).
#[derive(Serialize)]
pub struct PdfExportPayload {
    pub html: String,
    pub title: Option<String>,
}

/// Render the (already-emitted) HTML projection of a note to a PDF at
/// `target_path` via a hidden window + the platform's native
/// print-to-PDF, atomically (full success or nothing at the
/// destination).
///
/// `overwrite` carries the OS save dialog's explicit "Replace"
/// consent (SYNC-2): `false` + existing target →
/// [`PdfExportError::TargetAlreadyExists`] with the target untouched.
///
/// No vault gate, deliberately: there is no decrypt here — the HTML
/// arrives from the unlocked editor's WebView. A lock mid-flight
/// surfaces as [`PdfExportError::PayloadMissing`] via the teardown
/// cancellation (see `error.rs` type-level rationale).
#[tauri::command]
pub async fn pdf_export_render<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, PdfExportState>,
    html: String,
    title: Option<String>,
    target_path: String,
    overwrite: bool,
) -> Result<(), PdfExportError> {
    // First statements: bound the plaintext projection's — and the
    // plaintext-derived title's — lifetime to Zeroizing wrappers
    // (src-tauri/AGENTS.md Plaintext-IPC pattern; 255-F4).
    let html = Zeroizing::new(html);
    let title = title.map(Zeroizing::new);
    render_with_state(
        &app,
        state.inner(),
        html,
        title,
        PathBuf::from(target_path),
        overwrite,
    )
    .await
}

/// Inner — full pipeline behind [`pdf_export_render`], shared with the
/// debug-only smoke harness (`super::dev_smoke`). Owns the
/// stash-session lifecycle: every exit path destroys the hidden
/// window and wipes the stash.
pub(crate) async fn render_with_state<R: Runtime>(
    app: &AppHandle<R>,
    state: &PdfExportState,
    html: Zeroizing<String>,
    title: Option<Zeroizing<String>>,
    target_path: PathBuf,
    overwrite: bool,
) -> Result<(), PdfExportError> {
    // Destination validation BEFORE any session/window work — fail
    // fast with the target untouched. The atomic_write at finalize
    // re-enforces the overwrite consent race-safely.
    validate_destination(&target_path, overwrite).inspect_err(|e| {
        tracing::error!(
            stage = "dest_check",
            error_kind = pdf_export_error_kind(e),
            "pdf_export destination rejected"
        );
    })?;

    // Open the single-slot session (ExportInProgress guard).
    state.begin(html, title).inspect_err(|e| {
        tracing::warn!(
            stage = "stash",
            error_kind = pdf_export_error_kind(e),
            "pdf_export session already active"
        );
    })?;

    let started = Instant::now();
    let result = drive_capture(app, state, &target_path, overwrite).await;

    // Teardown on EVERY path (success or failure): destroy the hidden
    // window, wipe the stash, close the session.
    destroy_export_window(app);
    state.reset();

    let duration_ms = started.elapsed().as_millis() as u64;
    match &result {
        Ok(()) => {
            tracing::info!(
                event = "pdf_exported",
                duration_ms = duration_ms,
                "pdf_export capture + atomic publish succeeded"
            );
        }
        Err(e) => {
            tracing::error!(
                stage = "pdf_export",
                error_kind = pdf_export_error_kind(e),
                duration_ms = duration_ms,
                "pdf_export failed"
            );
        }
    }
    result
}

/// Hidden-page payload fetch. Granted ONLY to the `pdf-export` window
/// (`capabilities/pdf-export.json`); the main capability does not
/// carry `pdf-export:allow-pdf-export-payload`.
#[tauri::command]
pub async fn pdf_export_payload(
    state: State<'_, PdfExportState>,
) -> Result<PdfExportPayload, PdfExportError> {
    state
        .fetch_payload()
        .map(|(html, title)| PdfExportPayload { html, title })
        .ok_or_else(|| {
            tracing::warn!(
                stage = "payload_fetch",
                error_kind = "PayloadMissing",
                "pdf_export_payload requested with no staged session"
            );
            PdfExportError::PayloadMissing
        })
}

/// Hidden-page readiness signal (layout settled — fonts loaded,
/// images decoded). Granted ONLY to the `pdf-export` window.
#[tauri::command]
pub async fn pdf_export_ready(state: State<'_, PdfExportState>) -> Result<(), PdfExportError> {
    if state.signal_ready() {
        Ok(())
    } else {
        tracing::warn!(
            stage = "ready_signal",
            error_kind = "PayloadMissing",
            "pdf_export_ready from a stale or cancelled session"
        );
        Err(PdfExportError::PayloadMissing)
    }
}

// ---- pipeline stages ------------------------------------------------------

/// Window create → readiness wait → native capture → finalize.
async fn drive_capture<R: Runtime>(
    app: &AppHandle<R>,
    state: &PdfExportState,
    target_path: &Path,
    overwrite: bool,
) -> Result<(), PdfExportError> {
    // Hidden render window: bundled page only (`WebviewUrl::App`; the
    // app CSP restricts it to bundled assets + attachment://).
    let window = WebviewWindowBuilder::new(
        app,
        PDF_EXPORT_WINDOW_LABEL,
        WebviewUrl::App("pdf-export.html".into()),
    )
    .title("Myne") // static — never the note title (OS window lists)
    .visible(false)
    .focused(false)
    .skip_taskbar(true)
    .build()
    .map_err(|_| {
        tracing::error!(
            stage = "window_create",
            error_kind = "WindowCreateFailed",
            "pdf_export hidden window creation failed"
        );
        PdfExportError::WindowCreateFailed
    })?;

    // Content-protection BEFORE any frame could exist (the
    // `screen_capture::init` visible:false → protect chain). Applied
    // unconditionally `true`: the window is plaintext-bearing and
    // never user-visible, so always-on is strictly more protective
    // than the user's main-window preference and costs nothing — a
    // pref-disabled user never sees (or screenshots) this window.
    // Best-effort via the shared screen-capture helper (consistent
    // Linux-unsupported warn + success/failure event telemetry).
    crate::screen_capture::apply_inner(&window, true, "pdf_export_window");

    // Wait for the hidden page: payload fetched + layout settled.
    match state.wait_ready(READY_TIMEOUT).await {
        WaitOutcome::Ready => {}
        WaitOutcome::Cancelled => {
            tracing::warn!(
                stage = "ready_wait",
                error_kind = "PayloadMissing",
                "pdf_export cancelled mid-flight (lock teardown cleared the payload)"
            );
            return Err(PdfExportError::PayloadMissing);
        }
        WaitOutcome::TimedOut => {
            tracing::error!(
                stage = "ready_wait",
                error_kind = "RenderTimeout",
                "pdf_export hidden window missed the readiness deadline"
            );
            return Err(PdfExportError::RenderTimeout);
        }
    }

    // Native capture to a temp sibling AT the destination (plaintext
    // by the user's own intent — TB3 egress exception; same-dir keeps
    // everything on one filesystem).
    let capture_tmp = capture_tmp_path(target_path);
    let capture_result = run_native_capture(&window, &capture_tmp).await;

    match capture_result {
        Ok(()) => {
            // Title for the per-page footer stamp — cloned from the
            // stash (still `Zeroizing`); a session torn down between
            // capture and finalize degrades to the "Untitled" fallback
            // rather than failing the already-captured export.
            let title = state.title_for_stamp();
            finalize_capture_output(&capture_tmp, target_path, overwrite, title).await
        }
        Err(kind) => {
            // Best-effort: drop any partial capture temp on the way out.
            let tmp = capture_tmp.clone();
            let _ = tokio::task::spawn_blocking(move || std::fs::remove_file(tmp)).await;
            tracing::error!(
                stage = "capture",
                error_kind = "CaptureFailed",
                capture_failure_kind = ?kind,
                "pdf_export native capture failed"
            );
            Err(PdfExportError::CaptureFailed {
                capture_failure_kind: kind,
            })
        }
    }
}

/// Dispatch the per-OS capture arm into the window's `with_webview`
/// main-thread closure and await its one-shot completion under the
/// capture deadline.
async fn run_native_capture<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    capture_tmp: &Path,
) -> Result<(), CaptureFailureKind> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), CaptureFailureKind>>();
    let dest = capture_tmp.to_path_buf();
    window
        .with_webview(move |platform_webview| {
            super::capture::start_print_to_pdf(&platform_webview, &dest, move |res| {
                let _ = tx.send(res);
            });
        })
        .map_err(|_| CaptureFailureKind::Dispatch)?;

    match tokio::time::timeout(CAPTURE_TIMEOUT, rx).await {
        Err(_elapsed) => Err(CaptureFailureKind::Timeout),
        Ok(Err(_recv_closed)) => Err(CaptureFailureKind::ChannelClosed),
        Ok(Ok(arm_result)) => arm_result,
    }
}

/// Destroy the hidden window if present. Best-effort (already gone on
/// the lock-teardown race — `teardown_on_lock` got there first).
pub(super) fn destroy_export_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(PDF_EXPORT_WINDOW_LABEL) {
        let _ = window.destroy();
    }
}

// ---- headlessly-testable seams ---------------------------------------------

/// Destination validation (mirrors `note_export_with_dir`'s
/// dest-check + the SYNC-2 overwrite gate, both BEFORE any temp or
/// window work).
pub(crate) fn validate_destination(
    target_path: &Path,
    overwrite: bool,
) -> Result<(), PdfExportError> {
    if !crate::paths::parent_dir_ok(target_path) || target_path.is_dir() {
        return Err(PdfExportError::InvalidDestination);
    }
    if !overwrite && target_path.exists() {
        return Err(PdfExportError::TargetAlreadyExists);
    }
    Ok(())
}

/// Temp sibling AT the user-chosen destination for the native arm to
/// write into (same filesystem as the final atomic rename; plaintext
/// by the user's own intent — never inside the vault).
pub(crate) fn capture_tmp_path(target_path: &Path) -> PathBuf {
    let mut name = target_path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".capture-tmp");
    target_path.with_file_name(name)
}

/// Verify + publish the native arm's output: read the capture temp,
/// require `%PDF` magic, stamp the per-page footer (title + `X / Y`
/// counter; **fail-open** — a stamp failure publishes the unstamped
/// capture, the footer is cosmetic), route the bytes through the
/// canonical `atomic_write` honoring the overwrite consent, and ALWAYS
/// remove the capture temp (success or failure) so no plaintext
/// sibling outlives the call.
pub(crate) async fn finalize_capture_output(
    capture_tmp: &Path,
    target_path: &Path,
    overwrite: bool,
    title: Option<Zeroizing<String>>,
) -> Result<(), PdfExportError> {
    let tmp = capture_tmp.to_path_buf();
    let target = target_path.to_path_buf();
    let join = tokio::task::spawn_blocking(move || -> Result<(), PdfExportError> {
        let read_result = std::fs::read(&tmp);
        // The capture temp is consumed (or judged) exactly once —
        // remove it on every path below; a removal failure is
        // best-effort (the temp holds the user's own egress bytes at
        // the user-chosen destination, not vault contents).
        let publish = (|| -> Result<(), PdfExportError> {
            let bytes = read_result.map_err(|e| match e.kind() {
                std::io::ErrorKind::NotFound => PdfExportError::CaptureFailed {
                    capture_failure_kind: CaptureFailureKind::OutputMissing,
                },
                other => PdfExportError::Io {
                    io_error_kind: from_io_error_kind(other),
                },
            })?;
            // The artifact contract: a real, non-empty PDF document.
            if !bytes.starts_with(b"%PDF") {
                return Err(PdfExportError::CaptureFailed {
                    capture_failure_kind: CaptureFailureKind::OutputMissing,
                });
            }
            // Per-page footer (title bottom-left, "X / Y" bottom-right;
            // owner-requested, MYND-255 hotfix). FAIL OPEN on any stamp
            // error: the export must not break over a cosmetic footer —
            // publish the unstamped capture and warn (closed kind only;
            // never the title or any path).
            let bytes = match super::footer::stamp_footer(
                &bytes,
                title.as_deref().map(String::as_str).unwrap_or("Untitled"),
            ) {
                Ok(stamped) => stamped,
                Err(e) => {
                    tracing::warn!(
                        stage = "pdf_footer",
                        error_kind = e.kind(),
                        "pdf_export footer stamp failed; publishing the unstamped capture"
                    );
                    bytes
                }
            };
            // Canonical temp + sync + rename publish via the export-
            // destination variant (randomized `create_new` temp name —
            // a user file shaped like a temp sibling at the destination
            // is never truncated; 115-F1). `replace=false` rejects a
            // pre-existing target BEFORE the temp is created, so the
            // existing file stays untouched.
            crate::atomic_write::atomic_write_unclobbered(&target, &bytes, overwrite).map_err(|e| {
                match e.kind() {
                    std::io::ErrorKind::AlreadyExists => PdfExportError::TargetAlreadyExists,
                    other => PdfExportError::Io {
                        io_error_kind: from_io_error_kind(other),
                    },
                }
            })
        })();
        let _ = std::fs::remove_file(&tmp);
        publish.inspect_err(|e| {
            tracing::error!(
                stage = "finalize_write",
                error_kind = pdf_export_error_kind(e),
                "pdf_export finalize failed"
            );
        })
    })
    .await;

    match join {
        Err(_join_err) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "pdf_export finalize worker panicked or runtime shutdown"
            );
            Err(PdfExportError::JoinFailure)
        }
        Ok(result) => result,
    }
}

/// Static-string label for [`PdfExportError`] variants — the
/// drift-detector discipline of `note_export_error_kind` (a new
/// variant compile-fails this match; this is the exhaustiveness pin).
pub(crate) fn pdf_export_error_kind(e: &PdfExportError) -> &'static str {
    match e {
        PdfExportError::ExportInProgress => "ExportInProgress",
        PdfExportError::InvalidDestination => "InvalidDestination",
        PdfExportError::TargetAlreadyExists => "TargetAlreadyExists",
        PdfExportError::WindowCreateFailed => "WindowCreateFailed",
        PdfExportError::RenderTimeout => "RenderTimeout",
        PdfExportError::PayloadMissing => "PayloadMissing",
        PdfExportError::CaptureFailed { .. } => "CaptureFailed",
        PdfExportError::Io { .. } => "Io",
        PdfExportError::JoinFailure => "JoinFailure",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    // ---- destination validation matrix ---------------------------------

    #[test]
    fn missing_parent_is_invalid_destination() {
        let dir = ScopedTempDir::new("pdfdest-noparent").expect("tempdir");
        let target = dir.path().join("nope").join("out.pdf");
        let err = validate_destination(&target, false).expect_err("must reject");
        assert!(matches!(err, PdfExportError::InvalidDestination));
    }

    #[test]
    fn parent_is_a_file_is_invalid_destination() {
        let dir = ScopedTempDir::new("pdfdest-fileparent").expect("tempdir");
        let file_parent = dir.path().join("afile");
        std::fs::write(&file_parent, b"x").expect("seed file");
        let target = file_parent.join("out.pdf");
        let err = validate_destination(&target, true).expect_err("must reject");
        assert!(matches!(err, PdfExportError::InvalidDestination));
    }

    #[test]
    fn target_being_a_directory_is_invalid_destination() {
        let dir = ScopedTempDir::new("pdfdest-targetdir").expect("tempdir");
        let target = dir.path().join("outdir");
        std::fs::create_dir(&target).expect("seed dir");
        let err = validate_destination(&target, true).expect_err("must reject");
        assert!(matches!(err, PdfExportError::InvalidDestination));
    }

    #[test]
    fn overwrite_false_with_existing_target_is_rejected() {
        let dir = ScopedTempDir::new("pdfdest-collision").expect("tempdir");
        let target = dir.path().join("out.pdf");
        std::fs::write(&target, b"existing").expect("seed target");
        let err = validate_destination(&target, false).expect_err("must reject");
        assert!(matches!(err, PdfExportError::TargetAlreadyExists));
        // The existing file is untouched.
        assert_eq!(std::fs::read(&target).expect("read"), b"existing");
    }

    #[test]
    fn overwrite_true_with_existing_target_passes() {
        let dir = ScopedTempDir::new("pdfdest-replace").expect("tempdir");
        let target = dir.path().join("out.pdf");
        std::fs::write(&target, b"existing").expect("seed target");
        validate_destination(&target, true).expect("explicit consent passes");
    }

    #[test]
    fn fresh_target_in_existing_dir_passes() {
        let dir = ScopedTempDir::new("pdfdest-fresh").expect("tempdir");
        let target = dir.path().join("out.pdf");
        validate_destination(&target, false).expect("fresh target passes");
    }

    // ---- capture temp naming -------------------------------------------

    // ---- finalize matrix --------------------------------------------------

    #[test]
    fn finalize_publishes_pdf_and_removes_capture_tmp() {
        let dir = ScopedTempDir::new("pdffin-ok").expect("tempdir");
        let target = dir.path().join("out.pdf");
        let tmp = capture_tmp_path(&target);
        std::fs::write(&tmp, b"%PDF-1.7 fake body").expect("seed capture tmp");

        rt().block_on(finalize_capture_output(&tmp, &target, false, None))
            .expect("publish succeeds");

        assert_eq!(
            std::fs::read(&target).expect("read target"),
            b"%PDF-1.7 fake body"
        );
        assert!(!tmp.exists(), "capture temp must not outlive finalize");
        // No atomic_write temp residue either.
        let residue: Vec<_> = std::fs::read_dir(dir.path())
            .expect("read_dir")
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name() != "out.pdf")
            .collect();
        assert!(residue.is_empty(), "no stray temp siblings: {residue:?}");
    }

    /// 115-F1 at the PDF destination: a pre-existing USER file named
    /// `<target>.tmp` survives the publish byte-identical (the
    /// unclobbered helper's randomized temp never occupies that name).
    #[test]
    fn finalize_preserves_preexisting_user_tmp_sibling() {
        let dir = ScopedTempDir::new("pdffin-user-tmp").expect("tempdir");
        let target = dir.path().join("out.pdf");
        let user_tmp = dir.path().join("out.pdf.tmp");
        std::fs::write(&user_tmp, b"user file, not ours").expect("seed user tmp");
        let tmp = capture_tmp_path(&target);
        std::fs::write(&tmp, b"%PDF-1.7 fake body").expect("seed capture tmp");

        rt().block_on(finalize_capture_output(&tmp, &target, false, None))
            .expect("publish succeeds around the user file");

        assert_eq!(
            std::fs::read(&target).expect("read target"),
            b"%PDF-1.7 fake body"
        );
        assert_eq!(
            std::fs::read(&user_tmp).expect("read user tmp"),
            b"user file, not ours"
        );
    }

    #[test]
    fn finalize_overwrite_false_rejects_and_keeps_existing_target() {
        let dir = ScopedTempDir::new("pdffin-collision").expect("tempdir");
        let target = dir.path().join("out.pdf");
        std::fs::write(&target, b"%PDF-old").expect("seed existing");
        let tmp = capture_tmp_path(&target);
        std::fs::write(&tmp, b"%PDF-new").expect("seed capture tmp");

        let err = rt()
            .block_on(finalize_capture_output(&tmp, &target, false, None))
            .expect_err("collision without consent rejects");
        assert!(matches!(err, PdfExportError::TargetAlreadyExists));
        assert_eq!(std::fs::read(&target).expect("read"), b"%PDF-old");
        assert!(
            !tmp.exists(),
            "capture temp removed on the failure path too"
        );
    }

    #[test]
    fn finalize_overwrite_true_replaces_existing_target() {
        let dir = ScopedTempDir::new("pdffin-replace").expect("tempdir");
        let target = dir.path().join("out.pdf");
        std::fs::write(&target, b"%PDF-old").expect("seed existing");
        let tmp = capture_tmp_path(&target);
        std::fs::write(&tmp, b"%PDF-new").expect("seed capture tmp");

        rt().block_on(finalize_capture_output(&tmp, &target, true, None))
            .expect("replace with consent succeeds");
        assert_eq!(std::fs::read(&target).expect("read"), b"%PDF-new");
        assert!(!tmp.exists());
    }

    #[test]
    fn finalize_missing_capture_tmp_is_output_missing() {
        let dir = ScopedTempDir::new("pdffin-missing").expect("tempdir");
        let target = dir.path().join("out.pdf");
        let tmp = capture_tmp_path(&target);

        let err = rt()
            .block_on(finalize_capture_output(&tmp, &target, true, None))
            .expect_err("missing capture output rejects");
        assert!(matches!(
            err,
            PdfExportError::CaptureFailed {
                capture_failure_kind: CaptureFailureKind::OutputMissing
            }
        ));
        assert!(!target.exists(), "nothing published");
    }

    #[test]
    fn finalize_non_pdf_capture_output_is_output_missing() {
        let dir = ScopedTempDir::new("pdffin-notpdf").expect("tempdir");
        let target = dir.path().join("out.pdf");
        let tmp = capture_tmp_path(&target);
        std::fs::write(&tmp, b"<html>not a pdf</html>").expect("seed bogus tmp");

        let err = rt()
            .block_on(finalize_capture_output(&tmp, &target, true, None))
            .expect_err("non-PDF output rejects");
        assert!(matches!(
            err,
            PdfExportError::CaptureFailed {
                capture_failure_kind: CaptureFailureKind::OutputMissing
            }
        ));
        assert!(!target.exists(), "nothing published");
        assert!(!tmp.exists(), "bogus capture temp removed");
    }

    #[test]
    fn finalize_empty_capture_output_is_output_missing() {
        let dir = ScopedTempDir::new("pdffin-empty").expect("tempdir");
        let target = dir.path().join("out.pdf");
        let tmp = capture_tmp_path(&target);
        std::fs::write(&tmp, b"").expect("seed empty tmp");

        let err = rt()
            .block_on(finalize_capture_output(&tmp, &target, true, None))
            .expect_err("empty output rejects");
        assert!(matches!(
            err,
            PdfExportError::CaptureFailed {
                capture_failure_kind: CaptureFailureKind::OutputMissing
            }
        ));
    }

    // ---- footer stamp wiring (fail-open) ---------------------------------

    /// A real (lopdf-built) capture output gets the footer stamped
    /// before publish: the published bytes carry the title + counter
    /// in the uncompressed stamp streams.
    #[test]
    fn finalize_stamps_footer_on_real_pdf_capture() {
        let dir = ScopedTempDir::new("pdffin-stamp").expect("tempdir");
        let target = dir.path().join("out.pdf");
        let tmp = capture_tmp_path(&target);
        std::fs::write(&tmp, super::super::footer::tiny_test_pdf(2)).expect("seed capture tmp");

        rt().block_on(finalize_capture_output(
            &tmp,
            &target,
            false,
            Some(Zeroizing::new("Stamped Title".to_string())),
        ))
        .expect("publish succeeds");

        let published = std::fs::read(&target).expect("read target");
        assert!(published.starts_with(b"%PDF"));
        let text = String::from_utf8_lossy(&published);
        assert!(text.contains("(Stamped Title) Tj"), "title stamped");
        assert!(
            text.contains("(1 / 2) Tj") && text.contains("(2 / 2) Tj"),
            "counters stamped"
        );
        assert!(!tmp.exists(), "capture temp consumed");
    }

    /// No title in the session (teardown raced finalize, or the note
    /// is untitled) → the stamp uses the flows' "Untitled" fallback.
    #[test]
    fn finalize_stamps_untitled_fallback_without_a_title() {
        let dir = ScopedTempDir::new("pdffin-untitled").expect("tempdir");
        let target = dir.path().join("out.pdf");
        let tmp = capture_tmp_path(&target);
        std::fs::write(&tmp, super::super::footer::tiny_test_pdf(1)).expect("seed capture tmp");

        rt().block_on(finalize_capture_output(&tmp, &target, false, None))
            .expect("publish succeeds");

        let published = std::fs::read(&target).expect("read target");
        assert!(String::from_utf8_lossy(&published).contains("(Untitled) Tj"));
    }

    /// FAIL-OPEN: bytes that pass the `%PDF` magic gate but do not
    /// parse as a PDF publish UNstamped, byte-identical — a footer
    /// failure must never break the export.
    #[test]
    fn finalize_fails_open_to_unstamped_bytes_on_stamp_error() {
        let dir = ScopedTempDir::new("pdffin-failopen").expect("tempdir");
        let target = dir.path().join("out.pdf");
        let tmp = capture_tmp_path(&target);
        std::fs::write(&tmp, b"%PDF-1.7 magic-only, not parseable").expect("seed capture tmp");

        rt().block_on(finalize_capture_output(
            &tmp,
            &target,
            false,
            Some(Zeroizing::new("Ignored".to_string())),
        ))
        .expect("publish still succeeds (fail-open)");

        assert_eq!(
            std::fs::read(&target).expect("read target"),
            b"%PDF-1.7 magic-only, not parseable",
            "unstamped capture published byte-identical"
        );
        assert!(!tmp.exists());
    }

    // ---- error wire shape (TS mirror contract) ---------------------------

    #[test]
    fn error_serialization_matches_ts_mirror_shape() {
        let unit = serde_json::to_value(PdfExportError::RenderTimeout).expect("serialize");
        assert_eq!(unit, serde_json::json!({ "kind": "RenderTimeout" }));

        let capture = serde_json::to_value(PdfExportError::CaptureFailed {
            capture_failure_kind: CaptureFailureKind::NativePrintFailed,
        })
        .expect("serialize");
        assert_eq!(
            capture,
            serde_json::json!({
                "kind": "CaptureFailed",
                "detail": { "capture_failure_kind": "NativePrintFailed" }
            })
        );

        // `Unsupported` is constructed only by the Windows arm + the
        // non-desktop fallback, but its wire name is part of the closed
        // TS-mirror contract on EVERY platform — pin it here.
        let unsupported = serde_json::to_value(PdfExportError::CaptureFailed {
            capture_failure_kind: CaptureFailureKind::Unsupported,
        })
        .expect("serialize");
        assert_eq!(
            unsupported,
            serde_json::json!({
                "kind": "CaptureFailed",
                "detail": { "capture_failure_kind": "Unsupported" }
            })
        );

        let io = serde_json::to_value(PdfExportError::Io {
            io_error_kind: crate::io_failure_kind::IoFailureKind::NoSpace,
        })
        .expect("serialize");
        assert_eq!(
            io,
            serde_json::json!({
                "kind": "Io",
                "detail": { "io_error_kind": "NoSpace" }
            })
        );
    }
}
