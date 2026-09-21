//! `attachment://<id>` async custom-URI-scheme handler (MYND-169,
//! SYNC-4) — the desktop Tauri glue.
//!
//! Serves decrypted attachment bytes to the WebView so `<img src>` /
//! `<embed>` / pdf.js can render an attachment without any plaintext
//! ever touching disk. The handler:
//!
//! 1. Parses `<id>` (64-char lowercase hex) from the URI path.
//! 2. Requires `Slot::Unlocked` (else `403`, empty body).
//! 3. Reads `<vault>/attachments/<id-hex>`, decodes the `MYA1` blob to
//!    plaintext IN MEMORY (`items_key` from the slot, the catalog's
//!    `content_type` hint as the AAD).
//! 4. **Re-sniffs the content-type from the DECRYPTED bytes** and emits
//!    ONLY an allowlisted type — never `text/html` (the XSS-defense
//!    invariant).
//! 5. Returns a full `200` response (no Range/206 in v1).
//!
//! ## Extraction into `myne-core`
//!
//! The unit-testable decode+serve core — `build_response`, `extract_id`, the
//! `ServeKeys` material struct, and the canned error responses — moved to
//! [`crate::plugins::attachments::scheme_core`] (shared desktop↔mobile). This
//! module keeps ONLY the Tauri glue: the async-URI-scheme entry point
//! ([`handle`]), the main-window-label fence + slot peek + vault-dir resolution
//! ([`serve`]), and the `SCHEME` name registered on the `Builder` in `lib.rs`.
//!
//! ## Threat posture (SYNC-4 / `threat-model.md`)
//!
//! - **No plaintext on disk** — decode happens in RAM; only the response
//!   body (a fresh `Vec<u8>`) leaves `scheme_core`, handed to the WebView.
//! - **Unlock-gated** — a locked vault serves `403`.
//! - **Label-scoped** — the handler rejects any request whose originating
//!   webview label is not in [`ALLOWED_WEBVIEW_LABELS`] (the app window and
//!   the hidden PDF-export render window; MYND-638).
//! - **Content-type re-sniff** — the served `Content-Type` is derived
//!   from the bytes, allowlist-fenced (in `scheme_core::build_response`).
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use crate::plugins::attachments::scheme_core::{
    bad_request, build_response, extract_id, forbidden, server_error, ServeKeys,
};
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use std::path::PathBuf;
use tauri::{http, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

/// The custom URI scheme name. Registered on the Tauri `Builder` in
/// `lib.rs` via `register_asynchronous_uri_scheme_protocol`.
pub const SCHEME: &str = "attachment";

/// The webview labels permitted to fetch `attachment://` URIs. Any other
/// label is a routing anomaly and is rejected with `403`.
///
/// **`main`** is the app. **`pdf-export`** (MYND-638) is the hidden
/// render window the PDF export drives, and it has to be here or a PDF
/// silently comes out with no images: the fence predates that window, so
/// every `<img>` in the export projection was refused, and
/// `src/pdf-export/main.ts` swallows a failed image decode by design
/// ("a broken/missing attachment must stall nothing"). A blocked request
/// therefore became an invisible defect rather than an error.
///
/// Widening to an allowlist rather than dropping the fence is deliberate.
/// The guard exists to catch a request from a webview that should not
/// exist; both entries here are windows THIS crate creates, load a
/// bundled `WebviewUrl::App` page, are never user-navigable, and carry
/// narrow capabilities (`pdf-export` has exactly one permission,
/// `pdf-export:page`). A future window gets no access by accident — it
/// has to be added here, in the file whose whole job is saying who may
/// read decrypted attachment bytes.
///
/// **Detached note windows** (myne-md/myne#677, epic #173) are admitted by
/// the [`DETACHED_NOTE_LABEL_PREFIX`] rule below rather than a fixed entry,
/// because there is one host-spawned window per note (`note-<id>`, SYNC-1).
/// The same reasoning holds: the label is HOST-assigned (page context cannot
/// set its own window label), the window loads a bundled `WebviewUrl::App`
/// page, and it carries the narrow `detached-note` capability. A detached
/// window renders the same embeds a split pane already renders, so granting
/// it attachment reads is the same exposure already permitted (sync-ledger
/// SYNC-12).
const ALLOWED_WEBVIEW_LABELS: [&str; 2] = [
    "main",
    crate::plugins::pdf_export::commands::PDF_EXPORT_WINDOW_LABEL,
];

/// Label prefix for a detached (pop-out) note window: one host-spawned window
/// per note, labelled `note-<id>` (SYNC-1). The window-creation side
/// (myne#678) must spawn under this exact prefix; the capability
/// `capabilities/detached-note.json` matches the same `note-*` glob, and the
/// lock-teardown (myne#679) enumerates detached windows by it. Kept here as
/// the one source of truth until #678's window module lands and imports it.
pub const DETACHED_NOTE_LABEL_PREFIX: &str = "note-";

/// Whether a webview label may fetch `attachment://` URIs: a fixed allowlist
/// entry, or a detached note window (`note-<id>`). Pure and unit-tested so the
/// fence is checked without a Tauri runtime; the caller ([`serve`]) applies it.
fn is_allowed_webview_label(label: &str) -> bool {
    ALLOWED_WEBVIEW_LABELS.contains(&label) || label.starts_with(DETACHED_NOTE_LABEL_PREFIX)
}

/// The Tauri async-URI-scheme handler entry point. Registered in
/// `lib.rs`. Spawns the decrypt + serve work onto the async runtime so
/// the slot's async `RwLock` + the blocking blob read do not run on the
/// caller's thread, then resolves `responder`.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let webview_label = ctx.webview_label().to_string();
    // Extract the id from the URI synchronously (cheap, no await).
    let uri = request.uri().clone();

    tauri::async_runtime::spawn(async move {
        let response = serve(&app, &webview_label, &uri).await;
        responder.respond(response);
    });
}

/// Resolve one `attachment://` request to a full HTTP response.
///
/// The webview-label fence + slot peek + vault-dir resolution are host
/// concerns (they need the `AppHandle` + the managed `VaultRuntimeState`);
/// the actual decode logic is delegated to
/// [`crate::plugins::attachments::scheme_core::build_response`], which is
/// unit-testable without a Tauri runtime.
async fn serve<R: Runtime>(
    app: &tauri::AppHandle<R>,
    webview_label: &str,
    uri: &http::Uri,
) -> http::Response<Vec<u8>> {
    // (1) Webview-label fence. Any originating webview outside the
    //     allowlist → 403. The label is a `&'static str` comparison
    //     against our own constants; nothing user-controlled reaches it.
    if !is_allowed_webview_label(webview_label) {
        tracing::warn!(
            stage = "scheme_label_check",
            status = 403,
            "attachment:// request from a webview outside the allowlist rejected"
        );
        return forbidden();
    }

    // (2) Parse the id from the URI path (platform-varying forms).
    let id_hex = match extract_id(uri) {
        Some(id) => id,
        None => {
            tracing::debug!(stage = "scheme_id_parse", status = 400);
            return bad_request();
        }
    };

    // (3) Slot gate — clone (items_key, items_key_id, root_key) out.
    let state = match app.try_state::<VaultRuntimeState>() {
        Some(s) => s,
        None => return server_error(),
    };
    let keys = match state.peek_unlocked_attachment_material().await {
        Some((items_key, items_key_id, shared)) => ServeKeys {
            items_key,
            items_key_id,
            shared,
        },
        None => {
            tracing::debug!(stage = "scheme_slot_check", status = 403);
            return forbidden();
        }
    };

    // (4) Resolve the ACTIVE vault dir, then decode + re-sniff + build the
    //     response in the shared core. SYNC-6: the served bytes come from the
    //     unlocked vault (active id), not the sole-vault disk heuristic.
    let vault_dir = match vault_dir(app, state.active_vault_id().await) {
        Ok(d) => d,
        Err(_) => return server_error(),
    };

    build_response(&vault_dir, &keys, &id_hex)
}

/// Resolve the ACTIVE vault root. `active_id` is read from the runtime state by
/// [`serve`] (`state.active_vault_id().await`) after it obtains the managed
/// `VaultRuntimeState` — the only place with `.await` access to the slot map.
fn vault_dir<R: Runtime>(
    app: &tauri::AppHandle<R>,
    active_id: Option<crate::vault_id::VaultId>,
) -> std::io::Result<PathBuf> {
    crate::paths::active_vault_root_io(app, active_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The allowlist is the only thing standing between an arbitrary webview and
    /// decrypted attachment bytes, so pin both what it admits and what it does
    /// not. A future window added to the app must fail here until someone
    /// deliberately lists it (MYND-638).
    #[test]
    fn allowlist_admits_the_app_and_the_pdf_export_window_only() {
        assert!(ALLOWED_WEBVIEW_LABELS.contains(&"main"));
        assert!(ALLOWED_WEBVIEW_LABELS
            .contains(&crate::plugins::pdf_export::commands::PDF_EXPORT_WINDOW_LABEL));
        assert_eq!(
            ALLOWED_WEBVIEW_LABELS.len(),
            2,
            "no third label without review"
        );

        for label in ["", "clipper", "settings", "Main", "pdf_export", "devtools"] {
            assert!(
                !ALLOWED_WEBVIEW_LABELS.contains(&label),
                "label {label:?} must not reach attachment bytes"
            );
        }
    }

    /// The constant is shared with the window builder rather than re-typed —
    /// a copy would drift and silently re-break the export.
    #[test]
    fn pdf_export_label_is_the_one_the_window_is_built_with() {
        assert_eq!(
            crate::plugins::pdf_export::commands::PDF_EXPORT_WINDOW_LABEL,
            "pdf-export"
        );
    }

    /// The fence predicate, both directions (myne#677, epic #173): it admits the
    /// app window, the pdf-export window, and any detached note window
    /// (`note-<id>`, host-assigned), and rejects everything else, including a
    /// label that merely contains "note" without the `note-` prefix boundary.
    #[test]
    fn predicate_admits_main_pdf_export_and_detached_notes_only() {
        // Admitted.
        assert!(is_allowed_webview_label("main"));
        assert!(is_allowed_webview_label(
            crate::plugins::pdf_export::commands::PDF_EXPORT_WINDOW_LABEL
        ));
        assert!(is_allowed_webview_label(
            "note-0192f0a1b2c3d4e5f60718293a4b5c6d"
        ));

        // Rejected: no `note-` prefix, or the prefix not at the start.
        for label in [
            "",
            "evil",
            "clipper",
            "settings",
            "devtools",
            "note",      // no dash boundary
            "notemain",  // no dash boundary
            "xnote-abc", // prefix not at the start
            "-note-abc",
        ] {
            assert!(
                !is_allowed_webview_label(label),
                "label {label:?} must not reach attachment bytes"
            );
        }
    }
}
