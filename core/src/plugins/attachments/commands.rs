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
    AttachmentCleanUnusedError, AttachmentDeleteError, AttachmentExportError,
    AttachmentImportError, AttachmentRenameError, AttachmentServeError, AttachmentUnusedListError,
    CatalogListError,
};
use super::extract_types::ExtractedText;
use super::sniff::sniff_content_type;
use crate::host::HostCtx;
use crate::io_failure_kind::IoFailureKind;
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use crate::vault_io::{VaultIo, WriteOpts};
use protocol::{
    compute_attachment_id, decode_attachment_blob, decode_attachments_catalog, derive_subkey,
    encode_attachment_blob, encode_attachments_catalog, parse_vault_meta, read_or_empty,
    AttachmentMeta, AttachmentsCatalog, SubkeyRole, ATTACHMENT_ID_LEN,
    CATALOG_BLOB_ACCOUNT_HASH_LEN, MAX_ATTACHMENT_LEN, VAULT_META_ACCOUNT_HASH_LEN,
};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
// Tauri types serve only the cfg-gated IPC wrappers (task 79, Option B).
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use crate::host::tauri_host::TauriHost;
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
use tauri::{AppHandle, Runtime, State};
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
pub(crate) fn catalog_write_mutex() -> &'static Mutex<()> {
    static M: OnceLock<Mutex<()>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(()))
}

/// Resolve the ACTIVE vault root. `active_id` is read from the runtime state by
/// the calling command (`state.active_vault_id().await`) — the only place with
/// `.await` access to the slot map. SYNC-6: attachment import/list/delete/rename
/// all operate on the unlocked vault, so resolving via the active id (not the
/// transitional sole-vault disk heuristic) keeps the blob and catalog targeting
/// the correct vault once two or more exist.
///
/// One line over the pure resolver in `crate::paths`; the Tauri-shaped twin is
/// gone once every wrapper delegates (task 79).
fn vault_dir_from_host(
    host: &dyn HostCtx,
    active_id: Option<crate::vault_id::VaultId>,
) -> std::io::Result<PathBuf> {
    crate::paths::active_vault_root_io_from_host(host, active_id)
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
/// `pub(crate)` for cross-module reuse (e.g. `text_cache` for the
/// `attachments-text/<id-hex>` cache path), mirroring `hex_decode_id`.
pub fn hex_encode(bytes: &[u8]) -> String {
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
/// `pub(crate)`: also consumed by the notes plugin's
/// `note_export_attachments` (MYND-115 task 4 — cross-plugin reuse, the
/// `VaultRuntimeState`-borrow precedent).
pub fn hex_decode_id(s: &str) -> Option<[u8; ATTACHMENT_ID_LEN]> {
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
/// `pub(crate)`: also consumed by the notes plugin's
/// `note_export_attachments` (MYND-115 task 4).
pub async fn read_account_number_hash(
    io: &dyn VaultIo,
    vault_meta_path: &Path,
) -> Result<Result<[u8; VAULT_META_ACCOUNT_HASH_LEN], MetaParseFailed>, IoFailureKind> {
    // `vault.meta` is a double-buffered singleton on the web store (task 18), so
    // "read it" means "the newest copy that PARSES" — and `parse_vault_meta` is
    // exactly the verifier `open_newest` wants. Desktop and mobile are unchanged
    // by construction: `read_candidates` defaults to a one-element list there,
    // so this is the same read followed by the same parse.
    match crate::singleton::open_newest(io, vault_meta_path, |candidate| {
        parse_vault_meta(candidate).map(|m| m.account_number_hash)
    })
    .await
    {
        Ok(hash) => Ok(Ok(hash)),
        // Absence stays an IO answer rather than a parse failure — that is what
        // `std::fs::read` reported here before, and the callers' `Io`/
        // `InvalidVaultMeta` split is built on the distinction.
        Err(crate::singleton::OpenOutcome::Absent) => Err(IoFailureKind::NotFound),
        Err(crate::singleton::OpenOutcome::Io(kind)) => Err(kind),
        Err(crate::singleton::OpenOutcome::Undecodable(_)) => Ok(Err(MetaParseFailed)),
    }
}

/// Zero-sized marker for a `vault.meta` parse failure, mapped to each
/// command's `InvalidVaultMeta` variant at the call site.
pub struct MetaParseFailed;

/// Grace window (7 days) during which a freshly-added but never-referenced
/// attachment is withheld from the "unused" list (share-import ledger SYNC-10):
/// a file shared via the OS share sheet lands in the library UNATTACHED (zero
/// note references), which would otherwise place it in the Clean-Unused
/// cryptographic-erase set the instant it arrives. Excluding recent additions
/// keeps a just-shared, not-yet-filed file out of the erase review until the
/// user has had a week to file it; a genuinely-old unfiled attachment becomes
/// cleanable again after the window (accepted as correct). Uses the catalog's
/// existing `created_at` — no on-disk format change (SYNC-10). Since the
/// Clean-Unused dialog only ever erases ids it was shown from this list, the
/// list guard is the effective protection; a direct `attachment_clean_unused`
/// call with a hand-picked recent id is not covered (defense-in-depth follow-up).
pub const UNUSED_CLEANUP_GRACE_SECS: u64 = 7 * 24 * 60 * 60;

/// Stored `content_type` for an import whose bytes the sniffer does not
/// recognize (MYND-173). It is a catalog hint only — it is NOT a member
/// of [`sniff::ALLOWLISTED_CONTENT_TYPES`], so the `attachment://` handler
/// never emits it (it re-sniffs and only serves allowlisted types). An
/// octet-stream attachment renders in the editor as an export-only
/// file-card and is never served inline.
const OCTET_STREAM: &str = "application/octet-stream";

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
pub async fn attachment_import_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    source: ImportSource,
) -> Result<ImportedAttachment, AttachmentImportError> {
    let dir = vault_dir_from_host(host, state.active_vault_id().await)
        .map_err(AttachmentImportError::from)?;
    let result = attachment_import_with_dir(io, host, &dir, state, source).await;
    // MYND-468: a fresh import (not a dedup hit) is a local sync change — the
    // blob + catalog must push on the next coalesced cycle.
    if matches!(&result, Ok(imported) if !imported.deduplicated) {
        hooks.bump_local_change();
    }
    result
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn attachment_import<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    source: ImportSource,
) -> Result<ImportedAttachment, AttachmentImportError> {
    attachment_import_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        hooks.inner(),
        source,
    )
    .await
}

/// Testable core of [`attachment_import`] — the **extraction-free** import
/// (the mobile + core-command path). Desktop uses
/// [`attachment_import_with_dir_ext`] with its real text extractor so the eager
/// `MYE1` cache is populated for search parity; this wrapper injects a no-op
/// extractor, so no cache blob is written.
///
/// Steps: read the source bytes (first-line `Zeroizing`-wrapped),
/// enforce the cap, sniff the type (unrecognized ⇒ `octet-stream`,
/// MYND-173), peek the slot
/// for `(items_key, items_key_id, root_key)`, read the catalog, dedup on
/// the computed id, else encode + `atomic_write` the `MYA1` blob and
/// upsert + `atomic_write` the `MYC1` catalog. Returns the id + metadata.
pub async fn attachment_import_with_dir(
    io: &dyn VaultIo,
    host: &dyn HostCtx,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    source: ImportSource,
) -> Result<ImportedAttachment, AttachmentImportError> {
    attachment_import_with_dir_ext(io, host, vault_dir, state, source, None, no_op_extract).await
}

/// No-op text extractor: reports every input as `Unsupported`, so the eager
/// `MYE1` cache write in [`attachment_import_with_dir_ext`] is skipped. This is
/// the extractor the core `attachment_import` command + the mobile client use
/// (no extraction step); desktop injects the real `lopdf`/`zip`/`quick-xml` one.
fn no_op_extract(_content_type: &str, _filename: &str, _bytes: &[u8]) -> ExtractedText {
    ExtractedText::negative(
        super::extract_types::ExtractStatus::Unsupported,
        super::extract_types::SourceFormat::Other,
    )
}

/// Testable core of [`attachment_import`], with the text-extraction *producer*
/// injected as `extract` so this module (in `myne-core`) never depends on the
/// desktop-only `lopdf`/`zip`/`quick-xml` extractor. Desktop passes its real
/// extractor (eager `MYE1` cache — search parity); mobile / the core command
/// pass [`no_op_extract`] (no extraction step).
pub async fn attachment_import_with_dir_ext<F>(
    io: &dyn VaultIo,
    host: &dyn HostCtx,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    source: ImportSource,
    // Optional override for the fresh entry's `created_at` (UNIX seconds). `None`
    // stamps the current time — the ordinary paste/drop/import path. A caller
    // that is re-materializing a file with its own original timestamp (a backup
    // restore / migration import) passes `Some`, which also governs the
    // unused-cleanup grace window (`UNUSED_CLEANUP_GRACE_SECS`): a restored file
    // whose original creation predates the window is not withheld as "recently
    // added". Ignored on a dedup hit (the existing entry's `created_at` wins).
    created_at_override: Option<u64>,
    extract: F,
) -> Result<ImportedAttachment, AttachmentImportError>
where
    F: Fn(&str, &str, &[u8]) -> ExtractedText + Send + 'static,
{
    // (1) Materialize the source bytes + the display filename. For the
    //     path arm, the host reads the file. The bytes are wrapped in a
    //     `Zeroizing` on the first non-doc statement of their lifetime so
    //     every early-return drops + wipes them (Plaintext-IPC pattern —
    //     attachment bytes are AS-sensitive plaintext until encrypted).
    let (file_bytes, claimed_filename): (Zeroizing<Vec<u8>>, Option<String>) = match source {
        ImportSource::Bytes { bytes, filename } => (Zeroizing::new(bytes), filename),
        ImportSource::Path { path } => {
            let p = PathBuf::from(path);
            // Bound the allocation BEFORE reading the whole file: a huge picked /
            // drag-dropped file (e.g. a multi-GB video) would otherwise be pulled
            // into RAM in full and OOM the host before the `len()` cap check
            // below could fire. The Bytes arm is already materialized by the
            // WebView, so only the Path arm (the host reads the file) needs this.
            //
            // A **prefix read of cap+1** rather than a `metadata()` size probe
            // (task 44): it needs no seam method beyond the two the storage seam
            // already has, it costs one syscall instead of two, and it closes a
            // TOCTOU the size probe left open — a file that grows between the
            // `stat` and the read used to be read in full anyway. `cap+1` bytes
            // arriving means "at least cap+1", which is over.
            let bytes = io
                .read_prefix(&p, MAX_ATTACHMENT_IMPORT_LEN + 1)
                .await
                .map_err(AttachmentImportError::from)?;
            if bytes.len() > MAX_ATTACHMENT_IMPORT_LEN {
                return Err(AttachmentImportError::Oversize {
                    cap_bytes: MAX_ATTACHMENT_IMPORT_LEN,
                });
            }
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

    // (3) Content-type sniff. The sniffer recognizes ONLY the render
    //     allowlist (image/* + svg + pdf); anything else is stored as an
    //     opaque attachment with `application/octet-stream` (MYND-173).
    //     Accepting arbitrary bytes is safe because a non-allowlisted type
    //     is never served inline by the `attachment://` handler nor
    //     rendered — it surfaces in the editor as an export-only file-card,
    //     so a `.png`-renamed binary cannot become a scriptable served
    //     resource; the user only gets its bytes back verbatim via Export.
    let content_type = sniff_content_type(&file_bytes).unwrap_or(OCTET_STREAM);
    tracing::debug!(stage = "sniff", content_type = content_type);

    // (4) Slot gate — clone `(items_key, items_key_id, root_key)` out of
    //     the Unlocked slot. `root_key` is needed for BOTH the id-HMAC
    //     subkey (compute_attachment_id) and the catalog KEK
    //     (AttachmentsCatalogKey); `items_key` wraps the per-attachment
    //     key. All three are dropped at function exit (Zeroizing).
    // SYNC-6 writer-guard (MYND-32): guard bound across the blob +
    // catalog atomic_writes below.
    let (_slots_guard, items_key, items_key_id, root_key) = state
        .hold_unlocked_attachment_material()
        .await
        .ok_or(AttachmentImportError::Locked)?;
    tracing::debug!(stage = "slot_check", outcome = "vault_unlocked");

    // (5) Read vault.meta → account_number_hash (catalog AAD identity).
    let account_number_hash =
        match read_account_number_hash(io, &vault_dir.join("vault.meta")).await? {
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
    let mut catalog = read_catalog(io, &catalog_path, &catalog_key, &account_number_hash).await?;

    // A TOMBSTONED entry (deleted, awaiting sync propagation — MYND-468) is
    // treated as absent: re-importing the same file is the deliberate re-add
    // of `sync-protocol.md` §11.4 rule 4 — the fresh live entry's `created_at`
    // postdates the tombstone's `deleted_at`, so the revival wins the merge.
    if let Some(existing) = catalog.entries.get(&id_hex).filter(|e| !e.is_tombstone()) {
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
    let created_at = created_at_override.unwrap_or_else(|| host.now_unix_secs());

    // (10) Encode the MYA1 blob on a blocking thread (random key + nonces
    //      from getrandom; AEAD seal under items_key → attachment_key).
    //      Move the Zeroizing bytes + the key material into the closure so
    //      they wipe on closure exit.
    let attachments_dir = vault_dir.join("attachments");
    let blob_path = attachments_dir.join(&id_hex);
    let content_type_owned = content_type.to_string();
    // MYND-328: eager text extraction → MYE1 cache, done on the same blocking
    // thread (extraction is CPU work) right after the source blob lands. Derive
    // the attachment-text KEK + clone the inputs the closure needs. The KEK has
    // exactly one consumer — the cache write below — which task 90 compiled out
    // of wasm32, so on that target deriving it would be work with no reader.
    #[cfg(not(target_arch = "wasm32"))]
    let attachment_text_key = derive_subkey(&root_key, SubkeyRole::AttachmentTextKey);
    let filename_for_extract = filename.clone();
    // Only the CPU work stays inside `run_blocking` (task 44): the AEAD seal and
    // the text extraction. Every byte that reaches storage now goes through the
    // seam below, whose native arm dispatches its own blocking — so a browser,
    // where `run_blocking` runs its closure inline, no longer has `std::fs`
    // inside it.
    let join = crate::task::run_blocking(
        move || -> Result<(Vec<u8>, Option<ExtractedText>), AttachmentImportError> {
            let blob = encode_attachment_blob(
                &items_key,
                &items_key_id,
                &attachment_id,
                content_type_owned.as_bytes(),
                &file_bytes,
            )
            .map_err(|_| AttachmentImportError::EncodeFailed)?;

            // MYND-328: extract text from the (still-in-scope) plaintext for the
            // MYE1 cache. Unsupported formats (e.g. images) are NOT cached —
            // their O(1) dispatch is cheap to repeat and a cache blob per image
            // is waste — so an unsupported result is dropped here rather than
            // carried out to a write that would skip it anyway.
            let extracted = extract(&content_type_owned, &filename_for_extract, &file_bytes);
            let cacheable = (extracted.status != super::extract_types::ExtractStatus::Unsupported)
                .then_some(extracted);
            Ok((blob, cacheable))
        },
    )
    .await;
    let (blob, cacheable) = match join {
        Err(_join) => {
            tracing::error!(
                stage = "spawn_blocking_join",
                error_kind = "JoinFailure",
                "attachment_import encode worker panicked or runtime shutdown"
            );
            return Err(AttachmentImportError::JoinFailure);
        }
        Ok(Err(e)) => {
            tracing::error!(
                stage = "blob_encode",
                error_kind = attachment_import_error_kind(&e),
                "attachment_import blob encode failed"
            );
            return Err(e);
        }
        Ok(Ok(pair)) => pair,
    };

    // Ensure `attachments/` exists, then create-only write. The id is
    // content-addressed, so a pre-existing blob means the catalog dedup missed
    // and the bytes on disk are the SAME bytes — benign already-stored, not an
    // error.
    //
    // "Already exists" is recovered by ASKING rather than by widening the seam's
    // closed `IoFailureKind` (the `note_create` discipline): the enum crosses
    // the IPC boundary and is matched exhaustively in TypeScript, so a fifth
    // variant would be a two-language change to express one cheaply-observable
    // condition. The catalog write mutex is held across this, so the
    // check-after-failure is not a same-process TOCTOU; a lost cross-process
    // race fails loudly rather than replacing a blob, which is the safe
    // direction for a create-only write.
    if let Err(io_error_kind) = io.create_dir_all(&attachments_dir).await {
        tracing::error!(
            stage = "attachments_dir",
            error_kind = "Io",
            io_failure_kind = ?io_error_kind,
            "attachment_import could not create the attachments directory"
        );
        return Err(AttachmentImportError::Io { io_error_kind });
    }
    if let Err(io_error_kind) = io.write(&blob_path, &blob, WriteOpts::create_new()).await {
        if !io.exists(&blob_path).await.unwrap_or(false) {
            tracing::error!(
                stage = "blob_write",
                error_kind = "Io",
                io_failure_kind = ?io_error_kind,
                "attachment_import blob write failed"
            );
            return Err(AttachmentImportError::Io { io_error_kind });
        }
    }

    // Best-effort + non-fatal MYE1 cache write — a failed cache write must never
    // fail the import; the lazy backfill (search rebuild) retries.
    //
    // Native-only, and the `cfg` is the point (task 90): attachment-content
    // search is absent on web, so `text_cache`'s producers do not compile for
    // wasm32 at all. Dropping `cacheable` here rather than gating the extractor
    // call keeps the closure above target-independent — the web build passes
    // `no_op_extract`, so `cacheable` is already `None` and the drop is a no-op
    // in practice; the `cfg` is what stops a future caller from making it one in
    // theory and a written `MYE1` blob in fact.
    #[cfg(target_arch = "wasm32")]
    drop(cacheable);
    #[cfg(not(target_arch = "wasm32"))]
    if let Some(extracted) = cacheable {
        // NOT through the seam, and that is the boundary this task drew: the
        // MYE1 producers stay on `std::fs`, which is sound because they are now
        // compiled out of the one target that has no `std::fs` (see the
        // "Why the producers stop at wasm32" note in `text_cache.rs`).
        if super::text_cache::write_extracted(
            vault_dir,
            &attachment_text_key,
            &account_number_hash,
            &attachment_id,
            &extracted,
        )
        .is_err()
        {
            tracing::debug!(
                stage = "text_cache_write",
                "MYE1 cache write failed (non-fatal; lazy backfill retries)"
            );
        }
    }

    // (11) Upsert the catalog entry + atomic-write the catalog. The blob
    //      is already durably on disk; if the catalog write fails the blob
    //      is an orphan (recoverable — a re-import recomputes the same id,
    //      dedup-misses on the absent catalog entry, and the create-only
    //      blob write folds AlreadyExists to Ok, re-adding the entry).
    catalog.entries.insert(
        id_hex.clone(),
        AttachmentMeta::live(content_type.to_string(), created_at, filename.clone(), size),
    );
    let catalog_bytes = encode_attachments_catalog(&catalog_key, &account_number_hash, &catalog)
        .map_err(|_| AttachmentImportError::EncodeFailed)?;
    io.write(&catalog_path, &catalog_bytes, WriteOpts::default())
        .await
        .map_err(|io_error_kind| AttachmentImportError::Io { io_error_kind })?;

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
pub async fn catalog_list_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) -> Result<Vec<CatalogEntry>, CatalogListError> {
    let dir =
        vault_dir_from_host(host, state.active_vault_id().await).map_err(CatalogListError::from)?;
    catalog_list_with_dir(io, &dir, state).await
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn catalog_list<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Vec<CatalogEntry>, CatalogListError> {
    catalog_list_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await
}

/// Testable core of [`catalog_list`].
pub(crate) async fn catalog_list_with_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
) -> Result<Vec<CatalogEntry>, CatalogListError> {
    let root_key = state
        .peek_unlocked_root_key_clone()
        .await
        .ok_or(CatalogListError::Locked)?;

    let account_number_hash =
        match read_account_number_hash(io, &vault_dir.join("vault.meta")).await? {
            Ok(h) => h,
            Err(MetaParseFailed) => return Err(CatalogListError::InvalidVaultMeta),
        };

    let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
    let catalog_path = vault_dir.join("vault.attachments");
    let catalog =
        read_catalog_or_empty(io, &catalog_path, &catalog_key, &account_number_hash).await;

    let rows: Vec<CatalogEntry> = catalog
        .entries
        .into_iter()
        // A tombstoned entry is a sync deletion marker (MYND-468), not a
        // library item — never listed.
        .filter(|(_, meta)| !meta.is_tombstone())
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

// ---- attachment_unused_list ---------------------------------------------

/// `Slot::Unlocked`-gated read of the **unused** attachments — catalog
/// entries referenced by ZERO live notes (MYND-171, attachment cleanup).
/// The backing query for the "Clean unused attachments" review dialog.
///
/// Computed **authoritatively**: every `.myn` is decrypted host-side and
/// scanned for canonical `![[att:<id>]]` embeds (the union is the
/// referenced set); the catalog minus that set is "unused". It does NOT
/// trust the best-effort in-RAM reconcile graph — a swallowed `apply` there
/// would under-count references and risk listing a still-referenced
/// attachment for deletion. "Unused" deliberately includes a
/// never-inserted import (zero references is zero references); shared/
/// deduped attachments referenced by any remaining note are never listed.
///
/// **Fail-closed**: if any note cannot be read / decrypted / UTF-8-decoded
/// the whole list fails (`NoteScanFailed`) — better to refuse cleanup than
/// to under-report references. Returns the unused rows in catalog id order
/// (the `BTreeMap` iteration order), each a [`CatalogEntry`] the dialog
/// renders (thumbnail / filename / size).
pub async fn attachment_unused_list_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) -> Result<Vec<CatalogEntry>, AttachmentUnusedListError> {
    let dir = vault_dir_from_host(host, state.active_vault_id().await)
        .map_err(AttachmentUnusedListError::from)?;
    attachment_unused_list_with_dir(io, &dir, state, host.now_unix_secs()).await
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn attachment_unused_list<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
) -> Result<Vec<CatalogEntry>, AttachmentUnusedListError> {
    attachment_unused_list_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
    )
    .await
}

/// Testable core of [`attachment_unused_list`]. `now` is the current UNIX time
/// (the wrapper passes [`now_unix_secs`]); entries added within
/// [`UNUSED_CLEANUP_GRACE_SECS`] of it are withheld (SYNC-10). Pass
/// `u64::MAX` to disable the grace window (unbounded "now" ⇒ nothing is recent).
pub(crate) async fn attachment_unused_list_with_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    now: u64,
) -> Result<Vec<CatalogEntry>, AttachmentUnusedListError> {
    // Corpus-completeness gate (phase3-web-client task 89). BEFORE the scan, not
    // after: computing an unused set the caller must not act on is work whose
    // only possible use is to be ignored, and an implementation that computed it
    // first would invite a later "just show it, greyed out" change that hands the
    // user a wrong list.
    //
    // In `core/`, not the UI, so no caller can bypass it — and so a DESKTOP that
    // enrolled and has never finished its first sync gets the same protection.
    if !crate::plugins::sync::corpus::corpus_state(io, vault_dir)
        .await
        .permits_whole_corpus_sweep()
    {
        tracing::info!(
            stage = "corpus_gate",
            event = "unused_list_refused",
            "attachment_unused_list refused: corpus not proven complete"
        );
        return Err(AttachmentUnusedListError::CorpusIncomplete);
    }

    // Hold the slot guard across the whole compute (catalog read + note
    // scan) — the import/delete writer-guard pattern. Clone the material
    // once: root_key derives the catalog KEK; items_key + items_key_id
    // decrypt the notes.
    let (_slots_guard, items_key, items_key_id, root_key) = state
        .hold_unlocked_attachment_material()
        .await
        .ok_or(AttachmentUnusedListError::Locked)?;

    let account_number_hash =
        match read_account_number_hash(io, &vault_dir.join("vault.meta")).await? {
            Ok(h) => h,
            Err(MetaParseFailed) => return Err(AttachmentUnusedListError::InvalidVaultMeta),
        };

    // Hard-IO surfaces (`read_catalog`, not `read_catalog_or_empty`): a
    // masked-empty catalog would report a populated vault as "nothing to
    // clean". Absent catalog → empty → empty unused list (correct).
    let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
    let catalog = read_catalog(
        io,
        &vault_dir.join("vault.attachments"),
        &catalog_key,
        &account_number_hash,
    )
    .await
    .map_err(AttachmentUnusedListError::from)?;

    // Authoritative reference scan over ALL notes, fail-closed. Decrypts
    // every note → CPU/IO-bound → spawn_blocking. `items_key` +
    // `items_key_id` move into the closure (Zeroizing wipes on exit).
    let notes_dir = vault_dir.join("notes");
    // `run_blocking` is gone from this path rather than moved (task 44): the
    // scan's reads dispatch their own blocking through the seam, and its decodes
    // stay inline for the reason recorded on `collect_referenced_attachment_ids`.
    let referenced = crate::plugins::attachments::ref_scan::collect_referenced_attachment_ids(
        io,
        &notes_dir,
        &items_key,
        &items_key_id,
    )
    .await?;

    let rows: Vec<CatalogEntry> = catalog
        .entries
        .into_iter()
        // A tombstone is already deleted — never offered for cleanup (MYND-468).
        .filter(|(_, meta)| !meta.is_tombstone())
        .filter(|(id, _meta)| !referenced.contains(id))
        // SYNC-10 grace: withhold a freshly-added, never-referenced attachment
        // (e.g. a just-shared, not-yet-filed file) from the erase review for
        // UNUSED_CLEANUP_GRACE_SECS so it cannot be cleaned before the user
        // files it. `now.saturating_sub` guards a created_at ahead of `now`.
        .filter(|(_, meta)| now.saturating_sub(meta.created_at) >= UNUSED_CLEANUP_GRACE_SECS)
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
        event = "attachment_unused_listed",
        count = rows.len()
    );
    Ok(rows)
}

// ---- attachment_clean_unused --------------------------------------------

/// The outcome of an [`attachment_clean_unused`] sweep, surfaced to the
/// post-confirm summary. Hand-mirrored on the TS side.
#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct CleanResult {
    /// Number of attachments removed from the catalog (logically deleted).
    pub deleted: usize,
    /// Number of requested ids NOT removed — either now referenced by a
    /// note (TOCTOU re-verify caught it) or already absent from the catalog.
    pub skipped: usize,
    /// Total bytes freed by the blob unlinks that succeeded this call. A
    /// blob whose unlink failed / was already gone contributes 0 (its bytes
    /// are reclaimed by the unlock-time stray-file scan instead).
    pub bytes_reclaimed: u64,
}

/// Decide the survivor set and rewrite the catalog **catalog-first**
/// (MYND-171 Q5): drop every requested id that is present in the catalog
/// AND not in `referenced` (re-verified zero references), then atomic-write
/// the catalog ONCE. Returns the survivors (id + size, for the subsequent
/// blob unlinks) and the skipped count. The caller holds the catalog write
/// mutex across this call + the unlinks.
///
/// Catalog-first is deliberate and the OPPOSITE of single `attachment_delete`
/// (which unlinks first): a crash after this returns but before the unlinks
/// leaves catalog-less *stray blob files* — invisible to the user and swept
/// by the unlock-time scan — rather than dangling catalog entries that would
/// fail to open. `pub(crate)` so the crash-ordering test can stop here and
/// assert "catalog updated, blob still present".
pub(crate) async fn rewrite_catalog_dropping_unused(
    io: &dyn VaultIo,
    host: &dyn HostCtx,
    vault_dir: &Path,
    catalog_key: &[u8; 32],
    account_number_hash: &[u8; CATALOG_BLOB_ACCOUNT_HASH_LEN],
    requested: &[String],
    referenced: &std::collections::HashSet<String>,
) -> Result<(Vec<(String, u64)>, usize), AttachmentCleanUnusedError> {
    let catalog_path = vault_dir.join("vault.attachments");
    let mut catalog = read_catalog(io, &catalog_path, catalog_key, account_number_hash)
        .await
        .map_err(AttachmentCleanUnusedError::from)?;

    let mut survivors: Vec<(String, u64)> = Vec::new();
    let mut skipped = 0usize;
    for id in requested {
        match catalog.entries.get(id) {
            // Present, live, still zero-reference → erase. (Capture size
            // before the scrub so the summary can report bytes freed.)
            Some(meta) if !meta.is_tombstone() && !referenced.contains(id) => {
                survivors.push((id.clone(), meta.size))
            }
            // Absent / already tombstoned (gone) OR now referenced (TOCTOU) → skip.
            _ => skipped += 1,
        }
    }

    if !survivors.is_empty() {
        // MYND-468 (`sync-protocol.md` §11.4): swept entries become catalog
        // TOMBSTONES (not removals) so the deletion propagates to the fleet
        // and a stale catalog cannot resurrect them.
        let deleted_at = host.now_unix_secs();
        for (id, _) in &survivors {
            if let Some(meta) = catalog.entries.get(id).cloned() {
                catalog
                    .entries
                    .insert(id.clone(), meta.into_tombstone(deleted_at));
            }
        }
        let catalog_bytes = encode_attachments_catalog(catalog_key, account_number_hash, &catalog)
            .map_err(|_| AttachmentCleanUnusedError::EncodeFailed)?;
        io.write(&catalog_path, &catalog_bytes, WriteOpts::default())
            .await
            .map_err(AttachmentCleanUnusedError::from)?;
    }

    Ok((survivors, skipped))
}

/// `Slot::Unlocked`-gated batched erase of unused attachments — the
/// confirm step of "Clean unused attachments" (MYND-171). For each id the
/// user confirmed: re-verify it is STILL referenced by zero notes (the
/// authoritative, fail-closed scan — a note edited since the review list
/// was shown can have re-referenced it), drop the survivors from the
/// catalog in ONE atomic rewrite (catalog-first), then unlink their blobs.
///
/// Irreversible cryptographic erase (no trash tier). A requested id that
/// became referenced, or is already gone, is counted in `skipped`, not
/// erased. A note that cannot be read/decrypted during the re-verify aborts
/// the whole sweep (`NoteScanFailed`) with nothing deleted — fail-closed,
/// the same safety posture as `attachment_unused_list`.
pub async fn attachment_clean_unused_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    ids: Vec<String>,
) -> Result<CleanResult, AttachmentCleanUnusedError> {
    let dir = vault_dir_from_host(host, state.active_vault_id().await)
        .map_err(AttachmentCleanUnusedError::from)?;
    let result = attachment_clean_unused_with_dir(io, host, &dir, state, ids).await;
    // MYND-468: swept tombstones (catalog + queued records) must push.
    if matches!(&result, Ok(r) if r.deleted > 0) {
        hooks.bump_local_change();
    }
    result
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn attachment_clean_unused<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    ids: Vec<String>,
) -> Result<CleanResult, AttachmentCleanUnusedError> {
    attachment_clean_unused_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        hooks.inner(),
        ids,
    )
    .await
}

/// Testable core of [`attachment_clean_unused`].
pub async fn attachment_clean_unused_with_dir(
    io: &dyn VaultIo,
    host: &dyn HostCtx,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    ids: Vec<String>,
) -> Result<CleanResult, AttachmentCleanUnusedError> {
    // Canonicalize + strict-validate every id FIRST (bug-canary; the UI
    // only passes catalog ids). Reject the whole batch on any malformation
    // — a partial erase from a malformed set would be worse than a loud no-op.
    let mut requested: Vec<String> = Vec::with_capacity(ids.len());
    for id in &ids {
        let bytes = hex_decode_id(id).ok_or(AttachmentCleanUnusedError::InvalidId)?;
        requested.push(hex_encode(&bytes)); // canonical lowercase
    }

    // The same gate as `attachment_unused_list`, repeated here rather than
    // trusted from there (phase3-web-client task 89). The list is advisory and
    // this is the irreversible half: a browser tab that fetched the list while
    // complete, then lost storage, then confirmed, would erase against a corpus
    // that shrank underneath it. Re-checking at the destructive step is the same
    // reason this command re-runs the whole reference scan instead of trusting
    // the ids it was handed.
    if !crate::plugins::sync::corpus::corpus_state(io, vault_dir)
        .await
        .permits_whole_corpus_sweep()
    {
        tracing::warn!(
            stage = "corpus_gate",
            event = "clean_unused_refused",
            "attachment_clean_unused refused: corpus not proven complete"
        );
        return Err(AttachmentCleanUnusedError::CorpusIncomplete);
    }

    let (_slots_guard, items_key, items_key_id, root_key) = state
        .hold_unlocked_attachment_material()
        .await
        .ok_or(AttachmentCleanUnusedError::Locked)?;

    let account_number_hash =
        match read_account_number_hash(io, &vault_dir.join("vault.meta")).await? {
            Ok(h) => h,
            Err(MetaParseFailed) => return Err(AttachmentCleanUnusedError::InvalidVaultMeta),
        };
    let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);

    // Authoritative re-verify scan over ALL notes (fail-closed). Decrypts
    // every note → spawn_blocking. This closes the review→confirm TOCTOU:
    // an id re-referenced since the list was shown is in `referenced` and
    // gets skipped below. (Residual: a note save landing in the sub-ms
    // window between this scan and the catalog write below is not covered —
    // there is no vault-wide write lock in v0.1; Phase 2 sync revisit.)
    let notes_dir = vault_dir.join("notes");
    let referenced = crate::plugins::attachments::ref_scan::collect_referenced_attachment_ids(
        io,
        &notes_dir,
        &items_key,
        &items_key_id,
    )
    .await?;

    // Serialize the catalog RMW + unlinks against concurrent import/delete.
    let _write_guard = catalog_write_mutex().lock().await;

    // Catalog-first: drop survivors + rewrite the catalog, THEN unlink.
    let (survivors, skipped) = rewrite_catalog_dropping_unused(
        io,
        host,
        vault_dir,
        &catalog_key,
        &account_number_hash,
        &requested,
        &referenced,
    )
    .await?;

    // Queue each swept id's §11.4 blob-plane tombstone record (idempotent).
    // Best-effort per id — a failed queue write leaves the catalog tombstone
    // (which still propagates the deletion) and logs; the server-side body
    // reclaim then waits for a later re-delete or the horizon.
    for (id, _) in &survivors {
        if let Some(idb) = hex_decode_id(id) {
            if crate::plugins::sync::orchestrator::add_pending_attachment_tombstone(
                io, vault_dir, &idb,
            )
            .await
            .is_err()
            {
                tracing::warn!(
                    stage = "tombstone_queue",
                    "attachment_clean_unused tombstone queue write failed"
                );
            }
        }
    }

    let attachments_dir = vault_dir.join("attachments");
    let mut bytes_reclaimed = 0u64;
    for (id, size) in &survivors {
        // Crypto-erase parity with the single-delete path (§9.15.4): the MYE1
        // extracted-text cache lives under a persistent root_key-derived key (NOT
        // the per-attachment key destroyed with the blob), so dropping only the
        // MYA1 blob would leave a "permanently deleted" attachment's searchable
        // plaintext recoverable. Best-effort-remove the MYE1 cache too.
        if let Some(idb) = hex_decode_id(id) {
            if let Err(io_failure_kind) =
                super::text_cache::remove_extracted(io, vault_dir, &idb).await
            {
                tracing::warn!(
                    stage = "text_cache_unlink",
                    io_failure_kind = ?io_failure_kind,
                    "attachment_clean_unused MYE1 cache unlink failed; left as a stray"
                );
            }
        }
        match io.remove_file(&attachments_dir.join(id)).await {
            Ok(()) => bytes_reclaimed += *size,
            // Already gone: the catalog entry is dropped regardless (still
            // "deleted"); no bytes to count (reclaimed earlier).
            Err(IoFailureKind::NotFound) => {}
            // Unlink failed AFTER the catalog commit: the attachment is
            // logically deleted (catalog entry gone); the blob is now a
            // catalog-less stray file the unlock-time scan reclaims. Don't
            // fail the sweep over a cleanup remnant — log + carry on.
            Err(io_failure_kind) => {
                tracing::warn!(
                    stage = "blob_unlink",
                    io_failure_kind = ?io_failure_kind,
                    "attachment_clean_unused blob unlink failed post-catalog-commit; \
                     left as a stray file for the unlock-time scan"
                );
            }
        }
    }

    tracing::info!(
        stage = "success",
        event = "attachment_cleanup_done",
        deleted = survivors.len(),
        skipped = skipped
    );
    Ok(CleanResult {
        deleted: survivors.len(),
        skipped,
        bytes_reclaimed,
    })
}

// ---- unlock-time stray-blob reclaim (MYND-171) --------------------------

/// Outcome of the unlock-time stray-blob reclaim. Logged (not surfaced to
/// the WebView — this runs inside the unlock pipeline, best-effort).
pub(crate) enum StrayReclaimOutcome {
    /// `n` catalog-less hex blobs were unlinked (`n` may be 0).
    Removed(usize),
    /// The catalog file exists but did not decode — the valid-id set is
    /// untrustworthy, so the scan was **skipped** (nothing removed). The
    /// load-bearing fail-closed branch: a corrupt/tampered catalog must NOT
    /// make every blob look "stray" and trigger a mass deletion on unlock.
    SkipUndecodableCatalog,
    /// Filesystem error reading the catalog or scanning the dir.
    Io(IoFailureKind),
}

/// Remove catalog-less attachment blobs from `attachments_dir` — the pure
/// directory scan. A file is removed ONLY when its name is a canonical
/// 64-char lowercase-hex id (a final blob name) AND absent from `valid_ids`.
/// A cataloged id (incl. a zero-reference orphan the user has not swept) is
/// NEVER removed; a non-hex name (`.tmp`, `.DS_Store`, an interrupted-import
/// temp) is left untouched. Returns the count removed.
pub(crate) async fn reclaim_stray_blobs_in_dir(
    io: &dyn VaultIo,
    attachments_dir: &Path,
    valid_ids: &std::collections::HashSet<String>,
) -> Result<usize, IoFailureKind> {
    let entries = match io.read_dir(attachments_dir).await {
        Ok(e) => e,
        // No attachments dir yet → nothing to reclaim.
        Err(IoFailureKind::NotFound) => return Ok(0),
        Err(kind) => return Err(kind),
    };
    let mut removed = 0usize;
    for entry in entries {
        // Non-UTF-8 names cannot reach here — the seam's `DirEntry::name` is a
        // `String`, lossy-converted at the boundary — and a lossy-mangled name
        // simply fails the canonical-hex check below, which is what the old
        // `to_str()` arm did too.
        let name = entry.name.as_str();
        // Touch ONLY canonical 64-char lowercase-hex final blob names.
        // `hex_decode_id` enforces exactly that (rejects uppercase, wrong
        // length, non-hex, and any suffix like `.tmp`).
        if hex_decode_id(name).is_none() {
            continue;
        }
        // A cataloged id — including a zero-reference orphan awaiting the
        // user's explicit sweep — is never auto-removed. This is the guard
        // that keeps this scan from becoming the auto-GC the design rejects.
        if valid_ids.contains(name) {
            continue;
        }
        match io.remove_file(&attachments_dir.join(name)).await {
            Ok(()) => removed += 1,
            Err(IoFailureKind::NotFound) => {}
            Err(kind) => return Err(kind),
        }
    }
    Ok(removed)
}

/// Build the valid-id set from the catalog (fail-closed on an **undecodable**
/// catalog) and reclaim catalog-less stray blobs. Sync; testable without a
/// Tauri runtime. Uses [`decode_attachments_catalog`] directly (NOT
/// `read_or_empty`): a present-but-undecodable catalog yields
/// [`StrayReclaimOutcome::SkipUndecodableCatalog`] rather than an empty set —
/// otherwise a transiently-corrupt catalog would mark every blob stray and
/// delete the whole attachment store on unlock. A genuinely absent catalog
/// (`NotFound`) is the empty set: any hex blob is then a true orphan.
pub(crate) async fn reclaim_stray_blobs(
    io: &dyn VaultIo,
    vault_dir: &Path,
    catalog_key: &[u8; 32],
    account_number_hash: &[u8; CATALOG_BLOB_ACCOUNT_HASH_LEN],
) -> StrayReclaimOutcome {
    // Through `open_newest` (task 18/44): on the web store the catalog is two
    // alternating copies, and the fail-closed branch below is only sound if
    // "undecodable" means EVERY copy failed rather than "the newest file did".
    // Getting that wrong here is the expensive direction — it would mark every
    // blob stray and mass-delete the attachment store on unlock.
    let valid_ids: std::collections::HashSet<String> =
        match crate::singleton::open_newest(io, &vault_dir.join("vault.attachments"), |bytes| {
            decode_attachments_catalog(catalog_key, account_number_hash, bytes)
        })
        .await
        {
            // Only LIVE entries protect a blob (MYND-468): a blob whose entry is a
            // tombstone is a crypto-erased leftover (e.g. a crash between the
            // catalog tombstone write and the unlink) and is reclaimed like any
            // stray.
            Ok(catalog) => catalog
                .entries
                .into_iter()
                .filter(|(_, meta)| !meta.is_tombstone())
                .map(|(id, _)| id)
                .collect(),
            Err(crate::singleton::OpenOutcome::Absent) => std::collections::HashSet::new(),
            Err(crate::singleton::OpenOutcome::Undecodable(_)) => {
                return StrayReclaimOutcome::SkipUndecodableCatalog
            }
            Err(crate::singleton::OpenOutcome::Io(kind)) => return StrayReclaimOutcome::Io(kind),
        };
    match reclaim_stray_blobs_in_dir(io, &vault_dir.join("attachments"), &valid_ids).await {
        Ok(n) => StrayReclaimOutcome::Removed(n),
        Err(kind) => StrayReclaimOutcome::Io(kind),
    }
}

/// Unlock-time orchestration of [`reclaim_stray_blobs`] — wired into the
/// unlock pipeline after `recover_pending_rename_on_unlock`. Best-effort:
/// any failure is logged with a bounded reason and never blocks unlock. Holds
/// the catalog write mutex across the read+scan so it cannot race a
/// concurrent import/delete catalog RMW (none can occur at unlock time in
/// Phase 1's single window, but the guard keeps the invariant explicit).
pub async fn reclaim_stray_attachment_blobs(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) {
    let Ok(vault_dir) =
        crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
    else {
        tracing::warn!(
            event = "stray_scan_skipped",
            reason = "vault_dir_resolution_failed"
        );
        return;
    };
    let Some(root_key) = state.peek_unlocked_root_key_clone().await else {
        // A concurrent lock raced (Phase 2 only) — skip.
        tracing::warn!(event = "stray_scan_skipped", reason = "slot_not_unlocked");
        return;
    };
    let account_number_hash =
        match read_account_number_hash(io, &vault_dir.join("vault.meta")).await {
            Ok(Ok(h)) => h,
            Ok(Err(MetaParseFailed)) => {
                tracing::warn!(event = "stray_scan_skipped", reason = "invalid_vault_meta");
                return;
            }
            Err(io_failure_kind) => {
                tracing::warn!(
                    event = "stray_scan_skipped",
                    reason = "meta_io",
                    io_failure_kind = ?io_failure_kind,
                );
                return;
            }
        };
    let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);

    let _write_guard = catalog_write_mutex().lock().await;
    // No `run_blocking` wrapper any more: what this does is a catalog read, a
    // directory walk and N unlinks — all IO, all dispatching their own blocking
    // on the native arm. The one piece of CPU work, the catalog AEAD decode, is
    // a single small blob.
    match reclaim_stray_blobs(io, &vault_dir, &catalog_key, &account_number_hash).await {
        StrayReclaimOutcome::Removed(n) if n > 0 => {
            tracing::info!(event = "stray_blobs_reclaimed", count = n);
        }
        StrayReclaimOutcome::Removed(_) => {}
        StrayReclaimOutcome::SkipUndecodableCatalog => {
            tracing::warn!(event = "stray_scan_skipped", reason = "catalog_undecodable");
        }
        StrayReclaimOutcome::Io(io_failure_kind) => {
            tracing::warn!(event = "stray_scan_io", io_failure_kind = ?io_failure_kind);
        }
    }
}

// ---- attachment_delete --------------------------------------------------

/// `Slot::Unlocked`-gated explicit delete of one attachment: removes the
/// blob file and the catalog entry. NO auto-GC — the reference graph is
/// the UI's concern; this is a deliberate user action. Deleting an
/// absent id is idempotent `Ok(())`.
pub async fn attachment_delete_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    id: String,
) -> Result<(), AttachmentDeleteError> {
    let dir = vault_dir_from_host(host, state.active_vault_id().await)
        .map_err(AttachmentDeleteError::from)?;
    let result = attachment_delete_with_dir(io, host, &dir, state, id).await;
    // MYND-468: the catalog tombstone + queued blob-plane tombstone must push.
    if result.is_ok() {
        hooks.bump_local_change();
    }
    result
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn attachment_delete<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    id: String,
) -> Result<(), AttachmentDeleteError> {
    attachment_delete_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        hooks.inner(),
        id,
    )
    .await
}

/// Testable core of [`attachment_delete`].
pub async fn attachment_delete_with_dir(
    io: &dyn VaultIo,
    host: &dyn HostCtx,
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

    // SYNC-6 writer-guard (MYND-32): guard bound across the catalog
    // atomic_write below.
    let (_slots_guard, root_key) = state
        .hold_unlocked_root_key()
        .await
        .ok_or(AttachmentDeleteError::Locked)?;

    let account_number_hash =
        match read_account_number_hash(io, &vault_dir.join("vault.meta")).await? {
            Ok(h) => h,
            Err(MetaParseFailed) => return Err(AttachmentDeleteError::InvalidVaultMeta),
        };

    let _write_guard = catalog_write_mutex().lock().await;

    let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
    let catalog_path = vault_dir.join("vault.attachments");
    let mut catalog = read_catalog(io, &catalog_path, &catalog_key, &account_number_hash)
        .await
        .map_err(AttachmentDeleteError::from)?;

    // Deletion under sync (MYND-468, `sync-protocol.md` §11.4): the entry is
    // NOT removed — it becomes an **attachment catalog tombstone** (`deleted_at`
    // set, descriptive metadata scrubbed), the multi-device deletion marker
    // that defeats stale-catalog resurrection. Order is catalog-first, then
    // the tombstone queue, then the local erase — every crash window between
    // them is retry-recoverable (a re-delete of a tombstoned id re-queues).
    let (was_present, needs_queue) = match catalog.entries.get(&id_hex) {
        Some(e) if !e.is_tombstone() => {
            let tomb = e.clone().into_tombstone(host.now_unix_secs());
            catalog.entries.insert(id_hex.clone(), tomb);
            let catalog_bytes =
                encode_attachments_catalog(&catalog_key, &account_number_hash, &catalog)
                    .map_err(|_| AttachmentDeleteError::EncodeFailed)?;
            io.write(&catalog_path, &catalog_bytes, WriteOpts::default())
                .await
                .map_err(AttachmentDeleteError::from)?;
            (true, true)
        }
        // Already tombstoned — an interrupted earlier delete; re-queue + re-erase.
        Some(_) => (false, true),
        None => (false, false),
    };

    // Queue the §11.4 blob-plane tombstone record for the next push cycle
    // (idempotent per id). A failure surfaces — without the queue entry the
    // server would never reclaim the body.
    if needs_queue {
        crate::plugins::sync::orchestrator::add_pending_attachment_tombstone(
            io,
            vault_dir,
            &attachment_id,
        )
        .await
        .map_err(|_| {
            AttachmentDeleteError::from(std::io::Error::other(
                "attachment tombstone queue write failed",
            ))
        })?;
    }

    // Remove the blob file (idempotent on NotFound).
    let blob_path = vault_dir.join("attachments").join(&id_hex);
    match io.remove_file(&blob_path).await {
        Ok(()) => {}
        Err(IoFailureKind::NotFound) => {}
        Err(io_error_kind) => {
            tracing::error!(
                stage = "blob_unlink",
                error_kind = "Io",
                io_failure_kind = ?io_error_kind,
                "attachment_delete blob unlink failed"
            );
            return Err(AttachmentDeleteError::Io { io_error_kind });
        }
    }

    // MYND-328: remove the extracted-text cache blob too. It holds plaintext-
    // derived text under a `root_key` subkey (NOT the erased per-attachment
    // key), so leaving it behind is decryptable residue of a deleted file —
    // delete it for cryptographic-erase parity with the MYA1 source (§9.15.4).
    if let Err(io_error_kind) =
        super::text_cache::remove_extracted(io, vault_dir, &attachment_id).await
    {
        tracing::error!(
            stage = "text_cache_unlink",
            error_kind = "Io",
            io_failure_kind = ?io_error_kind,
            "attachment_delete extracted-text cache unlink failed"
        );
        return Err(AttachmentDeleteError::Io { io_error_kind });
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
pub async fn attachment_rename_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    hooks: &crate::hooks::Hooks,
    id: String,
    filename: String,
) -> Result<(), AttachmentRenameError> {
    let dir = vault_dir_from_host(host, state.active_vault_id().await)
        .map_err(AttachmentRenameError::from)?;
    let result = attachment_rename_with_dir(io, host, &dir, state, id, filename).await;
    // MYND-468: the catalog's filename-LWW change must push.
    if result.is_ok() {
        hooks.bump_local_change();
    }
    result
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn attachment_rename<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    hooks: State<'_, crate::hooks::Hooks>,
    id: String,
    filename: String,
) -> Result<(), AttachmentRenameError> {
    attachment_rename_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        hooks.inner(),
        id,
        filename,
    )
    .await
}

/// Testable core of [`attachment_rename`].
pub(crate) async fn attachment_rename_with_dir(
    io: &dyn VaultIo,
    host: &dyn HostCtx,
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

    // SYNC-6 writer-guard (MYND-32): guard bound across the catalog
    // atomic_write below.
    let (_slots_guard, root_key) = state
        .hold_unlocked_root_key()
        .await
        .ok_or(AttachmentRenameError::Locked)?;

    let account_number_hash =
        match read_account_number_hash(io, &vault_dir.join("vault.meta")).await? {
            Ok(h) => h,
            Err(MetaParseFailed) => return Err(AttachmentRenameError::InvalidVaultMeta),
        };

    let _write_guard = catalog_write_mutex().lock().await;

    let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
    let catalog_path = vault_dir.join("vault.attachments");
    let mut catalog = read_catalog(io, &catalog_path, &catalog_key, &account_number_hash)
        .await
        .map_err(AttachmentRenameError::from)?;

    // A tombstoned entry is deleted — renaming it is NotFound (bug-canary;
    // the UI never lists tombstones).
    let Some(entry) = catalog
        .entries
        .get_mut(&id_hex)
        .filter(|e| !e.is_tombstone())
    else {
        return Err(AttachmentRenameError::AttachmentNotFound);
    };
    entry.filename = filename;
    // The filename-LWW discriminator for the sync merge (§11.4 rule 4).
    entry.updated_at = Some(host.now_unix_secs());

    let catalog_bytes = encode_attachments_catalog(&catalog_key, &account_number_hash, &catalog)
        .map_err(|_| AttachmentRenameError::EncodeFailed)?;
    io.write(&catalog_path, &catalog_bytes, WriteOpts::default())
        .await
        .map_err(AttachmentRenameError::from)?;

    tracing::info!(stage = "success", event = "attachment_renamed");
    Ok(())
}

// ---- attachment_serve (phase3-web-client task 44) ------------------------

/// One attachment's decrypted bytes plus the type they may be SERVED as.
///
/// The desktop equivalent is an `http::Response`; a browser has no HTTP layer
/// between the vault and the `<img>`, so the same two fields cross as a value
/// and the caller mints an object URL from them.
#[derive(Debug)]
pub struct ServedAttachment {
    /// The RE-SNIFFED, allowlist-fenced type — never the catalog hint, never
    /// `text/html`. Comes from [`super::sniff::served_content_type`], the one
    /// place that decision is written down.
    pub content_type: &'static str,
    /// The decrypted bytes.
    ///
    /// **Not `Zeroizing`, and that is the honest shape rather than a slip.**
    /// These are going straight into a `Blob` the browser owns and this process
    /// cannot wipe; wrapping the Rust-side copy would zero one of two copies and
    /// read as a guarantee that does not hold. Same reasoning the desktop serve
    /// path already applies to its response body, under the V8-leak-dominance
    /// argument in `src-tauri/CLAUDE.md`.
    pub bytes: Vec<u8>,
}

/// Decrypt one attachment and return its bytes with a safe served type.
///
/// The browser half of `protocol.md` §9.9's serve path. Same decode as the
/// desktop `attachment://` handler — id parse → catalog `content_type` (the
/// inner AAD, so decode needs the SAME bytes) → blob read → AEAD open — and the
/// same re-sniff afterwards, through the shared
/// [`served_content_type`](super::sniff::served_content_type).
///
/// Every failure that could distinguish a tampered blob from a wrong-key one
/// collapses to [`AttachmentServeError::Denied`] (§6.4).
pub async fn attachment_serve_with_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    id: &str,
) -> Result<ServedAttachment, AttachmentServeError> {
    // Strict id parse first — a bug canary; the UI only serves ids it rendered.
    let attachment_id = hex_decode_id(id).ok_or(AttachmentServeError::Denied)?;
    let id_hex = hex_encode(&attachment_id);

    let Some((items_key, items_key_id, root_key)) = state.peek_unlocked_attachment_material().await
    else {
        return Err(AttachmentServeError::Locked);
    };

    let account_number_hash =
        match read_account_number_hash(io, &vault_dir.join("vault.meta")).await? {
            Ok(h) => h,
            Err(MetaParseFailed) => return Err(AttachmentServeError::InvalidVaultMeta),
        };

    // The catalog carries the `content_type` bound into the blob's inner AAD at
    // encode time, so a missing entry means the blob cannot be decoded at all —
    // reported as not-found rather than denied, matching the desktop handler.
    let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
    let catalog = read_catalog(
        io,
        &vault_dir.join("vault.attachments"),
        &catalog_key,
        &account_number_hash,
    )
    .await?;
    let content_type_hint = catalog
        .entries
        .get(&id_hex)
        .filter(|meta| !meta.is_tombstone())
        .map(|meta| meta.content_type.clone())
        .ok_or(AttachmentServeError::NotFound)?;

    let blob = match io.read(&vault_dir.join("attachments").join(&id_hex)).await {
        Ok(b) => b,
        Err(IoFailureKind::NotFound) => return Err(AttachmentServeError::NotFound),
        Err(io_error_kind) => return Err(AttachmentServeError::Io { io_error_kind }),
    };

    // AEAD open is the CPU work and stays on the pool where there is one.
    let join = crate::task::run_blocking(move || {
        decode_attachment_blob(
            &blob,
            &attachment_id,
            content_type_hint.as_bytes(),
            &items_key,
            &items_key_id,
        )
        .map_err(|_| AttachmentServeError::Denied)
    })
    .await;
    let plaintext = match join {
        Ok(Ok(p)) => p,
        Ok(Err(e)) => {
            // Non-distinguishing per §6.4 — tampered / cross-vault / wrong-key
            // all arrive here as one outcome and leave as one.
            tracing::debug!(stage = "serve_decode", outcome = "denied");
            return Err(e);
        }
        Err(_join) => {
            tracing::error!(stage = "spawn_blocking_join", error_kind = "JoinFailure");
            return Err(AttachmentServeError::Denied);
        }
    };

    let content_type = super::sniff::served_content_type(&plaintext);
    let bytes = plaintext.to_vec();
    drop(plaintext); // explicit wipe of the Zeroizing source

    tracing::debug!(stage = "serve", outcome = "ok", content_type = content_type);
    Ok(ServedAttachment {
        content_type,
        bytes,
    })
}

/// Host-resolving wrapper for [`attachment_serve_with_dir`].
pub async fn attachment_serve_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    id: &str,
) -> Result<ServedAttachment, AttachmentServeError> {
    let dir = vault_dir_from_host(host, state.active_vault_id().await).map_err(|e| {
        AttachmentServeError::Io {
            io_error_kind: crate::io_failure_kind::from_io_error_kind(e.kind()),
        }
    })?;
    attachment_serve_with_dir(io, &dir, state, id).await
}

// ---- shared catalog read helpers ----------------------------------------

/// Read + decode the catalog, returning a HARD error on any IO failure
/// other than absence (absent file → empty catalog, the § 9.10.4 base
/// case). AEAD / parse failures collapse to empty via
/// [`protocol::read_or_empty`]. Used by the import + delete paths where a
/// genuine IO failure (permission denied) must surface rather than be
/// masked as an empty catalog (which would then be overwritten on the
/// subsequent atomic_write, silently destroying the real catalog).
/// `pub(crate)`: also consumed (read-only) by the notes plugin's
/// `note_export_attachments` (MYND-115 task 4) — there a masked-empty
/// catalog would mis-report every referenced attachment as missing, so
/// the hard-IO-error surface is the right one for it too.
pub async fn read_catalog(
    io: &dyn VaultIo,
    catalog_path: &Path,
    catalog_key: &[u8; 32],
    account_number_hash: &[u8; CATALOG_BLOB_ACCOUNT_HASH_LEN],
) -> Result<AttachmentsCatalog, IoFailureKind> {
    // `read_candidates`, not `read`, and the difference is only visible on the
    // web store: a corrupt NEWEST copy of a double-buffered catalog must fall
    // back to the older intact one rather than collapsing to the empty catalog
    // that `read_or_empty` would produce — because the very next thing several
    // callers do is write the catalog back, which would make an empty read
    // permanent. Native is unchanged: the default `read_candidates` yields one
    // element there, so this is the same read followed by the same decode.
    let candidates = io.read_candidates(catalog_path).await?;
    for bytes in &candidates {
        if let Ok(catalog) = decode_attachments_catalog(catalog_key, account_number_hash, bytes) {
            return Ok(catalog);
        }
    }
    // Absent, or present and undecodable: § 9.10.4's fall-back-to-empty. The
    // `read_or_empty` call is kept for the present-but-undecodable arm so this
    // stays the protocol crate's decision rather than a second copy of it.
    Ok(read_or_empty(
        catalog_key,
        account_number_hash,
        candidates.first().map(|b| b.as_slice()),
    ))
}

/// Closed failure surface of [`load_catalog_for_export`] — the two
/// export callers map each variant onto their own error enums (with
/// their own stage-tagged tracing), keeping the closed-enum logging
/// discipline at the call sites.
pub enum CatalogLoadError {
    /// `vault.meta` exists but does not parse — the catalog AAD
    /// identity cannot be derived.
    InvalidVaultMeta,
    /// IO failure reading `vault.meta`.
    MetaIo(IoFailureKind),
    /// Hard IO failure reading `vault.attachments` (absence is NOT an
    /// error — it decodes to the empty catalog per [`read_catalog`]).
    CatalogIo(IoFailureKind),
}

/// The full catalog-for-export ritual, owned by the attachments
/// plugin: read `vault.meta`'s `account_number_hash` (the catalog AAD
/// identity, §9.10.3), derive the catalog KEK from `root_key`, and
/// [`read_catalog`]. Shared by the per-note attachments export
/// (`plugins::notes`) and the whole-vault tree export
/// (`plugins::export`) — both read-only consumers where a
/// masked-empty catalog would mis-report referenced attachments as
/// missing, so the hard-IO-error surface is the right one.
pub async fn load_catalog_for_export(
    io: &dyn VaultIo,
    vault_root: &Path,
    root_key: &[u8; 32],
) -> Result<AttachmentsCatalog, CatalogLoadError> {
    let account_number_hash =
        match read_account_number_hash(io, &vault_root.join("vault.meta")).await {
            Ok(Ok(h)) => h,
            Ok(Err(MetaParseFailed)) => return Err(CatalogLoadError::InvalidVaultMeta),
            Err(kind) => return Err(CatalogLoadError::MetaIo(kind)),
        };
    let catalog_key = derive_subkey(root_key, SubkeyRole::AttachmentsCatalogKey);
    read_catalog(
        io,
        &vault_root.join("vault.attachments"),
        &catalog_key,
        &account_number_hash,
    )
    .await
    .map_err(CatalogLoadError::CatalogIo)
}

// ---- attachment_export --------------------------------------------------

/// `Slot::Unlocked`-gated export of one attachment's decrypted bytes to a
/// user-chosen `destination` (MYND-173). The frontend opens the native
/// Save dialog — the established export-suite convention (`pdf_export` /
/// `vault_export_markdown` also receive the chosen path) — and passes the
/// path plus the overwrite consent. The plaintext is decrypted in Rust
/// RAM and written via `atomic_write_unclobbered`; it never crosses back
/// into the WebView. This is the TB3 user-initiated-egress exception: the
/// destination is plaintext by the user's own intent.
pub async fn attachment_export_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    id: String,
    destination: String,
    overwrite: bool,
) -> Result<(), AttachmentExportError> {
    let dir = vault_dir_from_host(host, state.active_vault_id().await)
        .map_err(AttachmentExportError::from)?;
    attachment_export_with_dir(io, &dir, state, &id, PathBuf::from(destination), overwrite).await
}

/// IPC wrapper. Delegates; the command name and payload the frontend
/// sends are unchanged because this IS the registered command.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn attachment_export<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    id: String,
    destination: String,
    overwrite: bool,
) -> Result<(), AttachmentExportError> {
    attachment_export_from_host(
        &TauriHost::new(app),
        &crate::vault_io::StdVaultIo,
        state.inner(),
        id,
        destination,
        overwrite,
    )
    .await
}

/// Testable core of [`attachment_export`]. Type-agnostic: works for any
/// attachment (image / PDF / opaque generic) — the chip's Export action
/// and the image/PDF Save-As affordance both call it.
pub(crate) async fn attachment_export_with_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    state: &VaultRuntimeState,
    id: &str,
    destination: PathBuf,
    overwrite: bool,
) -> Result<(), AttachmentExportError> {
    // (1) Decode the id (64 lowercase-hex → 32 bytes). A malformed id is
    //     a bug-canary — the UI only exports ids it rendered.
    let id_bytes = hex_decode_id(id).ok_or(AttachmentExportError::InvalidId)?;

    // (1b) Destination sanity (export-suite parity, mirrors
    //      `vault_export::validate_destination`): the parent must exist and be
    //      a directory, and the destination must not itself be an existing
    //      directory. Reject a malformed target cleanly rather than surfacing a
    //      raw filesystem error deep in the write.
    if !crate::paths::parent_dir_ok(&destination) || destination.is_dir() {
        tracing::debug!(stage = "dest_check", error_kind = "InvalidDestination");
        return Err(AttachmentExportError::InvalidDestination);
    }

    // (2) Slot peek: items_key + items_key_id decrypt the blob; root_key
    //     derives the catalog KEK (for the content_type bound into the
    //     blob AAD). All three wipe on drop.
    let Some((items_key, items_key_id, root_key)) = state.peek_unlocked_attachment_material().await
    else {
        tracing::debug!(stage = "slot_check", outcome = "vault_locked");
        return Err(AttachmentExportError::Locked);
    };

    // (3) Catalog lookup → the content_type (AAD) + existence check.
    let catalog = load_catalog_for_export(io, vault_dir, &root_key)
        .await
        .map_err(|e| match e {
            CatalogLoadError::InvalidVaultMeta => AttachmentExportError::InvalidVaultMeta,
            CatalogLoadError::MetaIo(io_error_kind)
            | CatalogLoadError::CatalogIo(io_error_kind) => {
                AttachmentExportError::Io { io_error_kind }
            }
        })?;
    let Some(meta) = catalog.entries.get(id) else {
        tracing::debug!(stage = "catalog_lookup", outcome = "not_found");
        return Err(AttachmentExportError::NotFound);
    };
    let content_type = meta.content_type.clone();

    // (4) Read + decode the immutable blob on a blocking thread, then
    //     write the plaintext to the destination. The decrypted bytes are
    //     `Zeroizing` (wiped on closure exit); the on-disk copy is the
    //     user's deliberate egress (TB3). `atomic_write_unclobbered` keeps
    //     a pre-existing user file shaped like its own temp sibling safe
    //     (115-F1); `overwrite=false` rejects an existing target untouched.
    let blob_path = vault_dir.join("attachments").join(id);
    // The blob read moved OUT of `run_blocking` and onto the IO seam (task 44);
    // the AEAD decode and the destination write stay inside it. That split is
    // what the export path needs anyway: the DESTINATION is a user-chosen path
    // outside the vault, and `atomic_write_unclobbered`'s temp-file dance is a
    // host filesystem affordance with no OPFS analogue — which is exactly why
    // task 48 decides web's export shape separately rather than porting this.
    let blob = match io.read(&blob_path).await {
        Ok(b) => b,
        Err(IoFailureKind::NotFound) => return Err(AttachmentExportError::NotFound),
        Err(io_error_kind) => return Err(AttachmentExportError::Io { io_error_kind }),
    };
    let join = crate::task::run_blocking(move || -> Result<(), AttachmentExportError> {
        let bytes = decode_attachment_blob(
            &blob,
            &id_bytes,
            content_type.as_bytes(),
            &items_key,
            &items_key_id,
        )
        .map_err(|_| AttachmentExportError::Corrupt)?;
        match crate::atomic_write::atomic_write_unclobbered(&destination, &bytes, overwrite) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                Err(AttachmentExportError::TargetAlreadyExists)
            }
            Err(e) => Err(AttachmentExportError::from(e)),
        }
        // `bytes` (Zeroizing) + `items_key` drop here.
    })
    .await;

    let result = match join {
        Err(_join) => {
            tracing::error!(stage = "spawn_blocking_join", error_kind = "JoinFailure");
            return Err(AttachmentExportError::JoinFailure);
        }
        Ok(r) => r,
    };
    match &result {
        Ok(()) => tracing::info!(stage = "success", event = "attachment_exported"),
        Err(e) => tracing::warn!(
            stage = "export",
            error_kind = attachment_export_error_kind(e)
        ),
    }
    result
}

/// Static-string label for [`AttachmentExportError`] variants — emitted
/// via `tracing` without crossing IPC or dragging DENY-listed payloads.
/// A new variant compile-fails this match.
fn attachment_export_error_kind(e: &AttachmentExportError) -> &'static str {
    match e {
        AttachmentExportError::Locked => "Locked",
        AttachmentExportError::InvalidId => "InvalidId",
        AttachmentExportError::NotFound => "NotFound",
        AttachmentExportError::Corrupt => "Corrupt",
        AttachmentExportError::TargetAlreadyExists => "TargetAlreadyExists",
        AttachmentExportError::InvalidDestination => "InvalidDestination",
        AttachmentExportError::InvalidVaultMeta => "InvalidVaultMeta",
        AttachmentExportError::Io { .. } => "Io",
        AttachmentExportError::JoinFailure => "JoinFailure",
    }
}

/// Read + decode the catalog, collapsing ANY failure (including IO) to
/// the empty catalog — the read-only `catalog_list` path, where a
/// transient IO error showing an empty library is acceptable (the next
/// list retries) and where no destructive write follows.
async fn read_catalog_or_empty(
    io: &dyn VaultIo,
    catalog_path: &Path,
    catalog_key: &[u8; 32],
    account_number_hash: &[u8; CATALOG_BLOB_ACCOUNT_HASH_LEN],
) -> AttachmentsCatalog {
    read_catalog(io, catalog_path, catalog_key, account_number_hash)
        .await
        .unwrap_or_else(|_| AttachmentsCatalog::empty())
}

/// Rebuild the attachment reference graph from the notes on disk.
///
/// **Why this runs at all.** The graph is RAM-only: `zeroize_attachment_refs`
/// wipes it on every lock, and it was only ever written by
/// `attachment_refs_apply` as a note is SAVED. Nothing rebuilt it on the way
/// back in — `reconcile.rs` says so in its own header ("the live note lifecycle
/// plus the unlock-time full rebuild is NOT wired here"). The visible result
/// was that after every app start each attachment reported "used in 0 notes",
/// on every client, until its referencing note happened to be re-saved. Unlike
/// `vault.indices` (persisted, MYI1), this graph has no disk form to reload, so
/// the rebuild has to read the notes.
///
/// Best-effort and silent on failure, like the sibling hydrates: a graph that
/// cannot be rebuilt is left as empty as it already was, and an unlock the user
/// completed must never fail because of it. `collect_note_attachment_refs` is
/// fail-closed, so a partial walk aborts rather than installing an
/// under-reporting graph — under-reporting is what would make a delete warning
/// lie about which notes it breaks.
pub async fn hydrate_attachment_refs_core(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    refs: &crate::plugins::attachments::reconcile::AttachmentRefsState,
) {
    let Ok(vault_dir) =
        crate::paths::active_vault_root_io_from_host(host, state.active_vault_id().await)
    else {
        tracing::warn!(
            event = "attachment_refs_rebuild_skipped",
            reason = "vault_dir_resolution_failed"
        );
        return;
    };
    let Some((items_key, items_key_id, _root_key)) =
        state.peek_unlocked_attachment_material().await
    else {
        // A concurrent lock raced — skip; the next unlock rebuilds.
        tracing::warn!(
            event = "attachment_refs_rebuild_skipped",
            reason = "slot_not_unlocked"
        );
        return;
    };

    match crate::plugins::attachments::ref_scan::collect_note_attachment_refs(
        io,
        &vault_dir.join("notes"),
        &items_key,
        &items_key_id,
    )
    .await
    {
        Ok(pairs) => {
            let notes = pairs.len();
            for (note_id, ids) in pairs {
                refs.apply(&note_id, ids);
            }
            // Counts only — a note-id is a per-vault correlation tag and an
            // attachment-id is another, so neither goes in a log line.
            tracing::info!(event = "attachment_refs_rebuilt", notes);
        }
        Err(_) => {
            tracing::warn!(
                event = "attachment_refs_rebuild_skipped",
                reason = "scan_failed"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::vault_unlock::state::{
        fixture_unlocked_with_keys, test_vault_id, VaultRuntimeState,
    };
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
            .set_unlocked(
                test_vault_id(),
                fixture_unlocked_with_keys(SEED_ROOT, SEED_ITEMS, SEED_ITEMS_ID),
            )
            .await;
        state
    }

    async fn temp_vault() -> (ScopedTempDir, VaultRuntimeState) {
        let tmp = ScopedTempDir::new("attach-it").expect("scoped tempdir");
        seed_vault_meta(tmp.path(), SEED_ACCOUNT_HASH);
        let state = unlocked_state().await;
        (tmp, state)
    }

    // ── the two seams, filled in for the ~180 call sites below ──────────────
    //
    // Task 44 gave every core here `io: &dyn VaultIo` and (where it needs a
    // clock) `host: &dyn HostCtx`. Rewriting each call site to thread both would
    // have buried the behavioural diff in mechanical noise, so the shims below
    // shadow the now-wider cores with the OLD signatures and supply the real
    // `StdVaultIo` — the same move task 45 made for `themes`.
    //
    // They are shims, not fakes: every one drives the production function
    // against a real temp directory. A stub `VaultIo` would only have proved the
    // signatures compile.

    fn io() -> &'static crate::vault_io::StdVaultIo {
        &crate::vault_io::StdVaultIo
    }

    /// A host whose clock is the REAL wall clock.
    ///
    /// [`TestHost`]'s default is a fixed synthetic epoch, which is the right
    /// default for a test that asserts on time — but these tests assert
    /// `created_at` / `deleted_at` against `SystemTime::now()`-shaped
    /// expectations, exactly as the production `now_unix_secs()` they replaced
    /// produced. Pinning the clock here would have changed what the suite tests
    /// rather than what the code does.
    fn host() -> crate::host::test_host::TestHost {
        let h = crate::host::test_host::TestHost::new("/nonexistent-attachments-test-host");
        h.set_now(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        );
        h
    }

    async fn attachment_import_with_dir(
        vault_dir: &Path,
        state: &VaultRuntimeState,
        source: ImportSource,
    ) -> Result<ImportedAttachment, AttachmentImportError> {
        super::attachment_import_with_dir(io(), &host(), vault_dir, state, source).await
    }

    // Unused by this module's own tests (the desktop crate's `import_desktop`
    // tests are the ones that inject a real extractor), kept so the shim set
    // covers the full core surface rather than only what today's tests happen
    // to reach.
    #[allow(dead_code)]
    async fn attachment_import_with_dir_ext<F>(
        vault_dir: &Path,
        state: &VaultRuntimeState,
        source: ImportSource,
        created_at_override: Option<u64>,
        extract: F,
    ) -> Result<ImportedAttachment, AttachmentImportError>
    where
        F: Fn(&str, &str, &[u8]) -> ExtractedText + Send + 'static,
    {
        super::attachment_import_with_dir_ext(
            io(),
            &host(),
            vault_dir,
            state,
            source,
            created_at_override,
            extract,
        )
        .await
    }

    async fn catalog_list_with_dir(
        vault_dir: &Path,
        state: &VaultRuntimeState,
    ) -> Result<Vec<CatalogEntry>, CatalogListError> {
        super::catalog_list_with_dir(io(), vault_dir, state).await
    }

    async fn attachment_unused_list_with_dir(
        vault_dir: &Path,
        state: &VaultRuntimeState,
        now: u64,
    ) -> Result<Vec<CatalogEntry>, AttachmentUnusedListError> {
        super::attachment_unused_list_with_dir(io(), vault_dir, state, now).await
    }

    async fn attachment_clean_unused_with_dir(
        vault_dir: &Path,
        state: &VaultRuntimeState,
        ids: Vec<String>,
    ) -> Result<CleanResult, AttachmentCleanUnusedError> {
        super::attachment_clean_unused_with_dir(io(), &host(), vault_dir, state, ids).await
    }

    async fn attachment_delete_with_dir(
        vault_dir: &Path,
        state: &VaultRuntimeState,
        id: String,
    ) -> Result<(), AttachmentDeleteError> {
        super::attachment_delete_with_dir(io(), &host(), vault_dir, state, id).await
    }

    async fn attachment_rename_with_dir(
        vault_dir: &Path,
        state: &VaultRuntimeState,
        id: String,
        filename: String,
    ) -> Result<(), AttachmentRenameError> {
        super::attachment_rename_with_dir(io(), &host(), vault_dir, state, id, filename).await
    }

    async fn attachment_export_with_dir(
        vault_dir: &Path,
        state: &VaultRuntimeState,
        id: &str,
        destination: PathBuf,
        overwrite: bool,
    ) -> Result<(), AttachmentExportError> {
        super::attachment_export_with_dir(io(), vault_dir, state, id, destination, overwrite).await
    }

    async fn rewrite_catalog_dropping_unused(
        vault_dir: &Path,
        catalog_key: &[u8; 32],
        account_number_hash: &[u8; CATALOG_BLOB_ACCOUNT_HASH_LEN],
        requested: &[String],
        referenced: &std::collections::HashSet<String>,
    ) -> Result<(Vec<(String, u64)>, usize), AttachmentCleanUnusedError> {
        super::rewrite_catalog_dropping_unused(
            io(),
            &host(),
            vault_dir,
            catalog_key,
            account_number_hash,
            requested,
            referenced,
        )
        .await
    }

    async fn reclaim_stray_blobs(
        vault_dir: &Path,
        catalog_key: &[u8; 32],
        account_number_hash: &[u8; CATALOG_BLOB_ACCOUNT_HASH_LEN],
    ) -> StrayReclaimOutcome {
        super::reclaim_stray_blobs(io(), vault_dir, catalog_key, account_number_hash).await
    }

    async fn reclaim_stray_blobs_in_dir(
        attachments_dir: &Path,
        valid_ids: &std::collections::HashSet<String>,
    ) -> Result<usize, IoFailureKind> {
        super::reclaim_stray_blobs_in_dir(io(), attachments_dir, valid_ids).await
    }

    #[allow(dead_code)]
    async fn read_catalog(
        catalog_path: &Path,
        catalog_key: &[u8; 32],
        account_number_hash: &[u8; CATALOG_BLOB_ACCOUNT_HASH_LEN],
    ) -> Result<AttachmentsCatalog, IoFailureKind> {
        super::read_catalog(io(), catalog_path, catalog_key, account_number_hash).await
    }

    // Eager-text-extraction → MYE1-cache tests (MYND-328) moved to the desktop
    // crate (`src-tauri/.../attachments/import_desktop.rs`): they exercise the
    // desktop-only `lopdf`/`zip`/`quick-xml` extractor via
    // `attachment_import_with_dir_ext`, which lives here but takes the extractor
    // as an injected closure. The core `attachment_import_with_dir` used by these
    // slots is extraction-free (no-op extractor), so an in-core assertion of "the
    // MYE1 cache exists after import" cannot hold without the desktop producer.

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

    // ---- attachment_export (MYND-173) ----------------------------------

    #[test]
    fn export_round_trips_imported_bytes() {
        // Import opaque bytes, export them to a user destination, and
        // assert the written file is byte-identical to the input.
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let payload = b"opaque generic file \x00\x01\x02 contents".to_vec();
            let imported = attachment_import_with_dir(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: payload.clone(),
                    filename: Some("report.docx".to_string()),
                },
            )
            .await
            .expect("import succeeds");
            assert_eq!(imported.content_type, "application/octet-stream");

            let out = ScopedTempDir::new("attach-export-out").unwrap();
            let dest = out.path().join("report.docx");
            attachment_export_with_dir(tmp.path(), &state, &imported.id, dest.clone(), false)
                .await
                .expect("export succeeds");

            assert_eq!(std::fs::read(&dest).unwrap(), payload);
        });
    }

    #[test]
    fn export_rejects_when_locked() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("attach-export-locked").unwrap();
            seed_vault_meta(tmp.path(), SEED_ACCOUNT_HASH);
            let state = VaultRuntimeState::default(); // Empty slot
            let out = ScopedTempDir::new("attach-export-out").unwrap();
            let result = attachment_export_with_dir(
                tmp.path(),
                &state,
                &"0".repeat(64),
                out.path().join("x.bin"),
                false,
            )
            .await;
            assert!(matches!(result, Err(AttachmentExportError::Locked)));
            assert!(!out.path().join("x.bin").exists());
        });
    }

    #[test]
    fn export_unknown_id_is_not_found() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let out = ScopedTempDir::new("attach-export-out").unwrap();
            // Valid lowercase-hex id that was never imported.
            let result = attachment_export_with_dir(
                tmp.path(),
                &state,
                &"0".repeat(64),
                out.path().join("x.bin"),
                false,
            )
            .await;
            assert!(matches!(result, Err(AttachmentExportError::NotFound)));
            assert!(!out.path().join("x.bin").exists());
        });
    }

    #[test]
    fn export_malformed_id_is_invalid() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let out = ScopedTempDir::new("attach-export-out").unwrap();
            let result = attachment_export_with_dir(
                tmp.path(),
                &state,
                "not-a-hex-id",
                out.path().join("x.bin"),
                false,
            )
            .await;
            assert!(matches!(result, Err(AttachmentExportError::InvalidId)));
        });
    }

    #[test]
    fn export_existing_target_respects_overwrite_consent() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let imported = attachment_import_with_dir(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: b"v1 bytes".to_vec(),
                    filename: Some("f.bin".to_string()),
                },
            )
            .await
            .expect("import");

            let out = ScopedTempDir::new("attach-export-out").unwrap();
            let dest = out.path().join("f.bin");
            // Pre-existing file at the destination.
            std::fs::write(&dest, b"pre-existing user file").unwrap();

            // overwrite=false rejects and leaves the existing file intact.
            let blocked =
                attachment_export_with_dir(tmp.path(), &state, &imported.id, dest.clone(), false)
                    .await;
            assert!(matches!(
                blocked,
                Err(AttachmentExportError::TargetAlreadyExists)
            ));
            assert_eq!(std::fs::read(&dest).unwrap(), b"pre-existing user file");

            // overwrite=true replaces it with the decrypted bytes.
            attachment_export_with_dir(tmp.path(), &state, &imported.id, dest.clone(), true)
                .await
                .expect("overwrite export succeeds");
            assert_eq!(std::fs::read(&dest).unwrap(), b"v1 bytes");
        });
    }

    #[test]
    fn export_rejects_invalid_destination() {
        // A destination whose parent directory does not exist is rejected
        // cleanly (export-suite parity) before any decrypt.
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let imported = attachment_import_with_dir(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: b"bytes".to_vec(),
                    filename: Some("f.bin".to_string()),
                },
            )
            .await
            .expect("import");
            let out = ScopedTempDir::new("attach-export-out").unwrap();
            let bad = out.path().join("no-such-dir").join("f.bin");
            let result =
                attachment_export_with_dir(tmp.path(), &state, &imported.id, bad, false).await;
            assert!(matches!(
                result,
                Err(AttachmentExportError::InvalidDestination)
            ));
        });
    }

    #[test]
    fn export_error_kind_covers_every_variant() {
        // Drift guard mirroring import_error_kind_covers_every_variant.
        use crate::io_failure_kind::IoFailureKind;
        let cases = [
            (AttachmentExportError::Locked, "Locked"),
            (AttachmentExportError::InvalidId, "InvalidId"),
            (AttachmentExportError::NotFound, "NotFound"),
            (AttachmentExportError::Corrupt, "Corrupt"),
            (
                AttachmentExportError::TargetAlreadyExists,
                "TargetAlreadyExists",
            ),
            (
                AttachmentExportError::InvalidDestination,
                "InvalidDestination",
            ),
            (AttachmentExportError::InvalidVaultMeta, "InvalidVaultMeta"),
            (
                AttachmentExportError::Io {
                    io_error_kind: IoFailureKind::Other,
                },
                "Io",
            ),
            (AttachmentExportError::JoinFailure, "JoinFailure"),
        ];
        for (e, label) in cases {
            assert_eq!(attachment_export_error_kind(&e), label);
        }
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
    fn import_accepts_unsupported_type_as_octet_stream() {
        // MYND-173: a type the sniffer does not recognize is no longer
        // rejected — it is stored as an opaque attachment with
        // `application/octet-stream`, the real filename, and the real size.
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let imported = attachment_import_with_dir(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: b"not a known file type at all".to_vec(),
                    filename: Some("mystery.docx".to_string()),
                },
            )
            .await
            .expect("opaque import succeeds");

            assert!(!imported.deduplicated);
            assert_eq!(imported.content_type, "application/octet-stream");
            assert_eq!(imported.filename, "mystery.docx");
            assert_eq!(imported.size, b"not a known file type at all".len() as u64);
            assert_eq!(imported.id.len(), 64);

            // Blob + catalog are on disk and the row lists with octet-stream.
            assert!(tmp.path().join("attachments").join(&imported.id).exists());
            let rows = catalog_list_with_dir(tmp.path(), &state)
                .await
                .expect("list succeeds");
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0].content_type, "application/octet-stream");
            assert_eq!(rows[0].filename, "mystery.docx");
        });
    }

    #[test]
    fn import_byte_source_without_filename_gets_bin_extension() {
        // An octet-stream byte-source with no caller filename falls back to
        // the generic `attachment.bin` auto-name (auto_filename `_` arm).
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let imported = attachment_import_with_dir(
                tmp.path(),
                &state,
                ImportSource::Bytes {
                    bytes: b"\x00\x01\x02 opaque blob".to_vec(),
                    filename: None,
                },
            )
            .await
            .expect("opaque import succeeds");
            assert_eq!(imported.content_type, "application/octet-stream");
            assert_eq!(imported.filename, "attachment.bin");
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

    // ---- attachment_unused_list (MYND-171) ----------------------------

    /// A PNG payload tagged with a distinguishing byte: distinct tags yield
    /// distinct content-addressed ids (identical bytes would dedup to one).
    fn png_with_tag(tag: u8) -> Vec<u8> {
        let mut v = vec![0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        v.push(tag);
        v
    }

    async fn import_tagged(tmp: &ScopedTempDir, state: &VaultRuntimeState, tag: u8) -> String {
        attachment_import_with_dir(
            tmp.path(),
            state,
            ImportSource::Bytes {
                bytes: png_with_tag(tag),
                filename: Some(format!("a{tag}.png")),
            },
        )
        .await
        .expect("import")
        .id
    }

    async fn create_note(notes_dir: &Path, state: &VaultRuntimeState, body: &str) -> String {
        std::fs::create_dir_all(notes_dir).unwrap();
        crate::plugins::notes::commands::note_create_with_dir(
            notes_dir.to_path_buf(),
            state,
            body.to_string(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("note_create")
    }

    /// Unused ids as an order-independent set (the command returns catalog
    /// `BTreeMap` order; tests assert membership, not order).
    async fn unused_ids(
        tmp: &ScopedTempDir,
        state: &VaultRuntimeState,
    ) -> std::collections::BTreeSet<String> {
        // u64::MAX disables the SYNC-10 grace window so these tests see every
        // never-referenced attachment regardless of its (just-set) created_at.
        attachment_unused_list_with_dir(tmp.path(), state, u64::MAX)
            .await
            .expect("unused_list")
            .into_iter()
            .map(|e| e.id)
            .collect()
    }

    #[test]
    fn unused_list_rejects_when_locked() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("attach-unused-locked").unwrap();
            let state = VaultRuntimeState::default(); // Empty slot
            let result = attachment_unused_list_with_dir(tmp.path(), &state, u64::MAX).await;
            assert!(matches!(result, Err(AttachmentUnusedListError::Locked)));
        });
    }

    #[test]
    fn unused_list_empty_when_no_attachments() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            assert!(unused_ids(&tmp, &state).await.is_empty());
        });
    }

    #[test]
    fn unused_list_reports_never_referenced_and_orphaned() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let notes_dir = tmp.path().join("notes");
            let a = import_tagged(&tmp, &state, 1).await;
            let b = import_tagged(&tmp, &state, 2).await;

            // `a` referenced by a note; `b` imported but never inserted →
            // the never-referenced import IS unused.
            let _note_a = create_note(&notes_dir, &state, &format!("![[att:{a}]]")).await;
            assert_eq!(
                unused_ids(&tmp, &state).await,
                std::collections::BTreeSet::from([b.clone()])
            );

            // Reference `b` too → nothing unused.
            let note_b = create_note(&notes_dir, &state, &format!("![[att:{b}]]")).await;
            assert!(unused_ids(&tmp, &state).await.is_empty());

            // Delete the note referencing `b` (orphan it) → `b` unused again.
            std::fs::remove_file(notes_dir.join(format!("{note_b}.myn"))).unwrap();
            assert_eq!(
                unused_ids(&tmp, &state).await,
                std::collections::BTreeSet::from([b.clone()])
            );

            // `a` is never offered for cleanup — it stayed referenced.
            assert!(!unused_ids(&tmp, &state).await.contains(&a));
        });
    }

    #[test]
    fn unused_list_withholds_recently_added_within_grace() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let t0 = host().now_unix_secs();
            // A never-referenced import — "unused", but freshly added (e.g. a
            // just-shared, not-yet-filed file). SYNC-10: it must not appear in
            // the Clean-Unused review until the grace window elapses.
            let a = import_tagged(&tmp, &state, 3).await;

            // Within the grace window → withheld.
            let within = attachment_unused_list_with_dir(
                tmp.path(),
                &state,
                t0 + UNUSED_CLEANUP_GRACE_SECS - 10,
            )
            .await
            .expect("unused_list");
            assert!(
                !within.iter().any(|e| e.id == a),
                "recent import is withheld"
            );

            // Past the grace window → offered for cleanup again.
            let past = attachment_unused_list_with_dir(
                tmp.path(),
                &state,
                t0 + UNUSED_CLEANUP_GRACE_SECS + 10,
            )
            .await
            .expect("unused_list");
            assert!(
                past.iter().any(|e| e.id == a),
                "aged-out import is cleanable"
            );
        });
    }

    #[test]
    fn unused_list_excludes_deduped_shared_attachment() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let notes_dir = tmp.path().join("notes");
            let a = import_tagged(&tmp, &state, 7).await;
            // Two notes embed the SAME content-addressed id (one shared
            // blob); the second uses the alias form to exercise that parse.
            let n1 = create_note(&notes_dir, &state, &format!("![[att:{a}]]")).await;
            let _n2 = create_note(&notes_dir, &state, &format!("see ![[att:{a}|pic]] ok")).await;

            // Remove the first note; the second still references `a`.
            std::fs::remove_file(notes_dir.join(format!("{n1}.myn"))).unwrap();
            assert!(
                unused_ids(&tmp, &state).await.is_empty(),
                "a shared attachment must not be listed unused while any note references it"
            );
        });
    }

    #[test]
    fn unused_list_fail_closed_on_unreadable_note() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let notes_dir = tmp.path().join("notes");
            // `_a` would be unused — but an unreadable note must abort the
            // whole computation rather than risk a false "unused" verdict.
            let _a = import_tagged(&tmp, &state, 9).await;
            let nid = create_note(&notes_dir, &state, "plain note, no embeds").await;
            // Corrupt the blob in place → decode fails → fail-closed.
            std::fs::write(
                notes_dir.join(format!("{nid}.myn")),
                b"not a valid MY01 blob",
            )
            .unwrap();
            let result = attachment_unused_list_with_dir(tmp.path(), &state, u64::MAX).await;
            assert!(matches!(
                result,
                Err(AttachmentUnusedListError::NoteScanFailed)
            ));
        });
    }

    // ---- attachment_clean_unused (MYND-171) ---------------------------

    fn blob_exists(tmp: &ScopedTempDir, id: &str) -> bool {
        tmp.path().join("attachments").join(id).exists()
    }

    async fn catalog_ids(tmp: &ScopedTempDir, state: &VaultRuntimeState) -> Vec<String> {
        catalog_list_with_dir(tmp.path(), state)
            .await
            .expect("catalog_list")
            .into_iter()
            .map(|e| e.id)
            .collect()
    }

    #[test]
    fn clean_unused_erases_orphan_and_reports_counts() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let a = import_tagged(&tmp, &state, 1).await; // unused, 9 bytes
            assert!(blob_exists(&tmp, &a));

            let result = attachment_clean_unused_with_dir(tmp.path(), &state, vec![a.clone()])
                .await
                .expect("clean");
            assert_eq!(
                result,
                CleanResult {
                    deleted: 1,
                    skipped: 0,
                    bytes_reclaimed: png_with_tag(1).len() as u64,
                }
            );
            // Catalog entry dropped + blob unlinked.
            assert!(!catalog_ids(&tmp, &state).await.contains(&a));
            assert!(!blob_exists(&tmp, &a));
        });
    }

    #[test]
    fn clean_unused_skips_referenced_toctou() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let notes_dir = tmp.path().join("notes");
            let a = import_tagged(&tmp, &state, 2).await;
            // A note references `a` — simulates a note that gained the
            // reference between the review list and the confirm.
            create_note(&notes_dir, &state, &format!("![[att:{a}]]")).await;

            let result = attachment_clean_unused_with_dir(tmp.path(), &state, vec![a.clone()])
                .await
                .expect("clean");
            assert_eq!(
                result,
                CleanResult {
                    deleted: 0,
                    skipped: 1,
                    bytes_reclaimed: 0,
                }
            );
            // Still-referenced attachment is untouched.
            assert!(catalog_ids(&tmp, &state).await.contains(&a));
            assert!(blob_exists(&tmp, &a));
        });
    }

    #[test]
    fn clean_unused_fail_closed_on_unreadable_note() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let notes_dir = tmp.path().join("notes");
            let a = import_tagged(&tmp, &state, 3).await; // would be erased
            let nid = create_note(&notes_dir, &state, "plain note").await;
            std::fs::write(notes_dir.join(format!("{nid}.myn")), b"corrupt blob").unwrap();

            let result =
                attachment_clean_unused_with_dir(tmp.path(), &state, vec![a.clone()]).await;
            assert!(matches!(
                result,
                Err(AttachmentCleanUnusedError::NoteScanFailed)
            ));
            // Nothing erased — the corrupt note aborted the whole sweep.
            assert!(catalog_ids(&tmp, &state).await.contains(&a));
            assert!(blob_exists(&tmp, &a));
        });
    }

    #[test]
    fn clean_unused_rejects_invalid_id() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let result =
                attachment_clean_unused_with_dir(tmp.path(), &state, vec!["not-hex".into()]).await;
            assert!(matches!(result, Err(AttachmentCleanUnusedError::InvalidId)));
        });
    }

    #[test]
    fn clean_unused_idempotent_when_blob_already_gone() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let a = import_tagged(&tmp, &state, 4).await;
            // Blob vanished out-of-band (e.g. a prior interrupted sweep);
            // the catalog still lists it.
            std::fs::remove_file(tmp.path().join("attachments").join(&a)).unwrap();

            let result = attachment_clean_unused_with_dir(tmp.path(), &state, vec![a.clone()])
                .await
                .expect("clean");
            assert_eq!(
                result,
                CleanResult {
                    deleted: 1,
                    skipped: 0,
                    bytes_reclaimed: 0, // blob already gone — no bytes freed now
                }
            );
            assert!(!catalog_ids(&tmp, &state).await.contains(&a));
        });
    }

    #[test]
    fn rewrite_catalog_dropping_unused_is_catalog_first() {
        // Simulates a crash AFTER the catalog rewrite but BEFORE the blob
        // unlinks: the catalog must already be updated (entry dropped) while
        // the blob still sits on disk as a catalog-less stray file — the
        // recoverable state the unlock-time scan (task 3) reclaims. Proves
        // catalog-first ordering without a panic seam.
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let a = import_tagged(&tmp, &state, 5).await;

            let catalog_key = derive_subkey(&[SEED_ROOT; 32], SubkeyRole::AttachmentsCatalogKey);
            let account_number_hash = [SEED_ACCOUNT_HASH; CATALOG_BLOB_ACCOUNT_HASH_LEN];
            let referenced = std::collections::HashSet::<String>::new();

            let (survivors, skipped) = rewrite_catalog_dropping_unused(
                tmp.path(),
                &catalog_key,
                &account_number_hash,
                std::slice::from_ref(&a),
                &referenced,
            )
            .await
            .expect("catalog rewrite");

            assert_eq!(skipped, 0);
            assert_eq!(survivors, vec![(a.clone(), png_with_tag(5).len() as u64)]);
            // Catalog-first: entry already dropped on disk...
            assert!(!catalog_ids(&tmp, &state).await.contains(&a));
            // ...but the blob is untouched (the unlink step hasn't run) —
            // a stray file for the unlock-time scan, NOT a dangling entry.
            assert!(blob_exists(&tmp, &a));
        });
    }

    // ---- unlock-time stray-blob reclaim (MYND-171, task 3) ------------

    #[test]
    fn reclaim_stray_blobs_in_dir_removes_only_catalog_less_hex() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("attach-stray-dir").unwrap();
            let dir = tmp.path().join("attachments");
            std::fs::create_dir_all(&dir).unwrap();
            let stray = "a".repeat(64); // 64-hex, NOT cataloged → removed
            let cataloged = "b".repeat(64); // 64-hex, cataloged → kept
            std::fs::write(dir.join(&stray), b"x").unwrap();
            std::fs::write(dir.join(&cataloged), b"x").unwrap();
            std::fs::write(dir.join("notes.txt"), b"x").unwrap(); // non-hex → kept
            std::fs::write(dir.join("c".repeat(63)), b"x").unwrap(); // wrong length → kept

            let valid: std::collections::HashSet<String> =
                std::iter::once(cataloged.clone()).collect();
            let removed = reclaim_stray_blobs_in_dir(&dir, &valid).await.unwrap();

            assert_eq!(removed, 1);
            assert!(!dir.join(&stray).exists(), "catalog-less hex blob removed");
            assert!(dir.join(&cataloged).exists(), "cataloged id preserved");
            assert!(dir.join("notes.txt").exists(), "non-hex left untouched");
            assert!(
                dir.join("c".repeat(63)).exists(),
                "wrong-length left untouched"
            );
        });
    }

    #[test]
    fn reclaim_stray_blobs_in_dir_empty_when_absent() {
        rt().block_on(async {
            let tmp = ScopedTempDir::new("attach-stray-absent").unwrap();
            let dir = tmp.path().join("attachments"); // never created
            let valid = std::collections::HashSet::new();
            assert_eq!(reclaim_stray_blobs_in_dir(&dir, &valid).await.unwrap(), 0);
        });
    }

    #[test]
    fn reclaim_stray_blobs_removes_stray_keeps_cataloged_with_good_catalog() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let a = import_tagged(&tmp, &state, 1).await; // cataloged
            let stray = "f".repeat(64);
            std::fs::write(tmp.path().join("attachments").join(&stray), b"x").unwrap();

            let catalog_key = derive_subkey(&[SEED_ROOT; 32], SubkeyRole::AttachmentsCatalogKey);
            let account_number_hash = [SEED_ACCOUNT_HASH; CATALOG_BLOB_ACCOUNT_HASH_LEN];
            let outcome = reclaim_stray_blobs(tmp.path(), &catalog_key, &account_number_hash).await;

            match outcome {
                StrayReclaimOutcome::Removed(n) => assert_eq!(n, 1),
                _ => panic!("expected Removed(1)"),
            }
            assert!(blob_exists(&tmp, &a), "cataloged blob preserved");
            assert!(
                !tmp.path().join("attachments").join(&stray).exists(),
                "catalog-less stray blob removed"
            );
        });
    }

    #[test]
    fn reclaim_stray_blobs_fail_closed_on_undecodable_catalog() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let a = import_tagged(&tmp, &state, 1).await; // real catalog + blob
            let stray = "f".repeat(64);
            std::fs::write(tmp.path().join("attachments").join(&stray), b"x").unwrap();

            // Corrupt the catalog: present-but-undecodable MUST abort the scan
            // (otherwise every blob looks stray → mass deletion on unlock).
            std::fs::write(tmp.path().join("vault.attachments"), b"garbage not MYC1").unwrap();

            let catalog_key = derive_subkey(&[SEED_ROOT; 32], SubkeyRole::AttachmentsCatalogKey);
            let account_number_hash = [SEED_ACCOUNT_HASH; CATALOG_BLOB_ACCOUNT_HASH_LEN];
            let outcome = reclaim_stray_blobs(tmp.path(), &catalog_key, &account_number_hash).await;

            assert!(matches!(
                outcome,
                StrayReclaimOutcome::SkipUndecodableCatalog
            ));
            // Nothing removed — both the cataloged blob AND the stray survive.
            assert!(blob_exists(&tmp, &a));
            assert!(tmp.path().join("attachments").join(&stray).exists());
        });
    }

    // ---- the corpus-completeness gate (phase3-web-client task 89) ----------
    //
    // The gated operation is a cryptographic erase whose tombstone PROPAGATES:
    // the desktop pulls it and erases its own copy, and the server drops the body
    // at horizon-GC. So the tests below are all about the two ways this can be
    // wrong — refusing when it should not (breaking a working desktop feature)
    // and permitting when it should not (destroying attachments across every
    // device the account has).

    /// Seed an enrolled-but-incomplete `sync-state.json`.
    async fn seed_sync_state(dir: &std::path::Path, complete: bool) {
        use crate::plugins::sync::state::SyncState;
        let s = SyncState {
            device_id_hex: Some("aa".repeat(16)),
            corpus_complete: complete,
            ..Default::default()
        };
        std::fs::write(dir.join("sync-state.json"), serde_json::to_vec(&s).unwrap()).unwrap();
    }

    #[test]
    fn unused_list_refuses_while_the_corpus_is_incomplete() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let _a = import_tagged(&tmp, &state, 1).await;
            seed_sync_state(tmp.path(), false).await;

            let result = attachment_unused_list_with_dir(tmp.path(), &state, u64::MAX).await;

            // Typed refusal, NOT an empty list. An empty list reads as "nothing
            // to clean", which is the second-worst answer — it is wrong AND it
            // looks like the good outcome.
            assert!(
                matches!(result, Err(AttachmentUnusedListError::CorpusIncomplete)),
                "expected CorpusIncomplete; got {result:?}"
            );
        });
    }

    #[test]
    fn clean_unused_refuses_while_the_corpus_is_incomplete_and_touches_nothing() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let a = import_tagged(&tmp, &state, 1).await;
            let catalog_before = std::fs::read(tmp.path().join("vault.attachments")).unwrap();
            seed_sync_state(tmp.path(), false).await;

            let result =
                attachment_clean_unused_with_dir(tmp.path(), &state, vec![a.clone()]).await;

            assert!(
                matches!(result, Err(AttachmentCleanUnusedError::CorpusIncomplete)),
                "expected CorpusIncomplete; got {result:?}"
            );
            // The whole point: a refused sweep leaves the catalog, the manifest
            // and every blob exactly as they were. Asserted on BYTES — a
            // re-serialised catalog with the same entries would be a rewrite
            // this command has no business performing.
            assert!(
                blob_exists(&tmp, &a),
                "the blob must survive a refused sweep"
            );
            assert_eq!(
                std::fs::read(tmp.path().join("vault.attachments")).unwrap(),
                catalog_before,
                "the catalog must be byte-unchanged by a refused sweep"
            );
        });
    }

    /// The regression that would break desktop. A vault that never enrolled has
    /// nothing missing — its local copy IS the corpus — so gating it would
    /// disable a working feature to protect against a state it cannot enter.
    #[test]
    fn a_vault_that_never_enrolled_is_not_gated() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let _a = import_tagged(&tmp, &state, 1).await;
            // No sync-state.json at all.
            let result = attachment_unused_list_with_dir(tmp.path(), &state, u64::MAX).await;
            assert!(
                result.is_ok(),
                "an unsynced vault must not be gated; got {result:?}"
            );
        });
    }

    #[test]
    fn a_device_that_proved_completeness_is_not_gated() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let _a = import_tagged(&tmp, &state, 1).await;
            seed_sync_state(tmp.path(), true).await;
            let result = attachment_unused_list_with_dir(tmp.path(), &state, u64::MAX).await;
            assert!(
                result.is_ok(),
                "a complete corpus must not be gated; got {result:?}"
            );
        });
    }

    /// phase3-web-client task 90: a web session must never reclaim a desktop
    /// session's `MYE1` extracted-text cache.
    ///
    /// The unlock-time stray scan is the only thing in the vault that deletes
    /// files nobody asked it to delete, so it is the one that could do this — and
    /// `attachments-text/<id-hex>` is *shaped exactly like* what it hunts: a
    /// canonical 64-char lowercase-hex filename with no catalog entry of its own.
    /// The only reason it survives is that the scan is handed `attachments/` and
    /// never walks a sibling. That is a one-argument invariant, which is why it
    /// gets a test rather than a comment: "scan the whole vault root for stray
    /// hex blobs" is a plausible future simplification, and it would silently
    /// erase the search cache of every attachment on the machine.
    ///
    /// Driven through the same entry point the unlock pipeline uses, with a
    /// deliberately catalog-less MYE1 file — the worst case, since a cataloged
    /// one would be protected by the valid-id set for the wrong reason.
    #[test]
    fn reclaim_stray_blobs_never_touches_the_mye1_text_cache() {
        rt().block_on(async {
            let (tmp, state) = temp_vault().await;
            let a = import_tagged(&tmp, &state, 1).await; // cataloged attachment
            let stray = "f".repeat(64);
            std::fs::write(tmp.path().join("attachments").join(&stray), b"x").unwrap();

            // A desktop session's MYE1 caches: one for the cataloged attachment,
            // one whose attachment is gone from the catalog entirely.
            let text_dir = tmp.path().join("attachments-text");
            std::fs::create_dir_all(&text_dir).unwrap();
            std::fs::write(text_dir.join(&a), b"MYE1 cached text for a live one").unwrap();
            std::fs::write(text_dir.join(&stray), b"MYE1 cached text, no catalog").unwrap();

            let catalog_key = derive_subkey(&[SEED_ROOT; 32], SubkeyRole::AttachmentsCatalogKey);
            let account_number_hash = [SEED_ACCOUNT_HASH; CATALOG_BLOB_ACCOUNT_HASH_LEN];
            let outcome = reclaim_stray_blobs(tmp.path(), &catalog_key, &account_number_hash).await;

            // The scan did its job on `attachments/` …
            match outcome {
                StrayReclaimOutcome::Removed(n) => assert_eq!(n, 1),
                _ => panic!("expected Removed(1)"),
            }
            assert!(!tmp.path().join("attachments").join(&stray).exists());

            // … and left `attachments-text/` entirely alone, including the entry
            // whose attachment it just reclaimed. Deleting THAT one would even
            // look defensible; it is still not this scan's call, because the
            // deletion paths that own MYE1 erasure (`attachment_delete`,
            // `attachment_clean_unused`, the sync tombstone) all go through
            // `text_cache::remove_extracted` and are keyed to a user action.
            assert!(
                text_dir.join(&a).exists(),
                "MYE1 cache of a cataloged attachment must survive the stray scan"
            );
            assert!(
                text_dir.join(&stray).exists(),
                "MYE1 cache is not a stray blob — the scan must not walk this directory"
            );
        });
    }
}
