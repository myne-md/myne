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
//! See: `src-tauri/AGENTS.md` "Secret-handling logging discipline" — the
//! decrypted bytes, the blob bytes, the id, and paths are DENY-listed; only the
//! served `&'static str` MIME label + a coarse status crosses a tracing boundary.

use super::commands::hex_decode_id;
use super::sniff::served_content_type;
use protocol::{
    decode_attachment_blob, meta_version_of, AttachmentsCatalog, MetaVersion,
    VAULT_META_ACCOUNT_HASH_LEN,
};
use std::path::Path;
use tauri::http;
use zeroize::Zeroizing;

/// Material cloned out of the unlocked slot for one serve. `items_key` is
/// `Zeroizing` (wipes on drop) and `shared` is the session's shared singleton
/// tier (the catalog / extracted-text KEKs derive from it, root-tier for a
/// pre-B2B vault and group-tier for an `NTV6` one); `items_key_id` is the
/// non-secret singleton UUIDv7. Fields are `pub` so each host's `serve` can
/// construct it from `state.peek_unlocked_attachment_material()`.
pub struct ServeKeys {
    pub items_key: Zeroizing<[u8; 32]>,
    pub items_key_id: [u8; 16],
    pub shared: crate::plugins::vault_unlock::state::SharedSingletonKey,
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
    let (meta_version, account_number_hash) =
        match read_account_number_hash(&vault_dir.join("vault.meta")) {
            Some(pair) => pair,
            None => return server_error(),
        };
    let catalog_key = keys
        .shared
        .derive(meta_version, protocol::SubkeyRole::AttachmentsCatalogKey);
    let catalog = read_catalog(
        &vault_dir.join("vault.attachments"),
        &catalog_key,
        &account_number_hash,
        meta_version,
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

    // RE-SNIFF the decrypted bytes. The rule and its rationale live in
    // `sniff::served_content_type`, which the browser's object-URL mint (task
    // 44) calls too — the one place this security decision is written down.
    let served_type = served_content_type(&plaintext);

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

// ---- text preview (MYND-268 Tier-1) -------------------------------------

/// Preview size cap. A Tier-1 text/code/csv preview is a READER, not an editor;
/// a multi-MiB dump would jank the WebView, so decrypted text beyond this is
/// truncated (the user still has full-fidelity Export). Measured in bytes of the
/// decrypted plaintext, pre-decode.
pub const ATTACHMENT_TEXT_PREVIEW_CAP: usize = 2 * 1024 * 1024;

/// Outcome of reading an attachment's decrypted TEXT for an inline preview. The
/// text crosses IPC as plaintext — same secret class as a note body
/// (`src-tauri/AGENTS.md` "Plaintext IPC"); the caller must never log it. Non-`Ok`
/// variants are non-distinguishing at the boundary (a wrong-key / tampered /
/// cross-vault blob all collapse to `Denied`, mirroring the serve path's §6.4).
pub enum ReadTextOutcome {
    /// Decrypted text, lossily UTF-8-decoded, truncated at the preview cap.
    Ok { text: String, truncated: bool },
    /// The id / catalog entry / blob file was absent.
    NotFound,
    /// Malformed id, or a decode failure (non-distinguishing).
    Denied,
    /// Host / IO failure reading `vault.meta` or the blob.
    ServerError,
}

/// Non-distinguishing decode failure, shared by the text + structured previews.
pub enum DecodeError {
    NotFound,
    Denied,
    ServerError,
}

/// Shared decode: id parse → catalog `content_type` hint (the inner AAD) → read
/// blob → `decode_attachment_blob` → the Zeroizing plaintext bytes. The SAME
/// decode as the serve path, minus the re-sniff (callers render inert text /
/// structured previews, never an interpreted content-type). A wrong-key /
/// tampered / cross-vault blob all collapse to `Denied` (§6.4).
pub fn decode_attachment_plaintext(
    vault_dir: &Path,
    keys: &ServeKeys,
    id_hex: &str,
) -> Result<Zeroizing<Vec<u8>>, DecodeError> {
    let Some(attachment_id) = hex_decode_id(id_hex) else {
        return Err(DecodeError::Denied);
    };
    let (meta_version, account_number_hash) =
        read_account_number_hash(&vault_dir.join("vault.meta")).ok_or(DecodeError::ServerError)?;
    let catalog_key = keys
        .shared
        .derive(meta_version, protocol::SubkeyRole::AttachmentsCatalogKey);
    let catalog = read_catalog(
        &vault_dir.join("vault.attachments"),
        &catalog_key,
        &account_number_hash,
        meta_version,
    );
    let content_type_hint = catalog
        .entries
        .get(id_hex)
        .map(|meta| meta.content_type.clone())
        .ok_or(DecodeError::NotFound)?;
    let blob_path = vault_dir.join("attachments").join(id_hex);
    let blob = match std::fs::read(&blob_path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(DecodeError::NotFound),
        Err(e) => {
            tracing::error!(
                stage = "read_attachment_blob_read",
                io_failure_kind = ?crate::io_failure_kind::from_io_error_kind(e.kind()),
                "attachment preview blob read failed"
            );
            return Err(DecodeError::ServerError);
        }
    };
    decode_attachment_blob(
        &blob,
        &attachment_id,
        content_type_hint.as_bytes(),
        &keys.items_key,
        &keys.items_key_id,
    )
    .map_err(|_| DecodeError::Denied)
}

/// Testable core of the Tier-1 attachment text preview (MYND-268): decode the
/// `MYA1` blob and return its plaintext as (lossy) UTF-8 text, capped for
/// preview. Reuses the SAME decode path as [`build_response`] but does NOT
/// re-sniff or allowlist — the caller renders the result as inert TEXT (a
/// read-only viewer / table / markdown render), never as an interpreted
/// content-type, so there is no serve-time XSS surface here (that defense stays
/// on the `attachment://` serve path). The `Zeroizing` plaintext wipes on drop;
/// the returned `String` is the accepted non-Zeroized intermediate (V8-leak
/// dominance, per the discipline).
pub fn read_attachment_text(vault_dir: &Path, keys: &ServeKeys, id_hex: &str) -> ReadTextOutcome {
    let plaintext = match decode_attachment_plaintext(vault_dir, keys, id_hex) {
        Ok(p) => p,
        Err(DecodeError::NotFound) => return ReadTextOutcome::NotFound,
        Err(DecodeError::Denied) => return ReadTextOutcome::Denied,
        Err(DecodeError::ServerError) => return ReadTextOutcome::ServerError,
    };
    let capped_len = plaintext.len().min(ATTACHMENT_TEXT_PREVIEW_CAP);
    let truncated = plaintext.len() > capped_len;
    // Lossy UTF-8: text/code/csv are usually UTF-8; invalid or cap-split bytes
    // become U+FFFD rather than failing (a preview, not a byte-exact round-trip).
    let text = String::from_utf8_lossy(&plaintext[..capped_len]).into_owned();
    drop(plaintext); // explicit wipe of the Zeroizing source
    ReadTextOutcome::Ok { text, truncated }
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

/// Read `vault.meta`'s account_number_hash + its crypto generation; `None` on
/// IO / parse failure. The generation travels with the hash so the serve path
/// derives the catalog KEK under the vault's OWN generation (#420) — a migrated
/// (`NTV5`) vault's `MYC5` catalog needs `derive_subkey_v0_2`.
fn read_account_number_hash(
    vault_meta_path: &Path,
) -> Option<(MetaVersion, [u8; VAULT_META_ACCOUNT_HASH_LEN])> {
    let bytes = std::fs::read(vault_meta_path).ok()?;
    let meta = protocol::parse_vault_meta_any(&bytes).ok()?;
    let version = meta_version_of(&bytes).unwrap_or(MetaVersion::V0_1);
    Some((version, meta.account_number_hash))
}

/// Read + decode the catalog, collapsing any failure to empty
/// (§ 9.10.4). The serve path never writes the catalog, so an
/// empty-on-failure read is non-destructive (a missing entry → 404).
fn read_catalog(
    catalog_path: &Path,
    catalog_key: &[u8; 32],
    account_number_hash: &[u8; VAULT_META_ACCOUNT_HASH_LEN],
    version: MetaVersion,
) -> AttachmentsCatalog {
    match std::fs::read(catalog_path) {
        Ok(bytes) => protocol::read_or_empty_versioned(
            version,
            catalog_key,
            account_number_hash,
            Some(&bytes),
        ),
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
            shared: crate::plugins::vault_unlock::state::SharedSingletonKey::OwnerRoot(
                Zeroizing::new([SEED_ROOT; 32]),
            ),
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
            membership: None,
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
            AttachmentMeta::live(
                content_type.to_string(),
                1_700_000_000,
                "x".to_string(),
                bytes.len() as u64,
            ),
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

    // ---- read_attachment_text (MYND-268 Tier-1) ------------------------

    #[test]
    fn reads_text_attachment_roundtrip() {
        let tmp = ScopedTempDir::new("scheme-text").unwrap();
        seed_vault_meta(tmp.path());
        let body = "line one\nsecond line\n";
        let id = seed_attachment(tmp.path(), body.as_bytes(), "text/plain");

        match read_attachment_text(tmp.path(), &keys(), &id) {
            ReadTextOutcome::Ok { text, truncated } => {
                assert_eq!(text, body);
                assert!(!truncated);
            }
            _ => panic!("expected Ok text"),
        }
    }

    #[test]
    fn read_text_absent_id_is_not_found() {
        let tmp = ScopedTempDir::new("scheme-text-missing").unwrap();
        seed_vault_meta(tmp.path());
        // Syntactically valid (64 hex chars) but never seeded → catalog miss.
        let absent = "ab".repeat(32);
        assert!(matches!(
            read_attachment_text(tmp.path(), &keys(), &absent),
            ReadTextOutcome::NotFound
        ));
    }

    #[test]
    fn read_text_malformed_id_is_denied() {
        let tmp = ScopedTempDir::new("scheme-text-bad").unwrap();
        seed_vault_meta(tmp.path());
        assert!(matches!(
            read_attachment_text(tmp.path(), &keys(), "not-hex!!"),
            ReadTextOutcome::Denied
        ));
    }

    #[test]
    fn read_text_tampered_blob_is_denied() {
        let tmp = ScopedTempDir::new("scheme-text-tamper").unwrap();
        seed_vault_meta(tmp.path());
        let id = seed_attachment(tmp.path(), b"hello world", "text/plain");
        let blob_path = tmp.path().join("attachments").join(&id);
        let mut blob = std::fs::read(&blob_path).unwrap();
        let last = blob.len() - 1;
        blob[last] ^= 0xFF;
        std::fs::write(&blob_path, &blob).unwrap();
        assert!(matches!(
            read_attachment_text(tmp.path(), &keys(), &id),
            ReadTextOutcome::Denied
        ));
    }

    #[test]
    fn read_text_truncates_at_cap() {
        let tmp = ScopedTempDir::new("scheme-text-cap").unwrap();
        seed_vault_meta(tmp.path());
        let big = "a".repeat(ATTACHMENT_TEXT_PREVIEW_CAP + 100);
        let id = seed_attachment(tmp.path(), big.as_bytes(), "text/plain");
        match read_attachment_text(tmp.path(), &keys(), &id) {
            ReadTextOutcome::Ok { text, truncated } => {
                assert_eq!(text.len(), ATTACHMENT_TEXT_PREVIEW_CAP);
                assert!(truncated);
            }
            _ => panic!("expected Ok truncated"),
        }
    }
}
