// SPDX-License-Identifier: AGPL-3.0
//! Platform-agnostic core of the `attachment://<id>` URI-scheme handler
//! (MYND-169, SYNC-4).
//!
//! The Tauri glue (`register_asynchronous_uri_scheme_protocol`, the
//! `AppHandle` → vault-dir resolution, the main-window-label fence, the async
//! spawn) is per-host and stays in each client's `scheme.rs`. This module owns
//! the unit-testable decode+serve core: given the vault dir, the unlocked-slot
//! key material, and the hex id, read + decode the `MYA1` blob, re-sniff the
//! content-type from the decrypted bytes, and build the full response — the
//! XSS-defense re-sniff invariant lives here.
//!
//! See: `src-tauri/CLAUDE.md` "Secret-handling logging discipline" — the
//! decrypted bytes, the blob bytes, the id, and paths are DENY-listed; only the
//! served `&'static str` MIME label + a coarse status crosses a tracing boundary.

use super::commands::hex_decode_id;
use super::sniff::{sniff_content_type, ALLOWLISTED_CONTENT_TYPES};
use protocol::{decode_attachment_blob, AttachmentsCatalog, VAULT_META_ACCOUNT_HASH_LEN};
use std::path::Path;
use tauri::http;
use zeroize::Zeroizing;

/// Material cloned out of the unlocked slot for one serve. `items_key` +
/// `root_key` are `Zeroizing` (wipe on drop); `items_key_id` is the
/// non-secret singleton UUIDv7. Fields are `pub` so each host's `serve` can
/// construct it from `state.peek_unlocked_attachment_material()`.
pub struct ServeKeys {
    pub items_key: Zeroizing<[u8; 32]>,
    pub items_key_id: [u8; 16],
    pub root_key: Zeroizing<[u8; 32]>,
}

/// Testable core: given the vault dir, the unlocked-slot key material,
/// and the hex id, read + decode the blob, re-sniff, and build the full
/// response. Returns `404` when the blob is absent, `403` when the id is
/// malformed or the blob fails to decode (non-distinguishing — a
/// tampered / cross-vault blob and a wrong-key blob look identical),
/// `200` with the re-sniffed allowlisted content-type on success.
pub fn build_response(vault_dir: &Path, keys: &ServeKeys, id_hex: &str) -> http::Response<Vec<u8>> {
    // Strict id parse → 32 bytes. Malformed → 403 (bug-canary; the UI
    // only emits catalog ids).
    let Some(attachment_id) = hex_decode_id(id_hex) else {
        tracing::debug!(stage = "scheme_id_decode", status = 403);
        return forbidden();
    };

    // Read the catalog to recover the content_type hint (bound into the
    // blob's inner AAD at encode time, so decode needs the SAME bytes).
    // Absent/tampered catalog → empty → no entry → 404 (the blob can't be
    // decoded without the content_type AAD; treat as not-found).
    let account_number_hash = match read_account_number_hash(&vault_dir.join("vault.meta")) {
        Some(h) => h,
        None => return server_error(),
    };
    let catalog_key =
        protocol::derive_subkey(&keys.root_key, protocol::SubkeyRole::AttachmentsCatalogKey);
    let catalog = read_catalog(
        &vault_dir.join("vault.attachments"),
        &catalog_key,
        &account_number_hash,
    );
    let content_type_hint = match catalog.entries.get(id_hex) {
        Some(meta) => meta.content_type.clone(),
        None => {
            tracing::debug!(stage = "scheme_catalog_lookup", status = 404);
            return not_found();
        }
    };

    // Read the blob file.
    let blob_path = vault_dir.join("attachments").join(id_hex);
    let blob = match std::fs::read(&blob_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            tracing::debug!(stage = "scheme_blob_read", status = 404);
            return not_found();
        }
        Err(e) => {
            tracing::error!(
                stage = "scheme_blob_read",
                status = 500,
                io_failure_kind = ?crate::io_failure_kind::from_io_error_kind(e.kind()),
                "attachment:// blob read failed"
            );
            return server_error();
        }
    };

    // Decode in memory. The plaintext is Zeroizing — it wipes when
    // `plaintext` drops at the end of this function (after the body is
    // cloned out).
    let plaintext = match decode_attachment_blob(
        &blob,
        &attachment_id,
        content_type_hint.as_bytes(),
        &keys.items_key,
        &keys.items_key_id,
    ) {
        Ok(pt) => pt,
        Err(_) => {
            // Non-distinguishing per §6.4: tampered / cross-vault /
            // wrong-key all collapse to one 403.
            tracing::debug!(stage = "scheme_decode", status = 403);
            return forbidden();
        }
    };

    // RE-SNIFF the decrypted bytes — the served content-type is derived
    // from the bytes, allowlist-fenced, NEVER the catalog hint and NEVER
    // text/html. An unrecognized sniff falls back to a non-scriptable
    // octet-stream so a tampered-but-decryptable blob can't become XSS.
    let served_type = sniff_content_type(&plaintext).unwrap_or("application/octet-stream");
    debug_assert!(
        served_type == "application/octet-stream"
            || ALLOWLISTED_CONTENT_TYPES.contains(&served_type),
        "served type must be allowlisted or the octet-stream fallback"
    );

    // Build the body (clones the plaintext out of the Zeroizing buffer).
    // The clone is the non-Zeroized intermediate that the WebView will
    // hold — accepted under the V8-leak-dominance argument; the original
    // Zeroizing `plaintext` wipes on drop below.
    let body = plaintext.to_vec();
    let len = body.len();
    drop(plaintext); // explicit wipe of the Zeroizing source

    tracing::debug!(
        stage = "scheme_serve",
        status = 200,
        content_type = served_type,
        "attachment:// served"
    );

    http::Response::builder()
        .status(http::StatusCode::OK)
        .header(http::header::CONTENT_TYPE, served_type)
        .header(http::header::CONTENT_LENGTH, len)
        // CORS: `attachment://` is a distinct origin from the app, so a WebView
        // `fetch('attachment://<id>')` (used by pdf.js — we feed it in-memory
        // bytes since it only http-streams) is a cross-origin read; without an
        // ACAO header the body is opaque and unreadable, so PDFs never render.
        // The scheme is local, unlock-gated, and main-window-scoped (not
        // network-exposed), so this only lets the app read its OWN decrypted
        // attachments. `<img>` already worked (images don't enforce CORS).
        .header("Access-Control-Allow-Origin", "*")
        // Belt: tell the WebView never to sniff a different type than we
        // declared (defense-in-depth with the re-sniff above).
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .unwrap_or_else(|_| server_error())
}

// ---- URI id extraction --------------------------------------------------

/// Extract the attachment-id from an `attachment://<id>` URI. Tauri
/// surfaces the scheme differently per platform:
///
/// - macOS/Linux: `attachment://localhost/<id>` (id is the path) OR
///   `attachment://<id>` (id is the host).
/// - Windows/Android: `http://attachment.localhost/<id>` (id is the
///   path).
///
/// To be robust across all forms, prefer the last non-empty path
/// segment; if the path is empty (or just `/`), fall back to the host
/// (minus a `localhost` / `attachment.localhost` sentinel). Returns the
/// candidate id string WITHOUT validating it as hex — [`build_response`]
/// does the strict decode.
pub fn extract_id(uri: &http::Uri) -> Option<String> {
    // Last non-empty path segment.
    let path = uri.path();
    if let Some(seg) = path.rsplit('/').find(|s| !s.is_empty()) {
        // Skip a `localhost` sentinel that can appear as the only path
        // segment on some platforms — it's not an id.
        if seg != "localhost" {
            return Some(seg.to_string());
        }
    }
    // Fall back to the host (the `attachment://<id>` form).
    if let Some(host) = uri.host() {
        let host = host.strip_suffix(".localhost").unwrap_or(host);
        if !host.is_empty() && host != "localhost" {
            return Some(host.to_string());
        }
    }
    None
}

// ---- meta + catalog helpers (serve-specific: collapse failure to empty) --
// The strict `hex_decode_id` (the path-traversal guard) is reused verbatim from
// `super::commands`; only the read helpers below stay local because the serve
// path intentionally collapses IO/parse failure to empty (§9.10.4) rather than
// surfacing the distinguishable errors the command path returns.

/// Read `vault.meta`'s account_number_hash; `None` on IO / parse failure.
fn read_account_number_hash(vault_meta_path: &Path) -> Option<[u8; VAULT_META_ACCOUNT_HASH_LEN]> {
    let bytes = std::fs::read(vault_meta_path).ok()?;
    protocol::parse_vault_meta(&bytes)
        .map(|m| m.account_number_hash)
        .ok()
}

/// Read + decode the catalog, collapsing any failure to empty
/// (§ 9.10.4). The serve path never writes the catalog, so an
/// empty-on-failure read is non-destructive (a missing entry → 404).
fn read_catalog(
    catalog_path: &Path,
    catalog_key: &[u8; 32],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
) -> AttachmentsCatalog {
    match std::fs::read(catalog_path) {
        Ok(bytes) => protocol::read_or_empty(catalog_key, account_number_hash, Some(&bytes)),
        Err(_) => AttachmentsCatalog::empty(),
    }
}

// ---- canned responses ---------------------------------------------------

/// `403` — empty, non-scriptable body. `pub` so each host's `serve` can reuse it
/// for the pre-`build_response` fences (bad webview label / locked slot).
pub fn forbidden() -> http::Response<Vec<u8>> {
    canned(http::StatusCode::FORBIDDEN)
}

fn not_found() -> http::Response<Vec<u8>> {
    canned(http::StatusCode::NOT_FOUND)
}

/// `400` — empty, non-scriptable body. `pub` for host `serve` reuse.
pub fn bad_request() -> http::Response<Vec<u8>> {
    canned(http::StatusCode::BAD_REQUEST)
}

/// `500` — empty, non-scriptable body. `pub` for host `serve` reuse.
pub fn server_error() -> http::Response<Vec<u8>> {
    canned(http::StatusCode::INTERNAL_SERVER_ERROR)
}

/// An empty-body error response with a non-scriptable content-type, so
/// even an error response cannot be turned into an HTML document the
/// WebView would execute.
fn canned(status: http::StatusCode) -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(status)
        .header(http::header::CONTENT_TYPE, "application/octet-stream")
        .header(http::header::CONTENT_LENGTH, 0)
        .body(Vec::new())
        .expect("canned response builds")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::ScopedTempDir;
    use protocol::{
        derive_subkey, encode_attachment_blob, encode_attachments_catalog, AttachmentMeta,
        SubkeyRole, VAULT_META_ACCOUNT_HASH_LEN,
    };

    const SEED_ROOT: u8 = 0x42;
    const SEED_ITEMS: u8 = 0x99;
    const SEED_ITEMS_ID: u8 = 1;
    const SEED_ACCOUNT_HASH: u8 = 0x33;
    const PNG_BYTES: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 9, 9, 9];

    fn keys() -> ServeKeys {
        ServeKeys {
            items_key: Zeroizing::new([SEED_ITEMS; 32]),
            items_key_id: [SEED_ITEMS_ID; 16],
            root_key: Zeroizing::new([SEED_ROOT; 32]),
        }
    }

    fn seed_vault_meta(dir: &Path) {
        let meta = protocol::VaultMeta {
            account_number_hash: [SEED_ACCOUNT_HASH; VAULT_META_ACCOUNT_HASH_LEN],
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            random_salt_password: [1u8; 16],
            random_salt_recovery: [2u8; 16],
            nonce_password_wrap: [3u8; 24],
            enc_root_key_password: [4u8; 64],
            nonce_recovery_wrap: [5u8; 24],
            enc_root_key_recovery: [6u8; 64],
            items_key_id: [7u8; 16],
            items_key_nonce: [8u8; 24],
            enc_items_key: [9u8; 64],
        };
        std::fs::write(
            dir.join("vault.meta"),
            protocol::serialize_vault_meta(&meta),
        )
        .unwrap();
    }

    /// Seed a blob + catalog entry the way `attachment_import` would, and
    /// return the hex id. Uses the same id derivation
    /// (`compute_attachment_id`) so `build_response` finds it.
    fn seed_attachment(dir: &Path, bytes: &[u8], content_type: &str) -> String {
        let root = [SEED_ROOT; 32];
        let items_key = [SEED_ITEMS; 32];
        let items_key_id = [SEED_ITEMS_ID; 16];
        let account_hash = [SEED_ACCOUNT_HASH; VAULT_META_ACCOUNT_HASH_LEN];

        let id = protocol::compute_attachment_id(&root, bytes);
        let id_hex: String = id.iter().map(|b| format!("{b:02x}")).collect();

        let blob = encode_attachment_blob(
            &items_key,
            &items_key_id,
            &id,
            content_type.as_bytes(),
            bytes,
        )
        .unwrap();
        let attach_dir = dir.join("attachments");
        std::fs::create_dir_all(&attach_dir).unwrap();
        std::fs::write(attach_dir.join(&id_hex), &blob).unwrap();

        let mut catalog = AttachmentsCatalog::empty();
        catalog.entries.insert(
            id_hex.clone(),
            AttachmentMeta {
                content_type: content_type.to_string(),
                created_at: 1_700_000_000,
                filename: "x".to_string(),
                size: bytes.len() as u64,
            },
        );
        let catalog_key = derive_subkey(&root, SubkeyRole::AttachmentsCatalogKey);
        let cbytes = encode_attachments_catalog(&catalog_key, &account_hash, &catalog).unwrap();
        std::fs::write(dir.join("vault.attachments"), &cbytes).unwrap();
        id_hex
    }

    // ---- URI id extraction ---------------------------------------------

    #[test]
    fn extract_id_from_path_form() {
        let uri: http::Uri = "attachment://localhost/abc123".parse().unwrap();
        assert_eq!(extract_id(&uri).as_deref(), Some("abc123"));
    }

    #[test]
    fn extract_id_from_windows_form() {
        let uri: http::Uri = "http://attachment.localhost/deadbeef".parse().unwrap();
        assert_eq!(extract_id(&uri).as_deref(), Some("deadbeef"));
    }

    #[test]
    fn extract_id_from_host_form() {
        let uri: http::Uri = "attachment://feedface".parse().unwrap();
        assert_eq!(extract_id(&uri).as_deref(), Some("feedface"));
    }

    #[test]
    fn extract_id_none_for_bare_localhost() {
        let uri: http::Uri = "attachment://localhost/".parse().unwrap();
        assert_eq!(extract_id(&uri), None);
    }

    // ---- build_response happy path -------------------------------------

    #[test]
    fn serves_png_with_resniffed_type() {
        let tmp = ScopedTempDir::new("scheme-png").unwrap();
        seed_vault_meta(tmp.path());
        let id = seed_attachment(tmp.path(), PNG_BYTES, "image/png");

        let resp = build_response(tmp.path(), &keys(), &id);
        assert_eq!(resp.status(), http::StatusCode::OK);
        assert_eq!(
            resp.headers().get(http::header::CONTENT_TYPE).unwrap(),
            "image/png"
        );
        assert_eq!(resp.body().as_slice(), PNG_BYTES);
        assert_eq!(
            resp.headers().get("X-Content-Type-Options").unwrap(),
            "nosniff"
        );
    }

    #[test]
    fn resniff_overrides_a_lying_catalog_content_type() {
        // The catalog says the blob is a PDF, but the actual bytes are a
        // PNG. The handler must serve image/png (re-sniffed), NOT the
        // catalog hint. Note: the content_type is bound into the AAD, so
        // the blob must be ENCODED under the same (lying) hint for decode
        // to succeed — we seed it as "application/pdf" but with PNG bytes.
        let tmp = ScopedTempDir::new("scheme-resniff").unwrap();
        seed_vault_meta(tmp.path());
        let id = seed_attachment(tmp.path(), PNG_BYTES, "application/pdf");

        let resp = build_response(tmp.path(), &keys(), &id);
        assert_eq!(resp.status(), http::StatusCode::OK);
        // Served type is the RE-SNIFFED PNG, not the catalog's pdf hint.
        assert_eq!(
            resp.headers().get(http::header::CONTENT_TYPE).unwrap(),
            "image/png"
        );
    }

    #[test]
    fn unrecognized_bytes_fall_back_to_octet_stream() {
        // Bytes that don't sniff to anything allowlisted → served as
        // octet-stream (non-scriptable), never text/html.
        let tmp = ScopedTempDir::new("scheme-octet").unwrap();
        seed_vault_meta(tmp.path());
        let mystery = b"\x00\x01\x02 not a known format \x03\x04";
        let id = seed_attachment(tmp.path(), mystery, "application/octet-stream");

        let resp = build_response(tmp.path(), &keys(), &id);
        assert_eq!(resp.status(), http::StatusCode::OK);
        assert_eq!(
            resp.headers().get(http::header::CONTENT_TYPE).unwrap(),
            "application/octet-stream"
        );
    }

    // ---- error paths ----------------------------------------------------

    #[test]
    fn malformed_id_is_forbidden() {
        let tmp = ScopedTempDir::new("scheme-badid").unwrap();
        seed_vault_meta(tmp.path());
        let resp = build_response(tmp.path(), &keys(), "not-hex");
        assert_eq!(resp.status(), http::StatusCode::FORBIDDEN);
        assert!(resp.body().is_empty());
    }

    #[test]
    fn absent_blob_is_not_found() {
        let tmp = ScopedTempDir::new("scheme-absent").unwrap();
        seed_vault_meta(tmp.path());
        // Valid-shape id that was never stored (no catalog entry, no blob).
        let id = "ab".repeat(32);
        let resp = build_response(tmp.path(), &keys(), &id);
        assert_eq!(resp.status(), http::StatusCode::NOT_FOUND);
    }

    #[test]
    fn wrong_items_key_decode_fail_is_forbidden_not_distinguishing() {
        let tmp = ScopedTempDir::new("scheme-wrongkey").unwrap();
        seed_vault_meta(tmp.path());
        let id = seed_attachment(tmp.path(), PNG_BYTES, "image/png");
        // Serve with a WRONG items_key → decode fails → 403 (non-
        // distinguishing from tamper / cross-vault).
        let mut wrong = keys();
        wrong.items_key = Zeroizing::new([0xEE; 32]);
        let resp = build_response(tmp.path(), &wrong, &id);
        assert_eq!(resp.status(), http::StatusCode::FORBIDDEN);
    }

    #[test]
    fn tampered_blob_is_forbidden() {
        let tmp = ScopedTempDir::new("scheme-tamper").unwrap();
        seed_vault_meta(tmp.path());
        let id = seed_attachment(tmp.path(), PNG_BYTES, "image/png");
        // Flip a ciphertext byte in the stored blob.
        let blob_path = tmp.path().join("attachments").join(&id);
        let mut blob = std::fs::read(&blob_path).unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0xFF;
        std::fs::write(&blob_path, &blob).unwrap();

        let resp = build_response(tmp.path(), &keys(), &id);
        assert_eq!(resp.status(), http::StatusCode::FORBIDDEN);
    }

    #[test]
    fn canned_responses_are_octet_stream_never_html() {
        for r in [forbidden(), not_found(), bad_request(), server_error()] {
            assert_eq!(
                r.headers().get(http::header::CONTENT_TYPE).unwrap(),
                "application/octet-stream",
                "error responses must never be a scriptable content-type"
            );
            assert!(r.body().is_empty());
        }
    }
}
