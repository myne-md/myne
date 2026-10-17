// SPDX-License-Identifier: AGPL-3.0
//! `attachment://<id>` async custom-URI-scheme handler — mobile Tauri glue.
//!
//! Serves decrypted attachment bytes to the WebView so `<img src>` / `<embed>` /
//! pdf.js can render an attachment without any plaintext ever touching disk. The
//! unit-testable decode+serve core — `build_response`, `extract_id`, the
//! `ServeKeys` material struct, the canned error responses — lives in the shared
//! `myne_core::plugins::attachments::scheme_core` (with the XSS-defense re-sniff
//! invariant). This module is only the Tauri glue: the async-URI-scheme entry
//! point, the main-window-label fence, the slot peek, and the active-vault-dir
//! resolution — mirroring the desktop `scheme.rs`.
//!
//! See: the main repo's `src-tauri/AGENTS.md` "Secret-handling logging
//! discipline".

use myne_core::plugins::attachments::scheme_core::{
    bad_request, build_response, extract_id, forbidden, server_error, ServeKeys,
};
use myne_core::plugins::vault_unlock::state::VaultRuntimeState;
use std::path::PathBuf;
use tauri::{http, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

/// The custom URI scheme name. Registered on the Tauri `Builder` in `lib.rs`
/// via `register_asynchronous_uri_scheme_protocol`.
pub const SCHEME: &str = "attachment";

/// The single webview label permitted to fetch `attachment://` URIs.
const MAIN_WINDOW_LABEL: &str = "main";

/// The Tauri async-URI-scheme handler entry point.
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: http::Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let webview_label = ctx.webview_label().to_string();
    let uri = request.uri().clone();
    tauri::async_runtime::spawn(async move {
        let response = serve(&app, &webview_label, &uri).await;
        responder.respond(response);
    });
}

/// Resolve one `attachment://` request to a full HTTP response. The
/// main-window fence + slot peek + vault-dir resolution are host concerns; the
/// decode logic is delegated to `scheme_core::build_response`.
async fn serve<R: Runtime>(
    app: &tauri::AppHandle<R>,
    webview_label: &str,
    uri: &http::Uri,
) -> http::Response<Vec<u8>> {
    if webview_label != MAIN_WINDOW_LABEL {
        return forbidden();
    }
    let id_hex = match extract_id(uri) {
        Some(id) => id,
        None => return bad_request(),
    };
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
        None => return forbidden(),
    };
    let vault_dir = match vault_dir(app, state.active_vault_id().await) {
        Ok(d) => d,
        Err(_) => return server_error(),
    };
    build_response(&vault_dir, &keys, &id_hex)
}

/// Resolve the ACTIVE vault root.
fn vault_dir<R: Runtime>(
    app: &tauri::AppHandle<R>,
    active_id: Option<crate::vault_id::VaultId>,
) -> std::io::Result<PathBuf> {
    crate::paths::active_vault_root_io(app, active_id)
}
