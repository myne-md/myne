// SPDX-License-Identifier: AGPL-3.0
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
use super::head_authority::{HeadAuthority, SignedHeadCtx};
use super::state::{
    clear_vault_meta_dirty, read_head_baseline, read_sync_state, vault_meta_is_dirty,
    write_head_baseline, write_sync_state, BlobSyncState, SyncState,
};
use super::transport::{HttpMethod, SyncTransport};
use crate::attachment_nonce::{scan_attachments_manifest, AttachmentManifestEntry};
use crate::plugins::vault_unlock::state::SharedSingletonKey;
use protocol::{
    compute_manifest_hash, decode_device_binding_blob, decode_member_names_blob, derive_subkey,
    derive_subkey_versioned, encode_attachments_catalog_versioned, encode_device_binding_blob,
    encode_member_names_blob, merge_device_bindings, merge_member_names, parse_vault_meta_any,
    serialize_vault_meta, AttachmentsCatalog, ManifestEntry, MetaVersion, SealedHead, SubkeyRole,
    VaultHead, VvEntry, AGENT_MEMORY_BLOB_MAGIC, AGENT_MEMORY_BLOB_V0_2_MAGIC,
    AGENT_MEMORY_CATALOG_BLOB_MAGIC, AGENT_MEMORY_CATALOG_BLOB_V0_2_MAGIC,
    AGENT_PERSONALITY_BLOB_MAGIC, AGENT_PERSONALITY_BLOB_V0_2_MAGIC, CATALOG_BLOB_MAGIC,
    CATALOG_BLOB_V0_2_MAGIC, CHATS_BLOB_MAGIC, CHATS_BLOB_V0_2_MAGIC, CHATS_CATALOG_BLOB_MAGIC,
    CHATS_CATALOG_BLOB_V0_2_MAGIC, DEVICE_BINDING_BLOB_MAGIC, MEMBER_NAMES_BLOB_MAGIC,
    PREFS_BLOB_MAGIC, PREFS_BLOB_V0_2_MAGIC, THEMES_BLOB_MAGIC, THEMES_BLOB_V0_2_MAGIC,
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
    /// A remote `vault.chats` change was merged onto the on-disk catalog this
    /// cycle (myne-md/myne#675): a conversation added, renamed or deleted on
    /// a peer. Reported for the same reason as `themes_applied_remote` (the
    /// WebView re-reads the roster over IPC on demand).
    pub chats_applied_remote: bool,
    /// Memory entry files downloaded + written to `memories/` this cycle
    /// (myne-md/myne#697, the `attachments_pulled` shape for the memory plane).
    pub memory_entries_pulled: usize,
    /// A remote memory-catalog change was merged onto the on-disk roster this
    /// cycle (myne-md/myne#697). Reported for the same reason as
    /// `chats_applied_remote` (the WebView re-reads the roster over IPC).
    pub memory_applied_remote: bool,
    /// A remote personality change was merged onto the on-disk singleton this
    /// cycle (myne-md/myne#697). Reported for the same reason: the settings
    /// surface re-reads it over IPC, and a silent peer-applied voice change
    /// is otherwise invisible.
    pub personality_applied_remote: bool,
    /// A remote `vault.member-names` change was merged onto the on-disk store this
    /// cycle (task 3b-ii): a member set, changed or cleared their display name on a
    /// peer. Reported for the same reason as `themes_applied_remote`: the
    /// orchestrator stays `AppHandle`-free, so any refresh choreography lives at the
    /// command boundary, and the WebView re-reads the roster over IPC on demand.
    pub member_names_applied_remote: bool,
    /// A remote `vault.device-bindings` change was merged onto the on-disk store this
    /// cycle (member-devices task 3): another device claimed itself, or the owner
    /// tombstoned a removed member's rows. Reported for the same reason as
    /// `member_names_applied_remote`: the orchestrator stays `AppHandle`-free, so any
    /// refresh choreography lives at the command boundary, and a devices panel re-reads
    /// the map over IPC on demand.
    pub device_bindings_applied_remote: bool,

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
    /// Canonical 36-char ids of the notes this cycle WROTE to disk (myne#305).
    ///
    /// Every local note writer re-indexes through the hooks seam; this one
    /// cannot, because the orchestrator is deliberately `AppHandle`-free and
    /// holds no `Hooks`. So it reports what it wrote and the cycle boundary —
    /// which does hold them — re-indexes. Without that, a note created on
    /// another device was absent from the live full-text index for the whole
    /// session, and the next persist certified it as indexed.
    ///
    /// Written notes only: a `SkippedDirty` or a failed download is not here.
    pub pulled_note_ids: Vec<String>,
    /// Pulled note revisions for notes OPEN in a live session this cycle
    /// (`collab-editor-bridge` task 7). The orchestrator does NOT write them, the
    /// session is the single durable writer (`SYNC-33`), so the caller merges each
    /// into the session (`LiveSession::merge_pulled`, §11.1 remove-wins) and raises
    /// the "updated from another device" signal. The third element is the
    /// device-local baseline `content_nonce` the scan compared against, carried so a
    /// caller that has to FALL BACK to the plain write can re-apply the same
    /// dirty-disk check rather than overwriting unconditionally.
    pub deferred_live_pulls: Vec<([u8; 16], Vec<u8>, Option<String>)>,
    /// Canonical 36-char ids of `NC05` notes whose local copy was updated this
    /// cycle by an **automatic CRDT merge** of a concurrent remote revision
    /// (ASM-6→B / #422) — a strict subset of `pulled_note_ids`. This is the
    /// "updated from another device" signal the product surface renders as a calm
    /// hint; unlike a plain pull (server-wins overwrite of an unedited note) it
    /// means *both* a local and a remote edit were reconciled. A local-only edit,
    /// a no-op merge, or a `MY01` keep-both never appears here.
    pub remote_merged_note_ids: Vec<String>,
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
    /// The vault was re-keyed by the §10.4.1 migration on **another device**
    /// (myne-md/myne#429): the server's head does not open under this device's
    /// `root_key`, and the server's `vault.meta` is a NEWER generation than the
    /// local one.
    ///
    /// Split out of `Pull(HeadInvalid)` because the two are byte-identical at the
    /// pull and mean opposite things. A head that will not open is normally
    /// evidence of forgery and earns the malicious-server alert; here it is the
    /// expected consequence of a migration the user themselves ran elsewhere, and
    /// the alert would be a false accusation the user cannot act on. The
    /// disambiguating fact is the server's meta generation, which no attacker can
    /// forge into being — a v0.2 meta only opens under credentials the user holds.
    ///
    /// The remedy is not a retry: this device must adopt the new meta and
    /// re-unlock, so the cycle boundary locks the vault and says so.
    RekeyedElsewhere,
}

use super::to_hex as hex;

/// The server's `vault.meta` when it is a NEWER generation than this device's —
/// i.e. someone ran the §10.4.1 migration on another device (myne-md/myne#429).
///
/// Consulted only to disambiguate an unopenable head, and deliberately
/// conservative: any doubt (transport failure, unreadable local meta, an
/// undecodable server meta) answers `None`, which leaves the ordinary integrity
/// path in charge. A false `Some` would suppress a genuine malicious-server
/// alert, so the bar is "the server demonstrably holds a generation this device
/// cannot have written".
///
/// It returns the **bytes** rather than a bool because the caller stages them
/// for the unlock path to promote (#447). Answering only "yes" would mean
/// fetching the same blob twice and leaving room for the two answers to disagree.
async fn server_meta_of_newer_generation(
    transport: &dyn SyncTransport,
    token: &str,
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
) -> Option<Vec<u8>> {
    let local = io.read(&vault_root.join("vault.meta")).await.ok()?;
    // Already v0.2 locally? Then a newer generation is not what this is.
    if protocol::meta_version_of(&local) != Some(protocol::MetaVersion::V0_1) {
        return None;
    }
    let resp = transport
        .request(HttpMethod::Get, "/vault.meta", &[], Some(token))
        .ok()?;
    if resp.status != 200 {
        return None;
    }
    (protocol::meta_version_of(&resp.body) == Some(protocol::MetaVersion::V0_2))
        .then_some(resp.body)
}

/// Parse a 32-hex blob-id key from `state.blobs` back to its 16 bytes. `None`
/// for anything malformed (defensive — the state file is device-local JSON).
///
/// **Strict**, through `protocol::hex::decode_lower`: conversation ids are minted
/// lowercase and every caller passes own-writer data (catalog keys, scan names),
/// so an uppercase spelling is a second identity for one blob rather than a
/// variant to accept. Aşama 3's R1.2 made the choice explicit — this helper and
/// `sync::devices::hex16` disagreed about case on the same 32-hex shape, and the
/// loser was a silent `None`.
fn from_hex16(s: &str) -> Option<[u8; 16]> {
    protocol::hex::decode_lower(s)
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
    rate_limit_backoff(|| engine::download_blob(transport, token, id))
}

/// The 429 backoff ladder itself, over any pull-side request: 250 → 500 → 1000 →
/// 2000 → 2000 → 2000 ms, then one final unguarded attempt. **Only**
/// `RateLimited` retries — every other outcome, success or failure, returns
/// immediately, which is what keeps a batch's `RouteUnsupported` (an `Ok`) from
/// being retried.
///
/// Generic over the request so the single-blob download and the batch window
/// share one ladder rather than two copies that can drift. Sleeps through
/// `crate::task::block_sleep`, the target-split seam — a plain
/// `std::thread::sleep` here compiles for wasm32 and then hangs the Worker.
fn rate_limit_backoff<T>(mut f: impl FnMut() -> Result<T, PullError>) -> Result<T, PullError> {
    let mut delay_ms = 250u64;
    for _ in 0..6 {
        match f() {
            Err(PullError::RateLimited) => {
                crate::task::block_sleep(std::time::Duration::from_millis(delay_ms));
                delay_ms = (delay_ms * 2).min(2000);
            }
            other => return other,
        }
    }
    f()
}

/// Upper bound on the blobs ONE `POST /sync/blobs` asks for (myne-md/myne#240).
/// Mirrors [`PUSH_CHUNK_MAX_BLOBS`] — the server's per-request work scales with
/// the id COUNT, and the batch's rate-limit cost is derived from it too.
const FETCH_WINDOW_MAX_BLOBS: usize = 256;

/// Upper bound on the ciphertext ONE batch window asks for, in bytes measured
/// before base64. Twin of [`PUSH_CHUNK_MAX_BYTES`], and the same 8 MiB, so the
/// encoded response (~4/3 of this plus per-entry framing, ≈11 MiB) stays far
/// under `transport::MAX_SYNC_RESPONSE_BYTES` (the cap sync passes into `crate::http`).
const FETCH_WINDOW_MAX_BYTES: usize = 8 * 1024 * 1024;

/// How many of `queue` the next batch request should ask for, bounded by BOTH
/// [`FETCH_WINDOW_MAX_BLOBS`] and [`FETCH_WINDOW_MAX_BYTES`] — the window closes
/// at whichever binds first, and a lone blob over the byte bound still travels by
/// itself (never zero, or the drain would loop on it forever).
///
/// **An empty queue yields ZERO, not one empty window** — the inversion of
/// [`push_chunks`], which deliberately returns one EMPTY chunk because a head-only
/// genesis push must still be sent. A fetch with nothing to ask for must send
/// nothing; the copied-from-push version of this spends a token and a round-trip
/// on an empty request, and nothing about the resulting data is wrong, so only a
/// test named for the inversion catches it.
///
/// The `size` this windows on is **advertised by the server and untrusted**
/// (`sync-protocol.md` §8.1), and an older server omits it entirely, in which case
/// `ChangedBlob::size` deserializes to 0. Neither case is special-cased and none
/// needs to be: an under-reported size can only make this window LARGER than
/// intended, the server enforces its own byte cap and serves the prefix that fits,
/// and the client re-windows whatever went unserved. The advisory number can cost
/// a round-trip; it cannot produce a wrong result.
fn fetch_window(queue: &[&engine::ChangedBlob]) -> usize {
    let mut bytes = 0usize;
    for (i, c) in queue.iter().enumerate() {
        if i > 0 && (i >= FETCH_WINDOW_MAX_BLOBS || bytes + c.size > FETCH_WINDOW_MAX_BYTES) {
            return i;
        }
        bytes += c.size;
    }
    queue.len()
}

/// Outcome of one pulled-note write attempt under the notes-write mutex.
pub(crate) enum PulledNoteApply {
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
/// The re-check can only see writers that publish under the same lock. The §8.3
/// rename batch did not, so it was invisible here: this function read a blob the
/// batch had already re-encoded but not yet published, concluded the disk was
/// clean, adopted the remote version as the baseline, and was then overwritten
/// (myne#302). It takes the lock now.
///
/// Divergence semantics mirror the pre-download filter: a synced baseline
/// exists and the disk no longer matches it (including "file vanished" — a
/// mid-cycle local delete must not be resurrected) → skip without mutation.
/// No baseline (fresh pull of a never-held note) → write unconditionally.
pub(crate) async fn apply_pulled_note_blob(
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
    // #264: through the SEAM, like the `io.exists` ten lines below. This asked
    // `std::path::Path::exists()`, which on wasm32 compiles and always answers
    // `false` — OPFS is not a filesystem `Path` can see. So on the web client
    // quarantine was a silent no-op: a note the engine had decided to remove
    // from the live set stayed exactly where it was, and the function reported
    // success. Two existence questions, ten lines apart, answered by two
    // different oracles.
    if !io.exists(&src).await.unwrap_or(false) {
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
                doc_heads_hex: Vec::new(),
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

/// The reserved 16-byte sync-plane blob-id of a shared singleton, derived from
/// the session's shared-tier key.
///
/// An owner/pre-B2B session (`OwnerRoot`) keeps the historical root-derived id:
/// it names bytes the server already holds and the migration never rewrites it.
/// An `NTV6` session (`Group`) derives it from the current group key
/// (`GroupRole`), which is what lets a member address the same shared blobs the
/// owner wrote (decision 0594: group roles cover shared content and shared
/// singleton material). The id therefore rotates with the group key on member
/// removal, and the retirement record's `reclaim_sync_ids_hex` is what reclaims
/// the superseded namespace.
///
/// `role` MUST be an identifier derivation (`catalog-sync-id` /
/// `prefs-sync-id` / `themes-sync-id` / `chats-catalog-sync-id` /
/// `agent-memory-catalog-sync-id` / `agent-personality-sync-id`), never a KEK
/// role: the id is server-visible, so truncating a key derivation into it
/// would leak key material to the sync plane.
fn shared_sync_id(shared: &SharedSingletonKey, role: SubkeyRole) -> [u8; 16] {
    match shared {
        SharedSingletonKey::OwnerRoot(root) => sync_id_for(root, role),
        SharedSingletonKey::Group(group) => {
            let group_role = role
                .shared_group_role()
                .expect("a shared-singleton identifier role must map to a group role");
            let sub =
                protocol::derive_group_subkey_v0_2(&protocol::GroupKey::new(**group), group_role);
            let mut id = [0u8; 16];
            id.copy_from_slice(&sub[..16]);
            id
        }
    }
}

/// Read a vault singleton blob's outer nonce (offset 6, `AEAD_NONCE_LEN` bytes)
/// decryption-free: the sync-plane change discriminator shared by the
/// `MYC1`/`MYC5` catalog, `MYP1`/`MYP5` prefs and `MYT1`/`MYT5` themes
/// envelopes. `None` unless `bytes` opens with one of that family's magics.
///
/// Both are always `protocol` registry constants at the call sites below,
/// never a re-typed literal (`protocol.md` §10.3 is the single source of truth
/// for magic-byte allocation, and a magic that stops matching here does not
/// error — the blob reads as unchanged and its family silently stops syncing).
/// All three families read the nonce through
/// [`crate::content_nonce::content_nonce_at`], which takes the base magic and
/// the later generations as separate arguments. This function was the shape
/// that got the two-generation part right first: [`crate::note_nonce`] and
/// [`crate::attachment_nonce`] hand-wrote the comparison, and the second of
/// them could therefore name one generation and did (myne-md/myne#638). Note
/// what consolidating cost here, since the entry records it too: the old
/// `(magic, magic_v0_2)` pair made a one-generation call absurd at the call
/// site, and `later: &[]` is not absurd. Rule 5 carries that now. Also enforced by
/// `scripts/check-crypto-registries.mjs` rules 2 and 5 (epic #249).
///
/// The OFFSET (6) is still a literal, and deliberately so: `protocol` exports
/// `*_BLOB_HEADER_LEN` for these three families but no per-family
/// `OFFSET_*_NONCE` the way `protocol::blob` exports `OFFSET_CONTENT_NONCE`.
/// Closing that gap means adding an exported offset constant per family in
/// `protocol` first; until then the offset is a known drift surface, not an
/// oversight. The nonce WIDTH is no longer a literal: `content_nonce_at` reads
/// `AEAD_NONCE_LEN` bytes from it.
fn read_singleton_nonce(bytes: &[u8], base: &[u8; 4], later: &[&[u8; 4]]) -> Option<[u8; 24]> {
    // BOTH generations. The `MY?5` envelope keeps the `MY?1` byte layout — only
    // the magic differs (§10.4.1 clause 6) — so the nonce is at the same offset.
    // Accepting only v0.1 makes every reader `None` on a migrated vault, and the
    // paragraph below spells out what that costs: the recorded baseline and the
    // on-disk nonce disagree forever, so every cycle re-classifies the record as
    // changed and re-adopts the server's bytes.
    crate::content_nonce::content_nonce_at(bytes, 6, base, later)
}

/// Download a synced singleton's bytes and verify them against the record that
/// advertised them, per `sync-protocol.md` §11.3 — the pre-mutation check the
/// note path does at `read_myn_content_nonce` and the attachment path at
/// `read_attachment_content_nonce`.
///
/// Returns `None` when there is nothing to pull, **and** when the served bytes
/// do not carry the advertised `content_nonce`. Both answers mean the same
/// thing to every caller: take the no-remote-record path, mutate nothing, and
/// leave the prior baseline authoritative.
///
/// Why the singletons need this as much as the notes do, despite being
/// small and mergeable: `record_blob_baseline` stores the nonce the SERVER
/// advertised, not the one read back out of the adopted bytes. Adopt unverified
/// bytes and the on-disk nonce and the recorded baseline disagree forever —
/// every later cycle re-classifies the record as changed and re-adopts it. If
/// the bytes additionally lack the family magic, `read_*_nonce` on the adopted
/// file is `None`, the push-side `if let Some(nonce)` guard adds nothing to
/// `to_push`, and the blob can never heal: the vault keeps the served bytes and
/// the loop never terminates. The whole failure is prevented by not writing
/// them.
///
/// `family` is a static label for the skip log. Nothing else is logged: the
/// nonces themselves are DENY-listed (`src-tauri/AGENTS.md`), and the blob id
/// is a vault-stable correlation tag.
fn verified_singleton_download(
    transport: &dyn SyncTransport,
    token: &str,
    remote_record: Option<&ChangedBlob>,
    remote_changed: bool,
    read_nonce: fn(&[u8]) -> Option<[u8; 24]>,
    family: &'static str,
) -> Result<SingletonPull, SyncCycleError> {
    let Some(rec) = remote_record.filter(|_| remote_changed) else {
        return Ok(SingletonPull::Nothing);
    };
    let bytes = download_blob_backoff(transport, token, &rec.id).map_err(SyncCycleError::Pull)?;
    if read_nonce(&bytes) != Some(rec.content_nonce) {
        // Empty bodies, junk, a truncated blob and a genuine-but-different
        // revision all land here on one check.
        tracing::warn!(
            stage = "singleton_pull_verify",
            family,
            "served bytes do not carry the advertised content_nonce; skipping with no local mutation"
        );
        return Ok(SingletonPull::Refused);
    }
    Ok(SingletonPull::Verified(rec.clone(), bytes))
}

/// The three outcomes of [`verified_singleton_download`].
///
/// `Nothing` and `Refused` both mean "do not adopt", but they are NOT
/// interchangeable, and collapsing them is a §11.3 violation in its own right.
/// §11.3 forbids *any* local mutation on a failed verification — "the disk
/// write **and** the baseline adoption". The prefs phase's no-changed-record
/// tail performs a baseline self-heal (for a re-enrolled device whose CAS base
/// went missing), which is correct when there was genuinely nothing to pull and
/// wrong when a record was refused: it would record the advertised nonce of a
/// revision the client just declined to accept.
enum SingletonPull {
    /// No record, or a record whose bytes we already hold.
    Nothing,
    /// A record was served and failed verification. Mutate nothing at all.
    Refused,
    /// Verified: the served bytes carry the advertised `content_nonce`.
    Verified(ChangedBlob, Vec<u8>),
}

/// The catalog's sync discriminator (`read_singleton_nonce` over MYC1).
fn read_catalog_nonce(bytes: &[u8]) -> Option<[u8; 24]> {
    read_singleton_nonce(bytes, &CATALOG_BLOB_MAGIC, &[&CATALOG_BLOB_V0_2_MAGIC])
}

/// `vault.prefs`' reserved 16-byte sync-plane blob-id:
/// `DeriveSubkey(root_key, "prefs-sync-id")[0..16]` (`protocol.md` §3.4,
/// MYND-478) — the `catalog_sync_id` twin.
pub fn prefs_sync_id(root_key: &[u8; 32]) -> [u8; 16] {
    sync_id_for(root_key, SubkeyRole::PrefsSyncId)
}

/// The prefs blob's sync discriminator (`read_singleton_nonce` over MYP1).
fn read_prefs_nonce(bytes: &[u8]) -> Option<[u8; 24]> {
    read_singleton_nonce(bytes, &PREFS_BLOB_MAGIC, &[&PREFS_BLOB_V0_2_MAGIC])
}

/// `vault.themes`' reserved 16-byte sync-plane blob-id:
/// `DeriveSubkey(root_key, "themes-sync-id")[0..16]` (`protocol.md` §3.4,
/// MYND-486) — the `catalog_sync_id` / `prefs_sync_id` twin.
pub fn themes_sync_id(root_key: &[u8; 32]) -> [u8; 16] {
    sync_id_for(root_key, SubkeyRole::ThemesSyncId)
}

/// The themes blob's sync discriminator (`read_singleton_nonce` over MYT1).
fn read_themes_nonce(bytes: &[u8]) -> Option<[u8; 24]> {
    read_singleton_nonce(bytes, &THEMES_BLOB_MAGIC, &[&THEMES_BLOB_V0_2_MAGIC])
}

/// `vault.member-names`' reserved 16-byte sync-plane blob-id, derived through the
/// GROUP tier (`protocol.md` §3.4, `decisions/protocol/0666`): the
/// `themes_sync_id` archetype.
///
/// It cannot go through [`shared_sync_id`], and the reason is worth stating: this
/// family is `NTV6`-only and has **no `SubkeyRole` counterpart** (there is no
/// pre-B2B form to derive a root-tier id for), so `SubkeyRole::shared_group_role`
/// has no arm to map and a `SubkeyRole` argument would not typecheck. `None` is
/// therefore the whole pre-B2B answer: an `OwnerRoot` session has no such blob and
/// the phase stands down, exactly as the command layer answers
/// `NotASharedVault`.
fn member_names_sync_id(shared: &SharedSingletonKey) -> Option<[u8; 16]> {
    let group = shared.group_bytes()?;
    Some(crate::plugins::member_names::names_sync_id(&group))
}

/// The member-names blob's sync discriminator (`read_singleton_nonce` over MYO5).
///
/// `MYO5` is this family's ONE generation: it is born `NTV6`-only, so there is no
/// `MYO1` form and no later `MY?5` generation to accept beside it. That is why the
/// `later` list is empty here and not because one was forgotten, which is the shape
/// `check-crypto-registries.mjs` rule 5 exists to catch: `MEMBER_NAMES_BLOB_MAGIC` is
/// deliberately off the `_V<n>_<m>_MAGIC` pattern, so the family has no later magic
/// for that rule to demand.
fn read_member_names_nonce(bytes: &[u8]) -> Option<[u8; 24]> {
    read_singleton_nonce(bytes, &MEMBER_NAMES_BLOB_MAGIC, &[])
}

/// The device-binding family's reserved 16-byte sync-plane blob-id, the
/// [`member_names_sync_id`] twin one row up. Group-derived for the same reason: it is
/// what lets a member address the blob the owner wrote, and it is why the id rotates
/// with the group key on member removal.
fn device_bindings_sync_id(shared: &SharedSingletonKey) -> Option<[u8; 16]> {
    let group = shared.group_bytes()?;
    Some(crate::plugins::device_binding::bindings_sync_id(&group))
}

/// The device-binding blob's sync discriminator (`read_singleton_nonce` over MYU5).
///
/// `MYU5` is this family's ONE generation, born `NTV6`-only exactly as `MYO5` is: there
/// is no `MYU1` form and no later `MY?5` generation to accept beside it. The `later`
/// list is empty because there is nothing to name, not because one was forgotten, which
/// is the shape `check-crypto-registries.mjs` rule 5 exists to catch;
/// `DEVICE_BINDING_BLOB_MAGIC` is deliberately off the `_V<n>_<m>_MAGIC` pattern, so the
/// family has no later magic for that rule to demand.
fn read_device_bindings_nonce(bytes: &[u8]) -> Option<[u8; 24]> {
    read_singleton_nonce(bytes, &DEVICE_BINDING_BLOB_MAGIC, &[])
}

/// `vault.chats`' reserved 16-byte sync-plane blob-id:
/// `DeriveSubkey(root_key, "chats-catalog-sync-id")[0..16]` (`protocol.md`
/// § 3.4, myne-md/myne#675): the `catalog_sync_id` / `prefs_sync_id` /
/// `themes_sync_id` twin.
pub fn chats_catalog_sync_id(root_key: &[u8; 32]) -> [u8; 16] {
    sync_id_for(root_key, SubkeyRole::ChatsCatalogSyncId)
}

/// The conversations-catalog blob's sync discriminator
/// (`read_singleton_nonce` over MYM1/MYM5 (both generations, the § 10.4.1
/// envelope convention: the nonce sits at the same offset in both, so one
/// reader covers the family. Accepting only v0.1 would make every reader
/// `None` on a migrated vault (myne-md/myne#638).
fn read_chats_catalog_nonce(bytes: &[u8]) -> Option<[u8; 24]> {
    read_singleton_nonce(
        bytes,
        &CHATS_CATALOG_BLOB_MAGIC,
        &[&CHATS_CATALOG_BLOB_V0_2_MAGIC],
    )
}

/// A conversation file's sync discriminator (`read_singleton_nonce` over
/// MYJ1/MYJ5, both generations, same envelope, same offset). The nonce
/// carries the per-conversation change, and an unchanged outer nonce proves
/// the file untouched since the last sync (no decrypt needed).
fn read_chats_blob_nonce(bytes: &[u8]) -> Option<[u8; 24]> {
    read_singleton_nonce(bytes, &CHATS_BLOB_MAGIC, &[&CHATS_BLOB_V0_2_MAGIC])
}

/// `<vault>/vault.chats`: the MYM1 conversations-catalog singleton.
fn chats_catalog_file_path(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join("vault.chats")
}

/// `<vault>/chats`: the MYJ1 per-conversation files directory.
fn chats_dir(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join("chats")
}

/// `vault.agent-memory`'s reserved 16-byte sync-plane blob-id:
/// `DeriveSubkey(root_key, "agent-memory-catalog-sync-id")[0..16]`
/// (`protocol.md` § 3.4, myne-md/myne#697): the `chats_catalog_sync_id`
/// twin.
pub fn agent_memory_catalog_sync_id(root_key: &[u8; 32]) -> [u8; 16] {
    sync_id_for(root_key, SubkeyRole::AgentMemoryCatalogSyncId)
}

/// The agent-memory-catalog blob's sync discriminator
/// (`read_singleton_nonce` over MYN1/MYN5 (both generations, the § 10.4.1
/// envelope convention: the nonce sits at the same offset in both, so one
/// reader covers the family. Accepting only v0.1 would make every reader
/// `None` on a migrated vault (myne-md/myne#638).
fn read_agent_memory_catalog_nonce(bytes: &[u8]) -> Option<[u8; 24]> {
    read_singleton_nonce(
        bytes,
        &AGENT_MEMORY_CATALOG_BLOB_MAGIC,
        &[&AGENT_MEMORY_CATALOG_BLOB_V0_2_MAGIC],
    )
}

/// A memory-entry file's sync discriminator (`read_singleton_nonce` over
/// MYX1/MYX5, both generations, same envelope, same offset). The nonce
/// carries the per-entry change, and an unchanged outer nonce proves the
/// file untouched since the last sync (no decrypt needed).
fn read_agent_memory_blob_nonce(bytes: &[u8]) -> Option<[u8; 24]> {
    read_singleton_nonce(
        bytes,
        &AGENT_MEMORY_BLOB_MAGIC,
        &[&AGENT_MEMORY_BLOB_V0_2_MAGIC],
    )
}

/// `vault.personality`'s reserved 16-byte sync-plane blob-id:
/// `DeriveSubkey(root_key, "agent-personality-sync-id")[0..16]`
/// (`protocol.md` § 3.4, myne-md/myne#697): the `themes_sync_id` twin.
pub fn agent_personality_sync_id(root_key: &[u8; 32]) -> [u8; 16] {
    sync_id_for(root_key, SubkeyRole::AgentPersonalitySyncId)
}

/// The personality blob's sync discriminator (`read_singleton_nonce` over
/// MYZ1/MYZ5, both generations, the same envelope convention).
fn read_personality_nonce(bytes: &[u8]) -> Option<[u8; 24]> {
    read_singleton_nonce(
        bytes,
        &AGENT_PERSONALITY_BLOB_MAGIC,
        &[&AGENT_PERSONALITY_BLOB_V0_2_MAGIC],
    )
}

/// Greatest `updated_at` over a DECODED personality plaintext
/// (`{"directives":[{text, updated_at}, …]}`), the whole-value LWW key
/// (§10.2.7). Unparseable input reads as 0: the merge only calls this on
/// bytes that already decrypted, so 0 means "empty voice", never "skip".
fn personality_max_updated_at(plaintext: &[u8]) -> u64 {
    serde_json::from_slice::<serde_json::Value>(plaintext)
        .ok()
        .and_then(|v| {
            v.get("directives")?
                .as_array()?
                .iter()
                .filter_map(|d| d.get("updated_at")?.as_u64())
                .max()
        })
        .unwrap_or(0)
}

/// `<vault>/vault.agent-memory`: the MYN1 agent-memory catalog singleton.
fn agent_memory_catalog_file_path(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join("vault.agent-memory")
}

/// `<vault>/memories`: the MYX1 per-entry memory files directory.
fn memories_dir(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join("memories")
}

/// `<vault>/vault.personality`: the MYZ1 personality singleton.
fn personality_file_path(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join("vault.personality")
}

/// The per-device `ai_enabled` gate for the memory plane (sync-protocol.md
/// §10.2.6/§10.2.7): a device with the opt-in off runs no memory phase and
/// pushes/pulls nothing for these ids. Read off the live `vault.prefs` at
/// scan time (the prefs phase may rewrite it later in the cycle, but the opt-in
/// is device-local and never merged, so the scan-time read cannot go stale
/// within a cycle). §9.5.5 read semantic: any decode failure falls back to
/// defaults, whose `ai_enabled` is off. An unreadable prefs file gates the
/// plane closed, never open.
async fn memory_sync_enabled(
    io: &dyn crate::vault_io::VaultIo,
    shared: &SharedSingletonKey,
    account_number_hash: &[u8; 16],
    vault_root: &Path,
    version: MetaVersion,
) -> bool {
    let prefs_key = shared.derive(version, SubkeyRole::PrefsKey);
    io.read(&vault_root.join("vault.prefs"))
        .await
        .ok()
        .and_then(|b| {
            protocol::decode_prefs_blob_versioned(version, &prefs_key, account_number_hash, &b).ok()
        })
        .map(|view| view.ai_enabled)
        .unwrap_or(false)
}

// NOTE: conversation deletions reclaim their server copy through the
// `pending-chats-tombstones` queue (one line per deleted conversation id),
// drained as blob-plane tombstone records in the chats push below. The
// attachments family needs a separate queue shape because attachment BLOBS
// are immutable and content-addressed, so a deletion must be re-pushed with
// a fresh nonce (`sync-protocol.md` §11.4). A conversation deletion is ALSO
// a catalog tombstone row (the row's causal version is the tombstone, the
// per-id causal join discards a concurrent append at merge, and no device
// ever pulls a conversation file its catalog does not name) — the queue
// exists only for the server-side reclaim the catalog row cannot express:
// without a blob-plane record the server ciphertext is orphaned permanently
// (never downloaded, never classified, never deleted).

/// `<vault>/vault.themes` — the MYT1 custom-themes singleton.
fn themes_file_path(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join("vault.themes")
}

/// `<vault>/vault.member-names`, the MYO5 member-names singleton.
fn member_names_file_path(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join(crate::plugins::member_names::MEMBER_NAMES_FILE)
}

/// `<vault>/vault.device-bindings`, the MYU5 device-binding singleton.
fn device_bindings_file_path(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join(crate::plugins::device_binding::DEVICE_BINDINGS_FILE)
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

/// Push the tombstones that let the server reclaim the blobs a whole-vault
/// re-key stranded (`sync-protocol.md` §5.6.1, myne-md/myne#443).
///
/// # Why this is its own request rather than three more entries in `to_push`
///
/// Its `base_version` is the version this device last saw, and the migration
/// may have run after a long offline stretch in which a peer wrote to the same
/// old singleton id. That makes a lost CAS genuinely reachable — and a
/// `blob_stale` 409 fails the **whole** chunk, so a stranded-storage entry mixed
/// into the content push would abort every push cycle, retry, abort again, and
/// wedge sync permanently on a cleanup errand. Reclaiming disk the user is not
/// paying attention to must never be able to cost them their sync.
///
/// So: separate request, no head, and the errors are triaged rather than
/// propagated.
///
/// - **Landed** → drop the entries; the records are `deleted`-marked and
///   horizon-GC will reclaim them on its own schedule.
/// - **A refusal about these blobs** (`BlobStale`, `QuotaExceeded`,
///   `PayloadTooLarge`, `BadResponse`) → drop them too. A wrong base version is
///   not something this device can learn the fix for — the server returns no
///   current version on a 409 — and retrying a request that is refused for a
///   structural reason produces one useless round trip per cycle forever. The
///   blobs stay stranded, which is exactly the pre-#443 state.
/// - **Anything else** (transport, 429, auth, frozen) → leave them queued. Those
///   say nothing about the request and everything about the moment.
///
/// Returns the number of tombstones the server accepted, for the caller's log.
async fn drain_orphan_tombstones(
    transport: &dyn SyncTransport,
    token: &str,
    state: &mut SyncState,
) -> usize {
    if state.pending_orphan_tombstones.is_empty() {
        return 0;
    }
    let mut blobs = Vec::new();
    for t in &state.pending_orphan_tombstones {
        // Strict: the orphan-tombstone queue is this client's own writer's
        // output (R1.2).
        let (Some(id), Some(content_nonce)) = (
            protocol::hex::decode_lower::<16>(&t.blob_id_hex),
            protocol::hex::decode_lower::<24>(&t.content_nonce_hex),
        ) else {
            continue;
        };
        blobs.push(PushBlob {
            id,
            base_version: t.base_version,
            content_nonce,
            // A tombstone record carries no body — the same shape the
            // attachment tombstone uses, and the one the server reads as
            // "mark this id deleted" (`SetTombstone`).
            ciphertext: Vec::new(),
            tombstone: true,
            // Not an attachment: there is no stored body to bridge to, only the
            // blob-plane record.
            attachment_id: None,
        });
    }
    // `(reclaimed, spent)` — one decision, so there is a single place the queue
    // is emptied and no arm can forget to.
    let (reclaimed, spent) = if blobs.is_empty() {
        // Every entry was malformed. Nothing to send, and nothing worth keeping:
        // a line that does not parse will not parse next cycle either.
        (0, true)
    } else {
        match engine::push(transport, token, &blobs, None) {
            Ok(outcome) => (outcome.results.len(), true),
            Err(
                PushError::BlobStale
                | PushError::HeadStale
                | PushError::QuotaExceeded
                | PushError::PayloadTooLarge
                | PushError::BadResponse,
            ) => {
                tracing::info!(
                    stage = "orphan_tombstones",
                    event = "abandoned",
                    count = blobs.len(),
                    "the re-key's stranded singleton blobs could not be marked \
                     for reclaim; they stay on the server as accepted storage debt"
                );
                (0, true)
            }
            Err(_) => (0, false),
        }
    };
    if spent {
        state.pending_orphan_tombstones.clear();
    }
    reclaimed
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
        // Strict: the attachment-tombstone queue is this client's own writer's
        // output (R1.2).
        let (Some(sync_id), Some(id), Some(content_nonce)) = (
            protocol::hex::decode_lower::<16>(p),
            protocol::hex::decode_lower::<32>(f),
            protocol::hex::decode_lower::<24>(n),
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

/// `download_attachment` with the same 429 backoff as [`download_blob_backoff`],
/// and — since #265 — RESUMING across those retries.
///
/// The engine's resume branch existed and was unreachable: both callers passed
/// an empty prefix and nothing ever produced a non-empty one, because a single
/// whole-body GET yields nothing at all when it fails. Upload has resumed from a
/// HEAD-probed offset since it shipped; download restarted from byte 0 on every
/// drop, which on a large attachment over a poor link is a transfer that cannot
/// finish.
///
/// The engine now fetches in ranges and reports each one, so `partial` grows
/// across attempts and a retry asks only for what is missing. A TRANSPORT
/// failure is retried too, not just a 429 — a dropped connection is exactly the
/// case resume exists for, and retrying it without a prefix would have been the
/// same restart in a longer loop.
///
/// The prefix lives in RAM for the duration of this call. Persisting it across
/// cycles would need the IO seam, which this synchronous path does not hold;
/// the win here is the one the defect was about — a 64 MiB attachment no longer
/// starts over because one range dropped.
fn download_attachment_backoff(
    transport: &dyn SyncTransport,
    token: &str,
    id: &[u8; 32],
) -> Result<Option<Vec<u8>>, PullError> {
    let mut delay_ms = 250u64;
    let mut partial: Vec<u8> = Vec::new();
    let mut last: Option<PullError> = None;
    for _ in 0..6 {
        // The prefix this attempt starts from, and a separate buffer the
        // progress callback fills. Two buffers rather than one because the
        // engine borrows the prefix for the whole call while the callback
        // writes — the same value cannot be both.
        let prefix = std::mem::take(&mut partial);
        let mut received: Vec<u8> = Vec::new();
        let mut progress = |so_far: &[u8]| {
            if so_far.len() > received.len() {
                received.clear();
                received.extend_from_slice(so_far);
            }
        };
        let outcome = engine::download_attachment(transport, token, id, &prefix, &mut progress);
        // `progress` is a closure, so this is not a `Drop` — it ends the
        // mutable borrow of `received` so the lines below can read it.
        // Written as a scope-ending rebind rather than `drop()`, which clippy
        // rejects on a non-`Drop` type.
        let _ = progress;
        // Keep whatever arrived — that is the whole point of resuming.
        partial = if received.len() > prefix.len() {
            received
        } else {
            prefix
        };
        match outcome {
            Err(PullError::RateLimited) => {
                crate::task::block_sleep(std::time::Duration::from_millis(delay_ms));
                delay_ms = (delay_ms * 2).min(2000);
                last = Some(PullError::RateLimited);
            }
            Err(PullError::Transport(t)) => {
                crate::task::block_sleep(std::time::Duration::from_millis(delay_ms));
                delay_ms = (delay_ms * 2).min(2000);
                last = Some(PullError::Transport(t));
            }
            other => return other,
        }
    }
    // Out of attempts: report the last real failure rather than silently
    // starting a seventh transfer.
    Err(last.unwrap_or(PullError::BadResponse))
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
    shared: &SharedSingletonKey,
    account_number_hash: &[u8; 16],
    vault_root: &Path,
    state: &mut SyncState,
    cat_id: &[u8; 16],
    remote_record: Option<&ChangedBlob>,
    version: MetaVersion,
) -> Result<CatalogPhase, SyncCycleError> {
    // See `apply_pulled_note_blob` — `blocking_lock` panics inside a runtime.
    let _guard = crate::plugins::attachments::commands::catalog_write_mutex()
        .lock()
        .await;

    let catalog_key = shared.derive(version, SubkeyRole::AttachmentsCatalogKey);
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

    // §11.3 gate — verify BEFORE any local mutation, exactly as the note and
    // attachment paths do. Bytes whose header nonce is not the one the record
    // advertised are dropped here, so neither the disk write nor the baseline
    // adoption below can see them.
    let verified = verified_singleton_download(
        transport,
        token,
        remote_record,
        remote_changed,
        read_catalog_nonce,
        "catalog",
    )?;

    if let SingletonPull::Verified(rec, remote_bytes) = verified {
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
            record_blob_baseline(state, &cat_hex, &rec);
            return Ok(CatalogPhase {
                merged,
                dirty: false,
            });
        }

        // Merge differs from the server → write it fresh and push it this
        // cycle against the server's current version.
        let merged_bytes = encode_attachments_catalog_versioned(
            version,
            &catalog_key,
            account_number_hash,
            &merged,
        )
        .map_err(|_| SyncCycleError::Io)?;
        io.write(&path, &merged_bytes, crate::vault_io::WriteOpts::default())
            .await
            .map_err(|_| SyncCycleError::Io)?;
        // Record the server's version as the CAS base WITHOUT claiming its
        // nonce (the local file now differs → dirty).
        record_blob_baseline(state, &cat_hex, &rec);
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
            doc_heads_hex: Vec::new(),
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

/// The two fields an enrollment seed does NOT adopt.
///
/// Extracted so it has a name, a place for its argument and a test. Inline it
/// was two assignments in the middle of a 300-line phase, and the review that
/// found the spec still describing the old behaviour also found that nothing
/// asserted the new one: the carve-out could have been deleted and every test in
/// this crate would have stayed green.
///
/// **Why these two and not "device-local fields".** `ai_provider_consent` is
/// device-local, and a device that inherited a consent it never gave would begin
/// sending this vault's note text to a named remote provider with nobody at that
/// device having seen the consent screen. `docs/spec/sync-protocol.md` §10.2.1
/// and `docs/threat-model.md` TB13 both name this seed path as one of the two
/// that had to close for the per-device claim to hold. `ai_enabled` goes with it
/// because it is the other half of the same gate: inherited "AI is on", plus an
/// inherited consent, plus the key (which still syncs), is a device fully
/// configured to send before anyone has touched it.
///
/// **Withheld, not derived from the classification table.** A loop over the
/// device-local fields would silently withhold the next field somebody
/// classifies device-local for an unrelated reason, and withholding a field from
/// a new device's seed is a decision rather than a consequence.
fn withhold_from_enrollment_seed(seeded: &mut protocol::PrefsView) {
    seeded.ai_provider_consent = None;
    seeded.ai_enabled = false;
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
    shared: &SharedSingletonKey,
    account_number_hash: &[u8; 16],
    vault_root: &Path,
    state: &mut SyncState,
    prefs_id: &[u8; 16],
    remote_record: Option<&ChangedBlob>,
    version: MetaVersion,
) -> Result<PrefsPhase, SyncCycleError> {
    use crate::plugins::sync::prefs_merge::{merge_prefs, shared_subset_hash};

    // See `apply_pulled_note_blob` — `blocking_lock` panics inside a runtime.
    let _guard = crate::plugins::prefs::commands::write_mutex().lock().await;

    let prefs_key = shared.derive(version, SubkeyRole::PrefsKey);
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
    // wholesale, device-local fields included as starting defaults, EXCEPT
    // `ai_provider_consent` and `ai_enabled`, which are cleared and the blob
    // re-encoded before the write (myne-md/myne#456). It said VERBATIM directly
    // above the code that stopped doing that, which is the shape a comment is
    // most expensive in. The carve-out is a security one: a device that
    // inherited a consent it never gave would begin sending this vault's note
    // text to a named remote provider with nobody at that device having seen the
    // consent screen, and `threat-model.md` TB13 cites this path by name. This runs
    // on the first authed cycle (a pending device has no token at join time)
    // and exactly once: after the seed the file exists, so every later cycle
    // merges. A server blob that fails decode falls through to the general
    // path (merge with defaults — the hostile-blob posture).
    if local_bytes.is_none() {
        // §11.3 gate. `decode_prefs_blob` below is NOT a substitute: it proves
        // the bytes are a valid `MYP1` for this vault, not that they are the
        // revision the record advertised — a server can serve a genuine older
        // blob under a newer record's nonce and the decode still succeeds.
        if let SingletonPull::Verified(rec, remote_bytes) = verified_singleton_download(
            transport,
            token,
            remote_record,
            true,
            read_prefs_nonce,
            "prefs-seed",
        )? {
            if let Ok(mut seeded) =
                protocol::decode_prefs_blob(&prefs_key, account_number_hash, &remote_bytes)
            {
                // **The two AI fields are withheld from the seed, and they are
                // the only device-local fields that are** (myne-md/myne#456).
                //
                // Adopting the rest verbatim is the recorded design and it is a
                // good one: a new device inheriting your theme, your editor
                // settings and your auto-lock timeout is a convenience nobody
                // has to ask for. A CONSENT is not a convenience. Inheriting it
                // means a device begins sending note plaintext to a third party
                // with nobody at that device having seen the screen that says
                // so, which is exactly what `docs/threat-model.md` TB13 names
                // as the crossing condition.
                //
                // Reclassifying the field to `DeviceLocal` (entry 0559) was
                // necessary and NOT sufficient: the classification is consumed
                // by `merge_prefs`, and a just-joined device never merges. It
                // has no local blob, so it takes this branch instead and the
                // whole closure was inert on the one path it was built for. The
                // `developer_mode` removal in entry 0558 rests on that closure,
                // which makes this the compensating half of a pair.
                //
                // `ai_enabled` goes with it: it is the other half of the gate
                // 0558's own module doc calls a pair, and a device that
                // inherited "AI is on" plus an inherited consent plus the synced
                // key is fully configured to send before anyone has touched it.
                //
                // Withheld, not defaulted from the classification table: this is
                // a narrow, argued carve-out rather than a rule about
                // device-local fields in general, and writing it as a loop over
                // `CLASSIFICATION` would silently withhold the next field
                // somebody classifies device-local for an unrelated reason.
                withhold_from_enrollment_seed(&mut seeded);
                // **The VERSIONED encoder, like every other write in this
                // function.** The v0.1-only twin compiles, passes every test run
                // against an unmigrated vault, and stamps the v0.1 magic
                // unconditionally, so a v0.2 vault would quietly grow a v0.1
                // prefs blob here. Every decoder is magic-detecting, so nothing
                // downstream would ever report the hybrid, and enrollment is
                // exactly the path a migrated vault reaches on a new device.
                // Caught by scripts/check-version-routing.mjs, which exists for
                // this failure and nothing else.
                let seed_bytes = protocol::encode_prefs_blob_versioned(
                    version,
                    &prefs_key,
                    account_number_hash,
                    &seeded,
                )
                .map_err(|_| SyncCycleError::Io)?;
                io.write(&path, &seed_bytes, crate::vault_io::WriteOpts::default())
                    .await
                    .map_err(|_| SyncCycleError::Io)?;
                record_blob_baseline(state, &id_hex, &rec);
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

    // §11.3 gate — before the write and before the baseline adoption.
    let verified = verified_singleton_download(
        transport,
        token,
        remote_record,
        remote_changed,
        read_prefs_nonce,
        "prefs",
    )?;

    let refused = matches!(verified, SingletonPull::Refused);
    if let SingletonPull::Verified(rec, remote_bytes) = verified {
        // A hostile/corrupt remote prefs blob collapses to defaults (§9.5.5);
        // merge(local, default) keeps every locally-clocked value and the
        // local view re-pushes over it.
        let remote_view =
            protocol::decode_prefs_blob(&prefs_key, account_number_hash, &remote_bytes)
                .unwrap_or_default();
        let mut merged = merge_prefs(&local_view, &remote_view);
        // myne#613: the merge is deliberately unbounded, because a budget
        // applied DURING it makes refusal order-dependent and breaks
        // `merge(a,b) == merge(b,a)`. So the bound is applied to its RESULT,
        // where the input is the same set on both devices and the shedding
        // order is total, which is what keeps both devices at the same bytes.
        //
        // Without it, two peers each just inside the local write budget merge to
        // roughly twice the cap (61,415 bytes each, 122,756 together, measured),
        // `encode_prefs_blob_versioned` below returns `Err`, and the
        // `map_err(|_| SyncCycleError::Io)?` on it used to abort the WHOLE cycle
        // before the notes phase, every cycle, with no way out: the local
        // deletions that would shrink the blob could never reach the peer.
        crate::plugins::prefs::set_mutation::shed_retained_clocks(&mut merged);
        let merged = merged;
        let applied_remote = merged != local_view;
        let merged_hash = shared_subset_hash(&merged);
        let remote_hash = shared_subset_hash(&remote_view);

        if merged == remote_view {
            // Adopt the server bytes VERBATIM — byte-identical blob + baseline
            // == server (version, nonce); nothing to push.
            io.write(&path, &remote_bytes, crate::vault_io::WriteOpts::default())
                .await
                .map_err(|_| SyncCycleError::Io)?;
            record_blob_baseline(state, &id_hex, &rec);
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
                let merged_bytes = protocol::encode_prefs_blob_versioned(
                    version,
                    &prefs_key,
                    account_number_hash,
                    &merged,
                )
                .map_err(|_| SyncCycleError::Io)?;
                io.write(&path, &merged_bytes, crate::vault_io::WriteOpts::default())
                    .await
                    .map_err(|_| SyncCycleError::Io)?;
            }
            record_blob_baseline(state, &id_hex, &rec);
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
        let merged_bytes = protocol::encode_prefs_blob_versioned(
            version,
            &prefs_key,
            account_number_hash,
            &merged,
        )
        .map_err(|_| SyncCycleError::Io)?;
        io.write(&path, &merged_bytes, crate::vault_io::WriteOpts::default())
            .await
            .map_err(|_| SyncCycleError::Io)?;
        record_blob_baseline(state, &id_hex, &rec);
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
    if let Some(rec) = remote_record.filter(|_| !refused) {
        // Self-heal the CAS baseline so a re-enrolled/migrated device stops
        // registering as never-synced. Skipped when the pull was REFUSED: §11.3
        // bars the baseline adoption as well as the disk write, and adopting a
        // refused record's advertised nonce is exactly that.
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
    /// The exact bytes to push, carried out of the phase whenever `dirty` — the
    /// merged store it just wrote, or the verified local store it just read.
    ///
    /// The phase hands these over rather than letting the push site re-read the
    /// file, because re-reading meant re-deriving the KEK, and that second
    /// derivation drifted: it stayed v0.1 after the phase became version-aware,
    /// so a migrated vault's `MYT5` never opened there (myne-md/myne#436). The
    /// reader is a strict verifier that answers `None` rather than erroring, so
    /// the push was skipped with no log, no toast and no failed cycle. `Some`
    /// exactly when `dirty` — one derivation, at the one site that already had
    /// the plaintext in hand.
    push_bytes: Option<Vec<u8>>,
}

/// The outcome of the chats catalog phase, consumed by the conversation-file
/// loop (the merged catalog is the authoritative § 11.4 roster) and the push
/// phase (a dirty catalog rides the same batch).
struct ChatsPhase {
    /// The post-merge catalog (== the on-disk catalog when this returns).
    merged: crate::plugins::chats::commands::ChatsCatalogMap,
    /// The catalog needs a push (local-only change, or a merge that differed
    /// from the server's plaintext).
    dirty: bool,
    /// A remote change was merged onto the on-disk catalog this cycle.
    applied_remote: bool,
    /// The exact bytes to push, carried out of the phase whenever `dirty`:
    /// the myne#436 single-derivation discipline (the push site never
    /// re-derives the KEK).
    push_bytes: Option<Vec<u8>>,
    /// The chats plane was refused this cycle (unreadable local catalog, or
    /// a verified remote record that failed schema parse): no reconciliation
    /// ran, nothing is dirty, nothing pushes. Scoped here rather than
    /// aborting the whole cycle: an unreadable chats store must never stall
    /// note or attachment sync, and skipping satisfies the same
    /// never-merge-over-unreadable guarantee (no reconciliation is no
    /// adoption). Implies `dirty == false`, `applied_remote == false`, and
    /// an empty `merged` (so the catalog-guarded loops downstream are inert
    /// by construction, not by coincidence).
    skipped: bool,
}

/// The one refused outcome every `sync_chats_phase` refusal arm returns: no
/// reconciliation, nothing dirty, nothing to push. A constructor rather than
/// five hand-written literals, so a sixth arm cannot invent a new shape.
fn skipped_chats_phase() -> ChatsPhase {
    ChatsPhase {
        merged: crate::plugins::chats::commands::ChatsCatalogMap::default(),
        dirty: false,
        applied_remote: false,
        push_bytes: None,
        skipped: true,
    }
}

/// Pull-side `vault.chats` reconciliation (myne-md/myne#675). The
/// `sync_themes_phase` twin, minus the fall-back-to-empty arm: conversations
/// are load-bearing user content, so the read semantic is
/// report-don't-empty (§ 9.23.3) and the catalog phase MUST behave
/// accordingly:
///
/// - An unreadable local catalog refuses reconciliation outright: the phase
///   returns the SKIPPED outcome (no chats reconciliation this cycle, the
///   rest of sync proceeds), so an unreadable store can never be adopted as
///   the merge base and then re-pushed over the server (the
///   reconstruction-over-real-content failure the fall-back rule forbids).
///   No remote pull can heal a corrupt local catalog except an adoption, and
///   adoption requires the remote write to win the causal merge, which it
///   cannot do against unknown local content, so the plane stands down and
///   the user is told (`tracing::warn`, the per-conversation arm's surface).
///   The refusal is scoped to the chats plane rather than aborting the whole
///   cycle: an unreadable chats store must never stall note or attachment
///   sync.
/// - A remote record whose bytes verify merges per-id (causal `version`,
///   remove-wins ties (`merge_chats_catalog`), then either adopts the
///   server bytes verbatim (merge equal to the remote map: re-encrypting
///   would nonce-churn an endless push loop) or writes the merged catalog
///   freshly (dirty, pushed this cycle against the server's version). A
///   verified remote record that fails schema parse is the same skipped
///   refusal, local store untouched.
/// - No changed remote record: dirty iff the local catalog drifted from the
///   synced baseline. A virgin no-conversations vault (no file, no baseline)
///   is deliberately NOT pushed: it stays chats-silent exactly as an
///   attachment-less vault stays catalog-silent.
///
/// `merged == remote_map` comparison is on the DECODED maps (not bytes): the
/// local re-encode of an identical map is byte-identical under the canonical
/// JSON, so no spurious dirty.
///
/// Holds the chats plugin's write mutex across the read-merge-write: the
/// CALLER takes it before invoking this phase and holds it through the
/// conversation loop that follows (ONE critical section, taken at the call
/// site because a tokio Mutex is not reentrant; shared with the plugin
/// commands). Each argument is a distinct cycle input (same shape as the
/// sibling phases); a bundling struct would not aid clarity at this single
/// internal call site.
#[allow(clippy::too_many_arguments)]
async fn sync_chats_phase(
    io: &dyn crate::vault_io::VaultIo,
    transport: &dyn SyncTransport,
    token: &str,
    root_key: &[u8; 32],
    account_number_hash: &[u8; 16],
    vault_root: &Path,
    state: &mut SyncState,
    chats_catalog_id: &[u8; 16],
    remote_record: Option<&ChangedBlob>,
    version: MetaVersion,
) -> Result<ChatsPhase, SyncCycleError> {
    use crate::plugins::chats::commands::ChatsCatalogMap;
    use protocol::{
        decode_chats_catalog_blob, decode_chats_catalog_blob_versioned,
        encode_chats_catalog_blob_versioned,
    };

    let chats_catalog_key = derive_subkey_versioned(version, root_key, SubkeyRole::ChatsCatalogKey);

    // Read + decode the local catalog. A refusal (unreadable store) degrades
    // to a skipped phase: no reconciliation this cycle, nothing pushed, the
    // rest of sync proceeds. Never-merge-over-unreadable holds by
    // construction: an unreadable store is never adopted as the merge base
    // and never re-pushed over the server.
    let path = chats_catalog_file_path(vault_root);
    let local_bytes: Option<Vec<u8>> = match crate::singleton::open_newest_and_sweep(
        io,
        &path,
        |bytes| {
            decode_chats_catalog_blob(&chats_catalog_key, account_number_hash, bytes).map(|_| ())
        },
    )
    .await
    {
        Ok(()) => match io.read(&path).await {
            Ok(bytes) => Some(bytes),
            // The sweep just proved the file exists and decodes: a
            // failed re-read is a read FAILURE, not an absence. Treating
            // it as `None` would decode to the empty roster and adopt the
            // server bytes verbatim over a live local catalog, dropping
            // local-only rows. Same skipped refusal as the `Io` arm.
            Err(kind) => {
                tracing::warn!(
                    stage = "chats-catalog",
                    io_failure_kind = ?kind,
                    "local conversations catalog re-read failed after a successful sweep; skipping the chats plane this cycle"
                );
                return Ok(skipped_chats_phase());
            }
        },
        Err(crate::singleton::OpenOutcome::Absent) => None,
        Err(crate::singleton::OpenOutcome::Undecodable(_)) => {
            tracing::warn!(
                stage = "chats-catalog",
                "local conversations catalog is unreadable; skipping the chats plane this cycle"
            );
            return Ok(skipped_chats_phase());
        }
        Err(crate::singleton::OpenOutcome::Io(kind)) => {
            tracing::warn!(
                stage = "chats-catalog",
                io_failure_kind = ?kind,
                "local conversations catalog read failed; skipping the chats plane this cycle"
            );
            return Ok(skipped_chats_phase());
        }
    };
    let decode_map = |bytes: Option<&[u8]>| -> Result<ChatsCatalogMap, ()> {
        match bytes {
            None => Ok(ChatsCatalogMap::default()),
            Some(b) => {
                let plaintext = decode_chats_catalog_blob_versioned(
                    version,
                    &chats_catalog_key,
                    account_number_hash,
                    b,
                )
                .map_err(|_| ())?;
                serde_json::from_slice(&plaintext).map_err(|_| ())
            }
        }
    };
    let local_map = match decode_map(local_bytes.as_deref()) {
        Ok(map) => map,
        Err(()) => {
            tracing::warn!(
                stage = "chats-catalog",
                "local conversations catalog does not parse; skipping the chats plane this cycle"
            );
            return Ok(skipped_chats_phase());
        }
    };
    let local_nonce = local_bytes.as_deref().and_then(read_chats_catalog_nonce);

    let id_hex = hex(chats_catalog_id);
    let baseline_nonce_hex = state
        .blobs
        .get(&id_hex)
        .map(|b| b.content_nonce_hex.clone());

    // A remote record whose nonce we already hold needs no download.
    let remote_changed = remote_record
        .map(|r| Some(r.content_nonce) != local_nonce)
        .unwrap_or(false);

    // §11.3 gate: an unverified remote adoption MUST NOT write over the live
    // catalog (the empty-read reconstruction failure).
    let verified = verified_singleton_download(
        transport,
        token,
        remote_record,
        remote_changed,
        read_chats_catalog_nonce,
        "chats-catalog",
    )?;

    if let SingletonPull::Verified(rec, remote_bytes) = verified {
        // The remote bytes verified against the record: decode them into the
        // remote map for the merge. An unverifiable remote payload (decodable
        // as a file but not as the catalog schema) is treated as refused: the
        // local store stays untouched and the chats plane is skipped for the
        // cycle (same scoped refusal as the unreadable-local arm; merging an
        // unparseable remote map is never an option).
        let remote_map: ChatsCatalogMap = match decode_chats_catalog_blob_versioned(
            version,
            &chats_catalog_key,
            account_number_hash,
            &remote_bytes,
        ) {
            Ok(plaintext) => match serde_json::from_slice(&plaintext) {
                Ok(map) => map,
                Err(_) => {
                    tracing::warn!(
                        stage = "chats-catalog",
                        "verified remote conversations catalog does not parse; \
                         skipping the chats plane this cycle"
                    );
                    return Ok(skipped_chats_phase());
                }
            },
            Err(_) => {
                tracing::warn!(
                    stage = "chats-catalog",
                    "verified remote conversations catalog does not decrypt; \
                     skipping the chats plane this cycle"
                );
                return Ok(skipped_chats_phase());
            }
        };
        let merged = crate::plugins::sync::conflict::merge_chats_catalog(&local_map, &remote_map);
        let applied_remote = merged != local_map;

        let (bytes, dirty) = if merged == remote_map {
            // Adopt the server bytes VERBATIM: byte-identical store +
            // baseline == server (version, nonce); nothing to push.
            (remote_bytes, false)
        } else {
            // The merge beat the server's store → write it fresh and push it
            // this cycle against the server's current version.
            let plaintext = serde_json::to_vec(&merged).map_err(|_| SyncCycleError::Io)?;
            let sealed = encode_chats_catalog_blob_versioned(
                version,
                &chats_catalog_key,
                account_number_hash,
                &plaintext,
            )
            .map_err(|_| SyncCycleError::Io)?;
            (sealed, true)
        };
        io.write(&path, &bytes, crate::vault_io::WriteOpts::default())
            .await
            .map_err(|_| SyncCycleError::Io)?;
        record_blob_baseline(state, &id_hex, &rec);
        return Ok(ChatsPhase {
            merged,
            dirty,
            applied_remote,
            push_bytes: dirty.then_some(bytes),
            skipped: false,
        });
    }

    // The local catalog always decodes here (a decode failure skipped above),
    // so this arm is exactly the "local readable, remote unchanged" case.

    // No (changed) remote catalog: dirty iff the local file drifted from the
    // synced baseline. A virgin no-conversations vault (no file, no baseline)
    // is NOT pushed: chats-silent by default.
    let local_nonce_hex = local_nonce.map(|n| hex(&n));
    let dirty = local_bytes.is_some()
        && local_nonce_hex != baseline_nonce_hex
        && !(baseline_nonce_hex.is_none() && local_map.is_empty());
    Ok(ChatsPhase {
        merged: local_map,
        dirty,
        applied_remote: false,
        // `dirty` already implies `local_bytes.is_some()`, the VERIFIED
        // bytes (a failed decode skipped above): the same ones the push
        // must carry (the myne#436 single-derivation discipline).
        push_bytes: if dirty { local_bytes } else { None },
        skipped: false,
    })
}

// ---------------------------------------------------------------------------
// agent-memory catalog phase (myne-md/myne#697, sync-protocol.md §10.2.6)
// ---------------------------------------------------------------------------

/// The memory phase's outcome (the `ChatsPhase` twin, minus the fall-back arm).
struct MemoryPhase {
    /// The post-merge catalog (== the on-disk catalog when this returns).
    merged: crate::plugins::memory::commands::MemoryCatalogMap,
    /// The catalog needs a push (local-only change, or a merge that differed
    /// from the server's plaintext).
    dirty: bool,
    /// A remote change was merged onto the on-disk catalog this cycle.
    applied_remote: bool,
    /// The exact bytes to push, carried out of the phase whenever `dirty`:
    /// the myne#436 single-derivation discipline (the push site never
    /// re-derives the KEK).
    push_bytes: Option<Vec<u8>>,
    /// The memory plane was refused this cycle (unreadable local catalog, or
    /// a verified remote record that failed schema parse): no reconciliation
    /// ran, nothing is dirty, nothing pushes. Scoped here rather than
    /// aborting the whole cycle, exactly like the chats refusal.
    skipped: bool,
    /// The pre-merge local row versions (id-hex → version, absent = no local
    /// row): the entry loop's both-changed arbiter. The merged row whose
    /// version differs from the local one is the remote winner (adopt its
    /// file); a merged row at the local version is the local winner (push our
    /// file). Deterministic on both sides because both compute the same merge
    /// and each compares against its own pre-merge row.
    local_versions: BTreeMap<String, u64>,
}

/// The one refused outcome every `sync_memory_phase` refusal arm returns.
fn skipped_memory_phase() -> MemoryPhase {
    MemoryPhase {
        merged: crate::plugins::memory::commands::MemoryCatalogMap::default(),
        dirty: false,
        applied_remote: false,
        push_bytes: None,
        skipped: true,
        local_versions: BTreeMap::new(),
    }
}

/// Pull-side `vault.agent-memory` reconciliation (myne-md/myne#697). The
/// `sync_chats_phase` twin, minus the fall-back-to-empty arm: memory is
/// load-bearing user content, so the read semantic is report-don't-empty
/// (§ 9.25.3) and the catalog phase MUST behave accordingly. Behind the
/// per-device `ai_enabled` gate: a device with the opt-in off runs no memory
/// phase at all (the caller checks before invoking; this function assumes the
/// gate passed).
///
/// `merged == remote_map` comparison is on the DECODED maps (not bytes): the
/// local re-encode of an identical map is byte-identical under the canonical
/// JSON, so no spurious dirty.
///
/// Holds the memory plugin's write mutex across the read-merge-write: the
/// CALLER takes it before invoking this phase and holds it through the entry
/// loop that follows (ONE critical section, taken at the call site because a
/// tokio Mutex is not reentrant; shared with the plugin commands).
#[allow(clippy::too_many_arguments)]
async fn sync_memory_phase(
    io: &dyn crate::vault_io::VaultIo,
    transport: &dyn SyncTransport,
    token: &str,
    root_key: &[u8; 32],
    account_number_hash: &[u8; 16],
    vault_root: &Path,
    state: &mut SyncState,
    memory_catalog_id: &[u8; 16],
    remote_record: Option<&ChangedBlob>,
    version: MetaVersion,
) -> Result<MemoryPhase, SyncCycleError> {
    use crate::plugins::memory::commands::MemoryCatalogMap;
    use protocol::{
        decode_agent_memory_catalog_blob_versioned, encode_agent_memory_catalog_blob_versioned,
    };

    let memory_catalog_key =
        derive_subkey_versioned(version, root_key, SubkeyRole::AgentMemoryCatalogKey);

    // Read + decode the local catalog. A refusal (unreadable store) degrades
    // to a skipped phase: no reconciliation this cycle, nothing pushed, the
    // rest of sync proceeds. Never-merge-over-unreadable holds by
    // construction.
    let path = agent_memory_catalog_file_path(vault_root);
    let local_bytes: Option<Vec<u8>> = match crate::singleton::open_newest_and_sweep(
        io,
        &path,
        |bytes| {
            decode_agent_memory_catalog_blob_versioned(
                version,
                &memory_catalog_key,
                account_number_hash,
                bytes,
            )
            .map(|_| ())
        },
    )
    .await
    {
        Ok(()) => match io.read(&path).await {
            Ok(bytes) => Some(bytes),
            Err(kind) => {
                tracing::warn!(
                    stage = "memory-catalog",
                    io_failure_kind = ?kind,
                    "local agent-memory catalog re-read failed after a successful sweep; skipping the memory plane this cycle"
                );
                return Ok(skipped_memory_phase());
            }
        },
        Err(crate::singleton::OpenOutcome::Absent) => None,
        Err(crate::singleton::OpenOutcome::Undecodable(_)) => {
            tracing::warn!(
                stage = "memory-catalog",
                "local agent-memory catalog is unreadable; skipping the memory plane this cycle"
            );
            return Ok(skipped_memory_phase());
        }
        Err(crate::singleton::OpenOutcome::Io(kind)) => {
            tracing::warn!(
                stage = "memory-catalog",
                io_failure_kind = ?kind,
                "local agent-memory catalog read failed; skipping the memory plane this cycle"
            );
            return Ok(skipped_memory_phase());
        }
    };
    let decode_map = |bytes: Option<&[u8]>| -> Result<MemoryCatalogMap, ()> {
        match bytes {
            None => Ok(MemoryCatalogMap::default()),
            Some(b) => {
                let plaintext = decode_agent_memory_catalog_blob_versioned(
                    version,
                    &memory_catalog_key,
                    account_number_hash,
                    b,
                )
                .map_err(|_| ())?;
                serde_json::from_slice(&plaintext).map_err(|_| ())
            }
        }
    };
    let local_map = match decode_map(local_bytes.as_deref()) {
        Ok(map) => map,
        Err(()) => {
            tracing::warn!(
                stage = "memory-catalog",
                "local agent-memory catalog does not parse; skipping the memory plane this cycle"
            );
            return Ok(skipped_memory_phase());
        }
    };
    let local_nonce = local_bytes
        .as_deref()
        .and_then(read_agent_memory_catalog_nonce);
    let local_versions: BTreeMap<String, u64> = local_map
        .iter()
        .map(|(k, row)| (k.clone(), row.version))
        .collect();

    let id_hex = hex(memory_catalog_id);
    let baseline_nonce_hex = state
        .blobs
        .get(&id_hex)
        .map(|b| b.content_nonce_hex.clone());

    let remote_changed = remote_record
        .map(|r| Some(r.content_nonce) != local_nonce)
        .unwrap_or(false);

    // §11.3 gate: an unverified remote adoption MUST NOT write over the live
    // catalog.
    let verified = verified_singleton_download(
        transport,
        token,
        remote_record,
        remote_changed,
        read_agent_memory_catalog_nonce,
        "memory-catalog",
    )?;

    if let SingletonPull::Verified(rec, remote_bytes) = verified {
        let remote_map: MemoryCatalogMap = match decode_agent_memory_catalog_blob_versioned(
            version,
            &memory_catalog_key,
            account_number_hash,
            &remote_bytes,
        ) {
            Ok(plaintext) => match serde_json::from_slice(&plaintext) {
                Ok(map) => map,
                Err(_) => {
                    tracing::warn!(
                        stage = "memory-catalog",
                        "verified remote agent-memory catalog does not parse;                          skipping the memory plane this cycle"
                    );
                    return Ok(skipped_memory_phase());
                }
            },
            Err(_) => {
                tracing::warn!(
                    stage = "memory-catalog",
                    "verified remote agent-memory catalog does not decrypt;                      skipping the memory plane this cycle"
                );
                return Ok(skipped_memory_phase());
            }
        };
        let merged = crate::plugins::sync::conflict::merge_memory_catalog(&local_map, &remote_map);
        let applied_remote = merged != local_map;

        let (bytes, dirty) = if merged == remote_map {
            // Adopt the server bytes VERBATIM: byte-identical store +
            // baseline == server (version, nonce); nothing to push.
            (remote_bytes, false)
        } else {
            let plaintext = serde_json::to_vec(&merged).map_err(|_| SyncCycleError::Io)?;
            let sealed = encode_agent_memory_catalog_blob_versioned(
                version,
                &memory_catalog_key,
                account_number_hash,
                &plaintext,
            )
            .map_err(|_| SyncCycleError::Io)?;
            (sealed, true)
        };
        io.write(&path, &bytes, crate::vault_io::WriteOpts::default())
            .await
            .map_err(|_| SyncCycleError::Io)?;
        record_blob_baseline(state, &id_hex, &rec);
        return Ok(MemoryPhase {
            merged,
            dirty,
            applied_remote,
            push_bytes: dirty.then_some(bytes),
            skipped: false,
            local_versions,
        });
    }

    // No (changed) remote catalog: dirty iff the local file drifted from the
    // synced baseline. A virgin no-memories vault (no file, no baseline) is
    // deliberately NOT pushed: memory-silent by default.
    let local_nonce_hex = local_nonce.map(|n| hex(&n));
    let dirty = local_bytes.is_some()
        && local_nonce_hex != baseline_nonce_hex
        && !(baseline_nonce_hex.is_none() && local_map.is_empty());
    Ok(MemoryPhase {
        merged: local_map,
        dirty,
        applied_remote: false,
        push_bytes: if dirty { local_bytes } else { None },
        skipped: false,
        local_versions,
    })
}

/// The outcome of one entry-file reconcile: what the cycle must push (if
/// anything) and the remote record this merge reconciled, if any (its version
/// is the CAS base; its nonce is the baseline either way).
#[derive(Debug)]
struct MemoryEntryPhase {
    /// The merged store was written this cycle and differs from the server's
    /// plaintext: push these exact bytes (myne#436 single-derivation: the
    /// push site never re-derives the KEK).
    push_bytes: Option<Vec<u8>>,
    /// The remote record this merge reconciled, if any.
    remote: Option<ChangedBlob>,
}

/// Pull-side reconcile of ONE per-entry file (`memories/<id-hex>`, `MYX1`,
/// § 9.26 + `sync-protocol.md` § 10.2.6). Called for every live catalog row
/// (after the catalog phase merged) under the memory plugin's write mutex.
/// Adopt-by-catalog-winner: the catalog merge already decided per-id which
/// side's row won, so bodies are never content-merged (unlike conversation
/// turns):
///
/// - No remote change: the file is verified-nonce-clean or left alone.
/// - Remote change, local clean: verified download → adopt verbatim.
/// - Local dirty, remote unchanged: push the local bytes.
/// - Both changed: the catalog winner decides (`remote_wins`, computed by the
///   caller from the merged row version against the pre-merge local one).
///   A tie (both bumped to the same version) reads as a local win on both
///   sides; both push, one 409s, the loser adopts next cycle, one extra
///   round-trip, still convergent on a last-writer-wins server.
///
/// Absent and unreadable are different answers: a file that exists but cannot
/// be read refuses this reconcile for the cycle, never merges as empty (which
/// would adopt the remote bytes over an entry that never reached the server).
#[allow(clippy::too_many_arguments)]
async fn sync_memory_entry_phase(
    io: &dyn crate::vault_io::VaultIo,
    transport: &dyn SyncTransport,
    token: &str,
    root_key: &[u8; 32],
    account_number_hash: &[u8; 16],
    vault_root: &Path,
    state: &mut SyncState,
    entry_id: &[u8; 16],
    remote_record: Option<&ChangedBlob>,
    remote_wins: bool,
    version: MetaVersion,
) -> Result<MemoryEntryPhase, SyncCycleError> {
    use protocol::decode_agent_memory_blob_versioned;

    let memory_key = derive_subkey_versioned(version, root_key, SubkeyRole::AgentMemoryKey);

    let id_hex = hex(entry_id);
    let path = memories_dir(vault_root).join(&id_hex);

    let local_bytes: Option<Vec<u8>> = match io.read(&path).await {
        Ok(bytes) => Some(bytes),
        Err(crate::io_failure_kind::IoFailureKind::NotFound) => None,
        Err(_) => return Err(SyncCycleError::Io),
    };
    let local_nonce = local_bytes
        .as_deref()
        .and_then(read_agent_memory_blob_nonce);

    let baseline_nonce_hex = state_baseline_nonce(state, &id_hex);
    let local_dirty = local_bytes.is_some()
        && baseline_nonce_hex.is_some()
        && local_nonce.map(|n| hex(&n)) != baseline_nonce_hex;

    let remote_changed = remote_record
        .map(|r| Some(r.content_nonce) != local_nonce)
        .unwrap_or(false);
    let verified = verified_singleton_download(
        transport,
        token,
        remote_record,
        remote_changed,
        read_agent_memory_blob_nonce,
        "memory-entry",
    )?;

    if let SingletonPull::Verified(rec, remote_bytes) = verified {
        // The remote bytes verified against the record: they must still
        // decode as an entry file (a verified-but-undecodable payload is a
        // refusal, never an adoption).
        if decode_agent_memory_blob_versioned(
            version,
            &memory_key,
            account_number_hash,
            entry_id,
            &remote_bytes,
        )
        .is_err()
        {
            tracing::warn!(
                stage = "memory-entry",
                "verified remote memory entry does not decrypt; skipping it for this cycle"
            );
            return Err(SyncCycleError::Io);
        }
        let take_remote = !local_dirty || remote_wins;
        if take_remote {
            // The `memories/` directory is created by a LOCAL write
            // (`memory::commands::write_entry_in_dir`), so a device that has
            // never authored a memory of its own (a phone that only pulls) does
            // not have it, and `atomic_write` requires its parent to exist.
            // Without this the adopt arm fails `NotFound`, the caller skips the
            // entry for the cycle, and it fails again every cycle: the catalog
            // (a vault-root singleton) syncs, so the roster lists rows whose
            // bodies never land. This closes that cause; a `create_dir_all`
            // failure of its own (a read-only vault, a permission denial) lands
            // in the same swallow-with-a-warning skip. The chats conversation
            // phase does the same step for `chats/` (myne-md/myne#883).
            io.create_dir_all(&memories_dir(vault_root))
                .await
                .map_err(|_| SyncCycleError::Io)?;
            io.write(&path, &remote_bytes, crate::vault_io::WriteOpts::default())
                .await
                .map_err(|_| SyncCycleError::Io)?;
            return Ok(MemoryEntryPhase {
                push_bytes: None,
                remote: Some(rec),
            });
        }
        // Local winner: keep our file; the push arm carries it below.
        return Ok(MemoryEntryPhase {
            push_bytes: local_bytes,
            remote: Some(rec),
        });
    }

    // No (changed) remote entry: push iff locally dirty.
    Ok(MemoryEntryPhase {
        push_bytes: if local_dirty { local_bytes } else { None },
        remote: None,
    })
}

/// The synced-baseline nonce for one blob-plane id, as an owned hex string
/// (the entry phase's dirty rule needs it by value; the call sites that hold
/// `state` borrows keep their own shape).
fn state_baseline_nonce(state: &SyncState, id_hex: &str) -> Option<String> {
    state.blobs.get(id_hex).map(|b| b.content_nonce_hex.clone())
}

// ---------------------------------------------------------------------------
// personality singleton phase (myne-md/myne#697, sync-protocol.md §10.2.7)
// ---------------------------------------------------------------------------

/// The personality phase's outcome (the themes-shape singleton phase).
struct PersonalityPhase {
    /// The post-merge blob (== the on-disk blob when this returns).
    merged: Option<Vec<u8>>,
    /// The personality needs a push (local-only change, or a merge that
    /// differed from the server's bytes).
    dirty: bool,
    /// A remote change was merged onto the on-disk blob this cycle.
    applied_remote: bool,
    /// The exact bytes to push, carried out of the phase whenever `dirty`.
    push_bytes: Option<Vec<u8>>,
    /// Refused this cycle: no reconciliation ran, nothing pushes.
    skipped: bool,
}

fn skipped_personality_phase() -> PersonalityPhase {
    PersonalityPhase {
        merged: None,
        dirty: false,
        applied_remote: false,
        push_bytes: None,
        skipped: true,
    }
}

/// Pull-side `vault.personality` reconciliation (myne-md/myne#697): whole-value
/// LWW on the canonical encoding (the themes-palette rule verbatim: never
/// directive-by-directive). Behind the per-device `ai_enabled` gate like the
/// memory phase.
#[allow(clippy::too_many_arguments)]
async fn sync_personality_phase(
    io: &dyn crate::vault_io::VaultIo,
    transport: &dyn SyncTransport,
    token: &str,
    root_key: &[u8; 32],
    account_number_hash: &[u8; 16],
    vault_root: &Path,
    state: &mut SyncState,
    personality_id: &[u8; 16],
    remote_record: Option<&ChangedBlob>,
    version: MetaVersion,
) -> Result<PersonalityPhase, SyncCycleError> {
    use protocol::decode_agent_personality_blob_versioned;

    // The memory plane's write mutex (the themes discipline): a user edit
    // landing between this phase's read and its write would otherwise be
    // silently overwritten (myne-md/myne#697). The memory pair holds the
    // same mutex at its call sites; the phase holds it for the whole
    // reconcile so read and write are one critical section.
    let _guard = crate::plugins::memory::commands::write_mutex()
        .lock_owned()
        .await;
    let personality_key =
        derive_subkey_versioned(version, root_key, SubkeyRole::AgentPersonalityKey);

    let path = personality_file_path(vault_root);
    let local_bytes: Option<Vec<u8>> = match crate::singleton::open_newest_and_sweep(
        io,
        &path,
        |bytes| {
            decode_agent_personality_blob_versioned(
                version,
                &personality_key,
                account_number_hash,
                bytes,
            )
            .map(|_| ())
        },
    )
    .await
    {
        Ok(()) => match io.read(&path).await {
            Ok(bytes) => Some(bytes),
            Err(kind) => {
                tracing::warn!(
                    stage = "personality",
                    io_failure_kind = ?kind,
                    "local personality re-read failed after a successful sweep; skipping the personality plane this cycle"
                );
                return Ok(skipped_personality_phase());
            }
        },
        Err(crate::singleton::OpenOutcome::Absent) => None,
        Err(crate::singleton::OpenOutcome::Undecodable(_)) => {
            tracing::warn!(
                stage = "personality",
                "local personality blob is unreadable; skipping the personality plane this cycle"
            );
            return Ok(skipped_personality_phase());
        }
        Err(crate::singleton::OpenOutcome::Io(kind)) => {
            tracing::warn!(
                stage = "personality",
                io_failure_kind = ?kind,
                "local personality read failed; skipping the personality plane this cycle"
            );
            return Ok(skipped_personality_phase());
        }
    };
    let local_nonce = local_bytes.as_deref().and_then(read_personality_nonce);

    let id_hex = hex(personality_id);
    let baseline_nonce_hex = state
        .blobs
        .get(&id_hex)
        .map(|b| b.content_nonce_hex.clone());

    // Changed-against-baseline, not changed-against-each-other: a local
    // CLEAR (file removed, `local_bytes` None) must read as a local change
    // whenever a baseline exists, or sync silently resurrects the server's
    // old blob over the user's delete (myne-md/myne#697). Comparing the
    // remote against the baseline (rather than the local) is what keeps a
    // genuinely new server write winning over the clear in the both-changed
    // arm below.
    let remote_changed = remote_record
        .map(|r| Some(hex(&r.content_nonce)) != baseline_nonce_hex)
        .unwrap_or(false);

    let verified = verified_singleton_download(
        transport,
        token,
        remote_record,
        remote_changed,
        read_personality_nonce,
        "personality",
    )?;

    if let SingletonPull::Verified(rec, remote_bytes) = verified {
        // Decode both sides for the whole-value comparison. An unverifiable
        // remote payload is a refusal, local store untouched.
        let local_ok = match &local_bytes {
            None => true,
            Some(b) => decode_agent_personality_blob_versioned(
                version,
                &personality_key,
                account_number_hash,
                b,
            )
            .is_ok(),
        };
        if !local_ok {
            tracing::warn!(
                stage = "personality",
                "local personality blob does not decrypt; skipping the personality plane this cycle"
            );
            return Ok(skipped_personality_phase());
        }
        let remote_ok = decode_agent_personality_blob_versioned(
            version,
            &personality_key,
            account_number_hash,
            &remote_bytes,
        )
        .is_ok();
        if !remote_ok {
            tracing::warn!(
                stage = "personality",
                "verified remote personality blob does not decrypt; skipping the personality plane this cycle"
            );
            return Ok(skipped_personality_phase());
        }
        // Whole-value LWW: the merge picks one side's bytes. A personality is
        // one coherent voice, so the rule is "the changed side wins; a change
        // on both sides resolves to the fresher whole value" (§10.2.7): the
        // greater max `updated_at` over the blob wins, ties go remote
        // (deterministic on both sides, since both see the same two blobs).
        // The nonce comparison below decides which side changed, exactly as
        // the dirty rule does.
        let local_nonce_hex = local_nonce.map(|n| hex(&n));
        let local_changed = local_nonce_hex != baseline_nonce_hex;
        let (bytes, dirty, applied_remote) = if remote_changed && !local_changed {
            (remote_bytes, false, true)
        } else if local_changed && !remote_changed {
            (local_bytes.clone().unwrap(), true, false)
        } else if remote_changed && local_changed {
            // Concurrent edit on both sides: fresher wins, ties go remote.
            // Decode failures cannot reach here (both sides verified above),
            // so an unparseable max reads as 0 rather than skipping the plane.
            let decode = |b: &[u8]| {
                decode_agent_personality_blob_versioned(
                    version,
                    &personality_key,
                    account_number_hash,
                    b,
                )
                .ok()
            };
            let local_max = local_bytes
                .as_deref()
                .and_then(decode)
                .map(|pt| personality_max_updated_at(&pt))
                .unwrap_or(0);
            let remote_max = decode(&remote_bytes)
                .map(|pt| personality_max_updated_at(&pt))
                .unwrap_or(0);
            if remote_max >= local_max {
                (remote_bytes, false, true)
            } else {
                (local_bytes.clone().unwrap(), true, false)
            }
        } else {
            (local_bytes.clone().unwrap_or_default(), false, false)
        };
        if !bytes.is_empty() {
            io.write(&path, &bytes, crate::vault_io::WriteOpts::default())
                .await
                .map_err(|_| SyncCycleError::Io)?;
        }
        record_blob_baseline(state, &id_hex, &rec);
        return Ok(PersonalityPhase {
            merged: Some(bytes.clone()),
            dirty,
            applied_remote,
            push_bytes: dirty.then_some(bytes),
            skipped: false,
        });
    }

    // No (changed) remote blob: dirty iff the local file drifted from the
    // synced baseline. A virgin vault (no file, no baseline) is NOT pushed:
    // personality-silent by default. A clear (no file, baseline present) IS
    // pushed, as a tombstone down in the push block.
    let local_nonce_hex = local_nonce.map(|n| hex(&n));
    let dirty = local_nonce_hex != baseline_nonce_hex;
    // A clear yields Some(empty) rather than None: the push block gates on
    // `push_bytes.take()` and only an empty vec reaches the tombstone arm.
    // None here would skip the tombstone silently while reporting dirty.
    let push_bytes = if dirty {
        Some(local_bytes.clone().unwrap_or_default())
    } else {
        None
    };
    Ok(PersonalityPhase {
        merged: local_bytes.clone(),
        dirty,
        applied_remote: false,
        push_bytes,
        skipped: false,
    })
}

/// A decoded conversation payload: turn ids in file order, the turn objects,
/// and the `title_derived_from` snapshot when the file carries one.
type DecodedConversationTurns = (Vec<String>, Vec<serde_json::Value>, Option<String>);

/// The outcome of one conversation-file reconcile: what the cycle must push
/// (if anything) and the merged bytes already on disk.
#[derive(Debug)]
struct ChatsConversationPhase {
    /// The merged store was written this cycle and differs from the server's
    /// plaintext: push these exact bytes (myne#436 single-derivation: the
    /// push site never re-derives the KEK).
    push_bytes: Option<Vec<u8>>,
    /// The remote record this merge reconciled, if any (its version is the
    /// CAS base; its nonce is the baseline either way).
    remote: Option<ChangedBlob>,
}

/// Pull-side reconcile of ONE per-conversation file (`chats/<id-hex>`,
/// `MYJ1`, § 9.24 + `sync-protocol.md` § 10.2.5). Called for every live
/// catalog row (after the catalog phase merged) under the chats plugin's
/// write mutex:
///
/// - No remote change: the file is verified-nonce-clean or left alone.
/// - Remote change: verified download → decrypt both sides → parse both turn
///   lists (§ 9.24.2 schema) → `merge_chats_turns` on the id lists (common
///   prefix kept, both suffixes kept in id order; an id on both sides is one
///   turn, with the LOCAL turn object winning a content mismatch. Settled
///   turns are immutable, so a mismatch is unreachable and determinism beats
///   argument-sensitivity) → adopt the server bytes verbatim when the merge
///   equals the remote list (no nonce churn), else write the merged file
///   freshly (pushed this cycle against the server's current version).
///
/// Anything that fails schema or AEAD on EITHER side refuses this
/// conversation's reconcile for the cycle (Err): a half-decoded turn list
/// merged and pushed would persist a parse artifact over real turns. The
/// same class the catalog's report-don't-empty closes for the roster.
#[allow(clippy::too_many_arguments)]
async fn sync_chats_conversation_phase(
    io: &dyn crate::vault_io::VaultIo,
    transport: &dyn SyncTransport,
    token: &str,
    root_key: &[u8; 32],
    account_number_hash: &[u8; 16],
    vault_root: &Path,
    conversation_id: &[u8; 16],
    remote_record: Option<&ChangedBlob>,
    version: MetaVersion,
) -> Result<ChatsConversationPhase, SyncCycleError> {
    use protocol::{decode_chats_blob_versioned, encode_chats_blob_versioned};

    let chats_key = derive_subkey_versioned(version, root_key, SubkeyRole::ChatsKey);

    let id_hex = hex(conversation_id);
    let dir = chats_dir(vault_root);
    let path = dir.join(&id_hex);

    // Absent and unreadable are different answers (the catalog phase's
    // re-read lesson one function up): a conversation file that exists but
    // cannot be read must refuse this reconcile for the cycle, never merge
    // as the empty turn list (which would adopt the remote bytes verbatim
    // over turns that never reached the server).
    let local_bytes: Option<Vec<u8>> = match io.read(&path).await {
        Ok(bytes) => Some(bytes),
        Err(crate::io_failure_kind::IoFailureKind::NotFound) => None,
        Err(_) => return Err(SyncCycleError::Io),
    };
    let local_nonce = local_bytes.as_deref().and_then(read_chats_blob_nonce);

    let remote_changed = remote_record
        .map(|r| Some(r.content_nonce) != local_nonce)
        .unwrap_or(false);
    let verified = verified_singleton_download(
        transport,
        token,
        remote_record,
        remote_changed,
        read_chats_blob_nonce,
        "chats-conversation",
    )?;

    let decode_turns = |bytes: &[u8]| -> Result<DecodedConversationTurns, SyncCycleError> {
        let plaintext = decode_chats_blob_versioned(
            version,
            &chats_key,
            account_number_hash,
            conversation_id,
            bytes,
        )
        .map_err(|_| SyncCycleError::Io)?;
        let v: serde_json::Value =
            serde_json::from_slice(&plaintext).map_err(|_| SyncCycleError::Io)?;
        let turns = v
            .get("turns")
            .and_then(|t| t.as_array())
            .ok_or(SyncCycleError::Io)?;
        let mut ids = Vec::with_capacity(turns.len());
        for t in turns {
            let id = t
                .get("id")
                .and_then(|i| i.as_str())
                .ok_or(SyncCycleError::Io)?;
            ids.push(id.to_string());
        }
        // The title-derivation snapshot rides the merge like a turn with
        // no id: it is normative file content (§ 9.24.2), not a cache,
        // so a merge that dropped it would permanently un-derive every
        // synced conversation's title on the other devices.
        let title = v
            .get("title_derived_from")
            .and_then(|s| s.as_str())
            .map(str::to_string);
        Ok((ids, turns.clone(), title))
    };

    if let SingletonPull::Verified(rec, remote_bytes) = verified {
        // Remote verified against the record: decode + parse both sides.
        // Schema/AEAD failure on EITHER side refuses this conversation for
        // the cycle (report-don't-merge: a parse artifact must never ride a
        // merge onto the push batch).
        let remote_plaintext = decode_chats_blob_versioned(
            version,
            &chats_key,
            account_number_hash,
            conversation_id,
            &remote_bytes,
        )
        .map_err(|_| SyncCycleError::Io)?;
        let remote_v: serde_json::Value =
            serde_json::from_slice(&remote_plaintext).map_err(|_| SyncCycleError::Io)?;
        let remote_turns = remote_v
            .get("turns")
            .and_then(|t| t.as_array())
            .ok_or(SyncCycleError::Io)?;
        let remote_ids: Vec<String> = remote_turns
            .iter()
            .map(|t| {
                t.get("id")
                    .and_then(|i| i.as_str())
                    .ok_or(SyncCycleError::Io)
                    .map(|s| s.to_string())
            })
            .collect::<Result<_, _>>()?;
        let remote_title = remote_v
            .get("title_derived_from")
            .and_then(|s| s.as_str())
            .map(str::to_string);

        let (local_ids, local_turns, local_title) = match local_bytes.as_deref() {
            Some(b) => decode_turns(b)?,
            None => (Vec::new(), Vec::new(), None),
        };
        // Local wins the title (the turn-object rule one paragraph down);
        // an absent local file takes the remote's.
        let merged_title = local_title.or(remote_title.clone());

        // Merge on the id lists; objects come from a by-id union with LOCAL
        // winning a content mismatch (unreachable in practice: settled turns
        // are immutable; determinism requires a rule, and local-wins is the
        // argument-independent fixed point the tests pin).
        let merged_ids = crate::plugins::sync::conflict::merge_chats_turns(&local_ids, &remote_ids);
        let mut by_id: std::collections::HashMap<&str, &serde_json::Value> =
            std::collections::HashMap::new();
        for (id, obj) in local_ids.iter().zip(local_turns.iter()) {
            by_id.insert(id.as_str(), obj);
        }
        for (id, obj) in remote_ids.iter().zip(remote_turns.iter()) {
            by_id.entry(id.as_str()).or_insert(obj);
        }
        let merged_turns: Vec<serde_json::Value> = merged_ids
            .iter()
            .map(|id| {
                by_id
                    .remove(id.as_str())
                    .cloned()
                    .unwrap_or(serde_json::Value::Null)
            })
            .collect();
        // The merged file keeps the § 9.24.2 shape: `turns` plus the
        // title snapshot when either side carries one. The verbatim-adoption
        // comparison below is built the same way, so an agreed title does
        // not churn the nonce and a disagreed one re-encrypts with ours.
        let payload_with_title =
            |turns: Vec<serde_json::Value>, title: Option<String>| -> serde_json::Value {
                let mut map = serde_json::Map::with_capacity(2);
                map.insert("turns".to_string(), serde_json::Value::Array(turns));
                if let Some(t) = title {
                    map.insert(
                        "title_derived_from".to_string(),
                        serde_json::Value::String(t),
                    );
                }
                serde_json::Value::Object(map)
            };
        let merged_payload = payload_with_title(merged_turns, merged_title);
        let merged_plaintext =
            serde_json::to_vec(&merged_payload).map_err(|_| SyncCycleError::Io)?;

        // Verbatim adoption when the merge equals the remote plaintext: no
        // nonce churn, no re-encrypt (the myne#436 lesson). The equality is
        // on the DECODED turn lists. Re-serializing an identical list is
        // kept byte-stable by key order, but the server bytes are the
        // canonical form and cost nothing to keep.
        let remote_turns_json = payload_with_title(remote_turns.clone(), remote_title);
        let (bytes, dirty) = if merged_payload == remote_turns_json {
            (remote_bytes, false)
        } else {
            let sealed = encode_chats_blob_versioned(
                version,
                &chats_key,
                account_number_hash,
                conversation_id,
                &merged_plaintext,
            )
            .map_err(|_| SyncCycleError::Io)?;
            (sealed, true)
        };
        io.create_dir_all(&dir)
            .await
            .map_err(|_| SyncCycleError::Io)?;
        io.write(&path, &bytes, crate::vault_io::WriteOpts::default())
            .await
            .map_err(|_| SyncCycleError::Io)?;
        return Ok(ChatsConversationPhase {
            push_bytes: dirty.then_some(bytes),
            remote: Some(rec),
        });
    }

    // No (changed) remote record for this conversation: nothing to reconcile.
    // Dirty-vs-clean is the push-detect phase's job (nonce vs baseline), not
    // this function's: this arm reports no push and no baseline move.
    Ok(ChatsConversationPhase {
        push_bytes: None,
        remote: None,
    })
}

/// Pull-side `vault.themes` reconciliation (MYND-486). The `sync_catalog_phase`
/// twin: `vault.themes` carries **no device-local subset** (every theme is
/// shared vault content), so the push gate is the blob nonce vs the synced
/// baseline (no shared-subset hash), which is the one twist `sync_prefs_phase`
/// needs and this phase does not. Downloads a changed remote themes blob, runs
/// the per-theme-name [`merge_custom_themes`] post-decrypt, and either **adopts
/// the server bytes verbatim** (merge equal to the remote: re-encrypting would
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
    shared: &SharedSingletonKey,
    account_number_hash: &[u8; 16],
    vault_root: &Path,
    state: &mut SyncState,
    themes_id: &[u8; 16],
    remote_record: Option<&ChangedBlob>,
    version: MetaVersion,
) -> Result<ThemesPhase, SyncCycleError> {
    use crate::plugins::themes::commands::{decode_themes_map_or_empty, encode_themes_map};

    // See `apply_pulled_note_blob`: `blocking_lock` panics inside a runtime.
    let _guard = crate::plugins::themes::commands::write_mutex().lock().await;

    let path = themes_file_path(vault_root);
    // The newest copy that DECRYPTS, not merely the newest that parses a header
    // (myne#301). A torn slot on the web client otherwise supplied both the
    // local nonce and, further down, the bytes pushed to the server, where
    // every peer decodes them to empty.
    let themes_key_for_read = shared.derive(version, SubkeyRole::CustomThemesKey);
    let local_bytes = crate::plugins::themes::commands::read_verified_themes_bytes(
        io,
        vault_root,
        &themes_key_for_read,
        account_number_hash,
    )
    .await;
    let local_nonce = local_bytes.as_deref().and_then(read_themes_nonce);

    // Decrypting the local store costs an HKDF + a full AEAD open + a whole-map
    // JSON parse, so it happens ONLY on the two paths that read the plaintext:
    // the remote-reconcile branch (which merges) and the virgin-store check
    // below. The steady state (no remote change, local nonce == baseline)
    // proves byte-cleanliness from the nonce alone and never decrypts. (The
    // `sync_catalog_phase` twin decodes eagerly for a reason this phase lacks:
    // it RETURNS the merged catalog to the downstream attachment loop, while
    // `ThemesPhase` returns only flags.)
    // §9.21.4 read semantic: any local decode failure falls back to empty.
    let decode_local = || {
        let themes_key = shared.derive(version, SubkeyRole::CustomThemesKey);
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

    // §11.3 gate. This family needs it most: the `io.write` below is shared by
    // both arms, and the local store falls back to EMPTY when it cannot be
    // decoded, so for unverified junk `merged == remote_map` holds and the
    // live `vault.themes` is replaced by that junk.
    let verified = verified_singleton_download(
        transport,
        token,
        remote_record,
        remote_changed,
        read_themes_nonce,
        "themes",
    )?;

    if let SingletonPull::Verified(rec, remote_bytes) = verified {
        let (themes_key, local_map) = decode_local();
        // A hostile/corrupt remote store collapses to empty (§9.21.4);
        // merge(local, empty) == local, so nothing is lost and the local store
        // re-pushes over it.
        let remote_map =
            decode_themes_map_or_empty(&themes_key, account_number_hash, Some(&remote_bytes));
        let merged = merge_custom_themes(&local_map, &remote_map);
        let applied_remote = merged != local_map;

        let (bytes, dirty) = if merged == remote_map {
            // Adopt the server bytes VERBATIM: byte-identical store + baseline
            // == server (version, nonce); nothing to push. Re-encrypting an
            // already-agreeing store would churn the nonce and push forever.
            (remote_bytes, false)
        } else {
            // The merge beat the server's store → write it fresh and push it
            // this cycle against the server's current version. The local file
            // (freshly re-encrypted) intentionally carries a different nonce
            // from the recorded CAS base.
            (
                encode_themes_map(version, &themes_key, account_number_hash, &merged)
                    .map_err(|_| SyncCycleError::Io)?,
                true,
            )
        };
        io.write(&path, &bytes, crate::vault_io::WriteOpts::default())
            .await
            .map_err(|_| SyncCycleError::Io)?;
        record_blob_baseline(state, &id_hex, &rec);
        return Ok(ThemesPhase {
            dirty,
            applied_remote,
            push_bytes: dirty.then_some(bytes),
        });
    }

    // No (changed) remote themes record: dirty iff the local file drifted from
    // the synced baseline. Every themes write re-encrypts under a fresh nonce,
    // so a local blob whose outer nonce still equals the baseline's is provably
    // byte-untouched since the last sync. A virgin empty store (no themes, no
    // baseline) is deliberately NOT pushed: a theme-less vault stays
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
        // `dirty` already implies `local_bytes.is_some()`, and these are the
        // VERIFIED bytes (myne#301): the same ones the push must carry.
        push_bytes: if dirty { local_bytes } else { None },
    })
}

/// The member-names phase's outcome (task 3b-ii).
struct MemberNamesPhase {
    /// The store needs a push: a local-only change, or a merge that differed from
    /// the server's plaintext.
    dirty: bool,
    /// A remote change was merged onto the on-disk store this cycle.
    applied_remote: bool,
    /// The exact bytes to push, carried out of the phase whenever `dirty` (the
    /// myne#436 single-derivation discipline: the push site never re-derives a key).
    push_bytes: Option<Vec<u8>>,
}

impl MemberNamesPhase {
    /// No group tier, no store: a pre-B2B vault has no `vault.member-names` and no
    /// epoch to address one under, so there is nothing to pull, merge or push.
    fn idle() -> Self {
        Self {
            dirty: false,
            applied_remote: false,
            push_bytes: None,
        }
    }
}

/// Pull-side `vault.member-names` reconciliation (task 3b-ii), the
/// `sync_themes_phase` twin. Three things differ, and each is dictated by the family
/// rather than chosen here:
///
/// 1. **It is `NTV6`-only.** The store is group-sealed and its AAD binds the group
///    epoch, so a pre-B2B `OwnerRoot` session has neither, and the phase answers
///    [`MemberNamesPhase::idle`] without a byte of traffic. The command layer answers
///    `NotASharedVault` for the same vault.
/// 2. **The KEK and its two bindings come from the family's own resolver**
///    ([`crate::plugins::member_names::resolve_names_from_group_key`]), which reads
///    `vault.meta` once for the account hash AND the epoch. The themes phase takes its
///    identity from the cycle because its AAD has no epoch; here the two must come from
///    one read, and the same resolver serves the command layer so the two can never
///    derive different keys (the myne-md/myne#436 shape).
/// 3. **A pulled copy that does not decode is refused, not merged as empty.** The
///    store's own entry point states the rule; this phase honours it by decoding before
///    it merges, because `merge(local, empty) == local` would discard a peer's rename
///    and then write the result back over it.
///
/// Like every sibling it holds the family's write mutex across the read-merge-write,
/// because the `set_mine` / `clear_mine` commands write the same map.
#[allow(clippy::too_many_arguments)]
async fn sync_member_names_phase(
    io: &dyn crate::vault_io::VaultIo,
    transport: &dyn SyncTransport,
    token: &str,
    shared: &SharedSingletonKey,
    vault_root: &Path,
    state: &mut SyncState,
    names_id: &[u8; 16],
    remote_record: Option<&ChangedBlob>,
) -> Result<MemberNamesPhase, SyncCycleError> {
    // NTV6-only: a pre-B2B `OwnerRoot` session holds no group key, so there is no KEK
    // to derive and no blob to address.
    let Some(group) = shared.group_bytes() else {
        return Ok(MemberNamesPhase::idle());
    };
    let resolved =
        match crate::plugins::member_names::resolve_names_from_group_key(io, &group, vault_root)
            .await
        {
            Ok(resolved) => resolved,
            Err(err) => {
                // Belt and braces: the cycle already parsed this `vault.meta` for the AAD
                // identity, so this arm is unreachable in a well-formed cycle. Skipping is
                // the safe direction either way: a name store that cannot be read must
                // never stall note or attachment sync, and skipping adopts nothing.
                tracing::warn!(
                    stage = "member_names",
                    event = "phase_skipped",
                    error = ?err,
                    "the member-names keyspace could not be resolved; syncing without it"
                );
                return Ok(MemberNamesPhase::idle());
            }
        };
    // The codec refuses a zero epoch on BOTH the seal and the open path, so a `vault.meta`
    // carrying one describes a vault this family cannot be addressed in.
    if resolved.group_key_epoch == 0 {
        tracing::warn!(
            stage = "member_names",
            event = "phase_skipped",
            "vault.meta carries a zero group epoch; the member-names store is not addressable"
        );
        return Ok(MemberNamesPhase::idle());
    }

    let _guard = crate::plugins::member_names::write_mutex().lock().await;
    // The second half of this family's write gate, taken here rather than at the
    // `io.write` far below because the phase's read-modify-write starts immediately:
    // a group rotation re-seals `vault.member-names` at a new epoch under the
    // exclusive side, and a write straddling it would publish the retired epoch's
    // ciphertext (`member_names::store::write_mutex` states the pair).
    let _quiesce = crate::singleton_quiesce::shared().await;

    let key = resolved.borrow();
    let path = member_names_file_path(vault_root);
    // The newest copy that DECODES, not merely the newest that parses a header
    // (myne#301): a torn slot on the web client would otherwise supply both the local
    // nonce and, further down, the bytes pushed to the server.
    let local_bytes =
        crate::plugins::member_names::read_verified_names_bytes(io, vault_root, &key).await;
    let local_nonce = local_bytes.as_deref().and_then(read_member_names_nonce);

    // Decrypting the local store costs an HKDF, a full AEAD open and a whole-map JSON
    // parse, so it happens ONLY on the two paths that read the plaintext: the
    // remote-reconcile merge and the virgin-store check. The steady state proves
    // byte-cleanliness from the nonce alone and never decrypts. `local_bytes` is already
    // the newest copy that decoded, so a `None` here means absent-or-undecryptable and
    // reads as the empty map, the direction every other merge input takes.
    let decode_local = || {
        local_bytes
            .as_deref()
            .and_then(|b| {
                decode_member_names_blob(key.key, key.account_number_hash, key.group_key_epoch, b)
                    .ok()
            })
            .unwrap_or_default()
    };

    let id_hex = hex(names_id);
    let baseline_nonce_hex = state
        .blobs
        .get(&id_hex)
        .map(|b| b.content_nonce_hex.clone());

    // A remote record whose nonce we already hold needs no download.
    let remote_changed = remote_record
        .map(|r| Some(r.content_nonce) != local_nonce)
        .unwrap_or(false);

    // §11.3 gate. The `io.write` below is shared by both arms, so unverified junk has
    // to be refused before anything is written. NOTE the difference from themes, which
    // collapses an undecodable remote to empty: here that refusal is the NEXT block, and
    // it returns instead of merging.
    let verified = verified_singleton_download(
        transport,
        token,
        remote_record,
        remote_changed,
        read_member_names_nonce,
        "member-names",
    )?;

    if let SingletonPull::Verified(rec, remote_bytes) = verified {
        let remote_map = match decode_member_names_blob(
            key.key,
            key.account_number_hash,
            key.group_key_epoch,
            &remote_bytes,
        ) {
            Ok(map) => map,
            Err(_) => {
                // The store's rule, and the reason this arm returns rather than
                // merging: `merge(local, empty) == local`, so an undecodable copy
                // merged as empty would silently discard a peer's rename and then be
                // written back over it.
                tracing::warn!(
                    stage = "member_names",
                    event = "remote_refused",
                    "the served member-names blob did not decode; no local mutation"
                );
                return Ok(MemberNamesPhase::idle());
            }
        };
        let local_map = decode_local();
        let merged = merge_member_names(&local_map, &remote_map);
        let applied_remote = merged != local_map;

        // `merged.is_empty()` implies `merged == remote_map` (the merge keeps every row
        // from both sides), so the write-fresh arm below always has bytes worth writing.
        let (bytes, dirty) = if merged == remote_map {
            // Adopt the server bytes VERBATIM: byte-identical store and baseline == the
            // server's (version, nonce), nothing to push. Re-encrypting an already
            // agreeing store would churn the nonce and push forever.
            (remote_bytes, false)
        } else {
            // The merge beat the server's store -> write it fresh and push it this
            // cycle against the server's current version. The file (freshly
            // re-encrypted) intentionally carries a different nonce from the recorded
            // CAS base.
            (
                encode_member_names_blob(
                    key.key,
                    key.account_number_hash,
                    key.group_key_epoch,
                    &merged,
                )
                .map_err(|_| SyncCycleError::Io)?,
                true,
            )
        };
        io.write(&path, &bytes, crate::vault_io::WriteOpts::default())
            .await
            .map_err(|_| SyncCycleError::Io)?;
        record_blob_baseline(state, &id_hex, &rec);
        return Ok(MemberNamesPhase {
            dirty,
            applied_remote,
            push_bytes: dirty.then_some(bytes),
        });
    }

    // No (changed) remote record: dirty iff the local file drifted from the synced
    // baseline. Every member-names write re-encrypts under a fresh nonce, so a local
    // blob whose outer nonce still equals the baseline's is provably byte-untouched
    // since the last sync. A vault where nobody has named yet (no store, no baseline) is
    // deliberately NOT pushed; a store holding ONLY tombstones IS, because the tombstone
    // is how a deletion propagates.
    let local_nonce_hex = local_nonce.map(|n| hex(&n));
    // The virgin-store conjunct is ordered baseline-first so the cheap `is_none` gates
    // the expensive decode: only a never-synced vault pays it, and only after the nonce
    // check already proved the file drifted. Both conjuncts are pure.
    let dirty = local_bytes.is_some()
        && local_nonce_hex != baseline_nonce_hex
        && !(baseline_nonce_hex.is_none() && decode_local().is_empty());
    Ok(MemberNamesPhase {
        dirty,
        applied_remote: false,
        // `dirty` already implies `local_bytes.is_some()`, and these are the VERIFIED
        // bytes (myne#301): the same ones the push must carry.
        push_bytes: if dirty { local_bytes } else { None },
    })
}

/// The device-binding phase's outcome, the [`MemberNamesPhase`] twin.
struct DeviceBindingsPhase {
    /// The store needs a push: a local-only change (a claim written on this device), or a
    /// merge that differed from the server's plaintext.
    dirty: bool,
    /// A remote change was merged onto the on-disk store this cycle.
    applied_remote: bool,
    /// The exact bytes to push, carried out of the phase whenever `dirty` (the myne#436
    /// single-derivation discipline: the push site never re-derives a key).
    push_bytes: Option<Vec<u8>>,
}

impl DeviceBindingsPhase {
    /// No group tier, no store: a pre-B2B vault has no `vault.device-bindings` and no
    /// epoch to address one under, so there is nothing to pull, merge or push.
    fn idle() -> Self {
        Self {
            dirty: false,
            applied_remote: false,
            push_bytes: None,
        }
    }
}

/// Pull-side `vault.device-bindings` reconciliation, the `sync_member_names_phase` twin.
///
/// Every structural decision is the same as its sibling's and for the same reasons: it is
/// `NTV6`-only (the store is group-sealed and its AAD binds the epoch); the KEK and its
/// two bindings come from the family's own resolver, which reads `vault.meta` once for the
/// account hash AND the epoch; a pulled copy that does not decode is refused rather than
/// merged as empty, because `merge(local, empty) == local` would discard a peer's claim
/// and then write the result back over it; and the whole read-merge-write holds the
/// family's write mutex, because this device's own claim is written by the command layer
/// and by the unlock hook.
///
/// **What differs is the merge, and it is the reason this phase exists at all.** The
/// sibling's rows are keyed by PERSON and only its own author can ever write one, so its
/// merge is a last-write-wins over disjoint keys. Here the key is the DEVICE and a row
/// names the person that device acts for, so two peers can hold rows for one device, and
/// the merge is version-ordered with a tombstone winning at an equal version
/// (`merge_device_bindings`). That is what makes two devices claiming themselves
/// concurrently survive, a claim written offline reconcile on the next cycle, and an
/// owner's removal tombstone outrank a claim that was already in flight.
#[allow(clippy::too_many_arguments)]
async fn sync_device_bindings_phase(
    io: &dyn crate::vault_io::VaultIo,
    transport: &dyn SyncTransport,
    token: &str,
    shared: &SharedSingletonKey,
    vault_root: &Path,
    state: &mut SyncState,
    bindings_id: &[u8; 16],
    remote_record: Option<&ChangedBlob>,
) -> Result<DeviceBindingsPhase, SyncCycleError> {
    // NTV6-only: a pre-B2B `OwnerRoot` session holds no group key, so there is no KEK to
    // derive and no blob to address.
    let Some(group) = shared.group_bytes() else {
        return Ok(DeviceBindingsPhase::idle());
    };
    let resolved = match crate::plugins::device_binding::resolve_bindings_from_group_key(
        io, &group, vault_root,
    )
    .await
    {
        Ok(resolved) => resolved,
        Err(err) => {
            // Belt and braces, exactly as the sibling: the cycle already parsed this
            // `vault.meta` for the AAD identity. Skipping is the safe direction either
            // way, and it must never stall note or attachment sync.
            tracing::warn!(
                stage = "device_bindings",
                event = "phase_skipped",
                error = ?err,
                "the device-binding keyspace could not be resolved; syncing without it"
            );
            return Ok(DeviceBindingsPhase::idle());
        }
    };
    // The codec refuses a zero epoch on BOTH the seal and the open path, so a `vault.meta`
    // carrying one describes a vault this family cannot be addressed in.
    if resolved.group_key_epoch == 0 {
        tracing::warn!(
            stage = "device_bindings",
            event = "phase_skipped",
            "vault.meta carries a zero group epoch; the device-binding store is not addressable"
        );
        return Ok(DeviceBindingsPhase::idle());
    }

    let _guard = crate::plugins::device_binding::write_mutex().lock().await;
    // The second half of this family's write gate (`device_binding::store::write_mutex`
    // states the pair): a group rotation re-seals `vault.device-bindings` at a new epoch
    // under the exclusive side, and a write straddling it would publish the retired
    // epoch's ciphertext.
    let _quiesce = crate::singleton_quiesce::shared().await;

    let key = resolved.borrow();
    let path = device_bindings_file_path(vault_root);
    // The newest copy that DECODES, not merely the newest that parses a header
    // (myne#301): a torn slot on the web client would otherwise supply both the local
    // nonce and, further down, the bytes pushed to the server.
    let local_bytes =
        crate::plugins::device_binding::read_verified_bindings_bytes(io, vault_root, &key).await;
    let local_nonce = local_bytes.as_deref().and_then(read_device_bindings_nonce);

    // Decrypting the local store costs an HKDF, a full AEAD open and a whole-map JSON
    // parse, so it happens ONLY on the two paths that read the plaintext: the
    // remote-reconcile merge and the virgin-store check.
    let decode_local = || {
        local_bytes
            .as_deref()
            .and_then(|b| {
                decode_device_binding_blob(key.key, key.account_number_hash, key.group_key_epoch, b)
                    .ok()
            })
            .unwrap_or_default()
    };

    let id_hex = hex(bindings_id);
    let baseline_nonce_hex = state
        .blobs
        .get(&id_hex)
        .map(|b| b.content_nonce_hex.clone());

    // A remote record whose nonce we already hold needs no download.
    let remote_changed = remote_record
        .map(|r| Some(r.content_nonce) != local_nonce)
        .unwrap_or(false);

    // §11.3 gate. The `io.write` below is shared by both arms, so unverified junk has to
    // be refused before anything is written.
    let verified = verified_singleton_download(
        transport,
        token,
        remote_record,
        remote_changed,
        read_device_bindings_nonce,
        "device-bindings",
    )?;

    if let SingletonPull::Verified(rec, remote_bytes) = verified {
        let remote_map = match decode_device_binding_blob(
            key.key,
            key.account_number_hash,
            key.group_key_epoch,
            &remote_bytes,
        ) {
            Ok(map) => map,
            Err(_) => {
                // The store's rule, and the reason this arm returns rather than merging:
                // `merge(local, empty) == local`, so an undecodable copy merged as empty
                // would silently discard a peer's claim and then be written back over it.
                tracing::warn!(
                    stage = "device_bindings",
                    event = "remote_refused",
                    "the served device-binding blob did not decode; no local mutation"
                );
                return Ok(DeviceBindingsPhase::idle());
            }
        };
        let local_map = decode_local();
        // The ONE refusal that is not corruption: two peers hold the same device under two
        // DIFFERENT people at the SAME version, which has no winner. Refusing leaves the
        // local store untouched and the cycle records no baseline, so the next cycle
        // retries with whatever the peers have written by then; a fresh claim on either
        // device (a strictly higher version) is the repair.
        let merged = match merge_device_bindings(&local_map, &remote_map) {
            Ok(merged) => merged,
            Err(_) => {
                tracing::warn!(
                    stage = "device_bindings",
                    event = "merge_conflict",
                    "two copies bind one device to two people at the same version; no local mutation"
                );
                return Ok(DeviceBindingsPhase::idle());
            }
        };
        let applied_remote = merged != local_map;

        let (bytes, dirty) = if merged == remote_map {
            // Adopt the server bytes VERBATIM: byte-identical store and baseline == the
            // server's (version, nonce), nothing to push. Re-encrypting an already
            // agreeing store would churn the nonce and push forever.
            (remote_bytes, false)
        } else {
            // The merge beat the server's store (this device claimed while the peer's copy
            // was in flight) -> write it fresh and push it this cycle against the server's
            // current version.
            (
                encode_device_binding_blob(
                    key.key,
                    key.account_number_hash,
                    key.group_key_epoch,
                    &merged,
                )
                .map_err(|_| SyncCycleError::Io)?,
                true,
            )
        };
        io.write(&path, &bytes, crate::vault_io::WriteOpts::default())
            .await
            .map_err(|_| SyncCycleError::Io)?;
        record_blob_baseline(state, &id_hex, &rec);
        return Ok(DeviceBindingsPhase {
            dirty,
            applied_remote,
            push_bytes: dirty.then_some(bytes),
        });
    }

    // No (changed) remote record: dirty iff the local file drifted from the synced
    // baseline. Every write re-encrypts under a fresh nonce, so a local blob whose outer
    // nonce still equals the baseline's is provably byte-untouched since the last sync. A
    // vault where no device has claimed yet (no store, no baseline) is deliberately NOT
    // pushed; a store holding ONLY tombstones IS, because a removal must propagate.
    let local_nonce_hex = local_nonce.map(|n| hex(&n));
    let dirty = local_bytes.is_some()
        && local_nonce_hex != baseline_nonce_hex
        && !(baseline_nonce_hex.is_none() && decode_local().is_empty());
    Ok(DeviceBindingsPhase {
        dirty,
        applied_remote: false,
        push_bytes: if dirty { local_bytes } else { None },
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

/// Upper bound on the blobs carried by ONE `/sync/push` request (myne-md/myne#222).
///
/// The body size is bounded by [`PUSH_CHUNK_MAX_BYTES`]; this bounds the *server-side
/// work*, which scales with the blob COUNT rather than with bytes — the server applies
/// blobs one at a time and re-indexes per blob (myne-md/myne-server#6). An unbounded
/// batch is what made a 50 000-note first sync hand the server more work than any
/// socket deadline can cover, so that nothing ever landed and nothing was ever
/// recorded. Paired with `http_transport::SOCKET_TIMEOUT`: raise one, re-read the
/// other.
const PUSH_CHUNK_MAX_BLOBS: usize = 256;

/// Upper bound on the inline ciphertext carried by ONE `/sync/push` request, in
/// bytes measured BEFORE base64 (the wire body is ~4/3 of this plus ~190 B of JSON
/// framing per blob). Keeps peak request memory bounded — `build_http_request_ext`
/// copies the body once more on its way out, so the true ceiling is ~2× the encoded
/// chunk regardless of vault size. A single blob above this bound still travels
/// alone rather than being split: the AEAD unit is never chunked (`server-protocol.md`
/// §3.2), and the per-blob cap is the server's `MaxBlobSize`, not this.
const PUSH_CHUNK_MAX_BYTES: usize = 8 * 1024 * 1024;

/// Split a push batch into request-sized chunks, in order, bounded by BOTH
/// [`PUSH_CHUNK_MAX_BLOBS`] and [`PUSH_CHUNK_MAX_BYTES`] — a chunk closes at
/// whichever bound trips first, and a lone blob over the byte bound still travels
/// by itself (never split: the AEAD unit is one whole-blob tag).
///
/// **An empty batch yields ONE empty chunk, not zero.** The caller's push block also
/// fires for the genesis head of an account with no local changes, and that head-only
/// push must still be sent; returning an empty iterator here would silently skip it
/// and leave a joining device with no head to adopt, forever.
fn push_chunks(blobs: &[PushBlob]) -> Vec<&[PushBlob]> {
    if blobs.is_empty() {
        return vec![&[]];
    }
    let mut chunks = Vec::new();
    let mut start = 0usize;
    let mut bytes = 0usize;
    for (i, b) in blobs.iter().enumerate() {
        // Close the OPEN chunk before this blob when adding it would overrun a
        // bound — never mid-blob, and never on an empty chunk (which is what lets
        // an oversized lone blob through instead of looping on it).
        if i > start
            && (i - start >= PUSH_CHUNK_MAX_BLOBS
                || bytes + b.ciphertext.len() > PUSH_CHUNK_MAX_BYTES)
        {
            chunks.push(&blobs[start..i]);
            start = i;
            bytes = 0;
        }
        bytes += b.ciphertext.len();
    }
    chunks.push(&blobs[start..]);
    chunks
}

/// SHA-256 of `bytes` as lowercase hex — the `vault.meta` baseline discriminator.
///
/// `pub(crate)` for the peer-side promotion (myne-md/myne#447), which has to
/// stamp the same baseline this phase compares against. A second hasher there
/// would be a second opinion about what "the baseline" means.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex(&Sha256::digest(bytes))
}

/// The vault's `account_number_hash`, the AAD binding both membership envelopes
/// use. Taken from the local meta because the account hash is a validated
/// invariant of `merge_vault_meta`, so the two inputs agree.
fn account_number_hash_of(meta: &protocol::VaultMeta) -> [u8; 16] {
    meta.account_number_hash
}

/// Union-merge the B2B roster extension across local and remote membership
/// fields, then re-seal it into the merged meta (myne-md/myne#698).
///
/// The single-account half of the membership field keeps its device-local rule;
/// only the 0x02 roster extension is shared. The merge itself lives in
/// `super::roster` (`merge_rosters`, the attachments-catalog §11.4 pattern); this
/// is the caller that comment named, and it runs HERE because only this site
/// holds the unlocked `root_key` the envelopes need.
///
/// No-op when the caller has no `root_key` (an unenrolled edge, most unit
/// tests), when neither side carries a roster, or on any envelope/seal failure.
/// The roster is a best-effort convergence and must never fail a meta cycle.
fn merge_roster_extension(
    root_key: Option<&[u8; 32]>,
    merged: &mut protocol::VaultMeta,
    local: Option<&protocol::Membership>,
    remote: Option<&protocol::Membership>,
    account_number_hash: [u8; 16],
) {
    let Some(root_key) = root_key else {
        // No key, no merge (an unenrolled edge or a keyless test caller).
        // Warn rather than stay silent: a keyed production cycle that lands
        // here leaves a diverged roster standing inside a Merged/Pushed
        // outcome, and nothing else names it.
        tracing::warn!(
            stage = "meta_phase",
            event = "roster_merge_skipped",
            reason = "no_root_key",
            "roster extension merge skipped: no root key, transplanted membership stands as-is"
        );
        return;
    };
    // A roster on either side; the single-account half of the transplanted
    // local membership stays as `merge_vault_meta` left it.
    let local_roster = match local
        .and_then(|m| m.roster.as_ref())
        .map(|r| protocol::unseal_membership_roster(root_key, r, &account_number_hash))
    {
        Some(Ok(bytes)) => super::roster::parse_roster(&bytes),
        Some(Err(_)) => None,
        None => Some(super::roster::RosterMap::new()),
    };
    let remote_roster = match remote
        .and_then(|m| m.roster.as_ref())
        .map(|r| protocol::unseal_membership_roster(root_key, r, &account_number_hash))
    {
        Some(Ok(bytes)) => super::roster::parse_roster(&bytes),
        Some(Err(_)) => None,
        None => Some(super::roster::RosterMap::new()),
    };
    let (Some(local_roster), Some(remote_roster)) = (local_roster, remote_roster) else {
        // An unreadable envelope is not a merge input: leave the transplanted
        // field alone rather than merging against a guessed empty roster.
        // Warn: the cycle still reports Merged/Pushed/Adopted while the roster
        // did not converge, and this line is the only place that says so.
        // (Counts only; roster bytes never enter a log line.)
        tracing::warn!(
            stage = "meta_phase",
            event = "roster_merge_skipped",
            reason = "unreadable_envelope",
            local_had_roster = local.and_then(|m| m.roster.as_ref()).is_some(),
            remote_had_roster = remote.and_then(|m| m.roster.as_ref()).is_some(),
            "roster extension merge skipped: a roster envelope failed to unseal or parse"
        );
        return;
    };
    // Nothing to write when neither side carried a roster extension. This is
    // the ordinary single-user cycle, so it stays silent by design: a warn
    // here would fire on every sync of every vault that never had a roster.
    // Nothing to write when neither side carried a roster extension.
    let had_any = local.and_then(|m| m.roster.as_ref()).is_some()
        || remote.and_then(|m| m.roster.as_ref()).is_some();
    if !had_any {
        return;
    }
    let union = super::roster::merge_rosters(&local_roster, &remote_roster);
    let plaintext = super::roster::encode_roster(&union);
    let mut nonce = [0u8; protocol::MEMBERSHIP_ROSTER_NONCE_LEN];
    if getrandom::getrandom(&mut nonce).is_err() {
        tracing::warn!(
            stage = "meta_phase",
            event = "roster_merge_skipped",
            reason = "csprng",
            "roster extension merge skipped: nonce randomness unavailable, union not sealed"
        );
        return;
    }
    let Ok(env) =
        protocol::seal_membership_roster_raw(root_key, &plaintext, &account_number_hash, &nonce)
    else {
        tracing::warn!(
            stage = "meta_phase",
            event = "roster_merge_skipped",
            reason = "seal",
            union_members = union.len(),
            "roster extension merge skipped: reseal of the merged union failed"
        );
        return;
    };
    // The roster rides INSIDE an existing membership field. When the merged meta
    // has none, there is no single-account half to attach it to (that half is
    // the local account id, which this site cannot fabricate), so the roster is
    // left for the unlock stamp to install rather than written against zeroes.
    if let Some(m) = merged.membership.as_mut() {
        m.roster = Some(env);
    }
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
    // The unlocked vault's `root_key`, threaded from `run_sync_cycle`, so the
    // B2B roster extension can be opened + union-merged across devices. `None`
    // on a caller that has no key (an unenrolled edge, and most unit tests):
    // the roster merge is then a no-op and the single-account membership field
    // keeps the device-local transplant rule unchanged.
    root_key: Option<&[u8; 32]>,
) -> MetaPhaseOutcome {
    let meta_path = vault_root.join("vault.meta");
    let Ok(local_bytes) = io.read(&meta_path).await else {
        return MetaPhaseOutcome::NoChange; // no local meta (unenrolled edge) → nothing
    };
    let Ok(local_meta) = parse_vault_meta_any(&local_bytes) else {
        return MetaPhaseOutcome::Skipped;
    };
    let local_hash = sha256_hex(&local_bytes);
    let dirty = vault_meta_is_dirty(io, vault_root).await;

    // myne#293 — the `vault.meta`-dirty marker opens its OWN push window.
    //
    // `allow_push` is threaded from the scheduler, and the scheduler only opens a
    // push window when the local-change counter advanced — which a credential
    // change does not bump. So a password change (or a recovery reset) whose
    // immediate push failed wrote the marker, and then the loop never pushed it:
    // every poll-driven cycle is pull-only until some UNRELATED note, prefs or
    // attachment edit happens to open a window. The contract `sync/commands.rs`
    // states — "a transport failure only writes the marker so the sync loop's
    // meta phase pushes it later" — was not honoured by the loop alone. A second
    // device joining in that window fetched the stale `vault.meta`, so the
    // password the user had just set did not unlock it and the OLD one did.
    //
    // Widening the gate here rather than bumping the local-change counter keeps
    // the two signals honest: the counter means "the user edited content", and a
    // credential rotation is not content. What `allow_push` protects is
    // edit-TIMING inference from push cadence; the marker carries no edit timing,
    // only "a credential changed and the server does not have it" — which the
    // immediate push at change time already revealed.
    //
    // The device-verification hold (myne#462) reaches this phase as
    // `allow_push == false`, i.e. exactly like a poll cycle, and that is correct
    // rather than incidental: a `vault.meta` PUT goes to its own endpoint, is not
    // a manifest member, and authors no head — so it cannot move the fingerprint
    // the eye-compare is reading. Stranding a credential rotation to protect a
    // code it cannot affect would be the wrong trade, and the `dirty` arm keeps
    // it moving.
    let may_push = allow_push || dirty;

    // A B2B vault carries an owner membership binding, and the server's
    // `vaultMetaWriteAccount` refuses a device token for the `vault.meta` write
    // (403 `owner_required`): it requires the OWNER's per-vault membership token,
    // which `ensure_owner_member_token` stores device-locally on the first B2B
    // action. Prefer it when this device holds one, so the owner's roster/epoch
    // changes actually reach the server; a pre-B2B vault has no owner binding and
    // keeps the device token. Resolved once, before `state` is mutated below.
    let put_token = state
        .owner_member_token_hex
        .clone()
        .unwrap_or_else(|| token.to_string());

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
                && may_push
                && super::enroll::put_vault_meta(transport, &put_token, &local_bytes).is_ok()
            {
                state.meta_baseline_hex = Some(local_hash);
                let _ = clear_vault_meta_dirty(io, vault_root).await;
                return MetaPhaseOutcome::Pushed;
            }
            return MetaPhaseOutcome::NoChange;
        }
        _ => return MetaPhaseOutcome::Skipped,
    };
    let Ok(server_meta) = parse_vault_meta_any(&server_bytes) else {
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

    // NTV6 branch (B2B, myne-md/myne#711 task 13). An `NTV6` `vault.meta`
    // carries a B2B tail OUTSIDE `VaultMeta` (the owner-wrapped group key, the
    // group-key epoch and the signed roster), so it is NEVER re-serialized from
    // the parsed `VaultMeta`: only a VERBATIM write of one side's bytes is safe
    // (`serialize_vault_meta_v0_2` would drop the tail and downgrade the vault).
    //
    // The epoch rule: a strictly-greater server epoch is adopted; a lower one is
    // a rollback and is refused; equal epochs must agree, and at equal epoch the
    // server may still carry a newer roster (an invite writes the roster at the
    // SAME epoch), so a server-only change is adopted too. A concurrent change at
    // the same epoch cannot be tie-broken and is refused. A MEMBER device (no
    // `root_key`) adopts but never writes `vault.meta`.
    let is_ntv6 = |b: &[u8]| b.get(..4) == Some(protocol::VAULT_META_NTV6_MAGIC.as_slice());
    let local_is_ntv6 = is_ntv6(&local_bytes);
    let server_is_ntv6 = is_ntv6(&server_bytes);
    if local_is_ntv6 || server_is_ntv6 {
        let member = root_key.is_none();
        // One-sided generation transition, LOCAL side (myne-md/myne#795): this
        // device performed the owner-only `NTV5`->`NTV6` migration and the server
        // still holds the pre-B2B copy. This is the ONLY path that carries a
        // migrated `vault.meta` to the server — the migration itself does not push,
        // and the both-sides-`NTV6` logic below cannot merge a one-sided frame — so
        // without it the server keeps serving `NTV5` and a member's accept, which
        // fetches the server copy and requires `NTV6`, dies at parse. A MEMBER never
        // holds `root_key`, so it can never have migrated; never adopt the older
        // server copy here.
        if local_is_ntv6 && !server_is_ntv6 {
            if !member
                && may_push
                && super::enroll::put_vault_meta(transport, &put_token, &local_bytes).is_ok()
            {
                state.meta_baseline_hex = Some(local_hash);
                let _ = clear_vault_meta_dirty(io, vault_root).await;
                tracing::info!(
                    stage = "meta_phase",
                    event = "ntv6_generation_pushed",
                    "published a local NTV5->NTV6 generation transition to the server"
                );
                return MetaPhaseOutcome::Pushed;
            }
            return MetaPhaseOutcome::Skipped;
        }
        // One-sided generation transition, SERVER side: another owner device
        // migrated this vault. Adopt the server's `NTV6` bytes verbatim, verified
        // under our root key when we hold one (mirrors the newer-epoch adopt below).
        if !local_is_ntv6 && server_is_ntv6 {
            let Ok(server_ntv6) = protocol::parse_vault_meta_ntv6(&server_bytes) else {
                return MetaPhaseOutcome::Skipped;
            };
            if let Some(root_key) = root_key {
                let group = match protocol::unlock_group_key_ntv6(
                    &server_ntv6,
                    &protocol::OwnerKey::new(*root_key),
                ) {
                    Ok(group) => group,
                    Err(_) => return MetaPhaseOutcome::Skipped,
                };
                if protocol::person_invite::open_group_roster(
                    &group,
                    &server_ntv6.base.account_number_hash,
                    server_ntv6.group_key_epoch,
                    &server_ntv6.signed_roster_envelope,
                )
                .is_none()
                {
                    return MetaPhaseOutcome::Skipped;
                }
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
                state.blobs.clear();
                state.meta_baseline_hex = Some(server_hash);
                let _ = clear_vault_meta_dirty(io, vault_root).await;
                tracing::info!(
                    stage = "meta_phase",
                    event = "ntv6_generation_adopted",
                    "adopted a peer's NTV5->NTV6 generation transition"
                );
                return MetaPhaseOutcome::Adopted;
            }
            return MetaPhaseOutcome::Skipped;
        }
        let (Ok(local_ntv6), Ok(server_ntv6)) = (
            protocol::parse_vault_meta_ntv6(&local_bytes),
            protocol::parse_vault_meta_ntv6(&server_bytes),
        ) else {
            return MetaPhaseOutcome::Skipped;
        };
        let local_epoch = local_ntv6.group_key_epoch;
        let server_epoch = server_ntv6.group_key_epoch;

        // Strictly-greater server epoch → adopt the server's bytes verbatim and
        // trigger the M1 refresh: clear the per-blob CAS baselines so the next
        // pull re-fetches every content header the owner rewrapped at the same
        // ids. Content ciphertext and `content_nonce` are unchanged by a
        // rewrap, so without this the peer would read itself as up to date.
        if protocol::person_invite::accept_newer_epoch(local_epoch, server_epoch).is_some() {
            // Authenticate the newer bytes BEFORE writing them. For an OWNER
            // adopter the owner-wrapped group key must open under our root key
            // and the roster envelope must open under that group key, so a
            // hostile server cannot forge a high epoch and wedge or lock out the
            // vault (the write below is irreversible: the genuine lower epoch is
            // then refused as a rollback forever). A MEMBER holds no root key, so
            // it cannot verify and relies on the group package it is delivered
            // (owed delivery path, task 30); it adopts unverified.
            if let Some(root_key) = root_key {
                let group = match protocol::unlock_group_key_ntv6(
                    &server_ntv6,
                    &protocol::OwnerKey::new(*root_key),
                ) {
                    Ok(group) => group,
                    Err(_) => {
                        tracing::warn!(
                            stage = "meta_phase",
                            event = "ntv6_epoch_unverified",
                            "refusing a newer group-key epoch whose owner wrap does not open"
                        );
                        return MetaPhaseOutcome::Skipped;
                    }
                };
                if protocol::person_invite::open_group_roster(
                    &group,
                    &server_ntv6.base.account_number_hash,
                    server_ntv6.group_key_epoch,
                    &server_ntv6.signed_roster_envelope,
                )
                .is_none()
                {
                    tracing::warn!(
                        stage = "meta_phase",
                        event = "ntv6_epoch_unverified",
                        "refusing a newer group-key epoch whose roster does not open"
                    );
                    return MetaPhaseOutcome::Skipped;
                }
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
                state.blobs.clear();
                state.meta_baseline_hex = Some(server_hash);
                let _ = clear_vault_meta_dirty(io, vault_root).await;
                tracing::info!(
                    stage = "meta_phase",
                    event = "ntv6_epoch_adopted",
                    "adopted a newer group-key epoch and queued the M1 header refresh"
                );
                return MetaPhaseOutcome::Adopted;
            }
            return MetaPhaseOutcome::Skipped;
        }
        // A lower server epoch is a rollback: refuse rather than regress the
        // keys under a session that already holds the newer tier.
        if server_epoch < local_epoch {
            tracing::warn!(
                stage = "meta_phase",
                event = "ntv6_epoch_rollback_refused",
                "refusing a lower group-key epoch as a rollback"
            );
            return MetaPhaseOutcome::Skipped;
        }
        // Equal epoch. The keys agree by construction; the roster may differ.
        if server_changed && !local_changed {
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
        if local_changed && !server_changed {
            // A member never pushes `vault.meta`; the roster is owner-authored.
            if !member
                && may_push
                && super::enroll::put_vault_meta(transport, &put_token, &local_bytes).is_ok()
            {
                state.meta_baseline_hex = Some(local_hash);
                let _ = clear_vault_meta_dirty(io, vault_root).await;
                return MetaPhaseOutcome::Pushed;
            }
            return MetaPhaseOutcome::NoChange;
        }
        // Both changed at the same epoch with no tie-break → fail closed.
        return MetaPhaseOutcome::Skipped;
    }

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
        // The device-local membership field is never adopted: it names THIS
        // device's account, and the server copy names another device's (or
        // none). Adopting it verbatim would strand a foreign owner that the
        // unlock stamp never repairs (it skips as already-present), so the
        // local field is transplanted into the adopted bytes. NTV5 only: a
        // MYV1 server blob has no field slot, and dropping the local field
        // there heals on next unlock (absent re-stamps), so that path stays
        // verbatim rather than version-upgrading the file on adopt.
        //
        // The 0x02 ROSTER extension is the one shared exception
        // (myne-md/myne#698): its member rows are a vault fact, so they are
        // union-merged with the server's rather than transplanted local-wins.
        let adopted_bytes =
            if protocol::meta_version_of(&server_bytes) == Some(protocol::MetaVersion::V0_2) {
                let mut adopted_meta = server_meta.clone();
                adopted_meta.membership = local_meta.membership.clone();
                merge_roster_extension(
                    root_key,
                    &mut adopted_meta,
                    local_meta.membership.as_ref(),
                    server_meta.membership.as_ref(),
                    account_number_hash_of(&local_meta),
                );
                protocol::serialize_vault_meta_v0_2(&adopted_meta)
            } else {
                server_bytes.clone()
            };
        if io
            .write(
                &meta_path,
                &adopted_bytes,
                crate::vault_io::WriteOpts::default(),
            )
            .await
            .is_ok()
        {
            // Baseline is what was WRITTEN, not what the server sent: the
            // transplant above means those differ exactly when the local
            // field existed, and baselining the server bytes would read our
            // own transplant back as local dirt on every cycle.
            state.meta_baseline_hex = Some(sha256_hex(&adopted_bytes));
            let _ = clear_vault_meta_dirty(io, vault_root).await;
            return MetaPhaseOutcome::Adopted;
        }
        return MetaPhaseOutcome::Skipped;
    }

    // Only I changed (server unchanged since my baseline) → push my meta.
    if local_changed && !server_changed {
        if may_push && super::enroll::put_vault_meta(transport, &put_token, &local_bytes).is_ok() {
            state.meta_baseline_hex = Some(local_hash);
            let _ = clear_vault_meta_dirty(io, vault_root).await;
            return MetaPhaseOutcome::Pushed;
        }
        return MetaPhaseOutcome::NoChange; // keep dirty for a later push cycle
    }

    // Both changed (concurrent) → deterministic, commutative merge so both devices
    // converge on the same winner with no server-side version counter.
    //
    // Generation guard (§10.4.1, #420): `merge_vault_meta` operates on the
    // version-less `VaultMeta` fields, so the re-serialize below MUST re-stamp
    // the SAME generation the inputs carry. Serializing a migrated (v0.2 / `NTV5`)
    // meta with `serialize_vault_meta` (which unconditionally stamps `MYV1` +
    // `0x01`) writes a blob that claims v0.1 over v0.2 wrap bytes — the next
    // unlock reads `meta_version_of` → `V0_1`, derives the KDF under the v0.1
    // salt domain, and the wrap key never opens: `InvalidCredentialOrVault` for
    // both password AND recovery, with every `NC05` note stranded under the
    // now-unreachable v0.2 `itemsKey`. Refuse a cross-generation merge outright
    // (never merge a `MYV1` and an `NTV5` meta), and serialize under the shared
    // generation.
    let local_gen = protocol::meta_version_of(&local_bytes);
    let server_gen = protocol::meta_version_of(&server_bytes);
    if local_gen != server_gen {
        return MetaPhaseOutcome::Skipped; // never merge across generations
    }
    let winner = meta_password_side_winner(&local_meta, &server_meta);
    let Ok(mut merged) = merge_vault_meta(&local_meta, &server_meta, winner) else {
        return MetaPhaseOutcome::Skipped; // incompatible invariant → leave local alone
    };
    // The roster extension is shared: union-merge both sides' member rows so a
    // peer's invite (or a removal tombstone) converges instead of being
    // transplanted local-wins by `merge_vault_meta`.
    merge_roster_extension(
        root_key,
        &mut merged,
        local_meta.membership.as_ref(),
        server_meta.membership.as_ref(),
        account_number_hash_of(&local_meta),
    );
    let merged_bytes = match local_gen {
        Some(protocol::MetaVersion::V0_2) => protocol::serialize_vault_meta_v0_2(&merged),
        _ => serialize_vault_meta(&merged).to_vec(),
    };
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
    } else if may_push {
        let _ = super::enroll::put_vault_meta(transport, &put_token, &merged_bytes);
        let _ = clear_vault_meta_dirty(io, vault_root).await;
    }
    // (!may_push && merged != server: keep dirty so a later push cycle propagates.
    // With a pending credential change `may_push` is true regardless of the
    // scheduler's window — myne#293.)
    MetaPhaseOutcome::Merged
}

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
/// `base_version` forever. One request is still one atomic batch (a single blob's
/// CAS failure aborts the server's batch before it commits, so an innocent sibling
/// in the SAME chunk cannot get through either) and every later chunk is abandoned
/// with it — but the chunks that already landed stay landed and stay recorded, see
/// below. Bounded by [`MAX_PUSH_ATTEMPTS`].
///
/// **What is persisted, and when.** The advanced cursor is written only on a fully
/// successful attempt, so a failed retry never leaks a half-advanced cursor onto
/// disk. A **landed push chunk** is the exception and is checkpointed inside the
/// attempt (myne-md/myne#222): the versions the server returned are a fact about the
/// server, and refusing to write them down is exactly what turned one timed-out
/// first sync into an account that could never sync again. The two rules do not
/// conflict — by the time a push runs, `pull_to_stable` has already returned a
/// stable page, so the cursor being persisted alongside is fully advanced and
/// consistent with what the pull wrote to disk.
/// What this cycle is allowed to push.
///
/// This replaced a bare `allow_push: bool` when the device-verification hold
/// landed (myne#462), because the hold needs a state the bool could not express:
/// **suppress content, but still author a genesis head.** Left as a bool, the
/// hold would have re-broken the liveness fix of `decisions.md` 2026-07-12 — on a
/// zero-note account nobody has ever pushed to, the genesis head is the only
/// thing a joining device can adopt, and a device holding pushes for the compare
/// would never author it, so the joiner's SAS would never appear and both screens
/// would wait forever. That is a worse bug than the one being fixed, and it is
/// invisible on any account that already has a head.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PushGate {
    /// A push cycle: the coalescing window elapsed, or the caller asked for one
    /// explicitly (`sync_now`).
    Allowed,
    /// A poll-driven pull-only cycle. Pushes are coalesced elsewhere; firing one
    /// here would turn the poll cadence into an edit-timing channel (§8.3
    /// resolution-blur).
    PollOnly,
    /// A push cycle running while a device-verification eye-compare is open on
    /// this device (myne#462). Content is held so the vault head stands still
    /// under the compare; genesis is not, for the liveness reason above.
    VerifyHold,
}

impl PushGate {
    /// May this cycle push content — notes, attachments, prefs, the catalog —
    /// and therefore author a head over them?
    pub fn allows_content(self) -> bool {
        matches!(self, PushGate::Allowed)
    }

    /// May this cycle author the genesis head of an account that has none?
    ///
    /// True under a verify hold, deliberately. A genesis push is head-only over
    /// an empty manifest: it commits nothing the user typed, it cannot move a
    /// head that does not exist, and it is the very head the joining device is
    /// waiting to adopt.
    pub fn allows_genesis(self) -> bool {
        matches!(self, PushGate::Allowed | PushGate::VerifyHold)
    }
}

// The arguments are each a distinct, independent input to the cycle (the
// transport, the two keys/ids, the token, the two paths, the push gate); bundling
// them into a struct would not aid clarity at this single orchestrator entry.
#[allow(clippy::too_many_arguments)]
pub async fn run_sync_cycle(
    io: &dyn crate::vault_io::VaultIo,
    transport: &dyn SyncTransport,
    // The owner root key, or `None` for a member session: a member holds no
    // `root_key`, and the shared families it may sync derive their ids from the
    // group tier (`shared`) instead. Owner-only phases (the meta roster merge,
    // credentials re-key) stand down when this is `None`.
    root_key: Option<&[u8; 32]>,
    shared: &SharedSingletonKey,
    account_number_hash: [u8; 16],
    device_id: [u8; 16],
    token: &str,
    notes_dir: &Path,
    vault_root: &Path,
    gate: PushGate,
    // The vault's generation, resolved from the SAME `vault.meta` parse that
    // produced `account_number_hash` (`cycle::cycle_account_number_hash`), so the
    // two cannot disagree. Every singleton phase derives its KEK under it: a
    // migrated vault's `MYP5`/`MYC5`/`MYT5` need v0.2, and a v0.1 KEK lands in
    // their read-as-empty branch, which then re-seals empty over the real blob.
    version: MetaVersion,
    attachment_keys: Option<AttachmentKeys<'_>>,
    // The signed (`0x02`) head authority when the vault is `NTV6` and a person
    // identity is held; `None` keeps the `NTV5` `root_key` HMAC head. Keyed off
    // the vault generation (decisions/protocol/0603, Q2 revised).
    signed: Option<&SignedHeadCtx>,
    // The blob ids of notes OPEN in a live session (`collab-editor-bridge` task 7).
    // A pulled revision of one is DEFERRED (not written) so the caller can merge it
    // into the session; every other pulled note is written as usual. Empty when no
    // session is open, the desktop/mobile norm and every `sim.rs` run.
    live_note_ids: &HashSet<[u8; 16]>,
) -> Result<SyncSummary, SyncCycleError> {
    let mut state = read_sync_state(io, vault_root)
        .await
        .map_err(|_| SyncCycleError::Io)?;

    // CLEAR the whole-corpus flag on entry (myne#292).
    //
    // Its own doc says it is "recomputed every cycle, and cleared as readily as
    // it is set" — because its only job is to authorise an IRREVERSIBLE
    // cross-device attachment erase, so it has to describe THIS cycle's end
    // state. It did not: the recompute is the last statement of
    // `sync_cycle_attempt`, and the only writer of that value to disk is the
    // success arm below. A cycle that wrote the merged catalog and then failed
    // in the note loop left the PREVIOUS cycle's `true` on disk — and every
    // in-attempt checkpoint that did run re-serialised that same stale `true`.
    // It then survived restarts indefinitely while retries kept failing, because
    // an offline device fails at the pull and never reaches the recompute.
    //
    // The consequence is not a stale badge: "Clean unused" reads this flag,
    // offers an attachment the device no longer has the corpus to judge, and
    // tombstones it on every device.
    //
    // Clearing on ENTRY rather than computing-before-every-return cannot be
    // defeated by a future early return added above the recompute. The cost is
    // that a cycle failing before the recompute leaves `false`, i.e. the sweep
    // declines until a cycle completes — which is the safe direction.
    //
    // It is PERSISTED here rather than left to whichever in-attempt checkpoint
    // happens to run, because "which checkpoint ran" is not a property the
    // invariant can rest on: a cycle that dies in the pull before any of them
    // would otherwise leave the stale `true` on disk, which is the whole defect.
    // The write is skipped when the flag was already false, so the common case
    // costs nothing.
    if state.corpus_complete {
        state.corpus_complete = false;
        write_sync_state(io, vault_root, &state)
            .await
            .map_err(|_| SyncCycleError::Io)?;
    }

    // The authority this vault's heads are authored, verified and baselined
    // under: signed `0x02` on an `NTV6` vault with a held person identity, else
    // the `NTV5` `root_key` HMAC.
    let head_authority = match signed {
        Some(ctx) => HeadAuthority::Signed(ctx),
        // An `NTV5` head is HMAC'd under the owner root key, which a member
        // does not hold; a member session is always `NTV6` and always signed.
        None => match root_key {
            Some(root_key) => HeadAuthority::Mac { root_key },
            None => return Err(SyncCycleError::Head),
        },
    };
    // Baseline VV + seq from the device-local head baseline (empty on first sync).
    let baseline_head = read_head_baseline(io, &head_authority, vault_root)
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
            shared,
            account_number_hash,
            device_id,
            token,
            notes_dir,
            vault_root,
            gate,
            version,
            attachment_keys,
            &head_authority,
            &mut state,
            &baseline_vv,
            baseline_seq,
            from_cursor,
            live_note_ids,
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
                let meta_outcome = sync_meta_phase(
                    io,
                    transport,
                    token,
                    vault_root,
                    &mut state,
                    gate.allows_content(),
                    root_key,
                )
                .await;
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
    root_key: Option<&[u8; 32]>,
    shared: &SharedSingletonKey,
    account_number_hash: [u8; 16],
    device_id: [u8; 16],
    token: &str,
    notes_dir: &Path,
    vault_root: &Path,
    gate: PushGate,
    // The vault's generation, resolved from the SAME `vault.meta` parse that
    // produced `account_number_hash` (`cycle::cycle_account_number_hash`), so the
    // two cannot disagree. Every singleton phase derives its KEK under it: a
    // migrated vault's `MYP5`/`MYC5`/`MYT5` need v0.2, and a v0.1 KEK lands in
    // their read-as-empty branch, which then re-seals empty over the real blob.
    version: MetaVersion,
    attachment_keys: Option<AttachmentKeys<'_>>,
    head_authority: &HeadAuthority<'_>,
    state: &mut SyncState,
    baseline_vv: &[VvEntry],
    baseline_seq: u64,
    from_cursor: u64,
    // The blob ids of notes OPEN in a live session (task 7): their pulled revision
    // is DEFERRED to `summary.deferred_live_pulls` rather than written.
    live_note_ids: &HashSet<[u8; 16]>,
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
    let cat_id = attachment_keys.map(|_| shared_sync_id(shared, SubkeyRole::CatalogSyncId));
    let themes_id = shared_sync_id(shared, SubkeyRole::ThemesSyncId);
    // `vault.member-names` is addressed through the GROUP tier only (`None` on a
    // pre-B2B `OwnerRoot` session), and it is the one shared singleton with no
    // `SubkeyRole` counterpart, which is why it does not go through `shared_sync_id`.
    let names_id = member_names_sync_id(shared);
    // `vault.device-bindings` is addressed the same way and for the same reason: group
    // tier only (`None` on a pre-B2B `OwnerRoot` session), and no `SubkeyRole`
    // counterpart to route through `shared_sync_id`. One row down from the names id in
    // `GroupRole::ALL`, and a separate derivation from it: a family whose id collided
    // with another's would have one family's push overwrite the other's blob.
    let bindings_id = device_bindings_sync_id(shared);
    // The chats / agent-memory / agent-personality catalogs are ROOT-derived, not
    // group-derived, and are therefore `None` on a member (which holds no
    // `root_key`). `docs/decisions/protocol/0609` states it: those three families
    // are person-private (the `MYY5` plane, 0608) and "have no group role", which
    // is why `member_removal::group_rotation_reclaim_sync_ids` lists only the
    // catalog / prefs / themes ids it rotates. Routing them through
    // `shared_sync_id` was a defect: on an `NTV6` session `shared` is `Group`, and
    // `GroupRole` has no chats / memory / personality variant, so the call hit an
    // `expect` and panicked the whole cycle (myne-md/myne#791). They derive from
    // the retained owner root, exactly as the v0.1/v0.2 root-tier singletons do.
    let chats_catalog_id = root_key.map(|rk| sync_id_for(rk, SubkeyRole::ChatsCatalogSyncId));
    // In-memory union of the per-conversation files (conversation id →
    // on-disk nonce), maintained by the pull loop like `att_scan`.
    let mut chats_scan: BTreeMap<[u8; 16], [u8; 24]> = BTreeMap::new();
    {
        if let Ok(entries) = io.read_dir(&chats_dir(vault_root)).await {
            for entry in entries {
                // Names, not paths: OPFS has no path API at all. The canonical
                // check is the attachments one (64 lowercase hex is an
                // attachment; ours is 32). A non-canonical name is skipped, and
                // the file-never-written question is what the header answers.
                if let Some(id) = from_hex16(&entry.name) {
                    if let Ok(header) = io
                        .read_prefix(&chats_dir(vault_root).join(&entry.name), 34)
                        .await
                    {
                        if let Some(nonce) = read_chats_blob_nonce(&header) {
                            chats_scan.insert(id, nonce);
                        }
                    }
                }
            }
        }
    }
    // The memory plane is behind the per-device `ai_enabled` gate
    // (sync-protocol.md §10.2.6/§10.2.7): an opted-out device derives no ids,
    // scans nothing, and inserts no baselines. It pushes/pulls nothing for
    // these ids, exactly as a vault with no conversations stays chats-silent.
    // The memory plane is owner-only: a member's memory and personality are
    // person-private (myne-md/myne#711 task 27), carried by the `MYY5` profile
    // plane, and their family keys have no group role by design. `root_key`
    // is `None` for a member, so the whole plane stands down exactly as it does
    // for an opted-out device.
    let memory_on = root_key.is_some()
        && memory_sync_enabled(io, shared, &account_number_hash, vault_root, version).await;
    // Root-derived for the same reason the chats catalog is (`0609`): no group
    // role, so a member (no `root_key`) skips the whole plane.
    let memory_catalog_id = root_key
        .map(|rk| sync_id_for(rk, SubkeyRole::AgentMemoryCatalogSyncId))
        .filter(|_| memory_on);
    let personality_id = root_key
        .map(|rk| sync_id_for(rk, SubkeyRole::AgentPersonalitySyncId))
        .filter(|_| memory_on);
    // In-memory union of the per-entry files (entry id → on-disk nonce),
    // maintained by the pull loop like `chats_scan`.
    let mut memories_scan: BTreeMap<[u8; 16], [u8; 24]> = BTreeMap::new();
    if memory_on {
        if let Ok(entries) = io.read_dir(&memories_dir(vault_root)).await {
            for entry in entries {
                if let Some(id) = from_hex16(&entry.name) {
                    if let Ok(header) = io
                        .read_prefix(&memories_dir(vault_root).join(&entry.name), 34)
                        .await
                    {
                        if let Some(nonce) = read_agent_memory_blob_nonce(&header) {
                            memories_scan.insert(id, nonce);
                        }
                    }
                }
            }
        }
    }
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
    if let Some(nid) = names_id {
        if let Some(n) = io
            .read(&member_names_file_path(vault_root))
            .await
            .ok()
            .as_deref()
            .and_then(read_member_names_nonce)
        {
            local.insert(nid, n);
        }
    }
    if let Some(cid) = chats_catalog_id {
        if let Some(n) = io
            .read(&chats_catalog_file_path(vault_root))
            .await
            .ok()
            .as_deref()
            .and_then(read_chats_catalog_nonce)
        {
            local.insert(cid, n);
        }
    }
    if let Some(mid) = memory_catalog_id {
        if let Some(n) = io
            .read(&agent_memory_catalog_file_path(vault_root))
            .await
            .ok()
            .as_deref()
            .and_then(read_agent_memory_catalog_nonce)
        {
            local.insert(mid, n);
        }
    }
    if let Some(pid) = personality_id {
        if let Some(n) = io
            .read(&personality_file_path(vault_root))
            .await
            .ok()
            .as_deref()
            .and_then(read_personality_nonce)
        {
            local.insert(pid, n);
        }
    }
    for (cid, n) in &memories_scan {
        local.insert(*cid, *n);
    }
    for (cid, n) in &chats_scan {
        local.insert(*cid, *n);
    }
    // This device re-keyed the vault locally (§10.4.1 migration, #429), so the
    // head the server still holds cannot open under the new `root_key`. Let the
    // pull take its id instead of reading it as a forgery; the head-authoring
    // block below re-bases onto that id and clears the flag.
    let rekey_rebase = state.rekey_rebase_pending;
    let page = match engine::pull_to_stable(
        transport,
        head_authority,
        token,
        baseline_vv,
        from_cursor,
        &local,
        false,
        rekey_rebase,
    ) {
        Ok(p) => p,
        Err(PullError::CursorExpired) => {
            reconcile_ran = true;
            state.cursor = 0;
            write_sync_state(io, vault_root, state)
                .await
                .map_err(|_| SyncCycleError::Io)?;
            engine::pull_to_stable(
                transport,
                head_authority,
                token,
                baseline_vv,
                0,
                &local,
                true,
                rekey_rebase,
            )
            .map_err(SyncCycleError::Pull)?
        }
        // A head that will not open is normally a forgery. On a device whose
        // sibling just ran the §10.4.1 migration it is instead the expected
        // consequence of a re-key, and the two are indistinguishable at the pull.
        // Ask the one question that separates them (#429): is the server's
        // `vault.meta` a NEWER generation than ours? Only the migration produces
        // that, and no server can fabricate it — a v0.2 meta opens only under
        // credentials the user holds.
        // A head that will not open is normally a forgery. On a device whose
        // sibling just ran the §10.4.1 migration it is instead the expected
        // consequence of a re-key. The question below separates them; the
        // `if let` binds the server's meta because this device is about to
        // STAGE it (#447) rather than merely learn that it exists.
        Err(PullError::HeadInvalid) => {
            let Some(newer) =
                server_meta_of_newer_generation(transport, token, io, vault_root).await
            else {
                return Err(SyncCycleError::Pull(PullError::HeadInvalid));
            };
            // Staged, never written over `vault.meta` (#447). The peer cannot
            // verify these bytes — it has no key for the generation they belong
            // to — so the only thing that may promote them is the user's own
            // credential opening them at unlock. A server that serves a
            // fabricated `NTV5` meta therefore costs a wasted Argon2id and
            // nothing else; overwriting here would cost the vault, because
            // `vault.meta` holds the only local copy of the wrapped `root_key`.
            //
            // Without this the loop had no exit: the peer locked, the user
            // unlocked, the OLD local meta re-derived the OLD root, the next
            // cycle met the same unopenable head, and it locked again.
            crate::plugins::vault_migrate::adopt::stage_incoming_meta(io, vault_root, &newer).await;
            return Err(SyncCycleError::RekeyedElsewhere);
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
                    doc_heads_hex: Vec::new(),
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

    // --- chats phase (myne-md/myne#675): every cycle for an owner ---
    // A member's conversations are person-private (myne-md/myne#711 task 28),
    // carried by the `MYY5` profile plane, never the shared group manifest: the
    // shared chats phase stands down for a member (its family key has no group
    // role by design). The skipped outcome keeps every downstream consumer
    // inert without a special case.
    // Like the themes singleton, the conversations catalog is never
    // head-committed; its dirty blob rides the push batch below so the CAS/409
    // machinery covers it. ONE critical section: the chats plugin's write
    // mutex is taken HERE, before the catalog read-merge-write, and held
    // through the conversation loop below, so a chats plugin command cannot
    // interleave between the roster the phase merged and the per-file
    // reconcile that follows it (the shape the sync_chats_phase docblock
    // describes; the phases' own guard is the call site's because a tokio
    // Mutex is not reentrant).
    let remote_chats_cat_rec = chats_catalog_id.and_then(|cid| {
        page.all_metas
            .iter()
            .find(|m| m.id == cid && m.attachment_id.is_none())
    });
    let chats_write_mutex = crate::plugins::chats::commands::write_mutex();
    let chats_write_guard = chats_write_mutex.lock().await;
    let mut chats_phase = match (root_key, chats_catalog_id) {
        (Some(root_key), Some(chats_catalog_id)) => {
            sync_chats_phase(
                io,
                transport,
                token,
                root_key,
                &account_number_hash,
                vault_root,
                state,
                &chats_catalog_id,
                remote_chats_cat_rec,
                version,
            )
            .await?
        }
        _ => skipped_chats_phase(),
    };

    // --- conversation pull loop (catalog-guarded) ---
    // For every LIVE catalog row, reconcile the per-conversation file. A row
    // whose record is a tombstone erases the local file instead (deletion
    // propagation); an id with no catalog row is never downloaded blind.
    // A locally-dirty file is skipped: our on-disk copy diverges from the
    // synced baseline and downloading the server's copy would clobber it.
    // The whole loop stands down when the catalog phase was refused
    // (`skipped`): with no merged roster there is nothing to reconcile
    // against, and deleting or adopting per-file on a refused catalog would
    // act without its guard.

    let mut conversations_pulled: usize = 0;
    // A non-skipped chats phase (a non-empty merged roster) only exists for an
    // owner: a member's phase is skipped with an EMPTY roster (its conversations
    // ride the person-private `MYY5` profile plane), so this loop body never runs
    // for one. The owner key is resolved INSIDE the loop for exactly that reason.
    // It used to sit before the loop as an unconditional `root_key.expect(...)`,
    // which fired on every member cycle and panicked the whole attempt before any
    // content was pulled — the member saw the generic "Sync error" and pulled
    // nothing (no notes, no prefs/name). Guarding here keeps the owner-only unwrap
    // off an empty (member) loop.
    for (conv_hex, entry) in chats_phase.merged.iter() {
        let Some(chats_root_key) = root_key else {
            break;
        };
        let Some(conv_id) = from_hex16(conv_hex) else {
            // The catalog is canonical JSON from our own writer; a malformed
            // id is a schema violation, not a download candidate.
            continue;
        };
        if !entry.is_live() {
            // Remote deletion propagation: erase the local body (+ nothing
            // else (the tombstone row itself already merged above).
            let path = chats_dir(vault_root).join(conv_hex);
            match io.remove_file(&path).await {
                Ok(()) => {
                    chats_scan.remove(&conv_id);
                    state.blobs.remove(conv_hex);
                }
                Err(crate::io_failure_kind::IoFailureKind::NotFound) => {
                    state.blobs.remove(conv_hex);
                }
                Err(_) => {}
            }
            continue;
        }
        // Locally-dirty skip (the notes candidates' cheap filter, same rule).
        let baseline_nonce_hex = state.blobs.get(conv_hex).map(|b| &b.content_nonce_hex);
        let local_nonce_hex = chats_scan.get(&conv_id).map(|n| hex(&n[..]));
        if baseline_nonce_hex.is_some() && baseline_nonce_hex != local_nonce_hex.as_ref() {
            continue;
        }
        let remote_rec = page
            .all_metas
            .iter()
            .find(|m| m.id == conv_id && m.attachment_id.is_none());
        let conv_phase = match sync_chats_conversation_phase(
            io,
            transport,
            token,
            chats_root_key,
            &account_number_hash,
            vault_root,
            &conv_id,
            remote_rec,
            version,
        )
        .await
        {
            Ok(p) => p,
            Err(e) => {
                // No conversation id on the record: it is a vault-stable
                // correlation tag in the DENY-listed class (`note_id`, salts,
                // nonces), and no other sync arm logs one.
                tracing::warn!(
                    stage = "chats-conversation",
                    error = ?e,
                    "a conversation failed to reconcile; skipping it for this cycle"
                );
                continue;
            }
        };
        if let Some(rec) = conv_phase.remote {
            record_blob_baseline(state, conv_hex, &rec);
            // `pulled` counts remote-adopted blobs (the notes twin): a
            // merged conversation is a download + a local write, same class.
            conversations_pulled += 1;
            // Mirror the write into the in-memory scan (ONE scan per attempt):
            // an adopted or merged file's fresh nonce is now the local one.
            if let Ok(bytes) = io.read(&chats_dir(vault_root).join(conv_hex)).await {
                if let Some(n) = read_chats_blob_nonce(&bytes) {
                    chats_scan.insert(conv_id, n);
                }
            }
        }
    }
    drop(chats_write_guard);

    // --- memory phase (myne-md/myne#697): gated, every cycle when on ---
    // Behind the per-device `ai_enabled` gate: `memory_catalog_id` is `None`
    // when the opt-in is off and the whole plane stands down (no pull, no
    // push, no tombstone drain). When on, the memory catalog rides the push
    // batch below like the chats catalog (never head-committed; CAS/409
    // covers it). ONE critical section: the memory plugin's write mutex is
    // taken HERE and held through the entry loop below, same shape as chats.
    let mut memory_phase: Option<MemoryPhase> = None;
    let mut personality_phase: Option<PersonalityPhase> = None;
    let mut entries_pulled: usize = 0;
    if let Some(mid) = memory_catalog_id {
        // `memory_catalog_id` is only `Some` when `root_key` is: the shared
        // memory plane is owner-only (a member's memory is person-private).
        let root_key = root_key.expect("memory_on implies an owner root key");
        let remote_mem_cat_rec = page
            .all_metas
            .iter()
            .find(|m| m.id == mid && m.attachment_id.is_none());
        let memory_write_mutex = crate::plugins::memory::commands::write_mutex();
        let memory_write_guard = memory_write_mutex.lock().await;
        let phase = sync_memory_phase(
            io,
            transport,
            token,
            root_key,
            &account_number_hash,
            vault_root,
            state,
            &mid,
            remote_mem_cat_rec,
            version,
        )
        .await?;

        // --- entry pull loop (catalog-guarded, adopt-by-catalog-winner) ---
        // For every LIVE catalog row, reconcile the per-entry file. A row
        // whose record is a tombstone erases the local file instead (deletion
        // propagation); an id with no catalog row is never downloaded blind.
        // A locally-dirty file is skipped: our on-disk copy diverges from the
        // synced baseline and downloading the server's copy would clobber it.
        // The whole loop stands down when the catalog phase was refused
        // (`skipped`): with no merged roster there is nothing to reconcile
        // against.
        if !phase.skipped {
            for (entry_hex, row) in phase.merged.iter() {
                let Some(entry_id) = from_hex16(entry_hex) else {
                    continue;
                };
                if !row.is_live() {
                    let path = memories_dir(vault_root).join(entry_hex);
                    match io.remove_file(&path).await {
                        Ok(()) => {
                            memories_scan.remove(&entry_id);
                            state.blobs.remove(entry_hex);
                        }
                        Err(crate::io_failure_kind::IoFailureKind::NotFound) => {
                            state.blobs.remove(entry_hex);
                        }
                        Err(_) => {}
                    }
                    continue;
                }
                // Locally-dirty skip (the conversation loop's cheap filter).
                let baseline_nonce_hex = state.blobs.get(entry_hex).map(|b| &b.content_nonce_hex);
                let local_nonce_hex = memories_scan.get(&entry_id).map(|n| hex(&n[..]));
                if baseline_nonce_hex.is_some() && baseline_nonce_hex != local_nonce_hex.as_ref() {
                    continue;
                }
                // Both-changed arbiter: the merged row at a version past the
                // pre-merge local one is the remote winner (adopt its file);
                // at the local version it is the local winner (push ours).
                let remote_wins = phase
                    .local_versions
                    .get(entry_hex)
                    .map(|v| row.version != *v)
                    .unwrap_or(true);
                let remote_rec = page
                    .all_metas
                    .iter()
                    .find(|m| m.id == entry_id && m.attachment_id.is_none());
                let entry_phase = match sync_memory_entry_phase(
                    io,
                    transport,
                    token,
                    root_key,
                    &account_number_hash,
                    vault_root,
                    state,
                    &entry_id,
                    remote_rec,
                    remote_wins,
                    version,
                )
                .await
                {
                    Ok(p) => p,
                    Err(e) => {
                        tracing::warn!(
                            stage = "memory-entry",
                            error = ?e,
                            "a memory entry failed to reconcile; skipping it for this cycle"
                        );
                        continue;
                    }
                };
                if let Some(rec) = entry_phase.remote {
                    record_blob_baseline(state, entry_hex, &rec);
                    entries_pulled += 1;
                    if let Ok(bytes) = io.read(&memories_dir(vault_root).join(entry_hex)).await {
                        if let Some(n) = read_agent_memory_blob_nonce(&bytes) {
                            memories_scan.insert(entry_id, n);
                        }
                    }
                }
            }
        }
        drop(memory_write_guard);
        memory_phase = Some(phase);

        // --- personality phase: the singleton half of the plane ---
        // Whole-value LWW, themes-shape. The phase holds the memory plane's
        // write mutex for the whole reconcile (myne-md/myne#697), so a user
        // edit landing between its read and its write cannot be silently
        // overwritten.
        let pid = personality_id.expect("personality id set whenever the gate passed");
        let remote_pers_rec = page
            .all_metas
            .iter()
            .find(|m| m.id == pid && m.attachment_id.is_none());
        personality_phase = Some(
            sync_personality_phase(
                io,
                transport,
                token,
                root_key,
                &account_number_hash,
                vault_root,
                state,
                &pid,
                remote_pers_rec,
                version,
            )
            .await?,
        );
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
            shared,
            &account_number_hash,
            vault_root,
            state,
            &cid,
            remote_cat_rec,
            version,
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
                            doc_heads_hex: Vec::new(),
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
                                doc_heads_hex: Vec::new(),
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
                    if crate::attachment_nonce::read_attachment_content_nonce(&bytes)
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
                            doc_heads_hex: Vec::new(),
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
    let prefs_id = shared_sync_id(shared, SubkeyRole::PrefsSyncId);
    let remote_prefs_rec = page
        .all_metas
        .iter()
        .find(|m| m.id == prefs_id && m.attachment_id.is_none());
    // myne#613: the prefs phase may FAIL without taking the cycle with it.
    //
    // `vault.prefs` is settings; the notes phase below is the user's data. This
    // used to be `.await?`, so any prefs-side `SyncCycleError` aborted
    // `sync_cycle_attempt` before the themes phase, the notes phase and the push
    // batch. The reachable case was an over-cap merged blob, which is now
    // bounded (`shed_retained_clocks`), but the ordering was wrong on its own
    // terms: a settings blob that cannot be written is a reason to skip settings
    // for a cycle, never a reason to stop syncing notes. The bound above closes
    // the growth path anybody has found; this closes the class.
    //
    // Skipping leaves `dirty: false`, so nothing here moves the push-gate
    // baseline: `set_prefs_gate_baseline` runs only when the prefs blob really
    // landed in the push batch, so the next cycle retries from the same base.
    let prefs_phase = match sync_prefs_phase(
        io,
        transport,
        token,
        shared,
        &account_number_hash,
        vault_root,
        state,
        &prefs_id,
        remote_prefs_rec,
        version,
    )
    .await
    {
        Ok(phase) => phase,
        Err(err) => {
            tracing::warn!(
                stage = "prefs",
                event = "phase_skipped",
                error = ?err,
                "the prefs phase failed; syncing notes anyway and retrying prefs next cycle"
            );
            PrefsPhase {
                dirty: false,
                applied_remote: false,
                shared_hash: String::new(),
            }
        }
    };

    // --- themes phase (MYND-486) — unconditional, every cycle ---
    // Like the catalog + prefs singletons, `vault.themes` is never
    // head-committed; its dirty blob rides the push batch below so the CAS/409
    // machinery covers it. (`themes_id` is derived once per attempt, above.)
    let remote_themes_rec = page
        .all_metas
        .iter()
        .find(|m| m.id == themes_id && m.attachment_id.is_none());
    let mut themes_phase = sync_themes_phase(
        io,
        transport,
        token,
        shared,
        &account_number_hash,
        vault_root,
        state,
        &themes_id,
        remote_themes_rec,
        version,
    )
    .await?;

    // --- member-names phase (task 3b-ii), only on a group-held (`NTV6`) session ---
    // Like the other shared singletons it is never head-committed; its dirty blob rides
    // the push batch below so the CAS/409 machinery covers it. `names_id` is `None` on a
    // pre-B2B vault, where the family does not exist at all.
    let mut names_phase = match names_id {
        Some(nid) => {
            let remote_names_rec = page
                .all_metas
                .iter()
                .find(|m| m.id == nid && m.attachment_id.is_none());
            sync_member_names_phase(
                io,
                transport,
                token,
                shared,
                vault_root,
                state,
                &nid,
                remote_names_rec,
            )
            .await?
        }
        None => MemberNamesPhase::idle(),
    };

    // --- device-bindings phase (member-devices task 3), group-held sessions only ----
    // Same shape and same gating as the names phase above: never head-committed, its
    // dirty blob rides the push batch below so the CAS/409 machinery covers it, and
    // `bindings_id` is `None` on a pre-B2B vault where the family does not exist.
    let mut bindings_phase = match bindings_id {
        Some(bid) => {
            let remote_bindings_rec = page
                .all_metas
                .iter()
                .find(|m| m.id == bid && m.attachment_id.is_none());
            sync_device_bindings_phase(
                io,
                transport,
                token,
                shared,
                vault_root,
                state,
                &bid,
                remote_bindings_rec,
            )
            .await?
        }
        None => DeviceBindingsPhase::idle(),
    };

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
                && Some(c.id) != names_id
                && Some(c.id) != bindings_id
                && Some(c.id) != chats_catalog_id
                && !chats_scan.contains_key(&c.id)
        })
        .count() as u32;
    super::progress::begin(note_record_count);
    let mut pulled = 0;
    // Conversations reconciled by the chats loop above (declared before the
    // notes drain so the accounting reads in one place): remote-adopted
    // blobs, same class as `pulled`, folded in at the summary.
    pulled += conversations_pulled;
    // The ids this cycle WRITES, for the boundary's re-index (myne#305).
    let mut pulled_note_ids: Vec<String> = Vec::new();
    // Pulled note revisions for OPEN live sessions, handed back for the caller to
    // merge into the session (task 7). Not written here, the session owns the note.
    let mut deferred_live_pulls: Vec<([u8; 16], Vec<u8>, Option<String>)> = Vec::new();
    // The ASM-6/#422 "updated from another device" signal — NC05 notes an
    // automatic CRDT merge reconciled this cycle (a strict subset of the above).
    let mut remote_merged_note_ids: Vec<String> = Vec::new();
    let mut pull_skipped = 0usize;
    // The records this loop will actually download, with the two filters hoisted
    // verbatim out of the old per-record loop:
    //
    //  - attachment records were handled above; the catalog, prefs and themes
    //    records belong to their own phases and are never written as notes;
    //  - a locally-dirty blob is skipped, because our on-disk copy diverges from
    //    the synced baseline (an unpushed local edit, or a genuine conflict) and
    //    downloading the server's copy would clobber it. The push phase below
    //    sends it; a real concurrent edit surfaces later via keep-both.
    //
    // That second one is only the CHEAP FILTER (it reads the cycle-start
    // manifest). The authoritative re-check still runs against the live disk
    // inside `apply_pulled_note_blob`'s lock, unchanged — batching only means the
    // cheap filter can now run up to one window earlier than the write, so a
    // racing local save wastes slightly more download before the in-lock check
    // catches it.
    let candidates: Vec<&engine::ChangedBlob> = page
        .changed
        .iter()
        .filter(|c| {
            !(c.attachment_id.is_some()
                || Some(c.id) == cat_id
                || c.id == prefs_id
                || c.id == themes_id
                || Some(c.id) == names_id
                || Some(c.id) == chats_catalog_id
                || chats_scan.contains_key(&c.id))
        })
        .filter(|c| {
            // A live-session note is ALWAYS a candidate (task 7): the session's own
            // flushes make the disk nonce diverge from the synced baseline, so the
            // dirty-skip below would exclude it forever and its remote revisions
            // would never reconcile until the pane closed. It is handled by the
            // DEFER branch in `apply_downloaded!` instead of a disk write.
            if live_note_ids.contains(&c.id) {
                return true;
            }
            let baseline_nonce = state.blobs.get(&hex(&c.id)).map(|b| &b.content_nonce_hex);
            let local_nonce = local.get(&c.id).map(|n| hex(n));
            !(baseline_nonce.is_some() && baseline_nonce != local_nonce.as_ref())
        })
        .collect();

    // Apply ONE downloaded record. Shared by the batch drain and the single-blob
    // fallback below so the §11.3 verification and everything downstream of it
    // cannot drift between the two paths.
    macro_rules! apply_downloaded {
        ($c:expr, $bytes:expr, $live:expr) => {{
            let c: &engine::ChangedBlob = $c;
            let bytes: &[u8] = $bytes;
            // `$live` is passed in rather than closed over: a free identifier in a
            // `macro_rules!` body resolves at the definition site, where this
            // function's `live_note_ids` parameter is not nameable.
            let live_note_ids: &std::collections::HashSet<[u8; 16]> = $live;
            let baseline_nonce = state
                .blobs
                .get(&hex(&c.id))
                .map(|b| b.content_nonce_hex.clone());
            // Validate BEFORE the write (§11.3): the downloaded header must carry
            // the exact `content_nonce` the pulled record advertised. Empty bytes
            // (a reclaimed body served as `""`), junk, and a nonce mismatch all
            // fail one check (`read_myn_content_nonce` → None for <header-size or
            // bad magic). On failure NOTHING is mutated: the live local copy stays
            // intact and the old baseline stays authoritative — the old behavior
            // (write unverified bytes, adopt the server baseline) is what made
            // this bug destroy live notes and self-seal.
            match crate::note_nonce::read_myn_content_nonce(bytes) {
                Some(n) if n == c.content_nonce => {
                    if live_note_ids.contains(&c.id) {
                        // Deferred live pull (task 7): the open session is the single
                        // durable writer, so do NOT write the pulled bytes; hand the
                        // verified bytes back for the caller to merge into the session
                        // (remove-wins) after the cycle. The baseline nonce rides along
                        // so a fallback write can re-apply the same dirty-disk check.
                        deferred_live_pulls.push((c.id, bytes.to_vec(), baseline_nonce.clone()));
                    } else {
                        match apply_pulled_note_blob(
                            io,
                            notes_dir,
                            &c.id,
                            bytes,
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
                                        doc_heads_hex: Vec::new(),
                                    },
                                );
                                pulled += 1;
                                // …and reported by id, so the cycle boundary can put it
                                // in the full-text index. The orchestrator holds no
                                // `Hooks` (it is deliberately `AppHandle`-free and
                                // `sim.rs` drives it with none), so it says what it
                                // wrote rather than indexing it here.
                                pulled_note_ids.push(uuid::Uuid::from_bytes(c.id).to_string());
                                // Counted at the WRITE, not at the download: the number
                                // the user watches is notes that exist locally, and a
                                // download that then failed to land would otherwise
                                // advance a bar for work that did not happen.
                                super::progress::advance();
                            }
                            // A local save landed between the cycle-start scan and this
                            // write, the note is an unpushed local edit now; the push
                            // phase (or keep-both) owns it. No write, no baseline move.
                            PulledNoteApply::SkippedDirty => {}
                            // The store is full (task 91). END the materialisation here
                            // rather than trying every remaining record against a store
                            // that cannot take them, each attempt is a round trip and a
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
                }
                _ => {
                    pull_skipped += 1;
                }
            }
        }};
    }

    // Batch the downloads (myne#240). Per-attempt, NOT per-process: a server that
    // answers 404 costs exactly one wasted round-trip per cycle, and a server that
    // gains the route is picked up on the next cycle with no state to invalidate.
    // A global or a `OnceLock` would leak the verdict across vaults and endpoints
    // and would owe an invalidation story for endpoint change and re-enrollment.
    let mut batch_ok = true;
    let mut queue: &[&engine::ChangedBlob] = &candidates;
    while !queue.is_empty() {
        if !batch_ok {
            // Fallback: a server without the batch route. One GET per blob, the
            // pre-#240 shape, with the same per-record dispositions.
            for c in queue {
                match download_blob_backoff(transport, token, &c.id) {
                    Ok(bytes) => apply_downloaded!(c, &bytes, live_note_ids),
                    // Per-blob unavailability (unknown id / horizon-GC reclaimed
                    // body, §11.3): skip the record WITHOUT any local mutation —
                    // no write, no baseline adoption — and keep the cycle alive.
                    // Against a pre-§11.3 server the reclaimed body arrives as an
                    // empty 200 instead; the nonce guard catches that shape too.
                    Err(PullError::BlobNotFound | PullError::BlobReclaimed) => {
                        pull_skipped += 1;
                    }
                    Err(e) => return Err(SyncCycleError::Pull(e)),
                }
            }
            break;
        }
        let n = fetch_window(queue);
        let ids: Vec<[u8; 16]> = queue[..n].iter().map(|c| c.id).collect();
        let outcome = rate_limit_backoff(|| engine::download_blobs(transport, token, &ids))
            .map_err(SyncCycleError::Pull)?;
        let batch = match outcome {
            engine::BlobBatchOutcome::RouteUnsupported => {
                batch_ok = false;
                continue;
            }
            engine::BlobBatchOutcome::Served(b) => b,
        };
        // Drain the window in request order, stopping at the first id the response
        // did not account for — the response describes a PREFIX, and everything
        // from there on is simply unserved and stays queued.
        let mut served = 0usize;
        for c in &queue[..n] {
            match batch.outcome(&c.id) {
                Some(Ok(bytes)) => {
                    served += 1;
                    let bytes = bytes.to_vec();
                    apply_downloaded!(c, &bytes, live_note_ids);
                }
                // Same disposition as the single route's 404/410, plus `internal`
                // and any code this client does not know: skip without mutating.
                Some(Err(_)) => {
                    served += 1;
                    pull_skipped += 1;
                }
                None => break,
            }
        }
        // A response that accounts for NOTHING would loop this drain forever. The
        // server's side of the contract is that it accounts for at least the first
        // requested id; a server that does not is one this client cannot talk to.
        if served == 0 {
            super::progress::finish();
            return Err(SyncCycleError::Pull(PullError::BadResponse));
        }
        queue = &queue[served..];
        // Checkpoint the adopted baselines per window — the mirror of the push
        // side's per-chunk checkpoint (myne#222). Without it a cycle that dies
        // mid-drain leaves the notes it wrote on disk with NO recorded baseline,
        // and the push-detect phase then queues them at base_version 0, collects
        // a 409 blob_stale and aborts that chunk and every chunk behind it. The
        // "persist only on success" rule this appears to bend is about a
        // half-advanced CURSOR reaching disk; `pull_to_stable` has already
        // returned a stable page by here, and `state.cursor` still moves only
        // below, after the whole loop.
        write_sync_state(io, vault_root, state)
            .await
            .map_err(|_| SyncCycleError::Io)?;
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
            .filter(|m| {
                m.attachment_id.is_none()
                    && Some(m.id) != cat_id
                    && m.id != prefs_id
                    && m.id != themes_id
                    && Some(m.id) != names_id
                    && Some(m.id) != chats_catalog_id
                    && !chats_scan.contains_key(&m.id)
            })
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
    // the blob CAS (409 blob_stale), which aborts the chunk they travel in and
    // abandons every chunk queued behind it. They MUST stay
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
    // Heads (the ASM-5 convergence marker) to record for each `NC05` note this
    // cycle pushes — read at the push-result recording below, in place of the
    // `Vec::new()` a `MY01` blob records. Keyed by note id.
    let mut nc05_push_heads: HashMap<[u8; 16], Vec<String>> = HashMap::new();
    if gate.allows_content() {
        for (id, nonce) in &local2 {
            let id_hex = hex(id);
            let nonce_hex = hex(nonce);
            // Cloned, not borrowed: the `NC05` convergence branch below re-inserts
            // into `state.blobs` (adopts a re-serialized note's new nonce without a
            // push), which a live `&` borrow of the map would forbid.
            let synced = state.blobs.get(&id_hex).cloned();
            if synced.as_ref().map(|b| b.content_nonce_hex.as_str()) == Some(nonce_hex.as_str()) {
                continue; // already in sync
            }
            // Unresolved staged conflict (see above): never push, never re-stage.
            if pending_conflicts.contains(&id_hex) {
                continue;
            }
            // A queued deletion pushes as a tombstone and never merges (there is no
            // content to converge). Its flag also gates the CRDT dispatch off.
            let is_tombstoning = pending_tombstones.contains(&id_hex);
            // The note keys for the `NC05` path — present only when this cycle
            // carries them (`attachment_keys`, which notes share) AND it is not a
            // pending deletion. `None` ⇒ the unchanged `MY01` behavior below. The
            // local blob is read LAZILY inside each `NC05` branch (never at the top
            // of the loop) so a note that ends up keep-both or reclaimed — paths
            // that never touch the local content — is not read at all, matching the
            // pre-CRDT flow: hoisting the read aborted the whole cycle when such a
            // note's blob was absent, before the attachment push could run.
            let crdt_keys = if is_tombstoning {
                None
            } else {
                attachment_keys
            };

            // True conflict: this note is locally dirty AND the server advanced it
            // past our synced baseline (a concurrent remote edit). For `MY01` this
            // is keep-both (pushing a stale `base_version` loses the CAS and wedges
            // the chunk); for `NC05` it is an automatic causal MERGE (ASM-9) — the
            // whole point of the migration.
            if let Some(b) = &synced {
                if let Some((server_version, remote_nonce)) = server_meta.get(id) {
                    if *server_version > b.version {
                        // Download the remote revision once (shared by both arms).
                        let remote_bytes = download_blob_backoff(transport, token, id).ok();
                        // `NC05` ⟷ `NC05` → merge, then push the merged blob at the
                        // server's current version so the CAS lands. A magic
                        // mismatch (local `NC05` vs remote `MY01`, mid-migration, or
                        // an undecryptable/corrupt remote) falls through to keep-both
                        // — never a silent cross-type merge (ASM-9).
                        // The merge needs the LOCAL blob — read it HERE, only when
                        // the remote is a live `NC05` revision (a `MY01` conflict, a
                        // non-CRDT/undecodable remote, or a locally-absent blob all
                        // fall through to keep-both without a mandatory read, so an
                        // absent-blob keep-both never aborts the cycle).
                        let local_ct = match (crdt_keys, remote_bytes.as_ref()) {
                            (Some(_), Some(remote))
                                if crate::plugins::notes::crdt::is_nc05_blob(remote) =>
                            {
                                io.read(&blob_path(notes_dir, id)).await.ok()
                            }
                            _ => None,
                        };
                        if let (Some(keys), Some(remote), Some(local_ct)) =
                            (crdt_keys, remote_bytes.as_ref(), local_ct.as_ref())
                        {
                            if crate::plugins::notes::crdt::is_nc05_blob(local_ct) {
                                if let Ok(merge) =
                                    crate::plugins::notes::crdt::merge_crdt_note_blobs(
                                        local_ct,
                                        remote,
                                        keys.items_key,
                                        keys.items_key_id,
                                        id,
                                    )
                                {
                                    // The winning blob's own header nonce (the value
                                    // the server records + peers verify).
                                    if let Some(merged_nonce) =
                                        crate::note_nonce::read_myn_content_nonce(&merge.blob)
                                    {
                                        use crate::plugins::notes::crdt::CrdtMergeResolution as R;
                                        // A delete-vs-edit is resolved remove-wins,
                                        // NOT by the text merge (myne#431). The three
                                        // arms differ in what has to happen next, so
                                        // they are spelled out rather than folded.
                                        if merge.resolution == R::LocalTombstoneWins {
                                            // Our tombstone wins: the blob on disk is
                                            // already the winner (untouched), so only
                                            // the push has to happen — at the server's
                                            // version, so the CAS lands over the
                                            // remote edit. No `pulled`/`merged` signal:
                                            // nothing local changed and a deletion is
                                            // not an "updated from another device".
                                            //
                                            // Pushed WITHOUT the tombstone flag: that
                                            // flag governs only server-side horizon-GC,
                                            // and the `deleted:` field is what actually
                                            // propagates the deletion (§11.1). The
                                            // `pending-tombstones` queue owns the flag;
                                            // a note reaching this branch is not on it.
                                            nc05_push_heads.insert(*id, merge.heads);
                                            to_push.push(PushBlob {
                                                id: *id,
                                                base_version: *server_version,
                                                content_nonce: merged_nonce,
                                                ciphertext: merge.blob,
                                                tombstone: false,
                                                attachment_id: None,
                                            });
                                            continue;
                                        }
                                        // Persist the winning blob locally — for a
                                        // merge it supersedes the divergent local copy
                                        // (no edit lost: the merge contains both); for
                                        // a remote tombstone it IS the deletion,
                                        // adopted verbatim.
                                        io.write(
                                            &blob_path(notes_dir, id),
                                            &merge.blob,
                                            crate::vault_io::WriteOpts::default(),
                                        )
                                        .await
                                        .map_err(|_| SyncCycleError::Io)?;
                                        // The local content changed → re-index +
                                        // re-read into the open editor.
                                        // `pulled_note_ids` drives the re-index/
                                        // re-read; `remote_merged_note_ids` is the
                                        // DISTINCT ASM-6/#422 "updated from another
                                        // device" signal the calm hint fires on (a
                                        // merge that reconciled a concurrent remote
                                        // edit — not a plain server-wins pull, and
                                        // never a deletion: "updated from another
                                        // device" over a note that just disappeared
                                        // is the wrong sentence).
                                        let id_str = uuid::Uuid::from_bytes(*id).to_string();
                                        pulled_note_ids.push(id_str.clone());
                                        if merge.resolution == R::Merged {
                                            remote_merged_note_ids.push(id_str);
                                            nc05_push_heads.insert(*id, merge.heads);
                                            to_push.push(PushBlob {
                                                id: *id,
                                                base_version: *server_version,
                                                content_nonce: merged_nonce,
                                                ciphertext: merge.blob,
                                                tombstone: false,
                                                attachment_id: None,
                                            });
                                        } else {
                                            // `RemoteTombstoneWins`: the server already
                                            // holds exactly these bytes, so pushing
                                            // them back would be a no-op revision that
                                            // churns the version counter. Adopt its
                                            // (version, nonce) as the baseline instead,
                                            // which is what stops the next cycle
                                            // re-detecting this note as dirty.
                                            state.blobs.insert(
                                                id_hex.clone(),
                                                BlobSyncState {
                                                    version: *server_version,
                                                    content_nonce_hex: hex(&merged_nonce),
                                                    doc_heads_hex: merge.heads,
                                                },
                                            );
                                        }
                                        continue;
                                    }
                                }
                            }
                        }
                        // `MY01` (or a fallen-through `NC05`): stage the remote
                        // revision so the notes layer can materialize a keep-both
                        // copy; the local edit stays on disk untouched.
                        if let Some(remote) = &remote_bytes {
                            let _ = stage_conflict(
                                io,
                                vault_root,
                                id,
                                *server_version,
                                remote_nonce,
                                remote,
                            )
                            .await;
                        }
                        conflicts.push(plan_note_keep_both(id, *remote_nonce));
                        continue;
                    }
                }
            }

            // No concurrent remote edit. For an `NC05` note whose on-disk
            // `content_nonce` changed, decide dirtiness by causal heads not the
            // nonce (ASM-5): a re-serialize/idempotent-merge that added nothing is
            // NOT a push — the note-level §10.2.2 ping-pong fix. Adopt the new
            // nonce into the baseline so the decryption-free fast diff stops
            // re-flagging it. A genuine edit advances the heads → push + record
            // them. (`MY01` keeps its unchanged always-push-on-nonce-change shape.)
            // Carries the convergence-probe read forward to the push read below so
            // an already-synced note (the only case that enters the block) reads
            // its blob once, not twice — the probe read and the push read hit the
            // same file. Stays `None` for a new note (`synced.is_none()`), whose
            // read is paid lazily at the bottom.
            let mut local_ct_for_push: Option<Vec<u8>> = None;
            if let (Some(keys), Some(b)) = (crdt_keys, synced.as_ref()) {
                // Read the local blob to decide NC05 dirtiness by causal heads.
                // Absence is tolerated here (fall through to the push read below,
                // which reports it) and a `MY01` blob simply is not an NC05 note.
                if let Ok(local_ct) = io.read(&blob_path(notes_dir, id)).await {
                    if crate::plugins::notes::crdt::is_nc05_blob(&local_ct) {
                        if let Ok((dirty, heads)) = crate::plugins::notes::crdt::nc05_convergence(
                            &local_ct,
                            &b.doc_heads_hex,
                            keys.items_key,
                            keys.items_key_id,
                            id,
                        ) {
                            if !dirty {
                                state.blobs.insert(
                                    id_hex.clone(),
                                    BlobSyncState {
                                        version: b.version,
                                        content_nonce_hex: nonce_hex.clone(),
                                        doc_heads_hex: heads,
                                    },
                                );
                                continue;
                            }
                            nc05_push_heads.insert(*id, heads);
                        }
                    }
                    // The bytes we just read ARE the push payload (only the
                    // `!dirty` arm above short-circuits, and it `continue`d).
                    // Reuse them so the push read below is skipped.
                    local_ct_for_push = Some(local_ct);
                }
            }

            // F4 fresh-cursor probe (§11.3): a re-enrolled device (wiped sync
            // state, cursor 0 → floor-exempt, no 410/reconcile) holding a local
            // copy of a RECLAIMED record would push it at `base_version 0` —
            // the CAS loses against the tombstone's final version and takes its
            // whole chunk down with it, and every chunk behind it, every cycle,
            // forever. Probe the blob
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
            // Read the local blob for the push — LAZILY, exactly here, so a note
            // that hit keep-both / convergence-adopt / reclaim above (all of which
            // `continue`) never reads it, and only a genuine push pays the read.
            // An already-synced note read it once for the convergence probe above;
            // reuse those bytes rather than reading the same file twice.
            let ciphertext = match local_ct_for_push {
                Some(ct) => ct,
                None => io
                    .read(&blob_path(notes_dir, id))
                    .await
                    .map_err(|_| SyncCycleError::Io)?,
            };
            to_push.push(PushBlob {
                id: *id,
                base_version: synced.as_ref().map(|b| b.version).unwrap_or(0),
                content_nonce: *nonce,
                ciphertext,
                // A deletion the notes layer queued → flag it so the server marks
                // it for horizon-GC (the `deleted:` field still propagates either
                // way; the flag only governs server-side reclamation).
                tombstone: is_tombstoning,
                attachment_id: None,
            });
        }
    }

    // --- detect attachment + catalog pushes (MYND-468) ---
    // Byte-uploads happen HERE, before ANY of the `/sync/push` chunks below, so
    // any head the server accepts only ever commits attachment bytes already
    // durably stored (SYNC-5 blobs-first-then-head, extended to attachments).
    let mut attachments_pushed = 0usize;
    let mut pushed_att_tombstones: HashSet<[u8; 32]> = HashSet::new();
    let mut pushed_chats_tombstones: Vec<[u8; 16]> = Vec::new();
    let mut pushed_memory_tombstones: Vec<[u8; 16]> = Vec::new();
    if gate.allows_content() {
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
                // the push (it would 409 its chunk and abandon the rest); the
                // next pull adopts the server's bytes.
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
            // The bytes come from the PHASE (myne#436), which verified them
            // (myne#301 — pushing a torn slot publishes an empty theme store to
            // every peer) under the generation-correct KEK it had already
            // derived. Re-reading here meant re-deriving, and that copy drifted
            // to v0.1 while the phase went version-aware, so a migrated vault
            // silently stopped publishing theme edits. One derivation, one
            // reader, no second opinion to keep in sync.
            if let Some(bytes) = themes_phase.push_bytes.take() {
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

        // A dirty member-names store (local-only change, or a merge that beat the
        // server's store) rides the same batch (task 3b-ii). Same single-derivation
        // discipline as themes (myne#436): the bytes come from the phase, never
        // re-derived here, and a nonce read that fails skips rather than pushing
        // empty (the merge arm decides, not this one).
        if names_phase.dirty {
            if let (Some(bytes), Some(nid)) = (names_phase.push_bytes.take(), names_id) {
                if let Some(nonce) = read_member_names_nonce(&bytes) {
                    let base = state.blobs.get(&hex(&nid)).map(|b| b.version).unwrap_or(0);
                    to_push.push(PushBlob {
                        id: nid,
                        base_version: base,
                        content_nonce: nonce,
                        ciphertext: bytes,
                        tombstone: false,
                        attachment_id: None,
                    });
                }
            }
        }

        // A dirty device-binding store rides the same batch (member-devices task 3).
        // The common case is a claim this device wrote at unlock and has not yet
        // published, which is exactly what makes an offline claim reconcile on the next
        // cycle with nothing user-visible happening. Same single-derivation discipline as
        // themes (myne#436): the bytes come from the phase, never re-derived here.
        if bindings_phase.dirty {
            if let (Some(bytes), Some(bid)) = (bindings_phase.push_bytes.take(), bindings_id) {
                if let Some(nonce) = read_device_bindings_nonce(&bytes) {
                    let base = state.blobs.get(&hex(&bid)).map(|b| b.version).unwrap_or(0);
                    to_push.push(PushBlob {
                        id: bid,
                        base_version: base,
                        content_nonce: nonce,
                        ciphertext: bytes,
                        tombstone: false,
                        attachment_id: None,
                    });
                }
            }
        }

        // A dirty chats catalog (local-only change, or a merge that beat the
        // server's store) rides the same batch as an inline blob
        // (myne-md/myne#675). Same single-derivation discipline as themes
        // (myne#436): the bytes come from the phase, never re-derived here.
        if chats_phase.dirty {
            if let (Some(bytes), Some(cid)) = (chats_phase.push_bytes.take(), chats_catalog_id) {
                if let Some(nonce) = read_chats_catalog_nonce(&bytes) {
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

        // Changed conversation files ride the same batch as inline blobs
        // (the notes twin: conversation-id sync blob-id, content_nonce from
        // the on-disk header, base_version from the recorded CAS base). A
        // conversation whose catalog row is a tombstone is NEVER pushed here
        // (the delete propagates through the catalog tombstone; pushing the
        // file would resurrect content against its own tombstone). A file
        // that fails its nonce read is skipped (report-don't-empty: the
        // merge arm decides, not the push arm).
        if gate.allows_content() {
            for (conv_hex, _) in chats_phase.merged.iter().filter(|(_, e)| e.is_live()) {
                let Some(conv_id) = from_hex16(conv_hex) else {
                    // The catalog is canonical JSON from our own writer; a
                    // malformed id is a schema violation, not a push.
                    continue;
                };
                let synced = state.blobs.get(conv_hex).cloned();
                // The skip decision reads the CURRENT on-disk file, never
                // the pre-guard `chats_scan` snapshot: a chats command may
                // have rewritten (or created) the file after the scan, and
                // trusting the snapshot would judge a mutated file "already
                // in sync" and hold its turns for a cycle behind a catalog
                // row that did push. Iterating the merged roster (fresh from
                // under the guard) rather than the scan closes the same hole
                // for files created after the scan.
                let Ok(bytes) = io.read(&chats_dir(vault_root).join(conv_hex)).await else {
                    // Absent (deletion propagation erased it) or unreadable
                    // (the merge arm decides, not the push arm): skip.
                    continue;
                };
                let Some(file_nonce) = read_chats_blob_nonce(&bytes) else {
                    continue;
                };
                if synced.as_ref().map(|b| b.content_nonce_hex.as_str())
                    == Some(hex(&file_nonce).as_str())
                {
                    continue; // already in sync
                }
                // A concurrent remote edit past our synced baseline: the
                // conversation phase merged and wrote it already, and the
                // bytes above are the merged file's. Push it with the
                // server's current version as the CAS base.
                let base_version = if let Some(b) = &synced {
                    if let Some((server_version, _)) = server_meta.get(&conv_id) {
                        if *server_version > b.version {
                            *server_version
                        } else {
                            b.version
                        }
                    } else {
                        b.version
                    }
                } else {
                    0
                };
                to_push.push(PushBlob {
                    id: conv_id,
                    base_version,
                    content_nonce: file_nonce,
                    ciphertext: bytes,
                    tombstone: false,
                    attachment_id: None,
                });
            }

            // Queued conversation deletions → blob-plane tombstone records. A
            // queued id whose catalog row is live again is a STALE tombstone
            // (re-created after delete): dropped, never pushed. An id with no
            // synced baseline has no server-side record to reclaim (the
            // migration rule): dropped. Otherwise the empty-ciphertext record
            // marks the server copy deleted so horizon-GC reclaims it; without
            // this the catalog tombstone erases every device copy while the
            // server ciphertext is orphaned permanently.
            let mut stale_chats: Vec<[u8; 16]> = Vec::new();
            for t in
                crate::plugins::chats::commands::read_pending_chats_tombstones(io, vault_root).await
            {
                let live_again = chats_phase
                    .merged
                    .get(&hex(&t.conv_id))
                    .map(|e| e.is_live())
                    .unwrap_or(false);
                let Some(baseline) = state.blobs.get(&hex(&t.conv_id)) else {
                    stale_chats.push(t.conv_id);
                    continue;
                };
                if live_again {
                    stale_chats.push(t.conv_id);
                    continue;
                }
                to_push.push(PushBlob {
                    id: t.conv_id,
                    base_version: baseline.version,
                    content_nonce: t.content_nonce,
                    ciphertext: Vec::new(),
                    tombstone: true,
                    attachment_id: None,
                });
                pushed_chats_tombstones.push(t.conv_id);
            }
            let _ = crate::plugins::chats::commands::clear_pending_chats_tombstones(
                io,
                vault_root,
                &stale_chats,
            )
            .await;
        }

        // --- memory plane push (myne-md/myne#697) ---
        // Gated with the pull half: `memory_phase` is `None` when the opt-in
        // is off and nothing for these ids rides the batch. Otherwise the
        // dirty catalog, the dirty personality singleton, and the changed
        // entry files ride the same batch as inline blobs (the chats shape:
        // conversation-id sync blob-id, content_nonce from the on-disk
        // header, base_version from the recorded CAS base). An entry whose
        // catalog row is a tombstone is NEVER pushed here (the delete
        // propagates through the catalog tombstone; pushing the file would
        // resurrect content against its own tombstone). A SKIPPED phase
        // (refused store, myne-md/myne#697) pushes nothing: with `merged`
        // empty every queued id reads "not live again" and a re-created
        // entry's server copy would be tombstoned.
        if let Some(memory_phase) = memory_phase.as_mut().filter(|p| !p.skipped) {
            let mid = memory_catalog_id.expect("catalog id set whenever the phase ran");
            if memory_phase.dirty {
                if let Some(bytes) = memory_phase.push_bytes.take() {
                    if let Some(nonce) = read_agent_memory_catalog_nonce(&bytes) {
                        let base = state.blobs.get(&hex(&mid)).map(|b| b.version).unwrap_or(0);
                        to_push.push(PushBlob {
                            id: mid,
                            base_version: base,
                            content_nonce: nonce,
                            ciphertext: bytes,
                            tombstone: false,
                            attachment_id: None,
                        });
                    }
                }
            }
            if let Some(personality_phase) = personality_phase.as_mut() {
                let pid = personality_id.expect("personality id set whenever the phase ran");
                if personality_phase.dirty {
                    if let Some(bytes) = personality_phase.push_bytes.take() {
                        if bytes.is_empty() {
                            // Local clear of a previously-synced personality:
                            // the delete rides the batch as a tombstone against
                            // the last synced nonce, or peers keep the old blob
                            // and the next pull resurrects it (myne-md/myne#697).
                            let base = state.blobs.get(&hex(&pid)).map(|b| b.version).unwrap_or(0);
                            let nonce = state
                                .blobs
                                .get(&hex(&pid))
                                // Lenient: `state.blobs` records the nonce as the
                                // SERVER last served it, so its case is not this
                                // client's to fix (R1.2).
                                .and_then(|b| protocol::hex::decode_ci::<24>(&b.content_nonce_hex));
                            if let Some(content_nonce) = nonce {
                                to_push.push(PushBlob {
                                    id: pid,
                                    base_version: base,
                                    content_nonce,
                                    ciphertext: Vec::new(),
                                    tombstone: true,
                                    attachment_id: None,
                                });
                            }
                        } else if let Some(nonce) = read_personality_nonce(&bytes) {
                            let base = state.blobs.get(&hex(&pid)).map(|b| b.version).unwrap_or(0);
                            to_push.push(PushBlob {
                                id: pid,
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
            if gate.allows_content() {
                for (entry_hex, _) in memory_phase.merged.iter().filter(|(_, e)| e.is_live()) {
                    let Some(entry_id) = from_hex16(entry_hex) else {
                        continue;
                    };
                    let synced = state.blobs.get(entry_hex).cloned();
                    // The skip decision reads the CURRENT on-disk file, never
                    // the pre-guard `memories_scan` snapshot (the conversation
                    // loop's hole, same fix).
                    let Ok(bytes) = io.read(&memories_dir(vault_root).join(entry_hex)).await else {
                        continue;
                    };
                    let Some(file_nonce) = read_agent_memory_blob_nonce(&bytes) else {
                        continue;
                    };
                    if synced.as_ref().map(|b| b.content_nonce_hex.as_str())
                        == Some(hex(&file_nonce).as_str())
                    {
                        continue; // already in sync
                    }
                    let base_version = if let Some(b) = &synced {
                        if let Some((server_version, _)) = server_meta.get(&entry_id) {
                            if *server_version > b.version {
                                *server_version
                            } else {
                                b.version
                            }
                        } else {
                            b.version
                        }
                    } else {
                        0
                    };
                    to_push.push(PushBlob {
                        id: entry_id,
                        base_version,
                        content_nonce: file_nonce,
                        ciphertext: bytes,
                        tombstone: false,
                        attachment_id: None,
                    });
                }

                // Queued entry deletions → blob-plane tombstone records. A
                // queued id whose catalog row is live again is a STALE
                // tombstone (re-created after delete): dropped, never pushed.
                // An id with no synced baseline has no server-side record to
                // reclaim (the migration rule): dropped. Otherwise the
                // empty-ciphertext record marks the server copy deleted so
                // horizon-GC reclaims it.
                let mut stale_memories: Vec<[u8; 16]> = Vec::new();
                // A corrupt or unreadable queue fails the cycle rather than
                // draining half a reclaim set: the reader refuses instead of
                // truncating, so there is no partial-drain shape to handle.
                let queued = crate::plugins::memory::commands::read_pending_memory_tombstones(
                    io, vault_root,
                )
                .await
                .map_err(|_| SyncCycleError::Io)?;
                for q in queued {
                    let live_again = memory_phase
                        .merged
                        .get(&hex(&q.entry_id))
                        .map(|e| e.is_live())
                        .unwrap_or(false);
                    let Some(baseline) = state.blobs.get(&hex(&q.entry_id)) else {
                        stale_memories.push(q.entry_id);
                        continue;
                    };
                    if live_again {
                        stale_memories.push(q.entry_id);
                        continue;
                    }
                    to_push.push(PushBlob {
                        id: q.entry_id,
                        base_version: baseline.version,
                        content_nonce: q.content_nonce,
                        ciphertext: Vec::new(),
                        tombstone: true,
                        attachment_id: None,
                    });
                    pushed_memory_tombstones.push(q.entry_id);
                }
                let _ = crate::plugins::memory::commands::clear_pending_memory_tombstones(
                    io,
                    vault_root,
                    &stale_memories,
                )
                .await;
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
    // A re-key re-base MUST author a head even with nothing to push (#429): the
    // stale-generation head is the thing being replaced, and waiting for an edit
    // would leave the vault head unopenable — and this device's own sync
    // wedged — until the user happens to type something.
    let rebasing = page.unverifiable_head_id.is_some();
    // The genesis carve-out is the §6.1 GENESIS-ON-EMPTY push, and `local2` being
    // empty is what makes that true rather than merely intended.
    //
    // Without the corpus check the exemption was strictly wider than the spec
    // bullet it implements: a device with notes on disk and no head yet (account
    // created, corpus written, the first coalesced push not yet due) would, DURING
    // a compare, publish a `vault-head-mac`-authenticated head whose
    // `manifest_hash` is taken from `local2` while `to_push` is empty, because
    // both content blocks sit behind `gate.allows_content()`. That head commits
    // `content_nonce`s for blobs the server does not hold, which is the SYNC-5
    // ordering this very function states as its invariant a few lines down, and a
    // peer pulling in that window cannot tell an over-claiming author from a
    // withholding server. The joining device pulls in exactly that window.
    let genesis_on_empty = gate.allows_genesis() && page.head.is_none() && local2.is_empty();
    if !to_push.is_empty() || genesis_on_empty || rebasing {
        // Author a linear-advance head over the current (post-pull) head: bump
        // this device's VV component, seq+1, parent = the server's current head
        // (genesis = the zero prev the server's first-head CAS expects).
        //
        // On a re-base the parent is the id of the head we could not open. The
        // server's head CAS compares `SHA-256(record)`, which is keyless, so the
        // advance lands even though nothing in the old head was readable — the
        // new generation starts from a fresh VV and `seq`, because an unopened
        // head contributes neither.
        let prev_head_id: [u8; 32] = page
            .head
            .as_ref()
            .map(|h| h.head_id)
            .or(page.unverifiable_head_id)
            .unwrap_or([0u8; 32]);
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
        let prev_head_hash = if page.head.is_some() || rebasing {
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
        let mut head_rng = rand_core::UnwrapErr(crate::rng::OsRng);
        let sealed = head_authority
            .seal(&head, &mut head_rng)
            .map_err(|_| SyncCycleError::Head)?;

        // --- push, in bounded chunks (myne-md/myne#222) ---
        //
        // One `/sync/push` per chunk, and the **head rides the last one**. That is
        // what keeps SYNC-5 blobs-first-then-head intact with no protocol change:
        // the head the server accepts still commits only blobs it already holds,
        // exactly as when the whole corpus travelled in one request. `engine::push`
        // already takes `new_head: Option<…>`, so an intermediate chunk passes `None`
        // and the server treats it as a blobs-only push.
        //
        // A cycle that dies partway now leaves the landed chunks landed AND recorded
        // (the checkpoint below), so the next cycle resumes instead of re-sending
        // everything from an empty baseline forever — the wedge in #222.
        //
        // `to_push` empty is NOT a no-op here: the enclosing `if` also fires for the
        // genesis head of an account with no local changes, so the loop must run once
        // over an empty slice to send that head-only push.
        let chunks = push_chunks(&to_push);
        for (i, chunk) in chunks.iter().enumerate() {
            let is_last = i + 1 == chunks.len();
            let outcome = engine::push(
                transport,
                token,
                chunk,
                is_last.then_some((&prev_head_id, &sealed.record)),
            )
            .map_err(SyncCycleError::Push)?;

            for (id, ver) in &outcome.results {
                if let Some(b) = chunk.iter().find(|b| &b.id == id) {
                    state.blobs.insert(
                        hex(id),
                        BlobSyncState {
                            version: *ver,
                            content_nonce_hex: hex(&b.content_nonce),
                            // The ASM-5 convergence marker for an `NC05` note that
                            // this cycle sealed (an edit or a merge); empty for
                            // `MY01` and for singletons/attachments, which have no
                            // Automerge heads. The next cycle diffs current heads
                            // against this to decide dirtiness without a push.
                            doc_heads_hex: nc05_push_heads.get(id).cloned().unwrap_or_default(),
                        },
                    );
                }
            }
            pushed += outcome.results.len();
            head_advanced |= outcome.head_id.is_some();
            // The re-based head landed → the exemption is spent (#429). Cleared
            // HERE, on the server's acknowledgement, rather than optimistically
            // when the migration set it: a re-base that never reached the server
            // must stay pending, or the next cycle reads the stale-generation
            // head as a forgery again and this time raises the alarm.
            if rekey_rebase && outcome.head_id.is_some() {
                // The other root-derived sync artefact (#429(e)): the SCRAM
                // secret is `derive_subkey(root_key, ServerAuth)`, so the re-key
                // invalidated the account's verifier too. `/auth/register` is
                // first-write-only and 409s, so the replace goes through the
                // authed route — HERE, while this cycle's token is provably
                // still valid, because that is the only window in which the
                // client can still authenticate at all. Left undone, nothing
                // looks wrong until the token expires or a new device enrols,
                // and then every handshake 401s permanently.
                //
                // Owner-only: a member holds no `root_key` and never sets
                // `rekey_rebase_pending` (group rotation is not a root re-key).
                if let Some(root_key) = root_key {
                    let new_secret = derive_subkey(root_key, SubkeyRole::ServerAuth);
                    let replaced = super::enroll::replace_verifier(
                        transport,
                        token,
                        &account_number_hash,
                        new_secret.as_slice(),
                    )
                    .is_ok();
                    // Both legs or neither: a head that landed with a stale verifier
                    // still leaves the account unreachable later, and clearing the
                    // flag would spend the one retry the next cycle has.
                    if replaced {
                        state.rekey_rebase_pending = false;
                    } else {
                        tracing::warn!(
                            stage = "rekey_rebase",
                            event = "verifier_replace_failed",
                            "the re-based head landed but the SCRAM verifier did not; retrying next cycle"
                        );
                    }
                }
            }
            // The prefs push landed → its shared-subset hash is the new push-gate
            // baseline (MYND-478, §10.2.1).
            if outcome.results.iter().any(|(id, _)| *id == prefs_id) {
                set_prefs_gate_baseline(vault_root, prefs_phase.shared_hash.clone());
            }
            // The queued tombstones are now flagged on the server → drop them from the
            // device-local queue so they aren't re-flagged every cycle.
            let pushed_tombstones: Vec<String> = chunk
                .iter()
                .filter(|b| b.tombstone)
                .map(|b| hex(&b.id))
                .collect();
            tombstones_pushed += pushed_tombstones.len();
            let _ = clear_pending_tombstones(io, vault_root, &pushed_tombstones).await;
            // Checkpoint. The versions this chunk returned are a fact about the
            // server; a later chunk failing must not un-learn them (see the
            // `run_sync_cycle` doc for why this does not contradict the
            // persist-on-success rule). Propagated rather than swallowed: a device
            // that cannot record what it just pushed is about to rebuild the #222
            // wedge, and it should say so instead of silently looping.
            write_sync_state(io, vault_root, state)
                .await
                .map_err(|_| SyncCycleError::Io)?;
        }
        // The attachment-tombstone queue drains only after its records landed.
        let _ = clear_pending_attachment_tombstones(io, vault_root, &pushed_att_tombstones).await;
        // Same for the conversation-tombstone queue: records that rode the
        // content push are dropped so they are not re-flagged every cycle.
        // (A failed cycle returns before this point, so the queue is kept.)
        let _ = crate::plugins::chats::commands::clear_pending_chats_tombstones(
            io,
            vault_root,
            &pushed_chats_tombstones,
        )
        .await;
        // Same for the entry-tombstone queue: records that rode the content
        // push are dropped so they are not re-flagged every cycle.
        let _ = crate::plugins::memory::commands::clear_pending_memory_tombstones(
            io,
            vault_root,
            &pushed_memory_tombstones,
        )
        .await;
        // The blobs a re-key stranded (#443). Deliberately AFTER the content
        // push and in a request of its own — see `drain_orphan_tombstones` for
        // why mixing them in could wedge every future push cycle.
        let reclaimed = drain_orphan_tombstones(transport, token, state).await;
        if reclaimed > 0 {
            tracing::info!(
                stage = "orphan_tombstones",
                event = "reclaimed",
                count = reclaimed,
                "marked the re-key's stranded singleton blobs for horizon-GC"
            );
        }
        write_head_baseline(io, vault_root, &sealed, head_authority.expected_format())
            .await
            .map_err(|_| SyncCycleError::Io)?;
        state.record_observation(&sealed.head_id, &version_vector);
    } else if let Some(vh) = &page.head {
        // No local changes: adopt the pulled head as the new baseline, storing
        // the PULLED record verbatim. Re-sealing the decoded head would be wrong
        // for a signed (`0x02`) head, whose ML-DSA half is randomized.
        let sealed = SealedHead {
            record: vh.record.clone(),
            head_id: vh.head_id,
        };
        write_head_baseline(io, vault_root, &sealed, head_authority.expected_format())
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
        chats_applied_remote: chats_phase.applied_remote,
        memory_entries_pulled: entries_pulled,
        memory_applied_remote: memory_phase
            .as_ref()
            .map(|p| p.applied_remote)
            .unwrap_or(false),
        personality_applied_remote: personality_phase
            .as_ref()
            .map(|p| p.applied_remote)
            .unwrap_or(false),
        member_names_applied_remote: names_phase.applied_remote,
        device_bindings_applied_remote: bindings_phase.applied_remote,
        pull_skipped,
        dropped,
        pulled_note_ids,
        remote_merged_note_ids,
        deferred_live_pulls,
    })
}

#[cfg(test)]
mod tests {
    /// The enrollment seed withholds the consent and the AI switch, and nothing
    /// else.
    ///
    /// Both directions, because the first half alone passes against a function
    /// that clears the whole view: what a seed is FOR is adopting the server's
    /// preferences, so a carve-out that took more than its two fields would be a
    /// different defect wearing this one's fix.
    #[test]
    fn the_enrollment_seed_withholds_exactly_two_fields() {
        let mut seeded = protocol::PrefsView {
            ai_provider_consent: Some("openrouter".into()),
            ai_enabled: true,
            ai_provider: Some("openrouter".into()),
            daily_folder: Some("Daily/".into()),
            ..Default::default()
        };

        withhold_from_enrollment_seed(&mut seeded);

        assert_eq!(
            seeded.ai_provider_consent, None,
            "an inherited consent is a device sending before anyone at it saw the screen"
        );
        assert!(!seeded.ai_enabled, "the other half of the same gate");
        assert_eq!(
            seeded.ai_provider,
            Some("openrouter".into()),
            "the provider is adopted: naming one is not permission to send to it"
        );
        assert_eq!(
            seeded.daily_folder,
            Some("Daily/".into()),
            "every other preference is adopted, which is what a seed is for"
        );
    }
    use super::*;
    use crate::plugins::notes::note_id::NoteId;
    use crate::plugins::sync::enroll::{self, EnrollPath};
    use crate::plugins::sync::transport::{
        HttpMethod, TransportError, TransportResponse, BLOB_BATCH_PATH,
    };
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
        // Still a bool here, and converted below. The ~80 existing scenarios say
        // "this is a push cycle" / "this is a poll cycle" and mean exactly that;
        // rewriting each to name a `PushGate` would be churn with no reader
        // benefit. The gate's third state (`VerifyHold`) is exercised by its own
        // tests, which call `run_sync_cycle` directly.
        allow_push: bool,
    ) -> Result<SyncSummary, SyncCycleError> {
        blocking(run_sync_cycle(
            &IO,
            transport,
            Some(root_key),
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(*root_key)),
            account_number_hash,
            device_id,
            token,
            notes_dir,
            vault_root,
            if allow_push {
                PushGate::Allowed
            } else {
                PushGate::PollOnly
            },
            MetaVersion::V0_1,
            None,
            None,
            &std::collections::HashSet::new(),
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
            // BOTH blob-download routes: the single one and the batch one
            // (myne-md/myne#240). Spelled out rather than left as a
            // `starts_with("/sync/blob")` prefix, which happens to catch both
            // but reads as if it only meant the single route — the same
            // accident that nearly disarmed `NonceCorruptingTransport`.
            if path.starts_with("/sync/blob?") || path == BLOB_BATCH_PATH {
                return Ok(TransportResponse {
                    status: 500,
                    body: Vec::new(),
                });
            }
            self.inner.request(method, path, body, token)
        }
    }

    /// Relays to a real transport while watching the `/sync/push` stream: records
    /// one entry per push saying whether it carried a `new_head` (the wire field is
    /// `skip_serializing_if = "Option::is_none"`, so its mere presence in the body
    /// is the answer), and optionally kills the Nth push (1-based) with a
    /// `TransportError::Network` — the shape a socket deadline produces mid-request,
    /// which is the myne-md/myne#222 failure.
    struct PushObserver {
        inner: Box<dyn SyncTransport>,
        /// One `carried_head` flag per observed push, in order.
        pushes: std::sync::Mutex<Vec<bool>>,
        /// 1-based index of the push to fail, if any.
        fail_nth: Option<usize>,
    }
    impl PushObserver {
        fn new(inner: Box<dyn SyncTransport>, fail_nth: Option<usize>) -> Self {
            Self {
                inner,
                pushes: std::sync::Mutex::new(Vec::new()),
                fail_nth,
            }
        }
        /// `(number of pushes, which of them carried the head)`.
        fn pushes(&self) -> Vec<bool> {
            self.pushes.lock().unwrap().clone()
        }
    }
    impl SyncTransport for PushObserver {
        fn request(
            &self,
            method: HttpMethod,
            path: &str,
            body: &[u8],
            token: Option<&str>,
        ) -> Result<TransportResponse, TransportError> {
            if path == "/sync/push" {
                let n = {
                    let mut seen = self.pushes.lock().unwrap();
                    let carried_head = body
                        .windows(b"\"new_head\"".len())
                        .any(|w| w == b"\"new_head\"");
                    seen.push(carried_head);
                    seen.len()
                };
                if self.fail_nth == Some(n) {
                    return Err(TransportError::Network);
                }
            }
            self.inner.request(method, path, body, token)
        }
    }

    /// Relays to a real transport while watching the blob-download stream: counts
    /// batch vs single-blob requests, the ids each batch asked for, and the 429s
    /// the server actually returned.
    ///
    /// The 429 count is the discriminating number for myne#240 and it is only
    /// observable HERE. `download_blob_backoff` swallows 429s in-cycle, so the
    /// pull loop reports success either way and `FailureClass::RateLimited` never
    /// fires — the acceptance criterion as originally filed was already green.
    /// What the change actually buys is the request count, and therefore the wall
    /// clock, which is what this decorator measures.
    struct PullObserver {
        inner: Box<dyn SyncTransport>,
        batches: std::sync::Mutex<Vec<usize>>,
        singles: std::sync::atomic::AtomicUsize,
        rate_limited: std::sync::atomic::AtomicUsize,
    }
    impl PullObserver {
        fn new(inner: Box<dyn SyncTransport>) -> Self {
            Self {
                inner,
                batches: std::sync::Mutex::new(Vec::new()),
                singles: std::sync::atomic::AtomicUsize::new(0),
                rate_limited: std::sync::atomic::AtomicUsize::new(0),
            }
        }
        /// How many ids each `POST /sync/blobs` asked for, in order.
        fn ids_per_batch(&self) -> Vec<usize> {
            self.batches.lock().unwrap().clone()
        }
        fn single_count(&self) -> usize {
            self.singles.load(std::sync::atomic::Ordering::Relaxed)
        }
        fn rate_limited(&self) -> usize {
            self.rate_limited.load(std::sync::atomic::Ordering::Relaxed)
        }
    }
    impl SyncTransport for PullObserver {
        fn request(
            &self,
            method: HttpMethod,
            path: &str,
            body: &[u8],
            token: Option<&str>,
        ) -> Result<TransportResponse, TransportError> {
            if path == BLOB_BATCH_PATH {
                // The body is this client's own serialization, so parsing it back
                // is safe here in a way PushObserver's byte-scan was not.
                let n = serde_json::from_slice::<serde_json::Value>(body)
                    .ok()
                    .and_then(|v| v["blob_ids_hex"].as_array().map(|a| a.len()))
                    .unwrap_or(0);
                self.batches.lock().unwrap().push(n);
            } else if path.starts_with("/sync/blob?") {
                self.singles
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            let resp = self.inner.request(method, path, body, token)?;
            if resp.status == 429 {
                self.rate_limited
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            Ok(resp)
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
    ///
    /// `None` → the binary isn't built and the caller self-skips — **unless
    /// this run asked for real fixtures**, in which case a missing binary is a
    /// panic naming it.
    ///
    /// **The failure mode that gate exists to prevent.** Every caller does
    /// `let Some(..) = spawn_server() else { eprintln!("SKIP …"); return; }`,
    /// and a Rust test that returns early **passes**. So the 25 server-backed
    /// tests in this file printed one line and reported `ok` on every machine
    /// and every CI run without the binary — indistinguishable, in the summary
    /// and in the exit code, from having actually run. A green line that
    /// asserted nothing is worse than a red one, and this cost a real
    /// misdiagnosis: a HEAD baseline taken to decide whether a branch had
    /// broken `attachment_readd_after_delete_revives` came back green because
    /// the worktree had no server, and the bug was already on develop
    /// (myne-md/myne#425).
    ///
    /// Same shape, and the same fix, as `engine_candle.rs::required_test_env`.
    /// Opt-in rather than default: a contributor who has not built the
    /// companion server should still get "skipped".
    fn server_binary() -> Option<PathBuf> {
        let found = if let Ok(p) = std::env::var("MYNE_E2E_SERVER") {
            let p = PathBuf::from(p);
            p.exists().then_some(p)
        } else {
            // cargo test CWD = the crate dir; the server is a sibling.
            let p = PathBuf::from("../myne-server/myne-server");
            p.exists().then_some(p)
        };
        assert!(
            found.is_some() || !crate::plugins::sync::test_fixtures::required("MYNE_TEST_REQUIRE_SERVER"),
            "MYNE_TEST_REQUIRE_SERVER=1 (or MYNE_TEST_REQUIRE_FIXTURES=1) was set, but the \
             myne-server binary is not built — this run was asked to exercise the real server \
             and cannot. Build it with `cd myne-server && go build -o myne-server ./cmd/myne-server`, \
             or point MYNE_E2E_SERVER at one."
        );
        found
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
            // `server_binary` floors a MISSING binary; this floors a binary that
            // was found and did not come up. Without it a port-file timeout under
            // load returns `None`, every caller's `else` arm prints SKIP, and the
            // run is green having asserted nothing — the myne-md/myne#425 shape
            // the sync-sim step's own comment records, reached by a different
            // route. It matters more since myne-md/myne#638 put the four
            // migrated-vault scenarios in that step.
            assert!(
                !crate::plugins::sync::test_fixtures::required("MYNE_TEST_REQUIRE_SERVER"),
                "MYNE_TEST_REQUIRE_SERVER=1 was set and the myne-server binary was found, \
                 but it did not report a port within the deadline. This run was asked to \
                 exercise the real server and cannot."
            );
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

    /// Drift lock for the three singleton discriminators: each one must be
    /// bound to BOTH of its `protocol` §10.3 registry constants, and must
    /// refuse a sibling family's magic in either generation. A re-typed literal that stopped matching would
    /// not error — `read_singleton_nonce` returns `None`, the blob reads as
    /// unchanged, and the family silently stops syncing. Nothing else in the
    /// tree compares these bytes against anything but themselves.
    #[test]
    fn singleton_discriminators_are_bound_to_the_registry_constants() {
        const NONCE: [u8; 24] = [0x7Au8; 24];

        // A 30-byte envelope head: 4-byte magic, 2 filler, then the nonce.
        fn envelope(magic: &[u8; 4]) -> Vec<u8> {
            let mut b = Vec::with_capacity(30);
            b.extend_from_slice(magic);
            b.extend_from_slice(&[0x00, 0x00]);
            b.extend_from_slice(&NONCE);
            b
        }

        // Each reader accepts BOTH of its own family's registry magics. The
        // v0.2 half is the half a migrated vault actually carries, and before
        // myne-md/myne#638 this lock covered only v0.1, which is how the same
        // defect one family over went unnoticed.
        assert_eq!(
            read_catalog_nonce(&envelope(&CATALOG_BLOB_MAGIC)),
            Some(NONCE)
        );
        assert_eq!(
            read_catalog_nonce(&envelope(&CATALOG_BLOB_V0_2_MAGIC)),
            Some(NONCE)
        );
        assert_eq!(read_prefs_nonce(&envelope(&PREFS_BLOB_MAGIC)), Some(NONCE));
        assert_eq!(
            read_prefs_nonce(&envelope(&PREFS_BLOB_V0_2_MAGIC)),
            Some(NONCE)
        );
        assert_eq!(
            read_themes_nonce(&envelope(&THEMES_BLOB_MAGIC)),
            Some(NONCE)
        );
        assert_eq!(
            read_themes_nonce(&envelope(&THEMES_BLOB_V0_2_MAGIC)),
            Some(NONCE)
        );

        // … and refuses every sibling family's, so a copy-paste that swapped
        // two of them fails here instead of quietly halting one family's sync.
        assert_eq!(read_catalog_nonce(&envelope(&PREFS_BLOB_MAGIC)), None);
        assert_eq!(read_catalog_nonce(&envelope(&THEMES_BLOB_MAGIC)), None);
        assert_eq!(read_prefs_nonce(&envelope(&CATALOG_BLOB_MAGIC)), None);
        assert_eq!(read_prefs_nonce(&envelope(&THEMES_BLOB_MAGIC)), None);
        assert_eq!(read_themes_nonce(&envelope(&CATALOG_BLOB_MAGIC)), None);
        assert_eq!(read_themes_nonce(&envelope(&PREFS_BLOB_MAGIC)), None);
        // The same, across generations: a v0.2 magic must not open a sibling
        // family's reader either.
        assert_eq!(read_catalog_nonce(&envelope(&PREFS_BLOB_V0_2_MAGIC)), None);
        assert_eq!(read_prefs_nonce(&envelope(&THEMES_BLOB_V0_2_MAGIC)), None);
        assert_eq!(read_themes_nonce(&envelope(&CATALOG_BLOB_V0_2_MAGIC)), None);

        // Short of the 30-byte nonce window: no partial read.
        let short = envelope(&CATALOG_BLOB_MAGIC);
        assert_eq!(read_catalog_nonce(&short[..29]), None);

        // The registry values themselves, spelled out once here so a change to
        // a §10.3 magic fails a test rather than silently re-keying a family.
        assert_eq!(&CATALOG_BLOB_MAGIC, b"MYC1");
        assert_eq!(&PREFS_BLOB_MAGIC, b"MYP1");
        assert_eq!(&THEMES_BLOB_MAGIC, b"MYT1");
        assert_eq!(&CATALOG_BLOB_V0_2_MAGIC, b"MYC5");
        assert_eq!(&PREFS_BLOB_V0_2_MAGIC, b"MYP5");
        assert_eq!(&THEMES_BLOB_V0_2_MAGIC, b"MYT5");
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

        let ta = crate::plugins::sync::http_transport::build_transport(&url).unwrap();
        let tb = crate::plugins::sync::http_transport::build_transport(&url).unwrap();

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
        // …and SAYS WHICH ONE (myne#305). The orchestrator holds no `Hooks`, so
        // this list is the only way the cycle boundary can put a pulled note
        // into the full-text index. An empty list here is the bug's shape: the
        // note lands on disk, nothing indexes it, and the next persist certifies
        // it as covered — permanently unsearchable across restarts.
        assert_eq!(
            pull.pulled_note_ids,
            vec![note.as_uuid().to_string()],
            "the cycle must report the id it wrote, not just a count"
        );

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
        /// How many responses this decorator actually rewrote. Asserted by the
        /// test: a decorator that silently stops corrupting turns the §11.3 guard
        /// into a test that passes having proved nothing. That is not
        /// hypothetical — the batch route (myne-md/myne#240) is caught by the old
        /// `starts_with("/sync/blob")` match, and the old top-level
        /// `v["ciphertext_b64"] = …` rewrite would have added a stray field to a
        /// batch body while leaving every real per-blob ciphertext intact.
        fired: std::sync::atomic::AtomicUsize,
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
            if resp.status != 200 {
                return Ok(resp);
            }
            let single = path.starts_with("/sync/blob?");
            let batch = path == BLOB_BATCH_PATH;
            if !single && !batch {
                return Ok(resp);
            }
            let mut v: serde_json::Value =
                serde_json::from_slice(&resp.body).expect("blob response is JSON");
            if single {
                v["ciphertext_b64"] = serde_json::Value::String(self.decoy_b64.clone());
                self.fired
                    .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            } else if let Some(entries) = v["blobs"].as_array_mut() {
                // The ciphertexts live one level down in the batch shape. Rewrite
                // each of them; a top-level assignment here would corrupt nothing.
                for e in entries.iter_mut() {
                    e["ciphertext_b64"] = serde_json::Value::String(self.decoy_b64.clone());
                    self.fired
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
            }
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
            eprintln!("SKIP corrupt_blob_nonce_forces_manifest_rescan: myne-server unavailable");
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

        let ta = crate::plugins::sync::http_transport::build_transport(&url).unwrap();
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
            inner: crate::plugins::sync::http_transport::build_transport(&url).unwrap(),
            decoy_b64,
            fired: std::sync::atomic::AtomicUsize::new(0),
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
        // The decorator must have actually rewritten something. Without this the
        // whole test degrades into "an honest download was skipped", which is
        // false, and it would still pass — the exact way a path-match change
        // could disarm the §11.3 guard in silence.
        assert!(
            tb.fired.load(std::sync::atomic::Ordering::Relaxed) > 0,
            "the corrupting decorator never fired — this test proves nothing"
        );
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
            crate::plugins::sync::http_transport::build_transport(&url)
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

    /// A member session holds no `root_key`, and its chats phase is `skipped`
    /// with an empty roster. The owner-only unwrap before the conversation loop
    /// used to run unconditionally and panicked every member cycle, which
    /// surfaced as the generic "Sync error" and pulled nothing (no notes, no
    /// prefs/name). This drives one full cycle with `root_key = None` on the
    /// group tier and asserts it runs to completion instead of unwinding.
    #[test]
    fn a_member_cycle_does_not_panic_on_the_owner_only_chats_phase() {
        use base64::Engine as _;
        use protocol::person_key::PersonKeyPair;
        use protocol::vault_head::VAULT_HEAD_FORMAT_V2;

        let (dir, notes) = fresh_vault("member-cycle");
        let account_number_hash = [0x5c; 16];
        // The member's own identity; deterministic seeds keep the test stable.
        let person = PersonKeyPair::generate_raw(&[0x11; 64], &[0x22; 32], &[0x33; 32]);
        let person_public = person.public_half();
        let ctx = SignedHeadCtx::new(person, account_number_hash, vec![person_public]);

        // The server serves a signed head so the cycle adopts it rather than
        // authoring a genesis (which would need a push route this test omits).
        let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
        let head = VaultHead {
            head_format_version: VAULT_HEAD_FORMAT_V2,
            account_number_hash,
            manifest_hash: [0u8; 32],
            seq: 1,
            prev_head_hash: Vec::new(),
            version_vector: vec![VvEntry {
                device_id: [0x99; 16],
                counter: 1,
            }],
        };
        let sealed = ctx.sign(&head, &mut rng).unwrap();
        let head_frag = (
            base64::engine::general_purpose::STANDARD.encode(&sealed.record),
            hex(&sealed.head_id),
        );

        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            200,
            pull_body_with_head("", 1, &head_frag),
        );
        // The empty page must not advance the cursor, or the engine keeps asking
        // for the next one and hits an unrouted path.
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=1",
            200,
            pull_body("", 1),
        );

        let items_key = [0x44u8; 32];
        let items_key_id = [0x55u8; 16];
        let shared = SharedSingletonKey::Group(zeroize::Zeroizing::new([0x77u8; 32]));
        let res = blocking(run_sync_cycle(
            &IO,
            &t,
            None,
            &shared,
            account_number_hash,
            [0x0a; 16],
            "tok",
            &notes,
            &dir,
            PushGate::Allowed,
            MetaVersion::V0_2,
            Some(AttachmentKeys {
                items_key: &items_key,
                items_key_id: &items_key_id,
            }),
            Some(&ctx),
            &std::collections::HashSet::new(),
        ));
        assert!(
            res.is_ok(),
            "a member cycle must run to completion, not panic on an owner-only unwrap: {res:?}"
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
                doc_heads_hex: Vec::new(),
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
                doc_heads_hex: Vec::new(),
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
                doc_heads_hex: Vec::new(),
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
    // Coverage instead: all THREE note-blob writers share `notes_write_mutex`
    // (compile-level) — this one, `note_update_with_dir`, and the §8.3 batch
    // (`note_write_batch_with_dir`, which joined them in myne#302) — and these
    // units pin the in-lock decision both ways.

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
            eprintln!(
                "SKIP push_on_device_a_pokes_device_b_over_live_sse: myne-server unavailable"
            );
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

        let ta = crate::plugins::sync::http_transport::build_transport(&url).unwrap();
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
        let tb = crate::plugins::sync::http_transport::build_transport(&url).unwrap();
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
        let mk = || crate::plugins::sync::http_transport::build_transport(&url).unwrap();

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
            inner: crate::plugins::sync::http_transport::build_transport(&url).unwrap(),
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

    /// myne#292 — a FAILED cycle must not leave the previous cycle's
    /// `corpus_complete: true` on disk.
    ///
    /// The flag's only job is to authorise an irreversible cross-device
    /// attachment erase, and its own doc says it is "recomputed every cycle, and
    /// cleared as readily as it is set". It was not: the recompute is the last
    /// statement of the attempt, and only the SUCCESS arm persisted it — so a
    /// device that was complete, then fell behind and kept failing, went on
    /// authorising "Clean unused" indefinitely with a corpus it no longer had.
    ///
    /// The existing coverage is the success path only (`corpus_complete` is
    /// asserted true after a clean pull); this is the other half.
    #[test]
    fn a_failed_cycle_clears_the_persisted_whole_corpus_flag() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP a_failed_cycle_clears_the_persisted_whole_corpus_flag: no server");
            return;
        };
        let root_key = [0x7Au8; 32];
        let account_hash = [0x7Bu8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0x15u8; 32];
        let items_key_id = [0x39u8; 16];

        let dir_a = std::env::temp_dir().join(format!("myne-cc-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-cc-B-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();

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
            "a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2a2",
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

        // B completes a cycle and is genuinely whole-corpus.
        let (tb, dev_b, tok_b) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
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
        .unwrap();
        assert!(
            read_sync_state(&dir_b).unwrap().corpus_complete,
            "precondition: B held the whole corpus after a clean cycle"
        );

        // A authors a second note, so B is now behind.
        let note2 = NoteId::new_v7();
        write_note(
            &notes_a,
            &items_key,
            &items_key_id,
            &note2,
            b"second",
            false,
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

        // B's next cycle dies in the note-body download loop.
        let tb_fail = FailBlobTransport {
            inner: crate::plugins::sync::http_transport::build_transport(&url).unwrap(),
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

        assert!(
            !read_sync_state(&dir_b).unwrap().corpus_complete,
            "a device that failed mid-cycle must NOT keep authorising the \
             irreversible fleet-wide attachment sweep"
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

    /// myne#462, the half that fixes the bug: while a device-verification
    /// eye-compare is open, a cycle with local changes authors **no head**, so
    /// the fingerprint both screens are reading stands still.
    ///
    /// Asserted as state, not as a return value: the return could report
    /// "nothing pushed" for several unrelated reasons, whereas `vv_log.last()`
    /// is literally what `sync_head_fingerprint` reads, so pinning it pins the
    /// displayed code.
    #[test]
    fn a_verify_hold_cycle_authors_no_head() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP a_verify_hold_cycle_authors_no_head: myne-server binary not found");
            return;
        };
        let root_key = [0x71u8; 32];
        let account_hash = [0x72u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0x15u8; 32];
        let items_key_id = [0x39u8; 16];

        let dir = std::env::temp_dir().join(format!("myne-hold-{}", std::process::id()));
        let notes = dir.join("notes");
        std::fs::create_dir_all(&notes).unwrap();

        let (t, dev, tok) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2",
            true,
        );

        // A first ordinary cycle so the account HAS a head — the genesis case is
        // the sibling test below, and conflating the two would let either pass
        // for the other's reason.
        let first = NoteId::new_v7();
        write_note(&notes, &items_key, &items_key_id, &first, b"one", false);
        run_cycle_legacy(
            t.as_ref(),
            &root_key,
            account_hash,
            dev,
            &tok,
            &notes,
            &dir,
            true,
        )
        .expect("the seeding cycle");
        let before = read_sync_state(&dir)
            .unwrap()
            .vv_log
            .last()
            .cloned()
            .expect("a head after the seeding cycle");

        // Now the ceremony is open, and the user edits (or an autosave fires).
        let second = NoteId::new_v7();
        write_note(&notes, &items_key, &items_key_id, &second, b"two", false);
        let held = blocking(run_sync_cycle(
            &IO,
            t.as_ref(),
            Some(&root_key),
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(root_key)),
            account_hash,
            dev,
            &tok,
            &notes,
            &dir,
            PushGate::VerifyHold,
            MetaVersion::V0_1,
            None,
            None,
            &std::collections::HashSet::new(),
        ))
        .expect("the held cycle still runs");
        assert_eq!(held.pushed, 0, "a held cycle pushes no content");
        assert!(!held.head_advanced, "a held cycle authors no head");

        let after = read_sync_state(&dir)
            .unwrap()
            .vv_log
            .last()
            .cloned()
            .expect("the observation survives the held cycle");
        assert_eq!(
            after.head_id_hex, before.head_id_hex,
            "the head the SAS is derived from must not move under the compare"
        );

        // And the edit is not lost — the very next unheld cycle pushes it.
        let released = run_cycle_legacy(
            t.as_ref(),
            &root_key,
            account_hash,
            dev,
            &tok,
            &notes,
            &dir,
            true,
        )
        .expect("the cycle after the compare closed");
        assert_eq!(released.pushed, 1, "the held edit flushes once released");

        std::fs::remove_dir_all(&dir).ok();
    }

    /// myne#462's liveness carve-out, and the reason `PushGate` is an enum
    /// rather than a second bool.
    ///
    /// On an account nobody has ever pushed to, the genesis head is the only
    /// thing a joining device can adopt — and without an adopted head its SAS
    /// never appears at all (`decisions.md` 2026-07-12, and
    /// `empty_vault_authors_genesis_head_so_joiner_sees_sas` above). A hold that
    /// suppressed *every* push would therefore hang both screens forever on
    /// exactly the accounts where the ceremony matters most: brand new ones.
    /// That is a worse bug than the one the hold fixes, and it is invisible on
    /// any account that already has a head.
    #[test]
    fn a_verify_hold_still_authors_the_genesis_head() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP a_verify_hold_still_authors_the_genesis_head: server binary not found");
            return;
        };
        let root_key = [0x73u8; 32];
        let account_hash = [0x74u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);

        let dir = std::env::temp_dir().join(format!("myne-holdgen-{}", std::process::id()));
        let notes = dir.join("notes");
        std::fs::create_dir_all(&notes).unwrap(); // EMPTY — nothing to push

        let (t, dev, tok) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3",
            true,
        );

        let held = blocking(run_sync_cycle(
            &IO,
            t.as_ref(),
            Some(&root_key),
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(root_key)),
            account_hash,
            dev,
            &tok,
            &notes,
            &dir,
            PushGate::VerifyHold,
            MetaVersion::V0_1,
            None,
            None,
            &std::collections::HashSet::new(),
        ))
        .expect("the held first cycle");
        assert!(
            held.head_advanced,
            "genesis must still be authored under a verify hold, or a joining \
             device on a fresh account never adopts a head and its SAS never appears"
        );
        assert_eq!(held.pushed, 0, "genesis is head-only — no blobs");
        assert!(
            read_sync_state(&dir).unwrap().vv_log.last().is_some(),
            "the genesis observation is recorded, so a fingerprint exists to compare"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The genesis carve-out is genesis-ON-EMPTY, and a non-empty corpus is not
    /// it.
    ///
    /// The condition used to be `gate.allows_genesis() && page.head.is_none()`
    /// with no look at the corpus, which is strictly wider than the §6.1 bullet
    /// it implements ("A device with zero content blobs ... a head-only push").
    /// A device with notes on disk and no head yet would, under a compare,
    /// author a head whose `manifest_hash` comes from the full local manifest
    /// while `to_push` is empty, because both content blocks sit behind
    /// `gate.allows_content()`. That head commits `content_nonce`s for blobs the
    /// server does not hold, which inverts the SYNC-5 ordering this function
    /// states as its own invariant, and a peer pulling in that window cannot
    /// tell an over-claiming author from a withholding server.
    #[test]
    fn a_verify_hold_does_not_author_genesis_over_a_non_empty_corpus() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!(
                "SKIP a_verify_hold_does_not_author_genesis_over_a_non_empty_corpus: \
                 server binary not found"
            );
            return;
        };
        let root_key = [0x75u8; 32];
        let account_hash = [0x76u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);

        let dir = std::env::temp_dir().join(format!("myne-holdgen2-{}", std::process::id()));
        let notes = dir.join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        // NOT empty: one local note, never pushed. This is the whole difference
        // from the sibling test above.
        let items_key = [0x11u8; 32];
        let items_key_id = [0x22u8; 16];
        let only = NoteId::new_v7();
        write_note(
            &notes,
            &items_key,
            &items_key_id,
            &only,
            b"local only",
            false,
        );

        let (t, dev, tok) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4",
            true,
        );

        let held = blocking(run_sync_cycle(
            &IO,
            t.as_ref(),
            Some(&root_key),
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(root_key)),
            account_hash,
            dev,
            &tok,
            &notes,
            &dir,
            PushGate::VerifyHold,
            MetaVersion::V0_1,
            None,
            None,
            &std::collections::HashSet::new(),
        ))
        .expect("the held first cycle");
        assert_eq!(held.pushed, 0, "content is held, as it must be");
        assert!(
            !held.head_advanced,
            "a head authored here would commit a manifest the server cannot serve"
        );

        std::fs::remove_dir_all(&dir).ok();
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
        let ta = crate::plugins::sync::http_transport::build_transport(&url).unwrap();
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
        let tb = crate::plugins::sync::http_transport::build_transport(&url).unwrap();
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
        let t = crate::plugins::sync::http_transport::build_transport(url).unwrap();
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

    /// A corpus larger than one push chunk travels as several `/sync/push`
    /// requests, and the head rides the LAST one (myne-md/myne#222).
    ///
    /// That ordering is the whole reason chunking needs no protocol change: the
    /// head the server accepts still commits only blobs it already holds, which is
    /// SYNC-5 blobs-first-then-head (`sync-protocol.md` §5) stated over several
    /// requests instead of one. A head on an intermediate chunk would commit a
    /// manifest covering blobs still in flight.
    #[test]
    fn a_large_push_is_chunked_and_the_head_rides_the_last_chunk() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP push_chunking: server binary not found");
            return;
        };
        let root_key = [0x91u8; 32];
        let account_hash = [0x92u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0x93u8; 32];
        let items_key_id = [0x94u8; 16];
        let dir_a = std::env::temp_dir().join(format!("myne-chunk-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-chunk-B-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();

        // One more than a whole chunk, so the split is exercised and asymmetric.
        let n = PUSH_CHUNK_MAX_BLOBS + 44;
        for i in 0..n {
            write_note(
                &notes_a,
                &items_key,
                &items_key_id,
                &NoteId::new_v7(),
                format!("note {i}").as_bytes(),
                false,
            );
        }
        let (ta, dev_a, tok_a) = enroll_device(
            &url,
            &account_hash,
            secret.as_slice(),
            "a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0",
            true,
        );
        let obs = PushObserver::new(ta, None);
        let push = run_cycle_legacy(
            &obs,
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("A push");

        assert_eq!(push.pushed, n, "every blob landed across the chunks");
        assert!(push.head_advanced, "the head advanced exactly once");
        assert_eq!(
            obs.pushes(),
            vec![false, true],
            "two /sync/push requests, and only the LAST carried a new_head"
        );

        // The head still describes the whole corpus: a fresh device materialises
        // every note from it, so chunking did not split the manifest.
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
        .expect("B pull");
        assert_eq!(pull.pulled, n, "B materialised the whole corpus");
        assert!(
            read_sync_state(&dir_b).unwrap().corpus_complete,
            "B's local manifest matches the head's — the head covers every chunk"
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    /// The myne-md/myne#222 regression, in miniature: a first sync whose push dies
    /// partway must leave the landed chunks RECORDED, so the next cycle finishes the
    /// job instead of re-sending everything from an empty baseline forever.
    ///
    /// Before the fix this vault pushed once, and a transport failure there recorded
    /// nothing at all (`sync-state.json` → `blobs: 0`) — which is exactly what was
    /// observed on the 50 000-note vault, and why every subsequent cycle repeated the
    /// same multi-minute round trip and failed identically.
    #[test]
    fn a_push_that_dies_midway_resumes_instead_of_wedging() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP push_resume: server binary not found");
            return;
        };
        let root_key = [0x95u8; 32];
        let account_hash = [0x96u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0x97u8; 32];
        let items_key_id = [0x98u8; 16];
        let dir_a = std::env::temp_dir().join(format!("myne-resume-A-{}", std::process::id()));
        let dir_b = std::env::temp_dir().join(format!("myne-resume-B-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        let notes_b = dir_b.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();
        std::fs::create_dir_all(&notes_b).unwrap();

        let n = PUSH_CHUNK_MAX_BLOBS + 44;
        let mut ids = Vec::new();
        for i in 0..n {
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
        // Kill the SECOND push below HTTP — the shape a socket deadline produces
        // once the request body is out and the server is still working.
        let obs = PushObserver::new(ta, Some(2));

        let err = run_cycle_legacy(
            &obs,
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect_err("the cycle fails with the second chunk");
        assert!(
            matches!(
                err,
                SyncCycleError::Push(PushError::Transport(TransportError::Network))
            ),
            "failed at the transport, not on a CAS: {err:?}"
        );

        let after_fail = read_sync_state(&dir_a).unwrap();
        assert_eq!(
            after_fail.blobs.len(),
            PUSH_CHUNK_MAX_BLOBS,
            "the chunk that LANDED was checkpointed (pre-fix: 0, and the account wedged)"
        );
        assert!(
            std::fs::read(dir_a.join("vault.head-state")).is_err(),
            "no head baseline: the head rides the last chunk, which never went out"
        );

        // Next cycle: only the remainder is dirty, and it converges.
        let resumed = run_cycle_legacy(
            &obs,
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("the retry cycle completes");
        assert_eq!(
            resumed.pushed,
            n - PUSH_CHUNK_MAX_BLOBS,
            "only the blobs that never landed were re-sent"
        );
        assert!(
            resumed.head_advanced,
            "the head landed on the resumed cycle"
        );
        assert_eq!(
            read_sync_state(&dir_a).unwrap().blobs.len(),
            n,
            "every blob now has a baseline"
        );

        // The account is genuinely converged, not merely locally consistent.
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
        .expect("B pull");
        assert_eq!(
            pull.pulled, n,
            "a fresh device materialises the whole corpus"
        );
        assert_eq!(
            read_note(&notes_b, &items_key, &items_key_id, &ids[0]).as_deref(),
            Some(&b"note 0"[..])
        );

        std::fs::remove_dir_all(&dir_a).ok();
        std::fs::remove_dir_all(&dir_b).ok();
    }

    /// A blob the server already holds at OUR revision, with no local baseline
    /// saying so, is ADOPTED — not re-pushed at `base_version = 0`.
    ///
    /// **Characterization, not a new mechanism.** myne-md/myne#222 asks for this as
    /// a fix ("a device that finds the server holding a blob whose `content_nonce`
    /// matches its own local copy should adopt that version as its baseline"); the
    /// §11.2 baseline reconcile above `pull_to_stable`'s roster already does it, for
    /// every id the server reports, since MYND-426. What was missing was a test in
    /// the state the 50 000-note vault was actually observed in — `blobs: 0`,
    /// `cursor: 0`, no `vault.head-state`, server holding the blobs — as opposed to
    /// `empty_baseline_self_heals_and_local_edit_pushes`, which keeps the cursor and
    /// the head baseline and has a genuine local edit to push. Pinning it is what
    /// stops a future change from quietly removing the property and re-opening the
    /// wedge from the other side.
    #[test]
    fn an_unrecorded_landed_blob_adopts_the_server_version() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP adopt_landed_blob: server binary not found");
            return;
        };
        let root_key = [0x99u8; 32];
        let account_hash = [0x9Au8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0x9Bu8; 32];
        let items_key_id = [0x9Cu8; 16];
        let dir_a = std::env::temp_dir().join(format!("myne-adopt-A-{}", std::process::id()));
        let notes_a = dir_a.join("notes");
        std::fs::create_dir_all(&notes_a).unwrap();

        let note = NoteId::new_v7();
        write_note(&notes_a, &items_key, &items_key_id, &note, b"body", false);
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
        .expect("initial push");

        // Reproduce the observed post-failure state: the server holds the blob, the
        // device recorded nothing about it and has no head baseline either.
        let mut st = read_sync_state(&dir_a).unwrap();
        assert!(!st.blobs.is_empty(), "the initial push recorded a baseline");
        st.blobs.clear();
        st.cursor = 0;
        write_sync_state(&dir_a, &st).unwrap();
        std::fs::remove_file(dir_a.join("vault.head-state")).unwrap();

        let obs = PushObserver::new(ta, None);
        let summary = run_cycle_legacy(
            &obs,
            &root_key,
            account_hash,
            dev_a,
            &tok_a,
            &notes_a,
            &dir_a,
            true,
        )
        .expect("the recovery cycle succeeds");

        assert!(
            obs.pushes().is_empty(),
            "nothing was pushed at all — the server's revision IS ours"
        );
        assert_eq!(summary.pushed, 0);
        assert!(
            summary.conflicts.is_empty(),
            "an identical blob is no conflict"
        );
        let healed = read_sync_state(&dir_a).unwrap();
        assert_eq!(
            healed
                .blobs
                .get(&hex(note.as_uuid().as_bytes()))
                .map(|b| b.version),
            Some(1),
            "the server's version became the baseline"
        );

        std::fs::remove_dir_all(&dir_a).ok();
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
        // DeviceRevoked, not the generic Unauthenticated: the token did not
        // expire, the owner revoked it, and myne#294 exists precisely because
        // reporting that as a retryable "sign-in expired" showed the wrong
        // copy and suppressed the web client's terminal takeover (gated on
        // `detail === "device_revoked"`) for up to a 15-minute auth park.
        // Accepting Unauthenticated here would re-open that collapse silently.
        assert!(
            matches!(
                err,
                SyncCycleError::Pull(PullError::DeviceRevoked)
                    | SyncCycleError::Push(PushError::DeviceRevoked)
            ),
            "clean DeviceRevoked, got {err:?}"
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
        version: MetaVersion,
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
            Some(root_key),
            &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(*root_key)),
            account_number_hash,
            device_id,
            token,
            &vault_root.join("notes"),
            vault_root,
            PushGate::Allowed,
            version,
            Some(AttachmentKeys {
                items_key,
                items_key_id,
            }),
            None,
            &std::collections::HashSet::new(),
        ))
    }

    /// Seed a local attachment exactly as `attachment_import` would: MYA1 blob
    /// under `attachments/<id-hex>` + a live MYC1 catalog entry.
    #[allow(clippy::too_many_arguments)]
    fn seed_attachment(
        version: MetaVersion,
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
        let blob = protocol::encode_attachment_blob_versioned(
            version,
            items_key,
            items_key_id,
            &id,
            b"application/octet-stream",
            plaintext,
        )
        .unwrap();
        // Pin the generation the fixture actually produced. Without this a
        // scenario can be handed the wrong `version` and re-run the v0.1 case
        // under an `_on_a_migrated_vault` name, staying green while proving
        // nothing, and it is the same silent-pass shape myne-md/myne#638 exists to
        // remove. Asserted here rather than per scenario so every caller, and
        // every scenario added later, is covered by construction.
        assert_eq!(
            &blob[0..4],
            match version {
                MetaVersion::V0_1 => protocol::attachment_blob::ATTACHMENT_BLOB_MAGIC.as_slice(),
                MetaVersion::V0_2 =>
                    protocol::attachment_blob::ATTACHMENT_BLOB_V0_2_MAGIC.as_slice(),
            },
            "seeded body carries the magic of the generation under test"
        );
        let att_dir = vault.join("attachments");
        std::fs::create_dir_all(&att_dir).unwrap();
        crate::atomic_write::atomic_write(&att_dir.join(hex(&id)), &blob, true).unwrap();

        let catalog_key =
            protocol::derive_subkey_versioned(version, root_key, SubkeyRole::AttachmentsCatalogKey);
        let existing = std::fs::read(vault.join("vault.attachments")).ok();
        let mut catalog = protocol::read_or_empty_versioned(
            version,
            &catalog_key,
            account_hash,
            existing.as_deref(),
        );
        let id_hex = hex(&id);
        // Mirror the production `attachment_import` causal version bump (#405):
        // `max(prior version) + 1`, so a re-add over a tombstone (version N)
        // outranks it (version N+1) and the §11.4 catalog merge keeps the
        // revival. Without this the helper writes version 0 and the tombstone
        // wins the merge — the shape `attachment_readd_after_delete_revives`
        // caught once `version` became the merge join's primary key.
        let next_version = catalog.entries.get(&id_hex).map_or(0, |e| e.version) + 1;
        let mut meta = protocol::AttachmentMeta::live(
            "application/octet-stream".to_string(),
            created_at,
            filename.to_string(),
            plaintext.len() as u64,
        );
        meta.version = next_version;
        catalog.entries.insert(id_hex, meta);
        let bytes = protocol::encode_attachments_catalog_versioned(
            version,
            &catalog_key,
            account_hash,
            &catalog,
        )
        .unwrap();
        // The catalog is the other half of "this vault is v0.2", and the four
        // scenarios assert against it. Pinned here for the same reason the body
        // is: a `version` threaded correctly to one encoder and wrongly to the
        // other still names itself `_on_a_migrated_vault` and passes.
        assert_eq!(
            &bytes[0..4],
            match version {
                MetaVersion::V0_1 => protocol::CATALOG_BLOB_MAGIC.as_slice(),
                MetaVersion::V0_2 => protocol::CATALOG_BLOB_V0_2_MAGIC.as_slice(),
            },
            "seeded catalog carries the magic of the generation under test"
        );
        crate::atomic_write::atomic_write(&vault.join("vault.attachments"), &bytes, true).unwrap();
        id
    }

    /// Delete a local attachment exactly as `attachment_delete` would under
    /// sync: catalog entry → tombstone (metadata scrubbed) + tombstone queue +
    /// blob unlink.
    fn delete_attachment_local(
        version: MetaVersion,
        vault: &Path,
        root_key: &[u8; 32],
        account_hash: &[u8; 16],
        id: &[u8; 32],
        deleted_at: u64,
    ) {
        let catalog_key =
            protocol::derive_subkey_versioned(version, root_key, SubkeyRole::AttachmentsCatalogKey);
        let existing = std::fs::read(vault.join("vault.attachments")).ok();
        let mut catalog = protocol::read_or_empty_versioned(
            version,
            &catalog_key,
            account_hash,
            existing.as_deref(),
        );
        let id_hex = hex(id);
        if let Some(meta) = catalog.entries.get(&id_hex).cloned() {
            catalog
                .entries
                .insert(id_hex.clone(), meta.into_tombstone(deleted_at));
        }
        let bytes = protocol::encode_attachments_catalog_versioned(
            version,
            &catalog_key,
            account_hash,
            &catalog,
        )
        .unwrap();
        crate::atomic_write::atomic_write(&vault.join("vault.attachments"), &bytes, true).unwrap();
        add_pending_attachment_tombstone(vault, id).unwrap();
        let _ = std::fs::remove_file(vault.join("attachments").join(&id_hex));
    }

    fn read_catalog_of(
        version: MetaVersion,
        vault: &Path,
        root_key: &[u8; 32],
        account_hash: &[u8; 16],
    ) -> protocol::AttachmentsCatalog {
        let catalog_key =
            protocol::derive_subkey_versioned(version, root_key, SubkeyRole::AttachmentsCatalogKey);
        let bytes = std::fs::read(vault.join("vault.attachments")).ok();
        protocol::read_or_empty_versioned(version, &catalog_key, account_hash, bytes.as_deref())
    }

    /// Everything an attachment scenario needs from two enrolled devices.
    struct TwoDevices {
        /// Kills the server on drop; never read.
        _guard: ServerGuard,
        ta: Box<dyn SyncTransport>,
        tb: Box<dyn SyncTransport>,
        dir_a: std::path::PathBuf,
        dir_b: std::path::PathBuf,
        dev_a: [u8; 16],
        dev_b: [u8; 16],
        tok_a: String,
        tok_b: String,
        /// The account the two devices actually enrolled against.
        ///
        /// Returned rather than re-derived. Five scenarios used to recompute it
        /// from `ATT_ROOT` and a re-typed tag literal, so enrolment and the
        /// cycle addressed the same account only as long as two literals agreed;
        /// a typo in either produced an empty-server puzzle rather than a key
        /// mismatch.
        account_hash: [u8; 16],
    }

    /// Enroll two devices on a fresh server. `None` → self-skip (binary not
    /// built).
    fn two_device_fixture(tag: &str) -> Option<TwoDevices> {
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

        let ta = crate::plugins::sync::http_transport::build_transport(&url).unwrap();
        let tb = crate::plugins::sync::http_transport::build_transport(&url).unwrap();
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
        Some(TwoDevices {
            _guard: guard,
            ta,
            tb,
            dir_a,
            dir_b,
            dev_a,
            dev_b,
            tok_a: hex32(&out_a.token),
            tok_b: hex32(&out_b.token),
            account_hash,
        })
    }

    const ATT_ROOT: [u8; 32] = [0x42u8; 32];
    const ATT_ITEMS: [u8; 32] = [0x11u8; 32];
    const ATT_ITEMS_ID: [u8; 16] = [0x22u8; 16];

    /// A imports an attachment; B receives the exact bytes + the live catalog
    /// entry: the end-to-end replication proof over the real byte-transport,
    /// run once per generation.
    ///
    /// The `MYA5` half had no coverage anywhere before myne-md/myne#638, and
    /// that absence is why the defect shipped: every attachment scenario here
    /// hardcoded `MetaVersion::V0_1`, so the suite exercised the one generation
    /// that worked while the generation real vaults are on pushed nothing at
    /// all, with `attachments_pushed` at 0 and the run green.
    ///
    /// Push and pull are asserted separately on purpose: that defect broke BOTH
    /// directions through the same reader, and a test that only checked B's
    /// bytes would pass on a fix that repaired the scan and left the
    /// downloaded-body verification behind. That the fixture really seeded the
    /// generation under test is pinned inside `seed_attachment`, so every
    /// scenario gets it rather than this one.
    fn replication_proof(version: MetaVersion, tag: &str) {
        let Some(fx) = two_device_fixture(tag) else {
            eprintln!("SKIP replication_proof({tag}): myne-server unavailable");
            return;
        };
        let account_hash = fx.account_hash;

        let plaintext = b"attachment payload from device A";
        let id = seed_attachment(
            version,
            &fx.dir_a,
            &ATT_ROOT,
            &account_hash,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
            plaintext,
            "payload.bin",
            1_000,
        );
        let push = run_cycle_att(
            version,
            fx.ta.as_ref(),
            &ATT_ROOT,
            account_hash,
            fx.dev_a,
            &fx.tok_a,
            &fx.dir_a,
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
            version,
            fx.tb.as_ref(),
            &ATT_ROOT,
            account_hash,
            fx.dev_b,
            &fx.tok_b,
            &fx.dir_b,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .expect("B cycle");
        assert_eq!(pull.attachments_pulled, 1, "B downloaded the body");

        let a_bytes = std::fs::read(fx.dir_a.join("attachments").join(hex(&id))).unwrap();
        let b_bytes = std::fs::read(fx.dir_b.join("attachments").join(hex(&id))).unwrap();
        assert_eq!(
            a_bytes, b_bytes,
            "B holds A's exact ciphertext (server-wins convergence)"
        );

        let cat_b = read_catalog_of(version, &fx.dir_b, &ATT_ROOT, &account_hash);
        let entry = cat_b
            .entries
            .get(&hex(&id))
            .expect("B merged the catalog entry");
        assert!(!entry.is_tombstone());
        assert_eq!(entry.filename, "payload.bin");

        // Idle cycles push nothing (nonce-churn regression): the catalog was
        // adopted verbatim, so no re-encrypt → no endless push loop.
        for (t, dev, tok, dir) in [
            (fx.ta.as_ref(), fx.dev_a, &fx.tok_a, &fx.dir_a),
            (fx.tb.as_ref(), fx.dev_b, &fx.tok_b, &fx.dir_b),
        ] {
            let idle = run_cycle_att(
                version,
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

        std::fs::remove_dir_all(&fx.dir_a).ok();
        std::fs::remove_dir_all(&fx.dir_b).ok();
    }

    #[test]
    fn two_devices_replicate_an_attachment() {
        replication_proof(MetaVersion::V0_1, "repl");
    }

    /// The same proof on a MIGRATED vault, where every body is `MYA5` and the
    /// catalog is `MYC5`. Its own `#[test]` rather than a loop inside one, so a
    /// regression names the generation it broke.
    #[test]
    fn two_devices_replicate_an_attachment_on_a_migrated_vault() {
        replication_proof(MetaVersion::V0_2, "repl-v0-2");
    }

    /// A deletes the attachment; B's blob is erased and its catalog entry is a
    /// tombstone — and B's stale catalog can never resurrect it (§11.4).
    fn attachment_delete_propagates_with_resurrection_guard_case(version: MetaVersion, tag: &str) {
        let Some(fx) = two_device_fixture(tag) else {
            eprintln!("SKIP attachment_delete_propagates_with_resurrection_guard({tag}): myne-server unavailable");
            return;
        };
        let account_hash = fx.account_hash;

        let plaintext = b"to be deleted everywhere";
        let id = seed_attachment(
            version,
            &fx.dir_a,
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
            version,
            fx.ta.as_ref(),
            &ATT_ROOT,
            account_hash,
            fx.dev_a,
            &fx.tok_a,
            &fx.dir_a,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .unwrap();
        run_cycle_att(
            version,
            fx.tb.as_ref(),
            &ATT_ROOT,
            account_hash,
            fx.dev_b,
            &fx.tok_b,
            &fx.dir_b,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .unwrap();
        assert!(fx.dir_b.join("attachments").join(hex(&id)).exists());

        // A deletes while B is "offline" (B holds a live catalog + the blob).
        delete_attachment_local(version, &fx.dir_a, &ATT_ROOT, &account_hash, &id, 2_000);
        let del = run_cycle_att(
            version,
            fx.ta.as_ref(),
            &ATT_ROOT,
            account_hash,
            fx.dev_a,
            &fx.tok_a,
            &fx.dir_a,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .expect("A delete cycle");
        assert!(
            del.tombstones_pushed >= 1,
            "the §11.4 tombstone record pushed"
        );
        assert!(
            read_pending_attachment_tombstones(&fx.dir_a).is_empty(),
            "the queue drained after the push"
        );

        // B pulls: catalog-first merge → tombstone wins → local erase.
        let pull = run_cycle_att(
            version,
            fx.tb.as_ref(),
            &ATT_ROOT,
            account_hash,
            fx.dev_b,
            &fx.tok_b,
            &fx.dir_b,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .expect("B pull cycle");
        assert_eq!(pull.attachments_deleted, 1, "B erased the tombstoned body");
        assert!(
            !fx.dir_b.join("attachments").join(hex(&id)).exists(),
            "B's blob is gone"
        );
        let cat_b = read_catalog_of(version, &fx.dir_b, &ATT_ROOT, &account_hash);
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
            version,
            fx.tb.as_ref(),
            &ATT_ROOT,
            account_hash,
            fx.dev_b,
            &fx.tok_b,
            &fx.dir_b,
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

        std::fs::remove_dir_all(&fx.dir_a).ok();
        std::fs::remove_dir_all(&fx.dir_b).ok();
    }

    #[test]
    fn attachment_delete_propagates_with_resurrection_guard() {
        attachment_delete_propagates_with_resurrection_guard_case(MetaVersion::V0_1, "del");
    }

    /// The same scenario on a MIGRATED vault (`MYA5` bodies, `MYC5`
    /// catalog). Its own `#[test]` so a regression names the generation it
    /// broke, and a separate fixture tag so the two accounts never share
    /// server state.
    #[test]
    fn attachment_delete_propagates_with_resurrection_guard_on_a_migrated_vault() {
        attachment_delete_propagates_with_resurrection_guard_case(MetaVersion::V0_2, "del-v0-2");
    }

    /// Both devices import the SAME file independently (same content-addressed
    /// id, different random ciphertext) — the §4.2 server-wins rule converges
    /// both manifests on one ciphertext instead of diverging forever.
    fn double_import_converges_server_wins_case(version: MetaVersion, tag: &str) {
        let Some(fx) = two_device_fixture(tag) else {
            eprintln!("SKIP double_import_converges_server_wins({tag}): myne-server unavailable");
            return;
        };
        let account_hash = fx.account_hash;

        let plaintext = b"identical file imported on two devices";
        let id_a = seed_attachment(
            version,
            &fx.dir_a,
            &ATT_ROOT,
            &account_hash,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
            plaintext,
            "same.bin",
            1_000,
        );
        let id_b = seed_attachment(
            version,
            &fx.dir_b,
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
            std::fs::read(fx.dir_a.join("attachments").join(hex(&id_a))).unwrap(),
            std::fs::read(fx.dir_b.join("attachments").join(hex(&id_b))).unwrap(),
            "randomized encryption: same id, different ciphertext"
        );

        // A wins the race; B's divergent local copy must adopt A's bytes.
        run_cycle_att(
            version,
            fx.ta.as_ref(),
            &ATT_ROOT,
            account_hash,
            fx.dev_a,
            &fx.tok_a,
            &fx.dir_a,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .unwrap();
        run_cycle_att(
            version,
            fx.tb.as_ref(),
            &ATT_ROOT,
            account_hash,
            fx.dev_b,
            &fx.tok_b,
            &fx.dir_b,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .unwrap();

        let a_bytes = std::fs::read(fx.dir_a.join("attachments").join(hex(&id_a))).unwrap();
        let b_bytes = std::fs::read(fx.dir_b.join("attachments").join(hex(&id_a))).unwrap();
        assert_eq!(a_bytes, b_bytes, "server-wins converged the ciphertexts");

        // Convergence is stable: further cycles on both sides move nothing.
        for (t, dev, tok, dir) in [
            (fx.ta.as_ref(), fx.dev_a, &fx.tok_a, &fx.dir_a),
            (fx.tb.as_ref(), fx.dev_b, &fx.tok_b, &fx.dir_b),
        ] {
            let idle = run_cycle_att(
                version,
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

        std::fs::remove_dir_all(&fx.dir_a).ok();
        std::fs::remove_dir_all(&fx.dir_b).ok();
    }

    #[test]
    fn double_import_converges_server_wins() {
        double_import_converges_server_wins_case(MetaVersion::V0_1, "dbl");
    }

    /// The same scenario on a MIGRATED vault (`MYA5` bodies, `MYC5`
    /// catalog). Its own `#[test]` so a regression names the generation it
    /// broke, and a separate fixture tag so the two accounts never share
    /// server state.
    #[test]
    fn double_import_converges_server_wins_on_a_migrated_vault() {
        double_import_converges_server_wins_case(MetaVersion::V0_2, "dbl-v0-2");
    }

    /// A re-add after a propagated deletion revives the entry (created_at >
    /// deleted_at) and re-uploads the body — the §11.4 rule-4 revival path,
    /// including the server-side un-tombstone CAS.
    fn attachment_readd_after_delete_revives_case(version: MetaVersion, tag: &str) {
        let Some(fx) = two_device_fixture(tag) else {
            eprintln!("SKIP attachment_readd_after_delete_revives({tag}): myne-server unavailable");
            return;
        };
        let account_hash = fx.account_hash;

        let plaintext = b"deleted then deliberately re-imported";
        let id = seed_attachment(
            version,
            &fx.dir_a,
            &ATT_ROOT,
            &account_hash,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
            plaintext,
            "phoenix.bin",
            1_000,
        );
        run_cycle_att(
            version,
            fx.ta.as_ref(),
            &ATT_ROOT,
            account_hash,
            fx.dev_a,
            &fx.tok_a,
            &fx.dir_a,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .unwrap();
        run_cycle_att(
            version,
            fx.tb.as_ref(),
            &ATT_ROOT,
            account_hash,
            fx.dev_b,
            &fx.tok_b,
            &fx.dir_b,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .unwrap();

        // Delete + propagate.
        delete_attachment_local(version, &fx.dir_a, &ATT_ROOT, &account_hash, &id, 2_000);
        run_cycle_att(
            version,
            fx.ta.as_ref(),
            &ATT_ROOT,
            account_hash,
            fx.dev_a,
            &fx.tok_a,
            &fx.dir_a,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .unwrap();
        run_cycle_att(
            version,
            fx.tb.as_ref(),
            &ATT_ROOT,
            account_hash,
            fx.dev_b,
            &fx.tok_b,
            &fx.dir_b,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .unwrap();

        // Re-import on A with a LATER created_at (the deliberate re-add).
        let id2 = seed_attachment(
            version,
            &fx.dir_a,
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
            version,
            fx.ta.as_ref(),
            &ATT_ROOT,
            account_hash,
            fx.dev_a,
            &fx.tok_a,
            &fx.dir_a,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .expect("A re-add cycle");
        assert_eq!(readd.attachments_pushed, 1, "A re-uploaded the body");

        // B revives: live entry wins the merge, body re-downloads.
        let pull = run_cycle_att(
            version,
            fx.tb.as_ref(),
            &ATT_ROOT,
            account_hash,
            fx.dev_b,
            &fx.tok_b,
            &fx.dir_b,
            &ATT_ITEMS,
            &ATT_ITEMS_ID,
        )
        .expect("B revival cycle");
        assert_eq!(
            pull.attachments_pulled, 1,
            "B re-downloaded the revived body"
        );
        let cat_b = read_catalog_of(version, &fx.dir_b, &ATT_ROOT, &account_hash);
        assert!(
            cat_b
                .entries
                .get(&hex(&id))
                .is_some_and(|e| !e.is_tombstone()),
            "B's entry is live again (created_at > deleted_at)"
        );

        std::fs::remove_dir_all(&fx.dir_a).ok();
        std::fs::remove_dir_all(&fx.dir_b).ok();
    }

    #[test]
    fn attachment_readd_after_delete_revives() {
        attachment_readd_after_delete_revives_case(MetaVersion::V0_1, "readd");
    }

    /// The same scenario on a MIGRATED vault (`MYA5` bodies, `MYC5`
    /// catalog). Its own `#[test]` so a regression names the generation it
    /// broke, and a separate fixture tag so the two accounts never share
    /// server state.
    #[test]
    fn attachment_readd_after_delete_revives_on_a_migrated_vault() {
        attachment_readd_after_delete_revives_case(MetaVersion::V0_2, "readd-v0-2");
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

        /// A MIGRATED vault meeting a peer that has also migrated: both blobs are
        /// `MYP5` under the v0.2 KEK, and the merge beats the server, so the phase
        /// takes its decode -> merge -> re-encode -> write path.
        ///
        /// Before the generation was threaded in, this phase derived
        /// `SubkeyRole::PrefsKey` under v0.1 unconditionally. The decoder sniffs
        /// the magic, so it picked the right family and then failed its tag check
        /// under the wrong key — and §9.5.5's read semantic answers ANY decode
        /// failure with `PrefsView::default()`. The phase then re-encoded that
        /// default as `MYP1` over the user's `MYP5` blob and pushed it, so the
        /// first sync after a migration reset every preference on every device.
        ///
        /// The two assertions are separate on purpose, and each catches one half:
        /// surviving content catches the KEK, surviving magic catches the encoder.
        /// Getting only the KEK right still writes `MYP1` bytes no v0.2 reader
        /// will open again. Both halves were re-broken individually to confirm
        /// this test names them.
        #[test]
        fn a_migrated_vault_keeps_its_myp5_prefs_instead_of_resetting_them() {
            let dir = scratch("migrated");
            let v0_2_key = protocol::derive_subkey_versioned(
                MetaVersion::V0_2,
                &ROOT,
                protocol::SubkeyRole::PrefsKey,
            );
            let seal = |view: &PrefsView| {
                protocol::encode_prefs_blob_versioned(MetaVersion::V0_2, &v0_2_key, &HASH, view)
                    .unwrap()
            };

            // Local: a SHARED field with the newer clock, so the merge beats the
            // server and the phase must take its write-a-fresh-blob branch, plus
            // a device-local one to prove the whole view survives, not just the
            // field under contention. Without the shared win the phase adopts the
            // server's bytes and never re-encodes, which makes the encoder half of
            // this test unfalsifiable (it was, once).
            let mut mine = PrefsView {
                label: Some("Mine".into()),
                auto_lock_seconds: Some(900),
                ..PrefsView::default()
            };
            mine.field_clocks.insert("label".into(), 9_000);
            let local_bytes = seal(&mine);
            assert_eq!(
                &local_bytes[0..4],
                protocol::PREFS_BLOB_V0_2_MAGIC.as_slice()
            );
            std::fs::write(dir.join("vault.prefs"), &local_bytes).unwrap();

            // Remote: a shared edit from the other migrated device, so the merge
            // differs from BOTH sides and the phase must write a fresh blob.
            let mut theirs = PrefsView {
                label: Some("Theirs".into()),
                ..PrefsView::default()
            };
            theirs.field_clocks.insert("label".into(), 100);
            let remote_bytes = seal(&theirs);
            let pid = prefs_sync_id(&ROOT);
            let t = FakeTransport::new();
            t.on(
                HttpMethod::Get,
                &format!("/sync/blob?id={}", hex(&pid)),
                200,
                serde_json::to_vec(
                    &serde_json::json!({ "ciphertext_b64": B64.encode(&remote_bytes) }),
                )
                .unwrap(),
            );
            let rec = ChangedBlob {
                id: pid,
                version: 7,
                content_nonce: read_prefs_nonce(&remote_bytes).unwrap(),
                attachment_id: None,
                size: remote_bytes.len(),
            };

            let mut st = SyncState::default();
            blocking(sync_prefs_phase(
                &IO,
                &t,
                "tok",
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &pid,
                Some(&rec),
                MetaVersion::V0_2,
            ))
            .unwrap();

            let after = std::fs::read(dir.join("vault.prefs")).unwrap();
            assert_eq!(
                &after[0..4],
                protocol::PREFS_BLOB_V0_2_MAGIC.as_slice(),
                "the phase rewrote a migrated vault's prefs as MYP1",
            );
            let back =
                protocol::decode_prefs_blob(&v0_2_key, &HASH, &after).expect("still v0.2-readable");
            assert_eq!(
                back.label.as_deref(),
                Some("Mine"),
                "the newer local shared edit lost to the server",
            );
            assert_eq!(
                back.auto_lock_seconds,
                Some(900),
                "the user's preferences were reset to defaults",
            );
            std::fs::remove_dir_all(&dir).ok();
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
        // unconditionally: the §10.2.1 initial publish (even a default view).
        #[test]
        fn initial_publish_when_server_never_held_prefs() {
            let dir = scratch("initpub");
            write_local(&dir, &PrefsView::default());
            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let pid = prefs_sync_id(&ROOT);

            let phase = blocking(sync_prefs_phase(
                &IO,
                &t,
                "tok",
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &pid,
                None,
                MetaVersion::V0_1,
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
                    doc_heads_hex: Vec::new(),
                },
            );
            // The synced baseline was the default view, whose SHARED subset
            // equals the themed view's (theme is device-local).
            set_prefs_gate_baseline(&dir, shared_subset_hash(&PrefsView::default()));
            let t = FakeTransport::new();

            let phase = blocking(sync_prefs_phase(
                &IO,
                &t,
                "tok",
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &pid,
                None,
                MetaVersion::V0_1,
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
                    doc_heads_hex: Vec::new(),
                },
            );
            set_prefs_gate_baseline(&dir, shared_subset_hash(&PrefsView::default()));
            let t = FakeTransport::new();

            let phase = blocking(sync_prefs_phase(
                &IO,
                &t,
                "tok",
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &pid,
                None,
                MetaVersion::V0_1,
            ))
            .unwrap();
            assert!(phase.dirty, "shared edit must push");
            std::fs::remove_dir_all(&dir).ok();
        }

        // A remote rename lands: merged into the on-disk view (device-local
        // theme preserved), applied_remote=true, and NO re-push: the server
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
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &pid,
                Some(&rec),
                MetaVersion::V0_1,
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
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &pid,
                Some(&rec),
                MetaVersion::V0_1,
            ))
            .unwrap();
            assert!(!phase2.dirty);
            assert!(!phase2.applied_remote);
            std::fs::remove_dir_all(&dir).ok();
        }

        // Enrollment wholesale seed: a VIRGIN vault (no vault.prefs on disk,
        // the just-joined state) adopts the server blob VERBATIM, device-local
        // fields included as starting defaults (Q3/Q7), and never re-seeds.
        #[test]
        fn virgin_vault_seeds_wholesale_from_server() {
            let dir = scratch("seed");
            // NO local vault.prefs: the just-joined-device state.
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
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &pid,
                Some(&rec),
                MetaVersion::V0_1,
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
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &pid,
                Some(&rec),
                MetaVersion::V0_1,
            ))
            .unwrap();
            assert!(!phase2.applied_remote);
            assert!(!phase2.dirty);
            std::fs::remove_dir_all(&dir).ok();
        }

        /// §11.3 on the enrollment seed. `decode_prefs_blob` succeeding is NOT
        /// the check: these bytes ARE a valid `MYP1` for this vault, they are
        /// simply not the revision the record advertised, which is exactly
        /// what a server replaying a genuine older blob under a newer record
        /// produces. Seeding them would write the wrong revision to a virgin
        /// vault AND record a baseline the client does not hold.
        #[test]
        fn a_seed_whose_bytes_do_not_match_the_record_is_refused() {
            let dir = scratch("seed-lying");
            let mut st = SyncState::default();
            let pid = prefs_sync_id(&ROOT);
            let t = FakeTransport::new();
            let mut remote = PrefsView {
                label: Some("Vault Identity".into()),
                ..PrefsView::default()
            };
            remote.field_clocks.insert("label".into(), 900);
            let mut rec = serve_remote(&t, &pid, &remote);
            // Same bytes on the wire, a different nonce in the record.
            rec.content_nonce = [0x11; 24];

            let phase = blocking(sync_prefs_phase(
                &IO,
                &t,
                "tok",
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &pid,
                Some(&rec),
                MetaVersion::V0_1,
            ))
            .unwrap();

            assert!(
                !dir.join("vault.prefs").exists(),
                "a virgin vault must not be seeded from unverified bytes"
            );
            assert!(
                !st.blobs.contains_key(&hex(&pid)),
                "no baseline may be adopted for bytes that were never verified"
            );
            assert!(!phase.applied_remote);
            std::fs::remove_dir_all(&dir).ok();
        }

        /// The steady-state twin: a populated vault must not have its live
        /// `vault.prefs` replaced by a revision the record misidentifies.
        #[test]
        fn a_steady_state_pull_under_a_lying_record_is_skipped() {
            let dir = scratch("steady-lying");
            let local = PrefsView {
                label: Some("Mine".into()),
                ..PrefsView::default()
            };
            write_local(&dir, &local);
            let before = std::fs::read(dir.join("vault.prefs")).unwrap();

            let mut st = SyncState::default();
            let pid = prefs_sync_id(&ROOT);
            let t = FakeTransport::new();
            let mut remote = PrefsView {
                label: Some("Theirs".into()),
                ..PrefsView::default()
            };
            remote.field_clocks.insert("label".into(), 9_000);
            let mut rec = serve_remote(&t, &pid, &remote);
            rec.content_nonce = [0x11; 24];

            let phase = blocking(sync_prefs_phase(
                &IO,
                &t,
                "tok",
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &pid,
                Some(&rec),
                MetaVersion::V0_1,
            ))
            .unwrap();

            assert_eq!(
                std::fs::read(dir.join("vault.prefs")).unwrap(),
                before,
                "the live blob must be byte-untouched"
            );
            assert_eq!(read_local(&dir).label, Some("Mine".into()));
            assert!(
                !st.blobs.contains_key(&hex(&pid)),
                "the prior baseline stays authoritative"
            );
            assert!(!phase.applied_remote);
            std::fs::remove_dir_all(&dir).ok();
        }

        // A virgin vault against an EMPTY server proceeds on defaults: no
        // crash, no seed, and the initial-publish intent registers as dirty.
        #[test]
        fn virgin_vault_with_empty_server_proceeds_on_defaults() {
            let dir = scratch("seedempty");
            let mut st = SyncState::default();
            let pid = prefs_sync_id(&ROOT);
            let t = FakeTransport::new();

            let phase = blocking(sync_prefs_phase(
                &IO,
                &t,
                "tok",
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &pid,
                None,
                MetaVersion::V0_1,
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
        // local blob is provably the server's bytes: healing from the edited
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
                    doc_heads_hex: Vec::new(),
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
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &pid,
                Some(&rec),
                MetaVersion::V0_1,
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
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &pid,
                Some(&rec),
                MetaVersion::V0_1,
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

        // ---- MYND-604: color groups across two devices ----------------------
        //
        // The criterion these serve is task 7's "rules … appear on a second
        // synced device". The restart half is proven by the desktop E2E
        // (`gc2`); this is the OTHER device. What makes a `FakeTransport`
        // faithful here rather than a stand-in: `run_sync_cycle`'s
        // `prefs_phase.dirty` arm uploads `io.read(vault_root/"vault.prefs")`
        // VERBATIM: the pushed ciphertext IS the author's on-disk blob, and
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
        /// DISABLED: a disabled rule is retained, so it must cross the wire
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
        // rules, same precedence order, same disabled flag, same filter ASTs;
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
                &IO,
                &t_a,
                "tok",
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir_a,
                &mut st_a,
                &pid,
                None,
                MetaVersion::V0_1,
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
                    doc_heads_hex: Vec::new(),
                },
            );
            set_prefs_gate_baseline(&dir_b, shared_subset_hash(&PrefsView::default()));
            let t_b = FakeTransport::new();
            let rec = serve_remote_raw(&t_b, &pid, &pushed, 8);

            let phase_b = blocking(sync_prefs_phase(
                &IO,
                &t_b,
                "tok",
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir_b,
                &mut st_b,
                &pid,
                Some(&rec),
                MetaVersion::V0_1,
            ))
            .unwrap();
            assert!(phase_b.applied_remote, "A's rules must land on B");
            assert!(
                !phase_b.dirty,
                "B adopted a shared subset it already agrees with ⇒ no ping-pong re-push"
            );

            // B's DISK is the assertion: the peer reads its rules back from
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
        // converges on B's version. The reverse leg is a separate claim:
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
            // and re-enables the second, under a newer clock.
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
                    doc_heads_hex: Vec::new(),
                },
            );
            set_prefs_gate_baseline(&dir_a, shared_subset_hash(&a));
            let t_a = FakeTransport::new();
            let rec = serve_remote_raw(&t_a, &pid, &b_bytes, 9);

            let phase = blocking(sync_prefs_phase(
                &IO,
                &t_a,
                "tok",
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir_a,
                &mut st_a,
                &pid,
                Some(&rec),
                MetaVersion::V0_1,
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
                    doc_heads_hex: Vec::new(),
                },
            );
            set_prefs_gate_baseline(&dir_a, shared_subset_hash(&a));
            let t_a = FakeTransport::new();
            let rec = serve_remote_raw(&t_a, &pid, &cleared_bytes, 11);

            blocking(sync_prefs_phase(
                &IO,
                &t_a,
                "tok",
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir_a,
                &mut st_a,
                &pid,
                Some(&rec),
                MetaVersion::V0_1,
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

    // ---- myne-md/myne#675: vault.chats phases (sync_chats_phase,
    // sync_chats_conversation_phase) --------------------

    mod chats_phase {
        // The parent module's seam shims (task 86).
        use super::{blocking, IO};

        use super::super::*;
        use crate::plugins::sync::state::SyncState;
        use crate::plugins::sync::transport::FakeTransport;
        use crate::vault_io::{IoResult, VaultIo};
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine as _;

        const ROOT: [u8; 32] = [0x42; 32];
        const HASH: [u8; 16] = [0x33; 16];
        const CONV: [u8; 16] = [0xAA; 16];

        fn scratch(tag: &str) -> std::path::PathBuf {
            let d = std::env::temp_dir().join(format!(
                "myne-chatsphase-{tag}-{}-{:p}",
                std::process::id(),
                &tag
            ));
            std::fs::create_dir_all(&d).unwrap();
            d
        }

        fn chats_key() -> zeroize::Zeroizing<[u8; 32]> {
            derive_subkey_versioned(MetaVersion::V0_1, &ROOT, SubkeyRole::ChatsKey)
        }

        fn chats_catalog_key() -> zeroize::Zeroizing<[u8; 32]> {
            derive_subkey_versioned(MetaVersion::V0_1, &ROOT, SubkeyRole::ChatsCatalogKey)
        }

        fn turn(id: &str, text: &str) -> serde_json::Value {
            serde_json::json!({"id": id, "kind": "text", "role": "user", "text": text})
        }

        fn seal_conversation(turns: Vec<serde_json::Value>, title: Option<&str>) -> Vec<u8> {
            let mut map = serde_json::Map::new();
            map.insert("turns".to_string(), serde_json::Value::Array(turns));
            if let Some(t) = title {
                map.insert(
                    "title_derived_from".to_string(),
                    serde_json::Value::String(t.to_string()),
                );
            }
            let plaintext = serde_json::to_vec(&serde_json::Value::Object(map)).unwrap();
            protocol::encode_chats_blob_versioned(
                MetaVersion::V0_1,
                &chats_key(),
                &HASH,
                &CONV,
                &plaintext,
            )
            .unwrap()
        }

        fn open_conversation(bytes: &[u8]) -> serde_json::Value {
            let plaintext = protocol::decode_chats_blob_versioned(
                MetaVersion::V0_1,
                &chats_key(),
                &HASH,
                &CONV,
                bytes,
            )
            .unwrap();
            serde_json::from_slice(&plaintext).unwrap()
        }

        fn turn_ids(v: &serde_json::Value) -> Vec<String> {
            v.get("turns")
                .and_then(|t| t.as_array())
                .unwrap()
                .iter()
                .map(|t| t.get("id").and_then(|i| i.as_str()).unwrap().to_string())
                .collect()
        }

        /// Encode a remote conversation blob and register it under
        /// `/sync/blob?id=…`.
        fn serve_remote(t: &FakeTransport, bytes: &[u8], version: u64) -> ChangedBlob {
            let nonce = read_chats_blob_nonce(bytes).unwrap();
            let body = serde_json::json!({ "ciphertext_b64": B64.encode(bytes) });
            t.on(
                HttpMethod::Get,
                &format!("/sync/blob?id={}", hex(&CONV)),
                200,
                serde_json::to_vec(&body).unwrap(),
            );
            ChangedBlob {
                id: CONV,
                content_nonce: nonce,
                version,
                size: bytes.len(),
                attachment_id: None,
            }
        }

        fn write_local(dir: &Path, bytes: &[u8]) {
            std::fs::create_dir_all(dir.join("chats")).unwrap();
            std::fs::write(dir.join("chats").join(hex(&CONV)), bytes).unwrap();
        }

        fn run_conversation_phase(
            io: &dyn VaultIo,
            t: &FakeTransport,
            dir: &Path,
            rec: Option<&ChangedBlob>,
        ) -> Result<ChatsConversationPhase, SyncCycleError> {
            blocking(sync_chats_conversation_phase(
                io,
                t,
                "tok",
                &ROOT,
                &HASH,
                dir,
                &CONV,
                rec,
                MetaVersion::V0_1,
            ))
        }

        /// A `VaultIo` whose reads always fail with a non-`NotFound` kind:
        /// pins the absent-vs-unreadable distinction (a wrapper that failed
        /// everything would prove nothing about the `NotFound` arm, which is
        /// exactly why the absent test below uses the real `IO`).
        struct FailReads;
        #[async_trait::async_trait]
        impl VaultIo for FailReads {
            async fn read(&self, _path: &Path) -> IoResult<Vec<u8>> {
                Err(crate::io_failure_kind::IoFailureKind::Other)
            }
            async fn read_prefix(&self, path: &Path, len: usize) -> IoResult<Vec<u8>> {
                crate::vault_io::StdVaultIo.read_prefix(path, len).await
            }
            async fn write(
                &self,
                path: &Path,
                bytes: &[u8],
                opts: crate::vault_io::WriteOpts,
            ) -> IoResult<()> {
                crate::vault_io::StdVaultIo.write(path, bytes, opts).await
            }
            async fn remove_file(&self, path: &Path) -> IoResult<()> {
                crate::vault_io::StdVaultIo.remove_file(path).await
            }
            async fn remove_dir_all(&self, path: &Path) -> IoResult<()> {
                crate::vault_io::StdVaultIo.remove_dir_all(path).await
            }
            async fn create_dir_all(&self, path: &Path) -> IoResult<()> {
                crate::vault_io::StdVaultIo.create_dir_all(path).await
            }
            async fn read_dir(&self, path: &Path) -> IoResult<Vec<crate::vault_io::DirEntry>> {
                crate::vault_io::StdVaultIo.read_dir(path).await
            }
            async fn exists(&self, path: &Path) -> IoResult<bool> {
                crate::vault_io::StdVaultIo.exists(path).await
            }
            async fn is_dir(&self, path: &Path) -> IoResult<bool> {
                crate::vault_io::StdVaultIo.is_dir(path).await
            }
            async fn rename(&self, from: &Path, to: &Path) -> IoResult<()> {
                crate::vault_io::StdVaultIo.rename(from, to).await
            }
        }

        // The refused outcome's contract, pinned where a sixth arm cannot
        // silently invent a new shape: nothing dirty, nothing applied,
        // an empty roster (so the catalog-guarded loops are inert), skipped.
        #[test]
        fn skipped_outcome_holds_its_invariants() {
            let phase = skipped_chats_phase();
            assert!(phase.skipped);
            assert!(!phase.dirty);
            assert!(!phase.applied_remote);
            assert!(phase.push_bytes.is_none());
            assert!(phase.merged.is_empty());
        }

        // A virgin no-conversations vault stays chats-silent: no file, no
        // record, nothing to push.
        #[test]
        fn virgin_vault_stays_chats_silent() {
            let dir = scratch("virgin");
            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let catid = chats_catalog_sync_id(&ROOT);
            let phase = blocking(sync_chats_phase(
                &IO,
                &t,
                "tok",
                &ROOT,
                &HASH,
                &dir,
                &mut st,
                &catid,
                None,
                MetaVersion::V0_1,
            ))
            .unwrap();
            assert!(!phase.dirty);
            assert!(!phase.skipped);
            assert!(phase.push_bytes.is_none());
            std::fs::remove_dir_all(&dir).ok();
        }

        // An unreadable local catalog refuses the plane even against a live
        // remote record: the garbage on disk is untouched (never adopted as
        // the merge base, never re-pushed over the server).
        #[test]
        fn unreadable_local_catalog_skips_the_plane() {
            let dir = scratch("unreadable");
            std::fs::write(dir.join("vault.chats"), b"torn-bytes").unwrap();
            let remote_bytes = protocol::encode_chats_catalog_blob_versioned(
                MetaVersion::V0_1,
                &chats_catalog_key(),
                &HASH,
                b"{}",
            )
            .unwrap();
            let t = FakeTransport::new();
            let catid = chats_catalog_sync_id(&ROOT);
            let nonce = read_chats_catalog_nonce(&remote_bytes).unwrap();
            let body = serde_json::json!({ "ciphertext_b64": B64.encode(&remote_bytes) });
            t.on(
                HttpMethod::Get,
                &format!("/sync/blob?id={}", hex(&catid)),
                200,
                serde_json::to_vec(&body).unwrap(),
            );
            let rec = ChangedBlob {
                id: catid,
                content_nonce: nonce,
                version: 3,
                size: remote_bytes.len(),
                attachment_id: None,
            };
            let mut st = SyncState::default();
            let phase = blocking(sync_chats_phase(
                &IO,
                &t,
                "tok",
                &ROOT,
                &HASH,
                &dir,
                &mut st,
                &catid,
                Some(&rec),
                MetaVersion::V0_1,
            ))
            .unwrap();
            assert!(phase.skipped, "an unreadable store refuses, never merges");
            assert!(!phase.dirty);
            assert_eq!(
                std::fs::read(dir.join("vault.chats")).unwrap(),
                b"torn-bytes",
                "the refused store is never written"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // Absent local file + a verified remote record: the remote is
        // adopted verbatim (the `NotFound`-is-absent arm, not a refusal).
        #[test]
        fn absent_conversation_file_adopts_verified_remote() {
            let dir = scratch("absent");
            let t = FakeTransport::new();
            let remote_bytes = seal_conversation(vec![turn("t1", "hello")], Some("remote-title"));
            let rec = serve_remote(&t, &remote_bytes, 2);
            let phase = run_conversation_phase(&IO, &t, &dir, Some(&rec)).unwrap();
            assert!(
                phase.push_bytes.is_none(),
                "verbatim adoption pushes nothing"
            );
            assert!(phase.remote.is_some());
            assert_eq!(
                std::fs::read(dir.join("chats").join(hex(&CONV))).unwrap(),
                remote_bytes,
                "adoption is byte-verbatim"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // A conversation file that exists but cannot be READ refuses for the
        // cycle: it must not merge as the empty turn list (which would adopt
        // the remote over turns that never reached the server).
        #[test]
        fn unreadable_conversation_file_refuses_for_the_cycle() {
            let dir = scratch("unreadable-conv");
            let io = FailReads;
            let t = FakeTransport::new();
            let remote_bytes = seal_conversation(vec![turn("t1", "hello")], Some("remote-title"));
            let rec = serve_remote(&t, &remote_bytes, 2);
            let err = run_conversation_phase(&io, &t, &dir, Some(&rec)).unwrap_err();
            assert!(
                matches!(err, SyncCycleError::Io),
                "a failed read refuses, never merges-as-empty"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // The merge carries the title snapshot: local wins on disagreement,
        // and the merged file keeps the § 9.24.2 shape.
        #[test]
        fn conversation_merge_keeps_the_local_title() {
            let dir = scratch("title");
            let t = FakeTransport::new();
            write_local(
                &dir,
                &seal_conversation(vec![turn("t1", "hello")], Some("local-title")),
            );
            let remote_bytes = seal_conversation(
                vec![turn("t1", "hello"), turn("t2", "and more")],
                Some("remote-title"),
            );
            let rec = serve_remote(&t, &remote_bytes, 2);
            let phase = run_conversation_phase(&IO, &t, &dir, Some(&rec)).unwrap();
            assert!(
                phase.push_bytes.is_some(),
                "a merge that beats the server pushes"
            );
            let merged =
                open_conversation(&std::fs::read(dir.join("chats").join(hex(&CONV))).unwrap());
            assert_eq!(turn_ids(&merged), vec!["t1".to_string(), "t2".to_string()]);
            assert_eq!(
                merged.get("title_derived_from").and_then(|s| s.as_str()),
                Some("local-title"),
                "the local snapshot survives the merge"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // An agreed title does not churn the nonce: identical turns and an
        // identical snapshot adopt the server bytes verbatim.
        #[test]
        fn conversation_agreed_title_adopts_verbatim() {
            let dir = scratch("title-agree");
            let t = FakeTransport::new();
            let local_bytes = seal_conversation(vec![turn("t1", "hello")], Some("shared-title"));
            write_local(&dir, &local_bytes);
            // A distinct seal of the same turns and title: same plaintext,
            // different outer nonce, so verbatim adoption is observable.
            let remote_bytes = seal_conversation(vec![turn("t1", "hello")], Some("shared-title"));
            let rec = serve_remote(&t, &remote_bytes, 5);
            let phase = run_conversation_phase(&IO, &t, &dir, Some(&rec)).unwrap();
            assert!(phase.push_bytes.is_none(), "an agreed merge pushes nothing");
            assert_eq!(
                std::fs::read(dir.join("chats").join(hex(&CONV))).unwrap(),
                remote_bytes,
                "adoption is byte-verbatim"
            );
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    // ---- myne-md/myne#697: agent-memory plane (sync_memory_phase) ----------

    mod memory_phase {
        // The parent module's seam shims (task 86).
        use super::{blocking, IO};

        use super::super::*;
        use crate::plugins::sync::state::SyncState;
        use crate::plugins::sync::transport::FakeTransport;
        use crate::vault_io::VaultIo;
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine as _;

        const ROOT: [u8; 32] = [0x42; 32];
        const HASH: [u8; 16] = [0x33; 16];
        const ENTRY: [u8; 16] = [0xBB; 16];

        fn scratch(tag: &str) -> std::path::PathBuf {
            let d = std::env::temp_dir().join(format!(
                "myne-memoryphase-{tag}-{}-{:p}",
                std::process::id(),
                &tag
            ));
            std::fs::create_dir_all(&d).unwrap();
            d
        }

        fn memory_catalog_key() -> zeroize::Zeroizing<[u8; 32]> {
            derive_subkey_versioned(MetaVersion::V0_1, &ROOT, SubkeyRole::AgentMemoryCatalogKey)
        }

        fn memory_key() -> zeroize::Zeroizing<[u8; 32]> {
            derive_subkey_versioned(MetaVersion::V0_1, &ROOT, SubkeyRole::AgentMemoryKey)
        }

        fn personality_key() -> zeroize::Zeroizing<[u8; 32]> {
            derive_subkey_versioned(MetaVersion::V0_1, &ROOT, SubkeyRole::AgentPersonalityKey)
        }

        fn row(version: u64) -> serde_json::Value {
            serde_json::json!({"created_at": 1, "updated_at": 1, "version": version})
        }

        fn seal_catalog(map: &serde_json::Value) -> Vec<u8> {
            protocol::encode_agent_memory_catalog_blob_versioned(
                MetaVersion::V0_1,
                &memory_catalog_key(),
                &HASH,
                &serde_json::to_vec(map).unwrap(),
            )
            .unwrap()
        }

        fn seal_entry(id: &[u8; 16], text: &str) -> Vec<u8> {
            let plaintext = serde_json::json!({"text": text}).to_string().into_bytes();
            protocol::encode_agent_memory_blob_versioned(
                MetaVersion::V0_1,
                &memory_key(),
                &HASH,
                id,
                &plaintext,
            )
            .unwrap()
        }

        fn seal_personality(directives: &str) -> Vec<u8> {
            let plaintext = serde_json::json!({"directives": directives})
                .to_string()
                .into_bytes();
            protocol::encode_agent_personality_blob_versioned(
                MetaVersion::V0_1,
                &personality_key(),
                &HASH,
                &plaintext,
            )
            .unwrap()
        }

        fn seal_personality_at(text: &str, updated_at: u64) -> Vec<u8> {
            let plaintext =
                serde_json::json!({"directives": [{"text": text, "updated_at": updated_at}]})
                    .to_string()
                    .into_bytes();
            protocol::encode_agent_personality_blob_versioned(
                MetaVersion::V0_1,
                &personality_key(),
                &HASH,
                &plaintext,
            )
            .unwrap()
        }

        /// Register bytes under `/sync/blob?id=…` and return the record.
        fn serve(t: &FakeTransport, id: &[u8; 16], bytes: &[u8], version: u64) -> ChangedBlob {
            let nonce = read_agent_memory_blob_nonce(bytes)
                .or_else(|| read_agent_memory_catalog_nonce(bytes))
                .or_else(|| read_personality_nonce(bytes))
                .unwrap();
            let body = serde_json::json!({ "ciphertext_b64": B64.encode(bytes) });
            t.on(
                HttpMethod::Get,
                &format!("/sync/blob?id={}", hex(id)),
                200,
                serde_json::to_vec(&body).unwrap(),
            );
            ChangedBlob {
                id: *id,
                content_nonce: nonce,
                version,
                size: bytes.len(),
                attachment_id: None,
            }
        }

        fn run_catalog_phase(
            io: &dyn VaultIo,
            t: &FakeTransport,
            dir: &Path,
            st: &mut SyncState,
            rec: Option<&ChangedBlob>,
        ) -> Result<MemoryPhase, SyncCycleError> {
            let catid = agent_memory_catalog_sync_id(&ROOT);
            blocking(sync_memory_phase(
                io,
                t,
                "tok",
                &ROOT,
                &HASH,
                dir,
                st,
                &catid,
                rec,
                MetaVersion::V0_1,
            ))
        }

        fn run_entry_phase(
            io: &dyn VaultIo,
            t: &FakeTransport,
            dir: &Path,
            st: &mut SyncState,
            rec: Option<&ChangedBlob>,
            remote_wins: bool,
        ) -> Result<MemoryEntryPhase, SyncCycleError> {
            blocking(sync_memory_entry_phase(
                io,
                t,
                "tok",
                &ROOT,
                &HASH,
                dir,
                st,
                &ENTRY,
                rec,
                remote_wins,
                MetaVersion::V0_1,
            ))
        }

        fn run_personality_phase(
            io: &dyn VaultIo,
            t: &FakeTransport,
            dir: &Path,
            st: &mut SyncState,
            rec: Option<&ChangedBlob>,
        ) -> Result<PersonalityPhase, SyncCycleError> {
            let pid = agent_personality_sync_id(&ROOT);
            blocking(sync_personality_phase(
                io,
                t,
                "tok",
                &ROOT,
                &HASH,
                dir,
                st,
                &pid,
                rec,
                MetaVersion::V0_1,
            ))
        }

        fn seed_baseline(st: &mut SyncState, id_hex: &str, nonce_hex: String) {
            st.blobs.insert(
                id_hex.to_string(),
                BlobSyncState {
                    version: 1,
                    content_nonce_hex: nonce_hex,
                    doc_heads_hex: Vec::new(),
                },
            );
        }

        #[test]
        fn skipped_outcome_holds_its_invariants() {
            let phase = skipped_memory_phase();
            assert!(phase.skipped);
            assert!(!phase.dirty);
            assert!(!phase.applied_remote);
            assert!(phase.push_bytes.is_none());
            assert!(phase.merged.is_empty());
            let phase = skipped_personality_phase();
            assert!(phase.skipped);
            assert!(!phase.dirty);
            assert!(!phase.applied_remote);
            assert!(phase.push_bytes.is_none());
        }

        // A virgin no-memories vault stays memory-silent: no file, no
        // record, nothing to push.
        #[test]
        fn virgin_vault_stays_memory_silent() {
            let dir = scratch("virgin");
            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let phase = run_catalog_phase(&IO, &t, &dir, &mut st, None).unwrap();
            assert!(!phase.dirty);
            assert!(!phase.skipped);
            assert!(phase.push_bytes.is_none());
            let phase = run_personality_phase(&IO, &t, &dir, &mut st, None).unwrap();
            assert!(!phase.dirty);
            assert!(!phase.skipped);
            assert!(phase.push_bytes.is_none());
            std::fs::remove_dir_all(&dir).ok();
        }

        // An unreadable local catalog refuses the plane even against a live
        // remote record: the garbage on disk is untouched.
        #[test]
        fn unreadable_local_catalog_skips_the_plane() {
            let dir = scratch("unreadable");
            std::fs::write(dir.join("vault.agent-memory"), b"torn-bytes").unwrap();
            let catid = agent_memory_catalog_sync_id(&ROOT);
            let remote_bytes = seal_catalog(&serde_json::json!({}));
            let t = FakeTransport::new();
            let rec = serve(&t, &catid, &remote_bytes, 3);
            let mut st = SyncState::default();
            let phase = run_catalog_phase(&IO, &t, &dir, &mut st, Some(&rec)).unwrap();
            assert!(phase.skipped, "an unreadable store refuses, never merges");
            assert!(!phase.dirty);
            assert_eq!(
                std::fs::read(dir.join("vault.agent-memory")).unwrap(),
                b"torn-bytes",
                "the refused store is never written"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // Absent local catalog + a verified remote record: adopted verbatim.
        #[test]
        fn absent_catalog_adopts_verified_remote() {
            let dir = scratch("absent-cat");
            let catid = agent_memory_catalog_sync_id(&ROOT);
            let remote_bytes = seal_catalog(&serde_json::json!({hex(&ENTRY): row(1)}));
            let t = FakeTransport::new();
            let rec = serve(&t, &catid, &remote_bytes, 2);
            let mut st = SyncState::default();
            let phase = run_catalog_phase(&IO, &t, &dir, &mut st, Some(&rec)).unwrap();
            assert!(!phase.skipped);
            assert!(
                phase.push_bytes.is_none(),
                "verbatim adoption pushes nothing"
            );
            assert!(phase.applied_remote);
            assert_eq!(
                std::fs::read(dir.join("vault.agent-memory")).unwrap(),
                remote_bytes,
                "adoption is byte-verbatim"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // Local-only change: dirty with the exact local bytes to push.
        #[test]
        fn local_only_catalog_change_pushes() {
            let dir = scratch("local-dirty");
            let local_bytes = seal_catalog(&serde_json::json!({hex(&ENTRY): row(1)}));
            std::fs::write(dir.join("vault.agent-memory"), &local_bytes).unwrap();
            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let phase = run_catalog_phase(&IO, &t, &dir, &mut st, None).unwrap();
            assert!(!phase.skipped);
            assert!(phase.dirty);
            assert_eq!(phase.push_bytes.unwrap(), local_bytes);
            std::fs::remove_dir_all(&dir).ok();
        }

        // A merge that beats the server pushes the merged bytes (local row A
        // + remote row B converge to {A, B}, which equals neither side).
        #[test]
        fn merge_that_beats_the_server_pushes() {
            let dir = scratch("merge-wins");
            let other = [0xCC; 16];
            let local_bytes = seal_catalog(&serde_json::json!({hex(&ENTRY): row(1)}));
            std::fs::write(dir.join("vault.agent-memory"), &local_bytes).unwrap();
            let remote_bytes = seal_catalog(&serde_json::json!({hex(&other): row(1)}));
            let catid = agent_memory_catalog_sync_id(&ROOT);
            let t = FakeTransport::new();
            let rec = serve(&t, &catid, &remote_bytes, 2);
            let mut st = SyncState::default();
            let phase = run_catalog_phase(&IO, &t, &dir, &mut st, Some(&rec)).unwrap();
            assert!(!phase.skipped);
            assert!(phase.dirty, "the merge differs from the server store");
            assert!(phase.applied_remote);
            assert_eq!(phase.merged.len(), 2, "both rows survive the join");
            assert!(phase.push_bytes.is_some());
            std::fs::remove_dir_all(&dir).ok();
        }

        // Enrollment seed order (task 8): a catalog adopted wholesale keeps
        // its tombstones, so an entry deleted before this device enrolled does
        // not resurrect here. The tombstoned row survives verbatim; no entry
        // file is fetched for it.
        #[test]
        fn enrollment_seed_keeps_tombstones_verbatim() {
            let dir = scratch("enroll-tomb");
            let dead = [0xDD; 16];
            let remote_bytes = seal_catalog(&serde_json::json!({
                hex(&ENTRY): row(1),
                hex(&dead): {"created_at": 1, "updated_at": 5, "version": 4, "deleted_at": 5},
            }));
            let catid = agent_memory_catalog_sync_id(&ROOT);
            let t = FakeTransport::new();
            let rec = serve(&t, &catid, &remote_bytes, 2);
            let mut st = SyncState::default();
            let phase = run_catalog_phase(&IO, &t, &dir, &mut st, Some(&rec)).unwrap();
            assert!(!phase.skipped);
            assert!(phase.applied_remote);
            let tomb = &phase.merged[&hex(&dead)];
            assert!(
                tomb.deleted_at.is_some(),
                "the pre-enrollment delete must survive the wholesale seed"
            );
            assert_eq!(phase.merged.len(), 2);
            std::fs::remove_dir_all(&dir).ok();
        }

        // Absent entry file + verified remote: adopted verbatim.
        //
        // The fixture deliberately does NOT pre-create `memories/`: an absent
        // local file is exactly the shape of a device that has never authored a
        // memory of its own, which is the device this arm exists for. A fixture
        // that creates the directory first makes the phase's own
        // `create_dir_all` unreachable and the test passes over the production
        // failure (myne-md/myne#883).
        #[test]
        fn absent_entry_adopts_verified_remote() {
            let dir = scratch("absent-entry");
            assert!(
                !dir.join("memories").exists(),
                "the fixture must start without the directory the phase owes"
            );
            let remote_bytes = seal_entry(&ENTRY, "likes tea");
            let t = FakeTransport::new();
            let rec = serve(&t, &ENTRY, &remote_bytes, 2);
            let mut st = SyncState::default();
            let phase = run_entry_phase(&IO, &t, &dir, &mut st, Some(&rec), true).unwrap();
            assert!(phase.push_bytes.is_none());
            assert!(phase.remote.is_some());
            assert_eq!(
                std::fs::read(dir.join("memories").join(hex(&ENTRY))).unwrap(),
                remote_bytes,
                "adoption is byte-verbatim"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // Locally dirty entry, no remote change: the local bytes push.
        #[test]
        fn dirty_entry_without_remote_change_pushes() {
            let dir = scratch("dirty-entry");
            let local_bytes = seal_entry(&ENTRY, "local text");
            std::fs::create_dir_all(dir.join("memories")).unwrap();
            std::fs::write(dir.join("memories").join(hex(&ENTRY)), &local_bytes).unwrap();
            let mut st = SyncState::default();
            seed_baseline(&mut st, &hex(&ENTRY), hex(&[0x00; 24]));
            let t = FakeTransport::new();
            let phase = run_entry_phase(&IO, &t, &dir, &mut st, None, false).unwrap();
            assert_eq!(phase.push_bytes.unwrap(), local_bytes);
            assert!(phase.remote.is_none());
            std::fs::remove_dir_all(&dir).ok();
        }

        // Both sides changed: the catalog winner decides. Remote winner →
        // adopt; local winner → push ours.
        #[test]
        fn both_changed_entry_defers_to_the_catalog_winner() {
            for (remote_wins, tag) in [(true, "remote"), (false, "local")] {
                let dir = scratch(&format!("both-changed-{tag}"));
                let local_bytes = seal_entry(&ENTRY, "local text");
                std::fs::create_dir_all(dir.join("memories")).unwrap();
                std::fs::write(dir.join("memories").join(hex(&ENTRY)), &local_bytes).unwrap();
                let remote_bytes = seal_entry(&ENTRY, "remote text");
                let t = FakeTransport::new();
                let rec = serve(&t, &ENTRY, &remote_bytes, 4);
                let mut st = SyncState::default();
                seed_baseline(&mut st, &hex(&ENTRY), hex(&[0x00; 24]));
                let phase =
                    run_entry_phase(&IO, &t, &dir, &mut st, Some(&rec), remote_wins).unwrap();
                if remote_wins {
                    assert!(phase.push_bytes.is_none());
                    assert_eq!(
                        std::fs::read(dir.join("memories").join(hex(&ENTRY))).unwrap(),
                        remote_bytes,
                        "the catalog winner's file is adopted"
                    );
                } else {
                    assert_eq!(
                        phase.push_bytes.unwrap(),
                        local_bytes,
                        "the local winner's file pushes"
                    );
                }
                std::fs::remove_dir_all(&dir).ok();
            }
        }

        // Personality: remote-only adopts (applied, nothing to push);
        // local-only pushes; both-changed resolves to the remote write.
        #[test]
        fn personality_singleton_reconciles_whole_value() {
            let pid = agent_personality_sync_id(&ROOT);
            // Remote-only.
            let dir = scratch("pers-remote");
            let remote_bytes = seal_personality("be terse");
            let t = FakeTransport::new();
            let rec = serve(&t, &pid, &remote_bytes, 2);
            let mut st = SyncState::default();
            let phase = run_personality_phase(&IO, &t, &dir, &mut st, Some(&rec)).unwrap();
            assert!(!phase.skipped);
            assert!(phase.applied_remote);
            assert!(!phase.dirty);
            assert_eq!(
                std::fs::read(dir.join("vault.personality")).unwrap(),
                remote_bytes
            );
            std::fs::remove_dir_all(&dir).ok();
            // Local-only.
            let dir = scratch("pers-local");
            let local_bytes = seal_personality("be warm");
            std::fs::write(dir.join("vault.personality"), &local_bytes).unwrap();
            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let phase = run_personality_phase(&IO, &t, &dir, &mut st, None).unwrap();
            assert!(phase.dirty);
            assert_eq!(phase.push_bytes.unwrap(), local_bytes);
            std::fs::remove_dir_all(&dir).ok();
            // Both changed: the remote write wins.
            let dir = scratch("pers-both");
            let local_bytes = seal_personality("be warm");
            std::fs::write(dir.join("vault.personality"), &local_bytes).unwrap();
            let remote_bytes = seal_personality("be terse");
            let t = FakeTransport::new();
            let rec = serve(&t, &pid, &remote_bytes, 3);
            let mut st = SyncState::default();
            seed_baseline(&mut st, &hex(&pid), hex(&[0x00; 24]));
            let phase = run_personality_phase(&IO, &t, &dir, &mut st, Some(&rec)).unwrap();
            assert!(!phase.dirty, "whole-value LWW resolves to one side");
            assert!(phase.applied_remote);
            assert_eq!(
                std::fs::read(dir.join("vault.personality")).unwrap(),
                remote_bytes,
                "the remote write wins a concurrent edit"
            );
            std::fs::remove_dir_all(&dir).ok();
            // Both changed, local fresher: the greater updated_at wins (§10.2.7).
            let dir = scratch("pers-fresh-local");
            let local_bytes = seal_personality_at("be warm", 3_000);
            std::fs::write(dir.join("vault.personality"), &local_bytes).unwrap();
            let remote_bytes = seal_personality_at("be terse", 2_000);
            let t = FakeTransport::new();
            let rec = serve(&t, &pid, &remote_bytes, 3);
            let mut st = SyncState::default();
            seed_baseline(&mut st, &hex(&pid), hex(&[0x00; 24]));
            let phase = run_personality_phase(&IO, &t, &dir, &mut st, Some(&rec)).unwrap();
            assert!(phase.dirty, "the fresher local write must push");
            assert!(!phase.applied_remote);
            assert_eq!(
                std::fs::read(dir.join("vault.personality")).unwrap(),
                local_bytes,
                "the fresher side wins a concurrent edit"
            );
            std::fs::remove_dir_all(&dir).ok();
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
            let bytes = encode_themes_map(MetaVersion::V0_1, &themes_key(), &HASH, map).unwrap();
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
            let bytes = encode_themes_map(MetaVersion::V0_1, &themes_key(), &HASH, map).unwrap();
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

        // The addressing switch that lets a member sync shared singletons: an
        // owner/pre-B2B session keeps the historical root-derived id, an `NTV6`
        // session derives it from the group key (`GroupRole`), so an owner and a
        // member holding the same epoch compute the SAME id while a member can
        // never reproduce the root-derived one.
        #[test]
        fn shared_sync_ids_are_group_derived_for_ntv6_and_root_derived_for_ntv5() {
            let root = [0x33u8; 32];
            let group = zeroize::Zeroizing::new([0x77u8; 32]);
            let owner = SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(root));
            let member = SharedSingletonKey::Group(group.clone());
            for (role, group_role) in [
                (
                    SubkeyRole::CatalogSyncId,
                    protocol::GroupRole::CatalogSyncId,
                ),
                (SubkeyRole::PrefsSyncId, protocol::GroupRole::PrefsSyncId),
                (SubkeyRole::ThemesSyncId, protocol::GroupRole::ThemesSyncId),
            ] {
                // The owner id is unchanged by this switch.
                assert_eq!(shared_sync_id(&owner, role), sync_id_for(&root, role));
                // The NTV6 id is the group derivation's first 16 bytes.
                let derived = protocol::derive_group_subkey_v0_2(
                    &protocol::GroupKey::new(*group),
                    group_role,
                );
                let mut expected = [0u8; 16];
                expected.copy_from_slice(&derived[..16]);
                assert_eq!(shared_sync_id(&member, role), expected);
                // A member could never have produced the root-derived id.
                assert_ne!(shared_sync_id(&member, role), shared_sync_id(&owner, role));
            }
            // Distinct per family, so two blob families never collide.
            assert_ne!(
                shared_sync_id(&member, SubkeyRole::PrefsSyncId),
                shared_sync_id(&member, SubkeyRole::ThemesSyncId)
            );
        }

        // The chats / agent-memory / agent-personality catalogs are ROOT-derived
        // even on an `NTV6` session, because they are person-private and have no
        // `GroupRole` (decisions/protocol/0609, 0608). Routing them through
        // `shared_sync_id` on a group session hit the `expect` and panicked the
        // whole cycle (myne-md/myne#791). This pins both halves: their id helper
        // is the root derivation, and it must not be reachable through the group
        // tier at all.
        #[test]
        fn private_catalogs_stay_root_derived_and_have_no_group_role() {
            let root = [0x33u8; 32];
            for (role, id) in [
                (SubkeyRole::ChatsCatalogSyncId, chats_catalog_sync_id(&root)),
                (
                    SubkeyRole::AgentMemoryCatalogSyncId,
                    agent_memory_catalog_sync_id(&root),
                ),
                (
                    SubkeyRole::AgentPersonalitySyncId,
                    agent_personality_sync_id(&root),
                ),
            ] {
                assert_eq!(id, sync_id_for(&root, role));
                assert!(
                    role.shared_group_role().is_none(),
                    "{role:?} must have no GroupRole: it is person-private, not shared"
                );
            }
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
                &IO,
                &t,
                "tok",
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &tid,
                None,
                MetaVersion::V0_1,
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
                &IO,
                &t,
                "tok",
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &tid,
                None,
                MetaVersion::V0_1,
            ))
            .unwrap();
            assert!(phase.dirty, "an unsynced local theme must push");
            // The phase carries the bytes the push will send (myne#436) — the
            // push site derives no key and re-reads nothing.
            assert_eq!(
                phase.push_bytes.as_deref().map(|b| &b[0..4]),
                Some(protocol::THEMES_BLOB_MAGIC.as_slice()),
                "a dirty phase must hand the push its verified bytes"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        /// A MIGRATED vault's dirty theme store must still produce pushable
        /// bytes — sealed `MYT5` under the v0.2 KEK (myne-md/myne#436).
        ///
        /// The failure this pins is silent by construction, which is why it
        /// survived a release. `read_verified_themes_bytes` is a strict verifier:
        /// handed a KEK that does not open the blob it answers `None`, not an
        /// error. So a generation-blind derivation does not fail the cycle, log
        /// anything, or surface a toast — the themes push is simply skipped, and
        /// every other device stops receiving the user's theme edits forever
        /// while sync reports success.
        ///
        /// Asserting `dirty` alone would NOT catch it (the flag is computed from
        /// the outer nonce, which needs no key), and asserting "no error" catches
        /// nothing at all. The load-bearing assertion is that bytes come out AND
        /// that they are the v0.2 family.
        #[test]
        fn a_migrated_vault_still_pushes_its_myt5_theme_store() {
            let dir = scratch("migrated-push");
            let v0_2_key = protocol::derive_subkey_versioned(
                MetaVersion::V0_2,
                &ROOT,
                SubkeyRole::CustomThemesKey,
            );
            let map = ThemesMap::from([theme("nord", "#88c0d0", T0)]);
            let bytes = encode_themes_map(MetaVersion::V0_2, &v0_2_key, &HASH, &map).unwrap();
            assert_eq!(
                &bytes[0..4],
                protocol::THEMES_BLOB_V0_2_MAGIC.as_slice(),
                "fixture must be a v0.2 store or the test proves nothing"
            );
            std::fs::write(dir.join("vault.themes"), &bytes).unwrap();

            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let tid = themes_sync_id(&ROOT);
            let phase = blocking(sync_themes_phase(
                &IO,
                &t,
                "tok",
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &tid,
                None,
                MetaVersion::V0_2,
            ))
            .unwrap();

            assert!(phase.dirty, "an unsynced migrated theme store must push");
            let pushed = phase
                .push_bytes
                .expect("a migrated vault's dirty store must reach the push");
            assert_eq!(
                &pushed[0..4],
                protocol::THEMES_BLOB_V0_2_MAGIC.as_slice(),
                "the push must carry the v0.2 store, not a v0.1 re-seal"
            );
            // And it is the user's store, not an empty one read through the
            // §9.21.4 fallback.
            assert_eq!(
                crate::plugins::themes::commands::decode_themes_map_or_empty(
                    &v0_2_key,
                    &HASH,
                    Some(&pushed)
                ),
                map,
                "the pushed store must be the themes the user actually has"
            );
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
                    doc_heads_hex: Vec::new(),
                },
            );
            let t = FakeTransport::new();

            let phase = blocking(sync_themes_phase(
                &IO,
                &t,
                "tok",
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &tid,
                None,
                MetaVersion::V0_1,
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
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &tid,
                Some(&rec),
                MetaVersion::V0_1,
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
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &tid,
                Some(&rec),
                MetaVersion::V0_1,
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
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &tid,
                Some(&rec),
                MetaVersion::V0_1,
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
                .expect("the store is readable here")
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
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &tid,
                Some(&rec),
                MetaVersion::V0_1,
            ))
            .unwrap();
            assert!(phase.dirty, "the local store re-pushes over the garbage");
            assert_eq!(read_local(&dir), local, "nothing lost");
            // §11.3: the baseline must NOT be adopted either. Before the
            // pre-write gate landed, this silently became `[0x9e; 24]` — a
            // baseline for a revision the client does not hold — and the test
            // did not look.
            assert!(
                !st.blobs.contains_key(&hex(&tid)),
                "a record whose bytes failed verification must leave no baseline"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        /// The case the old code actually destroyed data in, and the reason the
        /// check has to run BEFORE the write rather than being inferred from
        /// the merge outcome.
        ///
        /// With no local store, `decode_themes_map_or_empty` yields empty for
        /// the junk too, so `merged == remote_map` holds and the adopt arm
        /// writes the junk to `vault.themes` verbatim. Worse, the junk carries
        /// no `MYT1` magic, so on the next cycle `read_themes_nonce` of the
        /// on-disk file is `None`: the push-side `if let Some(nonce)` guard
        /// adds nothing to `to_push`, `dirty` stays true forever, and the blob
        /// can never heal.
        #[test]
        fn junk_never_reaches_disk_when_there_is_no_local_store() {
            let dir = scratch("hostile-virgin");
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
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &tid,
                Some(&rec),
                MetaVersion::V0_1,
            ))
            .unwrap();

            assert!(
                !dir.join("vault.themes").exists(),
                "unverified bytes must never be written; a virgin store stays virgin"
            );
            assert!(
                !st.blobs.contains_key(&hex(&tid)),
                "no baseline may be adopted for bytes that were never verified"
            );
            assert!(!phase.applied_remote, "nothing was applied");
            std::fs::remove_dir_all(&dir).ok();
        }

        /// myne#386 end-to-end: a palette carrying an off-grammar value
        /// arrives through the merge, is stored verbatim — and does not reach a
        /// reader.
        ///
        /// The attacker is anything holding `root_key` that writes
        /// `vault.themes` without running the validator: a second enrolled
        /// device on a modified or older build, a hand-crafted `MYT1`, or a
        /// restored backup. **Not** a hostile server — the blob is AEAD-sealed
        /// under `DeriveSubkey(root_key, "custom-themes-key")`, so TB5 can only
        /// withhold or replay, which is what the neighbouring tests cover.
        ///
        /// The merge deliberately keeps the bytes: `merge_custom_themes` clones
        /// a name only the peer has, and the agreeing-store arm adopts the
        /// server's bytes verbatim. Filtering there would fight the CRDT and
        /// churn the nonce. The read is the right chokepoint, and this asserts
        /// the two halves together — the store keeps what the peer sent, the
        /// reader does not see it.
        #[test]
        fn an_off_grammar_palette_from_a_peer_never_reaches_a_reader() {
            let dir = scratch("hostile-palette");
            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let tid = themes_sync_id(&ROOT);

            // A peer's theme whose accent is the CSS escape hatch the
            // allowlist exists to close, alongside one well-formed token.
            let mut palette = ThemePalette::from([(
                "--accent".to_string(),
                "url(https://evil.example/x)".to_string(),
            )]);
            palette.insert("--ink-1".into(), "#123456".into());
            let remote = ThemesMap::from([("peer".to_string(), ThemeEntry::live(palette, T0))]);
            let rec = serve_remote(&t, &tid, &remote);

            let phase = blocking(sync_themes_phase(
                &IO,
                &t,
                "tok",
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &tid,
                Some(&rec),
                MetaVersion::V0_1,
            ))
            .unwrap();
            assert!(phase.applied_remote, "the peer's theme was adopted");

            // The store holds what the peer sent — the merge is not the place
            // this gets fixed, and pretending otherwise would hide the point.
            let stored = read_local(&dir);
            assert_eq!(
                stored["peer"].palette.get("--accent").map(String::as_str),
                Some("url(https://evil.example/x)"),
                "the merge stores the peer's bytes verbatim, by design"
            );

            // The reader — the only path to `applyCustomTheme` and the CSSOM —
            // does not.
            let read = blocking(crate::plugins::themes::commands::themes_read_in_dir(
                &IO,
                &dir,
                &themes_key(),
                &HASH,
                "peer",
            ))
            .expect("read");
            assert!(
                !read.contains_key("--accent"),
                "an off-grammar value must not survive the read that feeds the DOM"
            );
            assert_eq!(
                read.get("--ink-1").map(String::as_str),
                Some("#123456"),
                "the rest of the palette is kept — this filters, it does not reject"
            );

            std::fs::remove_dir_all(&dir).ok();
        }

        /// A well-formed `MYT1` blob for this vault, served under a record that
        /// advertises a DIFFERENT nonce. Everything decrypts; only the identity
        /// of the revision is wrong. This is the case `decode_*` cannot catch
        /// and the one a malicious server actually has cheap access to — it
        /// replays a genuine older revision under a newer record.
        #[test]
        fn a_genuine_blob_under_a_lying_record_is_skipped() {
            let dir = scratch("lying-record");
            let local = ThemesMap::from([theme("nord", "#88c0d0", T0)]);
            write_local(&dir, &local);
            let before = std::fs::read(dir.join("vault.themes")).unwrap();

            let remote = ThemesMap::from([theme("gruvbox", "#282828", T0 + 1)]);
            let remote_bytes =
                encode_themes_map(MetaVersion::V0_1, &themes_key(), &HASH, &remote).unwrap();

            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let tid = themes_sync_id(&ROOT);
            let body = serde_json::json!({ "ciphertext_b64": B64.encode(&remote_bytes) });
            t.on(
                HttpMethod::Get,
                &format!("/sync/blob?id={}", hex(&tid)),
                200,
                serde_json::to_vec(&body).unwrap(),
            );
            // The record advertises a nonce these bytes do not carry.
            let rec = ChangedBlob {
                id: tid,
                content_nonce: [0x11; 24],
                version: 9,
                size: remote_bytes.len(),
                attachment_id: None,
            };

            let phase = blocking(sync_themes_phase(
                &IO,
                &t,
                "tok",
                &SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new(ROOT)),
                &HASH,
                &dir,
                &mut st,
                &tid,
                Some(&rec),
                MetaVersion::V0_1,
            ))
            .unwrap();

            assert_eq!(
                std::fs::read(dir.join("vault.themes")).unwrap(),
                before,
                "the live file must be byte-untouched"
            );
            assert_eq!(read_local(&dir), local, "the local store is unchanged");
            assert!(
                !st.blobs.contains_key(&hex(&tid)),
                "the prior baseline stays authoritative"
            );
            assert!(!phase.applied_remote);
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    mod member_names_phase {
        //! `vault.member-names` (task 3b-ii): the singleton classification and the
        //! pull-merge hook. The family is `NTV6`-only, so every fixture is a group-tier
        //! session over a real `vault.meta`.

        // The parent module's seam shims (task 86).
        use super::{blocking, fresh_vault, meta_json, pull_body, pull_body_with_head, IO};

        use super::super::*;
        use crate::plugins::sync::state::SyncState;
        use crate::plugins::sync::transport::FakeTransport;
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine as _;
        use protocol::person_key::PersonKeyPair;

        // The constants and the NTV6 fixture below are `pub(super)` because the
        // device-bindings phase module beside this one drives the SAME vault shape:
        // one `group_key_epoch`, one account hash, one structural `vault.meta`. A
        // second copy of the seal sequence there would be a second opinion about what
        // the resolver reads, and the two phases have to agree about it or the failure
        // looks like a fixture problem in whichever one was edited last.
        pub(super) const GROUP: [u8; 32] = [0x77; 32];
        pub(super) const HASH: [u8; 16] = [0x5c; 16];
        pub(super) const EPOCH: u64 = 3;

        pub(super) fn scratch(tag: &str) -> std::path::PathBuf {
            let d = std::env::temp_dir().join(format!(
                "myne-namesphase-{tag}-{}-{:p}",
                std::process::id(),
                &tag
            ));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            d
        }

        pub(super) fn group_tier() -> SharedSingletonKey {
            SharedSingletonKey::Group(zeroize::Zeroizing::new(GROUP))
        }

        fn names_key() -> zeroize::Zeroizing<[u8; 32]> {
            protocol::derive_group_subkey_v0_2(
                &protocol::GroupKey::new(GROUP),
                protocol::GroupRole::MemberNamesKey,
            )
        }

        pub(super) fn person(kem: u8, ed: u8, mldsa: u8) -> PersonKeyPair {
            PersonKeyPair::generate_raw(&[kem; 64], &[ed; 32], &[mldsa; 32])
        }

        /// A structurally valid `NTV6` `vault.meta` at `epoch`, built exactly as a
        /// migration/seal does, so `parse_vault_meta_ntv6` accepts it and the family's
        /// resolver reads the epoch its AAD binds.
        pub(super) fn ntv6_meta_bytes(epoch: u64) -> Vec<u8> {
            let root_key = [7u8; 32];
            let items_key = [9u8; 32];
            let items_key_id = [0x07u8; 16];
            let mut base = protocol::parse_vault_meta_v0_2(
                &protocol::encode_vault_meta_v0_2_raw(
                    &root_key,
                    &items_key,
                    &items_key_id,
                    "pw",
                    "abandon abandon abandon",
                    &HASH,
                    &protocol::DEFAULT_V0_1_KDF_PARAMS,
                    &[2u8; protocol::ARGON2_SALT_LEN],
                    &[4u8; protocol::ARGON2_SALT_LEN],
                    &[5u8; protocol::AEAD_NONCE_LEN],
                    &[6u8; protocol::AEAD_NONCE_LEN],
                    &[8u8; protocol::AEAD_NONCE_LEN],
                )
                .expect("encode NTV5 base"),
            )
            .expect("parse NTV5 base");
            let group_key = protocol::GroupKey::new(GROUP);
            let group_nonce = [12u8; protocol::AEAD_NONCE_LEN];
            let items_nonce = [13u8; protocol::AEAD_NONCE_LEN];
            let enc_group = protocol::aead_seal_ctx(
                &protocol::derive_owner_subkey_v0_2(
                    &protocol::OwnerKey::new(root_key),
                    protocol::OwnerRole::GroupKeyWrap,
                ),
                &group_nonce,
                &GROUP,
                &protocol::aad_vault_group_key_wrap_v0_2(&HASH, epoch),
            )
            .expect("seal group key");
            let enc_items = protocol::aead_seal_ctx(
                &protocol::derive_group_subkey_v0_2(&group_key, protocol::GroupRole::ItemsKeyWrap),
                &items_nonce,
                &items_key,
                &protocol::aad_vault_items_key_wrap_v0_2(&items_key_id),
            )
            .expect("seal items key");
            base.items_key_nonce = items_nonce;
            base.enc_items_key.copy_from_slice(&enc_items);
            let signed_roster_envelope = protocol::person_invite::seal_group_roster(
                &GROUP,
                &HASH,
                epoch,
                &[0xE6; protocol::AEAD_NONCE_LEN],
                &protocol::person_invite::SignedGroupRoster {
                    payload: vec![0xC3; 32],
                    signature: protocol::person_key::PersonSigned {
                        ed25519_sig: [0xD4; protocol::person_key::PERSON_ED25519_SIG_LEN],
                        mldsa_sig: vec![0xE5; protocol::person_key::PERSON_MLDSA_SIG_LEN],
                    },
                },
            )
            .expect("seal roster envelope");
            protocol::serialize_vault_meta_ntv6(&protocol::B2bVaultMeta {
                base,
                group_key_nonce: group_nonce,
                enc_group_key: enc_group.try_into().expect("fixed group-key wrap"),
                group_key_epoch: epoch,
                signed_roster_envelope,
            })
            .expect("serialize NTV6")
        }

        pub(super) fn seed_meta(dir: &Path) {
            std::fs::write(dir.join("vault.meta"), ntv6_meta_bytes(EPOCH)).unwrap();
        }

        /// One row, signed by the person it names (the only shape the codec accepts).
        fn row(
            who: &PersonKeyPair,
            person_id: &[u8; 16],
            version: u64,
            name: &str,
        ) -> protocol::MemberNameEntry {
            let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
            protocol::sign_member_name(who, person_id, version, false, name, &mut rng).unwrap()
        }

        /// A map holding exactly one row.
        fn one_row(
            who: &PersonKeyPair,
            person_id: &[u8; 16],
            version: u64,
            name: &str,
        ) -> protocol::MemberNamesMap {
            let mut map = protocol::MemberNamesMap::new();
            map.insert(hex(person_id), row(who, person_id, version, name));
            map
        }

        fn write_local(dir: &Path, map: &protocol::MemberNamesMap) -> Vec<u8> {
            let bytes =
                protocol::encode_member_names_blob(&names_key(), &HASH, EPOCH, map).unwrap();
            std::fs::write(dir.join("vault.member-names"), &bytes).unwrap();
            bytes
        }

        /// Encode a remote store and register its blob under `/sync/blob?id=…`.
        fn serve_remote(
            t: &FakeTransport,
            id: &[u8; 16],
            bytes: &[u8],
            version: u64,
        ) -> ChangedBlob {
            let nonce = read_member_names_nonce(bytes).unwrap();
            let body = serde_json::json!({ "ciphertext_b64": B64.encode(bytes) });
            t.on(
                HttpMethod::Get,
                &format!("/sync/blob?id={}", hex(id)),
                200,
                serde_json::to_vec(&body).unwrap(),
            );
            ChangedBlob {
                id: *id,
                content_nonce: nonce,
                version,
                size: bytes.len(),
                attachment_id: None,
            }
        }

        // The family is addressed through the GROUP tier only: a pre-B2B `OwnerRoot`
        // session has no group key, and this family has no `SubkeyRole` counterpart to
        // derive a root-tier id from. So the id helper answers `None`, and the phase
        // generates no traffic at all rather than deriving a key no member could read.
        #[test]
        fn a_pre_b2b_session_has_no_member_names_phase() {
            let dir = scratch("pre-b2b");
            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let id = [0x0a; 16];
            let owner = SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new([0x33; 32]));
            assert!(
                member_names_sync_id(&owner).is_none(),
                "a group-derived id must not be expressible on the root tier"
            );
            let phase = blocking(sync_member_names_phase(
                &IO, &t, "tok", &owner, &dir, &mut st, &id, None,
            ))
            .unwrap();
            assert!(!phase.dirty, "a pre-B2B vault has no name store to push");
            assert!(!phase.applied_remote);
            assert!(phase.push_bytes.is_none());
            assert!(
                t.requests().is_empty(),
                "a pre-B2B vault generates no member-names traffic"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // The id is group-derived and per-family, so an owner and a member of one epoch
        // compute the SAME id and two families never collide on one.
        #[test]
        fn the_member_names_id_agrees_with_the_group_derivation_and_no_sibling() {
            let member = group_tier();
            let id = member_names_sync_id(&member).expect("group tier");
            assert_eq!(id, crate::plugins::member_names::names_sync_id(&GROUP));
            assert_ne!(id, shared_sync_id(&member, SubkeyRole::ThemesSyncId));
            assert_ne!(id, shared_sync_id(&member, SubkeyRole::PrefsSyncId));
            assert_ne!(id, shared_sync_id(&member, SubkeyRole::CatalogSyncId));
        }

        // A name the server has never seen ⇒ the phase reports dirty AND carries the
        // exact bytes the push must send (the myne#436 single-derivation discipline: the
        // push site re-reads nothing).
        #[test]
        fn a_local_only_name_is_dirty_and_the_phase_carries_its_bytes() {
            let dir = scratch("local-only");
            seed_meta(&dir);
            let ann = person(0x11, 0x12, 0x13);
            let ann_id = [0x21; 16];
            write_local(&dir, &one_row(&ann, &ann_id, 1, "Ada"));

            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let id = member_names_sync_id(&group_tier()).unwrap();
            let phase = blocking(sync_member_names_phase(
                &IO,
                &t,
                "tok",
                &group_tier(),
                &dir,
                &mut st,
                &id,
                None,
            ))
            .unwrap();
            assert!(phase.dirty, "an unsynced local name must push");
            assert!(!phase.applied_remote);
            assert_eq!(
                phase.push_bytes.as_deref().map(|b| &b[0..4]),
                Some(protocol::MEMBER_NAMES_BLOB_MAGIC.as_slice()),
                "a dirty phase must hand the push its verified bytes"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // `merge(local, empty) == local`, so a pulled copy that fails the AEAD must be
        // REFUSED with no local mutation: merging it as empty would discard a peer's
        // rename and then write that emptiness back over it. The served bytes carry our
        // magic and an advertised nonce, so they pass the §11.3 header check and fail
        // only the decrypt: exactly the copy this arm exists for.
        #[test]
        fn a_pulled_copy_that_does_not_decode_is_refused() {
            let dir = scratch("refuse");
            seed_meta(&dir);
            let ann = person(0x11, 0x12, 0x13);
            let ann_id = [0x21; 16];
            let before = write_local(&dir, &one_row(&ann, &ann_id, 1, "Ada"));

            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let id = member_names_sync_id(&group_tier()).unwrap();

            let mut junk = Vec::from(protocol::MEMBER_NAMES_BLOB_MAGIC);
            junk.extend_from_slice(&[0x01, 0x01]);
            junk.extend_from_slice(&[0xAB; 24]);
            junk.extend_from_slice(&8u32.to_be_bytes());
            junk.extend_from_slice(&[0x00; 8]);
            t.on(
                HttpMethod::Get,
                &format!("/sync/blob?id={}", hex(&id)),
                200,
                serde_json::to_vec(&serde_json::json!({ "ciphertext_b64": B64.encode(&junk) }))
                    .unwrap(),
            );
            let rec = ChangedBlob {
                id,
                content_nonce: [0xAB; 24],
                version: 9,
                size: junk.len(),
                attachment_id: None,
            };

            let phase = blocking(sync_member_names_phase(
                &IO,
                &t,
                "tok",
                &group_tier(),
                &dir,
                &mut st,
                &id,
                Some(&rec),
            ))
            .unwrap();
            assert!(!phase.dirty, "a refused copy must not dirty the store");
            assert!(!phase.applied_remote);
            assert_eq!(
                std::fs::read(dir.join("vault.member-names")).unwrap(),
                before,
                "the live file must be byte-untouched"
            );
            assert!(
                !st.blobs.contains_key(&hex(&id)),
                "no baseline may be adopted for a refused copy"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // A remote copy is pulled and MERGED entry by entry, and the merge is reported
        // where the WebView can see it: on the cycle summary. The remote row (Bob) and
        // the local row (Ann) are a concurrent rename of DIFFERENT rows, so both must
        // survive, and with the flag false the roster would keep drawing the stale name
        // until something else happened to re-read it.
        #[test]
        fn a_pulled_member_name_is_merged_and_reported_at_the_cycle_boundary() {
            use protocol::vault_head::VAULT_HEAD_FORMAT_V2;

            let (dir, notes) = fresh_vault("member-names-cycle");
            seed_meta(&dir);

            let ann = person(0x11, 0x12, 0x13);
            let ann_id = [0x21; 16];
            let bob = person(0x31, 0x32, 0x33);
            let bob_id = [0x41; 16];
            write_local(&dir, &one_row(&ann, &ann_id, 1, "Ada"));

            // The server holds only Bob's row, at a version it never shared.
            let remote_bytes = protocol::encode_member_names_blob(
                &names_key(),
                &HASH,
                EPOCH,
                &one_row(&bob, &bob_id, 1, "Grace"),
            )
            .unwrap();
            let names_id = member_names_sync_id(&group_tier()).unwrap();

            // A signed head so the cycle adopts the server's rather than authoring a
            // genesis (a push route this test does not need).
            let person = person(0x51, 0x52, 0x53);
            let person_public = person.public_half();
            let ctx = SignedHeadCtx::new(person, HASH, vec![person_public]);
            let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
            let head = VaultHead {
                head_format_version: VAULT_HEAD_FORMAT_V2,
                account_number_hash: HASH,
                manifest_hash: [0u8; 32],
                seq: 1,
                prev_head_hash: Vec::new(),
                version_vector: vec![VvEntry {
                    device_id: [0x99; 16],
                    counter: 1,
                }],
            };
            let sealed = ctx.sign(&head, &mut rng).unwrap();
            let head_frag = (B64.encode(&sealed.record), hex(&sealed.head_id));

            let t = FakeTransport::new();
            let remote_nonce = read_member_names_nonce(&remote_bytes).unwrap();
            t.on(
                HttpMethod::Get,
                "/sync/pull?cursor=0",
                200,
                pull_body_with_head(&meta_json(&names_id, 4, &remote_nonce), 1, &head_frag),
            );
            t.on(
                HttpMethod::Get,
                "/sync/pull?cursor=1",
                200,
                pull_body("", 1),
            );
            t.on(
                HttpMethod::Get,
                &format!("/sync/blob?id={}", hex(&names_id)),
                200,
                serde_json::to_vec(
                    &serde_json::json!({ "ciphertext_b64": B64.encode(&remote_bytes) }),
                )
                .unwrap(),
            );

            let items_key = [0x44u8; 32];
            let items_key_id = [0x55u8; 16];
            let summary = blocking(run_sync_cycle(
                &IO,
                &t,
                None,
                &group_tier(),
                HASH,
                [0x0a; 16],
                "tok",
                &notes,
                &dir,
                PushGate::PollOnly,
                MetaVersion::V0_2,
                Some(AttachmentKeys {
                    items_key: &items_key,
                    items_key_id: &items_key_id,
                }),
                Some(&ctx),
                &std::collections::HashSet::new(),
            ))
            .expect("cycle runs");

            assert!(
                summary.member_names_applied_remote,
                "a merged remote name must be reported at the cycle boundary"
            );
            let on_disk = std::fs::read(dir.join("vault.member-names")).unwrap();
            let merged =
                protocol::decode_member_names_blob(&names_key(), &HASH, EPOCH, &on_disk).unwrap();
            assert_eq!(merged.len(), 2, "both rows survive the merge");
            assert_eq!(merged.get(&hex(&ann_id)).unwrap().name, "Ada");
            assert_eq!(merged.get(&hex(&bob_id)).unwrap().name, "Grace");
            std::fs::remove_dir_all(&dir).ok();
        }
    }

    // The device-bindings phase (member-devices task 3), the `member_names_phase`
    // module's twin and driven the same way: the phase directly for the arms that need
    // no cycle, plus ONE real `run_sync_cycle` for the merge, because the phase's
    // invocation is a `match` arm inside the 14 000-line orchestrator and
    // `core/src/plugins/sync/mod.rs` carries `#![allow(dead_code)]`, so a phase that
    // stopped being called would be silent to clippy, tests and every guard in
    // `scripts/`. The cycle-level test is the only thing in the tree that would notice.
    mod device_bindings_phase {
        use super::member_names_phase::{
            group_tier, person, scratch, seed_meta, EPOCH, GROUP, HASH,
        };
        use super::{blocking, fresh_vault, meta_json, pull_body, pull_body_with_head, IO};

        use super::super::*;
        use crate::plugins::sync::state::{BlobSyncState, SyncState};
        use crate::plugins::sync::transport::FakeTransport;
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine as _;
        use protocol::person_key::PersonKeyPair;

        /// The device-binding KEK, derived exactly as the family's own resolver does, so
        /// a fixture sealed here is one the phase can open.
        fn bindings_key() -> zeroize::Zeroizing<[u8; 32]> {
            protocol::derive_group_subkey_v0_2(
                &protocol::GroupKey::new(GROUP),
                protocol::GroupRole::DeviceBindingKey,
            )
        }

        /// One row, signed by the person it NAMES, which is the only shape
        /// `verify_device_binding` accepts: the signer's own fingerprint has to equal
        /// the fingerprint the row claims. The row key is the device, which is what makes
        /// a merge over this map different from the sibling family's.
        fn row(
            who: &PersonKeyPair,
            device_id: &[u8; 16],
            version: u64,
        ) -> protocol::DeviceBindingEntry {
            let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
            protocol::sign_device_binding(
                who,
                device_id,
                who.fingerprint(),
                version,
                false,
                &mut rng,
            )
            .unwrap()
        }

        /// A map holding exactly one live row for `device_id`.
        fn one_row(
            who: &PersonKeyPair,
            device_id: &[u8; 16],
            version: u64,
        ) -> protocol::DeviceBindingsMap {
            let mut map = protocol::DeviceBindingsMap::new();
            map.insert(hex(device_id), row(who, device_id, version));
            map
        }

        fn write_local(dir: &Path, map: &protocol::DeviceBindingsMap) -> Vec<u8> {
            let bytes =
                protocol::encode_device_binding_blob(&bindings_key(), &HASH, EPOCH, map).unwrap();
            std::fs::write(device_bindings_file_path(dir), &bytes).unwrap();
            bytes
        }

        fn decode(bytes: &[u8]) -> protocol::DeviceBindingsMap {
            protocol::decode_device_binding_blob(&bindings_key(), &HASH, EPOCH, bytes).unwrap()
        }

        /// Encode a remote store and register its blob under `/sync/blob?id=…`, with the
        /// `ChangedBlob` the pull page would carry.
        fn serve_remote(
            t: &FakeTransport,
            id: &[u8; 16],
            bytes: &[u8],
            version: u64,
        ) -> ChangedBlob {
            let nonce = read_device_bindings_nonce(bytes).unwrap();
            let body = serde_json::json!({ "ciphertext_b64": B64.encode(bytes) });
            t.on(
                HttpMethod::Get,
                &format!("/sync/blob?id={}", hex(id)),
                200,
                serde_json::to_vec(&body).unwrap(),
            );
            ChangedBlob {
                id: *id,
                content_nonce: nonce,
                version,
                size: bytes.len(),
                attachment_id: None,
            }
        }

        // The family is addressed through the GROUP tier only, exactly as the sibling is:
        // a pre-B2B `OwnerRoot` session holds no group key, so there is no KEK to derive
        // and no epoch to bind into the AAD. The phase must stand down BEFORE it reads
        // anything, which the empty request log is what proves.
        #[test]
        fn a_pre_b2b_session_has_no_device_bindings_phase() {
            let dir = scratch("bindings-pre-b2b");
            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let id = [0x0b; 16];
            let owner = SharedSingletonKey::OwnerRoot(zeroize::Zeroizing::new([0x33; 32]));
            assert!(
                device_bindings_sync_id(&owner).is_none(),
                "a group-derived id must not be expressible on the root tier"
            );
            let phase = blocking(sync_device_bindings_phase(
                &IO, &t, "tok", &owner, &dir, &mut st, &id, None,
            ))
            .unwrap();
            assert!(!phase.dirty);
            assert!(!phase.applied_remote);
            assert!(phase.push_bytes.is_none());
            assert!(
                t.requests().is_empty(),
                "a pre-B2B vault generates no device-binding traffic"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // Both ids are a 16-byte group-derived value with no `SubkeyRole` counterpart, so
        // the ONLY thing separating this family's sync id from its four siblings' is the
        // domain string inside the derivation. A collision would make the two phases
        // overwrite each other's blob at the server.
        #[test]
        fn the_device_bindings_id_agrees_with_the_group_derivation_and_no_sibling() {
            let member = group_tier();
            let id = device_bindings_sync_id(&member).expect("group tier");
            assert_eq!(id, crate::plugins::device_binding::bindings_sync_id(&GROUP));
            assert_ne!(
                id,
                member_names_sync_id(&member).expect("group tier"),
                "the two group-tier singletons must never share one sync id"
            );
            assert_ne!(id, shared_sync_id(&member, SubkeyRole::ThemesSyncId));
            assert_ne!(id, shared_sync_id(&member, SubkeyRole::PrefsSyncId));
            assert_ne!(id, shared_sync_id(&member, SubkeyRole::CatalogSyncId));
        }

        // Criterion 1 and 3 at the phase layer. A claim written while offline is a local
        // file the server has never seen: the phase reports it dirty AND carries the
        // exact bytes the push must send (the myne#436 single-derivation discipline: the
        // push site re-reads nothing), and those bytes are the row the user's device
        // really wrote rather than a re-derivation of it.
        #[test]
        fn a_local_only_binding_is_dirty_and_the_phase_carries_its_bytes() {
            let dir = scratch("bindings-local-only");
            seed_meta(&dir);
            let me = person(0x11, 0x12, 0x13);
            let mine = [0x21; 16];
            write_local(&dir, &one_row(&me, &mine, 1));

            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let id = device_bindings_sync_id(&group_tier()).unwrap();
            let phase = blocking(sync_device_bindings_phase(
                &IO,
                &t,
                "tok",
                &group_tier(),
                &dir,
                &mut st,
                &id,
                None,
            ))
            .unwrap();
            assert!(
                phase.dirty,
                "a binding claimed while offline must push on the next cycle"
            );
            assert!(!phase.applied_remote);
            let pushed = phase
                .push_bytes
                .as_deref()
                .expect("a dirty phase hands over bytes");
            assert_eq!(
                &pushed[0..4],
                protocol::DEVICE_BINDING_BLOB_MAGIC.as_slice(),
                "a dirty phase must hand the push its verified bytes"
            );
            let map = decode(pushed);
            assert_eq!(map.len(), 1);
            assert!(
                protocol::verify_device_binding(&me.public_half(), &mine, map.get(&hex(&mine)).unwrap()),
                "the bytes pushed are the row this device signed, verified against its own public half"
            );

            // The OTHER half of criterion 1: once the server has that exact nonce
            // recorded as this blob's baseline, the next cycle is not dirty and pushes
            // nothing. Without this the push loop would re-send the same store forever.
            let mut synced = SyncState::default();
            synced.blobs.insert(
                hex(&id),
                BlobSyncState {
                    version: 4,
                    content_nonce_hex: hex(&read_device_bindings_nonce(pushed).unwrap()),
                    doc_heads_hex: Vec::new(),
                },
            );
            let t2 = FakeTransport::new();
            let again = blocking(sync_device_bindings_phase(
                &IO,
                &t2,
                "tok",
                &group_tier(),
                &dir,
                &mut synced,
                &id,
                None,
            ))
            .unwrap();
            assert!(
                !again.dirty && again.push_bytes.is_none(),
                "a store already synced at the server's nonce must push nothing"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // `merge(local, empty) == local`, so a pulled copy that fails the AEAD must be
        // REFUSED with no local mutation: merging it as empty would discard a peer's
        // claim and then write that emptiness back over it. The served bytes are sealed
        // under the WRONG key, so they carry our magic and a real header nonce; they
        // pass the §11.3 gate and fail only the decrypt, which is exactly this arm.
        #[test]
        fn a_pulled_copy_that_does_not_decode_is_refused() {
            let dir = scratch("bindings-refuse");
            seed_meta(&dir);
            let me = person(0x11, 0x12, 0x13);
            let mine = [0x21; 16];
            let before = write_local(&dir, &one_row(&me, &mine, 1));

            let peer = person(0x31, 0x32, 0x33);
            let theirs = [0x41; 16];
            let foreign = protocol::encode_device_binding_blob(
                &[0x99u8; 32],
                &HASH,
                EPOCH,
                &one_row(&peer, &theirs, 1),
            )
            .unwrap();

            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let id = device_bindings_sync_id(&group_tier()).unwrap();
            let rec = serve_remote(&t, &id, &foreign, 9);

            let phase = blocking(sync_device_bindings_phase(
                &IO,
                &t,
                "tok",
                &group_tier(),
                &dir,
                &mut st,
                &id,
                Some(&rec),
            ))
            .unwrap();
            assert!(!phase.dirty, "a refused copy must not dirty the store");
            assert!(!phase.applied_remote);
            assert_eq!(
                std::fs::read(device_bindings_file_path(&dir)).unwrap(),
                before,
                "the live file must be byte-untouched"
            );
            assert!(
                !st.blobs.contains_key(&hex(&id)),
                "no baseline may be adopted for a refused copy"
            );
            assert!(
                decode(&std::fs::read(device_bindings_file_path(&dir)).unwrap())
                    .contains_key(&hex(&mine)),
                "the local row survives the refusal"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // Criterion 2 at the phase layer, and the reason this family has a phase of its
        // own: the key is the DEVICE and the row names the person, so a peer's copy and
        // this device's copy are claims over DISJOINT keys and the merge is a union, not
        // a replace. The merged map is then what the push carries, so the peer's claim is
        // not lost on the way to the server.
        #[test]
        fn a_pulled_binding_is_merged_entry_by_entry_and_the_merge_is_what_gets_pushed() {
            let dir = scratch("bindings-merge");
            seed_meta(&dir);
            let me = person(0x11, 0x12, 0x13);
            let mine = [0x21; 16];
            let peer = person(0x31, 0x32, 0x33);
            let theirs = [0x41; 16];
            write_local(&dir, &one_row(&me, &mine, 1));

            let remote_bytes = protocol::encode_device_binding_blob(
                &bindings_key(),
                &HASH,
                EPOCH,
                &one_row(&peer, &theirs, 1),
            )
            .unwrap();

            let mut st = SyncState::default();
            let t = FakeTransport::new();
            let id = device_bindings_sync_id(&group_tier()).unwrap();
            let rec = serve_remote(&t, &id, &remote_bytes, 4);

            let phase = blocking(sync_device_bindings_phase(
                &IO,
                &t,
                "tok",
                &group_tier(),
                &dir,
                &mut st,
                &id,
                Some(&rec),
            ))
            .unwrap();
            assert!(
                phase.applied_remote,
                "a merge that changed the local store must be reported at the cycle boundary"
            );
            assert!(
                phase.dirty,
                "a merge the server has not seen must push, or the peer's claim lives only here"
            );
            let pushed = decode(phase.push_bytes.as_deref().expect("merged bytes"));
            assert_eq!(
                pushed.len(),
                2,
                "both devices stay bound: the merge is a union, not a replace"
            );
            assert!(pushed.contains_key(&hex(&mine)));
            assert!(pushed.contains_key(&hex(&theirs)));
            let on_disk = decode(&std::fs::read(device_bindings_file_path(&dir)).unwrap());
            assert_eq!(
                on_disk, pushed,
                "the store and the push carry ONE map, not two derivations of it"
            );
            assert!(
                protocol::verify_device_binding(
                    &me.public_half(),
                    &mine,
                    on_disk.get(&hex(&mine)).unwrap()
                ),
                "the local row is still this device's own signature after the merge"
            );
            assert!(
                protocol::verify_device_binding(
                    &peer.public_half(),
                    &theirs,
                    on_disk.get(&hex(&theirs)).unwrap()
                ),
                "and the peer's row is still the peer's, unaltered by the merge"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // Criteria 2 and 3 through the REAL cycle, which is also the only proof in the
        // tree that `sync_device_bindings_phase` is invoked at all: `sync/mod.rs`'s
        // `#![allow(dead_code)]` makes a phase that stopped being called invisible to
        // clippy, and nothing under `scripts/` reads Rust call graphs. A device that
        // claimed while offline (the local store) meets a peer's row on the server, both
        // survive, and the boundary reports it where the device list can see it.
        #[test]
        fn an_offline_claim_is_merged_at_the_cycle_boundary() {
            use protocol::vault_head::VAULT_HEAD_FORMAT_V2;

            let (dir, notes) = fresh_vault("device-bindings-cycle");
            seed_meta(&dir);

            let me = person(0x11, 0x12, 0x13);
            let mine = [0x21; 16];
            let peer = person(0x31, 0x32, 0x33);
            let theirs = [0x41; 16];
            write_local(&dir, &one_row(&me, &mine, 1));

            // The server holds only the peer's row, at a version this device never saw.
            let remote_bytes = protocol::encode_device_binding_blob(
                &bindings_key(),
                &HASH,
                EPOCH,
                &one_row(&peer, &theirs, 1),
            )
            .unwrap();
            let bindings_id = device_bindings_sync_id(&group_tier()).unwrap();

            // A signed head so the cycle adopts the server's rather than authoring a
            // genesis (a push route this test does not need).
            let signer = person(0x51, 0x52, 0x53);
            let signer_public = signer.public_half();
            let ctx = SignedHeadCtx::new(signer, HASH, vec![signer_public]);
            let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
            let head = VaultHead {
                head_format_version: VAULT_HEAD_FORMAT_V2,
                account_number_hash: HASH,
                manifest_hash: [0u8; 32],
                seq: 1,
                prev_head_hash: Vec::new(),
                version_vector: vec![VvEntry {
                    device_id: [0x99; 16],
                    counter: 1,
                }],
            };
            let sealed = ctx.sign(&head, &mut rng).unwrap();
            let head_frag = (B64.encode(&sealed.record), hex(&sealed.head_id));

            let t = FakeTransport::new();
            let remote_nonce = read_device_bindings_nonce(&remote_bytes).unwrap();
            t.on(
                HttpMethod::Get,
                "/sync/pull?cursor=0",
                200,
                pull_body_with_head(&meta_json(&bindings_id, 4, &remote_nonce), 1, &head_frag),
            );
            t.on(
                HttpMethod::Get,
                "/sync/pull?cursor=1",
                200,
                pull_body("", 1),
            );
            t.on(
                HttpMethod::Get,
                &format!("/sync/blob?id={}", hex(&bindings_id)),
                200,
                serde_json::to_vec(
                    &serde_json::json!({ "ciphertext_b64": B64.encode(&remote_bytes) }),
                )
                .unwrap(),
            );

            let items_key = [0x44u8; 32];
            let items_key_id = [0x55u8; 16];
            let summary = blocking(run_sync_cycle(
                &IO,
                &t,
                None,
                &group_tier(),
                HASH,
                [0x0a; 16],
                "tok",
                &notes,
                &dir,
                PushGate::PollOnly,
                MetaVersion::V0_2,
                Some(AttachmentKeys {
                    items_key: &items_key,
                    items_key_id: &items_key_id,
                }),
                Some(&ctx),
                &std::collections::HashSet::new(),
            ))
            .expect("cycle runs");

            assert!(
                summary.device_bindings_applied_remote,
                "a merged binding must be reported at the cycle boundary, or the device \
                 list keeps drawing the stale roster"
            );
            let on_disk = decode(&std::fs::read(device_bindings_file_path(&dir)).unwrap());
            assert_eq!(on_disk.len(), 2, "both claims survive the cycle's merge");
            assert!(
                on_disk.contains_key(&hex(&mine)),
                "the offline claim survived"
            );
            assert!(on_disk.contains_key(&hex(&theirs)), "and so did the peer's");
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
                membership: None,
                person_binding: None,
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

            let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true, None));

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

            let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true, None));
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

            let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true, None));
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

            let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true, None));
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

        // A B2B vault's `vault.meta` PUT is OWNER-authorized: the server refuses a
        // device token with 403 `owner_required`. When this device holds the
        // owner's per-vault membership token, the push must carry IT, or the
        // roster/epoch never reaches the server and a member joins against a
        // stale roster (its own heads then fail to verify, wedging sync).
        #[test]
        fn a_b2b_meta_push_uses_the_owner_membership_token() {
            let dir = scratch("owner-token");
            let baseline = meta_bytes(0xAA); // what the server still has
            let local = meta_bytes(0xCC); // our changed meta
            std::fs::write(dir.join("vault.meta"), &local).unwrap();
            blocking(mark_vault_meta_dirty(&IO, &dir)).unwrap();
            let mut st = SyncState {
                meta_baseline_hex: Some(sha256_hex(&baseline)),
                owner_member_token_hex: Some("owner-tok".to_string()),
                ..Default::default()
            };
            let t = FakeTransport::new();
            t.on(HttpMethod::Get, "/vault.meta", 200, baseline);
            t.on(HttpMethod::Put, "/vault.meta", 200, Vec::new());

            let out = blocking(sync_meta_phase(
                &IO,
                &t,
                "device-tok",
                &dir,
                &mut st,
                true,
                None,
            ));
            assert_eq!(out, MetaPhaseOutcome::Pushed);
            let put_token = t
                .requests()
                .into_iter()
                .find(|(m, p, _, _, _)| *m == HttpMethod::Put && p == "/vault.meta")
                .and_then(|(_, _, _, tok, _)| tok);
            assert_eq!(
                put_token.as_deref(),
                Some("owner-tok"),
                "the meta PUT must carry the owner membership token, not the device token"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // myne#293 — a poll cycle (allow_push=false) with the DIRTY MARKER set
        // must push anyway.
        //
        // This test asserted the opposite, and that was the defect: the marker's
        // only production writer is the credential-push failure arm, and a
        // credential change bumps no local-change counter, so the scheduler
        // never opened a push window on its own. A password change whose
        // immediate push failed then sat unpushed until an unrelated note edit
        // happened to open one — while a second device joining in that window
        // fetched the stale meta and was unlocked by the OLD password.
        //
        // What `allow_push` protects is edit-TIMING inference from push cadence.
        // The marker carries no edit timing, only "a credential changed and the
        // server does not have it", which the immediate push at change time
        // already revealed.
        #[test]
        fn poll_cycle_pushes_a_pending_credential_change() {
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
            t.on(HttpMethod::Put, "/vault.meta", 200, Vec::new());

            let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, false, None));
            assert_eq!(out, MetaPhaseOutcome::Pushed);
            assert_eq!(
                put_recorded(&t),
                vec![local],
                "the rotated credential reaches the server without waiting for an \
                 unrelated content edit"
            );
            assert!(
                !blocking(vault_meta_is_dirty(&IO, &dir)),
                "dirty cleared once the server has it"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        // …and the coalescing rule is otherwise untouched: a poll cycle with a
        // local change but NO pending credential change still pushes nothing.
        #[test]
        fn poll_cycle_still_defers_a_plain_local_divergence() {
            let dir = scratch("poll-clean");
            let baseline = meta_bytes(0xAA);
            let local = meta_bytes(0xCC);
            std::fs::write(dir.join("vault.meta"), &local).unwrap();
            // No `mark_vault_meta_dirty` — the divergence is inferred from the
            // baseline, not from a credential change.
            let mut st = SyncState {
                meta_baseline_hex: Some(sha256_hex(&baseline)),
                ..Default::default()
            };
            let t = FakeTransport::new();
            t.on(HttpMethod::Get, "/vault.meta", 200, baseline);

            let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, false, None));
            assert_eq!(out, MetaPhaseOutcome::NoChange);
            assert!(put_recorded(&t).is_empty(), "a poll cycle pushes nothing");
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
            let out_a = blocking(sync_meta_phase(
                &IO, &ta, "tok", &dir_a, &mut st_a, true, None,
            ));
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
            let out_b = blocking(sync_meta_phase(
                &IO, &tb, "tok", &dir_b, &mut st_b, true, None,
            ));
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

        // The v0.2 (`NTV5`) twin of `meta_bytes`: same fields, stamped with the
        // migrated magic. Two of these differ only in the password-side wrap — a
        // password change on a MIGRATED vault.
        fn meta_bytes_v0_2(pw: u8) -> Vec<u8> {
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
                membership: None,
                person_binding: None,
            };
            protocol::serialize_vault_meta_v0_2(&m).to_vec()
        }

        // A concurrent password change on two MIGRATED (v0.2 / `NTV5`) devices must
        // re-serialize the merged meta as `NTV5`, NOT `MYV1`. Serializing it as
        // `MYV1` (the old unconditional `serialize_vault_meta`) writes v0.2 wrap
        // bytes under a v0.1 magic: the next unlock reads `V0_1`, derives the wrong
        // KDF salt domain, and BRICKS the vault (password AND recovery), stranding
        // every `NC05` note under the now-unreachable v0.2 `itemsKey`. The
        // generation guard in `sync_meta_phase` is what prevents that.
        #[test]
        fn concurrent_change_on_migrated_vaults_re_serializes_as_ntv5_not_myv1() {
            let baseline = meta_bytes_v0_2(0x10);
            let a_pw = meta_bytes_v0_2(0xAA);
            let b_pw = meta_bytes_v0_2(0xBB); // deterministic winner (greater wrap)

            let dir = scratch("conc-v0_2");
            std::fs::write(dir.join("vault.meta"), &a_pw).unwrap();
            blocking(mark_vault_meta_dirty(&IO, &dir)).unwrap();
            let mut st = SyncState {
                meta_baseline_hex: Some(sha256_hex(&baseline)),
                ..Default::default()
            };
            let t = FakeTransport::new();
            t.on(HttpMethod::Get, "/vault.meta", 200, b_pw.clone());
            t.on(HttpMethod::Put, "/vault.meta", 200, Vec::new());

            let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true, None));
            assert_eq!(out, MetaPhaseOutcome::Merged);
            let merged = std::fs::read(dir.join("vault.meta")).unwrap();
            assert_eq!(
                &merged[0..4],
                protocol::VAULT_META_V0_2_MAGIC.as_slice(),
                "a merged migrated meta stays NTV5 — it must never revert to MYV1"
            );
            assert_eq!(merged, b_pw, "still converges on the deterministic winner");
            std::fs::remove_dir_all(&dir).ok();
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
                membership: None,
                person_binding: None,
            };
            bad.enc_items_key = [0xEE; VAULT_META_WRAPPED_ITEMS_KEY_LEN]; // divergent!
            let server = serialize_vault_meta(&bad).to_vec();
            let mut st = SyncState {
                meta_baseline_hex: Some(sha256_hex(&local)),
                ..Default::default()
            };
            let t = FakeTransport::new();
            t.on(HttpMethod::Get, "/vault.meta", 200, server);

            let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true, None));
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

            let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true, None));
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

            let out = blocking(sync_meta_phase(&IO, &t, "tok", &dir, &mut st, true, None));
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

    /// Batch blob fetch on the pull path (myne-md/myne#240).
    mod blob_batch {
        use super::*;

        fn changed(size: usize) -> engine::ChangedBlob {
            engine::ChangedBlob {
                id: [0u8; 16],
                content_nonce: [0u8; 24],
                version: 1,
                size,
                attachment_id: None,
            }
        }

        /// The inversion of `push_chunks`, and the reason it gets a test of its
        /// own: push returns ONE EMPTY chunk for an empty batch (a head-only
        /// genesis push must still be sent), so the obvious copy of it here would
        /// send an empty batch request — spending a token and a round-trip on
        /// nothing. Every byte of the resulting data would be correct, so nothing
        /// else in the suite would notice.
        #[test]
        fn an_empty_queue_yields_no_window() {
            assert_eq!(fetch_window(&[]), 0);
        }

        #[test]
        fn a_window_closes_on_the_count_bound() {
            let all: Vec<engine::ChangedBlob> = (0..FETCH_WINDOW_MAX_BLOBS + 44)
                .map(|_| changed(1))
                .collect();
            let q: Vec<&engine::ChangedBlob> = all.iter().collect();
            assert_eq!(fetch_window(&q), FETCH_WINDOW_MAX_BLOBS);
            assert_eq!(fetch_window(&q[FETCH_WINDOW_MAX_BLOBS..]), 44);
            // Exactly at the bound splits cleanly rather than leaving a stray.
            assert_eq!(
                fetch_window(&q[..FETCH_WINDOW_MAX_BLOBS]),
                FETCH_WINDOW_MAX_BLOBS
            );
        }

        #[test]
        fn a_window_closes_on_the_byte_bound_before_the_count_bound() {
            // 512 KiB each → 16 fit in the 8 MiB budget, far below the count cap.
            let all: Vec<engine::ChangedBlob> = (0..40).map(|_| changed(512 * 1024)).collect();
            let q: Vec<&engine::ChangedBlob> = all.iter().collect();
            let n = fetch_window(&q);
            assert_eq!(n, 16, "the byte budget must bind before the count cap");
            assert!(n * 512 * 1024 <= FETCH_WINDOW_MAX_BYTES);
        }

        /// A lone blob over the whole budget still travels, or the drain loops on
        /// it forever. Mirrors push_chunks' oversized-lone-blob rule.
        #[test]
        fn a_lone_oversized_blob_gets_a_window_of_one() {
            let all = [changed(FETCH_WINDOW_MAX_BYTES * 2), changed(1)];
            let q: Vec<&engine::ChangedBlob> = all.iter().collect();
            assert_eq!(fetch_window(&q), 1);
        }

        /// `size` is server-advertised and untrusted (§8.1), and an older server
        /// omits it so it deserializes to 0. Neither is special-cased: with 0 the
        /// byte accumulator never trips and windowing degrades to count-only,
        /// after which the server serves the prefix that fits and the client
        /// re-windows the rest.
        #[test]
        fn a_zero_size_degrades_to_the_count_bound() {
            let all: Vec<engine::ChangedBlob> = (0..FETCH_WINDOW_MAX_BLOBS * 2)
                .map(|_| changed(0))
                .collect();
            let q: Vec<&engine::ChangedBlob> = all.iter().collect();
            assert_eq!(fetch_window(&q), FETCH_WINDOW_MAX_BLOBS);
        }

        /// The 50 000-note arithmetic, done as arithmetic rather than as a corpus.
        /// 1424 B is the 71.2 MB / 50 000 average recorded in the myne#222
        /// decisions entry; the count cap binds at that size, so the pull that
        /// used to be 50 000 requests is 196.
        #[test]
        fn fifty_thousand_notes_plan_one_hundred_ninety_six_windows() {
            let all: Vec<engine::ChangedBlob> = (0..50_000).map(|_| changed(1424)).collect();
            let mut q: &[&engine::ChangedBlob] = &all.iter().collect::<Vec<_>>();
            let mut windows = 0usize;
            while !q.is_empty() {
                let n = fetch_window(q);
                assert!(
                    n > 0,
                    "a window is never empty — the drain would not advance"
                );
                assert!(n <= FETCH_WINDOW_MAX_BLOBS);
                assert!(
                    n == 1
                        || q[..n].iter().map(|c| c.size).sum::<usize>() <= FETCH_WINDOW_MAX_BYTES
                );
                windows += 1;
                q = &q[n..];
            }
            assert_eq!(windows, 196);
        }

        /// The end-to-end proof, against the production limiter defaults spelled
        /// out literally rather than `spawn_server`'s lifted values.
        ///
        /// On `develop` this fails at `rate_limited() == 0`: 600 sequential GETs
        /// against a burst of 256 refilling at 16/s collects hundreds of 429s,
        /// which `download_blob_backoff` absorbs — the pull still succeeds, just
        /// slowly, which is exactly why the request count and not the failure
        /// class is the honest assertion.
        #[test]
        fn a_first_pull_of_a_large_vault_fits_inside_the_default_burst() {
            let Some((_guard, url)) = spawn_server_env("256", "16") else {
                eprintln!("SKIP blob_batch burst: server binary not found");
                return;
            };
            let root_key = [0xc1u8; 32];
            let account_hash = [0xc2u8; 16];
            let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
            let items_key = [0xc3u8; 32];
            let items_key_id = [0xc4u8; 16];
            let dir_a = std::env::temp_dir().join(format!("myne-bb-A-{}", std::process::id()));
            let dir_b = std::env::temp_dir().join(format!("myne-bb-B-{}", std::process::id()));
            let notes_a = dir_a.join("notes");
            let notes_b = dir_b.join("notes");
            std::fs::create_dir_all(&notes_a).unwrap();
            std::fs::create_dir_all(&notes_b).unwrap();

            // 600 = 2 full windows + 88, so the split is exercised and asymmetric.
            const N: usize = 600;
            for i in 0..N {
                write_note(
                    &notes_a,
                    &items_key,
                    &items_key_id,
                    &NoteId::new_v7(),
                    format!("note-{i}").as_bytes(),
                    false,
                );
            }
            let (ta, dev_a, tok_a) = enroll_device(
                &url,
                &account_hash,
                secret.as_slice(),
                "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0",
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
            .expect("A pushes 600 notes");

            let (_tb, dev_b, tok_b) = enroll_device(
                &url,
                &account_hash,
                secret.as_slice(),
                "d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1",
                false,
            );
            let obs = PullObserver::new(
                crate::plugins::sync::http_transport::build_transport(&url).unwrap(),
            );
            let pull = run_cycle_legacy(
                &obs,
                &root_key,
                account_hash,
                dev_b,
                &tok_b,
                &notes_b,
                &dir_b,
                true,
            )
            .expect("B cold-syncs in ONE cycle");

            assert_eq!(pull.pulled, N, "every note landed in one cycle");
            assert_eq!(
                obs.rate_limited(),
                0,
                "the cold sync must not touch the limiter at all — this is the \
                 assertion that fails before batching, where 600 GETs against a \
                 256 burst collect hundreds of 429s"
            );
            assert_eq!(
                obs.ids_per_batch(),
                vec![FETCH_WINDOW_MAX_BLOBS, FETCH_WINDOW_MAX_BLOBS, 88],
                "note bodies travel in bounded windows"
            );
            assert_eq!(
                obs.single_count(),
                0,
                "no note body fell back to the single-blob route"
            );

            // The control arm, and the reason the assertion above is meaningful:
            // a THIRD device doing the identical cold sync one-GET-per-blob — the
            // pre-#240 shape, still live as the old-server fallback — hammers the
            // very limiter the batch path did not touch. Without this the "0 429s"
            // above could just mean the corpus was too small to bind.
            let dir_c = std::env::temp_dir().join(format!("myne-bb-C-{}", std::process::id()));
            let notes_c = dir_c.join("notes");
            std::fs::create_dir_all(&notes_c).unwrap();
            let (_tc, dev_c, tok_c) = enroll_device(
                &url,
                &account_hash,
                secret.as_slice(),
                "e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2",
                false,
            );
            let legacy = PullObserver::new(Box::new(RouteAbsentTransport {
                inner: crate::plugins::sync::http_transport::build_transport(&url).unwrap(),
                status: 404,
            }));
            run_cycle_legacy(
                &legacy,
                &root_key,
                account_hash,
                dev_c,
                &tok_c,
                &notes_c,
                &dir_c,
                true,
            )
            .expect("the fallback path still completes, just slowly");
            // `>=` rather than `==`: every 429 the backoff swallows is itself
            // another GET the observer counts, which is the cost being measured.
            assert!(
                legacy.single_count() >= N,
                "the control really did one GET per blob: {}",
                legacy.single_count()
            );
            assert!(
                legacy.rate_limited() > 0,
                "the control arm did not bind the limiter, so the 0-429 assertion \
                 above proves nothing — raise N"
            );
            std::fs::remove_dir_all(&dir_a).ok();
            std::fs::remove_dir_all(&dir_b).ok();
            std::fs::remove_dir_all(&dir_c).ok();
        }

        /// A server without the route (404, or 405 behind a proxy that knows the
        /// /sync prefix but not the method) is probed ONCE and the rest of the
        /// attempt uses the single-blob route.
        #[test]
        fn a_server_without_the_batch_route_falls_back_to_single_blob() {
            let Some((_guard, url)) = spawn_server() else {
                eprintln!("SKIP blob_batch fallback: server binary not found");
                return;
            };
            let root_key = [0xe1u8; 32];
            let account_hash = [0xe2u8; 16];
            let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
            let items_key = [0xe3u8; 32];
            let items_key_id = [0xe4u8; 16];
            let dir_a = std::env::temp_dir().join(format!("myne-bbf-A-{}", std::process::id()));
            let dir_b = std::env::temp_dir().join(format!("myne-bbf-B-{}", std::process::id()));
            let notes_a = dir_a.join("notes");
            let notes_b = dir_b.join("notes");
            std::fs::create_dir_all(&notes_a).unwrap();
            std::fs::create_dir_all(&notes_b).unwrap();

            for i in 0..5 {
                write_note(
                    &notes_a,
                    &items_key,
                    &items_key_id,
                    &NoteId::new_v7(),
                    format!("old-server-{i}").as_bytes(),
                    false,
                );
            }
            let (ta, dev_a, tok_a) = enroll_device(
                &url,
                &account_hash,
                secret.as_slice(),
                "e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0",
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

            for status in [404u16, 405] {
                let dir = dir_b.join(status.to_string());
                let notes = dir.join("notes");
                std::fs::create_dir_all(&notes).unwrap();
                let (_t, dev, tok) = enroll_device(
                    &url,
                    &account_hash,
                    secret.as_slice(),
                    &format!("{status}0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f")[..32],
                    false,
                );
                let obs = PullObserver::new(Box::new(RouteAbsentTransport {
                    inner: crate::plugins::sync::http_transport::build_transport(&url).unwrap(),
                    status,
                }));
                let pull =
                    run_cycle_legacy(&obs, &root_key, account_hash, dev, &tok, &notes, &dir, true)
                        .expect("the cycle completes against a server without the route");
                assert_eq!(pull.pulled, 5, "every note landed via the fallback");
                assert_eq!(
                    obs.ids_per_batch().len(),
                    1,
                    "status {status}: the absent route is probed ONCE, not once per window"
                );
                assert_eq!(
                    obs.single_count(),
                    5,
                    "status {status}: one GET per note after the fallback"
                );
            }
            std::fs::remove_dir_all(&dir_a).ok();
            std::fs::remove_dir_all(&dir_b).ok();
        }

        /// The negative case, and the one that matters: a transport-level failure
        /// is a server OUTAGE, not a missing route. Falling back on it would mask
        /// a real outage as a slow success and permanently downgrade the session
        /// on one dropped packet. The cycle must fail and try the batch again.
        #[test]
        fn a_transport_error_on_the_batch_route_does_not_disable_it() {
            let Some((_guard, url)) = spawn_server() else {
                eprintln!("SKIP blob_batch outage: server binary not found");
                return;
            };
            let root_key = [0xf1u8; 32];
            let account_hash = [0xf2u8; 16];
            let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
            let items_key = [0xf3u8; 32];
            let items_key_id = [0xf4u8; 16];
            let dir_a = std::env::temp_dir().join(format!("myne-bbo-A-{}", std::process::id()));
            let dir_b = std::env::temp_dir().join(format!("myne-bbo-B-{}", std::process::id()));
            let notes_a = dir_a.join("notes");
            let notes_b = dir_b.join("notes");
            std::fs::create_dir_all(&notes_a).unwrap();
            std::fs::create_dir_all(&notes_b).unwrap();

            let note = NoteId::new_v7();
            write_note(&notes_a, &items_key, &items_key_id, &note, b"outage", false);
            let (ta, dev_a, tok_a) = enroll_device(
                &url,
                &account_hash,
                secret.as_slice(),
                "f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0",
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
            let (_tb, dev_b, tok_b) = enroll_device(
                &url,
                &account_hash,
                secret.as_slice(),
                "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f",
                false,
            );

            // First cycle: the batch route drops below HTTP.
            use crate::plugins::sync::transport::{FaultInjectingTransport, FaultMode};
            let dead = FaultInjectingTransport::fail_path(
                crate::plugins::sync::http_transport::build_transport(&url).unwrap(),
                BLOB_BATCH_PATH,
                99,
                FaultMode::Network,
            );
            let err = run_cycle_legacy(
                &dead,
                &root_key,
                account_hash,
                dev_b,
                &tok_b,
                &notes_b,
                &dir_b,
                true,
            )
            .expect_err("an outage on the batch route fails the cycle");
            assert!(
                matches!(err, SyncCycleError::Pull(PullError::Transport(_))),
                "an outage stays a transport error, it is not laundered into a \
                 fallback: got {err:?}"
            );
            assert!(
                !notes_b.join(format!("{}.myn", note.as_uuid())).exists(),
                "nothing was written by the failed cycle"
            );

            // Next cycle, healthy transport: the batch route is tried AGAIN.
            let obs = PullObserver::new(
                crate::plugins::sync::http_transport::build_transport(&url).unwrap(),
            );
            let pull = run_cycle_legacy(
                &obs,
                &root_key,
                account_hash,
                dev_b,
                &tok_b,
                &notes_b,
                &dir_b,
                true,
            )
            .expect("the next cycle recovers");
            assert_eq!(pull.pulled, 1);
            assert_eq!(
                obs.ids_per_batch(),
                vec![1],
                "the batch route was retried, not permanently disabled"
            );
            assert_eq!(obs.single_count(), 0);
            std::fs::remove_dir_all(&dir_a).ok();
            std::fs::remove_dir_all(&dir_b).ok();
        }

        /// Every way a batch response can try to make an id land as empty
        /// bytes, against a PRE-EXISTING LIVE LOCAL NOTE so a failure is
        /// destructive and visible. A correct server emits none of these — the
        /// point is that the client refuses them anyway, because "no local
        /// mutation" (§11.3) has to hold against a hostile or buggy peer too.
        ///
        /// Arms: the id omitted with each code; the id served with an EMPTY
        /// ciphertext (a pre-§11.3 server, or a hostile one); the id in BOTH
        /// arrays; and the id in NEITHER, which must stay queued rather than
        /// default to empty bytes.
        #[test]
        fn an_omitted_id_can_never_be_applied_as_a_zero_byte_body() {
            let items_key = [0x11u8; 32];
            let items_key_id = [0x22u8; 16];
            let id_hex_of = |id: &[u8; 16]| hex(id);

            /// `(tag, build the batch body the server returns for this window)`.
            type Arm = (&'static str, Box<dyn Fn(&str) -> String>);
            let arms: Vec<Arm> = vec![
                (
                    "omitted-reclaimed",
                    Box::new(|h: &str| {
                        format!("{{\"blobs\":[],\"omitted\":[{{\"blob_id_hex\":\"{h}\",\"error_code\":\"blob_reclaimed\"}}]}}")
                    }),
                ),
                (
                    "omitted-notfound",
                    Box::new(|h: &str| {
                        format!("{{\"blobs\":[],\"omitted\":[{{\"blob_id_hex\":\"{h}\",\"error_code\":\"not_found\"}}]}}")
                    }),
                ),
                (
                    "omitted-internal",
                    Box::new(|h: &str| {
                        format!("{{\"blobs\":[],\"omitted\":[{{\"blob_id_hex\":\"{h}\",\"error_code\":\"internal\"}}]}}")
                    }),
                ),
                (
                    "served-empty",
                    Box::new(|h: &str| {
                        format!("{{\"blobs\":[{{\"blob_id_hex\":\"{h}\",\"ciphertext_b64\":\"\"}}],\"omitted\":[]}}")
                    }),
                ),
                (
                    "in-both-arrays",
                    Box::new(|h: &str| {
                        format!("{{\"blobs\":[{{\"blob_id_hex\":\"{h}\",\"ciphertext_b64\":\"\"}}],\"omitted\":[{{\"blob_id_hex\":\"{h}\",\"error_code\":\"blob_reclaimed\"}}]}}")
                    }),
                ),
                (
                    "accounted-nowhere",
                    Box::new(|_h: &str| "{\"blobs\":[],\"omitted\":[]}".to_string()),
                ),
            ];

            for (tag, body_for) in arms {
                let (dir, notes) = fresh_vault(&format!("bbzero-{tag}"));
                let id = v7_id();
                let blob =
                    encode_new_note(&items_key, &items_key_id, &id, b"precious body").unwrap();
                let disk_nonce = crate::note_nonce::read_myn_content_nonce(&blob).unwrap();
                crate::atomic_write::atomic_write(&blob_path(&notes, &id), &blob, false).unwrap();
                // A CLEAN baseline, so the cheap dirty-filter does not fire and the
                // record really does reach the batch drain.
                let mut st = SyncState::default();
                st.blobs.insert(
                    hex(&id),
                    BlobSyncState {
                        version: 1,
                        content_nonce_hex: hex(&disk_nonce),
                        doc_heads_hex: Vec::new(),
                    },
                );
                write_sync_state(&dir, &st).unwrap();

                let t = FakeTransport::new();
                // The server advanced the record (new version + nonce), so the
                // client wants to download it.
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
                t.on(
                    HttpMethod::Post,
                    BLOB_BATCH_PATH,
                    200,
                    body_for(&id_hex_of(&id)).into_bytes(),
                );

                let out = run_cycle_legacy(
                    &t,
                    &[0x42; 32],
                    [0x5c; 16],
                    [0x0a; 16],
                    "tok",
                    &notes,
                    &dir,
                    false,
                );
                match tag {
                    // An id the response accounted for nowhere leaves the drain
                    // with no progress to make. Failing the cycle is the ONLY safe
                    // answer: looping would hang, and skipping would silently
                    // discard a record the server never spoke about.
                    "accounted-nowhere" => {
                        assert!(
                            matches!(out, Err(SyncCycleError::Pull(PullError::BadResponse))),
                            "{tag}: a window that accounts for nothing must fail the cycle, got {out:?}"
                        );
                    }
                    _ => {
                        let s = out.unwrap_or_else(|e| panic!("{tag}: cycle failed: {e:?}"));
                        assert_eq!(s.pulled, 0, "{tag}: nothing may count as pulled");
                        assert_eq!(s.pull_skipped, 1, "{tag}: the skip is honestly counted");
                    }
                }
                // The load-bearing assertion, identical in every arm.
                let on_disk = std::fs::read(blob_path(&notes, &id)).unwrap();
                assert_eq!(
                    on_disk, blob,
                    "{tag}: the live note must survive byte-identical"
                );
                let st2 = read_sync_state(&dir).unwrap();
                assert_eq!(
                    st2.blobs.get(&hex(&id)).map(|b| b.version),
                    Some(1),
                    "{tag}: the baseline must NOT be adopted — adoption is what made \
                     this class of bug self-seal"
                );
                std::fs::remove_dir_all(&dir).ok();
            }
        }
    }

    /// The peer's exit from the re-key (myne-md/myne#447): a head it cannot open
    /// while the server holds a NEWER-generation `vault.meta` must **stage** those
    /// bytes on the way out.
    ///
    /// Before this, the branch returned `RekeyedElsewhere` and nothing else — so
    /// the peer locked, the user unlocked, the OLD local meta re-derived the OLD
    /// root, and the next cycle met the same head. A loop with no exit, on the
    /// one path whose entire job is to move a peer onto the new generation.
    ///
    /// Hermetic: the head is authored under one root and the cycle runs under
    /// another, which is exactly the MAC failure a re-key produces — no server,
    /// no live migration.
    #[test]
    fn the_rekey_path_stages_the_servers_meta_on_its_way_out() {
        let dir = std::env::temp_dir().join(format!(
            "myne-orch-stage-{}-{:p}",
            std::process::id(),
            &"stage"
        ));
        std::fs::create_dir_all(dir.join("notes")).unwrap();

        // A v0.1 meta locally; a v0.2 meta on the server. Only a migration
        // produces that pairing, and it is what `server_meta_of_newer_generation`
        // keys off.
        let local_v0_1 = protocol::serialize_vault_meta(&meta_fixture()).to_vec();
        std::fs::write(dir.join("vault.meta"), &local_v0_1).unwrap();
        let server_v0_2 = protocol::serialize_vault_meta_v0_2(&meta_fixture()).to_vec();

        // The head is sealed under a DIFFERENT root than the cycle runs with, so
        // it fails its MAC verify — the peer-side signature of a re-key.
        let authored_under = [0xC1u8; 32];
        let running_under = [0xC2u8; 32];
        let account_hash = [0x33u8; 16];
        let head = sealed_head_fragment(&authored_under, account_hash);

        let t = FakeTransport::new();
        t.on(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            200,
            pull_body_with_head("", 0, &head),
        );
        t.on(HttpMethod::Get, "/vault.meta", 200, server_v0_2.clone());

        let err = run_cycle_legacy(
            &t,
            &running_under,
            account_hash,
            [0xA1; 16],
            "tok",
            &dir.join("notes"),
            &dir,
            true,
        )
        .expect_err("an unopenable head over a newer generation is RekeyedElsewhere");
        assert!(
            matches!(err, SyncCycleError::RekeyedElsewhere),
            "expected RekeyedElsewhere, got {err:?}"
        );

        // `vault.meta` is UNTOUCHED — asserted FIRST, deliberately. Staging is
        // not adopting: this device cannot verify these bytes, and overwriting
        // the only local copy of the wrapped root_key on a server's say-so is
        // the hole staging exists to avoid. Checked before the staged file so
        // that "adopted instead of staged" fails on the assertion that NAMES it,
        // rather than incidentally on a missing staging file.
        assert_eq!(
            std::fs::read(dir.join("vault.meta")).unwrap(),
            local_v0_1,
            "the re-key path overwrote vault.meta with unverified server bytes"
        );
        // …and the bytes are staged for the unlock path to prove.
        let staged = std::fs::read(dir.join("vault.meta.incoming"))
            .expect("the server's newer meta must be staged, or the peer has no way forward");
        assert_eq!(staged, server_v0_2);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A `vault.meta` fixture whose fields are irrelevant to the test — only its
    /// GENERATION matters, and that comes from which serializer stamps it.
    fn meta_fixture() -> protocol::VaultMeta {
        protocol::VaultMeta {
            account_number_hash: [0x33; 16],
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            random_salt_password: [0x11; protocol::VAULT_META_SALT_RANDOM_LEN],
            random_salt_recovery: [0x22; protocol::VAULT_META_SALT_RANDOM_LEN],
            nonce_password_wrap: [0x33; protocol::VAULT_META_NONCE_LEN],
            enc_root_key_password: [0x44; protocol::VAULT_META_WRAPPED_ROOT_KEY_LEN],
            nonce_recovery_wrap: [0x55; protocol::VAULT_META_NONCE_LEN],
            enc_root_key_recovery: [0x66; protocol::VAULT_META_WRAPPED_ROOT_KEY_LEN],
            items_key_id: [0x07; protocol::VAULT_META_ITEMS_KEY_ID_LEN],
            items_key_nonce: [0x08; protocol::VAULT_META_NONCE_LEN],
            enc_items_key: [0x09; protocol::VAULT_META_WRAPPED_ITEMS_KEY_LEN],
            membership: None,
            person_binding: None,
        }
    }

    // -----------------------------------------------------------------------
    // Orphan-tombstone reclaim (`sync-protocol.md` §5.6.1, myne-md/myne#443)
    // -----------------------------------------------------------------------

    /// Records every `/sync/push` body and answers each with a caller-supplied
    /// verdict, so the drain's triage is exercised with no server at all.
    use super::super::state::OrphanTombstone;

    struct ScriptedPush {
        bodies: std::sync::Mutex<Vec<String>>,
        verdict: Box<dyn Fn() -> Result<TransportResponse, TransportError> + Send + Sync>,
    }
    impl ScriptedPush {
        fn new(
            verdict: impl Fn() -> Result<TransportResponse, TransportError> + Send + Sync + 'static,
        ) -> Self {
            Self {
                bodies: std::sync::Mutex::new(Vec::new()),
                verdict: Box::new(verdict),
            }
        }
        fn bodies(&self) -> Vec<String> {
            self.bodies.lock().unwrap().clone()
        }
    }
    impl SyncTransport for ScriptedPush {
        fn request(
            &self,
            _method: HttpMethod,
            path: &str,
            body: &[u8],
            _token: Option<&str>,
        ) -> Result<TransportResponse, TransportError> {
            assert_eq!(
                path, "/sync/push",
                "the drain must not call any other route"
            );
            self.bodies
                .lock()
                .unwrap()
                .push(String::from_utf8_lossy(body).into_owned());
            (self.verdict)()
        }
    }

    fn ok_push(results: &[(&str, u64)]) -> Result<TransportResponse, TransportError> {
        let rows: Vec<String> = results
            .iter()
            .map(|(id, v)| format!(r#"{{"blob_id_hex":"{id}","version":{v}}}"#))
            .collect();
        Ok(TransportResponse {
            status: 200,
            body: format!(r#"{{"results":[{}]}}"#, rows.join(",")).into_bytes(),
        })
    }

    fn queued_state(ids: &[(&str, u64)]) -> SyncState {
        SyncState {
            pending_orphan_tombstones: ids
                .iter()
                .map(|(id, v)| OrphanTombstone {
                    blob_id_hex: (*id).to_string(),
                    base_version: *v,
                    content_nonce_hex: "ab".repeat(24),
                })
                .collect(),
            ..SyncState::default()
        }
    }

    /// The reclaim itself: one request, every queued id in it, each marked
    /// `tombstone` with an EMPTY body and the base version the migration
    /// recorded — and the queue empty afterwards, so the next cycle does not
    /// re-flag records the server already marked.
    #[test]
    fn orphan_tombstones_are_pushed_as_empty_deletions_and_leave_the_queue() {
        let ids = ["11".repeat(16), "22".repeat(16)];
        let t = ScriptedPush::new(move || ok_push(&[("11".repeat(16).as_str(), 8)]));
        let mut state = queued_state(&[(&ids[0], 7), (&ids[1], 3)]);

        let n = blocking(drain_orphan_tombstones(&t, "tok", &mut state));

        let bodies = t.bodies();
        assert_eq!(bodies.len(), 1, "one request, not one per id: {bodies:?}");
        let body = &bodies[0];
        for id in &ids {
            assert!(body.contains(id.as_str()), "{id} missing from {body}");
        }
        assert!(body.contains(r#""base_version":7"#), "{body}");
        assert!(body.contains(r#""base_version":3"#), "{body}");
        assert!(body.contains(r#""tombstone":true"#), "{body}");
        // Empty ciphertext — a tombstone carries no body. Base64 of "" is "".
        assert!(body.contains(r#""ciphertext_b64":"""#), "{body}");
        // No head rides this request: it is a cleanup errand, and advancing the
        // head from here would put a CAS the cycle already performed at risk.
        assert!(!body.contains("new_head"), "{body}");
        assert_eq!(n, 1, "the count comes from the server's results");
        assert!(
            state.pending_orphan_tombstones.is_empty(),
            "a landed reclaim must leave the queue"
        );
    }

    /// A lost CAS is abandoned, not retried (#443).
    ///
    /// The version came from a baseline recorded before the migration, and a
    /// peer that wrote to the same old id while this device was offline makes it
    /// stale. The server returns no current version with its 409, so there is
    /// nothing to retry WITH — a kept entry would buy one useless request per
    /// cycle, forever, to reclaim three blobs.
    #[test]
    fn an_orphan_tombstone_that_lost_its_cas_is_abandoned_rather_than_retried_forever() {
        let t = ScriptedPush::new(|| {
            Ok(TransportResponse {
                status: 409,
                body: br#"{"error_code":"blob_stale"}"#.to_vec(),
            })
        });
        let mut state = queued_state(&[(&"33".repeat(16), 7)]);

        let n = blocking(drain_orphan_tombstones(&t, "tok", &mut state));

        assert_eq!(n, 0);
        assert!(
            state.pending_orphan_tombstones.is_empty(),
            "a structurally-refused reclaim must be dropped; the blobs stay \
             stranded, which is exactly the pre-#443 state"
        );
    }

    /// A transport failure says nothing about the request — keep it queued.
    ///
    /// The distinction matters: abandoning on a flaky network would throw the
    /// reclaim away for a reason that will be gone in thirty seconds.
    #[test]
    fn a_transport_failure_keeps_the_orphan_tombstones_queued() {
        let t = ScriptedPush::new(|| Err(TransportError::Network));
        let mut state = queued_state(&[(&"44".repeat(16), 2)]);

        let n = blocking(drain_orphan_tombstones(&t, "tok", &mut state));

        assert_eq!(n, 0);
        assert_eq!(
            state.pending_orphan_tombstones.len(),
            1,
            "a network error must not spend the reclaim"
        );
    }

    /// An empty queue costs nothing — no request at all, so an ordinary cycle
    /// on a vault that never migrated is byte-identical to before.
    #[test]
    fn an_empty_orphan_queue_issues_no_request() {
        let t = ScriptedPush::new(|| unreachable!("no request may be made"));
        let mut state = SyncState::default();
        assert_eq!(blocking(drain_orphan_tombstones(&t, "tok", &mut state)), 0);
        assert!(t.bodies().is_empty());
    }

    /// The wedge property, against the REAL server (#443).
    ///
    /// A queued reclaim whose base version is wrong produces a genuine 409 from
    /// the real store — no decorator, no simulated status. The cycle must still
    /// succeed and the user's note must still land. Had the tombstones ridden
    /// the content chunk, that 409 would fail the whole push, the cycle would
    /// retry, fail again, and every future push would wedge behind a
    /// storage-cleanup errand the user never asked for.
    #[test]
    fn a_refused_orphan_reclaim_does_not_cost_the_cycle_its_push() {
        let Some((_guard, url)) = spawn_server() else {
            eprintln!("SKIP a_refused_orphan_reclaim_...: myne-server unavailable");
            return;
        };
        let root_key = [0x71u8; 32];
        let account_hash = [0x72u8; 16];
        let secret = derive_subkey(&root_key, SubkeyRole::ServerAuth);
        let items_key = [0x73u8; 32];
        let items_key_id = [0x74u8; 16];

        let dir = std::env::temp_dir().join(format!("myne-orch-orphan-{}", std::process::id()));
        let notes = dir.join("notes");
        std::fs::create_dir_all(&notes).unwrap();
        let note = NoteId::new_v7();
        let blob = encode_new_note(
            &items_key,
            &items_key_id,
            note.as_uuid().as_bytes(),
            b"this note must land anyway",
        )
        .unwrap();
        crate::atomic_write::atomic_write(
            &notes.join(format!("{}.myn", note.as_uuid())),
            &blob,
            false,
        )
        .unwrap();

        let t = crate::plugins::sync::http_transport::build_transport(&url).unwrap();
        enroll::register_verifier(t.as_ref(), &account_hash, secret.as_slice()).unwrap();
        let dev = enroll::generate_device_id();
        let out = enroll::enroll(
            t.as_ref(),
            &account_hash,
            secret.as_slice(),
            EnrollPath::Recovery,
            "c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2c2",
            dev,
        )
        .unwrap();
        let tok = hex32(&out.token);

        // A reclaim the server cannot honour: the id has no blob, so its
        // current version is 0 and a base of 7 is a real CAS mismatch.
        let orphan = "9f".repeat(16);
        let mut seeded = read_sync_state(&dir).unwrap();
        seeded.device_id_hex = Some(hex(&dev));
        seeded.account_hash_hex = Some(hex(&account_hash));
        seeded.pending_orphan_tombstones = vec![OrphanTombstone {
            blob_id_hex: orphan.clone(),
            base_version: 7,
            content_nonce_hex: "ab".repeat(24),
        }];
        write_sync_state(&dir, &seeded).unwrap();

        let summary = run_cycle_legacy(
            t.as_ref(),
            &root_key,
            account_hash,
            dev,
            &tok,
            &notes,
            &dir,
            true,
        )
        .expect("a refused reclaim must not fail the cycle");
        assert!(
            summary.pushed >= 1,
            "the user's note must still have been pushed, got {summary:?}"
        );

        let after = read_sync_state(&dir).unwrap();
        assert!(
            after.pending_orphan_tombstones.is_empty(),
            "the refused reclaim must be abandoned rather than left to re-fail \
             on every future cycle"
        );
        assert!(
            after.blobs.contains_key(&hex(note.as_uuid().as_bytes())),
            "the note's CAS baseline must have been recorded"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// The structural half (#443): the reclaim queue has exactly ONE reader.
    ///
    /// `drain_orphan_tombstones` cannot fail a cycle — it returns `usize`, not
    /// `Result`, so there is no error to propagate and the guarantee is the
    /// signature rather than a test. What a signature cannot hold is someone
    /// later folding these entries into `to_push` "to save a request", which
    /// silently restores the wedge every assertion above exists to prevent.
    #[test]
    fn the_orphan_reclaim_queue_is_read_in_exactly_one_place() {
        let src = include_str!("orchestrator.rs");
        let production = &src[..src.find("#[cfg(test)]").expect("test module")];
        // Compared by POSITION, not by text. The first draft asked whether each
        // matching LINE also appeared inside the drain, and a read folded into
        // the push loop passed it — because the line injected there was a copy
        // of one already in the drain, so the function was being compared
        // against itself. That is the shape this repo keeps rediscovering, and
        // a byte range is the fix: a site either falls inside the function or
        // it does not.
        let start = production
            .find("async fn drain_orphan_tombstones")
            .expect("the drain function");
        let end = start
            + production[start..]
                .find("\n}\n")
                .map(|i| i + 3)
                .expect("the drain function ends");

        let mut sites = 0usize;
        let mut cursor = 0usize;
        while let Some(i) = production[cursor..].find("pending_orphan_tombstones") {
            let at = cursor + i;
            assert!(
                at >= start && at < end,
                "the reclaim queue is read outside `drain_orphan_tombstones` \
                 (byte {at}, function spans {start}..{end}) — folding these \
                 into the content push restores the 409 wedge"
            );
            sites += 1;
            cursor = at + 1;
        }
        // Not pinned to an exact count: refactoring the drain's internals is
        // nobody's regression. The lower bound is what keeps the test from
        // passing vacuously if the field is renamed and nothing matches at all.
        assert!(
            sites >= 2,
            "expected at least the emptiness check and the iteration; a search \
             that matches nothing asserts nothing"
        );
    }

    /// Answers `POST /sync/blobs` with a chosen status (404/405) while relaying
    /// everything else, modelling a server that predates the route.
    struct RouteAbsentTransport {
        inner: Box<dyn SyncTransport>,
        status: u16,
    }
    impl SyncTransport for RouteAbsentTransport {
        fn request(
            &self,
            method: HttpMethod,
            path: &str,
            body: &[u8],
            token: Option<&str>,
        ) -> Result<TransportResponse, TransportError> {
            if path == BLOB_BATCH_PATH {
                return Ok(TransportResponse {
                    status: self.status,
                    body: b"{}".to_vec(),
                });
            }
            self.inner.request(method, path, body, token)
        }
    }
    mod ntv6_epoch {
        //! The `NTV6` epoch merge read path (myne-md/myne#711 task 13).
        use super::super::*;
        use super::{blocking, IO};
        use crate::plugins::sync::state::{mark_vault_meta_dirty, SyncState};
        use crate::plugins::sync::transport::{FakeTransport, HttpMethod};
        use crate::vault_io::VaultIo as _;

        /// A structurally valid `NTV6` `vault.meta` at `epoch`: the group-key
        /// wrap, the items-key wrap and the sealed roster are built exactly as a
        /// migration/seal does, so `parse_vault_meta_ntv6` accepts it.
        fn ntv6_meta_bytes(epoch: u64) -> Vec<u8> {
            let root_key = [7u8; 32];
            let items_key = [9u8; 32];
            let group_key_bytes = [11u8; 32];
            let account_hash = [0x33u8; 16];
            let items_key_id = [0x07u8; 16];
            let mut base = protocol::parse_vault_meta_v0_2(
                &protocol::encode_vault_meta_v0_2_raw(
                    &root_key,
                    &items_key,
                    &items_key_id,
                    "pw",
                    "abandon abandon abandon",
                    &account_hash,
                    &protocol::DEFAULT_V0_1_KDF_PARAMS,
                    &[2u8; protocol::ARGON2_SALT_LEN],
                    &[4u8; protocol::ARGON2_SALT_LEN],
                    &[5u8; protocol::AEAD_NONCE_LEN],
                    &[6u8; protocol::AEAD_NONCE_LEN],
                    &[8u8; protocol::AEAD_NONCE_LEN],
                )
                .expect("encode NTV5 base"),
            )
            .expect("parse NTV5 base");
            let group_key = protocol::GroupKey::new(group_key_bytes);
            let group_nonce = [12u8; protocol::AEAD_NONCE_LEN];
            let items_nonce = [13u8; protocol::AEAD_NONCE_LEN];
            let enc_group = protocol::aead_seal_ctx(
                &protocol::derive_owner_subkey_v0_2(
                    &protocol::OwnerKey::new(root_key),
                    protocol::OwnerRole::GroupKeyWrap,
                ),
                &group_nonce,
                &group_key_bytes,
                &protocol::aad_vault_group_key_wrap_v0_2(&account_hash, epoch),
            )
            .expect("seal group key");
            let enc_items = protocol::aead_seal_ctx(
                &protocol::derive_group_subkey_v0_2(&group_key, protocol::GroupRole::ItemsKeyWrap),
                &items_nonce,
                &items_key,
                &protocol::aad_vault_items_key_wrap_v0_2(&items_key_id),
            )
            .expect("seal items key");
            base.items_key_nonce = items_nonce;
            base.enc_items_key.copy_from_slice(&enc_items);
            let signed_roster_envelope = protocol::person_invite::seal_group_roster(
                &group_key_bytes,
                &account_hash,
                epoch,
                &[0xE6; protocol::AEAD_NONCE_LEN],
                &protocol::person_invite::SignedGroupRoster {
                    payload: vec![0xC3; 32],
                    signature: protocol::person_key::PersonSigned {
                        ed25519_sig: [0xD4; protocol::person_key::PERSON_ED25519_SIG_LEN],
                        mldsa_sig: vec![0xE5; protocol::person_key::PERSON_MLDSA_SIG_LEN],
                    },
                },
            )
            .expect("seal roster envelope");
            protocol::serialize_vault_meta_ntv6(&protocol::B2bVaultMeta {
                base,
                group_key_nonce: group_nonce,
                enc_group_key: enc_group.try_into().expect("fixed group-key wrap"),
                group_key_epoch: epoch,
                signed_roster_envelope,
            })
            .expect("serialize NTV6")
        }

        /// A structurally valid `NTV5` (v0.2, pre-B2B) `vault.meta`, the shape the
        /// server still holds after an owner migrated locally but never pushed.
        fn ntv5_meta_bytes() -> Vec<u8> {
            protocol::encode_vault_meta_v0_2_raw(
                &[7u8; 32],
                &[9u8; 32],
                &[0x07u8; 16],
                "pw",
                "abandon abandon abandon",
                &[0x33u8; 16],
                &protocol::DEFAULT_V0_1_KDF_PARAMS,
                &[2u8; protocol::ARGON2_SALT_LEN],
                &[4u8; protocol::ARGON2_SALT_LEN],
                &[5u8; protocol::AEAD_NONCE_LEN],
                &[6u8; protocol::AEAD_NONCE_LEN],
                &[8u8; protocol::AEAD_NONCE_LEN],
            )
            .expect("encode NTV5")
            .to_vec()
        }

        fn scratch(tag: &str) -> crate::test_support::ScopedTempDir {
            crate::test_support::ScopedTempDir::new(tag).expect("temp dir")
        }

        async fn read_local(tmp: &crate::test_support::ScopedTempDir) -> Vec<u8> {
            IO.read(&tmp.path().join("vault.meta")).await.unwrap()
        }

        async fn seeded(
            tag: &str,
            local: &[u8],
        ) -> (crate::test_support::ScopedTempDir, SyncState) {
            let tmp = scratch(tag);
            IO.write(
                &tmp.path().join("vault.meta"),
                local,
                crate::vault_io::WriteOpts::default(),
            )
            .await
            .unwrap();
            let st = SyncState {
                // Baseline == the local bytes → "only the server changed".
                meta_baseline_hex: Some(super::super::sha256_hex(local)),
                ..SyncState::default()
            };
            (tmp, st)
        }

        #[test]
        fn a_strictly_greater_epoch_is_adopted_and_clears_baselines() {
            blocking(async {
                let local = ntv6_meta_bytes(1);
                let server = ntv6_meta_bytes(2);
                let (dir, mut st) = seeded("adopt", &local).await;
                st.blobs.insert(
                    "aa".repeat(16),
                    crate::plugins::sync::state::BlobSyncState {
                        version: 1,
                        content_nonce_hex: "bb".repeat(24),
                        doc_heads_hex: Vec::new(),
                    },
                );
                let t = FakeTransport::new();
                t.on(HttpMethod::Get, "/vault.meta", 200, server.clone());
                let out =
                    sync_meta_phase(&IO, &t, "tok", dir.path(), &mut st, false, Some(&[7u8; 32]))
                        .await;
                assert_eq!(out, MetaPhaseOutcome::Adopted);
                assert_eq!(
                    read_local(&dir).await,
                    server,
                    "server bytes written verbatim"
                );
                assert!(st.blobs.is_empty(), "M1 refresh cleared the baselines");
                assert_eq!(
                    st.meta_baseline_hex.as_deref(),
                    Some(super::super::sha256_hex(&server).as_str())
                );
            });
        }

        #[test]
        fn a_lower_epoch_is_refused_as_a_rollback() {
            blocking(async {
                let local = ntv6_meta_bytes(2);
                let server = ntv6_meta_bytes(1);
                let (dir, mut st) = seeded("rollback", &local).await;
                let t = FakeTransport::new();
                t.on(HttpMethod::Get, "/vault.meta", 200, server);
                let out =
                    sync_meta_phase(&IO, &t, "tok", dir.path(), &mut st, false, Some(&[7u8; 32]))
                        .await;
                assert_eq!(out, MetaPhaseOutcome::Skipped);
                assert_eq!(
                    read_local(&dir).await,
                    local,
                    "a rollback must not regress the meta"
                );
            });
        }

        #[test]
        fn a_member_device_adopts_but_never_pushes() {
            blocking(async {
                // Local epoch 1 differs from the server's equal-epoch copy and is
                // dirty; the server is unchanged since our baseline. A MEMBER
                // (root_key None) must NOT push; an OWNER pushes.
                let server = ntv6_meta_bytes(1);
                let local = ntv6_meta_bytes(1);
                let (dir, mut st) = seeded("member", &local).await;
                st.meta_baseline_hex = Some(super::super::sha256_hex(&server));
                mark_vault_meta_dirty(&IO, dir.path()).await.unwrap();
                let t = FakeTransport::new();
                t.on(HttpMethod::Get, "/vault.meta", 200, server);
                t.on(HttpMethod::Put, "/vault.meta", 200, b"{}".to_vec());
                let member =
                    sync_meta_phase(&IO, &t, "tok", dir.path(), &mut st, false, None).await;
                assert_eq!(member, MetaPhaseOutcome::NoChange);
                assert!(
                    !t.requests()
                        .iter()
                        .any(|r| r.1 == "/vault.meta" && r.0 == HttpMethod::Put),
                    "a member must never write vault.meta"
                );
            });
        }

        // myne-md/myne#795: after the owner migrates NTV5->NTV6 locally, the server
        // still holds the NTV5 copy (the migration never pushes). The meta phase
        // must PUBLISH the local NTV6 generation, not skip it, or a member's accept
        // fetches NTV5 and dies at parse forever.
        #[test]
        fn a_one_sided_local_ntv6_is_pushed_and_never_adopts_the_server_ntv5() {
            blocking(async {
                let local = ntv6_meta_bytes(1);
                let server = ntv5_meta_bytes();
                let (dir, mut st) = seeded("gen-push", &local).await;
                mark_vault_meta_dirty(&IO, dir.path()).await.unwrap();
                let t = FakeTransport::new();
                t.on(HttpMethod::Get, "/vault.meta", 200, server);
                t.on(HttpMethod::Put, "/vault.meta", 200, b"{}".to_vec());
                let out =
                    sync_meta_phase(&IO, &t, "tok", dir.path(), &mut st, false, Some(&[7u8; 32]))
                        .await;
                assert_eq!(out, MetaPhaseOutcome::Pushed);
                assert!(
                    t.requests()
                        .iter()
                        .any(|r| r.0 == HttpMethod::Put && r.1 == "/vault.meta"),
                    "the migrated NTV6 meta must be PUT to the server"
                );
                assert_eq!(
                    read_local(&dir).await,
                    local,
                    "the local NTV6 meta must not be overwritten by the server's NTV5"
                );
                assert_eq!(
                    st.meta_baseline_hex.as_deref(),
                    Some(super::super::sha256_hex(&local).as_str())
                );
            });
        }

        // A member never holds `root_key`, so it can never have migrated; it must
        // not push when it somehow sees a one-sided local NTV6.
        #[test]
        fn a_one_sided_local_ntv6_is_not_pushed_by_a_member() {
            blocking(async {
                let local = ntv6_meta_bytes(1);
                let server = ntv5_meta_bytes();
                let (dir, mut st) = seeded("gen-member", &local).await;
                mark_vault_meta_dirty(&IO, dir.path()).await.unwrap();
                let t = FakeTransport::new();
                t.on(HttpMethod::Get, "/vault.meta", 200, server);
                t.on(HttpMethod::Put, "/vault.meta", 200, b"{}".to_vec());
                let out = sync_meta_phase(&IO, &t, "tok", dir.path(), &mut st, false, None).await;
                assert_eq!(out, MetaPhaseOutcome::Skipped);
                assert!(
                    !t.requests()
                        .iter()
                        .any(|r| r.0 == HttpMethod::Put && r.1 == "/vault.meta"),
                    "a member must never push vault.meta"
                );
            });
        }
    }
}
