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

use super::conflict::{plan_note_keep_both, ConflictCopyPlan};
use super::engine::{self, PullError, PushBlob, PushError};
use super::state::{
    read_head_baseline, read_sync_state, write_head_baseline, write_sync_state, BlobSyncState,
    SyncState,
};
use super::transport::SyncTransport;
use protocol::{compute_manifest_hash, ManifestEntry, VaultHead, VvEntry, VAULT_HEAD_FORMAT_V1};
use std::collections::{HashMap, HashSet};
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
    /// Head authoring (manifest hash / seal) failed.
    Head,
}

use super::to_hex as hex;

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
                std::thread::sleep(std::time::Duration::from_millis(delay_ms));
                delay_ms = (delay_ms * 2).min(2000);
            }
            other => return other,
        }
    }
    engine::download_blob(transport, token, id)
}

/// The device-local conflict-staging dir: a downloaded *remote* revision of a note
/// that lost a concurrent-edit race, held until the notes layer materializes it as
/// a keep-both copy (`conflict_of:`). The local edit is never touched.
fn conflict_staging_dir(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join("conflicts")
}

/// Persist a conflicting remote revision: `conflicts/<id>.myn` (the ciphertext the
/// notes layer decrypts to build the copy) + `conflicts/<id>.meta` (`<version>\n
/// <nonce-hex>`, the baseline [`resolve_conflict`] adopts).
fn stage_conflict(
    vault_root: &Path,
    id: &[u8; 16],
    version: u64,
    content_nonce: &[u8; 24],
    ciphertext: &[u8],
) -> Result<(), SyncCycleError> {
    let dir = conflict_staging_dir(vault_root);
    std::fs::create_dir_all(&dir).map_err(|_| SyncCycleError::Io)?;
    let id_hex = hex(id);
    crate::atomic_write::atomic_write(&dir.join(format!("{id_hex}.myn")), ciphertext, true)
        .map_err(|_| SyncCycleError::Io)?;
    let meta = format!("{version}\n{}", hex(content_nonce));
    crate::atomic_write::atomic_write(&dir.join(format!("{id_hex}.meta")), meta.as_bytes(), true)
        .map_err(|_| SyncCycleError::Io)?;
    Ok(())
}

/// The note ids (16-byte, hex) with a staged conflicting remote revision awaiting
/// keep-both materialization by the notes layer.
pub fn list_pending_conflicts(vault_root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(conflict_staging_dir(vault_root)) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("myn") {
                if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                    out.push(stem.to_string());
                }
            }
        }
    }
    out.sort();
    out
}

/// Read a staged conflicting remote revision's ciphertext (the notes layer
/// decrypts it to build the keep-both copy). `None` if nothing is staged.
pub fn read_staged_conflict_blob(vault_root: &Path, id_hex: &str) -> Option<Vec<u8>> {
    std::fs::read(conflict_staging_dir(vault_root).join(format!("{id_hex}.myn"))).ok()
}

/// Finish a keep-both resolution: adopt the staged remote revision's (version,
/// nonce) as the synced baseline for the note — so the untouched local edit now
/// pushes as a clean linear advance over it — then clear the staging. Idempotent;
/// a missing staging is a no-op.
pub fn resolve_conflict(vault_root: &Path, id_hex: &str) -> Result<(), SyncCycleError> {
    let dir = conflict_staging_dir(vault_root);
    let meta_path = dir.join(format!("{id_hex}.meta"));
    if let Ok(meta) = std::fs::read_to_string(&meta_path) {
        let mut lines = meta.lines();
        let version: u64 = lines
            .next()
            .and_then(|s| s.parse().ok())
            .ok_or(SyncCycleError::Io)?;
        let nonce_hex = lines.next().unwrap_or("").to_string();
        let mut state = read_sync_state(vault_root).map_err(|_| SyncCycleError::Io)?;
        state.blobs.insert(
            id_hex.to_string(),
            BlobSyncState {
                version,
                content_nonce_hex: nonce_hex,
            },
        );
        write_sync_state(vault_root, &state).map_err(|_| SyncCycleError::Io)?;
    }
    let _ = std::fs::remove_file(dir.join(format!("{id_hex}.myn")));
    let _ = std::fs::remove_file(meta_path);
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
fn read_pending_tombstones(vault_root: &Path) -> std::collections::HashSet<String> {
    std::fs::read_to_string(pending_tombstones_path(vault_root))
        .map(|s| {
            s.lines()
                .map(|l| l.trim().to_string())
                .filter(|l| !l.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Queue a note id (32-hex) as a tombstone for the next push. Idempotent.
pub fn add_pending_tombstone(vault_root: &Path, id_hex: &str) -> Result<(), SyncCycleError> {
    let mut set = read_pending_tombstones(vault_root);
    set.insert(id_hex.to_string());
    write_pending_tombstones(vault_root, &set)
}

/// Drop ids from the pending-tombstone queue (after they were pushed-with-flag).
fn clear_pending_tombstones(vault_root: &Path, drop: &[String]) -> Result<(), SyncCycleError> {
    if drop.is_empty() {
        return Ok(());
    }
    let mut set = read_pending_tombstones(vault_root);
    for d in drop {
        set.remove(d);
    }
    write_pending_tombstones(vault_root, &set)
}

fn write_pending_tombstones(
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
    crate::atomic_write::atomic_write(&pending_tombstones_path(vault_root), body.as_bytes(), true)
        .map_err(|_| SyncCycleError::Io)
}

/// The engine's `local` manifest (raw 16-byte id → 24-byte content_nonce), read
/// decryption-free from the on-disk notes dir. Converts the notes-domain
/// [`NonceManifest`](crate::search::persist::NonceManifest) String keys to the
/// raw uuid bytes the engine wants.
pub fn local_manifest(notes_dir: &Path) -> HashMap<[u8; 16], [u8; 24]> {
    let mut out = HashMap::new();
    for (id_str, nonce) in crate::plugins::notes::search_sync::scan_on_disk_manifest(notes_dir) {
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
// The arguments are each a distinct, independent input to the cycle (the
// transport, the two keys/ids, the token, the two paths, the push gate); bundling
// them into a struct would not aid clarity at this single orchestrator entry.
#[allow(clippy::too_many_arguments)]
pub fn run_sync_cycle(
    transport: &dyn SyncTransport,
    root_key: &[u8; 32],
    account_number_hash: [u8; 16],
    device_id: [u8; 16],
    token: &str,
    notes_dir: &Path,
    vault_root: &Path,
    allow_push: bool,
) -> Result<SyncSummary, SyncCycleError> {
    let mut state = read_sync_state(vault_root).map_err(|_| SyncCycleError::Io)?;

    // Baseline VV + seq from the device-local head baseline (empty on first sync).
    let baseline_head = read_head_baseline(root_key, vault_root).ok().flatten();
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
            transport,
            root_key,
            account_number_hash,
            device_id,
            token,
            notes_dir,
            vault_root,
            allow_push,
            &mut state,
            &baseline_vv,
            baseline_seq,
            from_cursor,
        ) {
            Ok(summary) => {
                // Persist the advanced cursor + per-blob CAS state ONLY on success,
                // so a failed retry never leaves a half-advanced cursor on disk.
                write_sync_state(vault_root, &state).map_err(|_| SyncCycleError::Io)?;
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
fn sync_cycle_attempt(
    transport: &dyn SyncTransport,
    root_key: &[u8; 32],
    account_number_hash: [u8; 16],
    device_id: [u8; 16],
    token: &str,
    notes_dir: &Path,
    vault_root: &Path,
    allow_push: bool,
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
    let local = local_manifest(notes_dir);
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
            state.cursor = 0;
            write_sync_state(vault_root, state).map_err(|_| SyncCycleError::Io)?;
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

    // --- apply remote changes: download + write each changed blob to disk ---
    let mut pulled = 0;
    for c in &page.changed {
        // Skip a locally-dirty blob: our on-disk copy diverges from the synced
        // baseline, so this is an unpushed local edit (or a genuine conflict) and
        // downloading the server's copy would clobber it. The push phase below
        // sends it; a real concurrent edit surfaces later via keep-both.
        let baseline_nonce = state
            .blobs
            .get(&hex(&c.id))
            .map(|b| b.content_nonce_hex.clone());
        let local_nonce = local.get(&c.id).map(|n| hex(n));
        if baseline_nonce.is_some() && baseline_nonce != local_nonce {
            continue;
        }
        let bytes = download_blob_backoff(transport, token, &c.id).map_err(SyncCycleError::Pull)?;
        std::fs::create_dir_all(notes_dir).map_err(|_| SyncCycleError::Io)?;
        crate::atomic_write::atomic_write(&blob_path(notes_dir, &c.id), &bytes, true)
            .map_err(|_| SyncCycleError::Io)?;
        state.blobs.insert(
            hex(&c.id),
            BlobSyncState {
                version: c.version,
                content_nonce_hex: hex(&c.content_nonce),
            },
        );
        pulled += 1;
    }
    state.cursor = page.next_cursor;
    if let Some(vh) = &page.head {
        state.record_observation(&vh.head_id, &vh.head.version_vector);
    }

    // --- detect local changes to push (content_nonce ≠ last-synced) ---
    // Skipped on a poll-driven Pull (`allow_push=false`): pushes are coalesced
    // and fire only after the local-change window elapses (loop_control), so a
    // poll never opens a high-resolution edit-timing channel (resolution-blur).
    let local2 = local_manifest(notes_dir);
    // The server's current (version, nonce) for every blob it reported — used to
    // tell a clean local edit (server still at our base) from a true conflict
    // (server advanced this blob past our synced baseline).
    let server_meta: HashMap<[u8; 16], (u64, [u8; 24])> = page
        .all_metas
        .iter()
        .map(|m| (m.id, (m.version, m.content_nonce)))
        .collect();
    let pending_tombstones = read_pending_tombstones(vault_root);
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
    let pending_conflicts: HashSet<String> =
        list_pending_conflicts(vault_root).into_iter().collect();
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
                                vault_root,
                                id,
                                *server_version,
                                remote_nonce,
                                &remote_bytes,
                            );
                        }
                        conflicts.push(plan_note_keep_both(id, *remote_nonce));
                        continue;
                    }
                }
            }
            let ciphertext =
                std::fs::read(blob_path(notes_dir, id)).map_err(|_| SyncCycleError::Io)?;
            to_push.push(PushBlob {
                id: *id,
                base_version: synced.map(|b| b.version).unwrap_or(0),
                content_nonce: *nonce,
                ciphertext,
                // A deletion the notes layer queued → flag it so the server marks
                // it for horizon-GC (the `deleted:` field still propagates either
                // way; the flag only governs server-side reclamation).
                tombstone: pending_tombstones.contains(&id_hex),
            });
        }
    }

    let mut pushed = 0;
    let mut head_advanced = false;
    let mut tombstones_pushed = 0;

    if !to_push.is_empty() {
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
        let manifest_hash =
            compute_manifest_hash(&manifest_entries(&local2)).map_err(|_| SyncCycleError::Head)?;
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
        // The queued tombstones are now flagged on the server → drop them from the
        // device-local queue so they aren't re-flagged every cycle.
        let pushed_tombstones: Vec<String> = to_push
            .iter()
            .filter(|b| b.tombstone)
            .map(|b| hex(&b.id))
            .collect();
        tombstones_pushed = pushed_tombstones.len();
        let _ = clear_pending_tombstones(vault_root, &pushed_tombstones);
        write_head_baseline(vault_root, &sealed).map_err(|_| SyncCycleError::Io)?;
        state.record_observation(&sealed.head_id, &version_vector);
    } else if let Some(vh) = &page.head {
        // No local changes: adopt the pulled head as the new baseline (re-seal
        // the decoded head — deterministic, reproduces the same record/head_id).
        let sealed = vh.head.seal(root_key).map_err(|_| SyncCycleError::Head)?;
        write_head_baseline(vault_root, &sealed).map_err(|_| SyncCycleError::Io)?;
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
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::notes::note_id::NoteId;
    use crate::plugins::sync::enroll::{self, EnrollPath};
    use protocol::{decode_note, derive_subkey, encode_new_note, SubkeyRole};
    use std::path::PathBuf;
    use std::process::Child;

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
        let username = "MY-ORCH-TEST";
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
        enroll::register_verifier(ta.as_ref(), &account_hash, username, secret.as_slice()).unwrap();

        let dev_a = enroll::generate_device_id();
        let out_a = enroll::enroll(
            ta.as_ref(),
            &account_hash,
            username,
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
            username,
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
        let push = run_sync_cycle(
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

        let pull = run_sync_cycle(
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
        let username = "MY-JOIN-TEST";
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
        enroll::register_verifier(ta.as_ref(), &account_hash, username, secret.as_slice()).unwrap();
        let dev_a = enroll::generate_device_id();
        let out_a = enroll::enroll(
            ta.as_ref(),
            &account_hash,
            username,
            secret.as_slice(),
            EnrollPath::Recovery,
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            dev_a,
        )
        .unwrap();
        let tok_a = hex32(&out_a.token);
        run_sync_cycle(
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
            username,
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
            username,
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
        let pull = run_sync_cycle(
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
        let username = "MY-HEAL-TEST";
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
        enroll::register_verifier(ta.as_ref(), &account_hash, username, secret.as_slice()).unwrap();
        let dev_a = enroll::generate_device_id();
        let out_a = enroll::enroll(
            ta.as_ref(),
            &account_hash,
            username,
            secret.as_slice(),
            EnrollPath::Recovery,
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            dev_a,
        )
        .unwrap();
        let tok_a = hex32(&out_a.token);
        run_sync_cycle(
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
        let mut st = crate::plugins::sync::state::read_sync_state(&dir_a).unwrap();
        assert!(
            !st.blobs.is_empty(),
            "baseline populated by the initial push"
        );
        st.blobs.clear();
        crate::plugins::sync::state::write_sync_state(&dir_a, &st).unwrap();

        // A edits the note locally (a fresh content_nonce).
        let blob_v2 =
            encode_new_note(&items_key, &items_key_id, &note_bytes, b"edited body").unwrap();
        crate::atomic_write::atomic_write(&notes_a.join(&fname), &blob_v2, true).unwrap();

        // A syncs: self-heal the baseline + push the edit (no 409), and do NOT
        // clobber the local edit with the server's v1.
        run_sync_cycle(
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
            username,
            secret.as_slice(),
            EnrollPath::Recovery,
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            dev_b,
        )
        .unwrap();
        let tok_b = hex32(&out_b.token);
        let pull = run_sync_cycle(
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
        username: &str,
        secret: &[u8],
        nonce: &str,
        register: bool,
    ) -> (Box<dyn SyncTransport>, [u8; 16], String) {
        let t = crate::plugins::sync::http_transport::build_transport(url, Vec::new()).unwrap();
        if register {
            enroll::register_verifier(t.as_ref(), account_hash, username, secret).unwrap();
        }
        let dev = enroll::generate_device_id();
        let out = enroll::enroll(
            t.as_ref(),
            account_hash,
            username,
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
        let username = "MY-LARGE-TEST";
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
            username,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        let push = run_sync_cycle(
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
            username,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );
        let pull = run_sync_cycle(
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
        let username = "MY-DEL-TEST";
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
            username,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        run_sync_cycle(
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
            username,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );
        run_sync_cycle(
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
        run_sync_cycle(
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
        run_sync_cycle(
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
        let username = "MY-CONFLICT-TEST";
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
            username,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        run_sync_cycle(
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
            username,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );
        run_sync_cycle(
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
        run_sync_cycle(
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
        let summary = run_sync_cycle(
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
            username,
            secret.as_slice(),
            "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2",
            false,
        );
        run_sync_cycle(
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
        let username = "MY-KEEPBOTH-TEST";
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
            username,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        run_sync_cycle(
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
            username,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );
        run_sync_cycle(
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
        run_sync_cycle(
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
        let s1 = run_sync_cycle(
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
        let s2 = run_sync_cycle(
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
            username,
            secret.as_slice(),
            "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2",
            false,
        );
        run_sync_cycle(
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
        let username = "MY-REVOKE-TEST";
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
            username,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        run_sync_cycle(
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
            username,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );
        run_sync_cycle(
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
        let err = run_sync_cycle(
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
    /// 410s, the from-0 re-pull succeeds.
    #[test]
    fn cursor_expired_resets_and_full_reconciles() {
        use crate::plugins::sync::state::{write_sync_state, SyncState};
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

        let summary = run_sync_cycle(
            &fake, &[0u8; 32], [0u8; 16], [0u8; 16], "tok", &notes, &dir, true,
        )
        .expect("the cycle recovers from cursor_expired");
        assert_eq!(summary.cursor, 0, "cursor reset to a full reconcile");
        // The recovery re-pull from 0 actually happened, with the reconcile flag.
        let pulled_from_0 = fake
            .requests()
            .iter()
            .any(|(m, p, _, _)| *m == HttpMethod::Get && p == "/sync/pull?cursor=0&reconcile=1");
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
        let username = "MY-RL-TEST";
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
            username,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        run_sync_cycle(
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
            username,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );
        let pull = run_sync_cycle(
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
        let username = "MY-TOMB-TEST";
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
            username,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        run_sync_cycle(
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
            username,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );
        run_sync_cycle(
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

        let s = run_sync_cycle(
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
        run_sync_cycle(
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
        let username = "MY-WEDGE-TEST";
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
            username,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        run_sync_cycle(
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
            username,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );
        run_sync_cycle(
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
        run_sync_cycle(
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
        let s1 = run_sync_cycle(
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
        let s2 = run_sync_cycle(
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
            username,
            secret.as_slice(),
            "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2",
            false,
        );
        run_sync_cycle(
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
        let username = "MY-RETRY-TEST";
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
            username,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        run_sync_cycle(
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
            username,
            secret.as_slice(),
            "b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1",
            false,
        );
        run_sync_cycle(
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
        run_sync_cycle(
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
        run_sync_cycle(
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
        let mut st = crate::plugins::sync::state::read_sync_state(&dir_b).unwrap();
        st.blobs
            .get_mut(&x_hex)
            .expect("B has a baseline for X")
            .version = 1;
        crate::plugins::sync::state::write_sync_state(&dir_b, &st).unwrap();

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
        let s = run_sync_cycle(
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
}
