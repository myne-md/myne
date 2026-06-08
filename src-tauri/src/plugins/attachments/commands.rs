//! `attachments` Tauri command handlers (MYND-169 — the
//! `attachments-crypto-pipeline` sub-feature, SYNC-8).
//!
//! - [`attachment_import`] — `Slot::Unlocked`-gated import of inline
//!   bytes (paste/drop) or a path (picker). Sniffs + validates type
//!   against the allowlist, enforces the 64 MiB cap, computes the
//!   content-addressed `attachment_id`, **dedups** (id-existence check),
//!   else encrypts the `MYA1` blob + upserts the `MYC1` catalog. Returns
//!   the id (hex) + the stored metadata.
//! - [`catalog_list`] — `Slot::Unlocked`-gated read of the full
//!   catalog metadata for the library UI (fall-back-to-empty per
//!   § 9.10.4).
//! - [`attachment_delete`] — `Slot::Unlocked`-gated explicit delete of
//!   one attachment (blob + catalog entry). NO auto-GC; the reference
//!   graph is the UI's concern.
//!
//! All crypto is host-side: `items_key` (from the unlocked slot) and the
//! catalog KEK (`DeriveSubkey(root_key, AttachmentsCatalogKey)`) never
//! cross IPC. The import path first-line-`Zeroizing`-wraps the source
//! bytes per the Plaintext-IPC pattern.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use super::error::{
    AttachmentDeleteError, AttachmentImportError, AttachmentRenameError, CatalogListError,
};
use super::sniff::sniff_content_type;
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use protocol::{
    compute_attachment_id, derive_subkey, encode_attachment_blob, encode_attachments_catalog,
    parse_vault_meta, read_or_empty, AttachmentMeta, AttachmentsCatalog, SubkeyRole,
    ATTACHMENT_ID_LEN, CATALOG_BLOB_ACCOUNT_HASH_LEN, MAX_ATTACHMENT_LEN,
    VAULT_META_ACCOUNT_HASH_LEN,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, Runtime, State};
use tokio::sync::Mutex;
use zeroize::Zeroizing;

/// The inclusive 64 MiB import cap, surfaced in the `Oversize` error so
/// the UI can render the limit without hardcoding it. Equal to
/// [`protocol::MAX_ATTACHMENT_LEN`].
pub const MAX_ATTACHMENT_IMPORT_LEN: usize = MAX_ATTACHMENT_LEN;

/// Per-plugin catalog write serialization. The catalog is a vault
/// singleton (`vault.attachments`); concurrent imports/deletes
/// read-modify-write it, so they must serialize to avoid a lost update.
/// `OnceLock<Mutex<()>>`, lazily initialized — same shape as
/// `prefs::commands::write_mutex`.
fn catalog_write_mutex() -> &'static Mutex<()> {
    static M: OnceLock<Mutex<()>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(()))
}

/// Resolve `<app_data_dir>/vault/` for the current Tauri app.
fn vault_dir<R: Runtime>(app: &AppHandle<R>) -> std::io::Result<PathBuf> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|_| std::io::Error::other("app_data_dir resolution failed"))?;
    Ok(base.join("vault"))
}

/// The `source` argument to [`attachment_import`].
///
/// `Bytes` is the paste / drop path: the WebView hands the raw file
/// bytes inline (base64-decoded by Tauri's IPC layer into a `Vec<u8>`)
/// plus the caller-claimed `filename` (for the catalog display name; the
/// actual content-type is always re-sniffed, never trusted from here).
/// `Path` is the picker / OS-drop path: the host reads the file itself.
///
/// Serde is internally tagged (`{"kind":"bytes","bytes":[..],"filename":".."}`
/// / `{"kind":"path","path":".."}`) so the TS side is a discriminated
/// union. Hand-mirrored by the insert UX (sub-feature 5).
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum ImportSource {
    /// Inline bytes (paste / in-WebView drop). `filename` is the
    /// caller-supplied display name; if `None`, a name is auto-generated
    /// from the sniffed content-type.
    Bytes {
        bytes: Vec<u8>,
        filename: Option<String>,
    },
    /// A filesystem path (native picker / OS drag-drop). The host reads
    /// the bytes; the display filename is derived from the path's final
    /// component.
    Path { path: String },
}

/// The success payload of [`attachment_import`] — the stored id (hex)
/// plus its catalog metadata, so the caller can render the attachment
/// immediately without a follow-up `catalog_list`.
///
/// Hand-mirrored on the TS side by the insert / library consumers.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ImportedAttachment {
    /// The content-addressed attachment-id, lowercase hex (64 chars).
    /// This is the on-disk filename and the `attachment://<id>` path.
    pub id: String,
    /// The re-sniffed allowlisted MIME (authoritative, not the
    /// caller-claimed type).
    pub content_type: String,
    /// The display filename stored in the catalog.
    pub filename: String,
    /// The file size in bytes.
    pub size: u64,
    /// Creation timestamp (UNIX seconds) recorded in the catalog. For a
    /// dedup hit this is the ORIGINAL import's timestamp (the existing
    /// entry is returned verbatim, not overwritten).
    pub created_at: u64,
    /// `true` when this id already existed (dedup hit — no new blob was
    /// written); `false` when a fresh blob + catalog entry were created.
    pub deduplicated: bool,
}

/// Lowercase-hex-encode a byte slice (no separators). Used for the
/// on-disk attachment filename + the catalog key + the IPC id string.
fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).expect("high nibble < 16"));
        s.push(char::from_digit((b & 0x0F) as u32, 16).expect("low nibble < 16"));
    }
    s
}

/// Decode a 64-char lowercase-hex attachment-id string into its 32-byte
/// value. Returns `None` on any malformation (wrong length, non-hex, or
/// uppercase — the canonical form is lowercase). Strict: this is the
/// inverse of [`hex_encode`] for an [`ATTACHMENT_ID_LEN`]-byte id.
fn hex_decode_id(s: &str) -> Option<[u8; ATTACHMENT_ID_LEN]> {
    if s.len() != ATTACHMENT_ID_LEN * 2 {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = [0u8; ATTACHMENT_ID_LEN];
    for (i, out_byte) in out.iter_mut().enumerate() {
        let hi = hex_val(bytes[i * 2])?;
        let lo = hex_val(bytes[i * 2 + 1])?;
        *out_byte = (hi << 4) | lo;
    }
    Some(out)
}

/// Map one lowercase-hex ASCII digit to its value, rejecting uppercase
/// (canonical attachment-ids are lowercase) and non-hex bytes.
fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    }
}

/// Read `vault.meta` and return its 16-byte `account_number_hash`
/// (offset 6), the binding identity for the catalog AAD (§ 9.10.3).
/// Generic over the caller's error type via the two `From` impls.
fn read_account_number_hash(
    vault_meta_path: &Path,
) -> std::io::Result<Result<[u8; VAULT_META_ACCOUNT_HASH_LEN], MetaParseFailed>> {
    let bytes = std::fs::read(vault_meta_path)?;
    Ok(parse_vault_meta(&bytes)
        .map(|m| m.account_number_hash)
        .map_err(|_| MetaParseFailed))
}

/// Zero-sized marker for a `vault.meta` parse failure, mapped to each
/// command's `InvalidVaultMeta` variant at the call site.
struct MetaParseFailed;

/// Current UNIX time in whole seconds, saturating at 0 if the clock is
/// before the epoch (cannot happen in practice). Used for the catalog
/// entry's `created_at`.
fn now_unix_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Derive a display filename for a byte-source import when the caller
/// did not supply one: a fixed stem plus the extension implied by the
/// sniffed content-type. (For path imports the final path component is
/// used instead — see [`attachment_import_with_dir`].)
fn auto_filename(content_type: &str) -> String {
    let ext = match content_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "application/pdf" => "pdf",
        _ => "bin",
    };
    format!("attachment.{ext}")
}

// ---- attachment_import --------------------------------------------------

/// `Slot::Unlocked`-gated attachment import. See module-level docs for
/// the full pipeline narration. The Tauri wrapper resolves
/// `app_data_dir` then delegates to [`attachment_import_with_dir`] so
/// tests exercise the core against a `ScopedTempDir` without a Tauri
/// runtime.
#[tauri::command]
pub async fn attachment_import<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    source: ImportSource,
) -> Result<ImportedAttachment, AttachmentImportError> {
    let dir = vault_dir(&app).map_err(AttachmentImportError::from)?;
    attachment_import_with_dir(&dir, state.inner(), source).await
}

/// Testable core of [`attachment_import`].
///
/// Steps: read the source bytes (first-line `Zeroizing`-wrapped),
/// enforce the cap, sniff the type against the allowlist, peek the slot
/// for `(items_key, items_key_id, root_key)`, read the catalog, dedup on
/// the computed id, else encode + `atomic_write` the `MYA1` blob and
/// upsert + `atomic_write` the `MYC1` catalog. Returns the id + metadata.
pub(crate) async fn attachment_import_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    source: ImportSource,
) -> Result<ImportedAttachment, AttachmentImportError> {
    // (1) Materialize the source bytes + the display filename. For the
    //     path arm, the host reads the file. The bytes are wrapped in a
    //     `Zeroizing` on the first non-doc statement of their lifetime so
    //     every early-return drops + wipes them (Plaintext-IPC pattern —
    //     attachment bytes are AS-sensitive plaintext until encrypted).
    let (file_bytes, claimed_filename): (Zeroizing<Vec<u8>>, Option<String>) = match source {
        ImportSource::Bytes { bytes, filename } => (Zeroizing::new(bytes), filename),
        ImportSource::Path { path } => {
            let p = PathBuf::from(path);
            let bytes = std::fs::read(&p).map_err(AttachmentImportError::from)?;
            // Derive the display name from the final path component; the
            // raw path itself is DENY-listed and never logged.
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .map(|s| s.to_string());
            (Zeroizing::new(bytes), name)
        }
    };

    // (2) Cap enforcement BEFORE any allocation-heavy work. The codec
    //     also enforces this, but rejecting here yields the distinct
    //     `Oversize` UX surface instead of a generic encode failure.
    if file_bytes.len() > MAX_ATTACHMENT_IMPORT_LEN {
        tracing::debug!(
            stage = "cap_check",
            error_kind = "Oversize",
            "attachment_import rejected: file exceeds 64 MiB cap"
        );
        return Err(AttachmentImportError::Oversize {
            cap_bytes: MAX_ATTACHMENT_IMPORT_LEN,
        });
    }

    // (3) Content-type sniff against the allowlist. A `.png`-renamed
    //     binary rejects here (content sniff, not extension).
    let content_type = match sniff_content_type(&file_bytes) {
        Some(ct) => ct,
        None => {
            tracing::debug!(
                stage = "sniff",
                error_kind = "UnsupportedType",
                "attachment_import rejected: type not in allowlist"
            );
            return Err(AttachmentImportError::UnsupportedType);
        }
    };
    tracing::debug!(stage = "sniff", content_type = content_type);

    // (4) Slot gate — clone `(items_key, items_key_id, root_key)` out of
    //     the Unlocked slot. `root_key` is needed for BOTH the id-HMAC
    //     subkey (compute_attachment_id) and the catalog KEK
    //     (AttachmentsCatalogKey); `items_key` wraps the per-attachment
    //     key. All three are dropped at function exit (Zeroizing).
    let (items_key, items_key_id, root_key) = state
        .peek_unlocked_attachment_material()
        .await
        .ok_or(AttachmentImportError::Locked)?;
    tracing::debug!(stage = "slot_check", outcome = "vault_unlocked");

    // (5) Read vault.meta → account_number_hash (catalog AAD identity).
    let account_number_hash = match read_account_number_hash(&vault_dir.join("vault.meta"))? {
        Ok(h) => h,
        Err(MetaParseFailed) => return Err(AttachmentImportError::InvalidVaultMeta),
    };

    // (6) Content-addressed id (keyed under root_key; stable within the
    //     vault, no cross-vault equality oracle).
    let attachment_id = compute_attachment_id(&root_key, &file_bytes);
    let id_hex = hex_encode(&attachment_id);

    // (7) Serialize the catalog read-modify-write under the per-plugin
    //     mutex so a concurrent import/delete cannot lose an update.
    let _write_guard = catalog_write_mutex().lock().await;

    // (8) Dedup: read the catalog; if the id already exists, return the
    //     EXISTING entry verbatim (no re-store, no timestamp churn).
    let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
    let catalog_path = vault_dir.join("vault.attachments");
    let mut catalog = read_catalog(&catalog_path, &catalog_key, &account_number_hash)?;

    if let Some(existing) = catalog.entries.get(&id_hex) {
        tracing::debug!(stage = "dedup", outcome = "hit");
        return Ok(ImportedAttachment {
            id: id_hex,
            content_type: existing.content_type.clone(),
            filename: existing.filename.clone(),
            size: existing.size,
            created_at: existing.created_at,
            deduplicated: true,
        });
    }

    // (9) Fresh import. Resolve the display filename (caller-supplied,
    //     else auto from the sniffed type) and the size + timestamp.
    let filename = claimed_filename
        .filter(|f| !f.trim().is_empty())
        .unwrap_or_else(|| auto_filename(content_type));
    let size = file_bytes.len() as u64;
    let created_at = now_unix_secs();

    // (10) Encode the MYA1 blob on a blocking thread (random key + nonces
    //      from getrandom; AEAD seal under items_key → attachment_key).
    //      Move the Zeroizing bytes + the key material into the closure so
    //      they wipe on closure exit.
    let attachments_dir = vault_dir.join("attachments");
    let blob_path = attachments_dir.join(&id_hex);
    let content_type_owned = content_type.to_string();
    let join = tokio::task::spawn_blocking(move || -> Result<(), AttachmentImportError> {
        let blob = encode_attachment_blob(
            &items_key,
            &items_key_id,
            &attachment_id,
            content_type_owned.as_bytes(),
            &file_bytes,
        )
        .map_err(|_| AttachmentImportError::EncodeFailed)?;
        // Ensure the attachments/ directory exists, then create-only
        // write (the id is content-addressed; a pre-existing blob would
        // mean the catalog dedup missed — treat AlreadyExists as a
        // benign already-stored, not an error).
        std::fs::create_dir_all(&attachments_dir)?;
        match crate::atomic_write::atomic_write(&blob_path, &blob, /* replace = */ false) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
            Err(e) => Err(AttachmentImportError::from(e)),
        }
    })
    .await;
    match join {
        Err(_join) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "attachment_import encode/write worker panicked or runtime shutdown"
            );
            return Err(AttachmentImportError::JoinFailure);
        }
        Ok(Err(e)) => {
            tracing::error!(
                stage = "blob_write",
                error_kind = attachment_import_error_kind(&e),
                "attachment_import blob encode/write failed"
            );
            return Err(e);
        }
        Ok(Ok(())) => {}
    }

    // (11) Upsert the catalog entry + atomic-write the catalog. The blob
    //      is already durably on disk; if the catalog write fails the blob
    //      is an orphan (recoverable — a re-import recomputes the same id,
    //      dedup-misses on the absent catalog entry, and the create-only
    //      blob write folds AlreadyExists to Ok, re-adding the entry).
    catalog.entries.insert(
        id_hex.clone(),
        AttachmentMeta {
            content_type: content_type.to_string(),
            created_at,
            filename: filename.clone(),
            size,
        },
    );
    let catalog_bytes = encode_attachments_catalog(&catalog_key, &account_number_hash, &catalog)
        .map_err(|_| AttachmentImportError::EncodeFailed)?;
    crate::atomic_write::atomic_write(&catalog_path, &catalog_bytes, /* replace = */ true)
        .map_err(AttachmentImportError::from)?;

    tracing::info!(stage = "success", event = "attachment_imported");
    Ok(ImportedAttachment {
        id: id_hex,
        content_type: content_type.to_string(),
        filename,
        size,
        created_at,
        deduplicated: false,
    })
}

/// Static-string label for [`AttachmentImportError`] variants — emitted
/// via `tracing` without crossing the IPC boundary or dragging
/// DENY-listed payloads. A new variant compile-fails this match.
fn attachment_import_error_kind(e: &AttachmentImportError) -> &'static str {
    match e {
        AttachmentImportError::Locked => "Locked",
        AttachmentImportError::Oversize { .. } => "Oversize",
        AttachmentImportError::UnsupportedType => "UnsupportedType",
        AttachmentImportError::Io { .. } => "Io",
        AttachmentImportError::InvalidVaultMeta => "InvalidVaultMeta",
        AttachmentImportError::EncodeFailed => "EncodeFailed",
        AttachmentImportError::JoinFailure => "JoinFailure",
    }
}

// ---- catalog_list -------------------------------------------------------

/// One catalog row returned by [`catalog_list`] — the id (hex) plus its
/// metadata. The catalog is keyed by id internally; the IPC shape is a
/// flat list so the TS side renders the library directly.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CatalogEntry {
    /// Attachment-id, lowercase hex (the `attachment://<id>` path).
    pub id: String,
    /// Import-time MIME hint (the handler re-sniffs at serve time; this
    /// is a display hint only, NOT the served header).
    pub content_type: String,
    /// Creation timestamp (UNIX seconds).
    pub created_at: u64,
    /// Display filename.
    pub filename: String,
    /// File size in bytes.
    pub size: u64,
}

/// `Slot::Unlocked`-gated read of the full attachments catalog for the
/// library UI. Fall-back-to-empty on any catalog decode failure
/// (§ 9.10.4) — only the slot gate + the `vault.meta` read surface as
/// errors. Returns the rows sorted by id (the catalog's `BTreeMap`
/// iteration order).
#[tauri::command]
pub async fn catalog_list<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Vec<CatalogEntry>, CatalogListError> {
    let dir = vault_dir(&app).map_err(CatalogListError::from)?;
    catalog_list_with_dir(&dir, state.inner()).await
}

/// Testable core of [`catalog_list`].
pub(crate) async fn catalog_list_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
) -> Result<Vec<CatalogEntry>, CatalogListError> {
    let root_key = state
        .peek_unlocked_root_key_clone()
        .await
        .ok_or(CatalogListError::Locked)?;

    let account_number_hash = match read_account_number_hash(&vault_dir.join("vault.meta"))? {
        Ok(h) => h,
        Err(MetaParseFailed) => return Err(CatalogListError::InvalidVaultMeta),
    };

    let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
    let catalog_path = vault_dir.join("vault.attachments");
    let catalog = read_catalog_or_empty(&catalog_path, &catalog_key, &account_number_hash);

    let rows: Vec<CatalogEntry> = catalog
        .entries
        .into_iter()
        .map(|(id, meta)| CatalogEntry {
            id,
            content_type: meta.content_type,
            created_at: meta.created_at,
            filename: meta.filename,
            size: meta.size,
        })
        .collect();

    tracing::debug!(
        stage = "success",
        event = "catalog_listed",
        count = rows.len()
    );
    Ok(rows)
}

// ---- attachment_delete --------------------------------------------------

/// `Slot::Unlocked`-gated explicit delete of one attachment: removes the
/// blob file and the catalog entry. NO auto-GC — the reference graph is
/// the UI's concern; this is a deliberate user action. Deleting an
/// absent id is idempotent `Ok(())`.
#[tauri::command]
pub async fn attachment_delete<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    id: String,
) -> Result<(), AttachmentDeleteError> {
    let dir = vault_dir(&app).map_err(AttachmentDeleteError::from)?;
    attachment_delete_with_dir(&dir, state.inner(), id).await
}

/// Testable core of [`attachment_delete`].
pub(crate) async fn attachment_delete_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    id: String,
) -> Result<(), AttachmentDeleteError> {
    // Strict id parse FIRST — bug-canary (the UI only hands back catalog
    // ids). The id string itself is DENY-listed; never logged.
    let attachment_id = hex_decode_id(&id).ok_or_else(|| {
        tracing::debug!(stage = "id_parse", error_kind = "InvalidId");
        AttachmentDeleteError::InvalidId
    })?;
    let id_hex = hex_encode(&attachment_id); // canonical lowercase re-encode

    let root_key = state
        .peek_unlocked_root_key_clone()
        .await
        .ok_or(AttachmentDeleteError::Locked)?;

    let account_number_hash = match read_account_number_hash(&vault_dir.join("vault.meta"))
        .map_err(AttachmentDeleteError::from)?
    {
        Ok(h) => h,
        Err(MetaParseFailed) => return Err(AttachmentDeleteError::InvalidVaultMeta),
    };

    let _write_guard = catalog_write_mutex().lock().await;

    let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
    let catalog_path = vault_dir.join("vault.attachments");
    let mut catalog = read_catalog(&catalog_path, &catalog_key, &account_number_hash)
        .map_err(AttachmentDeleteError::from)?;

    // Remove the catalog entry (idempotent — absence is not an error).
    let was_present = catalog.entries.remove(&id_hex).is_some();

    // Remove the blob file (idempotent on NotFound).
    let blob_path = vault_dir.join("attachments").join(&id_hex);
    match std::fs::remove_file(&blob_path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => {
            tracing::error!(
                stage = "blob_unlink",
                error_kind = "Io",
                io_failure_kind = ?crate::io_failure_kind::from_io_error_kind(e.kind()),
                "attachment_delete blob unlink failed"
            );
            return Err(AttachmentDeleteError::from(e));
        }
    }

    // Rewrite the catalog only if we actually removed an entry — avoids a
    // pointless disk write (and a nonce churn) on an already-absent id.
    if was_present {
        let catalog_bytes =
            encode_attachments_catalog(&catalog_key, &account_number_hash, &catalog)
                .map_err(|_| AttachmentDeleteError::EncodeFailed)?;
        crate::atomic_write::atomic_write(&catalog_path, &catalog_bytes, /* replace = */ true)
            .map_err(AttachmentDeleteError::from)?;
    }

    tracing::info!(
        stage = "success",
        event = "attachment_deleted",
        was_present = was_present
    );
    Ok(())
}

// ---- attachment_rename --------------------------------------------------

/// `Slot::Unlocked`-gated free-form rename of one attachment's catalog
/// display filename (MYND-170). Duplicates are allowed — the content-
/// addressed id is the key, the filename is a cosmetic display label, so
/// two entries may carry the same name. Only the `MYC1` catalog entry's
/// `filename` field changes; the blob, the id, and the on-disk filename
/// (the id hex) are untouched. Renaming an absent id is `AttachmentNotFound`
/// (a bug-canary — the UI only hands back catalog ids).
#[tauri::command]
pub async fn attachment_rename<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    id: String,
    filename: String,
) -> Result<(), AttachmentRenameError> {
    let dir = vault_dir(&app).map_err(AttachmentRenameError::from)?;
    attachment_rename_with_dir(&dir, state.inner(), id, filename).await
}

/// Testable core of [`attachment_rename`].
pub(crate) async fn attachment_rename_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    id: String,
    filename: String,
) -> Result<(), AttachmentRenameError> {
    // Strict id parse FIRST — bug-canary (the UI only hands back catalog
    // ids). The id string itself is DENY-listed; never logged.
    let attachment_id = hex_decode_id(&id).ok_or_else(|| {
        tracing::debug!(stage = "id_parse", error_kind = "InvalidId");
        AttachmentRenameError::InvalidId
    })?;
    let id_hex = hex_encode(&attachment_id); // canonical lowercase re-encode

    // Reject an empty / whitespace-only name — a blank display label is a
    // UX error the UI prevents, so this is a bug-canary too. (The catalog
    // can structurally hold any name; the product rule is "non-empty".)
    let filename = filename.trim().to_string();
    if filename.is_empty() {
        return Err(AttachmentRenameError::EmptyFilename);
    }

    let root_key = state
        .peek_unlocked_root_key_clone()
        .await
        .ok_or(AttachmentRenameError::Locked)?;

    let account_number_hash = match read_account_number_hash(&vault_dir.join("vault.meta"))
        .map_err(AttachmentRenameError::from)?
    {
        Ok(h) => h,
        Err(MetaParseFailed) => return Err(AttachmentRenameError::InvalidVaultMeta),
    };

    let _write_guard = catalog_write_mutex().lock().await;

    let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
    let catalog_path = vault_dir.join("vault.attachments");
    let mut catalog = read_catalog(&catalog_path, &catalog_key, &account_number_hash)
        .map_err(AttachmentRenameError::from)?;

    let Some(entry) = catalog.entries.get_mut(&id_hex) else {
        return Err(AttachmentRenameError::AttachmentNotFound);
    };
    entry.filename = filename;

    let catalog_bytes = encode_attachments_catalog(&catalog_key, &account_number_hash, &catalog)
        .map_err(|_| AttachmentRenameError::EncodeFailed)?;
    crate::atomic_write::atomic_write(&catalog_path, &catalog_bytes, /* replace = */ true)
        .map_err(AttachmentRenameError::from)?;

    tracing::info!(stage = "success", event = "attachment_renamed");
    Ok(())
}

// ---- shared catalog read helpers ----------------------------------------

/// Read + decode the catalog, returning a HARD error on any IO failure
/// other than absence (absent file → empty catalog, the § 9.10.4 base
/// case). AEAD / parse failures collapse to empty via
/// [`protocol::read_or_empty`]. Used by the import + delete paths where a
/// genuine IO failure (permission denied) must surface rather than be
/// masked as an empty catalog (which would then be overwritten on the
/// subsequent atomic_write, silently destroying the real catalog).
fn read_catalog(
    catalog_path: &Path,
    catalog_key: &[u8; 32],
    account_number_hash: &[u8; CATALOG_BLOB_ACCOUNT_HASH_LEN],
) -> std::io::Result<AttachmentsCatalog> {
    match std::fs::read(catalog_path) {
        Ok(bytes) => Ok(read_or_empty(
            catalog_key,
            account_number_hash,
            Some(&bytes),
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AttachmentsCatalog::empty()),
        Err(e) => Err(e),
    }
}

/// Read + decode the catalog, collapsing ANY failure (including IO) to
/// the empty catalog — the read-only `catalog_list` path, where a
/// transient IO error showing an empty library is acceptable (the next
/// list retries) and where no destructive write follows.
fn read_catalog_or_empty(
    catalog_path: &Path,
    catalog_key: &[u8; 32],
    account_number_hash: &[u8; CATALOG_BLOB_ACCOUNT_HASH_LEN],
) -> AttachmentsCatalog {
    match std::fs::read(catalog_path) {
        Ok(bytes) => read_or_empty(catalog_key, account_number_hash, Some(&bytes)),
        Err(_) => AttachmentsCatalog::empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::vault_unlock::state::{fixture_unlocked_with_keys, VaultRuntimeState};
    use crate::test_support::ScopedTempDir;
    use protocol::{SubkeyRole, VAULT_META_ACCOUNT_HASH_LEN};

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    const SEED_ROOT: u8 = 0x42;
    const SEED_ITEMS: u8 = 0x99;
    const SEED_ITEMS_ID: u8 = 1;
    const SEED_ACCOUNT_HASH: u8 = 0x33;

    // A minimal valid PNG payload (8-byte signature is enough for the
    // sniffer; the blob codec accepts arbitrary bytes).
    const PNG_BYTES: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4];
    const PDF_BYTES: &[u8] = b"%PDF-1.7\n1 0 obj\n<<>>\nendobj\n";

    /// Seed a real 345-byte vault.meta whose account_number_hash is the
    /// repeating seed byte; other fields are filler that parse-passes.
    fn seed_vault_meta(dir: &Path, seed: u8) {
        let meta = protocol::VaultMeta {
            account_number_hash: [seed; VAULT_META_ACCOUNT_HASH_LEN],
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
        .expect("seed vault.meta");
    }

    async fn unlocked_state() -> VaultRuntimeState {
        let state = VaultRuntimeState::default();
        state
            .set_unlocked(fixture_unlocked_with_keys(
                SEED_ROOT,
                SEED_ITEMS,
                SEED_ITEMS_ID,
            ))
            .await;
        state
    }

    async fn temp_vault() -> (ScopedTempDir, VaultRuntimeState) {
        let tmp = ScopedTempDir::new("attach-it").expect("scoped tempdir");
        seed_vault_meta(tmp.path(), SEED_ACCOUNT_HASH);
        let state = unlocked_state().await;
        (tmp, state)
    }

    // ---- hex round-trip ------------------------------------------------

    #[test]
    fn hex_encode_decode_round_trips() {
        let id = [0xAB; ATTACHMENT_ID_LEN];
        let hex = hex_encode(&id);
        assert_eq!(hex.len(), 64);
        assert_eq!(hex_decode_id(&hex), Some(id));
    }

    #[test]
    fn hex_decode_rejects_wrong_length_and_uppercase() {
        assert!(hex_decode_id("abcd").is_none());
        assert!(hex_decode_id(&"A".repeat(64)).is_none()); // uppercase
        assert!(hex_decode_id(&"g".repeat(64)).is_none()); // non-hex
    }

    // ---- slot gate -----------------------------------------------------

    #[test]
    fn import_rejects_when_locked() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("attach-locked").unwrap();
            seed_vault_meta(tmp.path(), SEED_ACCOUNT_HASH);
            let state = VaultRuntimeState::default(); // Empty slot
            let result = attachment_import_with_dir(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: PNG_BYTES.to_vec(),
                    filename: Some("a.png".to_string()),
                },
            )
            .await;
            assert!(matches!(result, Err(AttachmentImportError::Locked)));
        });
    }

    #[test]
    fn catalog_list_rejects_when_locked() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("attach-list-locked").unwrap();
            let state = VaultRuntimeState::default();
            let result = catalog_list_with_dir(tmp.path(), &state).await;
            assert!(matches!(result, Err(CatalogListError::Locked)));
        });
    }

    #[test]
    fn delete_rejects_when_locked() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("attach-del-locked").unwrap();
            let state = VaultRuntimeState::default();
            let result = attachment_delete_with_dir(tmp.path(), &state, "0".repeat(64)).await;
            assert!(matches!(result, Err(AttachmentDeleteError::Locked)));
        });
    }

    // ---- cap + allowlist ----------------------------------------------

    #[test]
    fn import_rejects_oversize() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            // One byte over the cap. PNG header so it would otherwise pass
            // the sniff — proves cap is checked before sniff is irrelevant
            // (cap is first).
            let mut bytes = vec![0u8; MAX_ATTACHMENT_IMPORT_LEN + 1];
            bytes[..8].copy_from_slice(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
            let result = attachment_import_with_dir(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes,
                    filename: None,
                },
            )
            .await;
            assert!(matches!(
                result,
                Err(AttachmentImportError::Oversize { cap_bytes }) if cap_bytes == MAX_ATTACHMENT_IMPORT_LEN
            ));
        });
    }

    #[test]
    fn import_rejects_unsupported_type() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let result = attachment_import_with_dir(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: b"not a known file type at all".to_vec(),
                    filename: Some("mystery.bin".to_string()),
                },
            )
            .await;
            assert!(matches!(
                result,
                Err(AttachmentImportError::UnsupportedType)
            ));
        });
    }

    // ---- happy path + dedup -------------------------------------------

    #[test]
    fn import_stores_blob_and_catalog_then_lists() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let imported = attachment_import_with_dir(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: PNG_BYTES.to_vec(),
                    filename: Some("photo.png".to_string()),
                },
            )
            .await
            .expect("import succeeds");

            assert!(!imported.deduplicated);
            assert_eq!(imported.content_type, "image/png");
            assert_eq!(imported.filename, "photo.png");
            assert_eq!(imported.size, PNG_BYTES.len() as u64);
            assert_eq!(imported.id.len(), 64);

            // Blob is on disk at attachments/<id>.
            let blob_path = tmp.path().join("attachments").join(&imported.id);
            assert!(blob_path.exists(), "blob must be written");
            // Catalog is on disk.
            assert!(tmp.path().join("vault.attachments").exists());

            // catalog_list returns the row.
            let rows = catalog_list_with_dir(tmp.path(), &state)
                .await
                .expect("list succeeds");
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].id, imported.id);
            assert_eq!(rows[0].filename, "photo.png");
            assert_eq!(rows[0].content_type, "image/png");
        });
    }

    #[test]
    fn import_dedups_identical_bytes() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let first = attachment_import_with_dir(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: PNG_BYTES.to_vec(),
                    filename: Some("first.png".to_string()),
                },
            )
            .await
            .expect("first import");
            assert!(!first.deduplicated);

            // Same bytes, different filename → dedup hit, ORIGINAL metadata
            // returned (filename stays "first.png").
            let second = attachment_import_with_dir(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: PNG_BYTES.to_vec(),
                    filename: Some("second.png".to_string()),
                },
            )
            .await
            .expect("second import");
            assert!(second.deduplicated, "identical bytes must dedup");
            assert_eq!(second.id, first.id);
            assert_eq!(second.filename, "first.png", "dedup returns original entry");

            // Still exactly one catalog row.
            let rows = catalog_list_with_dir(tmp.path(), &state).await.unwrap();
            assert_eq!(rows.len(), 1);
        });
    }

    #[test]
    fn import_distinct_bytes_make_distinct_ids() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let a = attachment_import_with_dir(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: PNG_BYTES.to_vec(),
                    filename: None,
                },
            )
            .await
            .unwrap();
            let b = attachment_import_with_dir(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: PDF_BYTES.to_vec(),
                    filename: None,
                },
            )
            .await
            .unwrap();
            assert_ne!(a.id, b.id);
            assert_eq!(a.content_type, "image/png");
            assert_eq!(b.content_type, "application/pdf");
            // Auto-filenames from the sniffed type.
            assert_eq!(a.filename, "attachment.png");
            assert_eq!(b.filename, "attachment.pdf");
            let rows = catalog_list_with_dir(tmp.path(), &state).await.unwrap();
            assert_eq!(rows.len(), 2);
        });
    }

    // ---- path-source import -------------------------------------------

    #[test]
    fn import_from_path_reads_the_file() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let src = tmp.path().join("source-image.png");
            std::fs::write(&src, PNG_BYTES).unwrap();
            let imported = attachment_import_with_dir(
                tmp.path(),
                &state,
                ImportSource::Path {
                    path: src.to_string_lossy().to_string(),
                },
            )
            .await
            .expect("path import succeeds");
            // Display filename derived from the path's final component.
            assert_eq!(imported.filename, "source-image.png");
            assert_eq!(imported.content_type, "image/png");
        });
    }

    // ---- delete --------------------------------------------------------

    #[test]
    fn delete_removes_blob_and_catalog_entry() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let imported = attachment_import_with_dir(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: PNG_BYTES.to_vec(),
                    filename: Some("doomed.png".to_string()),
                },
            )
            .await
            .unwrap();
            let blob_path = tmp.path().join("attachments").join(&imported.id);
            assert!(blob_path.exists());

            attachment_delete_with_dir(tmp.path(), &state, imported.id.clone())
                .await
                .expect("delete succeeds");

            assert!(!blob_path.exists(), "blob must be unlinked");
            let rows = catalog_list_with_dir(tmp.path(), &state).await.unwrap();
            assert!(rows.is_empty(), "catalog entry must be removed");
        });
    }

    #[test]
    fn delete_absent_id_is_idempotent_ok() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            // Valid-shape id that was never imported.
            let id = "ab".repeat(32);
            let result = attachment_delete_with_dir(tmp.path(), &state, id).await;
            assert!(result.is_ok(), "deleting an absent id is idempotent Ok");
        });
    }

    // ---- rename --------------------------------------------------------

    #[test]
    fn rename_updates_catalog_filename() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let imported = attachment_import_with_dir(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: PNG_BYTES.to_vec(),
                    filename: Some("old.png".to_string()),
                },
            )
            .await
            .unwrap();

            attachment_rename_with_dir(
                tmp.path(),
                &state,
                imported.id.clone(),
                "  renamed.png  ".to_string(),
            )
            .await
            .expect("rename succeeds");

            // The blob is untouched; only the catalog filename changes (trimmed).
            let rows = catalog_list_with_dir(tmp.path(), &state).await.unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].id, imported.id);
            assert_eq!(rows[0].filename, "renamed.png");
        });
    }

    #[test]
    fn rename_absent_id_is_not_found() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let id = "ab".repeat(32); // valid shape, never imported
            let result =
                attachment_rename_with_dir(tmp.path(), &state, id, "x.png".to_string()).await;
            assert!(matches!(
                result,
                Err(AttachmentRenameError::AttachmentNotFound)
            ));
        });
    }

    #[test]
    fn rename_rejects_invalid_id() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let result =
                attachment_rename_with_dir(tmp.path(), &state, "not-hex".to_string(), "x".into())
                    .await;
            assert!(matches!(result, Err(AttachmentRenameError::InvalidId)));
        });
    }

    #[test]
    fn rename_rejects_empty_filename() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let id = "ab".repeat(32);
            let result =
                attachment_rename_with_dir(tmp.path(), &state, id, "   ".to_string()).await;
            assert!(matches!(result, Err(AttachmentRenameError::EmptyFilename)));
        });
    }

    #[test]
    fn rename_rejects_when_locked() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("attach-rename-locked").unwrap();
            seed_vault_meta(tmp.path(), SEED_ACCOUNT_HASH);
            let state = VaultRuntimeState::default(); // empty slot
            let result = attachment_rename_with_dir(
                tmp.path(),
                &state,
                "ab".repeat(32),
                "x.png".to_string(),
            )
            .await;
            assert!(matches!(result, Err(AttachmentRenameError::Locked)));
        });
    }

    #[test]
    fn delete_rejects_invalid_id() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let result =
                attachment_delete_with_dir(tmp.path(), &state, "not-hex".to_string()).await;
            assert!(matches!(result, Err(AttachmentDeleteError::InvalidId)));
        });
    }

    // ---- catalog_list fall-back-to-empty ------------------------------

    #[test]
    fn catalog_list_empty_when_no_catalog_file() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let rows = catalog_list_with_dir(tmp.path(), &state)
                .await
                .expect("absent catalog → empty list");
            assert!(rows.is_empty());
        });
    }

    #[test]
    fn catalog_list_empty_when_catalog_tampered() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            // Seed a valid catalog via an import, then corrupt it.
            attachment_import_with_dir(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: PNG_BYTES.to_vec(),
                    filename: None,
                },
            )
            .await
            .unwrap();
            let catalog_path = tmp.path().join("vault.attachments");
            let mut bytes = std::fs::read(&catalog_path).unwrap();
            // Flip a ciphertext byte past the 34-byte header.
            bytes[40] ^= 0xFF;
            std::fs::write(&catalog_path, &bytes).unwrap();

            let rows = catalog_list_with_dir(tmp.path(), &state)
                .await
                .expect("tampered catalog → empty list (§9.10.4)");
            assert!(rows.is_empty());
        });
    }

    // ---- error_kind helper drift --------------------------------------

    #[test]
    fn import_error_kind_covers_every_variant() {
        assert_eq!(
            attachment_import_error_kind(&AttachmentImportError::Locked),
            "Locked"
        );
        assert_eq!(
            attachment_import_error_kind(&AttachmentImportError::Oversize { cap_bytes: 1 }),
            "Oversize"
        );
        assert_eq!(
            attachment_import_error_kind(&AttachmentImportError::UnsupportedType),
            "UnsupportedType"
        );
        assert_eq!(
            attachment_import_error_kind(&AttachmentImportError::InvalidVaultMeta),
            "InvalidVaultMeta"
        );
        assert_eq!(
            attachment_import_error_kind(&AttachmentImportError::EncodeFailed),
            "EncodeFailed"
        );
        assert_eq!(
            attachment_import_error_kind(&AttachmentImportError::JoinFailure),
            "JoinFailure"
        );
        assert_eq!(
            attachment_import_error_kind(&AttachmentImportError::Io {
                io_error_kind: crate::io_failure_kind::IoFailureKind::Other
            }),
            "Io"
        );
    }

    // ---- round-trip: decode the stored blob with the codec ------------

    #[test]
    fn imported_blob_decodes_under_the_vault_keys() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let imported = attachment_import_with_dir(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: PNG_BYTES.to_vec(),
                    filename: Some("rt.png".to_string()),
                },
            )
            .await
            .unwrap();

            // Recompute the vault keys the same way the fixture does.
            let items_key = [SEED_ITEMS; 32];
            let items_key_id = [SEED_ITEMS_ID; 16];
            let id = hex_decode_id(&imported.id).unwrap();
            let blob = std::fs::read(tmp.path().join("attachments").join(&imported.id)).unwrap();
            let plaintext = protocol::decode_attachment_blob(
                &blob,
                &id,
                imported.content_type.as_bytes(),
                &items_key,
                &items_key_id,
            )
            .expect("stored blob must decode under the vault's items_key");
            assert_eq!(plaintext.as_slice(), PNG_BYTES);
        });
    }

    // Touch the SubkeyRole import so the catalog KEK derivation is
    // exercised against a known role (compile-level: the import is used
    // by every command; this is a belt assertion the role exists).
    #[test]
    fn catalog_kek_role_is_distinct_from_id_hmac() {
        let root = [SEED_ROOT; 32];
        let kek = derive_subkey(&root, SubkeyRole::AttachmentsCatalogKey);
        let id_hmac = derive_subkey(&root, SubkeyRole::AttachmentsIdHmac);
        assert_ne!(*kek, *id_hmac);
    }
}
