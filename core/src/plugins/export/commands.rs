//! `vault_export_markdown` — decrypt the whole vault (or one folder
//! subtree) into a plaintext Obsidian-shape markdown tree (MYND-211).
//!
//! Concurrency discipline (the backup engine's SYNC-6 sequence):
//! 1. `try_acquire` the capacity-1 `auth_permits` lifecycle permit —
//!    reject-never-queue; held for the WHOLE export.
//! 2. Clone the slot material ONCE (`peek_unlocked_attachment_material`
//!    — items_key for note/attachment decrypt, root_key for the prefs +
//!    catalog subkeys). A locked vault rejects here: plaintext export is
//!    impossible without keys, unlike the ciphertext-copying backup.
//! 3. Take the writer-quiescence guard (slots WRITE lock) for the READ
//!    pass: note enumeration + decrypt + staging-tree writes + catalog
//!    read all observe a point-in-time-consistent vault. (The material
//!    is *peeked*, not *held* — a `hold_unlocked_*` read guard and the
//!    quiescence write guard on the same RwLock would deadlock; the
//!    permit excludes every key-rotating operation meanwhile.)
//! 4. Drop the guard; decrypt the immutable content-addressed MYA1
//!    blobs into `attachments/` (a blob deleted meanwhile fails the
//!    export honestly), then publish via ONE same-filesystem rename.
//!
//! Tree mapping (the importer's inversion — `src/notes/import/`):
//! FM `folder:` (canonical trailing-slash) → directories; FM `title:` +
//! exactly one `.md` → filename (`"Untitled"` fallback; `" (1)"` dedup
//! per directory); value-strict `trashed:` → excluded + counted;
//! `template: true` → ordinary note; deliberate empty folders from
//! prefs recreated; `snapshots/` never enumerated (counted from the dir
//! listing only). Notes without embeds are written byte-verbatim;
//! form-C embeds are rewritten to `![[<final-filename>]]` (the §6
//! sanctioned transform inverting the importer's form-C rewrite;
//! round-trip converges rather than byte-reverting — dialect §6).
//!
//! Staging: the destination itself is the new tree directory; the tree
//! builds at the sibling `<dest>.staging-<pid>` and publishes via
//! `finalize_atomic` (same directory ⇒ same filesystem ⇒ atomic).
//! Failure / cancel discards staging — NOTHING ever appears at the
//! destination unless the export completed.
//!
//! Logging: `// see: ../../CLAUDE.md "Secret-handling logging discipline"`
//! — counts-only; no paths, no titles, no note/attachment ids.

use crate::atomic_write;
use crate::export_naming::{
    rewrite_embeds_to_final_names, sanitize_export_component, suffixed_filename, DEDUP_RETRY_CAP,
};
use crate::io_failure_kind::IoFailureKind;
use crate::plugins::attachments::commands::hex_decode_id;
use crate::plugins::attachments::reconcile::extract_att_embed_spans;
use crate::plugins::notes::commands::enumerate_notes_dir;
use crate::plugins::notes::export_mtime::{apply_updated_mtime_from, fm_rfc3339_field_in};
use crate::plugins::notes::title_extract::{extract_title_slices, fm_folder, fm_title};
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use crate::vault_id::VaultId;
use protocol::{decode_attachment_blob, decode_note, derive_subkey, SubkeyRole};
use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime, State};
use zeroize::Zeroizing;

use super::error::{vault_export_error_kind, VaultExportError};

/// The reserved attachments directory at the export tree root — shares
/// its name-dedup namespace with any note whose own `folder:` is
/// literally `attachments/`.
const ATTACHMENTS_DIR: &str = "attachments";

/// Counts-only summary the UI renders after a published export.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct VaultExportSummary {
    /// Markdown files written into the tree.
    pub notes: u32,
    /// Attachment files written into `attachments/`.
    pub attachments: u32,
    /// Directories materialized in the tree (note folders + their
    /// ancestors + deliberate empty folders; the reserved
    /// `attachments/` dir is not counted).
    pub folders: u32,
    /// Notes excluded because their value-strict `trashed:` marker is a
    /// valid RFC 3339 timestamp.
    pub excluded_trashed: u32,
    /// `snapshots/` files excluded (counted from the dir listing — the
    /// snapshots dir is never enumerated into the tree).
    pub excluded_snapshots: u32,
}

/// Side-channel hooks for the long-running export passes — counts-only
/// progress ticks and cooperative cancellation (the backup
/// `ContainerHooks` shape, owned here so the export plugin carries no
/// backup-container dependency).
#[derive(Default, Clone)]
pub struct ExportHooks {
    /// Progress sink — `(done, total, phase)` where phase is `"notes"`
    /// or `"attachments"`. Never paths, never ids (DENY list).
    pub progress: Option<tokio::sync::mpsc::UnboundedSender<(u32, u32, &'static str)>>,
    /// Cooperative cancel flag (set by [`vault_export_cancel`]).
    pub cancelled: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
}

impl ExportHooks {
    /// Throttled progress tick: emit every 25th item, plus the FIRST
    /// item of a phase (`done == 1` — the phase transition the UI keys
    /// on) and the final `done == total`. Throttling at the source
    /// keeps a many-thousand-note vault from flooding the IPC event
    /// channel with one event per note.
    fn tick(&self, done: u32, total: u32, phase: &'static str) {
        if done != 1 && done != total && !done.is_multiple_of(25) {
            return;
        }
        if let Some(tx) = &self.progress {
            let _ = tx.send((done, total, phase));
        }
    }

    /// Clear the cancel flag — called only AFTER the lifecycle permit
    /// is ours, so a rejected second export never wipes a
    /// `vault_export_cancel` aimed at the in-flight one (the backup
    /// reset-position discipline).
    fn reset_cancel(&self) {
        if let Some(flag) = &self.cancelled {
            flag.store(false, std::sync::atomic::Ordering::Relaxed);
        }
    }

    fn check_cancel(&self) -> Result<(), VaultExportError> {
        match &self.cancelled {
            Some(flag) if flag.load(std::sync::atomic::Ordering::Relaxed) => {
                Err(VaultExportError::Cancelled)
            }
            _ => Ok(()),
        }
    }
}

/// `export://progress` — counts-only payload (DENY-list: no paths, no
/// titles, no ids). Mirrored on the TS side as `VaultExportProgress`.
pub(crate) const EXPORT_PROGRESS_EVENT: &str = "export://progress";

/// Payload for [`EXPORT_PROGRESS_EVENT`].
#[derive(Debug, Clone, Copy, Serialize)]
pub struct ExportProgressPayload {
    /// Items completed in the current phase.
    pub done: u32,
    /// Total items in the current phase.
    pub total: u32,
    /// `"notes"` (decrypt + stage, under quiescence) / `"attachments"`
    /// (immutable blob decrypt, after the lock drops).
    pub phase: &'static str,
}

/// Per-app export runtime: the cooperative cancel flag
/// [`vault_export_cancel`] sets.
#[derive(Default)]
pub struct ExportRuntime {
    pub(crate) cancel: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

pub(crate) fn export_runtime<R: Runtime>(app: &AppHandle<R>) -> tauri::State<'_, ExportRuntime> {
    use tauri::Manager;
    app.state::<ExportRuntime>()
}

/// Cancel the in-flight markdown export, if any. Idempotent; the export
/// returns `Cancelled` at its next cooperative check and discards the
/// staging tree — nothing appears at the destination.
#[tauri::command]
pub fn vault_export_cancel<R: Runtime>(app: AppHandle<R>) {
    export_runtime(&app)
        .cancel
        .store(true, std::sync::atomic::Ordering::Relaxed);
    tracing::info!(event = "vault_export_cancel_requested");
}

/// Export the vault at `vault_id` (explicit id, else the ACTIVE
/// unlocked vault) as a plaintext markdown tree at `destination` (the
/// new tree directory itself — it must not exist yet). `scope = None`
/// exports the whole vault; `Some(folder-prefix)` (canonical
/// trailing-slash form) exports only that subtree, rooted at the
/// subtree's contents.
#[tauri::command]
pub async fn vault_export_markdown<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, VaultRuntimeState>,
    vault_id: Option<String>,
    destination: String,
    scope: Option<String>,
) -> Result<VaultExportSummary, VaultExportError> {
    // Non-creating resolution (MYND-253, the backup precedent): export
    // reads an EXISTING vault; a missing/forged target must fail the
    // vault.meta probe cleanly, never materialize a directory.
    let target = match VaultId::parse_optional(vault_id.as_deref()) {
        Some(id) => Some(id),
        None => state.active_vault_id().await,
    };
    let vault_dir = crate::paths::vault_root_for_id_optional(&app, target).map_err(|_| {
        VaultExportError::Io {
            io_error_kind: IoFailureKind::Other,
        }
    })?;
    // The destination-rejection roots: the app data dir covers every
    // vault root beneath it; the resolved vault dir is added explicitly
    // (belt + suspenders for non-standard layouts).
    let app_data = crate::paths::app_data_dir(&app).map_err(|_| VaultExportError::Io {
        io_error_kind: IoFailureKind::Other,
    })?;
    let forbidden_roots = vec![app_data, vault_dir.clone()];

    // Progress forwarder: counts-only payloads to the WebView.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(u32, u32, &'static str)>();
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        while let Some((done, total, phase)) = rx.recv().await {
            let _ = emitter.emit(
                EXPORT_PROGRESS_EVENT,
                ExportProgressPayload { done, total, phase },
            );
        }
    });
    let runtime = export_runtime(&app);
    let hooks = ExportHooks {
        progress: Some(tx),
        cancelled: Some(runtime.cancel.clone()),
    };

    let result = vault_export_core(
        vault_dir,
        forbidden_roots,
        state.inner(),
        PathBuf::from(destination),
        scope,
        hooks,
    )
    .await;

    match &result {
        Ok(summary) => {
            tracing::info!(
                event = "vault_exported_markdown",
                notes = summary.notes,
                attachments = summary.attachments,
                folders = summary.folders,
                excluded_trashed = summary.excluded_trashed,
                excluded_snapshots = summary.excluded_snapshots,
                "vault markdown export published"
            );
        }
        Err(e) => {
            tracing::warn!(
                stage = "vault_export_markdown",
                error_kind = vault_export_error_kind(e),
                "vault markdown export failed"
            );
        }
    }
    result
}

/// Async core of [`vault_export_markdown`] — testable without an
/// `AppHandle`. Owns the permit → peek → quiesce(stage) → unguarded
/// attachments + publish sequence (module docs).
pub(crate) async fn vault_export_core(
    vault_dir: PathBuf,
    forbidden_roots: Vec<PathBuf>,
    state: &VaultRuntimeState,
    destination: PathBuf,
    scope: Option<String>,
    hooks: ExportHooks,
) -> Result<VaultExportSummary, VaultExportError> {
    // (1) Lifecycle permit, reject-never-queue, held until return.
    let _permit = state
        .auth_permits()
        .try_acquire()
        .map_err(|_| VaultExportError::AuthOperationInProgress)?;
    hooks.reset_cancel();

    // (2) Slot material ONCE — the loop never re-acquires per note.
    let Some((items_key, items_key_id, root_key)) = state.peek_unlocked_attachment_material().await
    else {
        tracing::debug!(
            stage = "slot_check",
            outcome = "vault_locked",
            "vault_export rejected: no unlocked vault"
        );
        return Err(VaultExportError::VaultNotUnlocked);
    };

    let scope = normalize_scope(scope.as_deref());

    // (3) Stage pass under writer quiescence (guard held across the
    // spawn_blocking await — the backup pattern; in-flight writers drain
    // first, new writers queue until the drop below).
    let quiesce = state.quiesce_writers().await;
    let params = StageParams {
        vault_dir: vault_dir.clone(),
        forbidden_roots,
        destination: destination.clone(),
        scope,
        items_key: items_key.clone(),
        items_key_id,
        root_key,
        hooks: hooks.clone(),
    };
    let staged = tokio::task::spawn_blocking(move || stage_export_tree(params))
        .await
        .map_err(|_| {
            // A panicked stage pass leaves user-consented plaintext in a
            // discovery-invisible sibling; the module contract is still
            // "every failure path discards staging".
            if let Some(staging) = staging_sibling(&destination) {
                let _ = std::fs::remove_dir_all(staging);
            }
            VaultExportError::JoinFailure
        })??;
    drop(quiesce);

    // (4) Attachment decrypt + publish, outside the lock window.
    let staging_for_cleanup = staged.staging.clone();
    let summary = tokio::task::spawn_blocking(move || {
        finalize_export(staged, &vault_dir, items_key, items_key_id, hooks)
    })
    .await
    .map_err(|_| {
        let _ = std::fs::remove_dir_all(&staging_for_cleanup);
        VaultExportError::JoinFailure
    })??;
    Ok(summary)
}

/// Inputs of the blocking stage pass, bundled (the pass runs in a
/// `spawn_blocking` closure and would otherwise take eight arguments).
struct StageParams {
    vault_dir: PathBuf,
    forbidden_roots: Vec<PathBuf>,
    destination: PathBuf,
    /// Normalized scope segments (`None` = whole vault).
    scope: Option<Vec<String>>,
    items_key: Zeroizing<[u8; 32]>,
    items_key_id: [u8; 16],
    root_key: Zeroizing<[u8; 32]>,
    hooks: ExportHooks,
}

/// One attachment scheduled for the post-quiescence decrypt pass: the
/// catalog was resolved and the FINAL (deduped) filename assigned
/// during the stage pass, so embeds could be rewritten; the blob bytes
/// are decrypted later (immutable, content-addressed — the SYNC-6
/// bounded-lock-hold rule).
struct PendingTreeAttachment {
    /// 64-char lowercase-hex attachment-id.
    id: String,
    /// Final filename inside `attachments/` (sanitized + deduped).
    filename: String,
    /// Catalog content-type — bound into the blob AAD.
    content_type: String,
}

/// Everything the finalize pass needs, produced under quiescence.
struct StagedExport {
    staging: PathBuf,
    destination: PathBuf,
    pending: Vec<PendingTreeAttachment>,
    notes: u32,
    folders: u32,
    excluded_trashed: u32,
    excluded_snapshots: u32,
}

/// Blocking stage pass: validate, then decrypt every live note into the
/// staging tree (folders, filenames, dedup, embed rewrite, mtimes) and
/// recreate deliberate empty folders. MUST run under the caller-held
/// writer-quiescence guard. Every error path removes the staging tree.
fn stage_export_tree(params: StageParams) -> Result<StagedExport, VaultExportError> {
    // A vault without vault.meta is not a vault.
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

    // `create_dir` (create-new semantics): a pre-existing entry at the
    // staging name FAILS the export instead of being reclaimed (115-F1
    // discipline at the destination parent — the old `remove_dir_all`
    // reclaim would have silently destroyed a user directory that
    // happened to carry the `<dest>.staging-<pid>` name). Stale crash
    // residue practically never collides: a new process gets a new pid,
    // and within one process the capacity-1 permit + the per-failure
    // `remove_dir_all` below keep the name free.
    std::fs::create_dir(&staging)?;

    let result = stage_export_tree_inner(&params, &staging);
    if result.is_err() {
        let _ = std::fs::remove_dir_all(&staging);
    }
    result
}

/// `vault.meta`'s `account_number_hash`, read synchronously.
///
/// The attachments plugin's shared version moved onto the storage seam and
/// became `async` with phase3-web-client task 44. This module cannot follow it:
/// `export` is host-only (gated out of the wasm build entirely) and this call
/// sits inside a synchronous staging pass, so there is nothing to await from.
/// Same shape and same justification as the `vault.prefs` read a few lines
/// below — the `std::fs` half is local, the DECODE stays the protocol crate's,
/// so the parse rule cannot drift.
///
/// `Ok(None)` is "present but does not parse" (the caller's `InvalidVaultMeta`);
/// absence and every other failure stay `Err`, matching what the shared helper
/// reported here before.
fn read_account_number_hash_blocking(
    vault_dir: &Path,
) -> std::io::Result<Option<[u8; protocol::VAULT_META_ACCOUNT_HASH_LEN]>> {
    let bytes = std::fs::read(vault_dir.join("vault.meta"))?;
    Ok(protocol::parse_vault_meta_any(&bytes)
        .map(|m| m.account_number_hash)
        .ok())
}

fn stage_export_tree_inner(
    params: &StageParams,
    staging: &Path,
) -> Result<StagedExport, VaultExportError> {
    let vault_dir = &params.vault_dir;
    let hooks = &params.hooks;

    let notes_dir = vault_dir.join("notes");
    let ids = match enumerate_notes_dir(&notes_dir) {
        Ok(ids) => ids,
        // A vault that never created a note has no notes/ dir — an
        // empty (but valid) export, not an error.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => return Err(e.into()),
    };
    let excluded_snapshots = count_snapshot_files(&vault_dir.join("snapshots"))?;

    // AAD identity for prefs + catalog (vault.meta presence was probed
    // above; an unlocked vault implies it parsed once already — a parse
    // failure here is honest corruption).
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

    // Deliberate empty folders (vault.prefs §9.5.2) — read-or-default,
    // the prefs read discipline (absent / undecodable prefs degrade to
    // "no deliberate folders", never fail the export).
    let prefs_key = derive_subkey(&params.root_key, SubkeyRole::PrefsKey);
    // `export` is host-only (gated out of the wasm build entirely) AND this
    // function is synchronous, so it cannot await the seam's read. It reads with
    // `std::fs` and shares the decode-and-fall-back half — § 9.5.5's "absent /
    // undecodable prefs degrade to defaults" is a spec rule, and a second copy
    // here would be a second place for it to drift.
    let prefs = match std::fs::read(vault_dir.join("vault.prefs")) {
        Ok(bytes) => crate::plugins::prefs::commands::decode_or_default(
            &bytes,
            &prefs_key,
            &account_number_hash,
        ),
        Err(_) => Default::default(),
    };

    // Tree-build state: per-directory assigned-name sets (the dedup
    // oracle — staging starts empty, so collisions only arise within
    // this run), the materialized-directory set (the `folders` count),
    // the id → final-attachment-name map (the embed-rewrite input), and
    // the deferred attachment list.
    let mut assigned: HashMap<String, HashSet<String>> = HashMap::new();
    let mut dirs: BTreeSet<String> = BTreeSet::new();
    let mut att_final: HashMap<String, String> = HashMap::new();
    let mut pending: Vec<PendingTreeAttachment> = Vec::new();
    let mut catalog: Option<protocol::AttachmentsCatalog> = None;
    let mut notes_written: u32 = 0;
    let mut excluded_trashed: u32 = 0;

    let total = ids.len() as u32;
    for (i, id) in ids.iter().enumerate() {
        hooks.check_cancel()?;
        let done = i as u32 + 1;

        let blob = std::fs::read(notes_dir.join(format!("{}.myn", id.as_uuid())))?;
        let decrypted = decode_note(
            &blob,
            id.as_uuid().as_bytes(),
            &params.items_key,
            &params.items_key_id,
        )
        .map_err(|_| {
            tracing::debug!(
                stage = "decode",
                outcome = "cannot_decrypt",
                "vault_export decode_note returned CannotDecrypt"
            );
            VaultExportError::CannotDecrypt
        })?;
        let Ok(plaintext) = std::str::from_utf8(decrypted.plaintext()) else {
            tracing::error!(
                stage = "utf8_check",
                error_kind = "InvalidPlaintextEncoding",
                "vault_export post-AEAD plaintext is not valid UTF-8"
            );
            return Err(VaultExportError::InvalidPlaintextEncoding);
        };

        // FM slices extracted ONCE per note — folder, trash marker,
        // title, and `updated:` all read off this one scan.
        let slices = extract_title_slices(decrypted.plaintext());
        let frontmatter = slices.frontmatter_bytes;

        // Folder + scope filter FIRST (a subtree export's exclusion
        // counts describe the subtree, not the vault).
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
                    // Out of scope — deliberately not part of this
                    // export (not an exclusion the summary reports).
                    hooks.tick(done, total, "notes");
                    continue;
                }
            },
        };

        // Trash exclusion — the value-strict read (TS lockstep): only a
        // valid RFC 3339 `trashed:` marks a note trashed.
        if frontmatter
            .and_then(|fm| fm_rfc3339_field_in(fm, b"trashed:"))
            .is_some()
        {
            excluded_trashed += 1;
            hooks.tick(done, total, "notes");
            continue;
        }

        // Filename: FM `title:` + exactly one `.md` (the importer's
        // strip-one-`.md` rule inverted); absent → "Untitled". Titles
        // sanitize under the SAME rule as catalog filenames.
        let title = frontmatter.and_then(fm_title);
        let base = match title.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            Some(t) => sanitize_export_component(t, "attachment"),
            None => "Untitled".to_string(),
        };
        let filename = format!("{base}.md");

        // Materialize the directory chain (sanitized segments; every
        // ancestor joins the folders count).
        let sanitized_segs: Vec<String> = rel_segs
            .iter()
            .map(|s| sanitize_export_component(s, "_"))
            .collect();
        let dir_rel = record_dir_chain(&mut dirs, &sanitized_segs);
        let dir_abs = if dir_rel.is_empty() {
            staging.to_path_buf()
        } else {
            staging.join(&dir_rel)
        };
        std::fs::create_dir_all(&dir_abs)?;

        // Deterministic per-directory dedup for duplicate (folder,
        // title) pairs.
        let final_name = {
            // The DIRECTORY key is folded too: `Work/` and `work/` are one
            // namespace on a case-insensitive volume, so they must share one
            // assigned set (myne#311).
            let names = assigned.entry(dedup_key(&dir_rel)).or_default();
            let picked = pick_deduped(names, &filename)?;
            names.insert(dedup_key(&picked));
            picked
        };

        // Resolve every NEW referenced attachment against the catalog
        // (lazily read — a vault with zero embeds never opens it) and
        // assign its final exported filename so the embed rewrite below
        // can splice real names. All-or-nothing: a referenced id absent
        // from the catalog fails the export here, staging discarded.
        let spans = extract_att_embed_spans(plaintext);
        for span in &spans {
            if att_final.contains_key(span.id) {
                continue;
            }
            if catalog.is_none() {
                // The attachments-plugin ritual (meta hash → catalog
                // KEK → read). The meta arms are unreachable in
                // practice — vault.meta already parsed above in this
                // same quiescent pass — but map honestly anyway.
                let Some(meta_hash) = read_account_number_hash_blocking(vault_dir)? else {
                    tracing::error!(
                        stage = "read_meta",
                        error_kind = "InvalidVaultMeta",
                        "vault_export vault.meta parse failed"
                    );
                    return Err(VaultExportError::InvalidVaultMeta);
                };
                let catalog_key =
                    derive_subkey(&params.root_key, SubkeyRole::AttachmentsCatalogKey);
                let loaded = match std::fs::read(vault_dir.join("vault.attachments")) {
                    Ok(bytes) => protocol::read_or_empty(&catalog_key, &meta_hash, Some(&bytes)),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        protocol::AttachmentsCatalog::empty()
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

        // Write: byte-verbatim when the note has no embeds; otherwise
        // the §6 sanctioned transform (every byte outside the spans
        // preserved — frontmatter included, so the `updated:` value
        // parsed off the one slice extraction above applies to both
        // branches). `replace=false` — staging starts empty, so an
        // AlreadyExists here would be a dedup bug, surfaced as Io. It WAS one,
        // on every case-insensitive volume: the oracle compared byte-exact
        // names while the volume does not, so `README.md` and `readme.md` both
        // read as unused and the second write aborted the whole export
        // (myne#311). The oracle folds case now — see `dedup_key`.
        // The unclobbered variant's randomized temps keep an in-run
        // sibling whose FINAL name is `<x>.tmp` safe from the later
        // `<x>` write's temp (115-F1 variant 2) — the published tree
        // is user-visible, so the in-staging namespace matters.
        let updated = frontmatter.and_then(|fm| fm_rfc3339_field_in(fm, b"updated:"));
        let target = dir_abs.join(&final_name);
        if spans.is_empty() {
            atomic_write::atomic_write_unclobbered(&target, decrypted.plaintext(), false)?;
        } else {
            let rewritten =
                Zeroizing::new(rewrite_embeds_to_final_names(plaintext, &spans, &att_final));
            atomic_write::atomic_write_unclobbered(&target, rewritten.as_bytes(), false)?;
        }
        apply_updated_mtime_from(&target, updated);
        notes_written += 1;
        hooks.tick(done, total, "notes");
        // Iteration end: `decrypted` (Zeroizing) drops, plaintext wipes.
    }

    // Deliberate empty folders (scope-relative), mkdir -p + counted.
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
            continue; // the tree root itself
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
    })
}

/// Blocking finalize pass: decrypt the referenced immutable attachment
/// blobs into `attachments/` inside staging, then publish the whole
/// tree via ONE atomic rename. Runs OUTSIDE the quiescence window.
/// Every error path removes the staging tree.
fn finalize_export(
    staged: StagedExport,
    vault_dir: &Path,
    items_key: Zeroizing<[u8; 32]>,
    items_key_id: [u8; 16],
    hooks: ExportHooks,
) -> Result<VaultExportSummary, VaultExportError> {
    let result = finalize_export_inner(&staged, vault_dir, &items_key, &items_key_id, &hooks);
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
    hooks: &ExportHooks,
) -> Result<VaultExportSummary, VaultExportError> {
    let total = staged.pending.len() as u32;
    if total > 0 {
        std::fs::create_dir_all(staged.staging.join(ATTACHMENTS_DIR))?;
    }
    for (i, p) in staged.pending.iter().enumerate() {
        hooks.check_cancel()?;
        // The span scanner only yields 64-lowercase-hex ids, so this
        // decode is structurally infallible; the defensive mapping
        // keeps the closed surface if that ever drifts.
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
        // Unclobbered for the same 115-F1 variant-2 reason as the note
        // writes: an attachment finally named `x.png.tmp` must survive
        // its `x.png` sibling's temp.
        atomic_write::atomic_write_unclobbered(
            &staged.staging.join(ATTACHMENTS_DIR).join(&p.filename),
            &bytes,
            false,
        )?;
        hooks.tick(i as u32 + 1, total, "attachments");
        // `bytes` (Zeroizing) drops here; the on-disk copy is the
        // user's deliberate egress.
    }

    // Publish: one same-filesystem rename (staging is a sibling of the
    // destination by construction). After this line the tree exists —
    // before it, nothing does.
    hooks.check_cancel()?;
    atomic_write::finalize_atomic(&staged.staging, &staged.destination, false)?;

    Ok(VaultExportSummary {
        notes: staged.notes,
        attachments: total,
        folders: staged.folders,
        excluded_trashed: staged.excluded_trashed,
        excluded_snapshots: staged.excluded_snapshots,
    })
}

/// Destination contract: the destination itself is the NEW tree
/// directory — its parent must exist and be a directory, nothing may
/// exist at the destination (never merge/replace), and it must not
/// canonicalize into any forbidden root (app data dir / vault root).
fn validate_destination(
    destination: &Path,
    forbidden_roots: &[PathBuf],
) -> Result<(), VaultExportError> {
    if !crate::paths::parent_dir_ok(destination) {
        tracing::error!(
            stage = "dest_check",
            error_kind = "InvalidDestination",
            "vault_export destination parent missing or not a directory"
        );
        return Err(VaultExportError::InvalidDestination);
    }
    // `parent_dir_ok` above guarantees the parent exists; the `else`
    // arm is unreachable but keeps the function total.
    let Some(parent) = destination.parent() else {
        return Err(VaultExportError::InvalidDestination);
    };
    // symlink_metadata: presence check that does NOT follow symlinks —
    // a dangling symlink at the destination still rejects.
    if destination.symlink_metadata().is_ok() {
        tracing::error!(
            stage = "dest_check",
            error_kind = "DestinationAlreadyExists",
            "vault_export destination already exists"
        );
        return Err(VaultExportError::DestinationAlreadyExists);
    }
    // Canonicalize-and-reject (the importer seam's component-wise
    // `starts_with`, write-side): the destination's parent resolved
    // through symlinks must not live inside a forbidden root.
    let canon_parent = parent.canonicalize()?;
    for root in forbidden_roots {
        let Ok(canon_root) = root.canonicalize() else {
            continue; // a root that does not exist cannot contain us
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

/// `<dest>.staging-<pid>` sibling (same directory ⇒ same filesystem ⇒
/// atomic publish rename). Dot-prefixless is fine — the name is
/// pid-scoped, transient, and removed on every failure path; it lives
/// at the user-chosen destination parent, never inside the vault.
fn staging_sibling(destination: &Path) -> Option<PathBuf> {
    let name = destination.file_name()?.to_str()?;
    Some(
        destination
            .parent()?
            .join(format!("{name}.staging-{}", std::process::id())),
    )
}

/// Normalize a scope string into its canonical segments. `None` (and a
/// scope that normalizes to the vault root — `""`, `"/"`) means whole
/// vault. Matching is byte-equality on the canonical Myne-written
/// segments (the importer's structural normalization, not its
/// case-fold identity — scope values come from the app's own folder
/// tree, which carries the canonical forms).
fn normalize_scope(scope: Option<&str>) -> Option<Vec<String>> {
    let segs: Vec<String> = scope?
        .split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    (!segs.is_empty()).then_some(segs)
}

/// Split a canonical `folder:` value into its non-empty segments
/// (structural normalization — duplicate / leading / trailing slashes
/// collapse, the TS `normalizeFolderPath` twin).
fn folder_segments(folder: &str) -> Vec<&str> {
    folder.split('/').filter(|s| !s.is_empty()).collect()
}

/// `Some(rest)` when `segs` equals or is prefixed by `prefix`
/// (component-wise — `"AB/"` is not under scope `"A/"`).
fn strip_scope_prefix<'a>(segs: &'a [&'a str], prefix: &[String]) -> Option<&'a [&'a str]> {
    if segs.len() < prefix.len() {
        return None;
    }
    if segs.iter().zip(prefix).any(|(s, p)| *s != p.as_str()) {
        return None;
    }
    Some(&segs[prefix.len()..])
}

/// Record `segs`' full ancestor chain into the materialized-directory
/// set and return the joined relative path (`""` for the tree root).
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

/// The key a name occupies in a directory's assigned set.
///
/// ASCII-lowercased, because the export writes with create-new semantics onto
/// whatever volume the user chose, and on macOS and Windows that volume is
/// case-INSENSITIVE by default (myne#311). A byte-exact dedup let `README.md`
/// and `readme.md` both be "unused", and the second write then returned
/// `AlreadyExists` — which propagates, discards the staging tree, and aborts
/// the WHOLE export with a generic write-failure line naming no file. It is
/// fully deterministic, so retrying never helped and the vault could never be
/// exported to such a volume again; the only workaround was renaming a note or
/// attachment the user had no reason to suspect.
///
/// Folding the ORACLE only — the emitted name keeps its original case, so
/// nothing about a successful export changes. This is a strict superset of the
/// old behaviour: byte-identical names still collide and still dedup, and the
/// case-differing pair now produces `readme (1).md` instead of failing.
///
/// `to_ascii_lowercase`, not `to_lowercase`: it matches what the platforms
/// actually do closely enough for a collision oracle and cannot change a
/// string's length, so the suffix arithmetic is unaffected. A pair that differs
/// only in non-ASCII case still collides on the volume and would still fail —
/// that is a narrower residue than the one this closes, and full Unicode
/// case-folding is not what either filesystem implements either.
fn dedup_key(name: &str) -> String {
    name.to_ascii_lowercase()
}

/// Deterministic `" (1)"` suffix-dedup against the names already
/// assigned in one directory (staging starts empty — pre-existing files
/// cannot exist, so the in-run set is the whole oracle).
///
/// `names` holds [`dedup_key`]s; the returned name is original-case.
fn pick_deduped(names: &HashSet<String>, candidate: &str) -> Result<String, VaultExportError> {
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

/// Count the `.myn` snapshot files in `snapshots/` without decrypting
/// (the PRD "report counts" rule); an absent dir counts zero. Only
/// `.myn` entries count (211-L3) — stray junk (`.DS_Store`-class
/// files) must not inflate the user-facing exclusion count.
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

// see: ../../CLAUDE.md "Secret-handling logging discipline"

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::attachments::commands::{attachment_import_with_dir, ImportSource};
    use crate::plugins::notes::commands::note_create_with_dir;
    use crate::plugins::vault_unlock::state::{
        fixture_unlocked_with_keys, test_vault_id, VaultRuntimeState,
    };
    use crate::test_support::ScopedTempDir;
    use std::fs;

    const SEED_ROOT: u8 = 0x07;
    const SEED_ITEMS: u8 = 0x09;
    const SEED_ITEMS_ID: u8 = 0x01;

    /// Sniffable PNG payloads with distinct tails (distinct
    /// content-addressed ids) — the notes-plugin export fixture bytes.
    const ATT_PNG_A: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xA1, 0xA2];
    const ATT_PNG_B: &[u8] = &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xB1, 0xB2];

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    /// Seed a parse-passing `vault.meta` (the prefs/catalog AAD identity
    /// source) — mirror of the notes plugin's export seeder.
    fn seed_vault_meta(vault_root: &Path) {
        let meta = protocol::VaultMeta {
            account_number_hash: [0x33; protocol::VAULT_META_ACCOUNT_HASH_LEN],
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
        fs::write(
            vault_root.join("vault.meta"),
            protocol::serialize_vault_meta(&meta),
        )
        .expect("seed vault.meta");
    }

    /// Scratch vault (`<scratch>/vault/` with vault.meta + notes/) plus
    /// an unlocked runtime state keyed to the fixture material.
    async fn vault_fixture(slug: &str) -> (ScopedTempDir, PathBuf, VaultRuntimeState) {
        let scratch = ScopedTempDir::new(slug).unwrap();
        let vault_dir = scratch.path().join("vault");
        fs::create_dir_all(&vault_dir).unwrap();
        crate::paths::notes_dir_under(&vault_dir).unwrap();
        seed_vault_meta(&vault_dir);
        let state = VaultRuntimeState::default();
        state
            .set_unlocked(
                test_vault_id(),
                fixture_unlocked_with_keys(SEED_ROOT, SEED_ITEMS, SEED_ITEMS_ID),
            )
            .await;
        (scratch, vault_dir, state)
    }

    async fn add_note(vault_dir: &Path, state: &VaultRuntimeState, plaintext: &str) -> String {
        note_create_with_dir(
            vault_dir.join("notes"),
            state,
            plaintext.to_string(),
            &crate::vault_io::StdVaultIo,
            &crate::host::NoopHost,
        )
        .await
        .expect("fixture note create must succeed")
    }

    async fn import_att(
        vault_dir: &Path,
        state: &VaultRuntimeState,
        bytes: &[u8],
        filename: &str,
    ) -> String {
        attachment_import_with_dir(
            &crate::vault_io::StdVaultIo,
            &crate::host::test_host::TestHost::new("/nonexistent-export-test-host"),
            vault_dir,
            state,
            ImportSource::Bytes {
                bytes: bytes.to_vec(),
                filename: Some(filename.to_string()),
            },
        )
        .await
        .expect("fixture attachment import must succeed")
        .id
    }

    async fn export(
        vault_dir: &Path,
        state: &VaultRuntimeState,
        dest: &Path,
        scope: Option<&str>,
    ) -> Result<VaultExportSummary, VaultExportError> {
        vault_export_core(
            vault_dir.to_path_buf(),
            vec![vault_dir.to_path_buf()],
            state,
            dest.to_path_buf(),
            scope.map(str::to_string),
            ExportHooks::default(),
        )
        .await
    }

    /// No `*.staging-*` sibling may remain next to `dest` — the
    /// discard-on-every-path contract.
    fn assert_no_staging_residue(dest: &Path) {
        let parent = dest.parent().unwrap();
        let residue: Vec<String> = fs::read_dir(parent)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".staging-"))
            .collect();
        assert!(residue.is_empty(), "staging residue left: {residue:?}");
    }

    /// Relative paths of every file under `root`, sorted.
    fn tree_files(root: &Path) -> Vec<String> {
        fn walk(dir: &Path, prefix: &str, out: &mut Vec<String>) {
            for entry in fs::read_dir(dir).unwrap() {
                let entry = entry.unwrap();
                let name = entry.file_name().to_string_lossy().into_owned();
                let rel = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{prefix}/{name}")
                };
                if entry.file_type().unwrap().is_dir() {
                    walk(&entry.path(), &rel, out);
                } else {
                    out.push(rel);
                }
            }
        }
        let mut out = Vec::new();
        walk(root, "", &mut out);
        out.sort();
        out
    }

    const UPDATED_EPOCH: u64 = 1_781_172_000; // 2026-06-11T10:00:00Z

    // ---- tree-shape golden ------------------------------------------------

    #[test]
    fn whole_vault_tree_shape_golden() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-golden").await;

            let alpha_body = "---\ntitle: Alpha\nfolder: Projects/\nupdated: 2026-06-11T10:00:00Z\n---\n\n# Alpha\n\nbody with trailing spaces   \nno trailing newline";
            add_note(&vault_dir, &state, alpha_body).await;
            add_note(
                &vault_dir,
                &state,
                "---\ntitle: Dup\nfolder: Projects/Sub/\n---\nbody one",
            )
            .await;
            add_note(
                &vault_dir,
                &state,
                "---\ntitle: Dup\nfolder: Projects/Sub/\n---\nbody two",
            )
            .await;
            add_note(&vault_dir, &state, "no frontmatter, root note").await;
            add_note(
                &vault_dir,
                &state,
                "---\ntitle: Tpl\ntemplate: true\n---\ntemplate body",
            )
            .await;
            add_note(
                &vault_dir,
                &state,
                "---\ntitle: Gone\ntrashed: 2026-06-01T00:00:00Z\n---\ntrashed body",
            )
            .await;
            // Snapshots are never enumerated — counted from the listing.
            // Only `.myn` entries count (211-L3): the `.DS_Store`-class
            // stray below must not inflate the exclusion count.
            fs::create_dir_all(vault_dir.join("snapshots")).unwrap();
            fs::write(vault_dir.join("snapshots/a.myn"), b"snap-a").unwrap();
            fs::write(vault_dir.join("snapshots/b.myn"), b"snap-b").unwrap();
            fs::write(vault_dir.join("snapshots/.DS_Store"), b"junk").unwrap();
            // Deliberate empty folders from prefs (one nested, one that
            // already exists through a note's folder — no double count).
            crate::plugins::prefs::commands::set_deliberate_folders_with_dir(
                &vault_dir,
                &state,
                &(std::sync::Arc::new(crate::hooks::NoopHooks) as crate::hooks::Hooks),
                vec!["Empty/Nested/".to_string(), "Projects/".to_string()],
            &crate::vault_io::StdVaultIo, &crate::host::NoopHost,)
            .await
            .expect("deliberate folders write");

            let dest = scratch.path().join("export-tree");
            let summary = export(&vault_dir, &state, &dest, None)
                .await
                .expect("export must publish");

            assert_eq!(summary.notes, 5);
            assert_eq!(summary.attachments, 0);
            assert_eq!(summary.excluded_trashed, 1);
            assert_eq!(summary.excluded_snapshots, 2);
            // Projects, Projects/Sub, Empty, Empty/Nested.
            assert_eq!(summary.folders, 4);

            // Tree shape: dup pair suffixed deterministically; template
            // included like any note; trashed + snapshots absent.
            let files = tree_files(&dest);
            assert_eq!(
                files,
                vec![
                    "Projects/Alpha.md".to_string(),
                    "Projects/Sub/Dup (1).md".to_string(),
                    "Projects/Sub/Dup.md".to_string(),
                    "Tpl.md".to_string(),
                    "Untitled.md".to_string(),
                ]
            );
            assert!(dest.join("Empty/Nested").is_dir());

            // Byte-verbatim body (frontmatter included, no trailing
            // newline normalization).
            assert_eq!(
                fs::read(dest.join("Projects/Alpha.md")).unwrap(),
                alpha_body.as_bytes()
            );
            // Both dup bodies present (creation-order assignment of the
            // suffix is UUIDv7-sort-dependent within one millisecond, so
            // assert the set).
            let dup_bodies: std::collections::BTreeSet<Vec<u8>> = [
                fs::read(dest.join("Projects/Sub/Dup.md")).unwrap(),
                fs::read(dest.join("Projects/Sub/Dup (1).md")).unwrap(),
            ]
            .into_iter()
            .collect();
            let expected: std::collections::BTreeSet<Vec<u8>> = [
                b"---\ntitle: Dup\nfolder: Projects/Sub/\n---\nbody one".to_vec(),
                b"---\ntitle: Dup\nfolder: Projects/Sub/\n---\nbody two".to_vec(),
            ]
            .into_iter()
            .collect();
            assert_eq!(dup_bodies, expected);

            // mtime mapped from `updated:` (SYNC-13).
            let mtime = fs::metadata(dest.join("Projects/Alpha.md"))
                .unwrap()
                .modified()
                .unwrap()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs();
            assert_eq!(mtime, UPDATED_EPOCH);

            assert_no_staging_residue(&dest);
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    // ---- gates ------------------------------------------------------------

    #[test]
    fn locked_vault_is_rejected_with_nothing_written() {
        rt().block_on(async {
            let scratch = ScopedTempDir::new("ve-locked").unwrap();
            let vault_dir = scratch.path().join("vault");
            fs::create_dir_all(&vault_dir).unwrap();
            crate::paths::notes_dir_under(&vault_dir).unwrap();
            seed_vault_meta(&vault_dir);
            let state = VaultRuntimeState::default(); // nothing unlocked
            let dest = scratch.path().join("export-tree");
            assert!(matches!(
                export(&vault_dir, &state, &dest, None).await,
                Err(VaultExportError::VaultNotUnlocked)
            ));
            assert!(!dest.exists());
            assert_no_staging_residue(&dest);
        });
    }

    #[test]
    fn export_rejects_while_auth_permit_is_held() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-permit").await;
            let dest = scratch.path().join("export-tree");
            let held = state.auth_permits().try_acquire().expect("permit");
            assert!(matches!(
                export(&vault_dir, &state, &dest, None).await,
                Err(VaultExportError::AuthOperationInProgress)
            ));
            drop(held);
            export(&vault_dir, &state, &dest, None)
                .await
                .expect("export proceeds once the permit is free");
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    #[test]
    fn missing_vault_meta_is_vault_not_found() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-nometa").await;
            fs::remove_file(vault_dir.join("vault.meta")).unwrap();
            let dest = scratch.path().join("export-tree");
            assert!(matches!(
                export(&vault_dir, &state, &dest, None).await,
                Err(VaultExportError::VaultNotFound)
            ));
            assert!(!dest.exists());
        });
    }

    // ---- destination validation -------------------------------------------

    #[test]
    fn destination_with_missing_parent_is_invalid() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-noparent").await;
            let dest = scratch.path().join("no-such-dir").join("export-tree");
            assert!(matches!(
                export(&vault_dir, &state, &dest, None).await,
                Err(VaultExportError::InvalidDestination)
            ));
        });
    }

    #[test]
    fn existing_destination_is_rejected_never_merged() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-exists").await;
            let dest = scratch.path().join("export-tree");
            fs::create_dir_all(&dest).unwrap();
            fs::write(dest.join("keep.txt"), b"pre-existing").unwrap();
            assert!(matches!(
                export(&vault_dir, &state, &dest, None).await,
                Err(VaultExportError::DestinationAlreadyExists)
            ));
            // The existing directory is untouched.
            assert_eq!(fs::read(dest.join("keep.txt")).unwrap(), b"pre-existing");
            assert_no_staging_residue(&dest);
        });
    }

    /// 115-F1 at the destination parent: a pre-existing USER directory
    /// that happens to carry the `<dest>.staging-<pid>` name fails the
    /// export closed (`create_dir` create-new semantics) instead of
    /// being `remove_dir_all`'d — the user's directory and its contents
    /// survive intact.
    #[test]
    fn preexisting_dir_at_staging_name_fails_closed_and_survives() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-staging-clash").await;
            add_note(&vault_dir, &state, "---\ntitle: Fine\n---\nbody").await;
            let dest = scratch.path().join("export-tree");
            let clash = staging_sibling(&dest).expect("staging name");
            fs::create_dir_all(&clash).unwrap();
            fs::write(clash.join("precious.txt"), b"user data, not residue").unwrap();

            let result = export(&vault_dir, &state, &dest, None).await;
            assert!(
                matches!(result, Err(VaultExportError::Io { .. })),
                "a name clash at the staging sibling must fail closed, got {result:?}"
            );
            assert!(!dest.exists(), "nothing may appear at the destination");
            // The user's directory is byte-intact — never reclaimed.
            assert_eq!(
                fs::read(clash.join("precious.txt")).unwrap(),
                b"user data, not residue"
            );
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    #[test]
    fn destination_inside_forbidden_roots_is_rejected() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-forbidden").await;
            // Inside the vault root itself.
            let inside_vault = vault_dir.join("export-tree");
            assert!(matches!(
                export(&vault_dir, &state, &inside_vault, None).await,
                Err(VaultExportError::DestinationNotAllowed)
            ));
            // Inside a simulated app data dir passed as forbidden root.
            let app_data = scratch.path().join("appdata");
            fs::create_dir_all(app_data.join("somewhere")).unwrap();
            let result = vault_export_core(
                vault_dir.clone(),
                vec![app_data.clone(), vault_dir.clone()],
                &state,
                app_data.join("somewhere").join("export-tree"),
                None,
                ExportHooks::default(),
            )
            .await;
            assert!(matches!(
                result,
                Err(VaultExportError::DestinationNotAllowed)
            ));
        });
    }

    // ---- failure + cancel discard staging ----------------------------------

    #[test]
    fn injected_decrypt_failure_leaves_nothing_at_destination() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-fail").await;
            add_note(&vault_dir, &state, "---\ntitle: Fine\n---\nok body").await;
            // A forged garbage blob under a valid UUIDv7 name fails the
            // AEAD honestly mid-loop.
            let forged = crate::plugins::notes::note_id::NoteId::new_v7();
            fs::write(
                vault_dir
                    .join("notes")
                    .join(format!("{}.myn", forged.as_uuid())),
                b"not a real MY01 blob",
            )
            .unwrap();

            let dest = scratch.path().join("export-tree");
            assert!(matches!(
                export(&vault_dir, &state, &dest, None).await,
                Err(VaultExportError::CannotDecrypt)
            ));
            assert!(!dest.exists(), "failure must leave nothing at destination");
            assert_no_staging_residue(&dest);
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    #[test]
    fn cancelled_export_discards_staging_and_publishes_nothing() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-cancel").await;
            for i in 0..12 {
                add_note(
                    &vault_dir,
                    &state,
                    &format!("---\ntitle: Note {i}\n---\nbody {i}"),
                )
                .await;
            }
            let dest = scratch.path().join("export-tree");
            // Cancel via the first progress tick (a pre-set flag would be
            // wiped by the post-permit reset — the backup discipline).
            let flag = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
            let (tx, mut prx) = tokio::sync::mpsc::unbounded_channel();
            let canceller = flag.clone();
            tokio::spawn(async move {
                if prx.recv().await.is_some() {
                    canceller.store(true, std::sync::atomic::Ordering::Relaxed);
                }
            });
            let hooks = ExportHooks {
                progress: Some(tx),
                cancelled: Some(flag),
            };
            let result = vault_export_core(
                vault_dir.clone(),
                vec![vault_dir.clone()],
                &state,
                dest.clone(),
                None,
                hooks,
            )
            .await;
            assert!(matches!(result, Err(VaultExportError::Cancelled)));
            assert!(!dest.exists(), "cancel must publish nothing");
            assert_no_staging_residue(&dest);
            assert_eq!(state.auth_permits().available_permits(), 1);
        });
    }

    // ---- attachments: dedup-once + embed rewrite ----------------------------

    #[test]
    fn attachments_export_once_with_dedup_and_embed_rewrite() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-att").await;
            // Two DISTINCT blobs sharing one catalog display name → the
            // tree-level suffix dedup; one blob referenced by TWO notes
            // → exported once.
            let id_a = import_att(&vault_dir, &state, ATT_PNG_A, "photo.png").await;
            let id_b = import_att(&vault_dir, &state, ATT_PNG_B, "photo.png").await;

            add_note(
                &vault_dir,
                &state,
                &format!(
                    "---\ntitle: First\n---\nsee ![[att:{id_a}|photo.png]] and ![[att:{id_b}]] end"
                ),
            )
            .await;
            add_note(
                &vault_dir,
                &state,
                &format!("---\ntitle: Second\n---\nagain ![[att:{id_a}]]"),
            )
            .await;
            let verbatim = "---\ntitle: Plain\n---\nno embeds at all";
            add_note(&vault_dir, &state, verbatim).await;

            let dest = scratch.path().join("export-tree");
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let hooks = ExportHooks {
                progress: Some(tx),
                cancelled: None,
            };
            let summary = vault_export_core(
                vault_dir.clone(),
                vec![vault_dir.clone()],
                &state,
                dest.clone(),
                None,
                hooks,
            )
            .await
            .expect("attachment export must publish");

            assert_eq!(summary.notes, 3);
            assert_eq!(
                summary.attachments, 2,
                "one blob, one file — even when referenced twice"
            );

            // Deterministic first-reference naming: id_a (first embed of
            // the first note) keeps the bare name; id_b suffixes.
            assert_eq!(
                fs::read(dest.join("attachments/photo.png")).unwrap(),
                ATT_PNG_A
            );
            assert_eq!(
                fs::read(dest.join("attachments/photo (1).png")).unwrap(),
                ATT_PNG_B
            );

            // Embeds rewritten to the final names; everything else
            // byte-preserved.
            assert_eq!(
                fs::read(dest.join("First.md")).unwrap(),
                b"---\ntitle: First\n---\nsee ![[photo.png]] and ![[photo (1).png]] end"
            );
            assert_eq!(
                fs::read(dest.join("Second.md")).unwrap(),
                b"---\ntitle: Second\n---\nagain ![[photo.png]]"
            );
            // A note without embeds stays byte-verbatim.
            assert_eq!(
                fs::read(dest.join("Plain.md")).unwrap(),
                verbatim.as_bytes()
            );

            // Progress: notes phase then attachments phase, counts-only,
            // ending with the full attachments count.
            let mut events: Vec<(u32, u32, &'static str)> = Vec::new();
            while let Ok(ev) = rx.try_recv() {
                events.push(ev);
            }
            assert!(events.iter().any(|(_, _, p)| *p == "notes"));
            assert_eq!(events.last().copied(), Some((2, 2, "attachments")));
        });
    }

    /// 115-F1 variant 2 inside the staging tree: an attachment whose
    /// FINAL name is `x.png.tmp`, written before its `x.png` sibling,
    /// used to be destroyed by the later write's fixed-name temp —
    /// leaving the published tree with a dangling embed. Both files
    /// must land intact.
    #[test]
    fn attachment_with_tmp_shaped_final_name_survives_its_sibling() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-att-tmpname").await;
            // First reference order writes "x.png.tmp" FIRST.
            let id_tmpish = import_att(&vault_dir, &state, ATT_PNG_A, "x.png.tmp").await;
            let id_plain = import_att(&vault_dir, &state, ATT_PNG_B, "x.png").await;
            add_note(
                &vault_dir,
                &state,
                &format!("---\ntitle: N\n---\na ![[att:{id_tmpish}]] b ![[att:{id_plain}]] c"),
            )
            .await;

            let dest = scratch.path().join("export-tree");
            let summary = export(&vault_dir, &state, &dest, None)
                .await
                .expect("export must publish");
            assert_eq!(summary.attachments, 2);

            assert_eq!(
                fs::read(dest.join("attachments/x.png.tmp")).unwrap(),
                ATT_PNG_A
            );
            assert_eq!(fs::read(dest.join("attachments/x.png")).unwrap(), ATT_PNG_B);
            assert_eq!(
                fs::read(dest.join("N.md")).unwrap(),
                b"---\ntitle: N\n---\na ![[x.png.tmp]] b ![[x.png]] c"
            );
        });
    }

    #[test]
    fn missing_referenced_attachment_fails_the_whole_export() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-att-missing").await;
            let ghost = "ab".repeat(32); // valid shape, never imported
            add_note(
                &vault_dir,
                &state,
                &format!("---\ntitle: Ghost\n---\n![[att:{ghost}]]"),
            )
            .await;
            let dest = scratch.path().join("export-tree");
            assert!(matches!(
                export(&vault_dir, &state, &dest, None).await,
                Err(VaultExportError::AttachmentMissing)
            ));
            assert!(
                !dest.exists(),
                "skip-nothing-silently: missing attachment fails closed"
            );
            assert_no_staging_residue(&dest);
        });
    }

    // ---- subtree scope -------------------------------------------------------

    #[test]
    fn subtree_scope_exports_exactly_the_subtree_and_its_attachments() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-scope").await;
            let id_in = import_att(&vault_dir, &state, ATT_PNG_A, "in.png").await;
            let id_out = import_att(&vault_dir, &state, ATT_PNG_B, "out.png").await;

            // In scope "A/": the scope root itself + a nested child.
            add_note(
                &vault_dir,
                &state,
                &format!("---\ntitle: AtRoot\nfolder: A/\n---\nref ![[att:{id_in}]] plus an out-of-scope wikilink [[C/Other]] kept verbatim"),
            )
            .await;
            add_note(
                &vault_dir,
                &state,
                "---\ntitle: Nested\nfolder: A/B/\n---\nnested body",
            )
            .await;
            // Out of scope: sibling folder, lookalike prefix, root note.
            add_note(
                &vault_dir,
                &state,
                &format!("---\ntitle: Other\nfolder: C/\n---\n![[att:{id_out}]]"),
            )
            .await;
            add_note(
                &vault_dir,
                &state,
                "---\ntitle: Lookalike\nfolder: AB/\n---\nnot under A/",
            )
            .await;
            add_note(&vault_dir, &state, "---\ntitle: Root\n---\nroot body").await;
            // Deliberate folders: one under scope, one outside.
            crate::plugins::prefs::commands::set_deliberate_folders_with_dir(
                &vault_dir,
                &state,
                &(std::sync::Arc::new(crate::hooks::NoopHooks) as crate::hooks::Hooks),
                vec!["A/Empty/".to_string(), "C/Empty/".to_string()],
            &crate::vault_io::StdVaultIo, &crate::host::NoopHost,)
            .await
            .expect("deliberate folders write");

            let dest = scratch.path().join("subtree-tree");
            let summary = export(&vault_dir, &state, &dest, Some("A/"))
                .await
                .expect("subtree export must publish");

            assert_eq!(summary.notes, 2);
            assert_eq!(summary.attachments, 1, "only attachments referenced by included notes");
            // B (note folder) + Empty (deliberate) — relativized.
            assert_eq!(summary.folders, 2);

            let files = tree_files(&dest);
            assert_eq!(
                files,
                vec![
                    "AtRoot.md".to_string(),
                    "B/Nested.md".to_string(),
                    "attachments/in.png".to_string(),
                ]
            );
            assert!(dest.join("Empty").is_dir());
            // Out-of-scope wikilink untouched; in-scope embed rewritten.
            assert_eq!(
                fs::read(dest.join("AtRoot.md")).unwrap(),
                b"---\ntitle: AtRoot\nfolder: A/\n---\nref ![[in.png]] plus an out-of-scope wikilink [[C/Other]] kept verbatim"
            );
        });
    }

    // ---- round-trip approximation (importer-inversion invariants) ------------

    #[test]
    fn round_trip_invariants_hold_over_the_exported_tree() {
        rt().block_on(async {
            let (scratch, vault_dir, state) = vault_fixture("ve-roundtrip").await;
            let id = import_att(&vault_dir, &state, ATT_PNG_A, "photo.png").await;

            let originals: Vec<&str> = vec![
                "---\ntitle: Root Note\nupdated: 2026-06-11T10:00:00Z\n---\nroot body",
                "---\ntitle: Inner\nfolder: A/B/\n---\ninner body, no trailing newline",
                "---\ntitle: report.md\nfolder: A/\n---\ndotted title round-trips via strip-one-.md",
            ];
            for p in &originals {
                add_note(&vault_dir, &state, p).await;
            }
            let embedded =
                format!("---\ntitle: Embedded\nfolder: A/\n---\nsee ![[att:{id}|photo.png]] end");
            add_note(&vault_dir, &state, &embedded).await;

            let dest = scratch.path().join("export-tree");
            export(&vault_dir, &state, &dest, None)
                .await
                .expect("export must publish");

            let mut seen = 0;
            for rel in tree_files(&dest) {
                if rel.starts_with("attachments/") {
                    continue;
                }
                seen += 1;
                let bytes = fs::read(dest.join(&rel)).unwrap();

                // (1) Tree location == FM `folder:` — the equality the
                // importer's SYNC-8 preexistingFolder guard suppresses on
                // (quiet re-import).
                let slices = extract_title_slices(&bytes);
                let fm_dir = slices.frontmatter_bytes.and_then(fm_folder);
                let tree_dir = rel.rfind('/').map(|cut| format!("{}/", &rel[..cut]));
                assert_eq!(fm_dir, tree_dir, "folder/location mismatch for {rel}");

                // (2) Filename strips exactly one `.md` back to the FM
                // title (the importer's deriveImportTitle inversion).
                let filename = rel.rsplit('/').next().unwrap();
                let derived_title = filename.strip_suffix(".md").unwrap();
                let fm_t = slices
                    .frontmatter_bytes
                    .and_then(fm_title)
                    .unwrap_or_else(|| "Untitled".to_string());
                assert_eq!(derived_title, fm_t, "title inversion failed for {rel}");

                // (3) Bodies byte-faithful modulo the documented embed
                // rewrite.
                let text = String::from_utf8(bytes.clone()).unwrap();
                if text.contains("Embedded") {
                    assert_eq!(
                        text,
                        "---\ntitle: Embedded\nfolder: A/\n---\nsee ![[photo.png]] end"
                    );
                } else {
                    assert!(
                        originals.iter().any(|o| o.as_bytes() == bytes.as_slice()),
                        "non-embed note must be byte-verbatim: {rel}"
                    );
                }
            }
            assert_eq!(seen, 4);
        });
    }

    // ---- helpers ---------------------------------------------------------

    #[test]
    fn scope_normalization_and_prefix_matching() {
        assert_eq!(normalize_scope(None), None);
        assert_eq!(normalize_scope(Some("")), None);
        assert_eq!(normalize_scope(Some("/")), None);
        assert_eq!(
            normalize_scope(Some("A/B/")),
            Some(vec!["A".to_string(), "B".to_string()])
        );
        // Trailing-slashless input normalizes identically.
        assert_eq!(normalize_scope(Some("A/B")), normalize_scope(Some("A/B/")));

        let prefix = vec!["A".to_string()];
        let inside = vec!["A", "B"];
        assert_eq!(strip_scope_prefix(&inside, &prefix), Some(&["B"][..]));
        let exact = vec!["A"];
        assert_eq!(strip_scope_prefix(&exact, &prefix), Some(&[][..]));
        let lookalike = vec!["AB"];
        assert_eq!(strip_scope_prefix(&lookalike, &prefix), None);
        let root: Vec<&str> = vec![];
        assert_eq!(strip_scope_prefix(&root, &prefix), None);
    }

    // (Tree-segment sanitization is `export_naming::sanitize_export_component`
    // with the `"_"` fallback — traversal-proofing pinned in that module's
    // tests.)

    #[test]
    fn pick_deduped_suffixes_deterministically() {
        let mut names: HashSet<String> = HashSet::new();
        assert_eq!(pick_deduped(&names, "Dup.md").unwrap(), "Dup.md");
        names.insert(dedup_key("Dup.md"));
        assert_eq!(pick_deduped(&names, "Dup.md").unwrap(), "Dup (1).md");
        names.insert(dedup_key("Dup (1).md"));
        assert_eq!(pick_deduped(&names, "Dup.md").unwrap(), "Dup (2).md");
    }

    // ── myne#311: the volume is case-insensitive; the oracle was not ───────
    //
    // The export writes with create-new semantics onto whatever volume the user
    // chose, and on macOS and Windows that volume folds case by default. A
    // byte-exact dedup let `README.md` and `readme.md` both read as unused, and
    // the second write returned `AlreadyExists` — which propagates, discards
    // the staging tree, and aborts the WHOLE export with a generic
    // write-failure line naming no file. Fully deterministic, so retrying never
    // helped and that vault could never be exported to such a volume again.
    //
    // These assert the CHOSEN NAMES, not merely that a call succeeded: on the
    // Linux CI runner a filesystem-level test of this would pass trivially,
    // because ext4 does not fold case.
    #[test]
    fn the_dedup_oracle_folds_case_so_a_case_differing_pair_is_suffixed() {
        let mut names: HashSet<String> = HashSet::new();
        assert_eq!(pick_deduped(&names, "README.md").unwrap(), "README.md");
        names.insert(dedup_key("README.md"));

        // The pair that used to abort the export.
        assert_eq!(pick_deduped(&names, "readme.md").unwrap(), "readme (1).md");
        assert_eq!(pick_deduped(&names, "ReadMe.md").unwrap(), "ReadMe (1).md");
        // …and the suffixed form is checked case-insensitively too, so a third
        // spelling does not collide with the second.
        names.insert(dedup_key("readme (1).md"));
        assert_eq!(pick_deduped(&names, "ReadMe.md").unwrap(), "ReadMe (2).md");
    }

    #[test]
    fn the_emitted_name_keeps_its_original_case() {
        // Folding the ORACLE only: nothing about a successful export changes,
        // so a file exported today keeps the name it has today.
        let names: HashSet<String> = HashSet::new();
        assert_eq!(pick_deduped(&names, "MyNotes.md").unwrap(), "MyNotes.md");
        assert_eq!(pick_deduped(&names, "Photo.PNG").unwrap(), "Photo.PNG");
    }

    #[test]
    fn a_folded_directory_key_is_one_namespace() {
        // `Work/` and `work/` are the same directory on the volume, so they
        // must share one assigned set — otherwise two same-named notes in
        // case-differing folders both write into it and the second aborts.
        assert_eq!(dedup_key("Work/Notes"), dedup_key("work/notes"));
        assert_ne!(dedup_key("Work/Notes"), dedup_key("Work/Other"));
    }
}
