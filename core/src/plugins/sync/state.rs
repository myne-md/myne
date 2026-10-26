// SPDX-License-Identifier: AGPL-3.0
//! Device-local sync state (SYNC-12, MYND-424 task 4).
//!
//! Three things persist **device-local, never synced** (AS6/A13 — sync state
//! must not leak to the server):
//!
//! 1. **cursor** — the server-issued pull cursor (SYNC-6): a monotonic `u64`
//!    change-seq high-water mark (see the `cursor` field below).
//! 2. **last-seen head baseline** — the `MYH1` `vault.head-state` blob
//!    (`protocol.md` §9.15) via `protocol::encode_head_state` /
//!    `decode_head_state` (re-verifies the head's own MAC under `root_key`).
//! 3. **VV-observation log** — the sequence of `(head_id, version_vector)` the
//!    device has seen, the input MYND-427 uses to decide re-convergence
//!    (concurrency) vs never-reconverge (fork). Bounded to the last
//!    [`MAX_VV_LOG`] observations.
//!
//! All three are device-local plaintext (the `registry.json` / `sync-config`
//! precedent): they carry no note plaintext or key material. Their contents —
//! cursors, `device_id`s, VV counters, `head_id`s — are already server-visible
//! (heads are wire-relayed), so device-local plaintext leaks nothing new and the
//! head baseline deliberately has no AEAD (the head carries only server-visible
//! metadata, §9.15). They live under the vault root but are **excluded from the
//! sync taxonomy** (enforced by MYND-426 task 3); the file names are listed in
//! [`DEVICE_LOCAL_SYNC_FILES`].
//!
//! The store is **disk-backed and stateless** — every read hits the file — so it
//! trivially survives lock/unlock (a fresh unlock just reloads from disk).

use super::config::SyncConfigError;
use crate::io_failure_kind::IoFailureKind;
use protocol::{SealedHead, VaultHead, VvEntry, DEVICE_ID_LEN, HEAD_ID_LEN};
use serde::{Deserialize, Serialize};
use std::path::Path;

/// Device-local sync-state file name (cursor + VV log), under the vault root.
pub const SYNC_STATE_FILE: &str = "sync-state.json";
/// Device-local `MYH1` head-baseline file name (`protocol.md` §9.15).
pub const HEAD_STATE_FILE: &str = "vault.head-state";
/// Device-local marker: this device made a local `vault.meta` credential change
/// (password change / recovery reset) that may not have reached the server yet.
/// Empty file; presence is the whole signal. The sync loop's meta phase treats a
/// dirty local `vault.meta` as the authoritative password-side wrap to push, then
/// clears this. Never synced (path-scoped scan walks only `notes/` + `attachments/`).
pub const VAULT_META_DIRTY_FILE: &str = "vault.meta-dirty";

/// The device-local files this module owns — NONE may ever enter the sync
/// taxonomy. The normative taxonomy (what syncs / what is device-local /
/// what is a rebuildable cache) lives in the spec (`docs/spec/sync-protocol.md`
/// §9); runtime enforcement is the path-scoped scan (the orchestrator only
/// walks `notes/` + `attachments/`), so nothing here is ever offered to the
/// server. Asserted by the test below.
pub const DEVICE_LOCAL_SYNC_FILES: &[&str] = &[SYNC_STATE_FILE, HEAD_STATE_FILE];

/// Upper bound on the VV-observation log (keeps the file small; 427 only needs
/// recent history to judge re-convergence).
pub const MAX_VV_LOG: usize = 256;

/// One persisted version-vector entry (`device_id` + counter), hex on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VvEntryDto {
    /// 16-byte VV-actor device_id, lowercase hex.
    pub device_id_hex: String,
    /// Authored-head counter for this device.
    pub counter: u64,
}

/// One observed head: its `head_id` and version vector at observation time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct VvObservation {
    /// 32-byte head_id, lowercase hex.
    pub head_id_hex: String,
    /// The head's version vector at the time it was observed.
    pub version_vector: Vec<VvEntryDto>,
}

/// The last-synced state of one content blob (the per-blob CAS bookkeeping the
/// orchestrator needs): the server `version` (the push CAS base) and the
/// `content_nonce` that version carries (the change-detection discriminator).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobSyncState {
    /// The server's opaque per-blob version (the next push's `base_version`).
    pub version: u64,
    /// The 24-byte `content_nonce` of that synced revision, lowercase hex.
    pub content_nonce_hex: String,
    /// For an `NC05` CRDT note only: the last-synced Automerge document heads
    /// (sorted lowercase hex) — the CLIENT-side convergence marker (ASM-5).
    /// Empty for a `MY01` note. The note is "dirty" (needs push) iff its current
    /// heads differ from these — a deterministic, terminating test, where
    /// `content_nonce` byte-equality would read perpetually-dirty (the §10.2.2
    /// ping-pong one layer down). `content_nonce_hex` stays the SERVER-facing
    /// discriminator; this is additive (`#[serde(default)]`, omitted when empty)
    /// so a pre-`NC05` `sync-state.json` stays byte-compatible.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub doc_heads_hex: Vec<String>,
}

/// A blob the server still holds under a sync-id this vault no longer derives
/// (`sync-protocol.md` §5.6.1, myne-md/myne#443).
///
/// The three synced singletons (`catalog`, `prefs`, `themes`) are keyed by
/// `root_key`-derived sync-ids, so a whole-vault re-key moves all three to new
/// ids and strands the old blobs server-side. Nothing reclaims them on its own:
/// horizon-GC reclaims `deleted`-marked records and nothing marks these, and no
/// client will ever address them again.
///
/// It carries its own `base_version` because the re-base drops the old
/// `state.blobs` entry in the same breath — the version is the push's CAS base
/// and there would be nowhere else to read it from afterwards.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OrphanTombstone {
    /// The stranded 16-byte sync-id, lowercase hex.
    pub blob_id_hex: String,
    /// The last version this device saw for it — the tombstone push's CAS base.
    pub base_version: u64,
    /// A freshly-minted 24-byte `content_nonce`, lowercase hex. Minted rather
    /// than reused for the same reason the attachment tombstone mints one: a
    /// record whose bytes changed while its nonce did not is a habit worth not
    /// having, even where (as here) no manifest covers the id.
    pub content_nonce_hex: String,
}

/// The device-local sync state persisted at `<vault_root>/sync-state.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncState {
    /// The server pull cursor (a monotonic `u64` change-seq high-water; the Go
    /// server's `next_cursor`). `0` = pull from the beginning / never pulled.
    #[serde(default)]
    pub cursor: u64,
    /// The bounded VV-observation log (oldest first).
    #[serde(default)]
    pub vv_log: Vec<VvObservation>,
    /// Per-blob CAS bookkeeping (`blob_id_hex` → last-synced version + nonce).
    /// Lets the orchestrator pick each push's `base_version` and detect which
    /// local notes changed since the last sync. Server-visible metadata only.
    #[serde(default)]
    pub blobs: std::collections::BTreeMap<String, BlobSyncState>,
    /// Epoch-ms of the last cycle that completed against the server on this
    /// device, or `None` if none ever has (myne#583).
    ///
    /// The client had no way to answer "how long has sync been broken": the
    /// scheduler holds monotonic logical time and dies with the process, and
    /// nothing on disk carried a clock. So a four-day outage looked exactly
    /// like a four-second one, and the four-day one went unnoticed.
    ///
    /// **Coalesced to [`SUCCESS_STAMP_COALESCE_MS`], deliberately.** Stamping
    /// every cycle would turn this file's mtime into a 30-second-resolution
    /// log of when the user's device was awake and online — the at-rest
    /// activity-metadata signal `threat-model.md` already bounds for
    /// `vault.workspace` and snapshots, and there is no reason to add a
    /// sharper one for a value a staleness threshold reads in days. It is
    /// written in the clear alongside the rest of this device-local file,
    /// which is why the granularity is the control rather than encryption.
    #[serde(default)]
    pub last_success_at_ms: Option<u64>,
    /// This device's 16-byte VV-actor `device_id` (lowercase hex), captured at
    /// enrollment so a later `sync_now` can author heads under the right actor.
    #[serde(default)]
    pub device_id_hex: Option<String>,
    /// The account's 16-byte `account_number_hash` (lowercase hex), captured at
    /// enrollment. Two roles: it binds head authoring to the right account, and
    /// its hex IS the SCRAM username (AS9 hash-only identity) — so a still-`pending`
    /// device can re-run the handshake to claim its token with no credential
    /// re-entry (the unlocked `root_key` re-derives the SCRAM secret).
    #[serde(default)]
    pub account_hash_hex: Option<String>,
    /// The OWNER's person identity code (`MYNE-PERSON-1:…`), captured on a
    /// member device at invite accept. A member's `NTV6` `vault.meta` carries an
    /// owner-signed roster, so verifying it (and therefore any signed head)
    /// needs the owner's public half, which a member holds only as this
    /// out-of-band code. **Public material only** (the same bytes the owner
    /// shared by hand), so it is stored in the clear like the account hash.
    #[serde(default)]
    pub owner_identity_code: Option<String>,
    /// The OWNER's identity code as this device recorded it — its OWN code, when this
    /// device is the owner's.
    ///
    /// A member stores the owner's code here at invite accept
    /// ([`Self::owner_identity_code`]). The owner's own device had nowhere to read its
    /// own public half from except the person keypair, which is phrase-sealed, so
    /// verifying the roster (the panel, and every signed head) demanded the phrase on
    /// every cold start even after the device key took over SIGNING (`0731` stages 1
    /// and 2). The halves are public material and this device derived them itself the
    /// last time the phrase was entered, so caching them costs no secrecy: it records
    /// what this device already knew, and a tampered copy cannot forge a roster that
    /// verifies against a key it substituted, because the roster's own signature is what
    /// is checked.
    ///
    /// Absent until the first unlock on a device with an owner vault. Its absence is not
    /// an error: the phrase path still works, and it is refreshed on every unlock.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub own_identity_code: Option<String>,
    /// The vault's server NAMESPACE when it is not the credential's own account
    /// (myne-md/myne#911 task 8): the random binding an `NTV7` vault writes at
    /// §9.3 offset 6, lowercase hex.
    ///
    /// Present only after an explicit publish. Its presence is what tells the
    /// cycle to address this vault with `?account=<hex>` and authenticate with
    /// the PERSON token, because a person-born vault has no vault SCRAM account
    /// at all. Absent on every pre-existing vault, where the credential names the
    /// namespace and no selector is sent.
    #[serde(default)]
    pub namespace_hex: Option<String>,
    /// The OWNER's device, as the invite package attested it
    /// (`decisions/protocol/0731` stage 2, `0733`).
    ///
    /// A roster signed by the owner's DEVICE key needs that device's public halves to
    /// verify, and a member has no group key before the first accept, so the halves
    /// travel INSIDE the package, person-signed by the owner. They are pinned here for
    /// the same reason `owner_identity_code` is: verification must not depend on a
    /// network round trip, and the value is public material only.
    ///
    /// Absent on every member device that accepted before the stage landed, and on every
    /// package from an owner with no device key. Its absence is not an error: it means
    /// "this owner signs rosters with the person key".
    ///
    /// Public material, so stored in the clear like the account hash and the identity
    /// code beside it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_device: Option<protocol::person_invite::OwnerDeviceAttestation>,
    /// Epoch-ms of the publish that recorded [`Self::namespace_hex`], or `None`
    /// while the vault is device-only (myne-md/myne#911 task 8).
    ///
    /// Coarse for the same reason `last_success_at_ms` is: it is a device-local
    /// fact about when a user acted, and a per-second stamp would make this file
    /// a sharper activity log than the value it carries is worth.
    #[serde(default)]
    pub published_at_ms: Option<u64>,
    /// Whether the last completed cycle PROVED this device holds every content
    /// blob the server's head commits to (phase3-web-client task 89).
    ///
    /// Set by comparing the local manifest hash against the MAC-verified vault
    /// head's `manifest_hash` — an exact statement of "I hold everything",
    /// verified rather than inferred, over data the cycle already assembled.
    /// Cleared whenever that comparison does not hold, so it can never go stale
    /// in the dangerous direction.
    ///
    /// It gates ONE thing: a whole-corpus destructive sweep
    /// (`attachment_clean_unused`), whose "unused" set is computed by scanning
    /// the local notes directory and is therefore wrong by exactly the notes a
    /// mid-materialisation device does not have yet. See
    /// `super::corpus` for why an approximation would not do.
    #[serde(default)]
    pub corpus_complete: bool,
    /// F1 Faz B: SHA-256 (lowercase hex) of the `vault.meta` this device last saw
    /// as the agreed synced state. Lets the meta phase distinguish "the server's
    /// meta is unchanged since I synced" (only I changed → push) from "the server
    /// also changed" (concurrent → deterministic merge). `None` = never reconciled
    /// meta yet. Device-local; not a credential (a hash of already-public bytes).
    #[serde(default)]
    pub meta_baseline_hex: Option<String>,
    /// Set by the v0.1 → v0.2 migration (§10.4.1, myne-md/myne#429): this device
    /// re-keyed the vault locally, so the head the server still holds is MAC'd
    /// under a `root_key` that no longer exists anywhere.
    ///
    /// Without it the next pull reads that head as **unopenable**, which is the
    /// same signal a forged head produces — `PullError::HeadInvalid`, routed to
    /// the malicious-server alert. The cycle then aborts before the push, so the
    /// head is never re-authored and the state feeds itself: a sanctioned local
    /// migration tells the user their server may be tampering with their data,
    /// forever.
    ///
    /// While it is set the pull accepts the server's head **unverified** — taking
    /// only its `head_id`, which is `SHA-256(record)` and needs no key — and the
    /// cycle authors a fresh head under the new root with that id as the CAS
    /// parent. Cleared by the push that lands, so exactly one cycle is exempt.
    ///
    /// It is NOT a security relaxation the server can request: only a local
    /// migration writes it, it survives one cycle, and every OTHER integrity
    /// check (head-id match, blob `content_nonce` verification, §11.3) stays on.
    #[serde(default)]
    pub rekey_rebase_pending: bool,
    /// Singleton blobs the re-key stranded server-side, awaiting the tombstone
    /// that lets horizon-GC reclaim them (myne-md/myne#443). See
    /// [`OrphanTombstone`]; written by the migration's sync-plane re-base,
    /// drained by a push cycle.
    ///
    /// It lives here rather than in a sibling queue file — unlike the
    /// attachment-tombstone queue it is modelled on — because the one writer is
    /// the re-base, which is already rewriting this struct in the same
    /// operation. A second file would be a second write that can fail on its
    /// own, leaving the flag set and the queue empty or the reverse.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pending_orphan_tombstones: Vec<OrphanTombstone>,
    /// The OWNER's per-vault membership token (lowercase hex), obtained by
    /// binding this vault's owner person once (myne-md/myne#711 task 11).
    ///
    /// It authenticates the owner on the vault's B2B routes (`POST /b2b/invites`
    /// is the first consumer). Vault-scoped and device-local, never synced. It is
    /// the same class of credential as the endpoint pin: a revocable availability
    /// token, not key material (`[person-token-storage] A` in the feature's
    /// `progress.md`), so it is device-local plaintext beside the sync cursor
    /// rather than under the token store's keychain seam.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_member_token_hex: Option<String>,
    /// The owner person id the stored membership token belongs to. A re-bound
    /// owner (a new person identity, e.g. after a migration) must not reuse the
    /// old token, so the pair is compared and re-bound on mismatch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_member_person_id_hex: Option<String>,
}

impl SyncState {
    /// Append an observation, bounding the log to [`MAX_VV_LOG`] (drops oldest).
    /// Skips a no-op duplicate of the most recent observation.
    pub fn record_observation(&mut self, head_id: &[u8; HEAD_ID_LEN], vv: &[VvEntry]) {
        let obs = VvObservation {
            head_id_hex: hex(head_id),
            version_vector: vv
                .iter()
                .map(|e| VvEntryDto {
                    device_id_hex: hex(&e.device_id),
                    counter: e.counter,
                })
                .collect(),
        };
        if self.vv_log.last() == Some(&obs) {
            return;
        }
        self.vv_log.push(obs);
        if self.vv_log.len() > MAX_VV_LOG {
            let overflow = self.vv_log.len() - MAX_VV_LOG;
            self.vv_log.drain(0..overflow);
        }
    }
}

use super::to_hex as hex;

/// Read `<dir>/sync-state.json`. Absent → default (no cursor, empty log).
///
/// # Absent and unreadable are different answers, and callers must keep them so
///
/// `Ok(SyncState::default())` means **this device has never enrolled** — cursor
/// 0, no baselines, no `device_id`. `Err` means the file is there and could not
/// be read or parsed, which is a different situation entirely and is NOT safe to
/// treat as the first one.
///
/// The dangerous shape is a read-modify-WRITE that collapses them: defaulting on
/// a failed read and then persisting destroys the pull cursor, the VV
/// observation log, the per-blob CAS baselines and `meta_baseline_hex` in one
/// step. The consequences compound — the device re-enrols as brand new, AND the
/// meta phase gets a false "only the server changed" verdict from the absent
/// `meta_baseline_hex`, which overwrites a locally-newer `vault.meta`.
///
/// `unwrap_or_default()` on this function is therefore a bug wherever a write
/// follows, and was one at two call sites until phase3-web-client task 86.
pub async fn read_sync_state(
    io: &dyn crate::vault_io::VaultIo,
    dir: &Path,
) -> Result<SyncState, SyncConfigError> {
    let path = dir.join(SYNC_STATE_FILE);
    // `open_newest`, not a plain read (task 86). On the web store this file is
    // two alternating copies, and `VaultIo::read` there returns the newest
    // STRUCTURALLY INTACT one — the newest whose generation frame parses. That
    // is not the same question: a write torn a few bytes in leaves a valid frame
    // wrapping half a JSON document, so a plain read hands back the torn copy
    // and the parse fails, even though the previous complete copy is sitting
    // right beside it. The verifier for a plaintext sidecar is `serde_json`, so
    // it has to be the thing that chooses.
    //
    // Native is unchanged by construction: `read_candidates` yields one element
    // there, so this is the same read followed by the same parse.
    match crate::singleton::open_newest(io, &path, |bytes| {
        serde_json::from_slice::<SyncState>(bytes)
    })
    .await
    {
        Ok(state) => Ok(state),
        // Absent is the legitimate pre-enrolment answer, and stays distinct from
        // "present and unreadable" — see the doc above.
        Err(crate::singleton::OpenOutcome::Absent) => Ok(SyncState::default()),
        Err(crate::singleton::OpenOutcome::Undecodable(_)) => Err(SyncConfigError::Parse),
        Err(crate::singleton::OpenOutcome::Io(kind)) => Err(kind.into()),
    }
}

/// This device's Automerge actor for note authoring (`SYNC-42`): the enrolled
/// `device_id` bytes (16, `DEVICE_ID_LEN`), or `None` when the vault carries no
/// device identity.
///
/// A single shared read so `note_create`, `note_update` and the batch writer all
/// derive the actor from the same source, and so `collab-provenance` resolves a
/// revision's `actor_hex` through the same bytes. `None` covers a never-enrolled
/// / local-only vault; the caller then falls back to a fresh CSPRNG draw
/// (`crdt_doc::note_actor_bytes`). The persisted id is hex on disk, so a
/// malformed value is `None` rather than an error: an unreadable identity is the
/// same shape as an absent one, no device to attribute to.
pub async fn read_device_actor(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
) -> Option<[u8; crate::plugins::sync::crdt_doc::ACTOR_ID_LEN]> {
    let st = read_sync_state(io, vault_root).await.ok()?;
    super::devices::hex16(st.device_id_hex.as_deref()?)
}

/// The device-local record of the `group_key_epoch` the vault's CONTENT blobs
/// are sealed at (myne-md/myne#797).
///
/// A rotation rewrites every note, attachment and snapshot's per-entry key wrap
/// under the new `itemsKey`, and that local re-key is a separate step from
/// installing the new keys on the slot. Both can be interrupted, and a session
/// that installs the new keys while a blob is still wrapped under the retired
/// one cannot open it and has no server copy to fall back on (the blob may not
/// have synced yet). This marker is what makes the two steps resumable rather
/// than ambiguous: it advances only after every staged blob has been published
/// AND the recovery journal has recorded the same epoch, so a retry knows
/// whether the blobs still need re-keying.
///
/// Device-local, never synced, never backed up: the same class as
/// `sync-state.json`, and magic-less for the same reason: it is bookkeeping
/// about this device's files, not a §10.3 blob family.
pub const CONTENT_EPOCH_FILE: &str = "vault.content-epoch";

#[derive(serde::Serialize, serde::Deserialize)]
struct ContentEpochRecord {
    version: u64,
    epoch: u64,
}

/// The epoch the local content blobs are wrapped under.
///
/// `Ok(None)` means the marker was never written (a vault created or joined
/// before it existed, or one that has never rotated). A read or decode FAILURE is
/// an `Err`, not `None`: the marker is the only thing that distinguishes "content
/// at epoch N" from "content at epoch N-1", and a caller that guesses N-1 re-runs
/// the re-key against blobs already under N, which fails and (before the idempotent
/// pass landed) locked the vault. Refusing is retryable; guessing is not
/// (myne-md/myne#797).
pub async fn read_content_epoch(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
) -> Result<Option<u64>, SyncConfigError> {
    match io.read(&vault_root.join(CONTENT_EPOCH_FILE)).await {
        Ok(bytes) => {
            let rec: ContentEpochRecord =
                serde_json::from_slice(&bytes).map_err(|_| SyncConfigError::Parse)?;
            if rec.version != 1 {
                return Err(SyncConfigError::Parse);
            }
            Ok(Some(rec.epoch))
        }
        Err(crate::io_failure_kind::IoFailureKind::NotFound) => Ok(None),
        Err(e) => Err(SyncConfigError::Io { io_error_kind: e }),
    }
}

/// Record the epoch the local content blobs are now wrapped under.
pub async fn write_content_epoch(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &Path,
    epoch: u64,
) -> Result<(), SyncConfigError> {
    let bytes = serde_json::to_vec(&ContentEpochRecord { version: 1, epoch })
        .map_err(|_| SyncConfigError::Parse)?;
    io.write(
        &vault_root.join(CONTENT_EPOCH_FILE),
        &bytes,
        crate::vault_io::WriteOpts::default(),
    )
    .await
    .map_err(SyncConfigError::from)
}

/// Remove the device-local sync baseline files (`sync-state.json` + `vault.head-state`)
/// for a vault — the "reset sync on this device" primitive. Idempotent (absent files
/// are fine). NEVER touches `notes/`, attachments, or `vault.meta`: it only drops the
/// device-local sync bookkeeping so the vault returns to a clean unsynced state and the
/// next sync re-bootstraps the baseline (BootstrapTofu) from the server.
pub async fn clear_device_local_sync(
    io: &dyn crate::vault_io::VaultIo,
    dir: &Path,
) -> Result<(), SyncConfigError> {
    for f in DEVICE_LOCAL_SYNC_FILES {
        match io.remove_file(&dir.join(f)).await {
            Ok(()) => {}
            Err(IoFailureKind::NotFound) => {}
            Err(kind) => return Err(kind.into()),
        }
    }
    // Also drop the orchestrator-owned device-local sync artifacts so a reset is a
    // genuinely clean slate — else stale deletion intent and stale conflict copies
    // (keyed to the OLD enrollment's baseline) survive into the next sync cycle after
    // re-enroll. Names mirror orchestrator.rs (`pending-tombstones` file + `conflicts/`
    // staging dir); neither holds note plaintext.
    match io.remove_file(&dir.join("pending-tombstones")).await {
        Ok(()) => {}
        Err(IoFailureKind::NotFound) => {}
        Err(kind) => return Err(kind.into()),
    }
    // The attachment-deletion queue (MYND-468) is likewise stale deletion
    // intent keyed to the old enrollment.
    match io
        .remove_file(&dir.join("pending-attachment-tombstones"))
        .await
    {
        Ok(()) => {}
        Err(IoFailureKind::NotFound) => {}
        Err(kind) => return Err(kind.into()),
    }
    // The chats + memory deletion queues (myne-md/myne#675 + myne-md/myne#697)
    // are the same stale intent: a queued id names a server copy under the
    // OLD enrollment's baseline, so replaying it after re-enroll would
    // tombstone a live server record.
    for queue in ["pending-chats-tombstones", "pending-memory-tombstones"] {
        match io.remove_file(&dir.join(queue)).await {
            Ok(()) => {}
            Err(IoFailureKind::NotFound) => {}
            Err(kind) => return Err(kind.into()),
        }
    }
    match io.remove_dir_all(&dir.join("conflicts")).await {
        Ok(()) => {}
        Err(IoFailureKind::NotFound) => {}
        Err(kind) => return Err(kind.into()),
    }
    // Deliberately NOT removed: `quarantine/` (reconcile drop-leg, §11.3). Unlike
    // every artifact above it holds USER DATA — the ciphertext of notes that were
    // deleted+reclaimed remotely while this device was offline. A sync reset must
    // never destroy it.
    // The vault.meta-dirty marker is keyed to the old enrollment's server state;
    // a fresh enrollment re-seeds meta, so drop it on reset.
    clear_vault_meta_dirty(io, dir).await?;
    Ok(())
}

/// Mark the local `vault.meta` as changed-but-maybe-not-pushed (F1). Written
/// after a credential change so the sync loop's meta phase knows to push the
/// local wrap even if the immediate best-effort push failed (offline). Empty
/// file; idempotent.
pub async fn mark_vault_meta_dirty(
    io: &dyn crate::vault_io::VaultIo,
    dir: &Path,
) -> Result<(), SyncConfigError> {
    io.write(
        &dir.join(VAULT_META_DIRTY_FILE),
        &[],
        crate::vault_io::WriteOpts::default(),
    )
    .await?;
    Ok(())
}

/// Clear the `vault.meta-dirty` marker (after a successful server push, or on
/// reset). Idempotent — an absent marker is fine.
pub async fn clear_vault_meta_dirty(
    io: &dyn crate::vault_io::VaultIo,
    dir: &Path,
) -> Result<(), SyncConfigError> {
    match io.remove_file(&dir.join(VAULT_META_DIRTY_FILE)).await {
        Ok(()) => Ok(()),
        Err(IoFailureKind::NotFound) => Ok(()),
        Err(kind) => Err(kind.into()),
    }
}

/// Whether the local `vault.meta` is marked dirty (a pending credential change
/// this device should push).
pub async fn vault_meta_is_dirty(io: &dyn crate::vault_io::VaultIo, dir: &Path) -> bool {
    // A failure to CONSULT the store reads as "not dirty", which is the same
    // answer an absent marker gives. That is the conservative direction: a false
    // "dirty" would push a local `vault.meta` the meta phase has no reason to
    // believe is newer, whereas a false "clean" only defers the push to the next
    // cycle (the marker is still on disk and the next read sees it).
    io.exists(&dir.join(VAULT_META_DIRTY_FILE))
        .await
        .unwrap_or(false)
}

/// Record THIS device's own person identity code into the active vault's sync state.
///
/// Called on every successful identity unlock, so the cache is refreshed rather than
/// trusted from the first time it was written. Best-effort on purpose: a readable sync
/// state is a convenience here, and failing an unlock because a JSON file would not
/// rewrite would trade a real capability for it.
pub async fn remember_own_identity_code(
    io: &dyn crate::vault_io::VaultIo,
    dir: &Path,
    code: &str,
) -> Result<(), SyncConfigError> {
    let mut state = read_sync_state(io, dir).await?;
    if state.own_identity_code.as_deref() == Some(code) {
        return Ok(());
    }
    state.own_identity_code = Some(code.to_string());
    write_sync_state(io, dir, &state).await
}

/// Persist the sync state to `<dir>/sync-state.json` (atomic replace).
pub async fn write_sync_state(
    io: &dyn crate::vault_io::VaultIo,
    dir: &Path,
    state: &SyncState,
) -> Result<(), SyncConfigError> {
    let path = dir.join(SYNC_STATE_FILE);
    let bytes = serde_json::to_vec_pretty(state).map_err(|_| SyncConfigError::Parse)?;
    io.write(&path, &bytes, crate::vault_io::WriteOpts::default())
        .await?;
    Ok(())
}

/// Persist the last-seen head baseline to `<dir>/vault.head-state` as `MYH1`
/// (atomic replace). `head_format_version` is the authority's expected byte
/// (`0x01` HMAC, `0x02` signed), so a signed vault's baseline round-trips.
pub async fn write_head_baseline(
    io: &dyn crate::vault_io::VaultIo,
    dir: &Path,
    sealed: &SealedHead,
    head_format_version: u8,
) -> Result<(), SyncConfigError> {
    let path = dir.join(HEAD_STATE_FILE);
    let blob = protocol::encode_head_state(sealed, head_format_version);
    io.write(&path, &blob, crate::vault_io::WriteOpts::default())
        .await?;
    Ok(())
}

/// Read + verify the device-local head baseline. Absent → `Ok(None)`. A present
/// blob is re-verified by the vault's [`HeadAuthority`] (the `root_key` HMAC on
/// an `NTV5` vault, the person-keypair signature on an `NTV6` vault); a tamper /
/// wrong-key blob is an error (the server cannot have written a valid one).
pub async fn read_head_baseline(
    io: &dyn crate::vault_io::VaultIo,
    head_authority: &super::head_authority::HeadAuthority<'_>,
    dir: &Path,
) -> Result<Option<VaultHead>, HeadBaselineError> {
    let path = dir.join(HEAD_STATE_FILE);
    // The `MYH1` envelope is `magic(4) || protocol(1) || format(1)` then the wire
    // record; the format byte must match what this vault's authority accepts, and
    // the record is verified by that authority (MAC or signature), so a signed
    // vault's baseline round-trips.
    let decode = |blob: &[u8]| -> Result<VaultHead, protocol::vault_head::VaultHeadError> {
        let header = 4 + 1 + 1;
        if blob.len() < header {
            return Err(protocol::vault_head::VaultHeadError::RecordTooShort);
        }
        if blob[0..4] != protocol::VAULT_HEAD_STATE_MAGIC {
            return Err(protocol::vault_head::VaultHeadError::StateMagicMismatch);
        }
        if blob[4] != protocol::VAULT_HEAD_PROTOCOL_VERSION {
            return Err(protocol::vault_head::VaultHeadError::ProtocolVersionMismatch);
        }
        // The baseline may hold a format this device no longer AUTHORS: a `0x03` head
        // written before a device key was lost still has to be readable, or the device
        // would forget its own version vector and re-author from zero.
        if !head_authority.accepts_format(blob[5]) {
            return Err(protocol::vault_head::VaultHeadError::FormatUnsupported);
        }
        head_authority.open(&blob[header..])
    };
    match crate::singleton::open_newest(io, &path, decode).await {
        Ok(head) => Ok(Some(head)),
        Err(crate::singleton::OpenOutcome::Absent) => Ok(None),
        Err(crate::singleton::OpenOutcome::Undecodable(_)) => Err(HeadBaselineError::Invalid),
        Err(crate::singleton::OpenOutcome::Io(_)) => Err(HeadBaselineError::Io),
    }
}

/// Failure surface for the head-baseline read (kept separate from
/// [`SyncConfigError`] because the MAC-verify failure is its own class).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind")]
pub enum HeadBaselineError {
    /// Filesystem error reading the baseline.
    Io,
    /// Magic / version / MAC verification failed (not a head this device sealed).
    Invalid,
}

// Re-exported lengths so callers don't import them twice.
const _: () = assert!(DEVICE_ID_LEN == 16);
const _: () = assert!(HEAD_ID_LEN == 32);

/// How coarse the last-success clock is allowed to be (myne#583).
///
/// One hour. The threshold that reads it is measured in days, so nothing is
/// lost, and the mtime of `sync-state.json` stays a once-an-hour signal rather
/// than a once-a-cycle one.
pub const SUCCESS_STAMP_COALESCE_MS: u64 = 60 * 60 * 1000;

/// Record that a cycle completed, if the recorded stamp is old enough to be
/// worth replacing.
///
/// Returns whether it wrote. A no-op on the common path: with a 30-second poll
/// interval this writes on roughly one cycle in 120, and reads the file it is
/// about to skip writing, which is the cheap half of an operation that has
/// just finished talking to a server.
pub async fn record_sync_success(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &std::path::Path,
    now_ms: u64,
) -> bool {
    let Ok(mut state) = read_sync_state(io, vault_root).await else {
        return false;
    };
    let fresh_enough = state
        .last_success_at_ms
        .is_some_and(|prev| now_ms.saturating_sub(prev) < SUCCESS_STAMP_COALESCE_MS);
    if fresh_enough {
        return false;
    }
    state.last_success_at_ms = Some(now_ms);
    write_sync_state(io, vault_root, &state).await.is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::VAULT_HEAD_FORMAT_V1;

    // ── the seam, filled in for this module's tests ─────────────────────────
    //
    // Task 86 gave every reader and writer here `io: &dyn VaultIo`. The shims
    // below shadow them with the OLD signatures and supply the real
    // `StdVaultIo`, so the ~120 call sites in this module read unchanged and the
    // behavioural diff is not buried in mechanical noise. They are shims, not
    // fakes: every one drives the production function against a real temp dir.

    use crate::test_support::ScopedTempDir;

    const IO: crate::vault_io::StdVaultIo = crate::vault_io::StdVaultIo;

    fn rt<F: std::future::Future>(f: F) -> F::Output {
        crate::test_support::block_on(f)
    }

    fn read_sync_state(dir: &Path) -> Result<SyncState, SyncConfigError> {
        rt(super::read_sync_state(&IO, dir))
    }
    fn write_sync_state(dir: &Path, state: &SyncState) -> Result<(), SyncConfigError> {
        rt(super::write_sync_state(&IO, dir, state))
    }
    fn read_head_baseline(
        root_key: &[u8; 32],
        dir: &Path,
    ) -> Result<Option<VaultHead>, HeadBaselineError> {
        let auth = crate::plugins::sync::head_authority::HeadAuthority::Mac { root_key };
        rt(super::read_head_baseline(&IO, &auth, dir))
    }
    fn write_head_baseline(dir: &Path, sealed: &SealedHead) -> Result<(), SyncConfigError> {
        rt(super::write_head_baseline(
            &IO,
            dir,
            sealed,
            protocol::VAULT_HEAD_FORMAT_V1,
        ))
    }
    #[allow(dead_code)]
    fn clear_device_local_sync(dir: &Path) -> Result<(), SyncConfigError> {
        rt(super::clear_device_local_sync(&IO, dir))
    }
    #[allow(dead_code)]
    fn mark_vault_meta_dirty(dir: &Path) -> Result<(), SyncConfigError> {
        rt(super::mark_vault_meta_dirty(&IO, dir))
    }
    #[allow(dead_code)]
    fn clear_vault_meta_dirty(dir: &Path) -> Result<(), SyncConfigError> {
        rt(super::clear_vault_meta_dirty(&IO, dir))
    }
    #[allow(dead_code)]
    fn vault_meta_is_dirty(dir: &Path) -> bool {
        rt(super::vault_meta_is_dirty(&IO, dir))
    }

    fn tmpdir(tag: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("myne-syncstate-{}-{}", tag, std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    // ── absent vs unreadable (phase3-web-client task 86) ────────────────────
    //
    // These two answers had four callers between them and two of those callers
    // erased the difference with `unwrap_or_default()`. The reader always kept
    // it; what these pin is that it stays keepable, because the consequence of
    // collapsing them is not a degraded read — it is a WRITE that destroys the
    // cursor, the VV log, the CAS baselines and `meta_baseline_hex` at once.

    // ── the sidecar over the OPFS container (task 86) ───────────────────────
    //
    // The container's own crash tests prove the algorithm. What these prove is
    // the criterion: that a sidecar's OWN READER sees "the previous copy or the
    // new one, never a default or a mixed one" after a torn write. They run over
    // `ContainerVaultIo`, which makes the same routing decision the browser's
    // OPFS arm makes, so the reader is driven exactly as a browser drives it.

    #[test]
    fn a_torn_sidecar_write_leaves_the_previous_copy_readable() {
        rt(async {
            let io = crate::test_support::ContainerVaultIo;
            let dir = tmpdir("torn-container");
            let base = dir.join(SYNC_STATE_FILE);
            for slot in 0..2 {
                let _ = std::fs::remove_file(crate::double_buffer::slot_path(
                    &base.to_string_lossy(),
                    slot,
                ));
            }

            // The OWNER's own code is remembered on unlock and REFRESHED on the next
            // one (`0731` stages 1 and 2 moved signing to the device key, and this is what
            // stops the panel and the cycle from still asking for the phrase to READ a
            // roster). Refreshed rather than write-once: a device that re-derived its
            // identity after a phrase change must not keep verifying against the old half.
            assert_eq!(
                super::read_sync_state(&io, &dir)
                    .await
                    .unwrap()
                    .own_identity_code,
                None
            );
            super::remember_own_identity_code(&io, &dir, "MYNE-PERSON-1:aa")
                .await
                .unwrap();
            assert_eq!(
                super::read_sync_state(&io, &dir)
                    .await
                    .unwrap()
                    .own_identity_code
                    .as_deref(),
                Some("MYNE-PERSON-1:aa")
            );
            super::remember_own_identity_code(&io, &dir, "MYNE-PERSON-1:bb")
                .await
                .unwrap();
            assert_eq!(
                super::read_sync_state(&io, &dir)
                    .await
                    .unwrap()
                    .own_identity_code
                    .as_deref(),
                Some("MYNE-PERSON-1:bb"),
                "a later unlock must replace the cached code, not keep the first one"
            );

            // Generation 1: a real, enrolled device.
            let enrolled = SyncState {
                cursor: 4_242,
                device_id_hex: Some("aa".repeat(16)),
                account_hash_hex: Some("bb".repeat(16)),
                meta_baseline_hex: Some("cc".repeat(32)),
                ..SyncState::default()
            };
            super::write_sync_state(&io, &dir, &enrolled).await.unwrap();

            // Generation 2, TORN mid-write — the shape a crash leaves on a store
            // with no atomicity, which is the entire reason task 18 exists.
            let mut next = enrolled.clone();
            next.cursor = 9_999;
            let bytes = serde_json::to_vec_pretty(&next).unwrap();
            crate::double_buffer::write_next_faulting(
                &crate::vault_io::StdVaultIo,
                &base,
                &bytes,
                crate::double_buffer::Fault::StopMidWrite(12),
            )
            .await
            .ok();

            // PREVIOUS-or-new, and here it is previous: the torn slot has a
            // broken frame, so `candidates` skips it. Crucially NOT the default
            // — a defaulted read here is what turns an enrolled device into a
            // brand-new one and overwrites a locally-newer `vault.meta`.
            let read = super::read_sync_state(&io, &dir).await.unwrap();
            assert_eq!(read, enrolled, "the torn write must not be observable");
            assert_ne!(read, SyncState::default());

            for slot in 0..2 {
                let _ = std::fs::remove_file(crate::double_buffer::slot_path(
                    &base.to_string_lossy(),
                    slot,
                ));
            }
        });
    }

    #[test]
    fn a_completed_sidecar_write_is_the_new_copy() {
        // The other half of previous-or-new: without this, a reader that always
        // returned the older copy would pass the test above.
        rt(async {
            let io = crate::test_support::ContainerVaultIo;
            let dir = tmpdir("container-advance");
            let base = dir.join(SYNC_STATE_FILE);
            for slot in 0..2 {
                let _ = std::fs::remove_file(crate::double_buffer::slot_path(
                    &base.to_string_lossy(),
                    slot,
                ));
            }
            let mut st = SyncState {
                cursor: 1,
                ..SyncState::default()
            };
            super::write_sync_state(&io, &dir, &st).await.unwrap();
            st.cursor = 2;
            super::write_sync_state(&io, &dir, &st).await.unwrap();
            assert_eq!(super::read_sync_state(&io, &dir).await.unwrap().cursor, 2);
            for slot in 0..2 {
                let _ = std::fs::remove_file(crate::double_buffer::slot_path(
                    &base.to_string_lossy(),
                    slot,
                ));
            }
        });
    }

    #[test]
    fn an_absent_state_is_the_default_not_an_error() {
        // The legitimate pre-enrolment answer: cursor 0, no baselines, no
        // device_id. A caller may default on this one.
        let dir = tmpdir("absent");
        let _ = std::fs::remove_file(dir.join(SYNC_STATE_FILE));
        assert_eq!(read_sync_state(&dir).unwrap(), SyncState::default());
    }

    #[test]
    fn a_present_but_unparseable_state_is_an_error_not_the_default() {
        let dir = tmpdir("torn");
        // A TRUNCATED file, which is the shape a torn write actually leaves —
        // not arbitrary garbage. On a store with no crash-atomicity (OPFS, the
        // whole reason task 18 exists) this is the realistic corruption.
        std::fs::write(
            dir.join(SYNC_STATE_FILE),
            br#"{"cursor":42,"vv_log":[],"bl"#,
        )
        .unwrap();
        assert!(matches!(read_sync_state(&dir), Err(SyncConfigError::Parse)));
        let _ = std::fs::remove_file(dir.join(SYNC_STATE_FILE));
    }

    #[test]
    fn an_empty_state_file_is_an_error_too() {
        // Zero bytes is the other torn shape: the file was created and nothing
        // landed. It must not read as "never enrolled".
        let dir = tmpdir("empty");
        std::fs::write(dir.join(SYNC_STATE_FILE), b"").unwrap();
        assert!(read_sync_state(&dir).is_err());
        let _ = std::fs::remove_file(dir.join(SYNC_STATE_FILE));
    }

    /// The last-success stamp advances, but only once an hour.
    ///
    /// Both halves are the test. It has to ADVANCE, or the staleness banner
    /// measures from a clock that never moves and fires on a healthy vault.
    /// And it has to COALESCE, or a 30-second poll turns this file's mtime into
    /// a high-resolution log of when the device was awake and online — the
    /// at-rest activity signal `threat-model.md` bounds elsewhere and there is
    /// no reason to add a sharper one for a threshold measured in days.
    #[test]
    fn the_success_stamp_advances_hourly_and_not_per_cycle() {
        let tmp = ScopedTempDir::new("sync-success-stamp").unwrap();
        let dir = tmp.path();
        write_sync_state(dir, &SyncState::default()).unwrap();

        // Never stamped: the first success writes.
        assert!(rt(super::record_sync_success(&IO, dir, 1_000_000)));
        assert_eq!(
            read_sync_state(dir).unwrap().last_success_at_ms,
            Some(1_000_000)
        );

        // A cycle a minute later does not: the recorded value is still fresh.
        assert!(!rt(super::record_sync_success(&IO, dir, 1_060_000)));
        assert_eq!(
            read_sync_state(dir).unwrap().last_success_at_ms,
            Some(1_000_000),
            "a coalesced no-op must leave the recorded value alone, not blank it"
        );

        // An hour on, it advances.
        let hour_later = 1_000_000 + super::SUCCESS_STAMP_COALESCE_MS;
        assert!(rt(super::record_sync_success(&IO, dir, hour_later)));
        assert_eq!(
            read_sync_state(dir).unwrap().last_success_at_ms,
            Some(hour_later)
        );

        // And it does not trample the rest of the file.
        let enrolled = SyncState {
            cursor: 42,
            device_id_hex: Some("ab".repeat(16)),
            ..Default::default()
        };
        write_sync_state(dir, &enrolled).unwrap();
        assert!(rt(super::record_sync_success(&IO, dir, hour_later * 2)));
        let after = read_sync_state(dir).unwrap();
        assert_eq!(after.cursor, 42);
        assert_eq!(after.device_id_hex, Some("ab".repeat(16)));
    }

    #[test]
    fn defaulting_over_an_unreadable_state_would_lose_exactly_these_fields() {
        // The blast radius, written down as a test rather than as a comment, so
        // that a future change which reintroduces `unwrap_or_default()` on a
        // write path has something concrete to fail.
        let enrolled = SyncState {
            cursor: 9_001,
            vv_log: Vec::new(),
            blobs: std::collections::BTreeMap::new(),
            device_id_hex: Some("aa".repeat(16)),
            account_hash_hex: Some("bb".repeat(16)),
            meta_baseline_hex: Some("cc".repeat(32)),
            corpus_complete: true,
            rekey_rebase_pending: false,
            last_success_at_ms: Some(1_700_000_000_000),
            pending_orphan_tombstones: vec![OrphanTombstone {
                blob_id_hex: "dd".repeat(16),
                base_version: 7,
                content_nonce_hex: "ee".repeat(24),
            }],
            owner_member_token_hex: Some("ff".repeat(32)),
            owner_member_person_id_hex: Some("12".repeat(16)),
            owner_identity_code: Some("MYNE-PERSON-1:aa".to_string()),
            own_identity_code: None,
            owner_device: None,
            namespace_hex: None,
            published_at_ms: None,
        };
        let defaulted = SyncState::default();

        // Re-enrols as a brand-new device…
        assert_ne!(enrolled.device_id_hex, defaulted.device_id_hex);
        // …loses the pull high-water mark, so the next cycle re-pulls from 0…
        assert_ne!(enrolled.cursor, defaulted.cursor);
        // …and hands the meta phase a false "only the server changed" verdict,
        // which is what overwrites a locally-newer `vault.meta`.
        assert!(enrolled.meta_baseline_hex.is_some());
        assert!(defaulted.meta_baseline_hex.is_none());
        // …and forgets which blobs the re-key stranded (#443). The mildest loss
        // on this list by far — nothing breaks, the server simply keeps three
        // dead blobs no client will ever address, which is the pre-#443 state.
        // Listed anyway: the point of this test is the FULL blast radius, and a
        // field left out because it seemed unimportant is how the list rots.
        assert!(!enrolled.pending_orphan_tombstones.is_empty());
        assert!(defaulted.pending_orphan_tombstones.is_empty());
        // …and forgets when sync last worked (myne#583), which resets the
        // staleness warning to "never synced" — the one reading that suppresses
        // it, since a device that has never synced has no elapsed time to warn
        // about. So the loss is silent in the direction that matters.
        assert!(enrolled.last_success_at_ms.is_some());
        assert!(defaulted.last_success_at_ms.is_none());
        // …and loses the owner's per-vault membership token, silently
        // de-authorising every B2B admin call until a re-bind (task 11).
        assert!(enrolled.owner_member_token_hex.is_some());
        assert!(defaulted.owner_member_token_hex.is_none());
    }

    fn sample_head(root_key: &[u8; 32], counter: u64) -> SealedHead {
        VaultHead {
            head_format_version: VAULT_HEAD_FORMAT_V1,
            account_number_hash: [0x33; 16],
            manifest_hash: [0x55; 32],
            seq: counter,
            prev_head_hash: Vec::new(),
            version_vector: vec![VvEntry {
                device_id: [0xA1; DEVICE_ID_LEN],
                counter,
            }],
        }
        .seal(root_key)
        .unwrap()
    }

    #[test]
    fn sync_state_roundtrip_and_absent_default() {
        let dir = tmpdir("rt");
        assert_eq!(read_sync_state(&dir).unwrap(), SyncState::default());

        let mut st = SyncState {
            cursor: 42,
            vv_log: Vec::new(),
            ..SyncState::default()
        };
        st.record_observation(
            &[0x01; 32],
            &[VvEntry {
                device_id: [0xA1; 16],
                counter: 1,
            }],
        );
        write_sync_state(&dir, &st).unwrap();
        assert_eq!(read_sync_state(&dir).unwrap(), st);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn vv_log_dedups_and_bounds() {
        let mut st = SyncState::default();
        let vv = [VvEntry {
            device_id: [0xA1; 16],
            counter: 1,
        }];
        st.record_observation(&[0x01; 32], &vv);
        st.record_observation(&[0x01; 32], &vv); // duplicate → skipped
        assert_eq!(st.vv_log.len(), 1);

        for i in 0..(MAX_VV_LOG + 10) as u64 {
            let mut id = [0u8; 32];
            id[..8].copy_from_slice(&i.to_be_bytes());
            st.record_observation(
                &id,
                &[VvEntry {
                    device_id: [0xA1; 16],
                    counter: i + 2,
                }],
            );
        }
        assert_eq!(st.vv_log.len(), MAX_VV_LOG);
    }

    #[test]
    fn head_baseline_roundtrip_and_wrong_key_rejected() {
        let dir = tmpdir("hb");
        let root = [0x42u8; 32];
        let other = [0x43u8; 32];

        assert_eq!(read_head_baseline(&root, &dir).unwrap(), None);

        let sealed = sample_head(&root, 7);
        write_head_baseline(&dir, &sealed).unwrap();

        let loaded = read_head_baseline(&root, &dir).unwrap().unwrap();
        assert_eq!(loaded.seq, 7);
        assert_eq!(loaded.version_vector[0].counter, 7);

        // Wrong root_key → MAC re-verify fails.
        assert_eq!(
            read_head_baseline(&other, &dir),
            Err(HeadBaselineError::Invalid)
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn device_local_files_are_not_sync_candidates() {
        // The baseline + state files must never appear in the sync content set.
        // The synced content blobs are .myn notes + attachments/<id> + the
        // singleton vault.* blobs; none of these names collide with ours.
        for f in DEVICE_LOCAL_SYNC_FILES {
            assert!(!f.ends_with(".myn"), "{f} must not look like a note blob");
            assert!(
                *f == SYNC_STATE_FILE || *f == HEAD_STATE_FILE,
                "unexpected device-local file {f}"
            );
        }
    }

    #[test]
    fn clear_device_local_sync_removes_all_sync_artifacts_keeps_notes() {
        let dir = std::env::temp_dir().join(format!("myne-clearsync-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("conflicts")).unwrap();
        std::fs::create_dir_all(dir.join("notes")).unwrap();
        // Every device-local sync artifact a reset must clear.
        for f in DEVICE_LOCAL_SYNC_FILES {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        std::fs::write(dir.join("pending-tombstones"), b"id1\nid2").unwrap();
        std::fs::write(dir.join("conflicts").join("abc.myn"), b"staged").unwrap();
        mark_vault_meta_dirty(&dir).unwrap();
        // User data the reset must NEVER touch.
        std::fs::write(dir.join("notes").join("keep.myn"), b"note").unwrap();
        std::fs::write(dir.join("vault.meta"), b"meta").unwrap();

        clear_device_local_sync(&dir).unwrap();

        assert!(
            !vault_meta_is_dirty(&dir),
            "reset must clear the vault.meta-dirty marker (keyed to the old enrollment)"
        );

        for f in DEVICE_LOCAL_SYNC_FILES {
            assert!(!dir.join(f).exists(), "{f} must be removed by reset");
        }
        assert!(
            !dir.join("pending-tombstones").exists(),
            "pending-tombstones queue must be cleared (else stale deletion intent survives)"
        );
        assert!(
            !dir.join("conflicts").exists(),
            "conflicts/ staging dir must be cleared (else stale conflict copies survive)"
        );
        assert!(
            dir.join("notes").join("keep.myn").exists(),
            "reset must NEVER touch notes"
        );
        assert!(
            dir.join("vault.meta").exists(),
            "reset must NEVER touch vault.meta"
        );
        // Idempotent on already-absent artifacts.
        clear_device_local_sync(&dir).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn vault_meta_dirty_marker_roundtrips() {
        let dir = std::env::temp_dir().join(format!("myne-metadirty-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // Absent by default.
        assert!(!vault_meta_is_dirty(&dir));
        // Clear on absent is a no-op (idempotent).
        clear_vault_meta_dirty(&dir).unwrap();
        assert!(!vault_meta_is_dirty(&dir));

        // Mark → dirty; re-mark is idempotent.
        mark_vault_meta_dirty(&dir).unwrap();
        assert!(vault_meta_is_dirty(&dir));
        mark_vault_meta_dirty(&dir).unwrap();
        assert!(vault_meta_is_dirty(&dir));

        // Clear → clean.
        clear_vault_meta_dirty(&dir).unwrap();
        assert!(!vault_meta_is_dirty(&dir));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn read_device_actor_reads_the_persisted_id_and_malformed_is_none() {
        // `SYNC-42`: note authoring derives the Automerge actor from this id.
        let tmp = ScopedTempDir::new("read-device-actor").unwrap();
        let dir = tmp.path();
        // Absent (never enrolled) → None, not an error.
        assert_eq!(rt(super::read_device_actor(&IO, dir)), None);

        let st = SyncState {
            device_id_hex: Some("a1".repeat(16)),
            ..Default::default()
        };
        write_sync_state(dir, &st).expect("write");
        assert_eq!(
            rt(super::read_device_actor(&IO, dir)),
            Some([0xA1u8; 16]),
            "the persisted hex id parses to its 16 bytes"
        );

        // A malformed id is None (no device to attribute to), never a panic.
        let bad = SyncState {
            device_id_hex: Some("zz".repeat(16)),
            ..Default::default()
        };
        write_sync_state(dir, &bad).expect("write");
        assert_eq!(rt(super::read_device_actor(&IO, dir)), None);
    }
}
