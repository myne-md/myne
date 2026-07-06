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
//! - **Main-window-scoped** — the handler rejects any request whose
//!   originating webview label is not `"main"`.
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

/// The single webview label permitted to fetch `attachment://` URIs.
/// v0.1 is single-window; any other label is a routing anomaly and is
/// rejected with `403`.
const MAIN_WINDOW_LABEL: &str = "main";

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
/// The main-window fence + slot peek + vault-dir resolution are host
/// concerns (they need the `AppHandle` + the managed `VaultRuntimeState`);
/// the actual decode logic is delegated to
/// [`crate::plugins::attachments::scheme_core::build_response`], which is
/// unit-testable without a Tauri runtime.
async fn serve<R: Runtime>(
    app: &tauri::AppHandle<R>,
    webview_label: &str,
    uri: &http::Uri,
) -> http::Response<Vec<u8>> {
    // (1) Main-window-only fence. Any other originating webview → 403.
    if webview_label != MAIN_WINDOW_LABEL {
        tracing::warn!(
            stage = "scheme_label_check",
            status = 403,
            "attachment:// request from non-main webview rejected"
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
        Some((items_key, items_key_id, root_key)) => ServeKeys {
            items_key,
            items_key_id,
            root_key,
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
