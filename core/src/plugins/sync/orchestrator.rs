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
use super::dictionary_payload::{merge_personal_dictionaries, PersonalDictionaryData};
use super::engine::{self, ChangedBlob, PullError, PushBlob, PushError};
use super::head_authority::{DeviceHeadSigner, HeadAuthority, SignedHeadCtx};
use super::state::{
    clear_vault_meta_dirty, persist_cycle_state, read_head_baseline, read_sync_state,
    update_sync_state, vault_meta_is_dirty, write_head_baseline, BlobSyncState, Persist, SyncState,
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
    CHATS_CATALOG_BLOB_V0_2_MAGIC, DEVICE_BINDING_BLOB_MAGIC, DICTIONARY_BLOB_MAGIC,
    DICTIONARY_BLOB_V0_2_MAGIC, MEMBER_NAMES_BLOB_MAGIC, PREFS_BLOB_MAGIC, PREFS_BLOB_V0_2_MAGIC,
    THEMES_BLOB_MAGIC, THEMES_BLOB_V0_2_MAGIC, VAULT_HEAD_FORMAT_V1,
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
    /// Why this cycle could not UPLOAD, when it could not (myne-md/myne#1027).
    ///
    /// `Some(token)` means the cycle ran under `PushGate::PollOnly` because this device cannot
    /// author a vault head; the token is the `AuthorityMissing` cause, or the failure class it
    /// maps to. `None` is an ordinary cycle. The cycle sets it AFTER the orchestrator returns,
    /// which is why the orchestrator's own constructor leaves it `None`, the decision is made
    /// one layer up, before the call, and carried back on the summary rather than in a second
    /// out-parameter.
    pub upload_blocked: Option<&'static str>,
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
    /// A remote `vault.dictionary` change was merged onto the on-disk dictionary
    /// this cycle (myne-md/myne#640). Reported for the same reason as
    /// `prefs_applied_remote`: the desktop holds the words in RAM for
    /// spell-checking, so the caller re-hydrates the spell state off this rather
    /// than leaving the open editor on a stale set until the next unlock.
    pub dictionary_applied_remote: bool,
    /// A remote `vault.themes` change was merged onto the on-disk store this
    /// cycle (MYND-486) — a theme added, edited or deleted on a peer. Reported
    /// for the same reason as `prefs_applied_remote` (the orchestrator stays
    /// AppHandle-free, so any refresh choreography lives at the command
    /// boundary).
    ///
    /// The cycle emits `THEMES_CHANGED_EVENT` off this flag (myne#943), which is
    /// what re-reads an open Appearance panel's list and repaints the palette;
    /// before that the list kept showing the pre-sync set until the panel was
    /// remounted. A same-name concurrent edit still resolves silently by LWW (a
    /// theme is not a note: no keep-both, no conflict surface).
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
    /// The binding merge refused a conflict this cycle: two copies bound one device to two
    /// people at the SAME version (myne-md/myne#976).
    ///
    /// **Names the devices rather than just saying "a conflict happened", and that is
    /// load-bearing.** The phase cannot repair a conflict (it is deliberately
    /// `AppHandle`-free AND session-free: it holds no `VaultRuntimeState`, so it cannot
    /// sign a row). The cycle boundary can, but only for THIS device: `reclaim_self_in_dir`
    /// moves this device's own key, so re-writing it does nothing whatsoever to a pair
    /// between two other members. A bare flag would have the boundary bump and re-seal its
    /// own row every cycle for a conflict it cannot touch, never push it (this path records
    /// no baseline), and log a repair that repaired nothing, which is the silent freeze
    /// this change exists to end wearing a green tick. Empty means no conflict.
    pub device_bindings_conflict: Vec<String>,

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
pub(super) const FETCH_WINDOW_MAX_BLOBS: usize = 256;

/// Upper bound on the ciphertext ONE batch window asks for, in bytes measured
/// before base64. Twin of [`PUSH_CHUNK_MAX_BYTES`], and the same 8 MiB, so the
/// encoded response (~4/3 of this plus per-entry framing, ≈11 MiB) stays far
/// under `transport::MAX_SYNC_RESPONSE_BYTES` (the cap sync passes into `crate::http`).
pub(super) const FETCH_WINDOW_MAX_BYTES: usize = 8 * 1024 * 1024;

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
        update_sync_state(io, vault_root, |state| {
            state.blobs.insert(
                id_hex.to_string(),
                BlobSyncState {
                    version,
                    content_nonce_hex: nonce_hex,
                    doc_heads_hex: Vec::new(),
                },
            );
            ((), Persist::Yes)
        })
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
/// `prefs-sync-id` / `themes-sync-id` / `personal-dictionary-sync-id` /
/// `chats-catalog-sync-id` / `agent-memory-catalog-sync-id` /
/// `agent-personality-sync-id`), never a KEK role: the id is server-visible, so
/// truncating a key derivation into it would leak key material to the sync plane.
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
/// `MYC1`/`MYC5` catalog, `MYP1`/`MYP5` prefs, `MYT1`/`MYT5` themes and
/// `MYD1`/`MYD5` dictionary envelopes. `None` unless `bytes` opens with one of
/// that family's magics.
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

/// `vault.dictionary`'s reserved 16-byte sync-plane blob-id:
/// `DeriveSubkey(root_key, "personal-dictionary-sync-id")[0..16]`
/// (`protocol.md` §3.4, myne-md/myne#640): the `prefs_sync_id` twin, and
/// group-derived on an `NTV6` session exactly like it.
pub fn dictionary_sync_id(root_key: &[u8; 32]) -> [u8; 16] {
    sync_id_for(root_key, SubkeyRole::PersonalDictSyncId)
}

/// The dictionary blob's sync discriminator (`read_singleton_nonce` over MYD1).
fn read_dictionary_nonce(bytes: &[u8]) -> Option<[u8; 24]> {
    read_singleton_nonce(
        bytes,
        &DICTIONARY_BLOB_MAGIC,
        &[&DICTIONARY_BLOB_V0_2_MAGIC],
    )
}

/// `vault.member-names`' reserved 16-byte sync-plane blob-id, derived through the
/// GROUP tier (`protocol.md` §3.4, `decisions/protocol/0666`): the
/// `themes_sync_id` archetype.
///
/// It cannot go through [`shared_sync_id`], and the reason is worth stating: this
/// family exists only on a vault that HAS a group tier, and it has **no `SubkeyRole`
/// counterpart** (there is no pre-B2B form to derive a root-tier id for), so
/// `SubkeyRole::shared_group_role` has no arm to map and a `SubkeyRole` argument would
/// not typecheck. `None` is therefore the whole pre-B2B answer: an `OwnerRoot` session
/// has no such blob and the phase stands down, exactly as the command layer answers
/// `NotASharedVault`.
fn member_names_sync_id(shared: &SharedSingletonKey) -> Option<[u8; 16]> {
    let group = shared.group_bytes()?;
    Some(crate::plugins::member_names::names_sync_id(&group))
}

/// The member-names blob's sync discriminator (`read_singleton_nonce` over MYO5).
///
/// `MYO5` is this family's ONE generation: it exists only on a vault with a group
/// tier, so there is no `MYO1` form and no later `MY?5` generation to accept beside
/// it. That is why the
/// `later` list is empty here and not because one was forgotten, which is the shape
/// `check-crypto-registries.mjs` rule 5 exists to catch: `MEMBER_NAMES_BLOB_MAGIC` is
/// deliberately off the `_V<n>_<m>_MAGIC` pattern, so the family has no later magic
/// for that rule to demand.
fn read_member_names_nonce(bytes: &[u8]) -> Option<[u8; 24]> {
    read_singleton_nonce(bytes, &MEMBER_NAMES_BLOB_MAGIC, &[])
}

/// What one binding-store refresh settled (myne-md/myne#1032).
///
/// Three outcomes, because the difference between the last two is a user-facing one: a vault that
/// does not vouch for a device is an integrity event, while a fetch that never happened is a
/// transient failure the UI already has a sentence for. Collapsing them into "no signers" reported
/// a network blip as tampering (review of myne-md/myne#1032).
enum SignerRefresh {
    /// Halves the signed roster vouches for, which the context did not already hold.
    Signers(Vec<DeviceHeadSigner>),
    /// Asked, and the vault does not vouch for this device.
    NotVouched,
    /// The question could not be answered; the carried error is the class to report.
    CouldNotAsk(PullError),
}

/// The device halves to retry an unverifiable `0x03` head with (myne-md/myne#1032).
///
/// The row that publishes a peer's signing halves travels in `vault.device-bindings`, and the pull
/// that its head blocks is the only route to that blob: the head is verified before the page's
/// metas are applied, so the very response carrying the row is refused. This breaks that circle by
/// fetching the ONE blob the group key addresses, decoding it (AEAD, so a forged copy closes), and
/// returning the halves the signed roster vouches for.
///
/// Read-only. The store's own sync phase persists and pushes the merged result on a later cycle;
/// nothing here writes, and nothing here adopts a head.
///
/// An empty answer means "the vault's own binding store does not know this device either", which
/// the caller reports as it found it.
async fn refresh_head_signers(
    io: &dyn crate::vault_io::VaultIo,
    transport: &dyn SyncTransport,
    token: &str,
    shared: &SharedSingletonKey,
    vault_root: &Path,
    head_authority: &HeadAuthority<'_>,
) -> SignerRefresh {
    // A verification set comes from a roster this device has VERIFIED; without one there is
    // nothing to check a fetched row against, and an unverified row must never become a signer
    // (`authority`'s "verification is not optional").
    let HeadAuthority::Signed(ctx) = head_authority else {
        return SignerRefresh::CouldNotAsk(PullError::HeadInvalid);
    };
    if ctx.roster_publics.is_empty() {
        // No verified roster means no row can be checked, so the question cannot be answered —
        // and an unverified row must never become a signer (`authority`'s "verification is not
        // optional").
        return SignerRefresh::CouldNotAsk(PullError::HeadInvalid);
    }
    let Some(group) = shared.group_bytes() else {
        return SignerRefresh::CouldNotAsk(PullError::HeadInvalid);
    };
    let Some(id) = device_bindings_sync_id(shared) else {
        return SignerRefresh::CouldNotAsk(PullError::HeadInvalid);
    };
    let Ok(resolved) =
        crate::plugins::device_binding::resolve_bindings_from_group_key(io, &group, vault_root)
            .await
    else {
        return SignerRefresh::CouldNotAsk(PullError::HeadInvalid);
    };
    let key = resolved.borrow();
    let bytes = match download_blob_backoff(transport, token, &id) {
        Ok(bytes) => bytes,
        // A fetch that did not happen is NOT the vault saying "this device is not mine", so it
        // must not become an integrity verdict. The transport's own error carries the right
        // class (revoked, unauthenticated, offline) and the UI already has copy for each.
        Err(err) => {
            tracing::warn!(
                stage = "sync_head_signers",
                event = "binding_store_fetch_failed",
                "the device-binding store could not be fetched to verify a peer's head; the \
                 refusal stands"
            );
            return SignerRefresh::CouldNotAsk(err);
        }
    };
    let Ok(remote) = protocol::decode_device_binding_blob(
        key.key,
        key.account_number_hash,
        key.group_key_epoch,
        &bytes,
    ) else {
        // Served bytes that do not open under this vault's group key prove nothing and add no
        // signer. §11.3 in one line.
        tracing::warn!(
            stage = "sync_head_signers",
            event = "binding_store_refused",
            "the served device-binding blob did not decode; no signer is added"
        );
        return SignerRefresh::CouldNotAsk(PullError::HeadInvalid);
    };
    // An UNREADABLE local store is "could not ask", not "nothing is bound" (review of
    // myne-md/myne#1032): an empty local side would let a stale served copy resurrect a tombstone
    // this device holds, and the signer it adds would be one the vault has withdrawn.
    let Ok(local) =
        crate::plugins::device_binding::read_device_bindings_in_dir(io, vault_root, &key).await
    else {
        return SignerRefresh::CouldNotAsk(PullError::HeadInvalid);
    };
    // MERGE, not replace: a served copy older than this device's cannot resurrect a tombstone, and
    // `merge_device_bindings`' one refusal (one device, two people, one version) has no winner, in
    // which case the local truth is all that is used.
    let merged = match protocol::merge_device_bindings(&local, &remote) {
        Ok(merged) => merged,
        Err(_) => {
            // The one refusal that is not corruption: one device bound to two people at one
            // version. The local truth is all that is used, and the case is logged because it is
            // the one shape where the retry cannot succeed.
            tracing::warn!(
                stage = "sync_head_signers",
                event = "binding_store_merge_conflict",
                "the served device-binding store conflicts with the local one; the retry uses \
                 local truth only"
            );
            local
        }
    };
    let signers = super::authority::verified_signers(&merged, &ctx.roster_publics);
    // Only the halves the context does not already hold: a retry with an unchanged set would ask
    // the same question twice.
    let extra: Vec<DeviceHeadSigner> = signers
        .into_iter()
        .filter(|candidate| {
            !ctx.device_signers.iter().any(|held| {
                held.device_id == candidate.device_id && held.public == candidate.public
            })
        })
        .collect();
    if extra.is_empty() {
        // Asked, and the vault does not vouch for that device: this IS the integrity answer.
        tracing::warn!(
            stage = "sync_head_signers",
            event = "binding_store_silent",
            "the fetched device-binding store knows no new signer for this head"
        );
        return SignerRefresh::NotVouched;
    }
    // `info`, not `warn`: this is the ordinary first-contact recovery, and it repeats until the
    // bindings phase persists the fetched row (review of myne-md/myne#1032).
    tracing::info!(
        stage = "sync_head_signers",
        event = "binding_store_refreshed",
        extra = extra.len(),
        "fetched the device-binding store to verify a peer's device-signed head"
    );
    SignerRefresh::Signers(extra)
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
/// `MYU5` is this family's ONE generation, existing on every vault with a group tier
/// exactly as `MYO5` does: there
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

/// The dictionary phase's RAM push-gate baselines, keyed by vault root: the
/// `prefs_gate_baselines` shape for `vault.dictionary` (myne-md/myne#640).
///
/// A separate map rather than the prefs one: the two families' discriminators
/// are different objects, and sharing a map would let one family's baseline
/// answer for the other's gate.
fn dictionary_gate_baselines() -> &'static std::sync::Mutex<HashMap<std::path::PathBuf, String>> {
    static M: std::sync::OnceLock<std::sync::Mutex<HashMap<std::path::PathBuf, String>>> =
        std::sync::OnceLock::new();
    M.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

/// The current RAM push-gate baseline for this vault, if any.
fn dictionary_gate_baseline(vault_root: &Path) -> Option<String> {
    dictionary_gate_baselines()
        .lock()
        .expect("dictionary gate baseline lock")
        .get(vault_root)
        .cloned()
}

/// Record `hash` as the RAM push-gate baseline for this vault.
fn set_dictionary_gate_baseline(vault_root: &Path, hash: String) {
    dictionary_gate_baselines()
        .lock()
        .expect("dictionary gate baseline lock")
        .insert(vault_root.to_path_buf(), hash);
}

/// The dictionary push gate's discriminator: SHA-256 (lowercase hex) of the
/// canonical `0x02` payload bytes.
///
/// RAM-only and never at rest, exactly like `shared_subset_hash`: persisting an
/// unkeyed digest of decrypted words would hand a filesystem observer a
/// confirmation oracle over the user's private vocabulary (SYNC-3).
fn dictionary_payload_hash(view: &PersonalDictionaryData) -> String {
    use sha2::{Digest, Sha256};
    super::to_hex(&Sha256::digest(view.canonicalized().encode()))
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
/// device having seen the consent screen. `agent-tooling/docs/spec/sync-protocol.md` §10.2.1
/// and `agent-tooling/docs/threat-model.md` TB13 both name this seed path as one of the two
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
                // so, which is exactly what `agent-tooling/docs/threat-model.md` TB13 names
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

    // §11.3 gate: before the write and before the baseline adoption.
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
///   turns are immutable except for the one monotone decision marker, which is
///   why a mismatch is reconciled rather than unreachable
///   (`conflict::merge_turn_content`), and determinism beats
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

        // Merge on the id lists; objects come from a by-id union whose content
        // rule is `merge_turn_content`: LOCAL wins a mismatch, except for the
        // monotone decision marker, where the decided copy wins in either
        // direction (myne-md/myne#894). A settled turn used to be immutable for
        // every field, which is what made local-wins a fixed point; the marker is
        // the one field a settled turn can gain, so the rule has to know about it
        // or an undecided copy silently overwrites a decision on every pull.
        let merged_ids = crate::plugins::sync::conflict::merge_chats_turns(&local_ids, &remote_ids);
        let mut local_by_id: std::collections::HashMap<&str, &serde_json::Value> =
            std::collections::HashMap::new();
        for (id, obj) in local_ids.iter().zip(local_turns.iter()) {
            local_by_id.insert(id.as_str(), obj);
        }
        let mut remote_by_id: std::collections::HashMap<&str, &serde_json::Value> =
            std::collections::HashMap::new();
        for (id, obj) in remote_ids.iter().zip(remote_turns.iter()) {
            remote_by_id.insert(id.as_str(), obj);
        }
        let merged_turns: Vec<serde_json::Value> = merged_ids
            .iter()
            .map(|id| {
                match (
                    local_by_id.remove(id.as_str()),
                    remote_by_id.remove(id.as_str()),
                ) {
                    (Some(l), Some(r)) => crate::plugins::sync::conflict::merge_turn_content(l, r),
                    (Some(l), None) => l.clone(),
                    (None, Some(r)) => r.clone(),
                    (None, None) => serde_json::Value::Null,
                }
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

/// The dictionary phase's outcome (myne-md/myne#640; `sync-protocol.md` §10.2.1).
struct DictionaryPhase {
    /// The dictionary blob needs a push: a local-only change, a merge that beat
    /// the server's payload, or the server has never held one.
    dirty: bool,
    /// A remote change was merged onto the on-disk dictionary this cycle: the
    /// caller re-hydrates the desktop spell state off this.
    applied_remote: bool,
    /// The exact bytes to push, carried out of the phase whenever `dirty` (the
    /// myne#436 single-derivation discipline: the push site never re-derives a
    /// key).
    push_bytes: Option<Vec<u8>>,
    /// `dictionary_payload_hash` of the view the phase settled on; the push site
    /// records it as the RAM push-gate baseline once the push lands (the
    /// `PrefsPhase::shared_hash` shape).
    gate_hash: String,
}

impl DictionaryPhase {
    /// No reconciliation ran: an EXISTING local blob could not be read, so
    /// nothing is dirty, nothing is adopted and nothing pushes. See
    /// [`sync_dictionary_phase`] for why this is a refusal rather than an empty
    /// dictionary.
    fn skipped() -> Self {
        Self {
            dirty: false,
            applied_remote: false,
            push_bytes: None,
            gate_hash: String::new(),
        }
    }
}

/// `<vault>/vault.dictionary`: the MYD1/MYD5 dictionary singleton.
fn dictionary_file_path(vault_root: &Path) -> std::path::PathBuf {
    vault_root.join("vault.dictionary")
}

/// Decode a `vault.dictionary` inner plaintext under its `dict_format_version`.
///
/// The codec is payload-agnostic, so the caller that has just opened the
/// envelope asks it which generation the bytes are and dispatches here. A `0x01`
/// payload promotes to the `0x02` shape with no clocks, which is exactly how a
/// pre-feature entry loses to the first clocked write.
fn parse_dictionary_payload(
    format: Option<u8>,
    plaintext: &[u8],
) -> Option<PersonalDictionaryData> {
    crate::plugins::sync::dictionary_payload::decode_dictionary_payload(format, plaintext)
}

/// Pull-side `vault.dictionary` reconciliation (myne-md/myne#640).
///
/// The `sync_prefs_phase` twin: a synced singleton outside the vault-head
/// manifest, pushed and pulled verbatim on the generic `/sync/blob` channel with
/// CAS, merged post-decrypt by `sync-protocol.md` §10.2.1's union-with-per-word-
/// removal-clocks. Three things are the family's own rather than inherited:
///
/// 1. **The blob is `root_key`-derived and `itemsKey`-independent**
///    (`SubkeyRole::PersonalDictKey`), like prefs/search/themes: the phase does
///    not ride the group tier for its KEK. Its sync id DOES route through
///    [`shared_sync_id`], so an `NTV6` member addresses the same blob under the
///    group key; the decision entry (`agent-tooling/design-notes/protocol/`) states the
///    member consequence (one shared vault dictionary).
/// 2. **An EXISTING but unreadable local blob is a REFUSAL, not an empty
///    dictionary** (myne#255). The prefs phase answers a local decode failure
///    with `PrefsView::default()`; doing that here would merge the peer's copy
///    against nothing and write the result over the user's real words. So a
///    decode or parse failure on the local blob returns
///    [`DictionaryPhase::skipped`]: no reconciliation, nothing dirty, nothing
///    pushed, the rest of the cycle proceeds. "Absent" and "unreadable" are
///    different facts and only the first means empty.
/// 3. **The push gate is the blob nonce plus a RAM payload hash.** The
///    dictionary has no device-local field (unlike prefs), so a local write
///    always changes the payload; the hash is there to absorb a re-encrypt of
///    identical content (the import path persists even when every word was
///    already present), which would otherwise push once for nothing. It is
///    RAM-only for the `shared_subset_hash` reason: an at-rest digest of
///    decrypted words would be a confirmation oracle over the user's private
///    vocabulary (SYNC-3).
#[allow(clippy::too_many_arguments)]
async fn sync_dictionary_phase(
    io: &dyn crate::vault_io::VaultIo,
    transport: &dyn SyncTransport,
    token: &str,
    shared: &SharedSingletonKey,
    account_number_hash: &[u8; 16],
    vault_root: &Path,
    state: &mut SyncState,
    dictionary_id: &[u8; 16],
    remote_record: Option<&ChangedBlob>,
    version: MetaVersion,
) -> Result<DictionaryPhase, SyncCycleError> {
    // Hold the shared-singleton barrier across the WHOLE read-merge-write
    // (myne-md/myne#711 task 15). The desktop spell plugin writes this file from
    // outside this crate and already takes the shared side, so without this a
    // group rotation's exclusive reseal could interleave with the sync write.
    let _quiesce = crate::singleton_quiesce::shared().await;
    // Order this read-merge-write against the desktop spell plugin, which holds
    // the same mutex. `shared()` above only keeps a reseal out (myne-md/myne#640).
    let _write_guard = crate::plugins::sync::dictionary_payload::write_mutex()
        .lock()
        .await;

    let key = shared.derive(version, SubkeyRole::PersonalDictKey);
    let path = dictionary_file_path(vault_root);
    // ABSENT is the empty dictionary; a read that FAILED is not. Collapsing the
    // two is the "default on error, then persist" shape (#255): the empty view
    // would be merged and written over a file this device never read.
    let local_bytes = match io.read(&path).await {
        Ok(bytes) => Some(bytes),
        Err(crate::io_failure_kind::IoFailureKind::NotFound) => None,
        Err(_) => {
            tracing::warn!(
                stage = "dictionary",
                event = "phase_skipped",
                "vault.dictionary could not be read; refusing to treat the failure as empty"
            );
            return Ok(DictionaryPhase::skipped());
        }
    };
    let local_nonce = local_bytes.as_deref().and_then(read_dictionary_nonce);

    // §9.13.4 / #255 read semantic, stated as code: ABSENT is the empty
    // dictionary, an EXISTING blob that will not open is a refusal.
    let local_view = match local_bytes.as_deref() {
        None => PersonalDictionaryData::default(),
        Some(bytes) => {
            let opened = protocol::decode_dictionary_blob_versioned(
                version,
                &key,
                account_number_hash,
                bytes,
            )
            .map_err(|_| ())
            .and_then(|plaintext| {
                parse_dictionary_payload(protocol::dictionary_blob_format(bytes), &plaintext)
                    .ok_or(())
            });
            match opened {
                Ok(view) => view.canonicalized(),
                Err(()) => {
                    tracing::warn!(
                        stage = "dictionary",
                        event = "phase_skipped",
                        "vault.dictionary exists but could not be read; refusing to treat it as empty"
                    );
                    return Ok(DictionaryPhase::skipped());
                }
            }
        }
    };

    let id_hex = hex(dictionary_id);
    let baseline_nonce_hex = state
        .blobs
        .get(&id_hex)
        .map(|b| b.content_nonce_hex.clone());

    // A remote revision is worth reconciling only when it is neither our own
    // bytes nor a server revision we already reconciled.
    let remote_changed = remote_record
        .map(|r| {
            Some(r.content_nonce) != local_nonce
                && Some(hex(&r.content_nonce)) != baseline_nonce_hex
        })
        .unwrap_or(false);

    // §11.3 gate: before the write and before the baseline adoption.
    let verified = verified_singleton_download(
        transport,
        token,
        remote_record,
        remote_changed,
        read_dictionary_nonce,
        "dictionary",
    )?;
    let refused = matches!(verified, SingletonPull::Refused);

    if let SingletonPull::Verified(rec, remote_bytes) = verified {
        // A remote payload that will not open is a REFUSAL, not empty-remote
        // (myne-md/myne#640). Collapsing it is the asymmetric case the spec
        // forbids: with no local words `merge(empty, empty) == remote_view` is
        // true, so the undecodable bytes would be adopted verbatim; with local
        // words the same collapse re-pushes a `0x02` blob over a newer peer's
        // record and destroys it. `sync_member_names_phase` takes this posture
        // for the same reason.
        let remote_view = match protocol::decode_dictionary_blob_versioned(
            version,
            &key,
            account_number_hash,
            &remote_bytes,
        )
        .ok()
        .and_then(|plaintext| {
            parse_dictionary_payload(protocol::dictionary_blob_format(&remote_bytes), &plaintext)
        }) {
            Some(view) => view.canonicalized(),
            None => {
                tracing::warn!(
                    stage = "dictionary",
                    event = "phase_skipped",
                    "a remote vault.dictionary could not be read; refusing to overwrite it"
                );
                return Ok(DictionaryPhase::skipped());
            }
        };

        let merged = merge_personal_dictionaries(&local_view, &remote_view);
        let applied_remote = merged != local_view;
        let merged_hash = dictionary_payload_hash(&merged);

        if merged == remote_view {
            // Adopt the server bytes VERBATIM: byte-identical blob + baseline ==
            // server (version, nonce); nothing to push. Re-encrypting an
            // already-agreeing dictionary would churn the nonce and push forever.
            io.write(&path, &remote_bytes, crate::vault_io::WriteOpts::default())
                .await
                .map_err(|_| SyncCycleError::Io)?;
            record_blob_baseline(state, &id_hex, &rec);
            set_dictionary_gate_baseline(vault_root, merged_hash.clone());
            return Ok(DictionaryPhase {
                dirty: false,
                applied_remote,
                push_bytes: None,
                gate_hash: merged_hash,
            });
        }

        // The merge beat the server's payload (or upgraded a legacy one) → write
        // it fresh and push it this cycle against the server's current version.
        // The local file (freshly re-encrypted) intentionally carries a different
        // nonce from the recorded CAS base.
        let merged_plain = merged.try_encode().ok_or(SyncCycleError::Io)?;
        let merged_bytes = protocol::encode_dictionary_blob_versioned(
            version,
            &key,
            account_number_hash,
            &merged_plain,
        )
        .map_err(|_| SyncCycleError::Io)?;
        io.write(&path, &merged_bytes, crate::vault_io::WriteOpts::default())
            .await
            .map_err(|_| SyncCycleError::Io)?;
        record_blob_baseline(state, &id_hex, &rec);
        // NOT `set_dictionary_gate_baseline` here: the push has not landed yet,
        // and a lost-CAS retry re-enters this phase with the server nonce equal
        // to the baseline and `dirty` false, so the tombstone would never be
        // re-sent. The push site records the gate baseline on success (the prefs
        // phase has the same split). myne-md/myne#640.
        return Ok(DictionaryPhase {
            dirty: true,
            applied_remote,
            push_bytes: Some(merged_bytes),
            gate_hash: merged_hash,
        });
    }

    // No (changed) remote record. Self-heal the CAS baseline so a re-enrolled or
    // migrated device stops registering as never-synced. Skipped when the pull was
    // REFUSED: §11.3 bars the baseline adoption as well as the disk write.
    if let Some(rec) = remote_record.filter(|_| !refused) {
        record_blob_baseline(state, &id_hex, rec);
    }
    let never_synced = !state.blobs.contains_key(&id_hex);
    let payload_hash = dictionary_payload_hash(&local_view);
    // No-change short-circuit: every dictionary write re-encrypts under a fresh
    // nonce, so a local blob whose outer nonce still equals the synced baseline's
    // is provably byte-untouched since the last sync.
    let baseline_nonce_now = state
        .blobs
        .get(&id_hex)
        .map(|b| b.content_nonce_hex.clone());
    let nonce_clean =
        baseline_nonce_now.is_some() && local_nonce.map(|n| hex(&n)) == baseline_nonce_now;
    // §10.2.1 initial publish, the prefs shape: a server that has never held a
    // dictionary receives this device's unconditionally. A vault with NO local
    // file stays dictionary-silent (an empty dictionary is the absent file), so
    // `local_bytes.is_some()` is a conjunct rather than an afterthought.
    let dirty = local_bytes.is_some()
        && (never_synced
            || (!nonce_clean
                && dictionary_gate_baseline(vault_root).as_deref() != Some(payload_hash.as_str())));
    Ok(DictionaryPhase {
        dirty,
        applied_remote: false,
        // The VERIFIED local bytes: the same ones the push must carry.
        push_bytes: if dirty { local_bytes } else { None },
        gate_hash: payload_hash,
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
/// 1. **It needs the group tier, which both tail generations carry.** The store is
///    group-sealed and its AAD binds the group
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
    // No group tier: a pre-B2B `OwnerRoot` session holds no group key, so there is no KEK
    // to derive and no blob to address. `NTV6` and `NTV7` both carry it.
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
    /// `merge_device_bindings` answered `ConflictingBinding`: nothing was written and the
    /// cycle recorded no baseline. Carried out rather than only logged because the repair is
    /// a SIGNED write, which this phase cannot perform (it holds no session) and the cycle
    /// boundary can. The keys say WHICH devices are tied, so the boundary repairs only a pair
    /// this device is party to ([`conflicting_device_ids`]).
    conflict: Vec<String>,
}

impl DeviceBindingsPhase {
    /// No group tier, no store: a pre-B2B vault has no `vault.device-bindings` and no
    /// epoch to address one under, so there is nothing to pull, merge or push.
    fn idle() -> Self {
        Self {
            dirty: false,
            applied_remote: false,
            push_bytes: None,
            conflict: Vec::new(),
        }
    }
}

/// Pull-side `vault.device-bindings` reconciliation, the `sync_member_names_phase` twin.
///
/// Every structural decision is the same as its sibling's and for the same reasons: it needs
/// the group tier, which both tail generations carry (the store is group-sealed and its AAD
/// binds the epoch); the KEK and its
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
    // No group tier: a pre-B2B `OwnerRoot` session holds no group key, so there is no KEK to
    // derive and no blob to address. `NTV6` and `NTV7` both carry it.
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

    // The local map, through the family's own reader: ABSENT reads as the empty map and an
    // undecodable store is an ERROR, so the two cannot be flattened into one answer here
    // (review of myne-md/myne#1032; the chats catalogue one phase up already answers it this
    // way). Treating a damaged store as empty makes `merge(empty, remote) == remote`, which is
    // read below as "the server's copy is complete" and written back over the local file.
    let read_local = || async {
        crate::plugins::device_binding::read_device_bindings_in_dir(io, vault_root, &key).await
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
        // Read through the family's own reader: ABSENT is the empty map and an undecodable
        // store is an ERROR, because flattening them makes `merge(empty, remote) == remote`,
        // which the arm below reads as "the server copy is complete" and writes back over the
        // local file (review of myne-md/myne#1032).
        let local_map = match read_local().await {
            Ok(map) => map,
            Err(err) => {
                tracing::warn!(
                    stage = "device_bindings",
                    event = "local_refused",
                    error = ?err,
                    "vault.device-bindings could not be read; no local mutation this cycle"
                );
                return Ok(DeviceBindingsPhase::idle());
            }
        };
        // The ONE refusal that is not corruption: two peers hold the same device under two
        // DIFFERENT people at the SAME version, which has no winner. Refusing leaves the
        // local store untouched and the cycle records no baseline, so the next cycle
        // retries with whatever the peers have written by then; a fresh claim on either
        // device (a strictly higher version) is the repair.
        let merged = match merge_device_bindings(&local_map, &remote_map) {
            Ok(merged) => merged,
            Err(_) => {
                let conflicts = protocol::conflicting_device_ids(&local_map, &remote_map);
                tracing::warn!(
                    stage = "device_bindings",
                    event = "merge_conflict",
                    conflicts = conflicts.len(),
                    "two copies bind one device to two people at the same version; no local mutation, the cycle boundary re-claims this device's own row if it is one of them"
                );
                return Ok(DeviceBindingsPhase {
                    conflict: conflicts,
                    ..DeviceBindingsPhase::idle()
                });
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
            conflict: Vec::new(),
        });
    }

    // No (changed) remote record: dirty iff the local file drifted from the synced
    // baseline. Every write re-encrypts under a fresh nonce, so a local blob whose outer
    // nonce still equals the baseline's is provably byte-untouched since the last sync. A
    // vault where no device has claimed yet (no store, no baseline) is deliberately NOT
    // pushed; a store holding ONLY tombstones IS, because a removal must propagate.
    // An unreadable store is NOT dirty here: this arm pushes the bytes it read, and the
    // question "is the local file ahead of the baseline" needs a store it can read. The
    // family's reader has already answered the damage case above by returning early when the
    // remote changed, and a damaged local file with no remote change is left for the next
    // cycle rather than pushed over a good server copy.
    let local_map_empty = read_local().await.map(|m| m.is_empty()).unwrap_or(true);
    let local_nonce_hex = local_nonce.map(|n| hex(&n));
    let dirty = local_bytes.is_some()
        && local_nonce_hex != baseline_nonce_hex
        && !(baseline_nonce_hex.is_none() && local_map_empty);
    Ok(DeviceBindingsPhase {
        dirty,
        applied_remote: false,
        push_bytes: if dirty { local_bytes } else { None },
        conflict: Vec::new(),
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

    // B2B/person branch (myne-md/myne#711 task 13, extended to the third
    // generation by the myne-md/myne#911 review). An `NTV6` or `NTV7`
    // `vault.meta` carries the B2B tail OUTSIDE `VaultMeta` (the owner-wrapped
    // group key, the group-key epoch and the signed roster), so it is NEVER
    // re-serialized from the parsed `VaultMeta`: only a VERBATIM write of one
    // side's bytes is safe (`serialize_vault_meta_v0_2` would drop the tail).
    //
    // **The generation comparison is ordered, not a magic test, and that is the
    // review's first finding.** `magic == NTV6` classified an `NTV7` frame as
    // "older than B2B", so a server still holding `NTV6` was ADOPTED over it
    // verbatim (the person wrap gone, the password the only credential left),
    // and the mirror arm pushed local `NTV6` over a server `NTV7` (the only
    // person wrap deleted server-side). Both were ordinary cycles, and the
    // second silently reversed an upgrade the spec calls irreversible.
    // `protocol::vault_meta_generation` orders `MYV1`/`NTV5` < `NTV6` < `NTV7`,
    // so: local newer means push, server newer means adopt, equal merges by
    // epoch, and a strictly older server is never allowed to overwrite what this
    // device holds.
    //
    // The epoch rule below is unchanged: a strictly-greater server epoch is
    // adopted; a lower one is a rollback and is refused; equal epochs must agree,
    // and at equal epoch the server may still carry a newer roster (an invite
    // writes the roster at the SAME epoch), so a server-only change is adopted
    // too. A concurrent change at the same epoch cannot be tie-broken and is
    // refused. A MEMBER device (no `root_key`) adopts but never writes
    // `vault.meta`.
    let local_generation = protocol::vault_meta_generation(&local_bytes);
    let server_generation = protocol::vault_meta_generation(&server_bytes);
    if local_generation != protocol::VaultMetaGeneration::Legacy
        || server_generation != protocol::VaultMetaGeneration::Legacy
    {
        let member = root_key.is_none();
        // One-sided generation transition, LOCAL side: this device performed an
        // owner-only upgrade (`NTV5`->`NTV6`, or `NTV6`/`NTV5`->`NTV7`) and the
        // server still holds the older copy. This is the ONLY path that carries a
        // migrated `vault.meta` to the server: the migration itself does not push,
        // and the equal-generation logic below cannot merge a one-sided frame. A
        // MEMBER never holds `root_key`, so it can never have migrated.
        //
        // **`local > server` is also what keeps an older server frame from ever
        // replacing a newer local one**, and that is why there is no separate
        // "refuse a rollback" arm above this one: the two conditions are the same
        // predicate, and the first draft of this fix had both, which made the
        // push below unreachable. The person wrap survives because this arm
        // pushes rather than adopts.
        if local_generation > server_generation {
            if !member
                && may_push
                && super::enroll::put_vault_meta(transport, &put_token, &local_bytes).is_ok()
            {
                state.meta_baseline_hex = Some(local_hash);
                let _ = clear_vault_meta_dirty(io, vault_root).await;
                tracing::info!(
                    stage = "meta_phase",
                    event = "meta_generation_pushed",
                    "published a local vault generation transition to the server"
                );
                return MetaPhaseOutcome::Pushed;
            }
            return MetaPhaseOutcome::Skipped;
        }
        // One-sided generation transition, SERVER side: another owner device
        // upgraded this vault. Adopt the server's bytes verbatim, verified under
        // our root key when we hold one. `parse_b2b_tail` accepts both tail
        // generations, so a peer's `NTV7` frame is verifiable here too.
        if server_generation > local_generation {
            // A MEMBER cannot verify a tail frame at all (no root key), so it
            // must not adopt one on the server's word (myne-md/myne#797): the
            // member's own group package, verified against the PINNED owner half,
            // is the only route to a new generation. Hold and retry.
            if member {
                tracing::warn!(
                    stage = "meta_phase",
                    event = "meta_generation_held_for_member",
                    "holding an unverified vault generation transition on a member device"
                );
                return MetaPhaseOutcome::Skipped;
            }
            let Some(server_tail) = protocol::parse_b2b_tail_any(&server_bytes).ok() else {
                return MetaPhaseOutcome::Skipped;
            };
            if let Some(root_key) = root_key {
                let group = match protocol::unlock_group_key_ntv6(
                    &server_tail,
                    &protocol::OwnerKey::new(*root_key),
                ) {
                    Ok(group) => group,
                    Err(_) => return MetaPhaseOutcome::Skipped,
                };
                if protocol::person_invite::open_group_roster(
                    &group,
                    &server_tail.base.account_number_hash,
                    server_tail.group_key_epoch,
                    &server_tail.signed_roster_envelope,
                )
                .is_none()
                {
                    return MetaPhaseOutcome::Skipped;
                }
            }
            // **A newer person generation is STAGED, never adopted verbatim
            // (myne-md/myne#911 review; extended to `NTV8` by the myne-md/myne#938
            // review).** `sync-protocol.md` §10 already requires it: a device that
            // sees a newer server generation MUST persist it as
            // `vault.meta.incoming` and leave `vault.meta` byte-identical, then
            // promote once the user's own credential has opened it. The reason is
            // sharper on this generation than on `NTV6`: the person wrap is the
            // vault's only second credential, and the checks above authenticate
            // the CREDENTIAL side (the group wrap and the roster), not the person
            // wrap. A hostile server can take the genuine frame, keep its password
            // wrap, append a person envelope sealed to its own key, and the
            // password still opens the adopted vault while the identity phrase is
            // now dead, silently, on every device that adopts it. Staging costs a
            // peer one unlock before it leaves the old generation, which is the
            // trade §10 chose.
            //
            // `>=` rather than `==`: an `NTV8` frame is the SAME move from this
            // device's side (the person wrap goes away) and the adopt arm below
            // would write it with no local password proven, which is the one thing
            // the old in-place upgrade refused to do. The staged copy is only ever
            // tried by a password unlock
            // (`vault_unlock`'s candidate order), so staging is what keeps the two
            // paths agreeing about when the wrap may move.
            if server_generation >= protocol::VaultMetaGeneration::Person {
                crate::plugins::vault_migrate::adopt::stage_incoming_meta(
                    io,
                    vault_root,
                    &server_bytes,
                )
                .await;
                tracing::info!(
                    stage = "meta_phase",
                    event = "meta_generation_staged",
                    "staged a newer person-wrapped vault generation for the next unlock to prove"
                );
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
                state.blobs.clear();
                state.meta_baseline_hex = Some(server_hash);
                let _ = clear_vault_meta_dirty(io, vault_root).await;
                tracing::info!(
                    stage = "meta_phase",
                    event = "meta_generation_adopted",
                    "adopted a peer's vault generation transition"
                );
                return MetaPhaseOutcome::Adopted;
            }
            return MetaPhaseOutcome::Skipped;
        }
        // Equal non-legacy generation. The tail is identical across `NTV6` and
        // `NTV7`, so the merge reads it through one parser and the bytes it
        // writes below are always the ADOPTED side's, never re-serialized.
        let (Some(local_ntv6), Some(server_ntv6)) = (
            protocol::parse_b2b_tail_any(&local_bytes).ok(),
            protocol::parse_b2b_tail_any(&server_bytes).ok(),
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
            // then refused as a rollback forever).
            //
            // A MEMBER holds no root key and CANNOT verify these bytes itself, so
            // it must not commit them on the server's word (myne-md/myne#797): a
            // hostile server that mints a high epoch would otherwise make the
            // member write it irreversibly, after which the genuine lower epoch is
            // refused as a rollback. The member instead HOLDS the adoption and
            // lets `member_adopt_rotation_from_host` commit it: but only after
            // its own delivered package has been fetched and opened at exactly
            // this epoch against the PINNED owner half. If the package is absent,
            // nothing is written and the next cycle retries.
            if member {
                tracing::info!(
                    stage = "meta_phase",
                    event = "ntv6_epoch_held_for_member",
                    "holding a newer group-key epoch until the member's package verifies it"
                );
                return MetaPhaseOutcome::Skipped;
            }
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
    // The record as this cycle LOADED it. Every persist below goes through
    // `persist_cycle_state`, which adopts only the fields that differ between this
    // snapshot and `state`, so a publish / enrolment / rotation that lands while this
    // cycle is on the wire is not undone by the cycle's next checkpoint
    // (myne-md/myne#964).
    let mut base = state.clone();

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
        persist_cycle_state(io, vault_root, &mut base, &state)
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
            &mut base,
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
                persist_cycle_state(io, vault_root, &mut base, &state)
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
    // What the cycle has already made the disk hold, for `persist_cycle_state`'s field
    // diff. Mutable because the merge advances it after every write.
    base: &mut SyncState,
    baseline_vv: &[VvEntry],
    baseline_seq: u64,
    from_cursor: u64,
    // The blob ids of notes OPEN in a live session (task 7): their pulled revision
    // is DEFERRED to `summary.deferred_live_pulls` rather than written.
    live_note_ids: &HashSet<[u8; 16]>,
) -> Result<SyncSummary, SyncCycleError> {
    // --- Content-epoch gate (myne-md/myne#797) ---
    //
    // A member's adoption installs the rotated tier on the live slot WITHOUT
    // re-keying local content (it cannot re-seal the credential store: it holds
    // neither the phrase nor the member password). Until the next credential
    // unlock runs that re-key, the on-disk blobs are still sealed under the
    // retired `itemsKey` while the slot holds the new one. Pushing them in that
    // window uploads ciphertext no peer at the current epoch can open, and
    // pulling current-epoch blobs would put a second, unreadable key epoch on the
    // same disk and make the next re-key's single-hop tolerance fail. So the
    // whole cycle stands down until the marker catches up; the next unlock does
    // that in the same step it re-seals the store.
    if let (Ok(Some(content_epoch)), Ok(meta)) = (
        crate::plugins::sync::state::read_content_epoch(io, vault_root).await,
        io.read(&vault_root.join("vault.meta")).await,
    ) {
        // Both tail generations. Reading only `NTV6` made this stand-down check a no-op on
        // `NTV7`, so a person-born vault whose local content lagged the group-key epoch went
        // on to re-seal under a retired `itemsKey` instead of waiting.
        if let Ok(b2b) = protocol::parse_b2b_tail_any(&meta) {
            if content_epoch < b2b.group_key_epoch {
                tracing::warn!(
                    stage = "sync_cycle",
                    event = "content_epoch_lagging",
                    content_epoch,
                    key_epoch = b2b.group_key_epoch,
                    "local content is still sealed under a retired itemsKey; standing down until the next unlock re-keys it"
                );
                return Ok(SyncSummary::default());
            }
        }
    }

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
    // `vault.dictionary` is the fourth shared singleton on this plane
    // (myne-md/myne#640). Same derivation shape as prefs/themes, so an `NTV6`
    // member addresses the owner's dictionary blob under the group key.
    let dictionary_id = shared_sync_id(shared, SubkeyRole::PersonalDictSyncId);
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
    // `root_key`). `agent-tooling/design-notes/protocol/0609` states it: those three families
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
    if let Some(n) = io
        .read(&dictionary_file_path(vault_root))
        .await
        .ok()
        .as_deref()
        .and_then(read_dictionary_nonce)
    {
        local.insert(dictionary_id, n);
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
    // Device halves fetched AFTER a first refusal (myne-md/myne#1032). Empty on the ordinary
    // attempt; filled once when the head turns out to be signed by a device this context cannot
    // verify, and the pull then runs again with them. Bounded to one fetch per attempt: a head
    // that still will not open after the vault's own binding store has been consulted is
    // reported as it is, not retried again.
    let mut extra_signers: Vec<DeviceHeadSigner> = Vec::new();
    let mut refreshed_signers = false;
    // The cursor this loop walks from. The reconcile recovery restarts the walk at 0, and the
    // bound is what keeps one attempt from fetching the same page forever.
    let mut pull_cursor = from_cursor;
    let page = loop {
        match engine::pull_to_stable(
            transport,
            head_authority,
            token,
            baseline_vv,
            pull_cursor,
            &local,
            reconcile_ran,
            rekey_rebase,
            &extra_signers,
        ) {
            Ok(p) => break p,
            // Its own arm rather than a fold into `HeadInvalid`, because the two do different
            // things: this one fetches the row that publishes the signer's halves and tries
            // again, at most once.
            Err(PullError::HeadSignerUnknown) if !refreshed_signers => {
                refreshed_signers = true;
                match refresh_head_signers(io, transport, token, shared, vault_root, head_authority)
                    .await
                {
                    SignerRefresh::Signers(signers) => {
                        extra_signers = signers;
                        continue;
                    }
                    // Asked, and the vault does not vouch for that device.
                    SignerRefresh::NotVouched => {
                        return Err(SyncCycleError::Pull(PullError::HeadSignerUnknown))
                    }
                    // Could not ask: NOT an integrity claim.
                    SignerRefresh::CouldNotAsk(err) => return Err(SyncCycleError::Pull(err)),
                }
            }
            // The reconcile walk runs INSIDE this loop (review of myne-md/myne#1032): it used to
            // be a `?` on its own `pull_to_stable`, so a device whose cursor was reclaimed met the
            // peer's unverifiable head on that pull and went straight to the tampering alert with
            // the repair never attempted — the first-contact-after-absence case this branch is
            // for.
            Err(PullError::CursorExpired) if !reconcile_ran => {
                reconcile_ran = true;
                state.cursor = 0;
                persist_cycle_state(io, vault_root, base, state)
                    .await
                    .map_err(|_| SyncCycleError::Io)?;
                pull_cursor = 0;
                continue;
            }
            // A head that will not open is normally a forgery. On a device whose
            // sibling just ran the §10.4.1 migration it is instead the expected
            // consequence of a re-key, and the two are indistinguishable at the pull.
            // Ask the one question that separates them (#429): is the server's
            // `vault.meta` a NEWER generation than ours? Only the migration produces
            // that, and no server can fabricate it — a v0.2 meta opens only under
            // credentials the user holds.
            // The `if let` binds the server's meta because this device is about to
            // STAGE it (#447) rather than merely learn that it exists.
            //
            // ONE arm for both error kinds, on purpose (review of myne-md/myne#1032): a
            // re-key invalidates a device-signed head's signature exactly as it invalidates any
            // other, so a `HeadSignerUnknown` that survives the refresh must still get this
            // recovery. Two arms shadowed it for the whole `0x03` class.
            Err(e @ (PullError::HeadInvalid | PullError::HeadSignerUnknown)) => {
                let Some(newer) =
                    server_meta_of_newer_generation(transport, token, io, vault_root).await
                else {
                    return Err(SyncCycleError::Pull(e));
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
                crate::plugins::vault_migrate::adopt::stage_incoming_meta(io, vault_root, &newer)
                    .await;
                return Err(SyncCycleError::RekeyedElsewhere);
            }
            Err(e) => return Err(SyncCycleError::Pull(e)),
        }
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
            persist_cycle_state(io, vault_root, base, state)
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

    // --- dictionary phase (myne-md/myne#640): unconditional, every cycle ---
    // The fourth shared singleton: `vault.dictionary` is never head-committed and
    // its dirty blob rides the push batch below, exactly like prefs/themes. The
    // phase REFUSES rather than emptying when an existing local blob cannot be
    // read (#255), so a failure here is a skipped reconciliation, never a
    // destructive one; it does not take the cycle with it (the prefs-phase
    // reasoning: a settings-like blob that cannot be written must not stop the
    // notes phase).
    let remote_dictionary_rec = page
        .all_metas
        .iter()
        .find(|m| m.id == dictionary_id && m.attachment_id.is_none());
    let mut dictionary_phase = match sync_dictionary_phase(
        io,
        transport,
        token,
        shared,
        &account_number_hash,
        vault_root,
        state,
        &dictionary_id,
        remote_dictionary_rec,
        version,
    )
    .await
    {
        Ok(phase) => phase,
        Err(err) => {
            tracing::warn!(
                stage = "dictionary",
                event = "phase_skipped",
                error = ?err,
                "the dictionary phase failed; syncing notes anyway and retrying next cycle"
            );
            DictionaryPhase::skipped()
        }
    };

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
                && c.id != dictionary_id
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
                || c.id == dictionary_id
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
        persist_cycle_state(io, vault_root, base, state)
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
                    && m.id != dictionary_id
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

        // A dirty dictionary blob (local-only change, a merge that beat the
        // server's payload, or the initial publish) rides the same batch
        // (myne-md/myne#640). Same single-derivation discipline as themes
        // (myne#436): the bytes come from the phase, never re-derived here.
        if dictionary_phase.dirty {
            if let Some(bytes) = dictionary_phase.push_bytes.take() {
                if let Some(nonce) = read_dictionary_nonce(&bytes) {
                    let base = state
                        .blobs
                        .get(&hex(&dictionary_id))
                        .map(|b| b.version)
                        .unwrap_or(0);
                    to_push.push(PushBlob {
                        id: dictionary_id,
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
            // The dictionary push landed → its payload hash is the new push-gate
            // baseline (myne-md/myne#640, §10.2.1).
            if outcome.results.iter().any(|(id, _)| *id == dictionary_id) {
                set_dictionary_gate_baseline(vault_root, dictionary_phase.gate_hash.clone());
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
            persist_cycle_state(io, vault_root, base, state)
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
        write_head_baseline(io, vault_root, &sealed, head_authority.authors_format())
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
        write_head_baseline(io, vault_root, &sealed, head_authority.authors_format())
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
        // The upload decision belongs to `cycle`, which knows the authority verdict before it
        // ever calls here; it stamps this on the way back (myne-md/myne#1027).
        upload_blocked: None,
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
        dictionary_applied_remote: dictionary_phase.applied_remote,
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
        device_bindings_conflict: bindings_phase.conflict,
        pull_skipped,
        dropped,
        pulled_note_ids,
        remote_merged_note_ids,
        deferred_live_pulls,
    })
}

#[cfg(test)]
#[path = "orchestrator_tests.rs"]
mod tests;
