//! `pdf-export` plugin — hidden-window native print-to-PDF capture for
//! the per-note PDF export (MYND-255 task 4, epic export-suite).
//!
//! Three commands across two seats:
//!
//! - `pdf_export_render` — MAIN-window seat (`pdf-export:default` in
//!   `capabilities/default.json`). Takes the ALREADY-EMITTED HTML
//!   projection (the main window's JS runs
//!   `src/dialect/html/emitNoteHtml.ts`; KaTeX/mermaid/highlight need
//!   a real WebView, and the plaintext already lives there — no
//!   decrypt-in-Rust duplication), stashes it, opens the hidden
//!   `pdf-export` window, and drives native print-to-PDF → canonical
//!   `atomic_write` at the user-chosen destination.
//! - `pdf_export_payload` + `pdf_export_ready` — hidden-window seat,
//!   granted ONLY by the near-empty `capabilities/pdf-export.json`
//!   (windows: ["pdf-export"]). The main capability does NOT carry
//!   them, and the hidden window cannot invoke anything else.
//!
//! **Security lockstep** (PRD "second-window security wiring — in
//! scope, not follow-up"): the hidden window is plaintext-bearing, so
//! it joins the main window's teardown discipline — every
//! lock-teardown site (`auto_lock`, `vault_lock`, unlock-switch,
//! change-password force-relock, vault-delete) calls
//! [`teardown_on_lock`] alongside `clear_staged_descriptor`, which
//! destroys the window AND wipes the stashed payload; content
//! protection is applied at window creation before any frame exists.
//!
//! Capability ACL: `pdf-export:default`
//! (`permissions/pdf-export/default.toml` and `build.rs
//! InlinedPlugin::commands` lock-stepped — adding a command without
//! the matching `commands.allow` entry is a security regression).
//!
//! Logging: see `src-tauri/AGENTS.md` "Secret-handling logging
//! discipline" — stage tags + closed kinds + coarse duration; never
//! the HTML payload, title, note id, or any path.

pub mod commands;
pub mod error;
pub mod state;

mod capture;
mod footer;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime};

/// Construct the `pdf-export` plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("pdf-export")
        .invoke_handler(tauri::generate_handler![
            commands::pdf_export_render,
            commands::pdf_export_payload,
            commands::pdf_export_ready,
        ])
        .setup(|app, _api| {
            app.manage(state::PdfExportState::default());
            #[cfg(debug_assertions)]
            dev_smoke::spawn_if_requested(app.app_handle().clone());
            Ok(())
        })
        .build()
}

/// Lock-teardown hook: destroy the hidden `pdf-export` window if
/// present and wipe the stashed payload (cancelling any in-flight
/// render, which then rejects with `PayloadMissing`). Wired into
/// EVERY lock-teardown site alongside
/// `workspace::clear_staged_descriptor` so the plaintext-bearing
/// second window never outlives the slot (threat-model A6; auto-grill
/// brief integration point 2). Sync + infallible.
pub fn teardown_on_lock<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(commands::PDF_EXPORT_WINDOW_LABEL) {
        let _ = window.destroy();
    }
    if let Some(state) = app.try_state::<state::PdfExportState>() {
        state.clear_for_teardown();
    }
}

/// Debug-build-only manual smoke harness for the capture pipeline.
///
/// The native arm needs a REAL window + WebView (no `tauri::test`
/// mock runtime can capture), and tests never own the macOS main
/// thread — so the smoke rides the dev app instead:
///
/// ```sh
/// MYNE_PDF_SMOKE=/tmp/myne-pdf-smoke.pdf pnpm tauri dev
/// ```
///
/// boots the app normally and, a few seconds in, drives the full
/// pipeline (stash → hidden window → readiness → native capture →
/// atomic publish) with a fixture HTML body, logging
/// `event = "pdf_smoke"` with the outcome. Compiled out of release
/// builds entirely (`#[cfg(debug_assertions)]`).
#[cfg(debug_assertions)]
mod dev_smoke {
    use std::path::PathBuf;
    use tauri::{AppHandle, Manager, Runtime};
    use zeroize::Zeroizing;

    const SMOKE_HTML: &str = "<h1 class=\"note-title\">PDF smoke</h1>\
        <p>Fixture body — <strong>bold</strong>, <em>italic</em>, \
        <code>mono</code>.</p>\
        <pre class=\"code-card\" data-lang=\"rust\"><code>fn main() {}</code></pre>\
        <p>Pagination filler follows.</p>";

    pub(super) fn spawn_if_requested<R: Runtime>(app: AppHandle<R>) {
        let Ok(target) = std::env::var("MYNE_PDF_SMOKE") else {
            return;
        };
        let target = PathBuf::from(target);
        tauri::async_runtime::spawn(async move {
            // Let the app finish booting (webview pool, asset server).
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            let state = app.state::<super::state::PdfExportState>();
            // Long fixture so the capture has > 1 page to paginate.
            let mut html = String::from(SMOKE_HTML);
            for i in 0..200 {
                html.push_str(&format!("<p>filler paragraph {i}</p>"));
            }
            let result = super::commands::render_with_state(
                &app,
                state.inner(),
                Zeroizing::new(html),
                Some(Zeroizing::new("PDF smoke".to_string())),
                target,
                true,
            )
            .await;
            match result {
                Ok(()) => tracing::info!(event = "pdf_smoke", outcome = "ok"),
                Err(e) => tracing::error!(
                    event = "pdf_smoke",
                    outcome = "failed",
                    error_kind = super::commands::pdf_export_error_kind(&e),
                ),
            }
        });
    }
}
