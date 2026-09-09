// SPDX-License-Identifier: AGPL-3.0
//! The whole-vault plaintext markdown-tree export walk, host-free.
//!
//! Extracted from `myne-core`'s `plugins::export` so the `myne-decrypt` CLI can
//! run the same export the desktop app runs, without pulling `myne-core`'s TLS
//! stack and ML runtime. The walk takes the key material (`items_key`,
//! `items_key_id`, `root_key`) directly rather than a `VaultRuntimeState`, and
//! uses `std::fs` (it is native-only by design: the CLI and the desktop both
//! run it on a real filesystem).
//!
//! Tree mapping (the importer's inversion): FM `folder:` → directories; FM
//! `title:` + exactly one `.md` → filename (`"Untitled"` fallback; `" (1)"`
//! dedup per directory); value-strict `trashed:` → excluded + counted;
//! `template: true` → ordinary note; deliberate empty folders from prefs
//! recreated; `snapshots/` never enumerated (counted from the dir listing only).
//! Notes without embeds are written byte-verbatim; form-C embeds are rewritten
//! to `![[<final-filename>]]` (the §6 sanctioned transform).
//!
//! Staging: the destination itself is the new tree directory; the tree builds
//! at the sibling `<dest>.staging-<pid>` and publishes via `finalize_atomic`.
//! Failure / cancel discards staging: NOTHING ever appears at the destination
//! unless the export completed.
//!
//! Logging: counts-only; no paths, no titles, no note/attachment ids.

use crate::atomic_write;
use crate::export_error::VaultExportError;
use crate::export_naming::{
    export_dedup_key as dedup_key, rewrite_embeds_to_final_names, sanitize_export_component,
    suffixed_filename, DEDUP_RETRY_CAP,
};
use crate::io_failure_kind::IoFailureKind;
use crate::notes::decode::decode_note_any;
use crate::notes::export_mtime::{apply_updated_mtime_from, fm_rfc3339_field_in};
use crate::notes::note_id::NoteId;
use crate::notes::title_extract::{extract_title_slices, fm_folder, fm_title};
use protocol::{decode_attachment_blob, AttachmentsCatalog, MetaVersion, SubkeyRole};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

/// The reserved attachments directory at the export tree root.
const ATTACHMENTS_DIR: &str = "attachments";

/// Counts-only summary the UI renders after a published export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct VaultExportSummary {
    pub notes: u32,
    pub attachments: u32,
    pub folders: u32,
    pub excluded_trashed: u32,
    pub excluded_snapshots: u32,
    /// Notes and snapshots that could not be decoded, preserved under
    /// `_undecodable/` and named in `_FAILED.txt`. Zero on the app's
    /// all-or-nothing path; non-zero only when the CLI runs best-effort.
    pub failed: u32,
    /// Notes written into `_trash/` (the CLI's `trashed:` mode). Zero on the
    /// app's exclude-and-count path.
    pub trashed: u32,
    /// Snapshots exported into `snapshots/` (the CLI's `--history`). Zero on
    /// the app's count-only path.
    pub snapshots: u32,
}

/// How the walk treats a note whose value-strict `trashed:` marker is set.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrashedMode {
    /// The app: exclude the note and count it (`excluded_trashed`).
    Exclude,
    /// The CLI: write the note into `_trash/` so it is recoverable.
    Trash,
}

/// Side-channel hooks for the long-running export passes: counts-only progress
/// ticks and cooperative cancellation. The desktop's `ExportHooks` (tokio
/// `mpsc` + `AtomicBool`) implements this; the CLI supplies a no-op.
pub trait ExportHooks {
    fn tick(&self, done: u32, total: u32, phase: &'static str);
    fn check_cancel(&self) -> Result<(), VaultExportError>;
}

/// A no-op [`ExportHooks`] for callers that need neither progress nor cancel.
#[derive(Debug, Default, Clone, Copy)]
pub struct NoopExportHooks;

impl ExportHooks for NoopExportHooks {
    fn tick(&self, _done: u32, _total: u32, _phase: &'static str) {}
    fn check_cancel(&self) -> Result<(), VaultExportError> {
        Ok(())
    }
}

/// Inputs of the blocking stage pass, bundled.
pub struct StageParams {
    pub vault_dir: PathBuf,
    pub forbidden_roots: Vec<PathBuf>,
    pub destination: PathBuf,
    /// Normalized scope segments (`None` = whole vault).
    pub scope: Option<Vec<String>>,
    pub items_key: Zeroizing<[u8; 32]>,
    pub items_key_id: [u8; 16],
    pub root_key: Zeroizing<[u8; 32]>,
    pub version: MetaVersion,
    /// How tombstoned notes are handled. The app excludes-and-counts; the CLI
    /// writes them into `_trash/`.
    pub trashed: TrashedMode,
    /// Best-effort salvage: when `true`, an undecodable note is preserved under
    /// `_undecodable/` and named in `_FAILED.txt` instead of aborting the whole
    /// export. The app keeps `false` (all-or-nothing); the CLI sets `true`.
    pub best_effort: bool,
    /// Export note snapshots (version history) into `snapshots/`. The app keeps
    /// `false` (snapshots are counted, never enumerated); the CLI sets `true`
    /// when `--history` is passed.
    pub history: bool,
}

/// One attachment scheduled for the post-quiescence decrypt pass.
struct PendingTreeAttachment {
    id: String,
    filename: String,
    content_type: String,
}

/// Everything the finalize pass needs, produced under quiescence. The fields
/// are private: the caller passes this opaque value straight to
/// [`finalize_export`].
pub struct StagedExport {
    staging: PathBuf,
    destination: PathBuf,
    pending: Vec<PendingTreeAttachment>,
    notes: u32,
    folders: u32,
    excluded_trashed: u32,
    excluded_snapshots: u32,
    failed: u32,
    trashed: u32,
    snapshots: u32,
}

impl StagedExport {
    /// The staging directory, for the caller's join-failure cleanup path.
    pub fn staging_path(&self) -> &Path {
        &self.staging
    }
}

/// Blocking stage pass: validate, then decrypt every live note into the
/// staging tree (folders, filenames, dedup, embed rewrite, mtimes) and
/// recreate deliberate empty folders. Every error path removes the staging tree.
pub fn stage_export_tree(
    params: StageParams,
    hooks: &dyn ExportHooks,
) -> Result<StagedExport, VaultExportError> {
    if !params.vault_dir.join("vault.meta").is_file() {
        return Err(VaultExportError::VaultNotFound);
    }
    validate_destination(&params.destination, &params.forbidden_roots)?;
    let staging = staging_sibling(&params.destination).ok_or_else(|| {
        tracing::error!(
            stage = "dest_check",
            error_kind = "InvalidDestination",
            "vault_export destination has no usable final path component"
        );
        VaultExportError::InvalidDestination
    })?;

    // The staging tree holds decrypted plaintext for the whole export, so it is
    // created owner-only (0700) on unix: a sibling local account must not read
    // the note corpus mid-export. The destination itself is the user's own
    // choice; the staging sibling is ours.
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        std::fs::DirBuilder::new().mode(0o700).create(&staging)?;
    }
    #[cfg(not(unix))]
    std::fs::create_dir(&staging)?;

    let result = stage_export_tree_inner(&params, &staging, hooks);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

/// `vault.meta`'s `account_number_hash`, read synchronously.
fn read_account_number_hash_blocking(
    vault_dir: &Path,
) -> std::io::Result<Option<[u8; protocol::VAULT_META_ACCOUNT_HASH_LEN]>> {
    let bytes = std::fs::read(vault_dir.join("vault.meta"))?;
    Ok(protocol::parse_vault_meta_any(&bytes)
        .map(|m| m.account_number_hash)
        .ok())
}

/// Decode `vault.prefs` to a `PrefsView`, falling back to defaults on any
/// failure (§9.5.5: absent / undecodable prefs degrade to defaults, never fail).
fn decode_prefs_or_default(
    bytes: &[u8],
    prefs_key: &[u8; 32],
    account_number_hash: &[u8; protocol::VAULT_META_ACCOUNT_HASH_LEN],
) -> protocol::PrefsView {
    protocol::decode_prefs_blob(prefs_key, account_number_hash, bytes).unwrap_or_default()
}

/// Enumerate the `.myn` note ids in `notes_dir`, sorted ascending.
fn enumerate_notes_dir(notes_dir: &Path) -> std::io::Result<Vec<NoteId>> {
    let mut ids: Vec<NoteId> = Vec::new();
    for entry in std::fs::read_dir(notes_dir)? {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(stem) = name.strip_suffix(".myn") else {
            continue;
        };
        if let Ok(id) = NoteId::parse(stem) {
            ids.push(id);
        }
    }
    ids.sort();
    Ok(ids)
}

/// Decode a 64-char lowercase-hex attachment-id string into its 32-byte value.
fn hex_decode_id(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = [0u8; 32];
    for (i, out_byte) in out.iter_mut().enumerate() {
        let hi = hex_val(bytes[i * 2])?;
        let lo = hex_val(bytes[i * 2 + 1])?;
        *out_byte = (hi << 4) | lo;
    }
    Some(out)
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    }
}

fn stage_export_tree_inner(
    params: &StageParams,
    staging: &Path,
    hooks: &dyn ExportHooks,
) -> Result<StagedExport, VaultExportError> {
    let vault_dir = &params.vault_dir;

    let notes_dir = vault_dir.join("notes");
    let ids = match enumerate_notes_dir(&notes_dir) {
        Ok(ids) => ids,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.into()),
    };
    let excluded_snapshots = count_snapshot_files(&vault_dir.join("snapshots"))?;

    // `--history`: export note snapshots into `snapshots/` beside the notes.
    // Each snapshot is a `.myn` blob under the same `items_key`, named
    // `<note_uuid>__<snapshot_uuid>.myn`; it decodes through the same
    // `decode_note_any` dispatcher as a live note.
    let mut snapshots_written: u32 = 0;
    let mut snapshot_failed: Vec<String> = Vec::new();
    if params.history {
        let (written, failed_names) = export_snapshots(vault_dir, staging, params, hooks)?;
        snapshots_written = written;
        snapshot_failed = failed_names;
    }

    let account_number_hash = match read_account_number_hash_blocking(vault_dir) {
        Ok(Some(h)) => h,
        Ok(None) => {
            tracing::error!(
                stage = "read_meta",
                error_kind = "InvalidVaultMeta",
                "vault_export vault.meta parse failed"
            );
            return Err(VaultExportError::InvalidVaultMeta);
        }
        Err(e) => return Err(e.into()),
    };

    let prefs_key =
        protocol::derive_subkey_versioned(params.version, &params.root_key, SubkeyRole::PrefsKey);
    let prefs = match std::fs::read(vault_dir.join("vault.prefs")) {
        Ok(bytes) => decode_prefs_or_default(&bytes, &prefs_key, &account_number_hash),
        Err(_) => protocol::PrefsView::default(),
    };

    let mut assigned: HashMap<String, HashSet<String>> = HashMap::new();
    let mut dirs: BTreeSet<String> = BTreeSet::new();
    let mut att_final: HashMap<String, String> = HashMap::new();
    let mut pending: Vec<PendingTreeAttachment> = Vec::new();
    let mut catalog: Option<AttachmentsCatalog> = None;
    let mut notes_written: u32 = 0;
    let mut excluded_trashed: u32 = 0;
    let mut trashed_written: u32 = 0;
    let mut failed: u32 = 0;
    let mut failed_names: Vec<String> = Vec::new();
    // Snapshots ran before the notes loop: fold their best-effort failures
    // into the same manifest and count, so missing history is never silent.
    failed += snapshot_failed.len() as u32;
    failed_names.extend(snapshot_failed);

    let total = ids.len() as u32;
    for (i, id) in ids.iter().enumerate() {
        hooks.check_cancel()?;
        let done = i as u32 + 1;

        let blob = std::fs::read(notes_dir.join(format!("{}.myn", id.as_uuid())))?;
        let decrypted = match decode_note_any(
            &blob,
            id.as_uuid().as_bytes(),
            &params.items_key,
            &params.items_key_id,
        ) {
            Ok(d) => d,
            Err(_) => {
                tracing::debug!(
                    stage = "decode",
                    outcome = "cannot_decrypt",
                    "vault_export note decode returned CannotDecrypt"
                );
                if params.best_effort {
                    // Preserve the raw ciphertext and name it in _FAILED.txt;
                    // continue rather than aborting the whole export.
                    let undecodable = staging.join("_undecodable");
                    std::fs::create_dir_all(&undecodable)?;
                    let name = format!("{}.myn", id.as_uuid());
                    std::fs::write(undecodable.join(&name), &blob)?;
                    failed_names.push(name);
                    failed += 1;
                    hooks.tick(done, total, "notes");
                    continue;
                }
                return Err(VaultExportError::CannotDecrypt);
            }
        };
        let Ok(plaintext) = std::str::from_utf8(&decrypted) else {
            tracing::error!(
                stage = "utf8_check",
                error_kind = "InvalidPlaintextEncoding",
                "vault_export post-AEAD plaintext is not valid UTF-8"
            );
            return Err(VaultExportError::InvalidPlaintextEncoding);
        };

        let slices = extract_title_slices(&decrypted);
        let frontmatter = slices.frontmatter_bytes;

        let folder_raw = frontmatter.and_then(fm_folder);
        let folder_segs: Vec<&str> = folder_raw
            .as_deref()
            .map(folder_segments)
            .unwrap_or_default();
        let rel_segs: &[&str] = match &params.scope {
            None => &folder_segs,
            Some(prefix) => match strip_scope_prefix(&folder_segs, prefix) {
                Some(rel) => rel,
                None => {
                    hooks.tick(done, total, "notes");
                    continue;
                }
            },
        };

        let is_trashed = frontmatter
            .and_then(|fm| fm_rfc3339_field_in(fm, b"trashed:"))
            .is_some();
        if is_trashed && params.trashed == TrashedMode::Exclude {
            excluded_trashed += 1;
            hooks.tick(done, total, "notes");
            continue;
        }

        let title = frontmatter.and_then(fm_title);
        let base = match title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            Some(t) => sanitize_export_component(t, "attachment"),
            None => "Untitled".to_string(),
        };
        let filename = format!("{base}.md");

        let sanitized_segs: Vec<String> = rel_segs
            .iter()
            .map(|s| sanitize_export_component(s, "_"))
            .collect();
        // A trashed note in the CLI's Trash mode lands under `_trash/` rather
        // than its own folder, so it is recoverable but clearly set aside.
        let dir_rel = if is_trashed {
            record_dir_chain(&mut dirs, &["_trash".to_string()])
        } else {
            record_dir_chain(&mut dirs, &sanitized_segs)
        };
        let dir_abs = if dir_rel.is_empty() {
            staging.to_path_buf()
        } else {
            staging.join(&dir_rel)
        };
        std::fs::create_dir_all(&dir_abs)?;

        let final_name = {
            let names = assigned.entry(dedup_key(&dir_rel)).or_default();
            let picked = pick_deduped(names, &filename)?;
            names.insert(dedup_key(&picked));
            picked
        };

        let spans = crate::embed_span::extract_att_embed_spans(plaintext);
        for span in &spans {
            if att_final.contains_key(span.id) {
                continue;
            }
            if catalog.is_none() {
                let Some(meta_hash) = read_account_number_hash_blocking(vault_dir)? else {
                    tracing::error!(
                        stage = "read_meta",
                        error_kind = "InvalidVaultMeta",
                        "vault_export vault.meta parse failed"
                    );
                    return Err(VaultExportError::InvalidVaultMeta);
                };
                let catalog_key = protocol::derive_subkey_versioned(
                    params.version,
                    &params.root_key,
                    SubkeyRole::AttachmentsCatalogKey,
                );
                let loaded = match std::fs::read(vault_dir.join("vault.attachments")) {
                    Ok(bytes) => protocol::read_or_empty(&catalog_key, &meta_hash, Some(&bytes)),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        AttachmentsCatalog::empty()
                    }
                    Err(e) => return Err(e.into()),
                };
                catalog = Some(loaded);
            }
            let Some(meta) = catalog.as_ref().and_then(|c| c.entries.get(span.id)) else {
                tracing::error!(
                    stage = "catalog_lookup",
                    error_kind = "AttachmentMissing",
                    "vault_export referenced attachment id absent from catalog"
                );
                return Err(VaultExportError::AttachmentMissing);
            };
            let final_att = {
                let names = assigned.entry(dedup_key(ATTACHMENTS_DIR)).or_default();
                let picked = pick_deduped(
                    names,
                    &sanitize_export_component(&meta.filename, "attachment"),
                )?;
                names.insert(dedup_key(&picked));
                picked
            };
            att_final.insert(span.id.to_string(), final_att.clone());
            pending.push(PendingTreeAttachment {
                id: span.id.to_string(),
                filename: final_att,
                content_type: meta.content_type.clone(),
            });
        }

        let updated = frontmatter.and_then(|fm| fm_rfc3339_field_in(fm, b"updated:"));
        let target = dir_abs.join(&final_name);
        if spans.is_empty() {
            atomic_write::atomic_write_unclobbered(&target, &decrypted, false)?;
        } else {
            let rewritten =
                Zeroizing::new(rewrite_embeds_to_final_names(plaintext, &spans, &att_final));
            atomic_write::atomic_write_unclobbered(&target, rewritten.as_bytes(), false)?;
        }
        apply_updated_mtime_from(&target, updated);
        if is_trashed {
            trashed_written += 1;
        } else {
            notes_written += 1;
        }
        hooks.tick(done, total, "notes");
    }

    // The best-effort manifest: name every note and snapshot that could not
    // be decoded.
    if !failed_names.is_empty() {
        let mut manifest = String::from(
            "The following notes and snapshots could not be decrypted and were preserved under _undecodable/:\n",
        );
        for name in &failed_names {
            manifest.push_str(name);
            manifest.push('\n');
        }
        std::fs::write(staging.join("_FAILED.txt"), manifest)?;
    }

    for folder in &prefs.deliberate_folders {
        let segs = folder_segments(folder);
        let rel: &[&str] = match &params.scope {
            None => &segs,
            Some(prefix) => match strip_scope_prefix(&segs, prefix) {
                Some(rel) => rel,
                None => continue,
            },
        };
        if rel.is_empty() {
            continue;
        }
        let sanitized: Vec<String> = rel
            .iter()
            .map(|s| sanitize_export_component(s, "_"))
            .collect();
        let dir_rel = record_dir_chain(&mut dirs, &sanitized);
        std::fs::create_dir_all(staging.join(dir_rel))?;
    }

    Ok(StagedExport {
        staging: staging.to_path_buf(),
        destination: params.destination.clone(),
        pending,
        notes: notes_written,
        folders: dirs.len() as u32,
        excluded_trashed,
        excluded_snapshots,
        failed,
        trashed: trashed_written,
        snapshots: snapshots_written,
    })
}

/// Blocking finalize pass: decrypt the referenced immutable attachment blobs
/// into `attachments/` inside staging, then publish the whole tree via ONE
/// atomic rename. Every error path removes the staging tree.
pub fn finalize_export(
    staged: StagedExport,
    vault_dir: &Path,
    items_key: Zeroizing<[u8; 32]>,
    items_key_id: [u8; 16],
    hooks: &dyn ExportHooks,
) -> Result<VaultExportSummary, VaultExportError> {
    let result = finalize_export_inner(&staged, vault_dir, &items_key, &items_key_id, hooks);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staged.staging);
    }
    result
}

fn finalize_export_inner(
    staged: &StagedExport,
    vault_dir: &Path,
    items_key: &Zeroizing<[u8; 32]>,
    items_key_id: &[u8; 16],
    hooks: &dyn ExportHooks,
) -> Result<VaultExportSummary, VaultExportError> {
    let total = staged.pending.len() as u32;
    if total > 0 {
        std::fs::create_dir_all(staged.staging.join(ATTACHMENTS_DIR))?;
    }
    for (i, p) in staged.pending.iter().enumerate() {
        hooks.check_cancel()?;
        let Some(id_bytes) = hex_decode_id(&p.id) else {
            return Err(VaultExportError::AttachmentMissing);
        };
        let blob = match std::fs::read(vault_dir.join(ATTACHMENTS_DIR).join(&p.id)) {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tracing::error!(
                    stage = "read_attachment_blob",
                    error_kind = "AttachmentMissing",
                    "vault_export attachment blob file is gone"
                );
                return Err(VaultExportError::AttachmentMissing);
            }
            Err(e) => return Err(e.into()),
        };
        let bytes = decode_attachment_blob(
            &blob,
            &id_bytes,
            p.content_type.as_bytes(),
            items_key,
            items_key_id,
        )
        .map_err(|_| {
            tracing::error!(
                stage = "decode_attachment",
                error_kind = "AttachmentCorrupt",
                "vault_export attachment blob failed to decrypt"
            );
            VaultExportError::AttachmentCorrupt
        })?;
        atomic_write::atomic_write_unclobbered(
            &staged.staging.join(ATTACHMENTS_DIR).join(&p.filename),
            &bytes,
            false,
        )?;
        hooks.tick(i as u32 + 1, total, "attachments");
    }

    hooks.check_cancel()?;
    atomic_write::finalize_atomic(&staged.staging, &staged.destination, false)?;

    Ok(VaultExportSummary {
        notes: staged.notes,
        attachments: total,
        folders: staged.folders,
        excluded_trashed: staged.excluded_trashed,
        excluded_snapshots: staged.excluded_snapshots,
        failed: staged.failed,
        trashed: staged.trashed,
        snapshots: staged.snapshots,
    })
}

/// Destination contract: the destination itself is the NEW tree directory.
fn validate_destination(
    destination: &Path,
    forbidden_roots: &[PathBuf],
) -> Result<(), VaultExportError> {
    if !parent_dir_ok(destination) {
        tracing::error!(
            stage = "dest_check",
            error_kind = "InvalidDestination",
            "vault_export destination parent missing or not a directory"
        );
        return Err(VaultExportError::InvalidDestination);
    }
    let Some(parent) = destination.parent() else {
        return Err(VaultExportError::InvalidDestination);
    };
    if destination.symlink_metadata().is_ok() {
        tracing::error!(
            stage = "dest_check",
            error_kind = "DestinationAlreadyExists",
            "vault_export destination already exists"
        );
        return Err(VaultExportError::DestinationAlreadyExists);
    }
    let canon_parent = parent.canonicalize()?;
    for root in forbidden_roots {
        let Ok(canon_root) = root.canonicalize() else {
            continue;
        };
        if canon_parent.starts_with(&canon_root) {
            tracing::error!(
                stage = "dest_check",
                error_kind = "DestinationNotAllowed",
                "vault_export destination is inside the app data dir / a vault root"
            );
            return Err(VaultExportError::DestinationNotAllowed);
        }
    }
    Ok(())
}

/// The destination's parent must be non-empty and an existing directory.
fn parent_dir_ok(path: &Path) -> bool {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty() && p.is_dir())
        .is_some()
}

/// `<dest>.staging-<pid>` sibling (same directory ⇒ same filesystem ⇒ atomic
/// publish rename).
pub fn staging_sibling(destination: &Path) -> Option<PathBuf> {
    let name = destination.file_name()?.to_str()?;
    Some(
        destination
            .parent()?
            .join(format!("{name}.staging-{}", std::process::id())),
    )
}

/// Normalize a scope string into its canonical segments.
pub fn normalize_scope(scope: Option<&str>) -> Option<Vec<String>> {
    let segs: Vec<String> = scope?
        .split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    (!segs.is_empty()).then_some(segs)
}

/// Split a canonical `folder:` value into its non-empty segments.
fn folder_segments(folder: &str) -> Vec<&str> {
    folder.split('/').filter(|s| !s.is_empty()).collect()
}

/// `Some(rest)` when `segs` equals or is prefixed by `prefix` (component-wise).
pub fn strip_scope_prefix<'a>(segs: &'a [&'a str], prefix: &[String]) -> Option<&'a [&'a str]> {
    if segs.len() < prefix.len() {
        return None;
    }
    if segs.iter().zip(prefix).any(|(s, p)| *s != p.as_str()) {
        return None;
    }
    Some(&segs[prefix.len()..])
}

/// Record `segs`' full ancestor chain into the materialized-directory set and
/// return the joined relative path (`""` for the tree root).
fn record_dir_chain(dirs: &mut BTreeSet<String>, segs: &[String]) -> String {
    let mut acc = String::new();
    for seg in segs {
        if !acc.is_empty() {
            acc.push('/');
        }
        acc.push_str(seg);
        dirs.insert(acc.clone());
    }
    acc
}

/// Deterministic `" (1)"` suffix-dedup against the names already assigned in
/// one directory.
pub fn pick_deduped(names: &HashSet<String>, candidate: &str) -> Result<String, VaultExportError> {
    if !names.contains(&dedup_key(candidate)) {
        return Ok(candidate.to_string());
    }
    for n in 1..=DEDUP_RETRY_CAP {
        let suffixed = suffixed_filename(candidate, n);
        if !names.contains(&dedup_key(&suffixed)) {
            return Ok(suffixed);
        }
    }
    tracing::error!(
        stage = "dedup",
        error_kind = "Io",
        "vault_export exceeded the suffix-dedup retry cap"
    );
    Err(VaultExportError::Io {
        io_error_kind: IoFailureKind::Other,
    })
}

/// Count the `.myn` snapshot files in `snapshots/` without decrypting.
fn count_snapshot_files(snapshots_dir: &Path) -> Result<u32, VaultExportError> {
    let entries = match std::fs::read_dir(snapshots_dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    };
    let mut count: u32 = 0;
    for entry in entries {
        let entry = entry.map_err(VaultExportError::from)?;
        let is_myn_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false)
            && entry.path().extension() == Some(std::ffi::OsStr::new("myn"));
        if is_myn_file {
            count += 1;
        }
    }
    Ok(count)
}

/// Export every snapshot in `snapshots/` into `staging/snapshots/`, preserving
/// the `<note_uuid>__<snapshot_uuid>.myn` filename. Each snapshot decodes
/// through the same `decode_note_any` dispatcher as a live note. Returns the
/// number written plus the names that could not be decoded (the best-effort
/// manifest tail: the caller names them in `_FAILED.txt` and counts them in
/// `failed`, exactly like undecodable notes).
fn export_snapshots(
    vault_dir: &Path,
    staging: &Path,
    params: &StageParams,
    hooks: &dyn ExportHooks,
) -> Result<(u32, Vec<String>), VaultExportError> {
    let snapshots_dir = vault_dir.join("snapshots");
    let entries = match std::fs::read_dir(&snapshots_dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((0, Vec::new())),
        Err(e) => return Err(e.into()),
    };
    let mut names: Vec<String> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(VaultExportError::from)?;
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".myn") {
            names.push(name);
        }
    }
    names.sort();

    let dest_dir = staging.join("snapshots");
    let total = names.len() as u32;
    let mut written = 0u32;
    let mut failed_names: Vec<String> = Vec::new();
    for (i, name) in names.iter().enumerate() {
        hooks.check_cancel()?;
        let blob = std::fs::read(snapshots_dir.join(name))?;
        // The snapshot's note_uuid is the first half of the filename; the blob
        // binds it in its AAD, so decode under that uuid. An unparsable name
        // fails like an undecodable blob: abort outside best-effort, preserve
        // and name it inside best-effort, so history is never silently missing.
        let note_uuid = name.split("__").next().unwrap_or("");
        let Ok(note_uuid) = uuid::Uuid::parse_str(note_uuid) else {
            if params.best_effort {
                let undecodable = staging.join("_undecodable");
                std::fs::create_dir_all(&undecodable)?;
                std::fs::write(undecodable.join(name), &blob)?;
                failed_names.push(name.clone());
                continue;
            }
            return Err(VaultExportError::CannotDecrypt);
        };
        let decrypted = match decode_note_any(
            &blob,
            note_uuid.as_bytes(),
            &params.items_key,
            &params.items_key_id,
        ) {
            Ok(d) => d,
            Err(_) => {
                if params.best_effort {
                    let undecodable = staging.join("_undecodable");
                    std::fs::create_dir_all(&undecodable)?;
                    std::fs::write(undecodable.join(name), &blob)?;
                    failed_names.push(name.clone());
                    continue;
                }
                return Err(VaultExportError::CannotDecrypt);
            }
        };
        std::fs::create_dir_all(&dest_dir)?;
        atomic_write::atomic_write_unclobbered(&dest_dir.join(name), &decrypted, false)?;
        written += 1;
        hooks.tick(i as u32 + 1, total, "snapshots");
    }
    Ok((written, failed_names))
}
