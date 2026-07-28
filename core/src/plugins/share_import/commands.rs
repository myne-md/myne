// SPDX-License-Identifier: AGPL-3.0
//! `share_import` plugin commands — the share-import staging queue
//! (`protocol.md` § 9.20).
//!
//! Device-key based (they do NOT touch the vault runtime, so `seal_share` works
//! while the vault is locked), except `drain_pending_shares`, which needs the
//! unlocked vault to import:
//! - **`seal_share`** — frame `{filename, mime, bytes}` and seal it into a
//!   `MYF1` blob under `sealed/`. This is the **Android** entry point (the
//!   Kotlin plugin hands the `content://` bytes to the WebView, which invokes
//!   it). On iOS the Share Extension links no crypto — it stages plaintext
//!   (§9.20.1), and `drain_pending_shares` seals those via `seal_staged_in_dir`.
//! - **`drain_pending_shares`** — decrypt every `sealed/` blob and import each
//!   into the vault's attachment library via `attachment_import_with_dir`
//!   (host-side — the up-to-64 MiB bytes never cross the WebView, SYNC-4),
//!   ack-after-success (at-least-once). Runs on unlock (SF4's JS trigger).
//! - **`share_ack`** — delete a drained entry by its hex `share_id`.
//!
//! Drain is **at-least-once**: `drain_in_dir` does not delete on read; only
//! `ack` (post-import) deletes, so a crash between import and ack re-drains that
//! entry into a rare dedup hit (harmless — content-addressed). The process-wide
//! `QUEUE_LOCK` serialises the filesystem operations regardless of caller.
//!
//! The OS-free `*_in_dir` cores take explicit dirs + a supplied key, so they
//! unit-test end-to-end without a keychain or an `AppHandle`.

use std::path::Path;

use getrandom::getrandom;
use protocol::share_import_blob::{
    decode_share_import_blob, encode_share_import_blob, MAX_SHARE_IMPORT_PLAINTEXT_LEN,
};
use serde::Serialize;
use tauri::{AppHandle, Runtime, State};
use zeroize::Zeroizing;

use super::device_key;
use super::error::ShareImportError;
use super::frame::{self, StagedShare};
use super::queue;
use crate::io_failure_kind::from_io_error_kind;
use crate::plugins::attachments::commands::{attachment_import_with_dir, ImportSource};
use crate::plugins::attachments::error::AttachmentImportError;
use crate::plugins::vault_unlock::state::VaultRuntimeState;

/// Serialises all queue filesystem operations across concurrent command
/// invocations (a share arriving mid-drain, or a StrictMode double-mount).
static QUEUE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// One imported share handed back to the WebView for the SF5 confirmation
/// (SYNC-9): the stored attachment id + display filename + whether it was a
/// dedup hit (a re-share of identical bytes).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ImportedShare {
    /// The content-addressed attachment id (hex) in the library.
    pub id: String,
    /// The display filename recorded in the catalog.
    pub filename: String,
    /// `true` when the file already existed (dedup hit — no new blob written).
    pub deduplicated: bool,
}

fn io(e: std::io::Error) -> ShareImportError {
    ShareImportError::Io(from_io_error_kind(e.kind()))
}

/// Frame `{filename, mime, file_bytes}` and seal it into a `MYF1` blob under
/// `sealed`. Drops an empty file (nothing to import) or an over-cap framed
/// plaintext (SYNC-11 — a poison-oversize entry would re-fail every drain
/// forever). Returns the new `share_id`, or `None` if the entry was dropped.
pub fn seal_share_in_dir(
    sealed: &Path,
    key: &[u8; 32],
    filename: &str,
    mime: &str,
    file_bytes: &[u8],
) -> Result<Option<[u8; 16]>, ShareImportError> {
    if file_bytes.is_empty() {
        return Ok(None);
    }
    let framed = Zeroizing::new(frame::frame_record(filename, mime, file_bytes));
    if framed.len() > MAX_SHARE_IMPORT_PLAINTEXT_LEN {
        return Ok(None);
    }
    queue::ensure_dir(sealed)?;
    let mut id = [0u8; 16];
    getrandom(&mut id).map_err(|_| ShareImportError::Backend)?;
    let blob =
        encode_share_import_blob(key, &id, &framed).map_err(|_| ShareImportError::Backend)?;
    let out = sealed.join(queue::hex_lower(&id));
    crate::atomic_write::atomic_write_private(&out, &blob, true).map_err(io)?;
    Ok(Some(id))
}

/// Seal every plaintext file the native iOS Share Extension dropped in `staging`
/// into a `MYF1` blob under `sealed`, deleting the plaintext. The extension
/// writes two files per share: `<uuid>` (the raw file bytes) and `<uuid>.meta`
/// (UTF-8 `"<mime>\n<filename>"`; the filename is everything after the first
/// newline, so a filename may itself contain newlines). A `<uuid>` with no
/// `.meta` (extension crashed mid-write) is still sealed with a default
/// filename/octet-stream rather than lost. Runs app-side under the app's own
/// device key, so no cross-process keychain sharing is needed. Returns the count
/// sealed. Mirrors the watch-capture `seal_staged_in_dirs` (§9.18).
pub fn seal_staged_in_dir(
    staging: &Path,
    sealed: &Path,
    key: &[u8; 32],
) -> Result<u32, ShareImportError> {
    let mut count = 0u32;
    for path in queue::list_files(staging) {
        // Skip the `.meta` sidecars — they are consumed alongside their `<uuid>`.
        if path.extension().and_then(|e| e.to_str()) == Some("meta") {
            continue;
        }
        let bytes = match std::fs::read(&path) {
            Ok(b) => Zeroizing::new(b),
            Err(_) => continue,
        };
        // Read the sidecar `<uuid>.meta` (best-effort; default if absent/corrupt).
        let meta_path = path.with_extension("meta");
        let (mime, filename) = match std::fs::read_to_string(&meta_path) {
            Ok(s) => {
                let mut lines = s.splitn(2, '\n');
                let mime = lines.next().unwrap_or("").trim().to_string();
                let filename = lines.next().unwrap_or("").to_string();
                let mime = if mime.is_empty() {
                    "application/octet-stream".to_string()
                } else {
                    mime
                };
                let filename = if filename.is_empty() {
                    "shared".to_string()
                } else {
                    filename
                };
                (mime, filename)
            }
            Err(_) => ("application/octet-stream".to_string(), "shared".to_string()),
        };
        // Seal (frames internally); drops empty/oversize. Delete the plaintext +
        // sidecar only after a successful seal (or an intentional drop) so a
        // transient failure retries next open.
        match seal_share_in_dir(sealed, key, &filename, &mime, &bytes) {
            Ok(_) => {
                let _ = std::fs::remove_file(&path);
                let _ = std::fs::remove_file(&meta_path);
                count += 1;
            }
            Err(_) => { /* leave both for the next attempt */ }
        }
    }
    Ok(count)
}

/// Decrypt every `MYF1` blob in `sealed` and return the framed shares. A blob
/// that cannot be decoded (corrupt / wrong-key) or unframed (malformed) is
/// deleted and skipped — it can never become an attachment. Does NOT delete
/// decoded entries (that is `ack`'s job — the at-least-once contract).
pub fn drain_in_dir(sealed: &Path, key: &[u8; 32]) -> Result<Vec<StagedShare>, ShareImportError> {
    let mut out = Vec::new();
    for path in queue::list_files(sealed) {
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) if queue::is_share_id(n) => n.to_string(),
            // Stray non-queue file — leave it alone, skip.
            _ => continue,
        };
        let blob = match std::fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        match decode_share_import_blob(key, &blob) {
            Ok(pt) => match frame::unframe_record(&pt) {
                Some((filename, mime, bytes)) => out.push(StagedShare {
                    id: name,
                    filename,
                    mime,
                    bytes: Zeroizing::new(bytes),
                }),
                // Decrypted but malformed framing — cannot become an attachment.
                None => {
                    let _ = std::fs::remove_file(&path);
                }
            },
            // Corrupt / foreign / wrong-key — drop, do not error.
            Err(_) => {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    Ok(out)
}

/// Delete a drained entry by its hex `share_id`. A non-hex id is rejected
/// (path-traversal guard); an already-absent entry is a successful ack.
pub fn ack_in_dir(sealed: &Path, id: &str) -> Result<(), ShareImportError> {
    if !queue::is_share_id(id) {
        return Err(ShareImportError::Backend);
    }
    match std::fs::remove_file(sealed.join(id)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io(e)),
    }
}

/// Seal a shared file into the encrypted queue. Device-key based, so it runs
/// while the vault is locked. The **Android** Kotlin plugin calls this (via the
/// WebView) with the `content://` bytes; on iOS the Share Extension links no
/// crypto and instead stages plaintext, which `drain_pending_shares` seals via
/// `seal_staged_in_dir` (§9.20.1). Returns the hex `share_id`, or `None` when the
/// file was dropped (empty / over the 64 MiB cap).
#[tauri::command]
pub async fn seal_share<R: Runtime>(
    app: AppHandle<R>,
    filename: String,
    mime: String,
    bytes: Vec<u8>,
) -> Result<Option<String>, ShareImportError> {
    let bytes = Zeroizing::new(bytes);
    let _guard = QUEUE_LOCK.lock().await;
    let sealed = queue::sealed_dir(&app)?;
    let key = device_key::resolve(&app)?;
    let id = seal_share_in_dir(&sealed, &key, &filename, &mime, &bytes)?;
    Ok(id.map(|b| queue::hex_lower(&b)))
}

/// Drain the staging queue into the vault's attachment library. Decrypts each
/// sealed blob host-side and calls `attachment_import` directly (the up-to-64
/// MiB bytes never cross the WebView, SYNC-4). At-least-once: ack only after a
/// successful import; on re-lock, stop and leave the rest queued; any other
/// import failure leaves that entry for the next drain (best-effort). Returns
/// the SYNC-9 `{id, filename, deduplicated}` list for the SF5 confirmation.
#[tauri::command]
pub async fn drain_pending_shares<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
) -> Result<Vec<ImportedShare>, ShareImportError> {
    let _guard = QUEUE_LOCK.lock().await;
    let sealed = queue::sealed_dir(&app)?;
    let staging = queue::staging_dir(&app)?;
    let staging_files = queue::list_files(&staging).len();
    let sealed_files = queue::list_files(&sealed).len();
    tracing::info!(
        stage = "share_import_drain",
        staging = %staging.display(),
        staging_files,
        sealed = %sealed.display(),
        sealed_files,
        "drain: scanning queue"
    );
    // Nothing staged AND nothing sealed → done (no key needed).
    if staging_files == 0 && sealed_files == 0 {
        return Ok(Vec::new());
    }
    let key = device_key::resolve(&app)?;
    // (iOS plaintext-staging) Seal any files the Share Extension dropped as
    // plaintext into `staging/` (it can't link the crypto), THEN drain `sealed/`.
    // Both use the app's own device key — no cross-process keychain sharing.
    let sealed_now = seal_staged_in_dir(&staging, &sealed, &key)?;
    if sealed_now > 0 {
        tracing::info!(
            stage = "share_import_drain",
            sealed_now,
            "drain: sealed staged plaintext files"
        );
    }
    let staged = drain_in_dir(&sealed, &key)?;
    tracing::info!(
        stage = "share_import_drain",
        decrypted = staged.len(),
        sealed_files,
        "drain: decrypted (decrypted < sealed_files ⇒ some blobs were undecryptable and dropped — likely a device-key/keychain mismatch)"
    );
    if staged.is_empty() {
        return Ok(Vec::new());
    }

    let dir = crate::paths::active_vault_root_io(&app, state.active_vault_id().await)
        .map_err(|_| ShareImportError::Backend)?;

    let mut imported = Vec::new();
    for share in staged {
        let source = ImportSource::Bytes {
            bytes: share.bytes.to_vec(),
            filename: Some(share.filename.clone()),
        };
        // `share_import` is host-only (cfg `tauri-ipc` + not wasm32), so the
        // two seams it hands the import are always the native ones.
        match attachment_import_with_dir(
            &crate::vault_io::StdVaultIo,
            &crate::host::tauri_host::TauriHost::new(app.clone()),
            &dir,
            state.inner(),
            source,
        )
        .await
        {
            Ok(att) => {
                // A fresh (non-dedup) import is a local sync change.
                if !att.deduplicated {
                    hooks.bump_local_change();
                }
                // Ack only after the import succeeded (at-least-once).
                let _ = ack_in_dir(&sealed, &share.id);
                imported.push(ImportedShare {
                    id: att.id,
                    filename: att.filename,
                    deduplicated: att.deduplicated,
                });
            }
            // Re-locked mid-drain — stop and leave the rest queued for the next
            // unlock (the captures contract).
            Err(AttachmentImportError::Locked) => break,
            // Any other failure: leave this entry queued, keep going.
            Err(_) => {}
        }
    }
    tracing::info!(
        stage = "share_import_drain",
        imported = imported.len(),
        "drain: imported into the attachment library"
    );
    Ok(imported)
}

/// Acknowledge (delete) a drained share once its attachment has been imported.
#[tauri::command]
pub async fn share_ack<R: Runtime>(app: AppHandle<R>, id: String) -> Result<(), ShareImportError> {
    let _guard = QUEUE_LOCK.lock().await;
    let sealed = queue::sealed_dir(&app)?;
    ack_in_dir(&sealed, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: [u8; 32] = [0x5a; 32];

    fn tmp() -> std::path::PathBuf {
        let mut sfx = [0u8; 8];
        getrandom(&mut sfx).unwrap();
        let d =
            std::env::temp_dir().join(format!("myne-share-import-test-{}", queue::hex_lower(&sfx)));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn seal_drain_ack_round_trip() {
        let root = tmp();
        let sealed = root.join("sealed");

        let bytes = [0x00u8, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a];
        let id = seal_share_in_dir(&sealed, &KEY, "photo.png", "image/png", &bytes)
            .unwrap()
            .expect("sealed");
        assert_eq!(queue::list_files(&sealed).len(), 1, "one MYF1 blob");

        let staged = drain_in_dir(&sealed, &KEY).unwrap();
        assert_eq!(staged.len(), 1);
        assert_eq!(staged[0].filename, "photo.png");
        assert_eq!(staged[0].mime, "image/png");
        assert_eq!(staged[0].bytes.as_slice(), &bytes);
        // Drain does NOT delete (at-least-once).
        assert_eq!(queue::list_files(&sealed).len(), 1);

        ack_in_dir(&sealed, &queue::hex_lower(&id)).unwrap();
        assert_eq!(queue::list_files(&sealed).len(), 0, "acked → empty");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn seal_staged_reads_extension_files_and_drains() {
        let root = tmp();
        let staging = root.join("staging");
        let sealed = root.join("sealed");
        std::fs::create_dir_all(&staging).unwrap();

        // Simulate what the iOS Share Extension writes: raw bytes + a `.meta`
        // sidecar ("<mime>\n<filename>").
        let bytes = [0x00u8, 0xff, 0x89, 0x50, 0x4e, 0x47];
        std::fs::write(staging.join("11111111-1111-1111-1111-111111111111"), bytes).unwrap();
        std::fs::write(
            staging.join("11111111-1111-1111-1111-111111111111.meta"),
            "image/png\nphoto.png",
        )
        .unwrap();
        // A byte file with NO meta (extension crashed mid-write) — must still seal.
        std::fs::write(
            staging.join("22222222-2222-2222-2222-222222222222"),
            b"hello",
        )
        .unwrap();

        let n = seal_staged_in_dir(&staging, &sealed, &KEY).unwrap();
        assert_eq!(n, 2, "both staged files sealed");
        assert_eq!(
            queue::list_files(&staging).len(),
            0,
            "staging drained (plaintext deleted)"
        );
        assert_eq!(queue::list_files(&sealed).len(), 2, "two MYF1 blobs");

        // The sealed blobs drain + unframe correctly, meta preserved.
        let staged = drain_in_dir(&sealed, &KEY).unwrap();
        assert_eq!(staged.len(), 2);
        let png = staged
            .iter()
            .find(|s| s.filename == "photo.png")
            .expect("photo.png");
        assert_eq!(png.mime, "image/png");
        assert_eq!(png.bytes.as_slice(), &bytes);
        // The meta-less entry got the defaults.
        let dflt = staged
            .iter()
            .find(|s| s.filename == "shared")
            .expect("default-named");
        assert_eq!(dflt.mime, "application/octet-stream");
        assert_eq!(dflt.bytes.as_slice(), b"hello");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_and_oversize_dropped_at_seal() {
        let root = tmp();
        let sealed = root.join("sealed");

        // Empty file → dropped (None), nothing written.
        assert!(seal_share_in_dir(&sealed, &KEY, "e.txt", "text/plain", &[])
            .unwrap()
            .is_none());

        // Over-cap framed plaintext → dropped (None). Build a file that pushes
        // the framed record just past the cap.
        let big = vec![0x61u8; MAX_SHARE_IMPORT_PLAINTEXT_LEN + 1];
        assert!(
            seal_share_in_dir(&sealed, &KEY, "big.bin", "application/octet-stream", &big)
                .unwrap()
                .is_none()
        );

        assert_eq!(queue::list_files(&sealed).len(), 0, "neither was sealed");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn wrong_key_entry_is_dropped_not_errored() {
        let root = tmp();
        let sealed = root.join("sealed");
        seal_share_in_dir(
            &sealed,
            &KEY,
            "s.dat",
            "application/octet-stream",
            b"secret",
        )
        .unwrap();

        // Drain under a DIFFERENT key → the entry is undecryptable, so it is
        // dropped (empty result, file removed) rather than surfacing an error.
        let other = [0x11u8; 32];
        let staged = drain_in_dir(&sealed, &other).unwrap();
        assert_eq!(staged.len(), 0);
        assert_eq!(queue::list_files(&sealed).len(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn ack_rejects_non_hex_id_path_traversal() {
        let root = tmp();
        let sealed = root.join("sealed");
        std::fs::create_dir_all(&sealed).unwrap();
        assert_eq!(
            ack_in_dir(&sealed, "../../etc/passwd"),
            Err(ShareImportError::Backend)
        );
        // A valid-form but absent id is a successful (idempotent) ack.
        assert!(ack_in_dir(&sealed, &"a".repeat(32)).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }
}
