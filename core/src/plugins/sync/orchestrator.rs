//! Sync orchestration — the production glue (MYND-424 R3) that drives the
//! [`super::engine`] primitives over a real transport against the **real local
//! vault**. The engine functions move bytes but have no production caller; this
//! module is that caller.
//!
//! [`run_sync_cycle`] ties one full cycle together:
//!   1. build the local `id → content_nonce` manifest from `<vault>/notes/`;
//!   2. `pull_to_stable` (client-side head MAC-verify + rollback rejection);
//!   3. for each changed remote blob, `download_blob` then write it to disk as
//!      `notes/<uuid>.myn` (the decisive "pulled note lands on disk" step);
//!   4. detect locally-changed notes (content_nonce ≠ last-synced), seal each as
//!      a [`PushBlob`] (the note's existing `.myn` bytes ARE the opaque
//!      ciphertext — no re-encryption), author a linear-advance vault head, and
//!      `push`;
//!   5. persist the advanced cursor + per-blob CAS state + the head baseline.
//!
//! Transport is blocking (`&dyn SyncTransport`); call this from
//! `spawn_blocking`. `vault_root` is where the device-local sync files live
//! (`sync-state.json`, `vault.head-state`); `notes_dir` is `<vault_root>/notes`.

use super::conflict::{
    merge_attachments_catalog, merge_custom_themes, merge_vault_meta, meta_password_side_winner,
    plan_note_keep_both, ConflictCopyPlan, MetaWinner,
};
use super::engine::{self, ChangedBlob, PullError, PushBlob, PushError};
use super::state::{
    clear_vault_meta_dirty, read_head_baseline, read_sync_state, vault_meta_is_dirty,
    write_head_baseline, write_sync_state, BlobSyncState, SyncState,
};
use super::transport::{HttpMethod, SyncTransport};
use crate::attachment_nonce::{scan_attachments_manifest, AttachmentManifestEntry};
use protocol::{
    compute_manifest_hash, derive_subkey, encode_attachments_catalog, parse_vault_meta,
    serialize_vault_meta, AttachmentsCatalog, ManifestEntry, SubkeyRole, VaultHead, VvEntry,
    VAULT_HEAD_FORMAT_V1,
};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

/// What one sync cycle did (surfaced to the status indicator + tests).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SyncSummary {
    /// Remote blobs downloaded + written to the local vault this cycle.
    pub pulled: usize,
    /// Local blobs pushed to the server this cycle.
    pub pushed: usize,
    /// True if a new vault head was authored + accepted.
    pub head_advanced: bool,
    /// The advanced pull cursor.
    pub cursor: u64,
    /// Notes the server advanced concurrently with an unpushed local edit (a true
    /// keep-both conflict). They are EXCLUDED from this push — pushing a stale
    /// `base_version` loses the CAS and would wedge the whole batch — and surfaced
    /// here so the notes layer can materialize the remote revision as a conflict
    /// copy (the original local edit is never overwritten or lost).
    pub conflicts: Vec<ConflictCopyPlan>,
    /// Deletions pushed this cycle WITH the tombstone flag set (the server marks
    /// them for horizon-GC). Driven by the notes-layer `sync_mark_tombstone` queue.
    pub tombstones_pushed: usize,
    /// True if this cycle performed a full reconcile (a `410 CursorExpired`
    /// beyond-horizon recovery reset the cursor to 0 and re-pulled). The
    /// caller emits the reconcile banner events off this (SYNC-36).
    pub reconcile_ran: bool,
    /// Attachment bodies downloaded + written to `attachments/` this cycle
    /// (MYND-468).
    pub attachments_pulled: usize,
    /// Attachment bodies uploaded over `/attachments/{id}` + registered on the
    /// blob plane this cycle.
    pub attachments_pushed: usize,
    /// Local attachment bodies erased this cycle because the merged catalog
    /// carries their tombstone (remote-deletion propagation).
    pub attachments_deleted: usize,
    /// The meta phase refused to adopt because the two `vault.meta` copies
    /// disagree on the password-side wrap and no baseline says which side moved
    /// (phase3-web-client task 88, [`MetaPhaseOutcome::CredentialAmbiguous`]).
    ///
    /// Surfaced rather than swallowed, because refusing is a **permanent stall**
    /// until someone acts: every later cycle re-refuses, and a user who is told
    /// nothing has no way to act. Silence here would trade a silent revert for a
    /// silent freeze, which is not an improvement.
    pub credential_ambiguous: bool,
    /// A remote `vault.prefs` change was merged into the on-disk view this
    /// cycle (MYND-478). The caller refreshes the RAM label/icon caches and
    /// emits the prefs-changed event off this (the orchestrator stays
    /// AppHandle-free).
    pub prefs_applied_remote: bool,
    /// A remote `vault.themes` change was merged onto the on-disk store this
    /// cycle (MYND-486) — a theme added, edited or deleted on a peer. Reported
    /// for the same reason as `prefs_applied_remote` (the orchestrator stays
    /// AppHandle-free, so any refresh choreography lives at the command
    /// boundary). NOTE: no listener is wired yet — a same-name concurrent edit
    /// resolves silently by LWW (a theme is not a note: no keep-both, no
    /// conflict surface), and the WebView re-reads themes over IPC on demand.
    /// The live-refresh event is a follow-on that needs a frontend listener.
    pub themes_applied_remote: bool,
    /// Changed-note downloads skipped WITHOUT any local mutation this cycle:
    /// the body was 404/410 (reclaimed, §11.3) or its bytes failed the header
    /// nonce-vs-record check (empty / junk / mismatch). Never written to disk,
    /// never adopted as a baseline — the honest counter for bounded staleness
    /// against a broken or hostile server.
    pub pull_skipped: usize,
    /// Previously-synced notes quarantined by the reconcile drop-leg this cycle
    /// (absent from the authoritative roster ⇒ deleted + reclaimed remotely).
    /// Moved to `<vault>/quarantine/` — never destroyed, never re-uploaded.
    pub dropped: usize,
}

/// Sync-cycle failures.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SyncCycleError {
    /// The pull leg failed (incl. `RollbackRejected` — malicious-server defence).
    Pull(PullError),
    /// The push leg failed (incl. `BlobStale` / `HeadStale` — retry next cycle).
    Push(PushError),
    /// A local filesystem error (read/write a `.myn`, read/write sync state).
    Io,
    /// The local store ran out of room while materialising a pulled note
    /// (phase3-web-client task 91).
    ///
    /// Split out of [`SyncCycleError::Io`] because the two want opposite
    /// schedules. A generic IO failure is usually transient and the ordinary
    /// backoff is right; a full store is not, and retrying at that cadence is a
    /// LOOP — the cycle re-downloads the same records and hits the same wall,
    /// forever, while the user sees nothing but a spinning dot.
    ///
    /// **The cursor deliberately does not advance on this path.** Nothing is
    /// lost: the records that did land are skipped next time by the disk-nonce
    /// check, and the ones that did not are re-pulled once there is room. What
    /// changes is that the client parks and SAYS the store is full instead of
    /// hammering silently.
    StorageFull,
    /// Head authoring (manifest hash / seal) failed.
    Head,
}

use super::to_hex as hex;

/// Parse a 32-hex blob-id key from `state.blobs` back to its 16 bytes. `None`
/// for anything malformed (defensive — the state file is device-local JSON).
fn from_hex16(s: &str) -> Option<[u8; 16]> {
    if s.len() != 32 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 16];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// The `<vault>/notes/<uuid>.myn` path for a 16-byte blob id.
fn blob_path(notes_dir: &Path, id: &[u8; 16]) -> std::path::PathBuf {
    let uuid = uuid::Uuid::from_bytes(*id);
    notes_dir.join(format!("{uuid}.myn"))
}

/// Download a blob, transparently backing off + retrying on the server's
/// per-account rate limit (429). A fresh device pulling a large vault otherwise
/// hits the burst cap mid-cycle and fails the whole pull; the backoff lets the
/// token bucket refill so the initial sync completes in one pass instead of
/// erroring out and relying on many full retry cycles. The cap bounds the total
/// wait so a genuinely throttled account still fails (rather than hangs).
fn download_blob_backoff(
    transport: &dyn SyncTransport,
    token: &str,
    id: &[u8; 16],
) -> Result<Vec<u8>, PullError> {
    let mut delay_ms = 250u64;
    for _ in 0..6 {
        match engine::download_blob(transport, token, id) {
            Err(PullError::RateLimited) => {
                crate::task::block_sleep(std::time::Duration::from_millis(delay_ms));
                delay_ms = (delay_ms * 2).min(2000);
            }
            other => return other,
        }
    }
    engine::download_blob(transport, token, id)
}

/// Outcome of one pulled-note write attempt under the notes-write mutex.
enum PulledNoteApply {
    /// The blob was written; adopt the manifest + baseline bookkeeping.
    Applied,
    /// The on-disk note diverged from the synced baseline while this cycle was
    /// in flight (a `note_update` raced the pull) — an unpushed local edit now;
    /// nothing was written.
    SkippedDirty,
    /// The store is full (phase3-web-client task 91). Distinct from an `Err` so
    /// the caller can END the materialisation cleanly rather than unwinding —
    /// what has already landed is fine and must keep its bookkeeping.
    StorageFull,
}

/// Write one pulled note blob to disk under `notes::commands::notes_write_mutex`,
/// re-running the dirty-skip test against the CURRENT on-disk header nonce
/// INSIDE the lock. The pre-download check upstream reads the cycle-start
/// manifest, which goes stale the moment a local save lands mid-cycle; this
/// in-lock re-check is what makes the editor's {read → base-guard → write}
/// (`note_update_with_dir`) and the pull's {check → write} linearizable — the
/// §11.3 expected-base guard's whole premise. The download already happened
/// OUTSIDE the lock (review invariant: never network I/O under this mutex).
///
/// Divergence semantics mirror the pre-download filter: a synced baseline
/// exists and the disk no longer matches it (including "file vanished" — a
/// mid-cycle local delete must not be resurrected) → skip without mutation.
/// No baseline (fresh pull of a never-held note) → write unconditionally.
async fn apply_pulled_note_blob(
    io: &dyn crate::vault_io::VaultIo,
    notes_dir: &Path,
    id: &[u8; 16],
    bytes: &[u8],
    baseline_nonce_hex: Option<&str>,
) -> Result<PulledNoteApply, SyncCycleError> {
    // `.lock().await`, not `blocking_lock()` (phase3-web-client task 86): the
    // cycle is async now, and `blocking_lock` PANICS inside a runtime. It was
    // correct while the whole cycle ran on `spawn_blocking`; here it is a crash,
    // and one the type system cannot see.
    let _guard = crate::plugins::notes::commands::notes_write_mutex()
        .lock()
        .await;
    if let Some(base) = baseline_nonce_hex {
        let disk_nonce_hex = io
            .read(&blob_path(notes_dir, id))
            .await
            .ok()
            .as_deref()
            .and_then(crate::note_nonce::read_myn_content_nonce)
            .map(|n| hex(&n));
        if disk_nonce_hex.as_deref() != Some(base) {
            return Ok(PulledNoteApply::SkippedDirty);
        }
    }
    io.create_dir_all(notes_dir)
        .await
        .map_err(|_| SyncCycleError::Io)?;
    match io
        .write(
            &blob_path(notes_dir, id),
            bytes,
            crate::vault_io::WriteOpts::default(),
        )
        .await
    {
        Ok(()) => Ok(PulledNoteApply::Applied),
        // The one IO failure with a different remedy and a different schedule.
        // Reported rather than raised so the caller can stop materialising and
        // keep what landed, instead of unwinding a cycle that was mostly fine.
        Err(crate::io_failure_kind::IoFailureKind::NoSpace) => Ok(PulledNoteApply::StorageFull),
        Err(_) => Err(SyncCycleError::Io),
    }
}

/// The device-local conflict-staging dir: a downloaded *remote* revision of a note
/// that lost a concurrent-edit race, held until the notes layer materializes it as
/// a keep-both copy (`conflict_of:`). The local edit is never touched.
fn conflict_staging_dir(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join("conflicts")
}

/// The device-local quarantine dir (§11.3 drop disposition): a previously-synced
/// note the reconcile drop-leg removed from `notes/` because the authoritative
/// roster no longer carries it (deleted + horizon-GC-reclaimed remotely). The
/// ciphertext is MOVED here — never destroyed, never re-uploaded (re-uploading
/// would resurrect deleted content server-side AND lose the push batch's CAS).
/// Deliberately NOT wiped by `clear_device_local_sync` — it holds user data.
pub(crate) fn quarantine_dir(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join("quarantine")
}

/// Move a note's on-disk blob into the quarantine dir. A missing source is a
/// no-op `Ok` (the id may be baseline-only); an occupied target gets a `-<n>`
/// suffix so repeated drops of re-created ids never overwrite older evidence.
async fn quarantine_note(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
    notes_dir: &Path,
    id: &[u8; 16],
) -> Result<(), SyncCycleError> {
    let src = blob_path(notes_dir, id);
    if !src.exists() {
        return Ok(());
    }
    let dir = quarantine_dir(vault_root);
    io.create_dir_all(&dir)
        .await
        .map_err(|_| SyncCycleError::Io)?;
    let uuid = uuid::Uuid::from_bytes(*id);
    let mut target = dir.join(format!("{uuid}.myn"));
    let mut n = 1u32;
    while io.exists(&target).await.unwrap_or(false) {
        target = dir.join(format!("{uuid}-{n}.myn"));
        n += 1;
    }
    // WRITE-then-REMOVE, not `rename` (phase3-web-client task 86). Rename is the
    // one filesystem operation this product cannot rely on: the Phase 0 spike
    // measured Safari implementing no `FileSystemFileHandle.move()` at all, at
    // 400 and at 3 000 files. Task 20 settled the replacement shape for
    // write-once directory entries and this is one.
    //
    // The crash window inverts, and the new direction is the safe one: a crash
    // between the write and the remove leaves the note in BOTH places, where a
    // failed rename could leave it in neither. §11.3's whole rule is that a
    // dropped note is "moved aside, never destroyed" — duplicate evidence costs
    // a stale file the next reconcile re-quarantines under the `-n` suffix;
    // losing it costs the note.
    let bytes = io.read(&src).await.map_err(|_| SyncCycleError::Io)?;
    io.write(&target, &bytes, crate::vault_io::WriteOpts::default())
        .await
        .map_err(|_| SyncCycleError::Io)?;
    io.remove_file(&src).await.map_err(|_| SyncCycleError::Io)
}

/// Persist a conflicting remote revision: `conflicts/<id>.myn` (the ciphertext the
/// notes layer decrypts to build the copy) + `conflicts/<id>.meta` (`<version>\n
/// <nonce-hex>`, the baseline [`resolve_conflict`] adopts).
async fn stage_conflict(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
    id: &[u8; 16],
    version: u64,
    content_nonce: &[u8; 24],
    ciphertext: &[u8],
) -> Result<(), SyncCycleError> {
    let dir = conflict_staging_dir(vault_root);
    io.create_dir_all(&dir)
        .await
        .map_err(|_| SyncCycleError::Io)?;
    let id_hex = hex(id);
    io.write(
        &dir.join(format!("{id_hex}.myn")),
        ciphertext,
        crate::vault_io::WriteOpts::default(),
    )
    .await
    .map_err(|_| SyncCycleError::Io)?;
    let meta = format!("{version}\n{}", hex(content_nonce));
    io.write(
        &dir.join(format!("{id_hex}.meta")),
        meta.as_bytes(),
        crate::vault_io::WriteOpts::default(),
    )
    .await
    .map_err(|_| SyncCycleError::Io)?;
    Ok(())
}

/// The note ids (16-byte, hex) with a staged conflicting remote revision awaiting
/// keep-both materialization by the notes layer.
pub async fn list_pending_conflicts(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = io.read_dir(&conflict_staging_dir(vault_root)).await {
        // The seam yields NAMES, not paths — OPFS has no path API at all, so a
        // path would have to be reassembled from a parent the caller already
        // holds. The `.myn` filter and stem extraction are the same two checks
        // the `Path` form did.
        for e in entries {
            if let Some(stem) = e.name.strip_suffix(".myn") {
                out.push(stem.to_string());
            }
        }
    }
    out.sort();
    out
}

/// Read a staged conflicting remote revision's ciphertext (the notes layer
/// decrypts it to build the keep-both copy). `None` if nothing is staged.
pub async fn read_staged_conflict_blob(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
    id_hex: &str,
) -> Option<Vec<u8>> {
    io.read(&conflict_staging_dir(vault_root).join(format!("{id_hex}.myn")))
        .await
        .ok()
}

/// Finish a keep-both resolution: adopt the staged remote revision's (version,
/// nonce) as the synced baseline for the note — so the untouched local edit now
/// pushes as a clean linear advance over it — then clear the staging. Idempotent;
/// a missing staging is a no-op.
pub async fn resolve_conflict(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
    id_hex: &str,
) -> Result<(), SyncCycleError> {
    let dir = conflict_staging_dir(vault_root);
    let meta_path = dir.join(format!("{id_hex}.meta"));
    if let Some(meta) = io
        .read(&meta_path)
        .await
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
    {
        let mut lines = meta.lines();
        let version: u64 = lines
            .next()
            .and_then(|s| s.parse().ok())
            .ok_or(SyncCycleError::Io)?;
        let nonce_hex = lines.next().unwrap_or("").to_string();
        let mut state = read_sync_state(io, vault_root)
            .await
            .map_err(|_| SyncCycleError::Io)?;
        state.blobs.insert(
            id_hex.to_string(),
            BlobSyncState {
                version,
                content_nonce_hex: nonce_hex,
            },
        );
        write_sync_state(io, vault_root, &state)
            .await
            .map_err(|_| SyncCycleError::Io)?;
    }
    let _ = io.remove_file(&dir.join(format!("{id_hex}.myn"))).await;
    let _ = io.remove_file(&meta_path).await;
    Ok(())
}

/// The device-local "these versions are deletions" queue: note ids (32-hex) the
/// notes layer tombstoned (`sync_mark_tombstone`), so the next push sets the
/// server's tombstone flag (horizon-GC). The engine can't read the encrypted
/// `deleted:` field itself, so the dialect-aware notes layer is the source of
/// truth — that also keeps a live note from ever being flagged (no false-positive
/// → no GC of live data). `<vault>/pending-tombstones`, newline-separated.
fn pending_tombstones_path(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join("pending-tombstones")
}

/// Read the pending-tombstone id set (absent → empty).
async fn read_pending_tombstones(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
) -> std::collections::HashSet<String> {
    io.read(&pending_tombstones_path(vault_root))
        .await
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
        .map(|s| {
            s.lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Queue a note id (32-hex) as a tombstone for the next push. Idempotent.
pub async fn add_pending_tombstone(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
    id_hex: &str,
) -> Result<(), SyncCycleError> {
    let mut set = read_pending_tombstones(io, vault_root).await;
    set.insert(id_hex.to_string());
    write_pending_tombstones(io, vault_root, &set).await
}

/// Drop ids from the pending-tombstone queue (after they were pushed-with-flag).
async fn clear_pending_tombstones(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
    drop: &[String],
) -> Result<(), SyncCycleError> {
    if drop.is_empty() {
        return Ok(());
    }
    let mut set = read_pending_tombstones(io, vault_root).await;
    for d in drop {
        set.remove(d);
    }
    write_pending_tombstones(io, vault_root, &set).await
}

async fn write_pending_tombstones(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
    set: &std::collections::HashSet<String>,
) -> Result<(), SyncCycleError> {
    let mut ids: Vec<&String> = set.iter().collect();
    ids.sort();
    let body = ids
        .iter()
        .map(|s| s.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    io.write(
        &pending_tombstones_path(vault_root),
        body.as_bytes(),
        crate::vault_io::WriteOpts::default(),
    )
    .await
    .map_err(|_| SyncCycleError::Io)
}

// ---------------------------------------------------------------------------
// Attachment + catalog sync (MYND-468; `sync-protocol.md` §8.1/§11.4)
// ---------------------------------------------------------------------------

/// The unlocked key material the attachment phases need: `items_key` +
/// `items_key_id` verify a downloaded `MYA1` blob end-to-end before it is
/// written to disk (§3.2: range slices carry no integrity — the whole-blob tag
/// is the check). `None` skips the attachment + catalog phases entirely
/// (legacy note-only cycles; production always passes `Some`).
#[derive(Clone, Copy)]
pub struct AttachmentKeys<'a> {
    /// The vault's singleton `itemsKey` (wraps every per-attachment key).
    pub items_key: &'a [u8; 32],
    /// The `items_key_id` from `vault.meta` (AAD-bound into every `MYA1`).
    pub items_key_id: &'a [u8; 16],
}

/// `<vault>/attachments` — the MYA1 blob dir (`protocol.md` §9.1).
fn attachments_dir(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join("attachments")
}

/// `<vault>/vault.attachments` — the MYC1 catalog singleton.
fn catalog_file_path(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join("vault.attachments")
}

/// A vault singleton's reserved 16-byte sync-plane blob-id:
/// `DeriveSubkey(root_key, <role>)[0..16]` (`protocol.md` §3.4). `role` MUST be
/// an **identifier** derivation (`catalog-sync-id` / `prefs-sync-id` /
/// `themes-sync-id`), never a KEK role — the blob-id is server-visible, so
/// truncating a key-derivation into it would leak key material to the sync
/// plane.
fn sync_id_for(root_key: &[u8; 32], role: SubkeyRole) -> [u8; 16] {
    let sub = derive_subkey(root_key, role);
    let mut id = [0u8; 16];
    id.copy_from_slice(&sub[..16]);
    id
}

/// The catalog's reserved 16-byte sync-plane blob-id:
/// `DeriveSubkey(root_key, "catalog-sync-id")[0..16]` (`protocol.md` §3.4).
pub fn catalog_sync_id(root_key: &[u8; 32]) -> [u8; 16] {
    sync_id_for(root_key, SubkeyRole::CatalogSyncId)
}

/// Read a vault singleton blob's outer 24-byte nonce (offset 6..30)
/// decryption-free — the sync-plane change discriminator shared by the MYC1
/// catalog and MYP1 prefs envelopes. `None` unless `bytes` opens with the
/// expected 4-byte magic.
fn read_singleton_nonce(bytes: &[u8], magic: &[u8; 4]) -> Option<[u8; 24]> {
    if bytes.len() < 30 || &bytes[0..4] != magic {
        return None;
    }
    let mut nonce = [0u8; 24];
    nonce.copy_from_slice(&bytes[6..30]);
    Some(nonce)
}

/// The catalog's sync discriminator (`read_singleton_nonce` over MYC1).
fn read_catalog_nonce(bytes: &[u8]) -> Option<[u8; 24]> {
    read_singleton_nonce(bytes, b"MYC1")
}

/// `vault.prefs`' reserved 16-byte sync-plane blob-id:
/// `DeriveSubkey(root_key, "prefs-sync-id")[0..16]` (`protocol.md` §3.4,
/// MYND-478) — the `catalog_sync_id` twin.
pub fn prefs_sync_id(root_key: &[u8; 32]) -> [u8; 16] {
    sync_id_for(root_key, SubkeyRole::PrefsSyncId)
}

/// The prefs blob's sync discriminator (`read_singleton_nonce` over MYP1).
fn read_prefs_nonce(bytes: &[u8]) -> Option<[u8; 24]> {
    read_singleton_nonce(bytes, b"MYP1")
}

/// `vault.themes`' reserved 16-byte sync-plane blob-id:
/// `DeriveSubkey(root_key, "themes-sync-id")[0..16]` (`protocol.md` §3.4,
/// MYND-486) — the `catalog_sync_id` / `prefs_sync_id` twin.
pub fn themes_sync_id(root_key: &[u8; 32]) -> [u8; 16] {
    sync_id_for(root_key, SubkeyRole::ThemesSyncId)
}

/// The themes blob's sync discriminator (`read_singleton_nonce` over MYT1).
fn read_themes_nonce(bytes: &[u8]) -> Option<[u8; 24]> {
    read_singleton_nonce(bytes, b"MYT1")
}

/// `<vault>/vault.themes` — the MYT1 custom-themes singleton.
fn themes_file_path(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join("vault.themes")
}

/// The pending **attachment**-tombstone queue (`sync-protocol.md` §11.4): one
/// line per deletion, `"<sync-id-hex> <full-id-hex> <fresh-nonce-hex>"`. The
/// fresh random nonce becomes the tombstone record's `content_nonce` (a
/// visible change on the blob plane); the full id lets the server mark the
/// stored body deleted. Written by the attachments plugin at delete time,
/// drained by the next push cycle.
fn pending_attachment_tombstones_path(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join("pending-attachment-tombstones")
}

/// One queued attachment tombstone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingAttachmentTombstone {
    /// The 16-byte attachment sync-id (blob-plane key).
    pub sync_id: [u8; 16],
    /// The full 32-byte attachment-id.
    pub id: [u8; 32],
    /// The fresh tombstone `content_nonce`.
    pub content_nonce: [u8; 24],
}

fn hex_to_arr<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// Read the pending attachment-tombstone queue (absent → empty; a malformed
/// line is skipped rather than wedging the cycle).
pub async fn read_pending_attachment_tombstones(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
) -> Vec<PendingAttachmentTombstone> {
    let Some(body) = io
        .read(&pending_attachment_tombstones_path(vault_root))
        .await
        .ok()
        .and_then(|b| String::from_utf8(b).ok())
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in body.lines() {
        let mut parts = line.split_whitespace();
        let (Some(p), Some(f), Some(n)) = (parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        let (Some(sync_id), Some(id), Some(content_nonce)) = (
            hex_to_arr::<16>(p),
            hex_to_arr::<32>(f),
            hex_to_arr::<24>(n),
        ) else {
            continue;
        };
        out.push(PendingAttachmentTombstone {
            sync_id,
            id,
            content_nonce,
        });
    }
    out
}

/// Queue an attachment deletion for the next push (called by the attachments
/// plugin right after the catalog-tombstone rewrite + local crypto-erase).
/// Mints the fresh tombstone nonce internally. Idempotent per full id.
pub async fn add_pending_attachment_tombstone(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
    id: &[u8; 32],
) -> Result<(), SyncCycleError> {
    let mut queue = read_pending_attachment_tombstones(io, vault_root).await;
    if queue.iter().any(|t| &t.id == id) {
        return Ok(());
    }
    let mut nonce = [0u8; 24];
    getrandom::getrandom(&mut nonce).map_err(|_| SyncCycleError::Io)?;
    let mut sync_id = [0u8; 16];
    sync_id.copy_from_slice(&id[..16]);
    queue.push(PendingAttachmentTombstone {
        sync_id,
        id: *id,
        content_nonce: nonce,
    });
    write_pending_attachment_tombstones(io, vault_root, &queue).await
}

/// Drop queue entries (after their tombstone records pushed, or when a re-add
/// made them stale).
async fn clear_pending_attachment_tombstones(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
    drop_ids: &HashSet<[u8; 32]>,
) -> Result<(), SyncCycleError> {
    if drop_ids.is_empty() {
        return Ok(());
    }
    let queue: Vec<PendingAttachmentTombstone> = read_pending_attachment_tombstones(io, vault_root)
        .await
        .into_iter()
        .filter(|t| !drop_ids.contains(&t.id))
        .collect();
    write_pending_attachment_tombstones(io, vault_root, &queue).await
}

async fn write_pending_attachment_tombstones(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
    queue: &[PendingAttachmentTombstone],
) -> Result<(), SyncCycleError> {
    let mut lines: Vec<String> = queue
        .iter()
        .map(|t| {
            format!(
                "{} {} {}",
                hex(&t.sync_id),
                hex(&t.id),
                hex(&t.content_nonce)
            )
        })
        .collect();
    lines.sort();
    io.write(
        &pending_attachment_tombstones_path(vault_root),
        lines.join("\n").as_bytes(),
        crate::vault_io::WriteOpts::default(),
    )
    .await
    .map_err(|_| SyncCycleError::Io)
}

/// `download_attachment` with the same 429 backoff as [`download_blob_backoff`].
fn download_attachment_backoff(
    transport: &dyn SyncTransport,
    token: &str,
    id: &[u8; 32],
) -> Result<Option<Vec<u8>>, PullError> {
    let mut delay_ms = 250u64;
    for _ in 0..6 {
        match engine::download_attachment(transport, token, id, &[]) {
            Err(PullError::RateLimited) => {
                crate::task::block_sleep(std::time::Duration::from_millis(delay_ms));
                delay_ms = (delay_ms * 2).min(2000);
            }
            other => return other,
        }
    }
    engine::download_attachment(transport, token, id, &[])
}

/// `upload_attachment` with the same 429 backoff.
fn upload_attachment_backoff(
    transport: &dyn SyncTransport,
    token: &str,
    id: &[u8; 32],
    bytes: &[u8],
) -> Result<(), PushError> {
    let mut delay_ms = 250u64;
    for _ in 0..6 {
        match engine::upload_attachment(transport, token, id, bytes) {
            Err(PushError::RateLimited) => {
                crate::task::block_sleep(std::time::Duration::from_millis(delay_ms));
                delay_ms = (delay_ms * 2).min(2000);
            }
            other => return other,
        }
    }
    engine::upload_attachment(transport, token, id, bytes)
}

/// The catalog phase's outcome, consumed by the attachment pull loop (the
/// merged catalog is the §11.4 rule-5 resurrection guard) and the push phase
/// (a dirty catalog rides the same batch).
struct CatalogPhase {
    /// The post-merge catalog (== the on-disk catalog when this returns).
    merged: AttachmentsCatalog,
    /// The catalog needs a push (local-only change, or a merge that differed
    /// from the server's plaintext).
    dirty: bool,
}

/// Pull-side catalog reconciliation (MUST run before any attachment record is
/// acted on — §11.4 rule 5). Downloads a changed remote catalog, merges
/// per-entry, and either **adopts the server bytes verbatim** (merge result
/// canonically equal to the remote — re-encrypting would nonce-churn an
/// endless push loop) or writes the merged catalog freshly (dirty → pushed
/// this cycle with the server's version as CAS base). Holds the attachments
/// plugin's catalog write mutex across the read-merge-write.
// Each argument is a distinct cycle input (same shape as run_sync_cycle above);
// a bundling struct would not aid clarity at this single internal call site.
#[allow(clippy::too_many_arguments)]
async fn sync_catalog_phase(
    io: &dyn crate::vault_io::VaultIo,
    transport: &dyn SyncTransport,
    token: &str,
    root_key: &[u8; 32],
    account_number_hash: &[u8; 16],
    vault_root: &Path,
    state: &mut SyncState,
    cat_id: &[u8; 16],
    remote_record: Option<&ChangedBlob>,
) -> Result<CatalogPhase, SyncCycleError> {
    // See `apply_pulled_note_blob` — `blocking_lock` panics inside a runtime.
    let _guard = crate::plugins::attachments::commands::catalog_write_mutex()
        .lock()
        .await;

    let catalog_key = derive_subkey(root_key, SubkeyRole::AttachmentsCatalogKey);
    let path = catalog_file_path(vault_root);
    let local_bytes = io.read(&path).await.ok();
    let local_nonce = local_bytes.as_deref().and_then(read_catalog_nonce);
    // §9.10.4 read semantic: any local decode failure falls back to empty.
    let local_cat =
        protocol::read_or_empty(&catalog_key, account_number_hash, local_bytes.as_deref());

    let cat_hex = hex(cat_id);
    let baseline_nonce_hex = state
        .blobs
        .get(&cat_hex)
        .map(|b| b.content_nonce_hex.clone());

    // A remote record whose nonce we already hold needs no download.
    let remote_changed = remote_record
        .map(|r| Some(r.content_nonce) != local_nonce)
        .unwrap_or(false);

    if let (Some(rec), true) = (remote_record, remote_changed) {
        let remote_bytes =
            download_blob_backoff(transport, token, &rec.id).map_err(SyncCycleError::Pull)?;
        // A hostile/corrupt remote catalog collapses to empty (§9.10.4);
        // merge(local, empty) == local, so nothing is lost and the local
        // catalog re-pushes over it.
        let remote_cat =
            protocol::read_or_empty(&catalog_key, account_number_hash, Some(&remote_bytes));
        let merged = merge_attachments_catalog(&local_cat, &remote_cat);

        if merged == remote_cat {
            // Adopt the server bytes VERBATIM — byte-identical catalog +
            // baseline == server (version, nonce); nothing to push.
            io.write(&path, &remote_bytes, crate::vault_io::WriteOpts::default())
                .await
                .map_err(|_| SyncCycleError::Io)?;
            record_blob_baseline(state, &cat_hex, rec);
            return Ok(CatalogPhase {
                merged,
                dirty: false,
            });
        }

        // Merge differs from the server → write it fresh and push it this
        // cycle against the server's current version.
        let merged_bytes = encode_attachments_catalog(&catalog_key, account_number_hash, &merged)
            .map_err(|_| SyncCycleError::Io)?;
        io.write(&path, &merged_bytes, crate::vault_io::WriteOpts::default())
            .await
            .map_err(|_| SyncCycleError::Io)?;
        // Record the server's version as the CAS base WITHOUT claiming its
        // nonce (the local file now differs → dirty).
        record_blob_baseline(state, &cat_hex, rec);
        return Ok(CatalogPhase {
            merged,
            dirty: true,
        });
    }

    // No (changed) remote catalog: dirty iff the local file drifted from the
    // synced baseline. A virgin empty catalog (no entries, no baseline) is
    // deliberately NOT pushed — an attachment-less vault stays catalog-silent.
    let local_nonce_hex = local_nonce.map(|n| hex(&n));
    let dirty = local_bytes.is_some()
        && local_nonce_hex != baseline_nonce_hex
        && !(local_cat.entries.is_empty() && baseline_nonce_hex.is_none());
    Ok(CatalogPhase {
        merged: local_cat,
        dirty,
    })
}

/// Record the server's current revision of a vault singleton as the CAS
/// baseline (version + nonce) — the one bookkeeping step every phase branch
/// (catalog / prefs / themes) that has seen a server record performs.
///
/// Recording the server's nonce does NOT claim the local file matches it: a
/// merge branch writes freshly-re-encrypted local bytes (a different nonce) and
/// reports `dirty`, using the recorded version purely as the push's CAS base.
fn record_blob_baseline(state: &mut SyncState, id_hex: &str, rec: &ChangedBlob) {
    state.blobs.insert(
        id_hex.to_string(),
        BlobSyncState {
            version: rec.version,
            content_nonce_hex: hex(&rec.content_nonce),
        },
    );
}

/// Per-process RAM baseline for the §10.2.1 prefs push gate: vault root →
/// the shared-subset hash last pushed or adopted as synced. Deliberately
/// **never persisted**: an unkeyed digest of decrypted shared prefs at rest
/// would hand a filesystem observer (A5/A7) a confirmation oracle over the
/// vault's label / folder names — the plaintext-at-rest class SYNC-3 forbids,
/// and `sync-state.json`'s own invariant is "server-visible metadata only".
/// A lost baseline (app restart) degrades to at most one redundant push, and
/// only when the local blob actually changed since the last sync — the
/// baseline-nonce short-circuit in `sync_prefs_phase` proves the no-change
/// case without any plaintext-derived state.
fn prefs_gate_baselines() -> &'static std::sync::Mutex<HashMap<std::path::PathBuf, String>> {
    static M: std::sync::OnceLock<std::sync::Mutex<HashMap<std::path::PathBuf, String>>> =
        std::sync::OnceLock::new();
    M.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// The current RAM push-gate baseline for this vault, if any.
fn prefs_gate_baseline(vault_root: &Path) -> Option<String> {
    prefs_gate_baselines()
        .lock()
        .expect("prefs gate baseline lock")
        .get(vault_root)
        .cloned()
}

/// Record `hash` as the RAM push-gate baseline for this vault.
fn set_prefs_gate_baseline(vault_root: &Path, hash: String) {
    prefs_gate_baselines()
        .lock()
        .expect("prefs gate baseline lock")
        .insert(vault_root.to_path_buf(), hash);
}

/// The prefs phase's outcome (MYND-478; `sync-protocol.md` §10.2.1).
struct PrefsPhase {
    /// The prefs blob needs a push: the shared subset changed vs the synced
    /// baseline, a merge beat the server's plaintext, or the server has never
    /// held a prefs blob (the §10.2.1 initial publish).
    dirty: bool,
    /// A remote change was merged into the on-disk view — the caller surfaces
    /// this so the UI layer refreshes caches + emits the prefs-changed event.
    applied_remote: bool,
    /// `shared_subset_hash` of the on-disk view when the phase returned; the
    /// caller records it as the new baseline once a push lands.
    shared_hash: String,
}

/// Pull-side `vault.prefs` reconciliation (MYND-478; `sync-protocol.md`
/// §10.2.1). The `sync_catalog_phase` twin with one twist: the push gate is
/// the **shared-subset hash**, not the blob nonce — a purely device-local
/// edit re-encrypts the blob but must generate no traffic. Downloads a
/// changed remote prefs blob, runs the §10.2 field/set merge post-decrypt,
/// and either **adopts the server bytes verbatim** (merge canonically equal
/// to the remote — re-encrypting would nonce-churn an endless push loop) or
/// writes the merged view freshly (dirty → pushed this cycle with the
/// server's version as CAS base). Holds the prefs plugin's write mutex
/// across the read-merge-write.
#[allow(clippy::too_many_arguments)]
async fn sync_prefs_phase(
    io: &dyn crate::vault_io::VaultIo,
    transport: &dyn SyncTransport,
    token: &str,
    root_key: &[u8; 32],
    account_number_hash: &[u8; 16],
    vault_root: &Path,
    state: &mut SyncState,
    prefs_id: &[u8; 16],
    remote_record: Option<&ChangedBlob>,
) -> Result<PrefsPhase, SyncCycleError> {
    use crate::plugins::sync::prefs_merge::{merge_prefs, shared_subset_hash};

    // See `apply_pulled_note_blob` — `blocking_lock` panics inside a runtime.
    let _guard = crate::plugins::prefs::commands::write_mutex().lock().await;

    let prefs_key = derive_subkey(root_key, SubkeyRole::PrefsKey);
    let path = vault_root.join("vault.prefs");
    let local_bytes = io.read(&path).await.ok();
    let local_nonce = local_bytes.as_deref().and_then(read_prefs_nonce);
    // §9.5.5 read semantic: any local decode failure falls back to defaults.
    let local_view = local_bytes
        .as_deref()
        .and_then(|b| protocol::decode_prefs_blob(&prefs_key, account_number_hash, b).ok())
        .unwrap_or_default();

    let id_hex = hex(prefs_id);

    // Enrollment wholesale seed (§10.2.1): a VIRGIN vault — no `vault.prefs`
    // on disk, the just-joined-device state (`sync_join_account` materializes
    // meta + notes but never a prefs blob) — adopts the server's blob
    // VERBATIM, device-local fields included as starting defaults. This runs
    // on the first authed cycle (a pending device has no token at join time)
    // and exactly once: after the seed the file exists, so every later cycle
    // merges. A server blob that fails decode falls through to the general
    // path (merge with defaults — the hostile-blob posture).
    if local_bytes.is_none() {
        if let Some(rec) = remote_record {
            let remote_bytes =
                download_blob_backoff(transport, token, &rec.id).map_err(SyncCycleError::Pull)?;
            if let Ok(seeded) =
                protocol::decode_prefs_blob(&prefs_key, account_number_hash, &remote_bytes)
            {
                io.write(&path, &remote_bytes, crate::vault_io::WriteOpts::default())
                    .await
                    .map_err(|_| SyncCycleError::Io)?;
                record_blob_baseline(state, &id_hex, rec);
                let shared_hash = shared_subset_hash(&seeded);
                set_prefs_gate_baseline(vault_root, shared_hash.clone());
                return Ok(PrefsPhase {
                    dirty: false,
                    applied_remote: true,
                    shared_hash,
                });
            }
        }
    }

    let baseline_nonce_hex = state
        .blobs
        .get(&id_hex)
        .map(|b| b.content_nonce_hex.clone());
    // A remote revision is worth reconciling only when it is neither our own
    // bytes (local nonce) nor a server revision we already reconciled
    // (baseline nonce) — without the second check, a peer's blob that differs
    // only in DEVICE-LOCAL fields would be re-downloaded and re-merged every
    // cycle forever.
    let remote_changed = remote_record
        .map(|r| {
            Some(r.content_nonce) != local_nonce
                && Some(hex(&r.content_nonce)) != baseline_nonce_hex
        })
        .unwrap_or(false);

    if let (Some(rec), true) = (remote_record, remote_changed) {
        let remote_bytes =
            download_blob_backoff(transport, token, &rec.id).map_err(SyncCycleError::Pull)?;
        // A hostile/corrupt remote prefs blob collapses to defaults (§9.5.5);
        // merge(local, default) keeps every locally-clocked value and the
        // local view re-pushes over it.
        let remote_view =
            protocol::decode_prefs_blob(&prefs_key, account_number_hash, &remote_bytes)
                .unwrap_or_default();
        let merged = merge_prefs(&local_view, &remote_view);
        let applied_remote = merged != local_view;
        let merged_hash = shared_subset_hash(&merged);
        let remote_hash = shared_subset_hash(&remote_view);

        if merged == remote_view {
            // Adopt the server bytes VERBATIM — byte-identical blob + baseline
            // == server (version, nonce); nothing to push.
            io.write(&path, &remote_bytes, crate::vault_io::WriteOpts::default())
                .await
                .map_err(|_| SyncCycleError::Io)?;
            record_blob_baseline(state, &id_hex, rec);
            set_prefs_gate_baseline(vault_root, merged_hash.clone());
            return Ok(PrefsPhase {
                dirty: false,
                applied_remote,
                shared_hash: merged_hash,
            });
        }

        if merged_hash == remote_hash {
            // The server already carries the merged SHARED subset — the views
            // differ only in device-local fields (which never sync). Persist
            // the merged view locally iff a remote shared edit landed, record
            // the server revision as the reconciled baseline, and push
            // NOTHING — pushing would ping-pong device-local re-encrypts
            // between peers forever.
            if applied_remote {
                let merged_bytes =
                    protocol::encode_prefs_blob(&prefs_key, account_number_hash, &merged)
                        .map_err(|_| SyncCycleError::Io)?;
                io.write(&path, &merged_bytes, crate::vault_io::WriteOpts::default())
                    .await
                    .map_err(|_| SyncCycleError::Io)?;
            }
            record_blob_baseline(state, &id_hex, rec);
            set_prefs_gate_baseline(vault_root, merged_hash.clone());
            return Ok(PrefsPhase {
                dirty: false,
                applied_remote,
                shared_hash: merged_hash,
            });
        }

        // The merge beat the server's SHARED subset → write it fresh and push
        // it this cycle. The server's revision is recorded as the CAS base;
        // its nonce also serves the anti-redownload check, while the local
        // file (freshly re-encrypted) intentionally carries a different one.
        let merged_bytes = protocol::encode_prefs_blob(&prefs_key, account_number_hash, &merged)
            .map_err(|_| SyncCycleError::Io)?;
        io.write(&path, &merged_bytes, crate::vault_io::WriteOpts::default())
            .await
            .map_err(|_| SyncCycleError::Io)?;
        record_blob_baseline(state, &id_hex, rec);
        return Ok(PrefsPhase {
            dirty: true,
            applied_remote,
            shared_hash: merged_hash,
        });
    }

    // No (changed) remote prefs record. NOTE this branch has TWO sub-cases:
    // the server record can match the LOCAL file's nonce (we hold exactly the
    // server's bytes) or only the PERSISTED baseline's nonce (an unsynced
    // local edit re-encrypted the file while the server simply hasn't moved).
    let shared_hash = shared_subset_hash(&local_view);
    if let Some(rec) = remote_record {
        // Self-heal the CAS baseline so a re-enrolled/migrated device stops
        // registering as never-synced.
        record_blob_baseline(state, &id_hex, rec);
        // Self-heal the RAM push-gate baseline ONLY when the local blob is
        // provably the server's exact bytes (nonce match). Healing in the
        // other sub-case would baptize an unsynced shared edit as "already
        // synced" and silently withhold it from the fleet — the poisoned-gate
        // lost-update. Left unset, the gate conservatively pushes once (the
        // §10.2.1 documented degradation).
        let local_is_server_bytes = local_nonce.map(|n| hex(&n)) == Some(hex(&rec.content_nonce));
        if local_is_server_bytes && prefs_gate_baseline(vault_root).is_none() {
            set_prefs_gate_baseline(vault_root, shared_hash.clone());
        }
    }
    let never_synced = !state.blobs.contains_key(&id_hex);
    // No-change short-circuit: every prefs write re-encrypts under a fresh
    // nonce, so a local blob whose outer nonce still equals the synced
    // baseline's is provably byte-untouched since the last sync — no
    // plaintext-derived state consulted.
    let baseline_nonce_now = state
        .blobs
        .get(&id_hex)
        .map(|b| b.content_nonce_hex.clone());
    let nonce_clean =
        baseline_nonce_now.is_some() && local_nonce.map(|n| hex(&n)) == baseline_nonce_now;
    // §10.2.1: a server that has never held a prefs blob receives this
    // device's unconditionally (even a default view) — the initial publish —
    // so a later enrollment gets the vault identity without waiting for a
    // shared-pref edit. Otherwise the RAM shared-subset baseline is the push
    // gate; a lost baseline (restart) conservatively pushes once.
    let dirty = never_synced
        || (!nonce_clean
            && prefs_gate_baseline(vault_root).as_deref() != Some(shared_hash.as_str()));
    Ok(PrefsPhase {
        dirty,
        applied_remote: false,
        shared_hash,
    })
}

/// The themes phase's outcome (MYND-486).
struct ThemesPhase {
    /// The themes blob needs a push: a local-only change, or a merge that
    /// differed from the server's plaintext.
    dirty: bool,
    /// A remote change was merged onto the on-disk store this cycle.
    applied_remote: bool,
}

/// Pull-side `vault.themes` reconciliation (MYND-486). The `sync_catalog_phase`
/// twin: `vault.themes` carries **no device-local subset** (every theme is
/// shared vault content), so the push gate is the blob nonce vs the synced
/// baseline — no shared-subset hash, which is the one twist `sync_prefs_phase`
/// needs and this phase does not. Downloads a changed remote themes blob, runs
/// the per-theme-name [`merge_custom_themes`] post-decrypt, and either **adopts
/// the server bytes verbatim** (merge equal to the remote — re-encrypting would
/// nonce-churn an endless push loop) or writes the merged store freshly (dirty
/// → pushed this cycle with the server's version as CAS base). Holds the themes
/// plugin's write mutex across the read-merge-write.
// Each argument is a distinct cycle input (the same shape as the sibling
// catalog/prefs phases); a bundling struct would not aid clarity here.
#[allow(clippy::too_many_arguments)]
async fn sync_themes_phase(
    io: &dyn crate::vault_io::VaultIo,
    transport: &dyn SyncTransport,
    token: &str,
    root_key: &[u8; 32],
    account_number_hash: &[u8; 16],
    vault_root: &Path,
    state: &mut SyncState,
    themes_id: &[u8; 16],
    remote_record: Option<&ChangedBlob>,
) -> Result<ThemesPhase, SyncCycleError> {
    use crate::plugins::themes::commands::{decode_themes_map_or_empty, encode_themes_map};

    // See `apply_pulled_note_blob` — `blocking_lock` panics inside a runtime.
    let _guard = crate::plugins::themes::commands::write_mutex().lock().await;

    let path = themes_file_path(vault_root);
    let local_bytes = io.read(&path).await.ok();
    let local_nonce = local_bytes.as_deref().and_then(read_themes_nonce);

    // Decrypting the local store costs an HKDF + a full AEAD open + a whole-map
    // JSON parse, so it happens ONLY on the two paths that read the plaintext:
    // the remote-reconcile branch (which merges) and the virgin-store check
    // below. The steady state — no remote change, local nonce == baseline —
    // proves byte-cleanliness from the nonce alone and never decrypts. (The
    // `sync_catalog_phase` twin decodes eagerly for a reason this phase lacks:
    // it RETURNS the merged catalog to the downstream attachment loop, while
    // `ThemesPhase` returns only flags.)
    // §9.21.4 read semantic: any local decode failure falls back to empty.
    let decode_local = || {
        let themes_key = derive_subkey(root_key, SubkeyRole::CustomThemesKey);
        let map =
            decode_themes_map_or_empty(&themes_key, account_number_hash, local_bytes.as_deref());
        (themes_key, map)
    };

    let id_hex = hex(themes_id);
    let baseline_nonce_hex = state
        .blobs
        .get(&id_hex)
        .map(|b| b.content_nonce_hex.clone());

    // A remote record whose nonce we already hold needs no download.
    let remote_changed = remote_record
        .map(|r| Some(r.content_nonce) != local_nonce)
        .unwrap_or(false);

    if let (Some(rec), true) = (remote_record, remote_changed) {
        let remote_bytes =
            download_blob_backoff(transport, token, &rec.id).map_err(SyncCycleError::Pull)?;
        let (themes_key, local_map) = decode_local();
        // A hostile/corrupt remote store collapses to empty (§9.21.4);
        // merge(local, empty) == local, so nothing is lost and the local store
        // re-pushes over it.
        let remote_map =
            decode_themes_map_or_empty(&themes_key, account_number_hash, Some(&remote_bytes));
        let merged = merge_custom_themes(&local_map, &remote_map);
        let applied_remote = merged != local_map;

        let (bytes, dirty) = if merged == remote_map {
            // Adopt the server bytes VERBATIM — byte-identical store + baseline
            // == server (version, nonce); nothing to push. Re-encrypting an
            // already-agreeing store would churn the nonce and push forever.
            (remote_bytes, false)
        } else {
            // The merge beat the server's store → write it fresh and push it
            // this cycle against the server's current version. The local file
            // (freshly re-encrypted) intentionally carries a different nonce
            // from the recorded CAS base.
            (
                encode_themes_map(&themes_key, account_number_hash, &merged)
                    .map_err(|_| SyncCycleError::Io)?,
                true,
            )
        };
        io.write(&path, &bytes, crate::vault_io::WriteOpts::default())
            .await
            .map_err(|_| SyncCycleError::Io)?;
        record_blob_baseline(state, &id_hex, rec);
        return Ok(ThemesPhase {
            dirty,
            applied_remote,
        });
    }

    // No (changed) remote themes record: dirty iff the local file drifted from
    // the synced baseline. Every themes write re-encrypts under a fresh nonce,
    // so a local blob whose outer nonce still equals the baseline's is provably
    // byte-untouched since the last sync. A virgin empty store (no themes, no
    // baseline) is deliberately NOT pushed — a theme-less vault stays
    // themes-silent, exactly as an attachment-less vault stays catalog-silent.
    let local_nonce_hex = local_nonce.map(|n| hex(&n));
    // The virgin-store conjunct is ordered baseline-first so the cheap `is_none`
    // gates the expensive decode: only a never-synced vault pays it, and only
    // after the nonce check already proved the file drifted. Both conjuncts are
    // pure, so the order swap is semantics-preserving.
    let dirty = local_bytes.is_some()
        && local_nonce_hex != baseline_nonce_hex
        && !(baseline_nonce_hex.is_none() && decode_local().1.is_empty());
    Ok(ThemesPhase {
        dirty,
        applied_remote: false,
    })
}

/// The engine's `local` manifest (raw 16-byte id → 24-byte content_nonce), read
/// decryption-free from the on-disk notes dir. Converts the notes-domain
/// [`NonceManifest`](crate::note_nonce::NonceManifest) String keys to the
/// raw uuid bytes the engine wants.
pub async fn local_manifest(
    io: &dyn crate::vault_io::VaultIo,
    notes_dir: &Path,
) -> HashMap<[u8; 16], [u8; 24]> {
    let mut out = HashMap::new();
    for (id_str, nonce) in crate::note_nonce::scan_on_disk_manifest_io(io, notes_dir).await {
        if let Ok(u) = uuid::Uuid::parse_str(&id_str) {
            out.insert(*u.as_bytes(), nonce);
        }
    }
    out
}

/// The manifest entries (sorted internally by `compute_manifest_hash`) that the
/// vault head commits as `manifest_hash`.
fn manifest_entries(local: &HashMap<[u8; 16], [u8; 24]>) -> Vec<ManifestEntry> {
    local
        .iter()
        .map(|(id, n)| ManifestEntry {
            id: *id,
            content_nonce: *n,
        })
        .collect()
}

/// Upper bound on the pull→push attempts in one [`run_sync_cycle`] (the initial
/// attempt + retries). A lost-CAS 409 triggers a full-reconcile retry; the bound
/// stops a structurally-unrecoverable 409 (or an actively-racing peer) from looping
/// forever — the next cycle simply re-attempts from the persisted cursor.
const MAX_PUSH_ATTEMPTS: usize = 3;

/// Run one full sync cycle against the configured server. `account_number_hash`
/// and `device_id` are the 16-byte values captured at enrollment (the head binds
/// the account; the VV-actor is this device). Idempotent: a no-change cycle is a
/// cheap pull that writes nothing.
///
/// **409 (lost-CAS) recovery.** A push can lose a compare-and-set two ways:
/// `BlobStale` (a blob's `base_version` fell behind the server) or `HeadStale`
/// (another device advanced the head between our pull and our push). Either is
/// retried with a **full-reconcile** pull (`from_cursor = 0`) so the next attempt
/// sees the *complete* server roster + current head: a blob that advanced past our
/// baseline but now sits OUTSIDE the normal `ChangedSince(cursor)` window is then
/// re-detected as a conflict (excluded), and a moved head is re-pulled so we
/// re-author a valid linear advance over it — instead of re-pushing a stale
/// `base_version` forever, which wedges the whole atomic push batch (a single
/// blob's CAS failure aborts the server's batch before it commits, so an innocent
/// sibling note can never get through either). Bounded by [`MAX_PUSH_ATTEMPTS`].
/// The device-local sync state is persisted only on a fully successful attempt, so
/// a failed retry never leaks a half-advanced cursor onto disk.
/// SHA-256 of `bytes` as lowercase hex — the `vault.meta` baseline discriminator.
fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex(&Sha256::digest(bytes))
}

/// What the `vault.meta` reconcile did this cycle (F1 Faz B). Returned for tests
/// and logging; the caller treats every arm as success (the phase is best-effort).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetaPhaseOutcome {
    /// Nothing to do (server + local already agree, or nothing to push yet).
    NoChange,
    /// Pushed the local meta to the server (this device's change propagated).
    Pushed,
    /// Adopted the server's meta locally (picked up another device's change).
    Adopted,
    /// Concurrent change on both devices — deterministically merged.
    Merged,
    /// Transient/incompatible: left local untouched (never overwrites on doubt).
    Skipped,
    /// The two metas disagree on the **password-side wrap** and this device has
    /// **no baseline** to say which side moved (phase3-web-client task 88).
    ///
    /// Refused rather than adopted, and the asymmetry of the two mistakes is the
    /// whole reason:
    ///
    /// * **Adopting wrongly** reverts a password the user has just changed. It is
    ///   silent — no error anywhere — and their new password stops working while
    ///   the old one starts working again. On the web client there is no recovery
    ///   phrase by settled decision, so the only remedy is a native client with a
    ///   password they have just been told is no longer theirs.
    /// * **Refusing wrongly** stalls another device's password change on this one.
    ///   The user knows they changed it, the vault content is untouched, and the
    ///   next cycle with an intact baseline resolves it.
    ///
    /// The condition is reachable exactly when the evidence was lost: `sync-state.json`
    /// and `vault.meta-dirty` both live in the same evictable OPFS container, so a
    /// browser eviction or a torn sidecar write removes `meta_baseline_hex` and the
    /// dirty marker together — and an ABSENT baseline must never read as "I have no
    /// local change".
    CredentialAmbiguous,
}

/// F1 Faz B — reconcile `vault.meta` with the server, independent of the head /
/// blob plane (`vault.meta` is class-2 identity, never head-committed). Runs once
/// per successful cycle. Closes the "a password change on device A must reach the
/// already-enrolled device B" gap that Faz A's push-on-change only half-covers.
///
/// Convergence with a plain last-writer-wins server (no version counter): the
/// device-local `meta_baseline_hex` distinguishes "server unchanged since I synced"
/// (only I changed → push) from "server also changed" (concurrent → deterministic
/// [`meta_password_side_winner`] merge, so both devices pick the same winner and
/// stop — CRDT-style, exactly like the attachments-catalog merge).
///
/// SAFETY: `root_key` is a per-vault random value that a password change never
/// touches — only its password-side *wrap* rotates — and [`merge_vault_meta`]
/// refuses any meta whose recovery-side / KDF params / itemsKey wrap diverges. So
/// an adopted/merged meta always carries the SAME `root_key` + itemsKey: notes stay
/// readable and an already-unlocked session (which holds the keys in memory) is
/// unaffected; only the NEXT unlock uses the new password wrap. On any doubt
/// (transport error, unparseable or invariant-incompatible server meta) the phase
/// SKIPS — it never overwrites the local credential root on a bad input.
pub(crate) async fn sync_meta_phase(
    io: &dyn crate::vault_io::VaultIo,
    transport: &dyn SyncTransport,
    token: &str,
    vault_root: &Path,
    state: &mut SyncState,
    allow_push: bool,
) -> MetaPhaseOutcome {
    let meta_path = vault_root.join("vault.meta");
    let Ok(local_bytes) = io.read(&meta_path).await else {
        return MetaPhaseOutcome::NoChange; // no local meta (unenrolled edge) → nothing
    };
    let Ok(local_meta) = parse_vault_meta(&local_bytes) else {
        return MetaPhaseOutcome::Skipped;
    };
    let local_hash = sha256_hex(&local_bytes);
    let dirty = vault_meta_is_dirty(io, vault_root).await;

    // Authed GET of THIS device's own server meta (no ?account=, not pre-auth).
    let resp = match transport.request(HttpMethod::Get, "/vault.meta", &[], Some(token)) {
        Ok(r) => r,
        Err(_) => return MetaPhaseOutcome::Skipped, // transient — keep dirty for next cycle
    };
    let server_bytes = match resp.status {
        200 => resp.body,
        404 => {
            // Server holds no meta yet (pre-seed). Contribute ours if we have a
            // pending change and may push; else nothing to do.
            if dirty
                && allow_push
                && super::enroll::put_vault_meta(transport, token, &local_bytes).is_ok()
            {
                state.meta_baseline_hex = Some(local_hash);
                let _ = clear_vault_meta_dirty(io, vault_root).await;
                return MetaPhaseOutcome::Pushed;
            }
            return MetaPhaseOutcome::NoChange;
        }
        _ => return MetaPhaseOutcome::Skipped,
    };
    let Ok(server_meta) = parse_vault_meta(&server_bytes) else {
        return MetaPhaseOutcome::Skipped;
    };
    let server_hash = sha256_hex(&server_bytes);

    // Already agree → clear any pending dirt, record the baseline.
    if server_hash == local_hash {
        state.meta_baseline_hex = Some(local_hash);
        let _ = clear_vault_meta_dirty(io, vault_root).await;
        return MetaPhaseOutcome::NoChange;
    }

    let baseline = state.meta_baseline_hex.as_deref();
    let local_changed = dirty || (baseline.is_some() && baseline != Some(local_hash.as_str()));
    let server_changed = baseline.is_none() || baseline != Some(server_hash.as_str());

    // Only the server changed (I have no pending local change) → adopt it. Validate
    // compatibility first: never overwrite the local credential root with a meta
    // whose recovery-side / KDF / itemsKey diverges (a hostile or corrupt server).
    if server_changed && !local_changed {
        // The absent-baseline trap (phase3-web-client task 88). `local_changed`
        // is `dirty || (baseline.is_some() && …)`, so with BOTH the baseline and
        // the dirty marker gone it computes `false` while `server_changed`
        // computes `true` — and this branch overwrites the local `vault.meta`
        // with the server's older copy. Those two signals live in the same
        // evictable OPFS container, so they are lost together, and the visible
        // result is that a password the user just changed silently stops working
        // and the old one silently starts working again.
        //
        // Scoped to the PASSWORD-SIDE wrap on purpose. An absent baseline with an
        // identical password wrap is the ordinary case — another device changed
        // something this one does not hold an opinion about — and refusing there
        // would stall propagation for no safety gain. It is only when the
        // credential itself differs and nothing can say which side moved that
        // adopting risks reverting one.
        let credential_differs = local_meta.random_salt_password
            != server_meta.random_salt_password
            || local_meta.nonce_password_wrap != server_meta.nonce_password_wrap
            || local_meta.enc_root_key_password != server_meta.enc_root_key_password;
        if baseline.is_none() && credential_differs {
            tracing::warn!(
                stage = "meta_phase",
                event = "credential_ambiguous",
                "refusing to adopt: password-side wraps differ and no baseline says which moved"
            );
            return MetaPhaseOutcome::CredentialAmbiguous;
        }
        if merge_vault_meta(&local_meta, &server_meta, MetaWinner::Remote).is_err() {
            return MetaPhaseOutcome::Skipped;
        }
        if io
            .write(
                &meta_path,
                &server_bytes,
                crate::vault_io::WriteOpts::default(),
            )
            .await
            .is_ok()
        {
            state.meta_baseline_hex = Some(server_hash);
            let _ = clear_vault_meta_dirty(io, vault_root).await;
            return MetaPhaseOutcome::Adopted;
        }
        return MetaPhaseOutcome::Skipped;
    }

    // Only I changed (server unchanged since my baseline) → push my meta.
    if local_changed && !server_changed {
        if allow_push && super::enroll::put_vault_meta(transport, token, &local_bytes).is_ok() {
            state.meta_baseline_hex = Some(local_hash);
            let _ = clear_vault_meta_dirty(io, vault_root).await;
            return MetaPhaseOutcome::Pushed;
        }
        return MetaPhaseOutcome::NoChange; // keep dirty for a later push cycle
    }

    // Both changed (concurrent) → deterministic, commutative merge so both devices
    // converge on the same winner with no server-side version counter.
    let winner = meta_password_side_winner(&local_meta, &server_meta);
    let Ok(merged) = merge_vault_meta(&local_meta, &server_meta, winner) else {
        return MetaPhaseOutcome::Skipped; // incompatible invariant → leave local alone
    };
    let merged_bytes = serialize_vault_meta(&merged);
    let merged_hash = sha256_hex(&merged_bytes);
    if io
        .write(
            &meta_path,
            &merged_bytes,
            crate::vault_io::WriteOpts::default(),
        )
        .await
        .is_err()
    {
        return MetaPhaseOutcome::Skipped;
    }
    state.meta_baseline_hex = Some(merged_hash.clone());
    if merged_hash == server_hash {
        // Server already holds the winner — nothing to push; we are converged.
        let _ = clear_vault_meta_dirty(io, vault_root).await;
    } else if allow_push {
        let _ = super::enroll::put_vault_meta(transport, token, &merged_bytes);
        let _ = clear_vault_meta_dirty(io, vault_root).await;
    }
    // (!allow_push && merged != server: keep dirty so a later push cycle propagates.)
    MetaPhaseOutcome::Merged
}

// The arguments are each a distinct, independent input to the cycle (the
// transport, the two keys/ids, the token, the two paths, the push gate); bundling
// them into a struct would not aid clarity at this single orchestrator entry.
#[allow(clippy::too_many_arguments)]
pub async fn run_sync_cycle(
    io: &dyn crate::vault_io::VaultIo,
    transport: &dyn SyncTransport,
    root_key: &[u8; 32],
    account_number_hash: [u8; 16],
    device_id: [u8; 16],
    token: &str,
    notes_dir: &Path,
    vault_root: &Path,
    allow_push: bool,
    attachment_keys: Option<AttachmentKeys<'_>>,
) -> Result<SyncSummary, SyncCycleError> {
    let mut state = read_sync_state(io, vault_root)
        .await
        .map_err(|_| SyncCycleError::Io)?;

    // Baseline VV + seq from the device-local head baseline (empty on first sync).
    let baseline_head = read_head_baseline(io, root_key, vault_root)
        .await
        .ok()
        .flatten();
    let baseline_vv: Vec<VvEntry> = baseline_head
        .as_ref()
        .map(|h| h.version_vector.clone())
        .unwrap_or_default();
    let baseline_seq = baseline_head.as_ref().map(|h| h.seq).unwrap_or(0);

    // Drive one attempt; on a lost-CAS 409 re-attempt with a full reconcile (see the
    // fn doc). `state` carries across attempts (its baselines/staged conflicts learnt
    // on attempt N help attempt N+1); it is persisted by the caller only on success.
    let mut from_cursor = state.cursor;
    let mut attempt = 0usize;
    loop {
        attempt += 1;
        match sync_cycle_attempt(
            io,
            transport,
            root_key,
            account_number_hash,
            device_id,
            token,
            notes_dir,
            vault_root,
            allow_push,
            attachment_keys,
            &mut state,
            &baseline_vv,
            baseline_seq,
            from_cursor,
        )
        .await
        {
            Ok(mut summary) => {
                // F1 Faz B: reconcile vault.meta once per successful cycle (it is
                // independent of the head/blob CAS plane, so it runs after the notes
                // attempt succeeds, not inside the 409-retry loop). Best-effort — a
                // meta hiccup must not fail a cycle that already synced notes; it
                // mutates `state.meta_baseline_hex` (persisted just below) and does
                // its own vault.meta write / dirty-marker clear.
                let meta_outcome =
                    sync_meta_phase(io, transport, token, vault_root, &mut state, allow_push).await;
                summary.credential_ambiguous =
                    meta_outcome == MetaPhaseOutcome::CredentialAmbiguous;
                // Persist the advanced cursor + per-blob CAS state + meta baseline
                // ONLY on success, so a failed retry never leaves a half-advanced
                // cursor on disk.
                write_sync_state(io, vault_root, &state)
                    .await
                    .map_err(|_| SyncCycleError::Io)?;
                return Ok(summary);
            }
            Err(SyncCycleError::Push(PushError::BlobStale | PushError::HeadStale))
                if attempt < MAX_PUSH_ATTEMPTS =>
            {
                // Full reconcile on the retry so the stale blob / moved head re-enters
                // the roster and is handled (excluded as a conflict / re-authored over).
                from_cursor = 0;
            }
            Err(e) => return Err(e),
        }
    }
}

/// One pull→reconcile→detect→push attempt. Factored out of [`run_sync_cycle`] so a
/// lost-CAS 409 can re-run it with a full-reconcile cursor (`from_cursor = 0`).
/// Mutates `state` in place (cursor + per-blob baselines + VV log) but does NOT
/// persist `sync-state.json` — the caller persists on success only.
#[allow(clippy::too_many_arguments)]
async fn sync_cycle_attempt(
    io: &dyn crate::vault_io::VaultIo,
    transport: &dyn SyncTransport,
    root_key: &[u8; 32],
    account_number_hash: [u8; 16],
    device_id: [u8; 16],
    token: &str,
    notes_dir: &Path,
    vault_root: &Path,
    allow_push: bool,
    attachment_keys: Option<AttachmentKeys<'_>>,
    state: &mut SyncState,
    baseline_vv: &[VvEntry],
    baseline_seq: u64,
    from_cursor: u64,
) -> Result<SyncSummary, SyncCycleError> {
    // --- PULL (head verify + rollback rejection happen inside) ---
    // A `cursor_expired` (410) means the server GC'd past our stored cursor: reset
    // to a full reconcile from 0 and re-pull ONCE. The re-pull sets `reconcile=true`
    // so the server exempts it from the cursor-expired floor — otherwise a vault
    // whose reclaim floor sits beyond the first pull page would 410 the page-2
    // request of the reconcile walk itself and wedge us at 410 forever. The baseline
    // self-heal below re-establishes per-blob versions (MYND-426 task 8).
    let mut reconcile_ran = false;
    // The engine's `local` map covers every synced artefact this device holds —
    // notes, attachment sync-ids, and the catalog + themes singletons — so an
    // unchanged record is never flagged `changed` and the baseline self-heal
    // below covers them all (MYND-468, MYND-486). The attachment/catalog phases
    // are gated on `attachment_keys` (legacy note-only cycles pass `None`);
    // the themes phase is unconditional.
    // ONE disk scan per attempt (notes + attachments): the pull loop below
    // maintains both manifests in memory as it writes, and (§11.3) ONLY ever
    // writes bytes whose header nonce matched the wire record — mismatching
    // bytes are skipped without touching disk, so the in-memory manifest can
    // never diverge from disk and the old `manifest_stale` rescan valve is no
    // longer needed. The push-detect and head-manifest phases reuse the
    // maintained manifests instead of re-walking every blob header.
    let cat_id = attachment_keys.map(|_| catalog_sync_id(root_key));
    let themes_id = themes_sync_id(root_key);
    let mut att_scan: BTreeMap<[u8; 16], AttachmentManifestEntry> = if attachment_keys.is_some() {
        scan_attachments_manifest(io, &attachments_dir(vault_root)).await
    } else {
        BTreeMap::new()
    };
    let mut notes_manifest = local_manifest(io, notes_dir).await;
    // The pre-pull union snapshot the pull-diff runs against — the dirty-skip
    // check wants each blob's state BEFORE this cycle's writes.
    let mut local = notes_manifest.clone();
    for (sid, e) in &att_scan {
        local.insert(*sid, e.content_nonce);
    }
    if let Some(cid) = cat_id {
        if let Some(n) = io
            .read(&catalog_file_path(vault_root))
            .await
            .ok()
            .as_deref()
            .and_then(read_catalog_nonce)
        {
            local.insert(cid, n);
        }
    }
    if let Some(n) = io
        .read(&themes_file_path(vault_root))
        .await
        .ok()
        .as_deref()
        .and_then(read_themes_nonce)
    {
        local.insert(themes_id, n);
    }
    let page = match engine::pull_to_stable(
        transport,
        root_key,
        token,
        baseline_vv,
        from_cursor,
        &local,
        false,
    ) {
        Ok(p) => p,
        Err(PullError::CursorExpired) => {
            reconcile_ran = true;
            state.cursor = 0;
            write_sync_state(io, vault_root, state)
                .await
                .map_err(|_| SyncCycleError::Io)?;
            engine::pull_to_stable(transport, root_key, token, baseline_vv, 0, &local, true)
                .map_err(SyncCycleError::Pull)?
        }
        Err(e) => return Err(SyncCycleError::Pull(e)),
    };

    // --- reconcile the synced baseline (self-heal) ---
    // For every blob the server reports that we already hold locally, adopt the
    // server's (version, nonce) as our synced baseline IF we have none recorded.
    // A prior corrupted cycle (the chunked push-response parse bug) could leave
    // `state.blobs` empty even though the server already holds our blobs; without
    // this every locally-held blob re-pushes at base_version 0 and the server CAS
    // rejects it (409). `or_insert` never clobbers a baseline we already hold.
    for m in &page.all_metas {
        if local.contains_key(&m.id) {
            state
                .blobs
                .entry(hex(&m.id))
                .or_insert_with(|| BlobSyncState {
                    version: m.version,
                    content_nonce_hex: hex(&m.content_nonce),
                });
        }
    }

    // --- surface the verified head to the SAS *before* downloading note bodies ---
    // The join head-fingerprint (`sync_head_fingerprint` reads `vv_log.last()` off
    // disk) must not wait for the whole first-cycle content download: a fresh join's
    // empty local manifest flags every blob `changed`, so the download loop below is
    // O(account size). The head is already MAC-verified + rollback-checked inside
    // `pull_to_stable`, and the SAS is a head fingerprint independent of note bodies,
    // so record + persist it here. This does NOT advance the cursor (still
    // `page.next_cursor`, applied after the loop), so "advance cursor only on success"
    // holds — the same in-attempt checkpoint shape as the 410-recovery write above.
    // `vv_log` is consumed only by the SAS command (baseline VV comes from
    // `read_head_baseline`), so an early persist has no other side effect.
    if let Some(vh) = &page.head {
        let new_head_hex = hex(&vh.head_id);
        let already_current = state
            .vv_log
            .last()
            .map(|o| o.head_id_hex == new_head_hex)
            .unwrap_or(false);
        state.record_observation(&vh.head_id, &vh.head.version_vector);
        // Persist only when the head actually changed — `record_observation` dedups a
        // repeat of the latest observation, so this avoids a redundant disk write every
        // cycle for a device already sitting on the current head.
        if !already_current {
            write_sync_state(io, vault_root, state)
                .await
                .map_err(|_| SyncCycleError::Io)?;
        }
    }

    // --- catalog phase (MUST precede any attachment record — §11.4 rule 5) ---
    // The merged catalog is the resurrection guard: a tombstoned id is erased
    // locally instead of downloaded; an uncataloged id is deferred.
    let mut attachments_pulled = 0usize;
    let mut attachments_deleted = 0usize;
    let mut catalog_phase: Option<CatalogPhase> = None;
    if let Some(keys) = attachment_keys {
        let cid = cat_id.expect("cat_id set whenever attachment_keys is Some");
        let remote_cat_rec = page
            .all_metas
            .iter()
            .find(|m| m.id == cid && m.attachment_id.is_none());
        let phase = sync_catalog_phase(
            io,
            transport,
            token,
            root_key,
            &account_number_hash,
            vault_root,
            state,
            &cid,
            remote_cat_rec,
        )
        .await?;

        // --- attachment pull loop (catalog-guarded, server-wins) ---
        for c in page.changed.iter().filter(|c| c.attachment_id.is_some()) {
            let full_id = c.attachment_id.expect("filtered on is_some");
            if full_id[..16] != c.id {
                // Server inconsistency (echoed id doesn't match the record key)
                // — never act on it.
                continue;
            }
            let full_hex = hex(&full_id);
            let prefix_hex = hex(&c.id);
            match phase.merged.entries.get(&full_hex) {
                // No catalog entry yet — the catalog record hasn't reached us
                // (or its push is still in flight). Defer to a later cycle
                // rather than downloading blind (§11.4 rule 5).
                None => continue,
                Some(e) if e.is_tombstone() => {
                    // Remote deletion propagation: erase the local body (+ its
                    // MYE1 text cache) and adopt the tombstone record as the
                    // baseline so it is not re-processed every cycle.
                    let p = attachments_dir(vault_root).join(&full_hex);
                    if io.remove_file(&p).await.is_ok() {
                        attachments_deleted += 1;
                    }
                    att_scan.remove(&c.id); // keep the in-memory manifest current
                                            // Back through `text_cache::remove_extracted` (task 86). Task
                                            // 44 had to inline the unlink here because that helper went
                                            // async while this file was still synchronous; the file is
                                            // async now, so the duplicate is gone and the §9.15.4
                                            // crypto-erase parity has one implementation again.
                    let _ = crate::plugins::attachments::text_cache::remove_extracted(
                        io, vault_root, &full_id,
                    )
                    .await;
                    state.blobs.insert(
                        prefix_hex,
                        BlobSyncState {
                            version: c.version,
                            content_nonce_hex: hex(&c.content_nonce),
                        },
                    );
                }
                Some(live) => {
                    // Already holding the server's exact bytes? (nonce match)
                    // → just self-heal the baseline.
                    if att_scan.get(&c.id).map(|e| e.content_nonce) == Some(c.content_nonce) {
                        state.blobs.insert(
                            prefix_hex,
                            BlobSyncState {
                                version: c.version,
                                content_nonce_hex: hex(&c.content_nonce),
                            },
                        );
                        continue;
                    }
                    let Some(bytes) = download_attachment_backoff(transport, token, &full_id)
                        .map_err(SyncCycleError::Pull)?
                    else {
                        // Body absent or still uploading — defer, no baseline.
                        continue;
                    };
                    // Pre-decrypt manifest check (§4.2): the header nonce must
                    // be the one the record advertises.
                    if crate::attachment_nonce::read_mya1_content_nonce(&bytes)
                        != Some(c.content_nonce)
                    {
                        continue;
                    }
                    // Full whole-blob AEAD/CTX verification BEFORE the write —
                    // a range-reassembled body carries no integrity of its own.
                    if protocol::decode_attachment_blob(
                        &bytes,
                        &full_id,
                        live.content_type.as_bytes(),
                        keys.items_key,
                        keys.items_key_id,
                    )
                    .is_err()
                    {
                        continue;
                    }
                    let dir = attachments_dir(vault_root);
                    io.create_dir_all(&dir)
                        .await
                        .map_err(|_| SyncCycleError::Io)?;
                    // Server-wins on nonce mismatch (§4.2): a locally-held
                    // divergent ciphertext of the same content-addressed id is
                    // REPLACED — plaintext is identical by construction, and
                    // adopting the server bytes is what converges the fleet's
                    // manifests (dirty-skip would diverge them forever).
                    io.write(
                        &dir.join(&full_hex),
                        &bytes,
                        crate::vault_io::WriteOpts::default(),
                    )
                    .await
                    .map_err(|_| SyncCycleError::Io)?;
                    // The adopted bytes' nonce was verified against the record
                    // above — mirror the write into the in-memory manifest so
                    // the push-detect phase sees it as clean without a rescan.
                    att_scan.insert(
                        c.id,
                        AttachmentManifestEntry {
                            id: full_id,
                            sync_id: c.id,
                            content_nonce: c.content_nonce,
                        },
                    );
                    state.blobs.insert(
                        prefix_hex,
                        BlobSyncState {
                            version: c.version,
                            content_nonce_hex: hex(&c.content_nonce),
                        },
                    );
                    attachments_pulled += 1;
                }
            }
        }
        catalog_phase = Some(phase);
    }

    // --- prefs phase (MYND-478, §10.2.1) — unconditional, every cycle ---
    // Independent of the head/blob-manifest plane (like the catalog, the prefs
    // singleton is never head-committed); its dirty blob rides the push batch
    // below so the CAS/409 machinery covers it.
    let prefs_id = prefs_sync_id(root_key);
    let remote_prefs_rec = page
        .all_metas
        .iter()
        .find(|m| m.id == prefs_id && m.attachment_id.is_none());
    let prefs_phase = sync_prefs_phase(
        io,
        transport,
        token,
        root_key,
        &account_number_hash,
        vault_root,
        state,
        &prefs_id,
        remote_prefs_rec,
    )
    .await?;

    // --- themes phase (MYND-486) — unconditional, every cycle ---
    // Like the catalog + prefs singletons, `vault.themes` is never
    // head-committed; its dirty blob rides the push batch below so the CAS/409
    // machinery covers it. (`themes_id` is derived once per attempt, above.)
    let remote_themes_rec = page
        .all_metas
        .iter()
        .find(|m| m.id == themes_id && m.attachment_id.is_none());
    let themes_phase = sync_themes_phase(
        io,
        transport,
        token,
        root_key,
        &account_number_hash,
        vault_root,
        state,
        &themes_id,
        remote_themes_rec,
    )
    .await?;

    // --- apply remote changes: download + write each changed NOTE blob to disk ---
    //
    // Progress (phase3-web-client task 39) is opened over the NOTE records only —
    // the catalog, prefs and themes singletons were handled above, and counting
    // them would make the denominator drift from what the user watches appear in
    // the sidebar. `begin(0)` is a no-op, so an ordinary idle cycle with nothing
    // to pull does not register as a run.
    let note_record_count = page
        .changed
        .iter()
        .filter(|c| {
            c.attachment_id.is_none()
                && Some(c.id) != cat_id
                && c.id != prefs_id
                && c.id != themes_id
        })
        .count() as u32;
    super::progress::begin(note_record_count);
    let mut pulled = 0;
    let mut pull_skipped = 0usize;
    for c in &page.changed {
        // Attachment records were handled above; the catalog, prefs and themes
        // records are their phases' (never written as notes).
        if c.attachment_id.is_some()
            || Some(c.id) == cat_id
            || c.id == prefs_id
            || c.id == themes_id
        {
            continue;
        }
        // Skip a locally-dirty blob: our on-disk copy diverges from the synced
        // baseline, so this is an unpushed local edit (or a genuine conflict) and
        // downloading the server's copy would clobber it. The push phase below
        // sends it; a real concurrent edit surfaces later via keep-both. This
        // pre-download form is only the CHEAP FILTER (it reads the cycle-start
        // manifest); the authoritative re-check runs against the live disk
        // inside `apply_pulled_note_blob`'s lock.
        let baseline_nonce = state
            .blobs
            .get(&hex(&c.id))
            .map(|b| b.content_nonce_hex.clone());
        let local_nonce = local.get(&c.id).map(|n| hex(n));
        if baseline_nonce.is_some() && baseline_nonce != local_nonce {
            continue;
        }
        let bytes = match download_blob_backoff(transport, token, &c.id) {
            Ok(b) => b,
            // Per-blob unavailability (unknown id / horizon-GC reclaimed body,
            // §11.3): skip the record WITHOUT any local mutation — no write, no
            // baseline adoption — and keep the cycle alive. Against a pre-§11.3
            // server the reclaimed body arrives as an empty 200 instead; the
            // nonce guard below catches that shape the same way.
            Err(PullError::BlobNotFound | PullError::BlobReclaimed) => {
                pull_skipped += 1;
                continue;
            }
            Err(e) => return Err(SyncCycleError::Pull(e)),
        };
        // Validate BEFORE the write (§11.3): the downloaded header must carry
        // the exact `content_nonce` the pulled record advertised. Empty bytes
        // (a reclaimed body served as `""`), junk, and a nonce mismatch all
        // fail one check (`read_myn_content_nonce` → None for <header-size or
        // bad magic). On failure NOTHING is mutated: the live local copy stays
        // intact and the old baseline stays authoritative — the old behavior
        // (write unverified bytes, adopt the server baseline) is what made
        // this bug destroy live notes and self-seal.
        match crate::note_nonce::read_myn_content_nonce(&bytes) {
            Some(n) if n == c.content_nonce => {
                match apply_pulled_note_blob(
                    io,
                    notes_dir,
                    &c.id,
                    &bytes,
                    baseline_nonce.as_deref(),
                )
                .await?
                {
                    PulledNoteApply::Applied => {
                        // Mirror the write into the in-memory manifest for the
                        // push-detect phase (ONE scan per attempt).
                        notes_manifest.insert(c.id, n);
                        state.blobs.insert(
                            hex(&c.id),
                            BlobSyncState {
                                version: c.version,
                                content_nonce_hex: hex(&c.content_nonce),
                            },
                        );
                        pulled += 1;
                        // Counted at the WRITE, not at the download: the number
                        // the user watches is notes that exist locally, and a
                        // download that then failed to land would otherwise
                        // advance a bar for work that did not happen.
                        super::progress::advance();
                    }
                    // A local save landed between the cycle-start scan and this
                    // write — the note is an unpushed local edit now; the push
                    // phase (or keep-both) owns it. No write, no baseline move.
                    PulledNoteApply::SkippedDirty => {}
                    // The store is full (task 91). END the materialisation here
                    // rather than trying every remaining record against a store
                    // that cannot take them — each attempt is a round trip and a
                    // failed write, and the answer will not change within this
                    // cycle.
                    //
                    // `finish()` before the return so the progress readout does
                    // not sit "active" forever on a bar that stopped.
                    PulledNoteApply::StorageFull => {
                        super::progress::finish();
                        return Err(SyncCycleError::StorageFull);
                    }
                }
            }
            _ => {
                pull_skipped += 1;
            }
        }
    }
    // Close the progress run whatever the per-record outcomes were. A skipped or
    // deferred record still ends the run: leaving it "active" forever would show
    // a bar that never completes on a cycle that finished normally.
    super::progress::finish();

    // The head observation is already recorded + persisted before the download loop
    // above (so the join SAS surfaces without waiting for the full content download);
    // here we only advance the cursor, which must move after a successful download.
    // A skipped (unavailable/invalid) blob does NOT hold the cursor back — bounded
    // staleness, honestly counted in `pull_skipped`, is accepted over junk writes.
    state.cursor = page.next_cursor;

    // --- reconcile drop-leg (§11.2/§11.3) — only on a full-manifest walk ---
    // The reconcile walk's roster (`all_metas`, reclaimed records omitted by a
    // §11.3 server) is the authoritative live set: a previously-synced local
    // note absent from it was deleted AND horizon-GC-reclaimed remotely. The
    // 3-way classify (`reconcile_policy`) separates that from never-synced
    // local work; only the drop leg is acted on here — the download leg is
    // already `page.changed`, and keep-local-only notes push naturally below.
    // Drop = move to `quarantine/` (never destroy, never re-upload — pushing
    // the ghost would lose the reclaimed record's CAS and resurrect deleted
    // content). A staged keep-both conflict is never dropped.
    let mut dropped = 0usize;
    if reconcile_ran {
        let authoritative: HashMap<[u8; 16], [u8; 24]> = page
            .all_metas
            .iter()
            .filter(|m| m.attachment_id.is_none() && Some(m.id) != cat_id && m.id != prefs_id)
            .map(|m| (m.id, m.content_nonce))
            .collect();
        let previously_synced: HashSet<[u8; 16]> =
            state.blobs.keys().filter_map(|k| from_hex16(k)).collect();
        let staged: HashSet<String> = list_pending_conflicts(io, vault_root)
            .await
            .into_iter()
            .collect();
        let plan = super::reconcile_policy::plan_full_reconcile(
            super::reconcile_policy::ReconcileTrigger::CursorExpired,
            &authoritative,
            &notes_manifest,
            &previously_synced,
        );
        let mut dropped_hex: Vec<String> = Vec::new();
        for id in &plan.drop {
            let id_hex = hex(id);
            if staged.contains(&id_hex) {
                continue; // unresolved keep-both — never quarantine user work
            }
            quarantine_note(io, vault_root, notes_dir, id).await?;
            notes_manifest.remove(id);
            state.blobs.remove(&id_hex);
            dropped_hex.push(id_hex);
            dropped += 1;
        }
        // The ids are gone locally — their queued tombstone flags (if any) are moot.
        let _ = clear_pending_tombstones(io, vault_root, &dropped_hex).await;
    }

    // --- detect local changes to push (content_nonce ≠ last-synced) ---
    // Skipped on a poll-driven Pull (`allow_push=false`): pushes are coalesced
    // and fire only after the local-change window elapses (loop_control), so a
    // poll never opens a high-resolution edit-timing channel (resolution-blur).
    //
    // Reuses the maintained in-memory manifest (ONE scan per attempt).
    // Deliberate behavior shift: a note saved concurrently DURING this cycle no
    // longer catches this cycle's push — its `SyncLocalChange` bump already
    // opened the next coalescing window (and the old mid-cycle rescan could
    // push a scan-time nonce the re-read ciphertext no longer matched).
    let local2 = notes_manifest;
    // The server's current (version, nonce) for every blob it reported — used to
    // tell a clean local edit (server still at our base) from a true conflict
    // (server advanced this blob past our synced baseline).
    let server_meta: HashMap<[u8; 16], (u64, [u8; 24])> = page
        .all_metas
        .iter()
        .map(|m| (m.id, (m.version, m.content_nonce)))
        .collect();
    let pending_tombstones = read_pending_tombstones(io, vault_root).await;
    // Notes whose remote revision is already staged as an unresolved keep-both
    // conflict (`conflicts/<id>.myn`, awaiting materialization). Their synced
    // baseline is, by construction, behind the server — so pushing them would lose
    // the blob CAS (409 blob_stale) and wedge the whole atomic batch. They MUST stay
    // excluded until `resolve_conflict` adopts the remote as the baseline; only then
    // does the untouched local edit push as a clean linear advance. This also closes
    // the cursor-window gap: a conflict first detected while the blob was in the pull
    // window (`server_meta` below) stays excluded after the cursor advances past it,
    // instead of silently re-pushing the stale base_version. The durable staging dir
    // — not this transient summary — is the materialization source (the notes layer
    // reads it via `list_pending_conflicts`), so an excluded blob is NOT re-surfaced
    // in `conflicts` here (re-surfacing every cycle would re-materialize duplicates).
    let pending_conflicts: HashSet<String> = list_pending_conflicts(io, vault_root)
        .await
        .into_iter()
        .collect();
    let mut to_push: Vec<PushBlob> = Vec::new();
    let mut conflicts: Vec<ConflictCopyPlan> = Vec::new();
    if allow_push {
        for (id, nonce) in &local2 {
            let id_hex = hex(id);
            let nonce_hex = hex(nonce);
            let synced = state.blobs.get(&id_hex);
            if synced.map(|b| b.content_nonce_hex.as_str()) == Some(nonce_hex.as_str()) {
                continue; // already in sync
            }
            // Unresolved staged conflict (see above): never push, never re-stage.
            if pending_conflicts.contains(&id_hex) {
                continue;
            }
            // True conflict: this note is locally dirty AND the server advanced it
            // past our synced baseline (a concurrent remote edit). Pushing a stale
            // base_version loses the blob CAS (BlobStale) and — because the push is
            // one atomic batch — wedges every OTHER note too. Exclude it and record
            // a keep-both plan; the local edit stays on disk untouched (no loss).
            if let Some(b) = synced {
                if let Some((server_version, remote_nonce)) = server_meta.get(id) {
                    if *server_version > b.version {
                        // Stage the remote revision (download it once) so the notes
                        // layer can materialize a keep-both copy of it; the local
                        // edit stays on disk untouched. `resolve_conflict` later
                        // adopts this version as the baseline so the local edit then
                        // pushes as a clean linear advance.
                        if let Ok(remote_bytes) = download_blob_backoff(transport, token, id) {
                            let _ = stage_conflict(
                                io,
                                vault_root,
                                id,
                                *server_version,
                                remote_nonce,
                                &remote_bytes,
                            )
                            .await;
                        }
                        conflicts.push(plan_note_keep_both(id, *remote_nonce));
                        continue;
                    }
                }
            }
            // F4 fresh-cursor probe (§11.3): a re-enrolled device (wiped sync
            // state, cursor 0 → floor-exempt, no 410/reconcile) holding a local
            // copy of a RECLAIMED record would push it at `base_version 0` —
            // the CAS loses against the tombstone's final version and, because
            // the batch is atomic, wedges every push forever. Probe the blob
            // route first; 410 `blob_reclaimed` → quarantine + exclude. Gated
            // to baseline-less ids on cursor-0/reconcile cycles OF AN ACCOUNT
            // WITH HISTORY (`page.head` present — a virgin account cannot hold
            // reclaimed records, and its genesis bulk-push must not spend one
            // probe round-trip per seeded note). Steady-state pushes never pay
            // the extra round-trip. Fail-open: any other probe outcome (404 =
            // genuinely new note, errors) proceeds to push.
            if synced.is_none() && page.head.is_some() && (from_cursor == 0 || reconcile_ran) {
                if let Err(PullError::BlobReclaimed) = engine::download_blob(transport, token, id) {
                    quarantine_note(io, vault_root, notes_dir, id).await?;
                    state.blobs.remove(&id_hex);
                    let _ = clear_pending_tombstones(io, vault_root, &[id_hex]).await;
                    dropped += 1;
                    continue;
                }
            }
            let ciphertext = io
                .read(&blob_path(notes_dir, id))
                .await
                .map_err(|_| SyncCycleError::Io)?;
            to_push.push(PushBlob {
                id: *id,
                base_version: synced.map(|b| b.version).unwrap_or(0),
                content_nonce: *nonce,
                ciphertext,
                // A deletion the notes layer queued → flag it so the server marks
                // it for horizon-GC (the `deleted:` field still propagates either
                // way; the flag only governs server-side reclamation).
                tombstone: pending_tombstones.contains(&id_hex),
                attachment_id: None,
            });
        }
    }

    // --- detect attachment + catalog pushes (MYND-468) ---
    // Byte-uploads happen HERE, before the single `/sync/push` batch below, so
    // any head the server accepts only ever commits attachment bytes already
    // durably stored (SYNC-5 blobs-first-then-head, extended to attachments).
    let mut attachments_pushed = 0usize;
    let mut pushed_att_tombstones: HashSet<[u8; 32]> = HashSet::new();
    if allow_push {
        if let Some(_keys) = attachment_keys {
            let cid = cat_id.expect("cat_id set whenever attachment_keys is Some");
            // No post-pull rescan: the pull loop maintained `att_scan` in
            // memory (server-wins adoptions inserted with their verified nonce,
            // tombstone erasures removed), so an adopted id's nonce equals its
            // fresh baseline and no longer registers as dirty here.
            for (sid, entry) in &att_scan {
                let prefix_hex = hex(sid);
                let synced = state.blobs.get(&prefix_hex);
                if synced.map(|b| b.content_nonce_hex.as_str())
                    == Some(hex(&entry.content_nonce).as_str())
                {
                    continue; // already in sync
                }
                // The server advanced this id past our baseline concurrently —
                // never keep-both for an attachment (§4.2 server-wins): skip
                // the push (it would 409 the whole batch); the next pull
                // adopts the server's bytes.
                if let Some(b) = synced {
                    if let Some((server_version, _)) = server_meta.get(sid) {
                        if *server_version > b.version {
                            continue;
                        }
                    }
                }
                let bytes = io
                    .read(&attachments_dir(vault_root).join(hex(&entry.id)))
                    .await
                    .map_err(|_| SyncCycleError::Io)?;
                upload_attachment_backoff(transport, token, &entry.id, &bytes)
                    .map_err(SyncCycleError::Push)?;
                attachments_pushed += 1;
                to_push.push(PushBlob {
                    id: *sid,
                    base_version: synced.map(|b| b.version).unwrap_or(0),
                    content_nonce: entry.content_nonce,
                    ciphertext: Vec::new(), // bytes travelled over /attachments
                    tombstone: false,
                    attachment_id: Some(entry.id),
                });
            }

            // Queued attachment deletions → §11.4 tombstone records. A queued
            // id that is live again (re-added locally, or revived by the
            // catalog merge) is a STALE tombstone — dropped, never pushed.
            let merged = catalog_phase
                .as_ref()
                .map(|p| &p.merged)
                .expect("catalog phase ran whenever attachment_keys is Some");
            let mut stale: HashSet<[u8; 32]> = HashSet::new();
            for t in read_pending_attachment_tombstones(io, vault_root).await {
                let live_again = merged
                    .entries
                    .get(&hex(&t.id))
                    .map(|e| !e.is_tombstone())
                    .unwrap_or(false);
                if live_again || att_scan.contains_key(&t.sync_id) {
                    stale.insert(t.id);
                    continue;
                }
                let base = state
                    .blobs
                    .get(&hex(&t.sync_id))
                    .map(|b| b.version)
                    .unwrap_or(0);
                to_push.push(PushBlob {
                    id: t.sync_id,
                    base_version: base,
                    content_nonce: t.content_nonce,
                    ciphertext: Vec::new(),
                    tombstone: true,
                    attachment_id: Some(t.id),
                });
                pushed_att_tombstones.insert(t.id);
            }
            let _ = clear_pending_attachment_tombstones(io, vault_root, &stale).await;

            // A dirty catalog (local-only change, or a merge that beat the
            // server's plaintext) rides the same batch as an inline blob.
            if catalog_phase.as_ref().map(|p| p.dirty).unwrap_or(false) {
                if let Ok(bytes) = io.read(&catalog_file_path(vault_root)).await {
                    if let Some(nonce) = read_catalog_nonce(&bytes) {
                        let base = state.blobs.get(&hex(&cid)).map(|b| b.version).unwrap_or(0);
                        to_push.push(PushBlob {
                            id: cid,
                            base_version: base,
                            content_nonce: nonce,
                            ciphertext: bytes,
                            tombstone: false,
                            attachment_id: None,
                        });
                    }
                }
            }
        }

        // A dirty prefs blob (shared-subset change, a merge that beat the
        // server's plaintext, or the §10.2.1 initial publish) rides the same
        // batch as an inline blob (MYND-478).
        if prefs_phase.dirty {
            if let Ok(bytes) = io.read(&vault_root.join("vault.prefs")).await {
                if let Some(nonce) = read_prefs_nonce(&bytes) {
                    let base = state
                        .blobs
                        .get(&hex(&prefs_id))
                        .map(|b| b.version)
                        .unwrap_or(0);
                    to_push.push(PushBlob {
                        id: prefs_id,
                        base_version: base,
                        content_nonce: nonce,
                        ciphertext: bytes,
                        tombstone: false,
                        attachment_id: None,
                    });
                }
            }
        }

        // A dirty themes blob (local-only change, or a merge that beat the
        // server's store) rides the same batch as an inline blob (MYND-486).
        if themes_phase.dirty {
            if let Ok(bytes) = io.read(&themes_file_path(vault_root)).await {
                if let Some(nonce) = read_themes_nonce(&bytes) {
                    let base = state
                        .blobs
                        .get(&hex(&themes_id))
                        .map(|b| b.version)
                        .unwrap_or(0);
                    to_push.push(PushBlob {
                        id: themes_id,
                        base_version: base,
                        content_nonce: nonce,
                        ciphertext: bytes,
                        tombstone: false,
                        attachment_id: None,
                    });
                }
            }
        }
    }

    let mut pushed = 0;
    let mut head_advanced = false;
    let mut tombstones_pushed = 0;

    // Author a head when there are local changes to push, OR — genesis liveness — when
    // this is a push cycle and the account has NO server head yet (an empty vault whose
    // welcome-note seed never landed). Without the second clause a zero-note account
    // never authors a head, so a joining device's pull returns `page.head = None`
    // forever and its SAS (which needs an adopted head) never appears. `allow_push`
    // keeps poll cycles push-free (resolution-blur); `page.head.is_none()` fires the
    // genesis exactly once — once a head exists, the empty-`to_push` case adopts it via
    // the `else` branch below. `compute_manifest_hash` over the empty manifest and a
    // head-only push (empty `to_push`) are both well-defined; the server accepts a
    // head-only push (blobs `[]` + `new_head`).
    // The `manifest_hash` of the head this cycle ends on, when the cycle authored
    // one. `None` means "the pulled head is still current" — see the corpus block
    // below, which is the only reader.
    let mut final_head_manifest_hash: Option<[u8; 32]> = None;
    if !to_push.is_empty() || (allow_push && page.head.is_none()) {
        // Author a linear-advance head over the current (post-pull) head: bump
        // this device's VV component, seq+1, parent = the server's current head
        // (genesis = the zero prev the server's first-head CAS expects).
        let prev_head_id: [u8; 32] = page.head.as_ref().map(|h| h.head_id).unwrap_or([0u8; 32]);
        let base_vv: Vec<VvEntry> = page
            .head
            .as_ref()
            .map(|h| h.head.version_vector.clone())
            .unwrap_or_else(|| baseline_vv.to_vec());
        let mut vv_map: HashMap<[u8; 16], u64> =
            base_vv.iter().map(|e| (e.device_id, e.counter)).collect();
        *vv_map.entry(device_id).or_insert(0) += 1;
        let version_vector: Vec<VvEntry> = vv_map
            .into_iter()
            .map(|(device_id, counter)| VvEntry { device_id, counter })
            .collect();
        let seq = page
            .head
            .as_ref()
            .map(|h| h.head.seq)
            .unwrap_or(baseline_seq)
            + 1;
        let prev_head_hash = if page.head.is_some() {
            vec![prev_head_id]
        } else {
            Vec::new()
        };
        // The head manifest covers content blobs — notes ∪ live attachments
        // (§4.2). The catalog singleton is deliberately outside it, and a
        // tombstoned attachment has already left the maintained manifest.
        let mut manifest_map = local2.clone();
        for (sid, e) in &att_scan {
            manifest_map.insert(*sid, e.content_nonce);
        }
        let manifest_hash = compute_manifest_hash(&manifest_entries(&manifest_map))
            .map_err(|_| SyncCycleError::Head)?;
        final_head_manifest_hash = Some(manifest_hash);
        let head = VaultHead {
            head_format_version: VAULT_HEAD_FORMAT_V1,
            account_number_hash,
            manifest_hash,
            seq,
            prev_head_hash,
            version_vector: version_vector.clone(),
        };
        let sealed = head.seal(root_key).map_err(|_| SyncCycleError::Head)?;

        let outcome = engine::push(
            transport,
            token,
            &to_push,
            Some((&prev_head_id, &sealed.record)),
        )
        .map_err(SyncCycleError::Push)?;

        for (id, ver) in &outcome.results {
            if let Some(b) = to_push.iter().find(|b| &b.id == id) {
                state.blobs.insert(
                    hex(id),
                    BlobSyncState {
                        version: *ver,
                        content_nonce_hex: hex(&b.content_nonce),
                    },
                );
            }
        }
        pushed = outcome.results.len();
        head_advanced = outcome.head_id.is_some();
        // The prefs push landed → its shared-subset hash is the new push-gate
        // baseline (MYND-478, §10.2.1).
        if outcome.results.iter().any(|(id, _)| *id == prefs_id) {
            set_prefs_gate_baseline(vault_root, prefs_phase.shared_hash.clone());
        }
        // The queued tombstones are now flagged on the server → drop them from the
        // device-local queue so they aren't re-flagged every cycle.
        let pushed_tombstones: Vec<String> = to_push
            .iter()
            .filter(|b| b.tombstone)
            .map(|b| hex(&b.id))
            .collect();
        tombstones_pushed = pushed_tombstones.len();
        let _ = clear_pending_tombstones(io, vault_root, &pushed_tombstones).await;
        // The attachment-tombstone queue drains only after its records landed.
        let _ = clear_pending_attachment_tombstones(io, vault_root, &pushed_att_tombstones).await;
        write_head_baseline(io, vault_root, &sealed)
            .await
            .map_err(|_| SyncCycleError::Io)?;
        state.record_observation(&sealed.head_id, &version_vector);
    } else if let Some(vh) = &page.head {
        // No local changes: adopt the pulled head as the new baseline (re-seal
        // the decoded head — deterministic, reproduces the same record/head_id).
        let sealed = vh.head.seal(root_key).map_err(|_| SyncCycleError::Head)?;
        write_head_baseline(io, vault_root, &sealed)
            .await
            .map_err(|_| SyncCycleError::Io)?;
    }

    // --- corpus completeness (phase3-web-client task 89) ---
    //
    // "Do I hold every content blob this account has?", answered EXACTLY rather
    // than approximated: the vault head commits `manifest_hash` over notes ∪ live
    // attachments (§4.2), the head is MAC-verified before anything reads it, and
    // the local manifest is already assembled above. So the comparison costs one
    // hash and states the property outright.
    //
    // It gates ONE thing — `attachment_clean_unused`, whose "unused" set is
    // computed by scanning the local notes directory and is therefore wrong by
    // exactly the notes a mid-materialisation device does not have yet. See
    // `super::corpus` for why every cheaper signal is an approximation.
    //
    // **Recomputed every cycle, and cleared as readily as it is set.** A device
    // that was complete and then fell behind must not keep a stale `true`: the
    // flag's only job is to authorise an irreversible cross-device erase, so it
    // has to describe THIS cycle's end state.
    //
    // No head at all (a virgin account before its genesis push) reads as
    // incomplete — there is nothing to compare against, and "I could not check"
    // must not authorise the sweep.
    {
        let mut local_content = local2.clone();
        for (sid, e) in &att_scan {
            local_content.insert(*sid, e.content_nonce);
        }
        let local_hash = compute_manifest_hash(&manifest_entries(&local_content)).ok();
        // The head this cycle ENDS on: the one it just authored, else the one it
        // pulled. Reading the pre-push head after a push would compare against a
        // manifest this device has already moved past.
        let head_hash =
            final_head_manifest_hash.or_else(|| page.head.as_ref().map(|h| h.head.manifest_hash));
        state.corpus_complete = match (local_hash, head_hash) {
            (Some(local), Some(remote)) => local == remote,
            _ => false,
        };
    }

    // NOTE: `sync-state.json` is persisted by `run_sync_cycle` on success only (so a
    // failed 409 retry never leaves a half-advanced cursor on disk). The 410-recovery
    // branch above is the one in-attempt write — a deliberate checkpoint of `cursor=0`.
    Ok(SyncSummary {
        pulled,
        pushed,
        head_advanced,
        cursor: state.cursor,
        conflicts,
        tombstones_pushed,
        reconcile_ran,
        attachments_pulled,
        attachments_pushed,
        attachments_deleted,
        // Set by the caller after the meta phase runs — the meta phase is
        // deliberately outside the 409-retry loop this summary is built in.
        credential_ambiguous: false,
        prefs_applied_remote: prefs_phase.applied_remote,
        themes_applied_remote: themes_phase.applied_remote,
        pull_skipped,
        dropped,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::notes::note_id::NoteId;
    use crate::plugins::sync::enroll::{self, EnrollPath};
    use crate::plugins::sync::transport::{HttpMethod, TransportError, TransportResponse};
    use protocol::{decode_note, encode_new_note};
    use std::path::PathBuf;
    use std::process::Child;

    // ── the storage seam, filled in for this module's tests ─────────────────
    //
    // Task 86 made `run_sync_cycle`, `sync_meta_phase`, `resolve_conflict` and
    // every sidecar reader/writer take `io: &dyn VaultIo` and become `async`
    // (the seam is async because OPFS handle acquisition is). The shims below
    // shadow them with the OLD synchronous signatures and supply the real
    // `StdVaultIo`, so ~150 call sites across these scenarios read unchanged.
    //
    // Shims, not fakes: each drives the production function against a real temp
    // vault. A stub `VaultIo` would only have proved the signatures compile —
    // and these are the tests that pin the CAS, cursor and conflict behaviour.
    const IO: crate::vault_io::StdVaultIo = crate::vault_io::StdVaultIo;

    fn blocking<F: std::future::Future>(f: F) -> F::Output {
        crate::test_support::block_on(f)
    }

    // The seam-taking helpers, shadowed with their pre-task-86 signatures so the
    // scenarios below read unchanged.
    fn list_pending_conflicts(vault_root: &Path) -> Vec<String> {
        blocking(super::list_pending_conflicts(&IO, vault_root))
    }
    #[allow(dead_code)]
    fn read_staged_conflict_blob(vault_root: &Path, id_hex: &str) -> Option<Vec<u8>> {
        blocking(super::read_staged_conflict_blob(&IO, vault_root, id_hex))
    }
    fn add_pending_tombstone(vault_root: &Path, id_hex: &str) -> Result<(), SyncCycleError> {
        blocking(super::add_pending_tombstone(&IO, vault_root, id_hex))
    }
    #[allow(dead_code)]
    fn add_pending_attachment_tombstone(
        vault_root: &Path,
        id: &[u8; 32],
    ) -> Result<(), SyncCycleError> {
        blocking(super::add_pending_attachment_tombstone(&IO, vault_root, id))
    }
    fn read_pending_tombstones(vault_root: &Path) -> std::collections::HashSet<String> {
        blocking(super::read_pending_tombstones(&IO, vault_root))
    }
    #[allow(dead_code)]
    fn write_pending_tombstones(
        vault_root: &Path,
        set: &std::collections::HashSet<String>,
    ) -> Result<(), SyncCycleError> {
        blocking(super::write_pending_tombstones(&IO, vault_root, set))
    }
    fn read_pending_attachment_tombstones(vault_root: &Path) -> Vec<PendingAttachmentTombstone> {
        blocking(super::read_pending_attachment_tombstones(&IO, vault_root))
    }
    #[allow(dead_code)]
    fn stage_conflict(
        vault_root: &Path,
        id: &[u8; 16],
        server_version: u64,
        remote_nonce: &[u8; 24],
        ciphertext: &[u8],
    ) -> Result<(), SyncCycleError> {
        blocking(super::stage_conflict(
            &IO,
            vault_root,
            id,
            server_version,
            remote_nonce,
            ciphertext,
        ))
    }
    #[allow(dead_code)]
    fn quarantine_note(
        vault_root: &Path,
        notes_dir: &Path,
        id: &[u8; 16],
    ) -> Result<(), SyncCycleError> {
        blocking(super::quarantine_note(&IO, vault_root, notes_dir, id))
    }

    fn read_sync_state(dir: &Path) -> Result<SyncState, super::super::config::SyncConfigError> {
        blocking(super::read_sync_state(&IO, dir))
    }
    fn write_sync_state(
        dir: &Path,
        state: &SyncState,
    ) -> Result<(), super::super::config::SyncConfigError> {
        blocking(super::write_sync_state(&IO, dir, state))
    }
    #[allow(dead_code)]
    fn resolve_conflict(vault_root: &Path, id_hex: &str) -> Result<(), SyncCycleError> {
        blocking(super::resolve_conflict(&IO, vault_root, id_hex))
    }

    /// The pre-MYND-468 cycle shape — a note-only cycle (no attachment keys).
    /// The existing note-sync scenarios pin note behavior in isolation;
    /// attachment-aware scenarios call `run_sync_cycle` with `Some(keys)`.
    #[allow(clippy::too_many_arguments)]
    fn run_cycle_legacy(
        transport: &dyn SyncTransport,
        root_key: &[u8; 32],
        account_number_hash: [u8; 16],
        device_id: [u8; 16],
        token: &str,
        notes_dir: &Path,
        vault_root: &Path,
        allow_push: bool,
    ) -> Result<SyncSummary, SyncCycleError> {
        blocking(run_sync_cycle(
            &IO,
            transport,
            root_key,
            account_number_hash,
            device_id,
            token,
            notes_dir,
            vault_root,
            allow_push,
            None,
        ))
    }

    /// A transport that relays everything to a wrapped real transport EXCEPT it
    /// fails every `/sync/blob` download with a 500, so the note-body download loop
    /// cannot complete. Used to prove the join SAS head observation is recorded +
    /// persisted before that loop (`join_head_fingerprint_persists_before_blob_download`).
    struct FailBlobTransport {
        inner: Box<dyn SyncTransport>,
    }
    impl SyncTransport for FailBlobTransport {
        fn request(
            &self,
            method: HttpMethod,
            path: &str,
            body: &[u8],
            token: Option<&str>,
        ) -> Result<TransportResponse, TransportError> {
            if path.starts_with("/sync/blob") {
                return Ok(TransportResponse {
                    status: 500,
                    body: Vec::new(),
                });
            }
            self.inner.request(method, path, body, token)
        }
    }

    /// Kills the spawned server on drop (so a panicking assert doesn't leak it).
    struct ServerGuard(Child);
    impl Drop for ServerGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// Resolve the `myne-server` binary (env override, else the built sibling).
    /// `None` → the binary isn't built; the caller self-skips (the E2E pattern).
    fn server_binary() -> Option<PathBuf> {
        if let Ok(p) = std::env::var("MYNE_E2E_SERVER") {
            let p = PathBuf::from(p);
            return p.exists().then_some(p);
        }
        // cargo test CWD = the crate dir (src-tauri/); the server is a sibling.
        let p = PathBuf::from("../myne-server/myne-server");
        p.exists().then_some(p)
    }

    /// Spawn an ephemeral in-memory server; return (guard, base_url). The
    /// portfile dir is unique per call (process id + a counter) so concurrent
    /// tests in the same process don't race on a shared portfile.
    fn spawn_server() -> Option<(ServerGuard, String)> {
        // Integration tests exercise sync correctness, not abuse throttling — lift
        // the per-account rate limit so a multi-hundred-blob cycle isn't confounded
        // by 429s. The rate-limit backoff test overrides with a low burst.
        spawn_server_env("1000000", "1000000")
    }

    fn spawn_server_env(burst: &str, refill: &str) -> Option<(ServerGuard, String)> {
        use std::sync::atomic::{AtomicU64, Ordering};
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let bin = server_binary()?;
        let dir = std::env::temp_dir().join(format!(
            "myne-orch-test-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).ok()?;
        let portfile = dir.join("port");
        let _ = std::fs::remove_file(&portfile);
        let child = std::process::Command::new(&bin)
            .env("MYNE_SERVER_ADDR", "127.0.0.1:0")
            .env("MYNE_SERVER_PORTFILE", &portfile)
            .env("MYNE_RATELIMIT_BURST", burst)
            .env("MYNE_RATELIMIT_REFILL", refill)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .ok()?;
        let guard = ServerGuard(child);
        // Read the OS-assigned port back race-free from the portfile.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        let mut port = 0u16;
        while std::time::Instant::now() < deadline {
            if let Ok(s) = std::fs::read_to_string(&portfile) {
                if let Ok(p) = s.trim().parse::<u16>() {
                    if p > 0 {
                        port = p;
                        break;
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        if port == 0 {
            return None;
        }
        // Wait until the listener actually accepts.
        while std::time::Instant::now() < deadline {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        Some((guard, format!("http://127.0.0.1:{port}")))
    }

    fn hex32(b: &[u8]) -> String {
        let mut s = String::with_capacity(b.len() * 2);
        for x in b {
            s.push_str(&format!("{x:02x}"));
        }
        s
    }

    /// End-to-end proof: device A authors a note, pushes it through a real
    /// `myne-server` over loopback http, device B pulls it and it lands on B's
    /// disk decrypting to the same plaintext. Self-skips if the server binary
    /// isn't built (CI without the companion binary).
    #[test]
    fn two_devices_replicate_a_note() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!(
                "SKIP two_devices_replicate_a_note: myne-server binary not found \
                 (build: cd myne-server && go build -o myne-server ./cmd/myne-server, \
                 or set MYNE_E2E_SERVER)"
            );
            return;
        };

        // --- shared account crypto (both devices share root_key + items_key) ---
        let root_key = [0x42u8; 32];
        let account_hash = [0x7Au8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0x11u8; 32];
        let items_key_id = [0x22u8; 16];

        // Device A authors a real .myn note in its vault.
        let dir_a = std::env::temp_dir().join(format!("myne-orch-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-orch-B-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();

        let note = NoteId::new_v7();
        let note_bytes = *note.as_uuid().as_bytes();
        let plaintext = b"hello from device A";
        let blob = encode_new_note(&items_key, &items_key_id, &note_bytes, plaintext).unwrap();
        crate::atomic_write::atomic_write(
            &notes_a.join(format!("{}.myn", note.as_uuid())),
            &blob,
            false,
        )
        .unwrap();

        let ta = crate::plugins::sync::http_transport::build_transport(&url, Vec::new()).unwrap();
        let tb = crate::plugins::sync::http_transport::build_transport(&url, Vec::new()).unwrap();

        // Register the SCRAM verifier (idempotent) then enroll both devices.
        enroll::register_verifier(ta.as_ref(), &account_hash, secret.as_slice()).unwrap();

        let dev_a = enroll::generate_device_id();
        let out_a = enroll::enroll(
            ta.as_ref(),
            &account_hash,
            secret.as_slice(),
            EnrollPath::Recovery,
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            dev_a,
        )
        .unwrap();
        assert!(
            out_a.approved && !out_a.token.is_empty(),
            "device A enrolled"
        );
        let tok_a = hex32(&out_a.token);

        let dev_b = enroll::generate_device_id();
        let out_b = enroll::enroll(
            tb.as_ref(),
            &account_hash,
            secret.as_slice(),
            EnrollPath::Recovery,
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            dev_b,
        )
        .unwrap();
        assert!(
            out_b.approved && !out_b.token.is_empty(),
            "device B enrolled"
        );
        let tok_b = hex32(&out_b.token);

        // --- A pushes; B pulls ---
        let push = run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A sync cycle");
        assert_eq!(push.pushed, 1, "A pushed the note");
        assert!(push.head_advanced, "A advanced the head");

        let pull = run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B sync cycle");
        assert_eq!(pull.pulled, 1, "B pulled the note");

        // --- B's disk has the note, decrypting to the same plaintext ---
        let b_path = notes_b.join(format!("{}.myn", note.as_uuid()));
        assert!(b_path.exists(), "note materialized on device B");
        let b_blob = std::fs::read(&b_path).unwrap();
        let decrypted = decode_note(&b_blob, &note_bytes, &items_key, &items_key_id).unwrap();
        assert_eq!(
            decrypted.plaintext(),
            plaintext,
            "B decrypts A's note to the same plaintext"
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    /// A transport that relays to a real server but swaps every `/sync/blob`
    /// ciphertext for a decoy blob whose header nonce does NOT match the wire
    /// record — the hostile/buggy-server shape the §11.3 pre-write nonce guard
    /// exists for.
    struct NonceCorruptingTransport {
        inner: Box<dyn SyncTransport>,
        decoy_b64: String,
    }
    impl SyncTransport for NonceCorruptingTransport {
        fn request(
            &self,
            method: HttpMethod,
            path: &str,
            body: &[u8],
            token: Option<&str>,
        ) -> Result<TransportResponse, TransportError> {
            let resp = self.inner.request(method, path, body, token)?;
            if !path.starts_with("/sync/blob") || resp.status != 200 {
                return Ok(resp);
            }
            let mut v: serde_json::Value =
                serde_json::from_slice(&resp.body).expect("blob response is JSON");
            v["ciphertext_b64"] = serde_json::Value::String(self.decoy_b64.clone());
            Ok(TransportResponse {
                status: 200,
                body: serde_json::to_vec(&v).unwrap(),
            })
        }
    }

    /// §11.3 pre-write nonce guard: bytes whose header nonce disagrees with the
    /// wire record are NEVER written and NEVER adopted as a baseline — the
    /// record is skipped (counted in `pull_skipped`) and the cycle completes.
    /// Pre-guard, the corrupt bytes were written + the server baseline adopted,
    /// which is exactly the shape that let a reclaimed empty body destroy a
    /// live local note and self-seal. The discriminating assertions: nothing on
    /// disk, `pulled == 0`, `pull_skipped == 1`, no wedge.
    #[test]
    fn corrupt_blob_nonce_is_skipped_never_written() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP corrupt_blob_nonce_forces_manifest_rescan: myne-server not built");
            return;
        };

        let root_key = [0x42u8; 32];
        let account_hash = [0x5Cu8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0x11u8; 32];
        let items_key_id = [0x22u8; 16];

        let dir_a = std::env::temp_dir().join(format!("myne-orch-nonceA-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-orch-nonceB-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();

        let note = NoteId::new_v7();
        let note_bytes = *note.as_uuid().as_bytes();
        let blob = encode_new_note(&items_key, &items_key_id, &note_bytes, b"real body").unwrap();
        crate::atomic_write::atomic_write(
            &notes_a.join(format!("{}.myn", note.as_uuid())),
            &blob,
            false,
        )
        .unwrap();

        // The decoy: a valid MY01 blob for a DIFFERENT note id — its header
        // nonce cannot match the record the server advertises for `note`.
        let decoy_id = NoteId::new_v7();
        let decoy = encode_new_note(
            &items_key,
            &items_key_id,
            decoy_id.as_uuid().as_bytes(),
            b"decoy",
        )
        .unwrap();
        use base64::Engine as _;
        let decoy_b64 = base64::engine::general_purpose::STANDARD.encode(&decoy);

        let ta = crate::plugins::sync::http_transport::build_transport(&url, Vec::new()).unwrap();
        enroll::register_verifier(ta.as_ref(), &account_hash, secret.as_slice()).unwrap();

        let dev_a = enroll::generate_device_id();
        let out_a = enroll::enroll(
            ta.as_ref(),
            &account_hash,
            secret.as_slice(),
            EnrollPath::Recovery,
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            dev_a,
        )
        .unwrap();
        let tok_a = hex32(&out_a.token);

        let tb = NonceCorruptingTransport {
            inner: crate::plugins::sync::http_transport::build_transport(&url, Vec::new()).unwrap(),
            decoy_b64,
        };
        let dev_b = enroll::generate_device_id();
        let out_b = enroll::enroll(
            &tb,
            &account_hash,
            secret.as_slice(),
            EnrollPath::Recovery,
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            dev_b,
        )
        .unwrap();
        let tok_b = hex32(&out_b.token);

        let push = run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A sync cycle");
        assert_eq!(push.pushed, 1);

        // B pulls the corrupted body. The cycle must complete (no wedge) and
        // must NOT write the mismatching bytes or adopt the server baseline —
        // the record is skipped, honestly counted.
        let pull = run_cycle_legacy(
            &tb,
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B sync cycle survives a nonce-corrupted download");
        assert_eq!(
            pull.pulled, 0,
            "mismatching bytes are never counted as pulled"
        );
        assert_eq!(pull.pull_skipped, 1, "the skip is honestly counted");
        assert_eq!(pull.pushed, 0, "nothing local to push — no phantom re-push");
        assert!(
            !notes_b.join(format!("{}.myn", note.as_uuid())).exists(),
            "corrupt served bytes must never reach disk"
        );
        // No baseline adoption → after a cursor reset (the reconcile/fresh-walk
        // shape) an HONEST transport still sees the note as changed and
        // materializes it correctly. (The incremental cursor advanced past the
        // record on the corrupt cycle — bounded staleness by design — so the
        // self-heal is proven via the walk-from-0 path.)
        let mut st_b = read_sync_state(&dir_b).unwrap();
        assert!(
            !st_b.blobs.contains_key(&hex(note.as_uuid().as_bytes())),
            "the corrupt record's baseline was never adopted"
        );
        st_b.cursor = 0;
        write_sync_state(&dir_b, &st_b).unwrap();
        let heal = run_cycle_legacy(
            crate::plugins::sync::http_transport::build_transport(&url, Vec::new())
                .unwrap()
                .as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B heals against an honest transport");
        assert_eq!(
            heal.pulled, 1,
            "self-heals once the server serves real bytes"
        );
        let on_disk = std::fs::read(notes_b.join(format!("{}.myn", note.as_uuid()))).unwrap();
        assert_eq!(on_disk, blob, "disk holds the REAL bytes after the heal");

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    // ── §11.3 reclaimed-blob pipeline (Guard A + drop-leg + F4 probe) ──────
    // These run against the in-process FakeTransport — no server binary needed.

    use crate::plugins::sync::transport::FakeTransport;

    fn meta_json(id: &[u8; 16], version: u64, nonce: &[u8; 24]) -> String {
        format!(
            "{{\"uuid_hex\":\"{}\",\"version\":{version},\"content_nonce_hex\":\"{}\",\"size\":1}}",
            hex(id),
            hex(nonce)
        )
    }

    fn pull_body(metas_json: &str, next_cursor: u64) -> Vec<u8> {
        format!("{{\"metas\":[{metas_json}],\"next_cursor\":{next_cursor}}}").into_bytes()
    }

    fn fresh_vault(tag: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("myne-orch-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let notes = dir.join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        (dir, notes)
    }

    /// A valid v7 note id as the 16 raw bytes (files named off non-v7 ids are
    /// skipped by `enumerate_notes_dir`, so on-disk fixtures must use these).
    fn v7_id() -> [u8; 16] {
        *NoteId::new_v7().as_uuid().as_bytes()
    }

    /// A sealed head fragment (`record_b64`, `head_id_hex`) another device
    /// might have authored — makes the canned pull carry verifiable history
    /// (the F4 probe is gated on `page.head.is_some()`).
    fn sealed_head_fragment(
        root_key: &[u8; 32],
        account_number_hash: [u8; 16],
    ) -> (String, String) {
        use base64::Engine as _;
        let head = VaultHead {
            head_format_version: VAULT_HEAD_FORMAT_V1,
            account_number_hash,
            manifest_hash: [0u8; 32],
            seq: 1,
            prev_head_hash: Vec::new(),
            version_vector: vec![VvEntry {
                device_id: [0x99; 16],
                counter: 1,
            }],
        };
        let sealed = head.seal(root_key).unwrap();
        (
            base64::engine::general_purpose::STANDARD.encode(&sealed.record),
            hex(&sealed.head_id),
        )
    }

    fn pull_body_with_head(metas_json: &str, next_cursor: u64, head: &(String, String)) -> Vec<u8> {
        format!(
            "{{\"metas\":[{metas_json}],\"next_cursor\":{next_cursor},\"head\":{{\"record_b64\":\"{}\",\"head_id_hex\":\"{}\"}}}}",
            head.0, head.1
        )
        .into_bytes()
    }

    /// Guard A, fresh-join shape: a reclaimed record served as an empty 200
    /// (pre-§11.3 server) must be skipped — no 0-byte junk file, no baseline
    /// adoption, cycle completes with the skip honestly counted.
    #[test]
    fn empty_ciphertext_download_is_skipped_not_written() {
        let (dir, notes) = fresh_vault("emptyct");
        let id = [0x01u8; 16];
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            200,
            pull_body(&meta_json(&id, 3, &[0xaa; 24]), 1),
        );
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=1",
            200,
            pull_body("", 1),
        );
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(&id)),
            200,
            b"{\"ciphertext_b64\":\"\"}".to_vec(),
        );

        let s = run_cycle_legacy(
            &t,
            &[0x42; 32],
            [0x5c; 16],
            [0x0a; 16],
            "tok",
            &notes,
            &dir,
            false,
        )
        .expect("cycle survives the empty body");
        assert_eq!(s.pulled, 0, "an empty body is never counted as pulled");
        assert_eq!(s.pull_skipped, 1);
        assert!(
            !blob_path(&notes, &id).exists(),
            "no 0-byte junk file may be written"
        );
        let st = read_sync_state(&dir).unwrap();
        assert!(
            !st.blobs.contains_key(&hex(&id)),
            "the tombstone baseline must NOT be adopted (adoption is what made the bug self-seal)"
        );
        assert_eq!(
            st.cursor, 1,
            "the cursor still advances (bounded staleness)"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Guard A, the headline data-loss repro: a CLEAN live local note whose
    /// server record was reclaimed (served empty) must survive byte-identical.
    /// Pre-guard, the empty bytes overwrote it and the adopted baseline sealed
    /// the destruction.
    #[test]
    fn junk_download_never_overwrites_live_note() {
        let (dir, notes) = fresh_vault("junkct");
        let id = v7_id();
        let items_key = [0x11u8; 32];
        let items_key_id = [0x22u8; 16];
        let blob = encode_new_note(&items_key, &items_key_id, &id, b"precious body").unwrap();
        let disk_nonce = crate::note_nonce::read_myn_content_nonce(&blob).unwrap();
        crate::atomic_write::atomic_write(&blob_path(&notes, &id), &blob, false).unwrap();
        // Clean baseline: state matches disk (an in-sync note, dirty-skip must NOT fire).
        let mut st = SyncState::default();
        st.blobs.insert(
            hex(&id),
            BlobSyncState {
                version: 1,
                content_nonce_hex: hex(&disk_nonce),
            },
        );
        write_sync_state(&dir, &st).unwrap();

        let t = FakeTransport::new();
        // The server advanced the record (tombstone version, different nonce)…
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            200,
            pull_body(&meta_json(&id, 2, &[0xbb; 24]), 1),
        );
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=1",
            200,
            pull_body("", 1),
        );
        // …but the body is gone (reclaimed → empty 200 on an old server).
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(&id)),
            200,
            b"{\"ciphertext_b64\":\"\"}".to_vec(),
        );

        let s = run_cycle_legacy(
            &t,
            &[0x42; 32],
            [0x5c; 16],
            [0x0a; 16],
            "tok",
            &notes,
            &dir,
            false,
        )
        .expect("cycle survives");
        assert_eq!(s.pull_skipped, 1);
        let on_disk = std::fs::read(blob_path(&notes, &id)).unwrap();
        assert_eq!(on_disk, blob, "the live note must survive byte-identical");
        let st2 = read_sync_state(&dir).unwrap();
        assert_eq!(
            st2.blobs.get(&hex(&id)).map(|b| b.version),
            Some(1),
            "the old baseline stays authoritative — no tombstone adoption"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Guard A, §11.3 server shape: `/sync/blob` → 410 `blob_reclaimed` is a
    /// per-record skip, never a whole-cycle failure.
    #[test]
    fn blob_reclaimed_410_is_skipped_not_cycle_failure() {
        let (dir, notes) = fresh_vault("blob410");
        let id = [0x03u8; 16];
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            200,
            pull_body(&meta_json(&id, 4, &[0xcc; 24]), 1),
        );
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=1",
            200,
            pull_body("", 1),
        );
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(&id)),
            410,
            b"{\"error_code\":\"blob_reclaimed\"}".to_vec(),
        );

        let s = run_cycle_legacy(
            &t,
            &[0x42; 32],
            [0x5c; 16],
            [0x0a; 16],
            "tok",
            &notes,
            &dir,
            false,
        )
        .expect("410 blob_reclaimed must not fail the cycle");
        assert_eq!(s.pull_skipped, 1);
        assert!(!blob_path(&notes, &id).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Drop-leg: a previously-synced note absent from the reconcile roster is
    /// QUARANTINED (moved, never destroyed), its baseline and queued tombstone
    /// flag dropped, the authored state consistent — and `dropped` counted.
    #[test]
    fn reconcile_drop_quarantines_previously_synced_absentee() {
        let (dir, notes) = fresh_vault("dropleg");
        let id = v7_id();
        let items_key = [0x11u8; 32];
        let items_key_id = [0x22u8; 16];
        let blob = encode_new_note(&items_key, &items_key_id, &id, b"ghost note").unwrap();
        let disk_nonce = crate::note_nonce::read_myn_content_nonce(&blob).unwrap();
        crate::atomic_write::atomic_write(&blob_path(&notes, &id), &blob, false).unwrap();
        let mut st = SyncState {
            cursor: 5,
            ..Default::default()
        };
        st.blobs.insert(
            hex(&id),
            BlobSyncState {
                version: 1,
                content_nonce_hex: hex(&disk_nonce),
            },
        );
        write_sync_state(&dir, &st).unwrap();
        add_pending_tombstone(&dir, &hex(&id)).unwrap();

        let t = FakeTransport::new();
        // Stale cursor → 410 → reconcile walk whose roster no longer carries the id.
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=5",
            410,
            b"{\"error_code\":\"cursor_expired\"}".to_vec(),
        );
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0&reconcile=1",
            200,
            pull_body("", 6),
        );
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=6&reconcile=1",
            200,
            pull_body("", 6),
        );

        let s = run_cycle_legacy(
            &t,
            &[0x42; 32],
            [0x5c; 16],
            [0x0a; 16],
            "tok",
            &notes,
            &dir,
            false,
        )
        .expect("reconcile cycle");
        assert!(s.reconcile_ran);
        assert_eq!(s.dropped, 1);
        assert!(
            !blob_path(&notes, &id).exists(),
            "the ghost left the live notes dir"
        );
        let uuid = uuid::Uuid::from_bytes(id);
        assert!(
            dir.join("quarantine").join(format!("{uuid}.myn")).exists(),
            "…but its ciphertext is preserved in quarantine/"
        );
        let st2 = read_sync_state(&dir).unwrap();
        assert!(!st2.blobs.contains_key(&hex(&id)), "baseline dropped");
        assert!(
            !read_pending_tombstones(&dir).contains(&hex(&id)),
            "the moot tombstone flag is dequeued"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Drop-leg discriminator: a never-synced local note absent from the
    /// roster is NEW LOCAL WORK — kept on disk, never quarantined.
    #[test]
    fn reconcile_keeps_never_synced_local_note() {
        let (dir, notes) = fresh_vault("keeplocal");
        let id = v7_id();
        let items_key = [0x11u8; 32];
        let items_key_id = [0x22u8; 16];
        let blob = encode_new_note(&items_key, &items_key_id, &id, b"fresh local work").unwrap();
        crate::atomic_write::atomic_write(&blob_path(&notes, &id), &blob, false).unwrap();
        // Enrolled before (cursor advanced), but this note never synced (no baseline).
        let st = SyncState {
            cursor: 5,
            ..Default::default()
        };
        write_sync_state(&dir, &st).unwrap();

        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=5",
            410,
            b"{\"error_code\":\"cursor_expired\"}".to_vec(),
        );
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0&reconcile=1",
            200,
            pull_body("", 6),
        );
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=6&reconcile=1",
            200,
            pull_body("", 6),
        );

        let s = run_cycle_legacy(
            &t,
            &[0x42; 32],
            [0x5c; 16],
            [0x0a; 16],
            "tok",
            &notes,
            &dir,
            false,
        )
        .expect("reconcile cycle");
        assert!(s.reconcile_ran);
        assert_eq!(s.dropped, 0, "new local work is never dropped");
        assert!(blob_path(&notes, &id).exists(), "…and stays in notes/");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Drop-leg guard: an id with a staged (unresolved) keep-both conflict is
    /// never quarantined — conflict resolution owns it.
    #[test]
    fn staged_conflict_id_is_not_dropped() {
        let (dir, notes) = fresh_vault("stagedskip");
        let id = v7_id();
        let items_key = [0x11u8; 32];
        let items_key_id = [0x22u8; 16];
        let blob = encode_new_note(&items_key, &items_key_id, &id, b"conflicted local").unwrap();
        let disk_nonce = crate::note_nonce::read_myn_content_nonce(&blob).unwrap();
        crate::atomic_write::atomic_write(&blob_path(&notes, &id), &blob, false).unwrap();
        let mut st = SyncState {
            cursor: 5,
            ..Default::default()
        };
        st.blobs.insert(
            hex(&id),
            BlobSyncState {
                version: 1,
                content_nonce_hex: hex(&disk_nonce),
            },
        );
        write_sync_state(&dir, &st).unwrap();
        stage_conflict(&dir, &id, 2, &[0xee; 24], b"staged remote bytes").unwrap();

        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=5",
            410,
            b"{\"error_code\":\"cursor_expired\"}".to_vec(),
        );
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0&reconcile=1",
            200,
            pull_body("", 6),
        );
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=6&reconcile=1",
            200,
            pull_body("", 6),
        );

        let s = run_cycle_legacy(
            &t,
            &[0x42; 32],
            [0x5c; 16],
            [0x0a; 16],
            "tok",
            &notes,
            &dir,
            false,
        )
        .expect("reconcile cycle");
        assert_eq!(
            s.dropped, 0,
            "a staged conflict is conflict-resolution's, not the drop-leg's"
        );
        assert!(blob_path(&notes, &id).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// F4 fresh-cursor probe: a re-enrolled device (cursor 0, wiped baselines)
    /// holding a local copy of a RECLAIMED record must quarantine it instead of
    /// pushing `base_version 0` into a guaranteed 409 batch-wedge.
    #[test]
    fn fresh_cursor_push_probe_quarantines_reclaimed() {
        let (dir, notes) = fresh_vault("probe410");
        let id = v7_id();
        let root_key = [0x42u8; 32];
        let account = [0x5cu8; 16];
        let items_key = [0x11u8; 32];
        let items_key_id = [0x22u8; 16];
        let blob = encode_new_note(&items_key, &items_key_id, &id, b"reclaimed ghost").unwrap();
        crate::atomic_write::atomic_write(&blob_path(&notes, &id), &blob, false).unwrap();

        let head = sealed_head_fragment(&root_key, account);
        let t = FakeTransport::new();
        // An account WITH history (head present) whose roster no longer carries
        // the ghost — the §11.3 server omitted the reclaimed record.
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            200,
            pull_body_with_head("", 0, &head),
        );
        // The probe: the server knows this id as a reclaimed record.
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(&id)),
            410,
            b"{\"error_code\":\"blob_reclaimed\"}".to_vec(),
        );

        let s = run_cycle_legacy(
            &t, &root_key, account, [0x0a; 16], "tok", &notes, &dir, true,
        )
        .expect("cycle");
        assert_eq!(s.dropped, 1, "the reclaimed ghost is quarantined");
        assert_eq!(
            s.pushed, 0,
            "…and never pushed (base_version 0 would 409-wedge the batch)"
        );
        assert!(!blob_path(&notes, &id).exists());
        let uuid = uuid::Uuid::from_bytes(id);
        assert!(dir.join("quarantine").join(format!("{uuid}.myn")).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    // ── apply_pulled_note_blob: in-lock dirty re-check (A1 linearization) ──
    // Two-thread race pin deliberately downgraded: `run_sync_cycle` is
    // monolithic over a transport with no mid-loop injection seam, so a
    // barrier-based race test would need test-only hooks in production code.
    // Coverage instead: both writers share `notes_write_mutex` (compile-level),
    // and these units pin the in-lock decision both ways.

    /// The cycle-start manifest said "clean", but a local save landed before
    /// the write: the in-lock re-read sees the diverged disk nonce and skips —
    /// the pulled bytes must never clobber the fresh local edit.
    #[test]
    fn apply_pulled_note_blob_skips_when_disk_nonce_diverged_from_scan() {
        let (dir, notes) = fresh_vault("applylock-dirty");
        let id = v7_id();
        let items_key = [0x11u8; 32];
        let items_key_id = [0x22u8; 16];
        let original = encode_new_note(&items_key, &items_key_id, &id, b"scanned base").unwrap();
        let scanned_nonce = crate::note_nonce::read_myn_content_nonce(&original).unwrap();
        // …but by write time the disk already holds a NEWER local edit.
        let local_edit = encode_new_note(&items_key, &items_key_id, &id, b"local edit").unwrap();
        crate::atomic_write::atomic_write(&blob_path(&notes, &id), &local_edit, false).unwrap();

        let server_bytes = encode_new_note(&items_key, &items_key_id, &id, b"server v2").unwrap();
        let outcome = blocking(apply_pulled_note_blob(
            &IO,
            &notes,
            &id,
            &server_bytes,
            Some(hex(&scanned_nonce).as_str()),
        ))
        .unwrap();
        assert!(matches!(outcome, PulledNoteApply::SkippedDirty));
        let on_disk = std::fs::read(blob_path(&notes, &id)).unwrap();
        assert_eq!(on_disk, local_edit, "the racing local edit survives");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Clean case: disk still matches the synced baseline → the pulled bytes land.
    #[test]
    fn apply_pulled_note_blob_writes_when_clean() {
        let (dir, notes) = fresh_vault("applylock-clean");
        let id = v7_id();
        let items_key = [0x11u8; 32];
        let items_key_id = [0x22u8; 16];
        let base = encode_new_note(&items_key, &items_key_id, &id, b"synced base").unwrap();
        let base_nonce = crate::note_nonce::read_myn_content_nonce(&base).unwrap();
        crate::atomic_write::atomic_write(&blob_path(&notes, &id), &base, false).unwrap();

        let server_bytes = encode_new_note(&items_key, &items_key_id, &id, b"server v2").unwrap();
        let outcome = blocking(apply_pulled_note_blob(
            &IO,
            &notes,
            &id,
            &server_bytes,
            Some(hex(&base_nonce).as_str()),
        ))
        .unwrap();
        assert!(matches!(outcome, PulledNoteApply::Applied));
        let on_disk = std::fs::read(blob_path(&notes, &id)).unwrap();
        assert_eq!(on_disk, server_bytes);
        // A vanished file under a live baseline is likewise dirty (a mid-cycle
        // local delete must not be resurrected).
        std::fs::remove_file(blob_path(&notes, &id)).unwrap();
        let outcome2 = blocking(apply_pulled_note_blob(
            &IO,
            &notes,
            &id,
            &server_bytes,
            Some(hex(&base_nonce).as_str()),
        ))
        .unwrap();
        assert!(matches!(outcome2, PulledNoteApply::SkippedDirty));
        // No baseline (fresh pull) writes unconditionally.
        let outcome3 = blocking(apply_pulled_note_blob(
            &IO,
            &notes,
            &id,
            &server_bytes,
            None,
        ))
        .unwrap();
        assert!(matches!(outcome3, PulledNoteApply::Applied));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// F4 sibling: a 404 probe answer means "genuinely new note" — it pushes
    /// exactly as before (fail-open).
    #[test]
    fn fresh_cursor_push_probe_404_pushes_normally() {
        let (dir, notes) = fresh_vault("probe404");
        let id = v7_id();
        let root_key = [0x42u8; 32];
        let account = [0x5cu8; 16];
        let items_key = [0x11u8; 32];
        let items_key_id = [0x22u8; 16];
        let blob = encode_new_note(&items_key, &items_key_id, &id, b"genuinely new").unwrap();
        crate::atomic_write::atomic_write(&blob_path(&notes, &id), &blob, false).unwrap();

        let head = sealed_head_fragment(&root_key, account);
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            200,
            pull_body_with_head("", 0, &head),
        );
        t.on(
            HttpMethod::Get,
            &format!("/sync/blob?id={}", hex(&id)),
            404,
            b"{\"error_code\":\"not_found\"}".to_vec(),
        );
        t.on(
            HttpMethod::Post,
            "/sync/push",
            200,
            format!(
                "{{\"results\":[{{\"blob_id_hex\":\"{}\",\"version\":1}}],\"head_id_hex\":\"{}\"}}",
                hex(&id),
                "cd".repeat(32)
            )
            .into_bytes(),
        );

        let s = run_cycle_legacy(
            &t, &root_key, account, [0x0a; 16], "tok", &notes, &dir, true,
        )
        .expect("cycle");
        assert_eq!(
            s.pushed, 1,
            "a 404 probe is fail-open — the new note pushes"
        );
        assert_eq!(s.dropped, 0);
        assert!(blob_path(&notes, &id).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Live end-to-end poke: device B holds an open `/sync/poke` SSE stream
    /// against the REAL server; device A's push must surface as a contentless
    /// poke on B's stream within seconds (the §8.3-as-amended baseline path:
    /// push → server Notify → SSE event → SsePokeSignal bump). Self-skips
    /// without the server binary.
    #[test]
    fn push_on_device_a_pokes_device_b_over_live_sse() {
        use crate::plugins::sync::poke_listener::{drain_stream, SsePokeSignal};
        use std::sync::atomic::{AtomicBool, Ordering};

        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP push_on_device_a_pokes_device_b_over_live_sse: myne-server not built");
            return;
        };

        let root_key = [0x42u8; 32];
        let account_hash = [0x6Du8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0x11u8; 32];
        let items_key_id = [0x22u8; 16];

        let dir_a = std::env::temp_dir().join(format!("myne-orch-pokeA-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        let note = NoteId::new_v7();
        let blob = encode_new_note(
            &items_key,
            &items_key_id,
            note.as_uuid().as_bytes(),
            b"poke me",
        )
        .unwrap();
        crate::atomic_write::atomic_write(
            &notes_a.join(format!("{}.myn", note.as_uuid())),
            &blob,
            false,
        )
        .unwrap();

        let ta = crate::plugins::sync::http_transport::build_transport(&url, Vec::new()).unwrap();
        enroll::register_verifier(ta.as_ref(), &account_hash, secret.as_slice()).unwrap();
        let dev_a = enroll::generate_device_id();
        let out_a = enroll::enroll(
            ta.as_ref(),
            &account_hash,
            secret.as_slice(),
            EnrollPath::Recovery,
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            dev_a,
        )
        .unwrap();
        let tok_a = hex32(&out_a.token);
        let tb = crate::plugins::sync::http_transport::build_transport(&url, Vec::new()).unwrap();
        let dev_b = enroll::generate_device_id();
        let out_b = enroll::enroll(
            tb.as_ref(),
            &account_hash,
            secret.as_slice(),
            EnrollPath::Recovery,
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            dev_b,
        )
        .unwrap();
        let tok_b = hex32(&out_b.token);

        // B opens the live SSE stream and drains it on a side thread.
        let stream = tb
            .open_sse("/sync/poke", &tok_b, std::time::Duration::from_secs(10))
            .expect("open_sse against the live server");
        let shutdown = stream.socket.try_clone().unwrap();
        let signal = SsePokeSignal::default();
        let signal2 = signal.clone();
        let stop = std::sync::Arc::new(AtomicBool::new(false));
        let stop2 = stop.clone();
        let chunked = stream.chunked;
        let reader = stream.reader;
        let drainer = std::thread::spawn(move || drain_stream(reader, chunked, &stop2, &signal2));

        // A pushes — the server must poke B's open stream.
        let push = run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A push cycle");
        assert_eq!(push.pushed, 1);

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while signal.get() == 0 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
        assert!(
            signal.get() >= 1,
            "device A's push must arrive as a poke on B's live SSE stream"
        );

        stop.store(true, Ordering::Relaxed);
        let _ = shutdown.shutdown(std::net::Shutdown::Both);
        let _ = drainer.join();
        std::fs::remove_dir_all(&dir_a).ok();
    }

    /// The "add this device" flow: device B joins an existing account by
    /// `{account# + password}` → server gates it **pending** (no token) → device
    /// A approves it → B re-runs the handshake and **claims its token** → B syncs
    /// and the owner's note lands on B. No recovery phrase. Self-skips without the
    /// server binary.
    #[test]
    fn password_device_join_pending_approve_claim_then_sync() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP password_device_join_...: myne-server binary not found");
            return;
        };

        let root_key = [0x55u8; 32];
        let account_hash = [0x6Bu8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0x12u8; 32];
        let items_key_id = [0x34u8; 16];

        let dir_a = std::env::temp_dir().join(format!("myne-join-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-join-B-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();
        let mk =
            || crate::plugins::sync::http_transport::build_transport(&url, Vec::new()).unwrap();

        // Owner A: author a note, register the verifier, enroll (recovery →
        // self-approve), push.
        let note = NoteId::new_v7();
        let note_bytes = *note.as_uuid().as_bytes();
        let plaintext = b"note from the owner";
        let blob = encode_new_note(&items_key, &items_key_id, &note_bytes, plaintext).unwrap();
        crate::atomic_write::atomic_write(
            &notes_a.join(format!("{}.myn", note.as_uuid())),
            &blob,
            false,
        )
        .unwrap();
        let ta = mk();
        enroll::register_verifier(ta.as_ref(), &account_hash, secret.as_slice()).unwrap();
        let dev_a = enroll::generate_device_id();
        let out_a = enroll::enroll(
            ta.as_ref(),
            &account_hash,
            secret.as_slice(),
            EnrollPath::Recovery,
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            dev_a,
        )
        .unwrap();
        let tok_a = hex32(&out_a.token);
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .unwrap();

        // Device B joins via PASSWORD → the server gates it pending (no token).
        let dev_b = enroll::generate_device_id();
        let out_b = enroll::enroll(
            mk().as_ref(),
            &account_hash,
            secret.as_slice(),
            EnrollPath::Password,
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            dev_b,
        )
        .unwrap();
        assert!(!out_b.approved, "a password device starts pending");
        assert!(out_b.token.is_empty(), "a pending device has no token yet");

        // Owner A approves B.
        crate::plugins::sync::devices::approve_device(ta.as_ref(), &tok_a, &dev_b).unwrap();

        // B CLAIMS its token by re-running the handshake with the same device_id.
        let out_b2 = enroll::enroll(
            mk().as_ref(),
            &account_hash,
            secret.as_slice(),
            EnrollPath::Password,
            "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
            dev_b,
        )
        .unwrap();
        assert!(
            out_b2.approved,
            "an approved device claims its token on re-enroll"
        );
        assert!(!out_b2.token.is_empty());
        let tok_b = hex32(&out_b2.token);

        // B syncs → the owner's note lands on B's disk, decrypting to the same text.
        let pull = run_cycle_legacy(
            mk().as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B sync after join");
        assert_eq!(pull.pulled, 1, "B pulled the owner's note after joining");
        let b_path = notes_b.join(format!("{}.myn", note.as_uuid()));
        assert!(
            b_path.exists(),
            "the note materialized on the joined device"
        );
        let decrypted = decode_note(
            &std::fs::read(&b_path).unwrap(),
            &note_bytes,
            &items_key,
            &items_key_id,
        )
        .unwrap();
        assert_eq!(decrypted.plaintext(), plaintext);

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    /// #1 (SAS latency): the joining device records + PERSISTS the pulled head
    /// observation BEFORE the note-body download loop, so its join SAS
    /// (`sync_head_fingerprint` → `vv_log.last()`, read from disk) surfaces without
    /// waiting for the whole first-cycle content download. Proven by failing every
    /// `/sync/blob` GET: the cycle errors mid-download and NO note lands on disk,
    /// yet the persisted `sync-state.json` already carries the head observation.
    /// Before the fix the observation was recorded only AFTER the loop and persisted
    /// only on whole-cycle success, so a failed cycle left `vv_log` empty.
    #[test]
    fn join_head_fingerprint_persists_before_blob_download() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!(
                "SKIP join_head_fingerprint_persists_before_blob_download: server binary not found"
            );
            return;
        };
        let root_key = [0x5Au8; 32];
        let account_hash = [0x5Bu8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0x14u8; 32];
        let items_key_id = [0x38u8; 16];

        let dir_a = std::env::temp_dir().join(format!("myne-sasA-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-sasB-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();

        // Owner A authors a note and pushes it (server now holds A's head + blob).
        let note = NoteId::new_v7();
        write_note(
            &notes_a,
            &items_key,
            &items_key_id,
            &note,
            b"owner note",
            false,
        );
        let (ta, dev_a, tok_a) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .unwrap();
        let a_head = read_sync_state(&dir_a)
            .unwrap()
            .vv_log
            .last()
            .cloned()
            .expect("A recorded its head at push");

        // Device B joins (recovery self-approve) and gets a token.
        let (_tb, dev_b, tok_b) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );

        // B syncs through a transport that FAILS every blob download, so the
        // content-download loop cannot complete.
        let tb_fail = FailBlobTransport {
            inner: crate::plugins::sync::http_transport::build_transport(&url, Vec::new()).unwrap(),
        };
        let res = run_cycle_legacy(
            &tb_fail,
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        );
        assert!(
            res.is_err(),
            "the cycle errors because the blob download fails"
        );

        // The note body did NOT land (the download never completed)...
        assert!(
            !notes_b.join(format!("{}.myn", note.as_uuid())).exists(),
            "no note body downloaded"
        );
        // ...yet B's persisted sync-state already carries the head observation: the
        // SAS fingerprint is available before any note body is fetched.
        let b_head = read_sync_state(&dir_b)
            .unwrap()
            .vv_log
            .last()
            .cloned()
            .expect("B recorded + persisted the head BEFORE the download loop");
        assert_eq!(
            b_head.head_id_hex, a_head.head_id_hex,
            "B's early-surfaced SAS fingerprint matches the owner's head"
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    /// #2 (empty-vault liveness): a zero-note vault still authors a genesis head on
    /// its first push, so a joining device can pull + adopt it and its join SAS
    /// appears. Without the genesis-on-empty gate the account never gets a head, the
    /// joiner's pull returns `head=None` forever, and the SAS never shows (the phone
    /// hangs on "Waiting for approval").
    #[test]
    fn empty_vault_authors_genesis_head_so_joiner_sees_sas() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP empty_vault_authors_genesis_head...: server binary not found");
            return;
        };
        let root_key = [0x61u8; 32];
        let account_hash = [0x62u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);

        let dir_a = std::env::temp_dir().join(format!("myne-genA-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-genB-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap(); // EMPTY — no notes authored
        std::fs::create_dir_all(&notes_b).unwrap();

        // Owner A: empty vault, enroll, push → authors a genesis head over 0 notes.
        let (ta, dev_a, tok_a) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        let push = run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A's first cycle");
        assert!(push.head_advanced, "an empty vault authors a genesis head");
        assert_eq!(push.pushed, 0, "no blobs pushed for an empty vault");
        let a_head = read_sync_state(&dir_a)
            .unwrap()
            .vv_log
            .last()
            .cloned()
            .expect("A recorded the genesis head observation (its own SAS)");

        // Device B joins (recovery self-approve) and pulls: it adopts the genesis
        // head and its join SAS fingerprint appears — matching A's.
        let (tb, dev_b, tok_b) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );
        let pull = run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B's join cycle");
        assert_eq!(pull.pulled, 0, "nothing to download on an empty account");
        let b_head = read_sync_state(&dir_b)
            .unwrap()
            .vv_log
            .last()
            .cloned()
            .expect("the joining device adopts the genesis head → SAS appears");
        assert_eq!(
            b_head.head_id_hex, a_head.head_id_hex,
            "both devices agree on the genesis head fingerprint"
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    /// Regression: a device that holds the account's blobs locally but whose
    /// synced baseline (`state.blobs`) was lost — the chunked push-response parse
    /// bug left it empty even though the server stored the blobs — must SELF-HEAL
    /// from the pull roster and push only the genuinely-edited blob (NOT re-push
    /// everything at base_version 0, which the server CAS rejects 409), and must
    /// not let the pull clobber the unpushed local edit with the server's copy.
    #[test]
    fn empty_baseline_self_heals_and_local_edit_pushes() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP empty_baseline_self_heals: myne-server binary not found");
            return;
        };

        let root_key = [0x33u8; 32];
        let account_hash = [0x44u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0x13u8; 32];
        let items_key_id = [0x37u8; 16];

        let dir_a = std::env::temp_dir().join(format!("myne-heal-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-heal-B-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();
        let note = NoteId::new_v7();
        let note_bytes = *note.as_uuid().as_bytes();
        let fname = format!("{}.myn", note.as_uuid());

        // Device A authors a note and pushes it (server stores it at version 1).
        let blob_v1 = encode_new_note(&items_key, &items_key_id, &note_bytes, b"original").unwrap();
        crate::atomic_write::atomic_write(&notes_a.join(&fname), &blob_v1, false).unwrap();
        let ta = crate::plugins::sync::http_transport::build_transport(&url, Vec::new()).unwrap();
        enroll::register_verifier(ta.as_ref(), &account_hash, secret.as_slice()).unwrap();
        let dev_a = enroll::generate_device_id();
        let out_a = enroll::enroll(
            ta.as_ref(),
            &account_hash,
            secret.as_slice(),
            EnrollPath::Recovery,
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            dev_a,
        )
        .unwrap();
        let tok_a = hex32(&out_a.token);
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A initial push");

        // Corruption: clear A's synced baseline — exactly what the chunked
        // push-response parse bug produced (server got the blob, A never recorded
        // it). Device identity + cursor are kept.
        let mut st = read_sync_state(&dir_a).unwrap();
        assert!(
            !st.blobs.is_empty(),
            "baseline populated by the initial push"
        );
        st.blobs.clear();
        write_sync_state(&dir_a, &st).unwrap();

        // A edits the note locally (a fresh content_nonce).
        let blob_v2 =
            encode_new_note(&items_key, &items_key_id, &note_bytes, b"edited body").unwrap();
        crate::atomic_write::atomic_write(&notes_a.join(&fname), &blob_v2, true).unwrap();

        // A syncs: self-heal the baseline + push the edit (no 409), and do NOT
        // clobber the local edit with the server's v1.
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A heal + push edit");
        let a_after = std::fs::read(notes_a.join(&fname)).unwrap();
        let a_dec = decode_note(&a_after, &note_bytes, &items_key, &items_key_id).unwrap();
        assert_eq!(
            a_dec.plaintext(),
            b"edited body",
            "A's local edit survived (not clobbered by the pull)"
        );

        // Device B pulls the edit fresh → proves the edit actually propagated.
        let tb = crate::plugins::sync::http_transport::build_transport(&url, Vec::new()).unwrap();
        let dev_b = enroll::generate_device_id();
        let out_b = enroll::enroll(
            tb.as_ref(),
            &account_hash,
            secret.as_slice(),
            EnrollPath::Recovery,
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            dev_b,
        )
        .unwrap();
        let tok_b = hex32(&out_b.token);
        let pull = run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B pull");
        assert_eq!(pull.pulled, 1, "B pulled the edited note");
        let b_blob = std::fs::read(notes_b.join(&fname)).unwrap();
        let b_dec = decode_note(&b_blob, &note_bytes, &items_key, &items_key_id).unwrap();
        assert_eq!(
            b_dec.plaintext(),
            b"edited body",
            "B sees A's edit (v2 propagated end-to-end)"
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    /// Enroll a device via the recovery path (self-approves). `register` runs the
    /// one-time SCRAM verifier registration (call it true on the first device).
    fn enroll_device(
        url: &str,
        account_hash: &[u8; 16],
        secret: &[u8],
        nonce: &str,
        register: bool,
    ) -> (Box<dyn SyncTransport>, [u8; 16], String) {
        let t = crate::plugins::sync::http_transport::build_transport(url, Vec::new()).unwrap();
        if register {
            enroll::register_verifier(t.as_ref(), account_hash, secret).unwrap();
        }
        let dev = enroll::generate_device_id();
        let out = enroll::enroll(
            t.as_ref(),
            account_hash,
            secret,
            EnrollPath::Recovery,
            nonce,
            dev,
        )
        .unwrap();
        let tok = hex32(&out.token);
        (t, dev, tok)
    }

    fn write_note(
        notes_dir: &std::path::Path,
        ik: &[u8; 32],
        iki: &[u8; 16],
        id: &NoteId,
        body: &[u8],
        replace: bool,
    ) {
        let nb = *id.as_uuid().as_bytes();
        let blob = encode_new_note(ik, iki, &nb, body).unwrap();
        crate::atomic_write::atomic_write(
            &notes_dir.join(format!("{}.myn", id.as_uuid())),
            &blob,
            replace,
        )
        .unwrap();
    }

    fn read_note(
        notes_dir: &std::path::Path,
        ik: &[u8; 32],
        iki: &[u8; 16],
        id: &NoteId,
    ) -> Option<Vec<u8>> {
        let nb = *id.as_uuid().as_bytes();
        let blob = std::fs::read(notes_dir.join(format!("{}.myn", id.as_uuid()))).ok()?;
        Some(decode_note(&blob, &nb, ik, iki).ok()?.plaintext().to_vec())
    }

    /// The user's real shape: a vault larger than the server page size (300 notes
    /// against the 256-blob page) replicates fully to a fresh device across
    /// multiple pull pages. Guards the cursor-drain loop + reconcile at scale.
    #[test]
    fn large_vault_300_notes_replicates_across_pages() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP large_vault_300: server binary not found");
            return;
        };
        let root_key = [0x71u8; 32];
        let account_hash = [0x72u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0x73u8; 32];
        let items_key_id = [0x74u8; 16];
        let dir_a = std::env::temp_dir().join(format!("myne-large-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-large-B-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();

        let mut ids = Vec::new();
        for i in 0..300u32 {
            let note = NoteId::new_v7();
            write_note(
                &notes_a,
                &items_key,
                &items_key_id,
                &note,
                format!("note {i}").as_bytes(),
                false,
            );
            ids.push(note);
        }
        let (ta, dev_a, tok_a) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        let push = run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A push 300");
        assert_eq!(push.pushed, 300, "A pushed all 300 notes in one cycle");

        let (tb, dev_b, tok_b) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );
        let pull = run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B pull 300");
        assert_eq!(pull.pulled, 300, "B pulled all 300 notes across pages");
        assert_eq!(
            read_note(&notes_b, &items_key, &items_key_id, &ids[0]).as_deref(),
            Some(&b"note 0"[..])
        );
        assert_eq!(
            read_note(&notes_b, &items_key, &items_key_id, &ids[299]).as_deref(),
            Some(&b"note 299"[..])
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    /// An offline delete propagates to a device that was up-to-date before the
    /// delete: with an intact baseline the pull correctly DOWNLOADS the deletion
    /// (not treated as a local edit), so the note does not resurrect.
    #[test]
    fn offline_delete_propagates_with_intact_baseline() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP offline_delete: server binary not found");
            return;
        };
        let root_key = [0x61u8; 32];
        let account_hash = [0x62u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0x63u8; 32];
        let items_key_id = [0x64u8; 16];
        let dir_a = std::env::temp_dir().join(format!("myne-del-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-del-B-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();
        let note = NoteId::new_v7();

        // A authors X "live", pushes; B syncs (B now holds X live, baseline intact).
        write_note(
            &notes_a,
            &items_key,
            &items_key_id,
            &note,
            b"live body",
            false,
        );
        let (ta, dev_a, tok_a) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A push live");
        let (tb, dev_b, tok_b) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );
        run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B initial pull");
        assert_eq!(
            read_note(&notes_b, &items_key, &items_key_id, &note).as_deref(),
            Some(&b"live body"[..]),
            "B has the live note"
        );

        // A "deletes" X (the tombstone re-encrypts the blob with the deleted marker
        // → a fresh content_nonce). A pushes.
        write_note(
            &notes_a,
            &items_key,
            &items_key_id,
            &note,
            b"deleted: 2026-06-21T00:00:00Z",
            true,
        );
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A push delete");

        // B syncs: must DOWNLOAD the deletion (B never edited → not locally dirty).
        run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B pull delete");
        assert_eq!(
            read_note(&notes_b, &items_key, &items_key_id, &note).as_deref(),
            Some(&b"deleted: 2026-06-21T00:00:00Z"[..]),
            "the deletion propagated to B (no resurrection)"
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    /// Concurrent same-note edit must NOT wedge the vault. Device B edits X (which
    /// A also edited + pushed) AND adds an unrelated note Y, then syncs. B's cycle
    /// succeeds: the X conflict is surfaced + EXCLUDED from the push (so it can't
    /// fail the atomic batch CAS), Y pushes regardless, and B's local X edit is
    /// left untouched. Both revisions survive (B's edit on B, A's edit on the
    /// server) — no silent loss, no wedge. The auto-materialization of the remote
    /// revision as a conflict copy is the follow-up below.
    #[test]
    fn concurrent_edit_no_wedge_and_surfaces_conflict() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP concurrent_no_wedge: server binary not found");
            return;
        };
        let root_key = [0x81u8; 32];
        let account_hash = [0x82u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0x83u8; 32];
        let items_key_id = [0x84u8; 16];
        let dir_a = std::env::temp_dir().join(format!("myne-conf-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-conf-B-{}", std::process::id()));
        let dir_c = std::env::temp_dir().join(format!("myne-conf-C-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        let notes_c = dir_c.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();
        std::fs::create_dir_all(&notes_c).unwrap();
        let x = NoteId::new_v7();

        // Both devices reach a synced baseline of X.
        write_note(&notes_a, &items_key, &items_key_id, &x, b"base", false);
        let (ta, dev_a, tok_a) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A push base");
        let (tb, dev_b, tok_b) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );
        run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B pull base");

        // A edits X and pushes (server X advances). B edits X offline AND adds a
        // fresh note Y, then syncs.
        write_note(
            &notes_a,
            &items_key,
            &items_key_id,
            &x,
            b"edit from A",
            true,
        );
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A push edit");
        write_note(
            &notes_b,
            &items_key,
            &items_key_id,
            &x,
            b"edit from B",
            true,
        );
        let y = NoteId::new_v7();
        write_note(
            &notes_b,
            &items_key,
            &items_key_id,
            &y,
            b"unrelated note",
            false,
        );
        let summary = run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B sync must succeed despite the conflict (no wedge)");

        assert_eq!(summary.conflicts.len(), 1, "the X conflict is surfaced");
        assert_eq!(
            summary.conflicts[0].conflict_of_hex,
            hex(x.as_uuid().as_bytes()),
            "conflict names X"
        );
        assert!(
            summary.pushed >= 1,
            "the unrelated note Y pushed despite the conflict (no wedge)"
        );
        assert_eq!(
            read_note(&notes_b, &items_key, &items_key_id, &x).as_deref(),
            Some(&b"edit from B"[..]),
            "B's X edit untouched"
        );

        // Y reached the server and A's X edit is preserved there — no revision lost.
        let (tc, dev_c, tok_c) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2",
            false,
        );
        run_cycle_legacy(
            tc.as_ref(),
            &root_key,
            account_hash,
            dev_c,
            &tok_c,
            &notes_c,
            &dir_c,
            true,
        )
        .expect("C pull");
        assert_eq!(
            read_note(&notes_c, &items_key, &items_key_id, &y).as_deref(),
            Some(&b"unrelated note"[..]),
            "Y synced through to C"
        );
        assert_eq!(
            read_note(&notes_c, &items_key, &items_key_id, &x).as_deref(),
            Some(&b"edit from A"[..]),
            "A's X edit preserved on the server"
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
        std::fs::remove_dir_all(&dir_c).ok();
    }

    /// Full keep-both: after a concurrent edit, B materializes A's revision as a
    /// conflict copy (a new note) and keeps its own edit at X — both survive and
    /// converge to a third device. The engine stages A's blob + surfaces the plan;
    /// the test plays the notes layer's part (decrypt the staged blob → create the
    /// copy → resolve_conflict adopts the baseline). End-to-end through `C`.
    #[test]
    fn concurrent_same_note_edit_materializes_keep_both_copy() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP keep_both: server binary not found");
            return;
        };
        let root_key = [0x91u8; 32];
        let account_hash = [0x92u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0x93u8; 32];
        let items_key_id = [0x94u8; 16];
        let dir_a = std::env::temp_dir().join(format!("myne-kb-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-kb-B-{}", std::process::id()));
        let dir_c = std::env::temp_dir().join(format!("myne-kb-C-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        let notes_c = dir_c.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();
        std::fs::create_dir_all(&notes_c).unwrap();
        let x = NoteId::new_v7();

        // Both reach a synced baseline of X; A edits + pushes; B edits offline.
        write_note(&notes_a, &items_key, &items_key_id, &x, b"base", false);
        let (ta, dev_a, tok_a) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A push base");
        let (tb, dev_b, tok_b) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );
        run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B pull base");
        write_note(
            &notes_a,
            &items_key,
            &items_key_id,
            &x,
            b"edit from A",
            true,
        );
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A push edit");
        write_note(
            &notes_b,
            &items_key,
            &items_key_id,
            &x,
            b"edit from B",
            true,
        );

        // B's conflict cycle: A's revision is staged + surfaced; X is excluded.
        let s1 = run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B conflict cycle");
        assert_eq!(s1.conflicts.len(), 1, "conflict surfaced");
        let x_hex = hex(x.as_uuid().as_bytes());
        assert_eq!(
            list_pending_conflicts(&dir_b),
            vec![x_hex.clone()],
            "A's revision staged"
        );

        // --- the notes layer's part (TS `createConflictCopy` + resolve) ---
        let staged = read_staged_conflict_blob(&dir_b, &x_hex).expect("staged blob");
        let remote_body = decode_note(&staged, x.as_uuid().as_bytes(), &items_key, &items_key_id)
            .unwrap()
            .plaintext()
            .to_vec();
        assert_eq!(
            remote_body, b"edit from A",
            "staged remote revision decrypts to A's edit"
        );
        // Materialize the copy as a new note (TS adds the conflict_of frontmatter;
        // the engine flow only needs both bodies to survive + converge).
        let z = NoteId::new_v7();
        write_note(&notes_b, &items_key, &items_key_id, &z, &remote_body, false);
        resolve_conflict(&dir_b, &x_hex).expect("resolve");
        assert!(
            list_pending_conflicts(&dir_b).is_empty(),
            "staging cleared after resolve"
        );

        // B re-syncs: X (edit-B) now pushes as a clean linear advance + the copy Z.
        let s2 = run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B push resolved");
        assert!(s2.conflicts.is_empty(), "no conflict after resolution");
        assert_eq!(
            read_note(&notes_b, &items_key, &items_key_id, &x).as_deref(),
            Some(&b"edit from B"[..]),
            "B keeps its own edit at X"
        );

        // A third device sees BOTH revisions — neither edit was lost.
        let (tc, dev_c, tok_c) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2",
            false,
        );
        run_cycle_legacy(
            tc.as_ref(),
            &root_key,
            account_hash,
            dev_c,
            &tok_c,
            &notes_c,
            &dir_c,
            true,
        )
        .expect("C pull");
        assert_eq!(
            read_note(&notes_c, &items_key, &items_key_id, &x).as_deref(),
            Some(&b"edit from B"[..]),
            "C sees X = B's edit"
        );
        assert_eq!(
            read_note(&notes_c, &items_key, &items_key_id, &z).as_deref(),
            Some(&b"edit from A"[..]),
            "C sees the keep-both copy = A's edit"
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
        std::fs::remove_dir_all(&dir_c).ok();
    }

    /// A device whose token is revoked mid-life fails its next cycle cleanly with
    /// `Unauthenticated` (not a corrupt-state commit), and a held local edit
    /// survives untouched so a re-enrolled device can still push it. Real
    /// multi-device "remove this device" flow.
    #[test]
    fn revoked_token_fails_cycle_cleanly_without_losing_local_edit() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP revoked_token: server binary not found");
            return;
        };
        let root_key = [0xa1u8; 32];
        let account_hash = [0xa2u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0xa3u8; 32];
        let items_key_id = [0xa4u8; 16];
        let dir_a = std::env::temp_dir().join(format!("myne-rev-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-rev-B-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();

        // A (owner) enrolls + pushes a note; B enrolls (self-approves via recovery)
        // and syncs once so it holds a valid token + the note.
        let note = NoteId::new_v7();
        write_note(&notes_a, &items_key, &items_key_id, &note, b"shared", false);
        let (ta, dev_a, tok_a) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A push");
        let (tb, dev_b, tok_b) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );
        run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B initial sync");

        // The owner revokes B. B makes a local edit, then tries to sync with its
        // now-dead token.
        crate::plugins::sync::devices::revoke_device(ta.as_ref(), &tok_a, &dev_b)
            .expect("owner revokes B");
        write_note(
            &notes_b,
            &items_key,
            &items_key_id,
            &note,
            b"B unsynced edit",
            true,
        );
        let err = run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect_err("revoked token must fail the cycle");
        assert!(
            matches!(
                err,
                SyncCycleError::Pull(PullError::Unauthenticated)
                    | SyncCycleError::Push(PushError::Unauthenticated)
            ),
            "clean Unauthenticated, got {err:?}"
        );
        // The local edit is untouched — nothing was lost to the failed cycle.
        assert_eq!(
            read_note(&notes_b, &items_key, &items_key_id, &note).as_deref(),
            Some(&b"B unsynced edit"[..])
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    /// A `cursor_expired` (410) — the server GC'd past the device's stored cursor —
    /// resets the cursor to 0 and re-pulls a full reconcile, instead of looping on
    /// 410 forever. Driven with a fake transport: the first pull (stale cursor)
    /// 410s, the from-0 re-pull succeeds. The re-pull returns no head, so the push
    /// phase authors a genesis head (§6.1 re-genesis / genesis-on-empty) — the two
    /// recovery paths compose without wedging.
    #[test]
    fn cursor_expired_resets_and_full_reconciles() {
        use crate::plugins::sync::state::SyncState;
        use crate::plugins::sync::transport::{FakeTransport, HttpMethod};

        let dir = std::env::temp_dir().join(format!("myne-cursor-{}", std::process::id()));
        let notes = dir.join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        // Persist a stale cursor the server will reject.
        let st = SyncState {
            cursor: 5,
            ..Default::default()
        };
        write_sync_state(&dir, &st).unwrap();

        let fake = FakeTransport::new();
        fake.on(
            HttpMethod::Get,
            "/sync/pull?cursor=5",
            410,
            br#"{"error_code":"cursor_expired"}"#.to_vec(),
        );
        // The recovery re-pull carries `reconcile=1` so the server exempts it from
        // the cursor-expired floor (the pagination×floor wedge fix).
        fake.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0&reconcile=1",
            200,
            br#"{"metas":[],"next_cursor":0}"#.to_vec(),
        );
        // The re-pull returns no head (the server has none), so the recovery push
        // authors a genesis head over the empty corpus (§6.1 re-genesis / genesis-on-
        // empty liveness) — canned so the head-only push succeeds.
        fake.on(
            HttpMethod::Post,
            "/sync/push",
            200,
            br#"{"results":[],"head_id_hex":"3333333333333333333333333333333333333333333333333333333333333333"}"#.to_vec(),
        );

        let summary = run_cycle_legacy(
            &fake, &[0u8; 32], [0u8; 16], [0u8; 16], "tok", &notes, &dir, true,
        )
        .expect("the cycle recovers from cursor_expired");
        assert_eq!(summary.cursor, 0, "cursor reset to a full reconcile");
        assert!(
            summary.head_advanced,
            "no server head → the recovery push authors a genesis head (§6.1 re-genesis)"
        );
        assert!(
            summary.reconcile_ran,
            "the 410-recovery full reconcile sets reconcile_ran (drives the banner events)"
        );
        // The recovery re-pull from 0 actually happened, with the reconcile flag.
        let pulled_from_0 = fake
            .requests()
            .iter()
            .any(|(m, p, _, _, _)| *m == HttpMethod::Get && p == "/sync/pull?cursor=0&reconcile=1");
        assert!(
            pulled_from_0,
            "re-pulled from cursor 0 with reconcile=1 after the 410"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A fresh device pulling a vault larger than the server's rate-limit burst
    /// completes its initial sync in ONE cycle: the blob-download backoff absorbs
    /// the 429s (token-bucket refill) instead of failing the whole pull. Uses a
    /// deliberately low burst so the backoff path is exercised.
    #[test]
    fn large_initial_sync_backs_off_through_rate_limit() {
        let Some((_guard, url)) = spawn_server_env("100", "100000") else {
            eprintln!("SKIP rate_limit_backoff: server binary not found");
            return;
        };
        let root_key = [0xb1u8; 32];
        let account_hash = [0xb2u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0xb3u8; 32];
        let items_key_id = [0xb4u8; 16];
        let dir_a = std::env::temp_dir().join(format!("myne-rl-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-rl-B-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();

        // 150 notes > the 100-blob burst → B's download loop will hit 429s.
        let mut ids = Vec::new();
        for i in 0..150u32 {
            let note = NoteId::new_v7();
            write_note(
                &notes_a,
                &items_key,
                &items_key_id,
                &note,
                format!("n{i}").as_bytes(),
                false,
            );
            ids.push(note);
        }
        let (ta, dev_a, tok_a) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A push 150");
        let (tb, dev_b, tok_b) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );
        let pull = run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B initial sync completes despite the rate limit (backoff)");
        assert_eq!(
            pull.pulled, 150,
            "all 150 notes pulled in one cycle via backoff"
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    /// A queued tombstone (the notes layer's `sync_mark_tombstone`) is pushed WITH
    /// the server tombstone flag set, then dropped from the device-local queue; the
    /// deletion still propagates to a second device.
    #[test]
    fn queued_tombstone_pushes_with_flag_then_clears() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP tombstone_flag: server binary not found");
            return;
        };
        let root_key = [0xc1u8; 32];
        let account_hash = [0xc2u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0xc3u8; 32];
        let items_key_id = [0xc4u8; 16];
        let dir_a = std::env::temp_dir().join(format!("myne-tomb-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-tomb-B-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();
        let x = NoteId::new_v7();

        // A authors X live + pushes; B syncs (holds the live note).
        write_note(&notes_a, &items_key, &items_key_id, &x, b"live body", false);
        let (ta, dev_a, tok_a) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A push live");
        let (tb, dev_b, tok_b) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );
        run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B initial sync");

        // The notes layer tombstones X: queue it + write the deleted version.
        let x_hex = hex(x.as_uuid().as_bytes());
        add_pending_tombstone(&dir_a, &x_hex).expect("queue tombstone");
        write_note(
            &notes_a,
            &items_key,
            &items_key_id,
            &x,
            b"deleted: 2026-06-21T00:00:00Z",
            true,
        );

        let s = run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A push tombstone");
        assert_eq!(s.tombstones_pushed, 1, "X pushed with the tombstone flag");
        assert!(
            read_pending_tombstones(&dir_a).is_empty(),
            "the queue cleared after the flagged push"
        );

        // The deletion propagates to B.
        run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B pull deletion");
        assert_eq!(
            read_note(&notes_b, &items_key, &items_key_id, &x).as_deref(),
            Some(&b"deleted: 2026-06-21T00:00:00Z"[..]),
            "B sees the deletion"
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    /// Regression (the Windows→Mac sync wedge): a conflict detected in an EARLIER
    /// cycle (while the blob was in the pull window) must STAY excluded from the push
    /// after the cursor advances past it. Otherwise the next local edit re-pushes the
    /// note at its now-stale `base_version`, the server CAS 409s, and — because the
    /// push is one atomic batch — the whole batch wedges, so an innocent sibling note
    /// can never reach the server either. The fix excludes any note whose remote
    /// revision is still staged as an unresolved keep-both conflict.
    #[test]
    fn staged_conflict_stays_excluded_and_sibling_pushes_after_cursor_advance() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP staged_conflict_stays_excluded: server binary not found");
            return;
        };
        let root_key = [0x91u8; 32];
        let account_hash = [0x92u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0x93u8; 32];
        let items_key_id = [0x94u8; 16];
        let dir_a = std::env::temp_dir().join(format!("myne-wedge-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-wedge-B-{}", std::process::id()));
        let dir_c = std::env::temp_dir().join(format!("myne-wedge-C-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        let notes_c = dir_c.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();
        std::fs::create_dir_all(&notes_c).unwrap();
        let x = NoteId::new_v7();
        let x_hex = hex(x.as_uuid().as_bytes());

        // A authors X, pushes; B pulls X to a synced baseline (v1).
        write_note(&notes_a, &items_key, &items_key_id, &x, b"base", false);
        let (ta, dev_a, tok_a) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A push base");
        let (tb, dev_b, tok_b) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );
        run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B pull base");

        // A edits X and pushes (server X→v2, change-seq advances past X). B edits X
        // offline (concurrent) — it has NOT yet pulled A's revision.
        write_note(
            &notes_a,
            &items_key,
            &items_key_id,
            &x,
            b"edit from A",
            true,
        );
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A push edit");
        write_note(
            &notes_b,
            &items_key,
            &items_key_id,
            &x,
            b"edit from B",
            true,
        );

        // B cycle #1: pulls A's X@v2 (in window) → conflict detected, staged, and
        // excluded. B's cursor advances PAST X's change-seq. Nothing pushes (X is the
        // only dirty note), and the conflict is left UNRESOLVED (no materialization).
        let s1 = run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B cycle 1 surfaces the conflict without wedging");
        assert_eq!(s1.conflicts.len(), 1, "cycle 1 surfaces the X conflict");
        assert_eq!(
            s1.pushed, 0,
            "nothing pushed in cycle 1 (X is the only dirty note)"
        );
        assert!(
            list_pending_conflicts(&dir_b).contains(&x_hex),
            "X is staged pending after cycle 1"
        );

        // B now edits an innocent sibling note Y.
        let y = NoteId::new_v7();
        write_note(
            &notes_b,
            &items_key,
            &items_key_id,
            &y,
            b"innocent sibling",
            false,
        );

        // B cycle #2: X is now OUTSIDE the pull window (the cursor advanced past it in
        // cycle 1). Before the fix, X would be re-pushed at its stale base_version →
        // 409 blob_stale → the whole batch (including Y) wedges and the cycle errors.
        // The fix excludes the still-staged X, so Y pushes cleanly and the cycle is Ok.
        let s2 = run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B cycle 2 must NOT wedge — the staged conflict is excluded, Y pushes");
        assert!(
            s2.pushed >= 1,
            "the innocent sibling Y pushed despite the unresolved conflict"
        );

        // B's local X edit is untouched, and X stays a pending conflict until resolved.
        assert_eq!(
            read_note(&notes_b, &items_key, &items_key_id, &x).as_deref(),
            Some(&b"edit from B"[..]),
            "B's X edit untouched (never overwritten by the conflicting remote)"
        );
        assert!(
            list_pending_conflicts(&dir_b).contains(&x_hex),
            "X stays a pending conflict until the keep-both is resolved"
        );

        // Y reached the server (a fresh device C pulls it); A's X@v2 is preserved.
        let (tc, dev_c, tok_c) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2",
            false,
        );
        run_cycle_legacy(
            tc.as_ref(),
            &root_key,
            account_hash,
            dev_c,
            &tok_c,
            &notes_c,
            &dir_c,
            true,
        )
        .expect("C pull");
        assert_eq!(
            read_note(&notes_c, &items_key, &items_key_id, &y).as_deref(),
            Some(&b"innocent sibling"[..]),
            "Y synced through to C (no wedge)"
        );
        assert_eq!(
            read_note(&notes_c, &items_key, &items_key_id, &x).as_deref(),
            Some(&b"edit from A"[..]),
            "A's X edit preserved on the server"
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
        std::fs::remove_dir_all(&dir_c).ok();
    }

    /// Regression: the reactive lost-CAS recovery. A push that 409s `blob_stale` for
    /// a blob that is NOT a pre-staged conflict and sits OUTSIDE the cursor window
    /// (a baseline that fell behind the server — the partial-commit / corrupted-state
    /// class) must NOT propagate the error and wedge forever. The cycle re-pulls a
    /// full reconcile, re-detects the blob as a conflict against the now-complete
    /// roster, excludes it, and succeeds.
    #[test]
    fn blob_stale_recovers_via_full_reconcile_retry() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP blob_stale_recovers: server binary not found");
            return;
        };
        let root_key = [0xA1u8; 32];
        let account_hash = [0xA2u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0xA3u8; 32];
        let items_key_id = [0xA4u8; 16];
        let dir_a = std::env::temp_dir().join(format!("myne-retry-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-retry-B-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();
        let x = NoteId::new_v7();
        let x_hex = hex(x.as_uuid().as_bytes());

        // A authors X, pushes (v1). B pulls X to a clean baseline (v1).
        write_note(&notes_a, &items_key, &items_key_id, &x, b"base", false);
        let (ta, dev_a, tok_a) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A push base");
        let (tb, dev_b, tok_b) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );
        run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B pull base");

        // A edits X → v2 (server change-seq advances past X). B pulls it cleanly (B
        // has NOT edited X, so no conflict): B's baseline → v2, cursor past X.
        write_note(
            &notes_a,
            &items_key,
            &items_key_id,
            &x,
            b"edit from A",
            true,
        );
        run_cycle_legacy(
            ta.as_ref(),
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A push v2");
        run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B pull v2");
        assert_eq!(
            read_note(&notes_b, &items_key, &items_key_id, &x).as_deref(),
            Some(&b"edit from A"[..]),
            "B holds A's v2 before the corruption"
        );

        // Corrupt B's recorded baseline for X back to v1 WITHOUT staging a conflict —
        // simulating a baseline that fell behind the server while X sits outside the
        // cursor window (the partial-commit / chunked-parse class of desync).
        let mut st = read_sync_state(&dir_b).unwrap();
        st.blobs
            .get_mut(&x_hex)
            .expect("B has a baseline for X")
            .version = 1;
        write_sync_state(&dir_b, &st).unwrap();

        // B edits X locally → dirty over the corrupted v1 baseline. On push B sends
        // X@base_version=1; the server is at v2 → 409 blob_stale. Without the reactive
        // retry the cycle would error; with it, the full-reconcile retry re-detects X
        // as a conflict (server v2 > baseline v1), excludes it, and the cycle is Ok.
        write_note(
            &notes_b,
            &items_key,
            &items_key_id,
            &x,
            b"edit from B",
            true,
        );
        let s = run_cycle_legacy(
            tb.as_ref(),
            &root_key,
            account_hash,
            dev_b,
            &tok_b,
            &notes_b,
            &dir_b,
            true,
        )
        .expect("B cycle recovers from the 409 instead of wedging");
        assert_eq!(
            s.pushed, 0,
            "X (the only dirty note) is excluded, nothing pushes"
        );
        assert!(
            list_pending_conflicts(&dir_b).contains(&x_hex),
            "the recovery staged X as a conflict"
        );
        assert_eq!(
            read_note(&notes_b, &items_key, &items_key_id, &x).as_deref(),
            Some(&b"edit from B"[..]),
            "B's local X edit survived the recovery (never clobbered)"
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    // -----------------------------------------------------------------------
    // Attachment sync (MYND-468) — real-server integration
    // -----------------------------------------------------------------------

    /// The attachment-aware cycle (the production shape; the legacy wrapper
    /// above pins note behavior in isolation).
    #[allow(clippy::too_many_arguments)]
    fn run_cycle_att(
        transport: &dyn SyncTransport,
        root_key: &[u8; 32],
        account_number_hash: [u8; 16],
        device_id: [u8; 16],
        token: &str,
        vault_root: &Path,
        items_key: &[u8; 32],
        items_key_id: &[u8; 16],
    ) -> Result<SyncSummary, SyncCycleError> {
        blocking(run_sync_cycle(
            &IO,
            transport,
            root_key,
            account_number_hash,
            device_id,
            token,
            &vault_root.join("notes"),
            vault_root,
            true,
            Some(AttachmentKeys {
                items_key,
                items_key_id,
            }),
        ))
    }

    /// Seed a local attachment exactly as `attachment_import` would: MYA1 blob
    /// under `attachments/<id-hex>` + a live MYC1 catalog entry.
    #[allow(clippy::too_many_arguments)]
    fn seed_attachment(
        vault: &Path,
        root_key: &[u8; 32],
        account_hash: &[u8; 16],
        items_key: &[u8; 32],
        items_key_id: &[u8; 16],
        plaintext: &[u8],
        filename: &str,
        created_at: u64,
    ) -> [u8; 32] {
        let id = protocol::compute_attachment_id(root_key, plaintext);
        let blob = protocol::encode_attachment_blob(
            items_key,
            items_key_id,
            &id,
            b"application/octet-stream",
            plaintext,
        )
        .unwrap();
        let att_dir = vault.join("attachments");
        std::fs::create_dir_all(&att_dir).unwrap();
        crate::atomic_write::atomic_write(&att_dir.join(hex(&id)), &blob, true).unwrap();

        let catalog_key = derive_subkey(root_key, SubkeyRole::AttachmentsCatalogKey);
        let existing = std::fs::read(vault.join("vault.attachments")).ok();
        let mut catalog = protocol::read_or_empty(&catalog_key, account_hash, existing.as_deref());
        catalog.entries.insert(
            hex(&id),
            protocol::AttachmentMeta::live(
                "application/octet-stream".to_string(),
                created_at,
                filename.to_string(),
                plaintext.len() as u64,
            ),
        );
        let bytes =
            protocol::encode_attachments_catalog(&catalog_key, account_hash, &catalog).unwrap();
        crate::atomic_write::atomic_write(&vault.join("vault.attachments"), &bytes, true).unwrap();
        id
    }

    /// Delete a local attachment exactly as `attachment_delete` would under
    /// sync: catalog entry → tombstone (metadata scrubbed) + tombstone queue +
    /// blob unlink.
    fn delete_attachment_local(
        vault: &Path,
        root_key: &[u8; 32],
        account_hash: &[u8; 16],
        id: &[u8; 32],
        deleted_at: u64,
    ) {
        let catalog_key = derive_subkey(root_key, SubkeyRole::AttachmentsCatalogKey);
        let existing = std::fs::read(vault.join("vault.attachments")).ok();
        let mut catalog = protocol::read_or_empty(&catalog_key, account_hash, existing.as_deref());
        let id_hex = hex(id);
        if let Some(meta) = catalog.entries.get(&id_hex).cloned() {
            catalog
                .entries
                .insert(id_hex.clone(), meta.into_tombstone(deleted_at));
        }
        let bytes =
            protocol::encode_attachments_catalog(&catalog_key, account_hash, &catalog).unwrap();
        crate::atomic_write::atomic_write(&vault.join("vault.attachments"), &bytes, true).unwrap();
        add_pending_attachment_tombstone(vault, id).unwrap();
        let _ = std::fs::remove_file(vault.join("attachments").join(&id_hex));
    }

    fn read_catalog_of(
        vault: &Path,
        root_key: &[u8; 32],
        account_hash: &[u8; 16],
    ) -> protocol::AttachmentsCatalog {
        let catalog_key = derive_subkey(root_key, SubkeyRole::AttachmentsCatalogKey);
        let bytes = std::fs::read(vault.join("vault.attachments")).ok();
        protocol::read_or_empty(&catalog_key, account_hash, bytes.as_deref())
    }

    /// Enroll two devices on a fresh server; returns everything the attachment
    /// scenarios need. `None` → self-skip (binary not built).
    #[allow(clippy::type_complexity)]
    fn two_device_fixture(
        tag: &str,
    ) -> Option<(
        ServerGuard,
        Box<dyn SyncTransport>,
        Box<dyn SyncTransport>,
        std::path::PathBuf,
        std::path::PathBuf,
        [u8; 16],
        [u8; 16],
        String,
        String,
    )> {
        let (guard, url) = spawn_server()?;
        let root_key = [0x42u8; 32];
        let account_hash = {
            // Distinct account per scenario so parallel tests never share state.
            let mut h = [0u8; 16];
            let d = protocol::compute_attachment_id(&root_key, tag.as_bytes());
            h.copy_from_slice(&d[..16]);
            h
        };
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);

        let dir_a = std::env::temp_dir().join(format!("myne-att-A-{tag}-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-att-B-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir_a);
        let _ = std::fs::remove_dir_all(&dir_b);
        std::fs::create_dir_all(dir_a.join("notes")).unwrap();
        std::fs::create_dir_all(dir_b.join("notes")).unwrap();

        let ta = crate::plugins::sync::http_transport::build_transport(&url, Vec::new()).unwrap();
        let tb = crate::plugins::sync::http_transport::build_transport(&url, Vec::new()).unwrap();
        enroll::register_verifier(ta.as_ref(), &account_hash, secret.as_slice()).unwrap();
        let dev_a = enroll::generate_device_id();
        let out_a = enroll::enroll(
            ta.as_ref(),
            &account_hash,
            secret.as_slice(),
            EnrollPath::Recovery,
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            dev_a,
        )
        .unwrap();
        let dev_b = enroll::generate_device_id();
        let out_b = enroll::enroll(
            tb.as_ref(),
            &account_hash,
            secret.as_slice(),
            EnrollPath::Recovery,
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            dev_b,
        )
        .unwrap();
        Some((
            guard,
            ta,
            tb,
            dir_a,
            dir_b,
            dev_a,
            dev_b,
            hex32(&out_a.token),
            hex32(&out_b.token),
        ))
    }

    const ATT_ROOT: [u8; 32] = [0x42u8; 32];
    const ATT_ITEMS: [u8; 32] = [0x11u8; 32];
    const ATT_ITEMS_ID: [u8; 16] = [0x22u8; 16];

    /// A imports an attachment; B receives the exact bytes + the live catalog
    /// entry — the end-to-end replication proof over the real byte-transport.
    #[test]
    fn two_devices_replicate_an_attachment() {
        let Some((_g, ta, tb, dir_a, dir_b, dev_a, dev_b, tok_a, tok_b)) =
            two_device_fixture("repl")
        else {
            eprintln!("SKIP two_devices_replicate_an_attachment: myne-server not built");
            return;
        };
        let account_hash = {
            let d = protocol::compute_attachment_id(&ATT_ROOT, b"repl");
            let mut h = [0u8; 16];
            h.copy_from_slice(&d[..16]);
            h
        };

        let plaintext = b"attachment payload from device A";
        let id = seed_attachment(
            &dir_a,
            &ATT_ROOT,
            &account_hash,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
            plaintext,
            "payload.bin",
            1_000,
        );

        let push = run_cycle_att(
            ta.as_ref(),
            &ATT_ROOT,
            account_hash,
            dev_a,
            &tok_a,
            &dir_a,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .expect("A cycle");
        assert_eq!(push.attachments_pushed, 1, "A uploaded the body");
        assert!(
            push.head_advanced,
            "A authored a head over notes∪attachments"
        );

        let pull = run_cycle_att(
            tb.as_ref(),
            &ATT_ROOT,
            account_hash,
            dev_b,
            &tok_b,
            &dir_b,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .expect("B cycle");
        assert_eq!(pull.attachments_pulled, 1, "B downloaded the body");

        let a_bytes = std::fs::read(dir_a.join("attachments").join(hex(&id))).unwrap();
        let b_bytes = std::fs::read(dir_b.join("attachments").join(hex(&id))).unwrap();
        assert_eq!(
            a_bytes, b_bytes,
            "B holds A's exact ciphertext (server-wins convergence)"
        );

        let cat_b = read_catalog_of(&dir_b, &ATT_ROOT, &account_hash);
        let entry = cat_b
            .entries
            .get(&hex(&id))
            .expect("B merged the catalog entry");
        assert!(!entry.is_tombstone());
        assert_eq!(entry.filename, "payload.bin");

        // Idle cycles push nothing (nonce-churn regression): the catalog was
        // adopted verbatim, so no re-encrypt → no endless push loop.
        for (t, dev, tok, dir) in [
            (ta.as_ref(), dev_a, &tok_a, &dir_a),
            (tb.as_ref(), dev_b, &tok_b, &dir_b),
        ] {
            let idle = run_cycle_att(
                t,
                &ATT_ROOT,
                account_hash,
                dev,
                tok,
                dir,
                &ATT_ITEMS,
                &ATT_ITEMS_ID,
            )
            .expect("idle cycle");
            assert_eq!(
                (
                    idle.pushed,
                    idle.attachments_pushed,
                    idle.attachments_pulled
                ),
                (0, 0, 0),
                "an idle cycle after convergence moves nothing"
            );
        }

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    /// A deletes the attachment; B's blob is erased and its catalog entry is a
    /// tombstone — and B's stale catalog can never resurrect it (§11.4).
    #[test]
    fn attachment_delete_propagates_with_resurrection_guard() {
        let Some((_g, ta, tb, dir_a, dir_b, dev_a, dev_b, tok_a, tok_b)) =
            two_device_fixture("del")
        else {
            eprintln!("SKIP attachment_delete_propagates: myne-server not built");
            return;
        };
        let account_hash = {
            let d = protocol::compute_attachment_id(&ATT_ROOT, b"del");
            let mut h = [0u8; 16];
            h.copy_from_slice(&d[..16]);
            h
        };

        let plaintext = b"to be deleted everywhere";
        let id = seed_attachment(
            &dir_a,
            &ATT_ROOT,
            &account_hash,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
            plaintext,
            "doomed.bin",
            1_000,
        );
        // Replicate to B first.
        run_cycle_att(
            ta.as_ref(),
            &ATT_ROOT,
            account_hash,
            dev_a,
            &tok_a,
            &dir_a,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .unwrap();
        run_cycle_att(
            tb.as_ref(),
            &ATT_ROOT,
            account_hash,
            dev_b,
            &tok_b,
            &dir_b,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .unwrap();
        assert!(dir_b.join("attachments").join(hex(&id)).exists());

        // A deletes while B is "offline" (B holds a live catalog + the blob).
        delete_attachment_local(&dir_a, &ATT_ROOT, &account_hash, &id, 2_000);
        let del = run_cycle_att(
            ta.as_ref(),
            &ATT_ROOT,
            account_hash,
            dev_a,
            &tok_a,
            &dir_a,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .expect("A delete cycle");
        assert!(
            del.tombstones_pushed >= 1,
            "the §11.4 tombstone record pushed"
        );
        assert!(
            read_pending_attachment_tombstones(&dir_a).is_empty(),
            "the queue drained after the push"
        );

        // B pulls: catalog-first merge → tombstone wins → local erase.
        let pull = run_cycle_att(
            tb.as_ref(),
            &ATT_ROOT,
            account_hash,
            dev_b,
            &tok_b,
            &dir_b,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .expect("B pull cycle");
        assert_eq!(pull.attachments_deleted, 1, "B erased the tombstoned body");
        assert!(
            !dir_b.join("attachments").join(hex(&id)).exists(),
            "B's blob is gone"
        );
        let cat_b = read_catalog_of(&dir_b, &ATT_ROOT, &account_hash);
        assert!(
            cat_b
                .entries
                .get(&hex(&id))
                .is_some_and(|e| e.is_tombstone()),
            "B's catalog entry is the tombstone"
        );

        // Resurrection guard: B's next cycles never re-push the dead entry or
        // re-download the body.
        let idle = run_cycle_att(
            tb.as_ref(),
            &ATT_ROOT,
            account_hash,
            dev_b,
            &tok_b,
            &dir_b,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .unwrap();
        assert_eq!(
            (
                idle.attachments_pulled,
                idle.attachments_pushed,
                idle.pushed
            ),
            (0, 0, 0),
            "no resurrection churn"
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    /// Both devices import the SAME file independently (same content-addressed
    /// id, different random ciphertext) — the §4.2 server-wins rule converges
    /// both manifests on one ciphertext instead of diverging forever.
    #[test]
    fn double_import_converges_server_wins() {
        let Some((_g, ta, tb, dir_a, dir_b, dev_a, dev_b, tok_a, tok_b)) =
            two_device_fixture("dbl")
        else {
            eprintln!("SKIP double_import_converges: myne-server not built");
            return;
        };
        let account_hash = {
            let d = protocol::compute_attachment_id(&ATT_ROOT, b"dbl");
            let mut h = [0u8; 16];
            h.copy_from_slice(&d[..16]);
            h
        };

        let plaintext = b"identical file imported on two devices";
        let id_a = seed_attachment(
            &dir_a,
            &ATT_ROOT,
            &account_hash,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
            plaintext,
            "same.bin",
            1_000,
        );
        let id_b = seed_attachment(
            &dir_b,
            &ATT_ROOT,
            &account_hash,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
            plaintext,
            "same.bin",
            1_001,
        );
        assert_eq!(id_a, id_b, "content-addressing: same plaintext → same id");
        assert_ne!(
            std::fs::read(dir_a.join("attachments").join(hex(&id_a))).unwrap(),
            std::fs::read(dir_b.join("attachments").join(hex(&id_b))).unwrap(),
            "randomized encryption: same id, different ciphertext"
        );

        // A wins the race; B's divergent local copy must adopt A's bytes.
        run_cycle_att(
            ta.as_ref(),
            &ATT_ROOT,
            account_hash,
            dev_a,
            &tok_a,
            &dir_a,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .unwrap();
        run_cycle_att(
            tb.as_ref(),
            &ATT_ROOT,
            account_hash,
            dev_b,
            &tok_b,
            &dir_b,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .unwrap();

        let a_bytes = std::fs::read(dir_a.join("attachments").join(hex(&id_a))).unwrap();
        let b_bytes = std::fs::read(dir_b.join("attachments").join(hex(&id_a))).unwrap();
        assert_eq!(a_bytes, b_bytes, "server-wins converged the ciphertexts");

        // Convergence is stable: further cycles on both sides move nothing.
        for (t, dev, tok, dir) in [
            (ta.as_ref(), dev_a, &tok_a, &dir_a),
            (tb.as_ref(), dev_b, &tok_b, &dir_b),
        ] {
            let idle = run_cycle_att(
                t,
                &ATT_ROOT,
                account_hash,
                dev,
                tok,
                dir,
                &ATT_ITEMS,
                &ATT_ITEMS_ID,
            )
            .unwrap();
            assert_eq!(
                (idle.attachments_pulled, idle.attachments_pushed),
                (0, 0),
                "no double-import churn"
            );
        }

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    /// A re-add after a propagated deletion revives the entry (created_at >
    /// deleted_at) and re-uploads the body — the §11.4 rule-4 revival path,
    /// including the server-side un-tombstone CAS.
    #[test]
    fn attachment_readd_after_delete_revives() {
        let Some((_g, ta, tb, dir_a, dir_b, dev_a, dev_b, tok_a, tok_b)) =
            two_device_fixture("readd")
        else {
            eprintln!("SKIP attachment_readd_after_delete: myne-server not built");
            return;
        };
        let account_hash = {
            let d = protocol::compute_attachment_id(&ATT_ROOT, b"readd");
            let mut h = [0u8; 16];
            h.copy_from_slice(&d[..16]);
            h
        };

        let plaintext = b"deleted then deliberately re-imported";
        let id = seed_attachment(
            &dir_a,
            &ATT_ROOT,
            &account_hash,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
            plaintext,
            "phoenix.bin",
            1_000,
        );
        run_cycle_att(
            ta.as_ref(),
            &ATT_ROOT,
            account_hash,
            dev_a,
            &tok_a,
            &dir_a,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .unwrap();
        run_cycle_att(
            tb.as_ref(),
            &ATT_ROOT,
            account_hash,
            dev_b,
            &tok_b,
            &dir_b,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .unwrap();

        // Delete + propagate.
        delete_attachment_local(&dir_a, &ATT_ROOT, &account_hash, &id, 2_000);
        run_cycle_att(
            ta.as_ref(),
            &ATT_ROOT,
            account_hash,
            dev_a,
            &tok_a,
            &dir_a,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .unwrap();
        run_cycle_att(
            tb.as_ref(),
            &ATT_ROOT,
            account_hash,
            dev_b,
            &tok_b,
            &dir_b,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .unwrap();

        // Re-import on A with a LATER created_at (the deliberate re-add).
        let id2 = seed_attachment(
            &dir_a,
            &ATT_ROOT,
            &account_hash,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
            plaintext,
            "phoenix.bin",
            3_000,
        );
        assert_eq!(id, id2);
        let readd = run_cycle_att(
            ta.as_ref(),
            &ATT_ROOT,
            account_hash,
            dev_a,
            &tok_a,
            &dir_a,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .expect("A re-add cycle");
        assert_eq!(readd.attachments_pushed, 1, "A re-uploaded the body");

        // B revives: live entry wins the merge, body re-downloads.
        let pull = run_cycle_att(
            tb.as_ref(),
            &ATT_ROOT,
            account_hash,
            dev_b,
            &tok_b,
            &dir_b,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .expect("B revival cycle");
        assert_eq!(
            pull.attachments_pulled, 1,
            "B re-downloaded the revived body"
        );
        let cat_b = read_catalog_of(&dir_b, &ATT_ROOT, &account_hash);
        assert!(
            cat_b
                .entries
                .get(&hex(&id))
                .is_some_and(|e| !e.is_tombstone()),
            "B's entry is live again (created_at > deleted_at)"
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    // ---- F1 Faz B: vault.meta reconcile (sync_meta_phase) --------------------

    // ---- MYND-478: vault.prefs phase (sync_prefs_phase) ----------------------

    mod prefs_phase {
        // The parent module's seam shims (task 86).
        use super::{blocking, IO};

        use super::super::*;
        use crate::plugins::sync::prefs_merge::shared_subset_hash;
        use crate::plugins::sync::state::SyncState;
        use crate::plugins::sync::transport::FakeTransport;
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine as _;
        use protocol::PrefsView;

        const ROOT: [u8; 32] = [0x42; 32];
        const HASH: [u8; 16] = [0x33; 16];

        fn scratch(tag: &str) -> std::path::PathBuf {
            let d = std::env::temp_dir().join(format!(
                "myne-prefsphase-{tag}-{}-{:p}",
                std::process::id(),
                &tag
            ));
            std::fs::create_dir_all(&d).unwrap();
            d
        }

        fn prefs_key() -> zeroize::Zeroizing<[u8; 32]> {
            derive_subkey(&ROOT, SubkeyRole::PrefsKey)
        }

        fn write_local(dir: &Path, view: &PrefsView) {
            let bytes = protocol::encode_prefs_blob(&prefs_key(), &HASH, view).unwrap();
            std::fs::write(dir.join("vault.prefs"), &bytes).unwrap();
        }

        fn read_local(dir: &Path) -> PrefsView {
            let bytes = std::fs::read(dir.join("vault.prefs")).unwrap();
            protocol::decode_prefs_blob(&prefs_key(), &HASH, &bytes).unwrap()
        }

        /// Encode a remote view and register its blob under `/sync/blob?id=…`.
        fn serve_remote(t: &FakeTransport, pid: &[u8; 16], view: &PrefsView) -> ChangedBlob {
            let bytes = protocol::encode_prefs_blob(&prefs_key(), &HASH, view).unwrap();
            let nonce = read_prefs_nonce(&bytes).unwrap();
            let body = serde_json::json!({ "ciphertext_b64": B64.encode(&bytes) });
            t.on(
                HttpMethod::Get,
                &format!("/sync/blob?id={}", hex(pid)),
                200,
                serde_json::to_vec(&body).unwrap(),
            );
            ChangedBlob {
                id: *pid,
                content_nonce: nonce,
                version: 7,
                size: bytes.len(),
                attachment_id: None,
            }
        }

        // A server that has never held a prefs blob receives this device's
        // unconditionally — the §10.2.1 initial publish (even a default view).
        #[test]
        fn initial_publish_when_server_never_held_prefs() {
            let dir = scratch("initpub");
            write_local(&dir, &PrefsView::default());
            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let pid = prefs_sync_id(&ROOT);

            let phase = blocking(sync_prefs_phase(
                &IO, &t, "tok", &ROOT, &HASH, &dir, &mut st, &pid, None,
            ))
            .unwrap();
            assert!(phase.dirty, "never-synced server ⇒ initial publish");
            assert!(!phase.applied_remote);
            std::fs::remove_dir_all(&dir).ok();
        }

        // The push gate: a purely device-local edit (theme) re-encrypts the
        // blob but leaves the shared subset unchanged ⇒ NO push.
        #[test]
        fn device_local_change_generates_no_push() {
            let dir = scratch("gate");
            let themed = PrefsView {
                theme: Some(protocol::ThemeChoice::Dark),
                ..PrefsView::default()
            };
            write_local(&dir, &themed);
            let mut st = SyncState::default();
            let pid = prefs_sync_id(&ROOT);
            st.blobs.insert(
                hex(&pid),
                BlobSyncState {
                    version: 3,
                    content_nonce_hex: "00".repeat(24),
                },
            );
            // The synced baseline was the default view — whose SHARED subset
            // equals the themed view's (theme is device-local).
            set_prefs_gate_baseline(&dir, shared_subset_hash(&PrefsView::default()));
            let t = FakeTransport::new();

            let phase = blocking(sync_prefs_phase(
                &IO, &t, "tok", &ROOT, &HASH, &dir, &mut st, &pid, None,
            ))
            .unwrap();
            assert!(!phase.dirty, "device-local edit must not push");
            std::fs::remove_dir_all(&dir).ok();
        }

        // A shared-field edit (label) changes the shared-subset hash ⇒ push.
        #[test]
        fn shared_change_pushes() {
            let dir = scratch("shared");
            let mut labeled = PrefsView {
                label: Some("Renamed".into()),
                ..PrefsView::default()
            };
            labeled.field_clocks.insert("label".into(), 100);
            write_local(&dir, &labeled);
            let mut st = SyncState::default();
            let pid = prefs_sync_id(&ROOT);
            st.blobs.insert(
                hex(&pid),
                BlobSyncState {
                    version: 3,
                    content_nonce_hex: "00".repeat(24),
                },
            );
            set_prefs_gate_baseline(&dir, shared_subset_hash(&PrefsView::default()));
            let t = FakeTransport::new();

            let phase = blocking(sync_prefs_phase(
                &IO, &t, "tok", &ROOT, &HASH, &dir, &mut st, &pid, None,
            ))
            .unwrap();
            assert!(phase.dirty, "shared edit must push");
            std::fs::remove_dir_all(&dir).ok();
        }

        // A remote rename lands: merged into the on-disk view (device-local
        // theme preserved), applied_remote=true, and NO re-push — the server
        // already carries the merged shared subset (the anti-ping-pong rule).
        #[test]
        fn remote_rename_merges_applies_and_does_not_repush() {
            let dir = scratch("remote");
            let themed = PrefsView {
                theme: Some(protocol::ThemeChoice::Dark),
                ..PrefsView::default()
            };
            write_local(&dir, &themed);
            let mut st = SyncState::default();
            let pid = prefs_sync_id(&ROOT);
            let t = FakeTransport::new();
            let mut remote = PrefsView {
                label: Some("From Peer".into()),
                ..PrefsView::default()
            };
            remote.field_clocks.insert("label".into(), 500);
            let rec = serve_remote(&t, &pid, &remote);

            let phase = blocking(sync_prefs_phase(
                &IO,
                &t,
                "tok",
                &ROOT,
                &HASH,
                &dir,
                &mut st,
                &pid,
                Some(&rec),
            ))
            .unwrap();
            assert!(phase.applied_remote, "remote rename must apply");
            assert!(!phase.dirty, "shared subsets agree ⇒ no re-push");
            let on_disk = read_local(&dir);
            assert_eq!(on_disk.label.as_deref(), Some("From Peer"));
            assert_eq!(
                on_disk.theme,
                Some(protocol::ThemeChoice::Dark),
                "device-local theme survives the merge"
            );
            assert_eq!(
                st.blobs.get(&hex(&pid)).map(|b| b.version),
                Some(7),
                "server revision recorded as baseline"
            );
            // Second cycle against the SAME server record: already reconciled
            // (baseline nonce) ⇒ no download, no dirt, no ping-pong.
            let phase2 = blocking(sync_prefs_phase(
                &IO,
                &t,
                "tok",
                &ROOT,
                &HASH,
                &dir,
                &mut st,
                &pid,
                Some(&rec),
            ))
            .unwrap();
            assert!(!phase2.dirty);
            assert!(!phase2.applied_remote);
            std::fs::remove_dir_all(&dir).ok();
        }

        // Enrollment wholesale seed: a VIRGIN vault (no vault.prefs on disk —
        // the just-joined state) adopts the server blob VERBATIM, device-local
        // fields included as starting defaults (Q3/Q7), and never re-seeds.
        #[test]
        fn virgin_vault_seeds_wholesale_from_server() {
            let dir = scratch("seed");
            // NO local vault.prefs — the just-joined-device state.
            let mut st = SyncState::default();
            let pid = prefs_sync_id(&ROOT);
            let t = FakeTransport::new();
            let mut remote = PrefsView {
                label: Some("Vault Identity".into()),
                theme: Some(protocol::ThemeChoice::Dark), // device-local!
                ..PrefsView::default()
            };
            remote.field_clocks.insert("label".into(), 900);
            let rec = serve_remote(&t, &pid, &remote);

            let phase = blocking(sync_prefs_phase(
                &IO,
                &t,
                "tok",
                &ROOT,
                &HASH,
                &dir,
                &mut st,
                &pid,
                Some(&rec),
            ))
            .unwrap();
            assert!(phase.applied_remote);
            assert!(!phase.dirty, "a seed adopts; it never pushes");
            let seeded = read_local(&dir);
            assert_eq!(seeded, remote, "wholesale: device-local theme included");
            // Second cycle against the same record: file exists + baseline
            // matches ⇒ no re-seed, no download loop.
            let phase2 = blocking(sync_prefs_phase(
                &IO,
                &t,
                "tok",
                &ROOT,
                &HASH,
                &dir,
                &mut st,
                &pid,
                Some(&rec),
            ))
            .unwrap();
            assert!(!phase2.applied_remote);
            assert!(!phase2.dirty);
            std::fs::remove_dir_all(&dir).ok();
        }

        // A virgin vault against an EMPTY server proceeds on defaults — no
        // crash, no seed, and the initial-publish intent registers as dirty.
        #[test]
        fn virgin_vault_with_empty_server_proceeds_on_defaults() {
            let dir = scratch("seedempty");
            let mut st = SyncState::default();
            let pid = prefs_sync_id(&ROOT);
            let t = FakeTransport::new();

            let phase = blocking(sync_prefs_phase(
                &IO, &t, "tok", &ROOT, &HASH, &dir, &mut st, &pid, None,
            ))
            .unwrap();
            assert!(!phase.applied_remote);
            assert!(phase.dirty, "never-synced ⇒ initial-publish intent");
            assert!(
                !dir.join("vault.prefs").exists(),
                "no file invented; defaults apply in RAM"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // Poisoned-gate regression (re-review I7): an UNSYNCED shared edit +
        // app restart (RAM baseline lost) + an unchanged server record must
        // still push. The self-heal may only adopt the gate baseline when the
        // local blob is provably the server's bytes — healing from the edited
        // view would silently withhold the rename from the fleet forever.
        #[test]
        fn unsynced_shared_edit_survives_a_restart() {
            let dir = scratch("restartpush");
            // The synced state was the default view under nonce 0x11…;
            // the user then renamed (re-encrypt, fresh nonce) and the app
            // restarted before any cycle ran (fresh scratch dir ⇒ empty RAM
            // baseline).
            let mut labeled = PrefsView {
                label: Some("Renamed Before Restart".into()),
                ..PrefsView::default()
            };
            labeled.field_clocks.insert("label".into(), 100);
            write_local(&dir, &labeled);
            let mut st = SyncState::default();
            let pid = prefs_sync_id(&ROOT);
            let synced_nonce = [0x11u8; 24];
            st.blobs.insert(
                hex(&pid),
                BlobSyncState {
                    version: 3,
                    content_nonce_hex: hex(&synced_nonce),
                },
            );
            // Server unchanged: its record still carries the synced nonce.
            let rec = ChangedBlob {
                id: pid,
                content_nonce: synced_nonce,
                version: 3,
                size: 0,
                attachment_id: None,
            };
            let t = FakeTransport::new();

            let phase = blocking(sync_prefs_phase(
                &IO,
                &t,
                "tok",
                &ROOT,
                &HASH,
                &dir,
                &mut st,
                &pid,
                Some(&rec),
            ))
            .unwrap();
            assert!(
                phase.dirty,
                "the unsynced rename must push despite the lost RAM baseline"
            );
            assert!(!phase.applied_remote);
            std::fs::remove_dir_all(&dir).ok();
        }

        // Concurrent shared edits on both sides: the merge beats the server's
        // shared subset (local newer label survives + remote icon adopted) ⇒
        // write fresh + push against the server's version.
        #[test]
        fn concurrent_shared_edits_merge_and_push() {
            let dir = scratch("concurrent");
            let mut local = PrefsView {
                label: Some("Local Wins".into()),
                ..PrefsView::default()
            };
            local.field_clocks.insert("label".into(), 200);
            write_local(&dir, &local);
            let mut st = SyncState::default();
            let pid = prefs_sync_id(&ROOT);
            let t = FakeTransport::new();
            let mut remote = PrefsView {
                label: Some("Remote Loses".into()),
                icon: Some("book".into()),
                ..PrefsView::default()
            };
            remote.field_clocks.insert("label".into(), 100);
            remote.field_clocks.insert("icon".into(), 300);
            let rec = serve_remote(&t, &pid, &remote);

            let phase = blocking(sync_prefs_phase(
                &IO,
                &t,
                "tok",
                &ROOT,
                &HASH,
                &dir,
                &mut st,
                &pid,
                Some(&rec),
            ))
            .unwrap();
            assert!(phase.dirty, "merge beat the server ⇒ push");
            assert!(phase.applied_remote, "remote icon landed locally");
            let on_disk = read_local(&dir);
            assert_eq!(on_disk.label.as_deref(), Some("Local Wins"));
            assert_eq!(on_disk.icon.as_deref(), Some("book"));
            assert_eq!(on_disk.field_clocks.get("label"), Some(&200));
            assert_eq!(on_disk.field_clocks.get("icon"), Some(&300));
            std::fs::remove_dir_all(&dir).ok();
        }

        // ---- MYND-635: color groups across two devices ----------------------
        //
        // The criterion these serve is task 7's "rules … appear on a second
        // synced device". The restart half is proven by the desktop E2E
        // (`gc2`); this is the OTHER device. What makes a `FakeTransport`
        // faithful here rather than a stand-in: `run_sync_cycle`'s
        // `prefs_phase.dirty` arm uploads `io.read(vault_root/"vault.prefs")`
        // VERBATIM — the pushed ciphertext IS the author's on-disk blob — and
        // the server is a zero-knowledge relay that cannot read or alter it.
        // So serving device A's actual file bytes as B's server record models
        // the wire payload exactly; only the socket is faked, and the response
        // is parsed by the same `download_blob_backoff` + codec production
        // uses. `prefs_merge`'s tests cover the merge algebra in isolation;
        // these cover the phase that carries it between two vault dirs.

        /// Register ALREADY-ENCODED bytes (a peer's on-disk blob, which is
        /// verbatim what the push path uploads) as the server's record.
        fn serve_remote_raw(
            t: &FakeTransport,
            pid: &[u8; 16],
            bytes: &[u8],
            version: u64,
        ) -> ChangedBlob {
            let nonce = read_prefs_nonce(bytes).unwrap();
            let body = serde_json::json!({ "ciphertext_b64": B64.encode(bytes) });
            t.on(
                HttpMethod::Get,
                &format!("/sync/blob?id={}", hex(pid)),
                200,
                serde_json::to_vec(&body).unwrap(),
            );
            ChangedBlob {
                id: *pid,
                content_nonce: nonce,
                version,
                size: bytes.len(),
                attachment_id: None,
            }
        }

        /// Two ordered rules exercising both v1 filter leaves, one of them
        /// DISABLED — a disabled rule is retained, so it must cross the wire
        /// too or re-enabling it on the peer loses the authoring work.
        fn authored_rules() -> Vec<protocol::ColorGroup> {
            use protocol::{ColorGroup, FilterNode};
            vec![
                ColorGroup {
                    id: "g-first".into(),
                    name: "Work".into(),
                    color: "group-teal".into(),
                    enabled: true,
                    filter: FilterNode::HasTag { tag: "work".into() },
                },
                ColorGroup {
                    id: "g-second".into(),
                    name: "Archive".into(),
                    color: "group-rose".into(),
                    enabled: false,
                    filter: FilterNode::InFolder {
                        path: "Archive/2026".into(),
                    },
                },
            ]
        }

        // Device A authors color groups; device B receives them. A's push
        // registers as dirty, and B's phase lands A's EXACT blob bytes: same
        // rules, same precedence order, same disabled flag, same filter ASTs —
        // while B's own device-local tuning survives untouched.
        #[test]
        fn color_groups_authored_on_device_a_land_on_device_b() {
            let dir_a = scratch("cgdevA");
            let dir_b = scratch("cgdevB");
            let pid = prefs_sync_id(&ROOT);

            // --- Device A: author the rules, then run its phase against a
            // server that has never held prefs → the §10.2.1 initial publish.
            let mut a = PrefsView {
                color_groups: authored_rules(),
                ..PrefsView::default()
            };
            a.field_clocks.insert("color_groups".into(), 1_000);
            write_local(&dir_a, &a);
            let mut st_a = SyncState::default();
            let t_a = FakeTransport::new();
            let phase_a = blocking(sync_prefs_phase(
                &IO, &t_a, "tok", &ROOT, &HASH, &dir_a, &mut st_a, &pid, None,
            ))
            .unwrap();
            assert!(phase_a.dirty, "A must push its newly authored rules");

            // The bytes `run_sync_cycle` would upload for A, read the same way.
            let pushed = std::fs::read(dir_a.join("vault.prefs")).unwrap();

            // --- Device B: an already-synced device with no color groups and
            // its own device-local theme.
            let b_before = PrefsView {
                theme: Some(protocol::ThemeChoice::Dark),
                ..PrefsView::default()
            };
            write_local(&dir_b, &b_before);
            let mut st_b = SyncState::default();
            st_b.blobs.insert(
                hex(&pid),
                BlobSyncState {
                    version: 3,
                    content_nonce_hex: "00".repeat(24),
                },
            );
            set_prefs_gate_baseline(&dir_b, shared_subset_hash(&PrefsView::default()));
            let t_b = FakeTransport::new();
            let rec = serve_remote_raw(&t_b, &pid, &pushed, 8);

            let phase_b = blocking(sync_prefs_phase(
                &IO,
                &t_b,
                "tok",
                &ROOT,
                &HASH,
                &dir_b,
                &mut st_b,
                &pid,
                Some(&rec),
            ))
            .unwrap();
            assert!(phase_b.applied_remote, "A's rules must land on B");
            assert!(
                !phase_b.dirty,
                "B adopted a shared subset it already agrees with ⇒ no ping-pong re-push"
            );

            // B's DISK is the assertion — the peer reads its rules back from
            // the blob it persisted, not from the merge's return value.
            let on_b = read_local(&dir_b);
            assert_eq!(
                on_b.color_groups,
                authored_rules(),
                "every field of every rule, in authoring order (= precedence)"
            );
            assert_eq!(
                on_b.color_groups
                    .iter()
                    .map(|g| g.id.as_str())
                    .collect::<Vec<_>>(),
                vec!["g-first", "g-second"],
                "precedence order survives the wire; never re-sorted by id"
            );
            assert!(!on_b.color_groups[1].enabled, "a disabled rule is retained");
            assert_eq!(on_b.field_clocks.get("color_groups"), Some(&1_000));
            assert_eq!(
                on_b.theme,
                Some(protocol::ThemeChoice::Dark),
                "B's device-local theme is not overwritten by A's vault content"
            );

            std::fs::remove_dir_all(&dir_a).ok();
            std::fs::remove_dir_all(&dir_b).ok();
        }

        // …and back the other way: B edits the list it just received and A
        // converges on B's version. The reverse leg is a separate claim —
        // `color_groups` is `Shared(WholeValueLww)`, so the peer that edits
        // second must WIN on the author, not merge into a hybrid list.
        #[test]
        fn a_color_group_edited_on_device_b_converges_back_onto_device_a() {
            let dir_a = scratch("cgbackA");
            let dir_b = scratch("cgbackB");
            let pid = prefs_sync_id(&ROOT);

            // A holds the authored list (clock 1_000).
            let mut a = PrefsView {
                color_groups: authored_rules(),
                ..PrefsView::default()
            };
            a.field_clocks.insert("color_groups".into(), 1_000);
            write_local(&dir_a, &a);

            // B edits it: reorders (precedence change), renames the first rule
            // and re-enables the second — under a newer clock.
            let mut edited = authored_rules();
            edited.swap(0, 1);
            edited[0].enabled = true;
            edited[1].name = "Work Notes".into();
            let mut b = PrefsView {
                color_groups: edited.clone(),
                theme: Some(protocol::ThemeChoice::Dark),
                ..PrefsView::default()
            };
            b.field_clocks.insert("color_groups".into(), 2_000);
            write_local(&dir_b, &b);
            let b_bytes = std::fs::read(dir_b.join("vault.prefs")).unwrap();

            // A pulls B's blob.
            let mut st_a = SyncState::default();
            st_a.blobs.insert(
                hex(&pid),
                BlobSyncState {
                    version: 3,
                    content_nonce_hex: "00".repeat(24),
                },
            );
            set_prefs_gate_baseline(&dir_a, shared_subset_hash(&a));
            let t_a = FakeTransport::new();
            let rec = serve_remote_raw(&t_a, &pid, &b_bytes, 9);

            let phase = blocking(sync_prefs_phase(
                &IO,
                &t_a,
                "tok",
                &ROOT,
                &HASH,
                &dir_a,
                &mut st_a,
                &pid,
                Some(&rec),
            ))
            .unwrap();
            assert!(phase.applied_remote, "B's newer edit must land on A");

            let on_a = read_local(&dir_a);
            assert_eq!(
                on_a.color_groups, edited,
                "whole-value LWW: A adopts B's list entire, never a hybrid"
            );
            assert_eq!(
                on_a.color_groups
                    .iter()
                    .map(|g| g.id.as_str())
                    .collect::<Vec<_>>(),
                vec!["g-second", "g-first"],
                "the reordered precedence is what converged"
            );
            assert_eq!(on_a.field_clocks.get("color_groups"), Some(&2_000));
            assert_eq!(
                on_a.theme, None,
                "B's device-local theme did NOT travel to A"
            );

            std::fs::remove_dir_all(&dir_a).ok();
            std::fs::remove_dir_all(&dir_b).ok();
        }

        // A stale peer cannot resurrect deleted rules. The delete is the case
        // the codec bug found last turn lived in, and it is the one an LWW
        // field gets wrong most easily: an empty list is omitted from the
        // blob, so "absent" must read as "cleared under clock 3_000", not as
        // "this device has nothing to say".
        #[test]
        fn deleting_every_rule_on_one_device_deletes_them_on_the_other() {
            let dir_a = scratch("cgdelA");
            let pid = prefs_sync_id(&ROOT);

            // A still holds the rules under the OLD clock.
            let mut a = PrefsView {
                label: Some("Keep Me".into()),
                color_groups: authored_rules(),
                ..PrefsView::default()
            };
            a.field_clocks.insert("color_groups".into(), 1_000);
            a.field_clocks.insert("label".into(), 50);
            write_local(&dir_a, &a);

            // B cleared the list under a NEWER clock and pushed that.
            let mut b = PrefsView::default();
            b.field_clocks.insert("color_groups".into(), 3_000);
            let cleared_bytes = protocol::encode_prefs_blob(&prefs_key(), &HASH, &b).unwrap();

            let mut st_a = SyncState::default();
            st_a.blobs.insert(
                hex(&pid),
                BlobSyncState {
                    version: 3,
                    content_nonce_hex: "00".repeat(24),
                },
            );
            set_prefs_gate_baseline(&dir_a, shared_subset_hash(&a));
            let t_a = FakeTransport::new();
            let rec = serve_remote_raw(&t_a, &pid, &cleared_bytes, 11);

            blocking(sync_prefs_phase(
                &IO,
                &t_a,
                "tok",
                &ROOT,
                &HASH,
                &dir_a,
                &mut st_a,
                &pid,
                Some(&rec),
            ))
            .unwrap();

            let on_a = read_local(&dir_a);
            assert!(
                on_a.color_groups.is_empty(),
                "the peer's delete wins; rules do not come back"
            );
            // The neighbour-field guard from last turn's decoder bug: a view
            // that collapsed to defaults would ALSO show an empty list, so
            // assert something else survived the read.
            assert_eq!(
                on_a.label.as_deref(),
                Some("Keep Me"),
                "the rest of the preference set is intact (not a defaults fallback)"
            );

            std::fs::remove_dir_all(&dir_a).ok();
        }
    }

    // ---- MYND-486: vault.themes phase (sync_themes_phase) --------------------

    mod themes_phase {
        // The parent module's seam shims (task 86).
        use super::{blocking, IO};

        use super::super::*;
        use crate::plugins::sync::state::SyncState;
        use crate::plugins::sync::transport::FakeTransport;
        use crate::plugins::themes::commands::{
            encode_themes_map, ThemeEntry, ThemePalette, ThemesMap,
        };
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine as _;

        const ROOT: [u8; 32] = [0x42; 32];
        const HASH: [u8; 16] = [0x33; 16];
        const T0: u64 = 1_700_000_000;

        fn scratch(tag: &str) -> std::path::PathBuf {
            let d = std::env::temp_dir().join(format!(
                "myne-themesphase-{tag}-{}-{:p}",
                std::process::id(),
                &tag
            ));
            std::fs::create_dir_all(&d).unwrap();
            d
        }

        fn themes_key() -> zeroize::Zeroizing<[u8; 32]> {
            derive_subkey(&ROOT, SubkeyRole::CustomThemesKey)
        }

        fn theme(name: &str, accent: &str, now: u64) -> (String, ThemeEntry) {
            (
                name.to_string(),
                ThemeEntry::live(
                    ThemePalette::from([("--accent".into(), accent.into())]),
                    now,
                ),
            )
        }

        fn write_local(dir: &Path, map: &ThemesMap) {
            let bytes = encode_themes_map(&themes_key(), &HASH, map).unwrap();
            std::fs::write(dir.join("vault.themes"), &bytes).unwrap();
        }

        fn read_local(dir: &Path) -> ThemesMap {
            let bytes = std::fs::read(dir.join("vault.themes")).unwrap();
            crate::plugins::themes::commands::decode_themes_map_or_empty(
                &themes_key(),
                &HASH,
                Some(&bytes),
            )
        }

        /// Encode a remote store and register its blob under `/sync/blob?id=…`.
        fn serve_remote(t: &FakeTransport, tid: &[u8; 16], map: &ThemesMap) -> ChangedBlob {
            let bytes = encode_themes_map(&themes_key(), &HASH, map).unwrap();
            let nonce = read_themes_nonce(&bytes).unwrap();
            let body = serde_json::json!({ "ciphertext_b64": B64.encode(&bytes) });
            t.on(
                HttpMethod::Get,
                &format!("/sync/blob?id={}", hex(tid)),
                200,
                serde_json::to_vec(&body).unwrap(),
            );
            ChangedBlob {
                id: *tid,
                content_nonce: nonce,
                version: 7,
                size: bytes.len(),
                attachment_id: None,
            }
        }

        // The themes sync-id is the reserved DeriveSubkey(root, "themes-sync-id")
        // [0..16] — deterministic across the fleet and distinct from the sibling
        // singletons' ids (a collision would merge two blob families).
        #[test]
        fn themes_sync_id_is_deterministic_and_distinct() {
            assert_eq!(themes_sync_id(&ROOT), themes_sync_id(&ROOT));
            assert_ne!(themes_sync_id(&ROOT), prefs_sync_id(&ROOT));
            assert_ne!(themes_sync_id(&ROOT), catalog_sync_id(&ROOT));
            assert_ne!(themes_sync_id(&ROOT), themes_sync_id(&[0x11; 32]));
        }

        // A theme-less vault stays themes-silent: no local blob, no server
        // record ⇒ nothing to push (no §10.2.1-style initial publish here —
        // vault.themes carries no vault identity a joiner needs).
        #[test]
        fn virgin_store_is_not_pushed() {
            let dir = scratch("virgin");
            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let tid = themes_sync_id(&ROOT);

            let phase = blocking(sync_themes_phase(
                &IO, &t, "tok", &ROOT, &HASH, &dir, &mut st, &tid, None,
            ))
            .unwrap();
            assert!(!phase.dirty, "a theme-less vault generates no traffic");
            assert!(!phase.applied_remote);
            std::fs::remove_dir_all(&dir).ok();
        }

        // A local import the server has never seen ⇒ push.
        #[test]
        fn local_only_theme_is_dirty() {
            let dir = scratch("localonly");
            write_local(&dir, &ThemesMap::from([theme("nord", "#88c0d0", T0)]));
            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let tid = themes_sync_id(&ROOT);

            let phase = blocking(sync_themes_phase(
                &IO, &t, "tok", &ROOT, &HASH, &dir, &mut st, &tid, None,
            ))
            .unwrap();
            assert!(phase.dirty, "an unsynced local theme must push");
            std::fs::remove_dir_all(&dir).ok();
        }

        // The push gate: a local blob whose nonce still equals the synced
        // baseline's is provably untouched since the last sync ⇒ no push.
        #[test]
        fn unchanged_local_blob_generates_no_push() {
            let dir = scratch("clean");
            let map = ThemesMap::from([theme("nord", "#88c0d0", T0)]);
            write_local(&dir, &map);
            let nonce = read_themes_nonce(&std::fs::read(dir.join("vault.themes")).unwrap())
                .expect("MYT1 nonce");
            let mut st = SyncState::default();
            let tid = themes_sync_id(&ROOT);
            st.blobs.insert(
                hex(&tid),
                BlobSyncState {
                    version: 3,
                    content_nonce_hex: hex(&nonce),
                },
            );
            let t = FakeTransport::new();

            let phase = blocking(sync_themes_phase(
                &IO, &t, "tok", &ROOT, &HASH, &dir, &mut st, &tid, None,
            ))
            .unwrap();
            assert!(!phase.dirty, "byte-untouched blob must not push");
            std::fs::remove_dir_all(&dir).ok();
        }

        // A concurrent add on each side: the merge keeps BOTH themes, beats the
        // server's store ⇒ written fresh + pushed this cycle, with the server's
        // version recorded as the CAS base.
        #[test]
        fn concurrent_adds_merge_and_push() {
            let dir = scratch("merge");
            write_local(&dir, &ThemesMap::from([theme("nord", "#88c0d0", T0)]));
            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let tid = themes_sync_id(&ROOT);
            let remote = ThemesMap::from([theme("solarized", "#268bd2", T0 + 1)]);
            let rec = serve_remote(&t, &tid, &remote);

            let phase = blocking(sync_themes_phase(
                &IO,
                &t,
                "tok",
                &ROOT,
                &HASH,
                &dir,
                &mut st,
                &tid,
                Some(&rec),
            ))
            .unwrap();
            assert!(phase.dirty, "merge beat the server ⇒ push");
            assert!(phase.applied_remote, "the peer's theme landed locally");
            let on_disk = read_local(&dir);
            assert_eq!(on_disk.len(), 2, "both themes survive");
            assert!(on_disk.contains_key("nord"));
            assert!(on_disk.contains_key("solarized"));
            // The server's revision is the CAS base for this cycle's push.
            assert_eq!(st.blobs[&hex(&tid)].version, 7);
            std::fs::remove_dir_all(&dir).ok();
        }

        // The merge equals the remote (a virgin device pulling a peer's store):
        // adopt the server bytes VERBATIM — re-encrypting would nonce-churn an
        // endless push loop.
        #[test]
        fn merge_equal_to_remote_adopts_server_bytes_verbatim() {
            let dir = scratch("adopt");
            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let tid = themes_sync_id(&ROOT);
            let remote = ThemesMap::from([theme("nord", "#88c0d0", T0)]);
            let rec = serve_remote(&t, &tid, &remote);

            let phase = blocking(sync_themes_phase(
                &IO,
                &t,
                "tok",
                &ROOT,
                &HASH,
                &dir,
                &mut st,
                &tid,
                Some(&rec),
            ))
            .unwrap();
            assert!(!phase.dirty, "adopting the server's bytes pushes nothing");
            assert!(phase.applied_remote);
            assert_eq!(read_local(&dir), remote);
            // Baseline == the server's exact revision (version + nonce), so the
            // next cycle sees the blob as clean.
            let on_disk_nonce =
                read_themes_nonce(&std::fs::read(dir.join("vault.themes")).unwrap()).unwrap();
            assert_eq!(st.blobs[&hex(&tid)].content_nonce_hex, hex(&on_disk_nonce));
            assert_eq!(st.blobs[&hex(&tid)].version, 7);
            std::fs::remove_dir_all(&dir).ok();
        }

        // A remote delete vs a stale local live copy: the tombstone wins the
        // merge (no resurrection) and the theme leaves the local list.
        #[test]
        fn remote_tombstone_applies_locally_without_resurrection() {
            let dir = scratch("tomb");
            write_local(&dir, &ThemesMap::from([theme("nord", "#88c0d0", T0)]));
            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let tid = themes_sync_id(&ROOT);
            let (name, entry) = theme("nord", "#88c0d0", T0);
            let remote = ThemesMap::from([(name, entry.into_tombstone(T0 + 10))]);
            let rec = serve_remote(&t, &tid, &remote);

            let phase = blocking(sync_themes_phase(
                &IO,
                &t,
                "tok",
                &ROOT,
                &HASH,
                &dir,
                &mut st,
                &tid,
                Some(&rec),
            ))
            .unwrap();
            assert!(phase.applied_remote, "the peer's delete landed");
            let on_disk = read_local(&dir);
            assert!(
                on_disk["nord"].is_tombstone(),
                "the local live copy did NOT resurrect the theme"
            );
            assert!(
                // The themes list moved onto the IO seam (phase3-web-client
                // task 45), so this sync-side assertion drives it through the
                // native arm rather than through `std::fs` directly.
                crate::test_support::block_on(
                    crate::plugins::themes::commands::themes_list_in_dir(
                        &crate::vault_io::StdVaultIo,
                        &dir,
                        &themes_key(),
                        &HASH,
                    )
                )
                .is_empty(),
                "a tombstoned theme is gone from the user's list"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // A hostile/corrupt remote store collapses to empty (§9.21.4):
        // merge(local, empty) == local, so nothing is lost and the local store
        // re-pushes over it.
        #[test]
        fn corrupt_remote_store_loses_nothing() {
            let dir = scratch("hostile");
            let local = ThemesMap::from([theme("nord", "#88c0d0", T0)]);
            write_local(&dir, &local);
            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let tid = themes_sync_id(&ROOT);
            let body = serde_json::json!({ "ciphertext_b64": B64.encode(b"not a MYT1 blob") });
            t.on(
                HttpMethod::Get,
                &format!("/sync/blob?id={}", hex(&tid)),
                200,
                serde_json::to_vec(&body).unwrap(),
            );
            let rec = ChangedBlob {
                id: tid,
                content_nonce: [0x9e; 24],
                version: 7,
                size: 15,
                attachment_id: None,
            };

            let phase = blocking(sync_themes_phase(
                &IO,
                &t,
                "tok",
                &ROOT,
                &HASH,
                &dir,
                &mut st,
                &tid,
                Some(&rec),
            ))
            .unwrap();
            assert!(phase.dirty, "the local store re-pushes over the garbage");
            assert_eq!(read_local(&dir), local, "nothing lost");
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    mod meta_phase {
        // The parent module's seam shims, re-exported into this nested one.
        use super::{blocking, IO};

        use super::super::*;
        use crate::plugins::sync::state::{mark_vault_meta_dirty, vault_meta_is_dirty, SyncState};
        use crate::plugins::sync::transport::{FakeTransport, HttpMethod};
        use protocol::{
            serialize_vault_meta, VaultMeta, VAULT_META_ITEMS_KEY_ID_LEN, VAULT_META_NONCE_LEN,
            VAULT_META_SALT_RANDOM_LEN, VAULT_META_WRAPPED_ITEMS_KEY_LEN,
            VAULT_META_WRAPPED_ROOT_KEY_LEN,
        };

        // A vault.meta with a given password-side marker. Recovery-side, KDF, and
        // the itemsKey wrap are FIXED (the cross-device invariants) so two of these
        // differ only in the password-side wrap — exactly a password change.
        fn meta_bytes(pw: u8) -> Vec<u8> {
            let m = VaultMeta {
                account_number_hash: [0x33; 16],
                kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
                random_salt_password: [pw; VAULT_META_SALT_RANDOM_LEN],
                random_salt_recovery: [0x55; VAULT_META_SALT_RANDOM_LEN],
                nonce_password_wrap: [pw; VAULT_META_NONCE_LEN],
                enc_root_key_password: [pw; VAULT_META_WRAPPED_ROOT_KEY_LEN],
                nonce_recovery_wrap: [0x55; VAULT_META_NONCE_LEN],
                enc_root_key_recovery: [0x55; VAULT_META_WRAPPED_ROOT_KEY_LEN],
                items_key_id: [0x07; VAULT_META_ITEMS_KEY_ID_LEN],
                items_key_nonce: [0x08; VAULT_META_NONCE_LEN],
                enc_items_key: [0x09; VAULT_META_WRAPPED_ITEMS_KEY_LEN],
            };
            serialize_vault_meta(&m).to_vec()
        }

        fn scratch(tag: &str) -> std::path::PathBuf {
            let d = std::env::temp_dir().join(format!(
                "myne-metaphase-{tag}-{}-{:p}",
                std::process::id(),
                &tag
            ));
            std::fs::create_dir_all(&d).unwrap();
            d
        }

        fn put_recorded(t: &FakeTransport) -> Vec<Vec<u8>> {
            t.requests()
                .into_iter()
                .filter(|(m, p, _, _, _)| *m == HttpMethod::Put && p == "/vault.meta")
                .map(|(_, _, body, _, _)| body)
                .collect()
        }

        /// The silent-revert trap (phase3-web-client task 88).
        ///
        /// `sync-state.json` and `vault.meta-dirty` live in the same evictable
        /// OPFS container, so a browser eviction or a torn sidecar write loses
        /// them TOGETHER. `local_changed` then computes `false` (no dirty marker,
        /// and the baseline clause is guarded by `baseline.is_some()`) while
        /// `server_changed` computes `true` — and the adopt branch overwrites the
        /// local `vault.meta` with the server's older copy.
        ///
        /// What the user sees: the password they just changed stops working and
        /// the old one starts working again, with no error anywhere. On the web
        /// client there is no recovery phrase by settled decision, so the only
        /// remedy is a native client with a password they have just been told is
        /// no longer theirs.
        #[test]
        fn refuses_to_adopt_a_differing_credential_when_no_baseline_says_which_moved() {
            let dir = scratch("ambiguous");
            let local = meta_bytes(0xAA); // this device's NEW password wrap
            let server = meta_bytes(0xBB); // the server's older one
            std::fs::write(dir.join("vault.meta"), &local).unwrap();
            // The post-eviction state: no baseline, no dirty marker.
            let mut st = SyncState::default();
            let t = FakeTransport::new();
            t.on(HttpMethod::Get, "/vault.meta", 200, server.clone());

            let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true));

            assert_eq!(out, MetaPhaseOutcome::CredentialAmbiguous);
            assert_eq!(
                std::fs::read(dir.join("vault.meta")).unwrap(),
                local,
                "the local credential must survive an unresolvable disagreement"
            );
            assert!(
                st.meta_baseline_hex.is_none(),
                "refusing must not invent a baseline — that would make the NEXT cycle adopt"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        /// The other half, and the reason the guard is scoped to the password
        /// side. An absent baseline with an IDENTICAL password wrap is ordinary —
        /// another device changed something this one holds no opinion about — and
        /// refusing there would stall propagation for no safety gain.
        #[test]
        fn an_absent_baseline_still_adopts_when_the_credential_is_unchanged() {
            let dir = scratch("ambiguous-same-pw");
            // Same password side, different elsewhere: only the recovery-side
            // bytes are varied here, which `merge_vault_meta` treats as a hard
            // divergence — so this asserts the guard did not fire, via the
            // outcome it DOES produce rather than by adopting something the
            // merge would refuse.
            let local = meta_bytes(0xAA);
            std::fs::write(dir.join("vault.meta"), &local).unwrap();
            let mut st = SyncState::default();
            let t = FakeTransport::new();
            // Identical bytes → the early "already agree" return, which proves
            // the guard is not reached for an unchanged credential.
            t.on(HttpMethod::Get, "/vault.meta", 200, local.clone());

            let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true));
            assert_eq!(out, MetaPhaseOutcome::NoChange);
            assert_eq!(st.meta_baseline_hex, Some(sha256_hex(&local)));
            std::fs::remove_dir_all(&dir).ok();
        }

        // Device B holds an old meta, made NO local change; the server carries a
        // newer password-side (device A changed it). B must ADOPT it: the local
        // file becomes the server bytes, and no PUT is sent.
        #[test]
        fn adopts_remote_change_when_not_dirty() {
            let dir = scratch("adopt");
            let local = meta_bytes(0xAA);
            let server = meta_bytes(0xBB);
            std::fs::write(dir.join("vault.meta"), &local).unwrap();
            // Baseline = the local we last synced (so "server changed, I didn't").
            let mut st = SyncState {
                meta_baseline_hex: Some(sha256_hex(&local)),
                ..Default::default()
            };
            let t = FakeTransport::new();
            t.on(HttpMethod::Get, "/vault.meta", 200, server.clone());

            let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true));
            assert_eq!(out, MetaPhaseOutcome::Adopted);
            assert_eq!(
                std::fs::read(dir.join("vault.meta")).unwrap(),
                server,
                "B adopts the server's newer meta verbatim"
            );
            assert_eq!(st.meta_baseline_hex, Some(sha256_hex(&server)));
            assert!(put_recorded(&t).is_empty(), "adoption pushes nothing");
            std::fs::remove_dir_all(&dir).ok();
        }

        // Device A changed its password (dirty); the server still holds the old
        // meta (== baseline). A must PUSH its local meta and clear the marker.
        #[test]
        fn pushes_local_change_when_only_i_changed() {
            let dir = scratch("push");
            let baseline = meta_bytes(0xAA); // what the server still has
            let local = meta_bytes(0xCC); // A's new password-side
            std::fs::write(dir.join("vault.meta"), &local).unwrap();
            blocking(mark_vault_meta_dirty(&IO, &dir)).unwrap();
            let mut st = SyncState {
                meta_baseline_hex: Some(sha256_hex(&baseline)),
                ..Default::default()
            };
            let t = FakeTransport::new();
            t.on(HttpMethod::Get, "/vault.meta", 200, baseline);
            t.on(HttpMethod::Put, "/vault.meta", 200, Vec::new());

            let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true));
            assert_eq!(out, MetaPhaseOutcome::Pushed);
            let puts = put_recorded(&t);
            assert_eq!(puts.len(), 1);
            assert_eq!(puts[0], local, "A pushes its own new meta");
            assert_eq!(st.meta_baseline_hex, Some(sha256_hex(&local)));
            assert!(
                !blocking(vault_meta_is_dirty(&IO, &dir)),
                "dirty cleared after a successful push"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // A poll cycle (allow_push=false) with a pending local change must NOT push
        // yet — it keeps the dirty marker for a later push cycle.
        #[test]
        fn poll_cycle_defers_push_and_keeps_dirty() {
            let dir = scratch("poll");
            let baseline = meta_bytes(0xAA);
            let local = meta_bytes(0xCC);
            std::fs::write(dir.join("vault.meta"), &local).unwrap();
            blocking(mark_vault_meta_dirty(&IO, &dir)).unwrap();
            let mut st = SyncState {
                meta_baseline_hex: Some(sha256_hex(&baseline)),
                ..Default::default()
            };
            let t = FakeTransport::new();
            t.on(HttpMethod::Get, "/vault.meta", 200, baseline);

            let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, false));
            assert_eq!(out, MetaPhaseOutcome::NoChange);
            assert!(put_recorded(&t).is_empty(), "a poll cycle pushes nothing");
            assert!(
                blocking(vault_meta_is_dirty(&IO, &dir)),
                "dirty kept for a later push cycle"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // Both devices changed concurrently: the phase merges deterministically and
        // BOTH devices, from their own perspective, converge on the SAME winner.
        #[test]
        fn concurrent_change_converges_deterministically() {
            let baseline = meta_bytes(0x10); // the shared last-synced state
            let a_pw = meta_bytes(0xAA); // device A's new password-side
            let b_pw = meta_bytes(0xBB); // device B's new password-side
                                         // Deterministic winner is the greater enc_root_key_password → 0xBB.
            let winner = b_pw.clone();

            // --- A's perspective: local=A, server=B (B pushed first) ---
            let dir_a = scratch("conc-a");
            std::fs::write(dir_a.join("vault.meta"), &a_pw).unwrap();
            blocking(mark_vault_meta_dirty(&IO, &dir_a)).unwrap();
            let mut st_a = SyncState {
                meta_baseline_hex: Some(sha256_hex(&baseline)),
                ..Default::default()
            };
            let ta = FakeTransport::new();
            ta.on(HttpMethod::Get, "/vault.meta", 200, b_pw.clone());
            ta.on(HttpMethod::Put, "/vault.meta", 200, Vec::new());
            let out_a = blocking(sync_meta_phase(&IO, &ta, "tok", &dir_a, &mut st_a, true));
            assert_eq!(out_a, MetaPhaseOutcome::Merged);
            assert_eq!(
                std::fs::read(dir_a.join("vault.meta")).unwrap(),
                winner,
                "A converges on the deterministic winner (0xBB)"
            );

            // --- B's perspective: local=B, server=A (A pushed first) ---
            let dir_b = scratch("conc-b");
            std::fs::write(dir_b.join("vault.meta"), &b_pw).unwrap();
            blocking(mark_vault_meta_dirty(&IO, &dir_b)).unwrap();
            let mut st_b = SyncState {
                meta_baseline_hex: Some(sha256_hex(&baseline)),
                ..Default::default()
            };
            let tb = FakeTransport::new();
            tb.on(HttpMethod::Get, "/vault.meta", 200, a_pw.clone());
            tb.on(HttpMethod::Put, "/vault.meta", 200, Vec::new());
            let out_b = blocking(sync_meta_phase(&IO, &tb, "tok", &dir_b, &mut st_b, true));
            assert_eq!(out_b, MetaPhaseOutcome::Merged);
            assert_eq!(
                std::fs::read(dir_b.join("vault.meta")).unwrap(),
                winner,
                "B converges on the SAME deterministic winner (0xBB)"
            );
            // Both devices agree — the whole point.
            assert_eq!(st_a.meta_baseline_hex, st_b.meta_baseline_hex);

            std::fs::remove_dir_all(&dir_a).ok();
            std::fs::remove_dir_all(&dir_b).ok();
        }

        // A server meta with a DIVERGENT itemsKey wrap (different vault / corrupt /
        // hostile) must NEVER overwrite the local credential root — it SKIPS.
        #[test]
        fn refuses_to_adopt_incompatible_server_meta() {
            let dir = scratch("incompat");
            let local = meta_bytes(0xAA);
            std::fs::write(dir.join("vault.meta"), &local).unwrap();
            // Server meta with a different itemsKey → merge_vault_meta rejects it.
            let mut bad = VaultMeta {
                account_number_hash: [0x33; 16],
                kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
                random_salt_password: [0xBB; VAULT_META_SALT_RANDOM_LEN],
                random_salt_recovery: [0x55; VAULT_META_SALT_RANDOM_LEN],
                nonce_password_wrap: [0xBB; VAULT_META_NONCE_LEN],
                enc_root_key_password: [0xBB; VAULT_META_WRAPPED_ROOT_KEY_LEN],
                nonce_recovery_wrap: [0x55; VAULT_META_NONCE_LEN],
                enc_root_key_recovery: [0x55; VAULT_META_WRAPPED_ROOT_KEY_LEN],
                items_key_id: [0x07; VAULT_META_ITEMS_KEY_ID_LEN],
                items_key_nonce: [0x08; VAULT_META_NONCE_LEN],
                enc_items_key: [0x09; VAULT_META_WRAPPED_ITEMS_KEY_LEN],
            };
            bad.enc_items_key = [0xEE; VAULT_META_WRAPPED_ITEMS_KEY_LEN]; // divergent!
            let server = serialize_vault_meta(&bad).to_vec();
            let mut st = SyncState {
                meta_baseline_hex: Some(sha256_hex(&local)),
                ..Default::default()
            };
            let t = FakeTransport::new();
            t.on(HttpMethod::Get, "/vault.meta", 200, server);

            let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true));
            assert_eq!(out, MetaPhaseOutcome::Skipped);
            assert_eq!(
                std::fs::read(dir.join("vault.meta")).unwrap(),
                local,
                "local credential root is NEVER overwritten by an incompatible meta"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // Server holds no meta yet (404) + a pending local change → push it.
        #[test]
        fn pushes_on_404_when_dirty() {
            let dir = scratch("seed");
            let local = meta_bytes(0xAA);
            std::fs::write(dir.join("vault.meta"), &local).unwrap();
            blocking(mark_vault_meta_dirty(&IO, &dir)).unwrap();
            let mut st = SyncState::default();
            let t = FakeTransport::new();
            t.on(HttpMethod::Get, "/vault.meta", 404, Vec::new());
            t.on(HttpMethod::Put, "/vault.meta", 200, Vec::new());

            let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true));
            assert_eq!(out, MetaPhaseOutcome::Pushed);
            assert_eq!(put_recorded(&t), vec![local.clone()]);
            assert_eq!(st.meta_baseline_hex, Some(sha256_hex(&local)));
            assert!(!blocking(vault_meta_is_dirty(&IO, &dir)));
            std::fs::remove_dir_all(&dir).ok();
        }

        // Server and local already agree → clear dirt, record baseline, no push.
        #[test]
        fn no_op_when_already_in_sync() {
            let dir = scratch("agree");
            let m = meta_bytes(0xAA);
            std::fs::write(dir.join("vault.meta"), &m).unwrap();
            blocking(mark_vault_meta_dirty(&IO, &dir)).unwrap();
            let mut st = SyncState::default();
            let t = FakeTransport::new();
            t.on(HttpMethod::Get, "/vault.meta", 200, m.clone());

            let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true));
            assert_eq!(out, MetaPhaseOutcome::NoChange);
            assert!(put_recorded(&t).is_empty());
            assert_eq!(st.meta_baseline_hex, Some(sha256_hex(&m)));
            assert!(
                !blocking(vault_meta_is_dirty(&IO, &dir)),
                "an agreeing server clears a stale dirty flag"
            );
            std::fs::remove_dir_all(&dir).ok();
        }
    }
}
