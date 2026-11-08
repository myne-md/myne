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
/// what is a rebuildable cache) lives in the spec (`myne-agents/docs/spec/sync-protocol.md`
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
    /// Epoch-ms of the last cycle that **uploaded something**, a push that moved a blob or
    /// advanced the head, or `None` if this device has never uploaded (myne-md/myne#1027).
    ///
    /// Separate from [`Self::last_success_at_ms`], and the separation is the fix: that stamp is
    /// written by a cycle that merely REACHED the server, which includes every pull-only cycle.
    /// A device that had uploaded nothing for a day reported a success two minutes old, so the
    /// one number a user would read to answer "is everything on the server?" said yes.
    ///
    /// **Coalesced to [`SUCCESS_STAMP_COALESCE_MS`] for the same, stronger reason.** `sync-state.json`
    /// is device-local plaintext, and its mtime is at-rest activity metadata; an upload stamp
    /// per upload would resolve the user's editing rhythm rather than their online-ness. One
    /// hour keeps the value honest to the coarseness the surface uses ("three hours ago") while
    /// leaving the file's resolution where `threat-model.md` bounds it.
    #[serde(default)]
    pub last_upload_at_ms: Option<u64>,
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
    /// Epoch-ms of the last `GET /b2b/vaults` probe that asked whether the server
    /// still lists this vault (myne-md/myne#974).
    ///
    /// The probe exists because a published vault whose server record vanished is
    /// invisible from the client side, and it is the only request this branch adds
    /// to a healthy cycle. `sync_now` runs on every local edit and about once a
    /// second while a verification screen is open, so an ungated probe would pay a
    /// round trip and a share of the account's rate limit at that cadence to learn
    /// that a healthy vault is still healthy. The stamp is what keeps it to
    /// `BINDINGS_PROBE_INTERVAL_MS`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_bindings_check_ms: Option<u64>,
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

    /// Adopt the changes a RUNNING cycle made between the record it loaded (`base`) and
    /// the record it has now. [`persist_cycle_state`] says why only those.
    ///
    /// **The `Self { … }` pattern is exhaustive on purpose: no `..`.** A field added to
    /// this record stops the function compiling, and that is the moment to decide which
    /// side owns it: the cycle (bind it and merge it below) or a command (bind it as
    /// `_` under the comment below). A roster kept in a test instead would be a second
    /// copy of this list, and the two drift the first time only one of them is edited.
    ///
    /// **Two fields are merged per ENTRY and not per field**, because both are
    /// collections a command also writes into: `blobs` gets a per-blob CAS baseline from
    /// `resolve_conflict`, a group rotation and both re-key paths, and
    /// `pending_orphan_tombstones` gets a queued reclaim from those same two. A cycle
    /// touches both on nearly every run that moved anything, so adopting either whole
    /// would delete the command's entry and restore a retired sync-id's baseline, which
    /// is the loss this whole change exists to stop, one level down (myne-md/myne#964).
    fn adopt_cycle_changes(&mut self, base: &Self, cycle: &Self) {
        let Self {
            cursor,
            vv_log,
            blobs,
            corpus_complete,
            meta_baseline_hex,
            pending_orphan_tombstones,
            rekey_rebase_pending,
            // Command-owned: a cycle never writes these, so adopting one would be the
            // cycle reverting a command's answer with its own copy from cycle start.
            last_success_at_ms: _,
            last_upload_at_ms: _,
            device_id_hex: _,
            account_hash_hex: _,
            owner_identity_code: _,
            own_identity_code: _,
            namespace_hex: _,
            owner_device: _,
            published_at_ms: _,
            last_bindings_check_ms: _,
            owner_member_token_hex: _,
            owner_member_person_id_hex: _,
        } = cycle;
        // Each comparison is `cycle` against `base`, never against `self`: `self` is the
        // record on disk NOW, which another writer may already have moved, and treating
        // that as "unchanged" is how a cycle would adopt nothing and lose its own work.
        if *cursor != base.cursor {
            self.cursor = *cursor;
        }
        if *vv_log != base.vv_log {
            self.vv_log.clone_from(vv_log);
        }
        self.adopt_blob_baselines(&base.blobs, blobs);
        if *corpus_complete != base.corpus_complete {
            self.corpus_complete = *corpus_complete;
        }
        if *meta_baseline_hex != base.meta_baseline_hex {
            self.meta_baseline_hex.clone_from(meta_baseline_hex);
        }
        self.adopt_orphan_tombstones(&base.pending_orphan_tombstones, pending_orphan_tombstones);
        if *rekey_rebase_pending != base.rekey_rebase_pending {
            self.rekey_rebase_pending = *rekey_rebase_pending;
        }
    }

    /// Merge the per-blob CAS baselines the cycle changed onto the record on disk.
    ///
    /// The unit is the BLOB, not the map: an entry the cycle did not touch is left
    /// exactly as the file has it, so a conflict resolution, a rotation or a re-key that
    /// landed while the cycle was on the wire keeps its baseline.
    ///
    /// A blob this cycle REMOVED is removed from disk even if a command wrote it back.
    /// That is the one same-key case, and the cycle's removal is the later decision: it
    /// means "this baseline must go", which is what a re-key arm says about every id it
    /// stranded.
    fn adopt_blob_baselines(
        &mut self,
        base: &std::collections::BTreeMap<String, BlobSyncState>,
        cycle: &std::collections::BTreeMap<String, BlobSyncState>,
    ) {
        for (id, entry) in cycle {
            if base.get(id) != Some(entry) {
                self.blobs.insert(id.clone(), entry.clone());
            }
        }
        for id in base.keys() {
            if !cycle.contains_key(id) {
                self.blobs.remove(id);
            }
        }
    }

    /// Merge the orphan-tombstone queue the cycle drained onto the record on disk.
    ///
    /// A cycle only ever REMOVES from this queue (its push phase clears what it just
    /// reclaimed); a command appends. So the merge is: drop what this cycle drained, keep
    /// what a command queued while it was in flight, and append anything the cycle added
    /// (nothing today, stated so a future writer is not silently dropped here).
    fn adopt_orphan_tombstones(&mut self, base: &[OrphanTombstone], cycle: &[OrphanTombstone]) {
        let base_ids: std::collections::BTreeSet<&str> =
            base.iter().map(|t| t.blob_id_hex.as_str()).collect();
        let cycle_ids: std::collections::BTreeSet<&str> =
            cycle.iter().map(|t| t.blob_id_hex.as_str()).collect();
        self.pending_orphan_tombstones.retain(|t| {
            // Asleep on disk only because this cycle has not drained it yet.
            !base_ids.contains(t.blob_id_hex.as_str()) || cycle_ids.contains(t.blob_id_hex.as_str())
        });
        for queued in cycle {
            if !base_ids.contains(queued.blob_id_hex.as_str())
                && !self
                    .pending_orphan_tombstones
                    .iter()
                    .any(|t| t.blob_id_hex == queued.blob_id_hex)
            {
                self.pending_orphan_tombstones.push(queued.clone());
            }
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

// This device's identity is NOT read here (myne-md/myne#958).
//
// `read_device_actor` used to live in this module and read this record only, while
// `cycle` read the person credential for the same fact; the two answers diverged and
// every authoring path silently lost the device's identity. Both reads now live in
// `super::device_actor`, the only module allowed to name either record's
// `device_id_hex`, held by `scripts/check-device-actor.mjs`.

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
    update_sync_state(io, dir, |state| {
        if state.own_identity_code.as_deref() == Some(code) {
            return ((), Persist::No);
        }
        state.own_identity_code = Some(code.to_string());
        ((), Persist::Yes)
    })
    .await
}

/// Serializes every read-modify-write of `sync-state.json` in this process.
///
/// Process-wide rather than keyed by vault, for the reason
/// [`super::cycle::sync_cycle_mutex`] gives for the same choice: one active unlocked
/// vault per process, and the section it guards is a read plus a write of one small JSON
/// file. The lock order is `sync_cycle_mutex` → this one, and it cannot be inverted:
/// the closure [`update_sync_state`] runs is synchronous, so nothing it does can reach
/// either lock again.
static WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Whether an [`update_sync_state`] mutation is worth a disk write.
///
/// Its own type rather than a `bool` because one caller answers `No` for a reason that
/// is a rule of the product rather than an optimisation: the two coalesced clocks
/// ([`SUCCESS_STAMP_COALESCE_MS`]) read this record every cycle and move about once an
/// hour, and answering `Yes` on the cycles they did not move buys two whole-record
/// rewrites an hour and nothing else.
///
/// **It does not bound the file's mtime, and the record must not claim it does.** The
/// cycle persists its advanced cursor on every successful run, so `sync-state.json` is
/// still rewritten once per cycle and a device on the 30-second poll still leaves a
/// once-per-cycle at-rest trace of when it was awake and online. `threat-model.md` AS15
/// records that as a residual rather than as a bound (myne-md/myne#1027,
/// `decisions/sync/0787`), and an earlier draft of that amendment claimed more.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Persist {
    /// The record changed: write it.
    Yes,
    /// The record is deliberately unchanged: leave the file, and its mtime, alone.
    No,
}

/// The ONE way to write the sync state: read the record that is on disk NOW, hand it to
/// `mutate`, and write back what the mutation left.
///
/// # Why the read has to happen in here
///
/// The shape this replaces, where every caller read a whole [`SyncState`], changed one
/// field and wrote the whole record back, loses a concurrent writer's change
/// whenever two are in flight: both read the same snapshot, and the last write wins
/// with the loser's field gone (myne-md/myne#964). Nothing reports it. The fields are
/// written by different callers and each loss costs something different: a `cursor`
/// re-pulls work, a CAS baseline makes the next blob write compare against a stale
/// base, `owner_member_token_hex` re-registers the device.
///
/// So the read is not the caller's to do: taking it here, under the lock, is what makes
/// a stale snapshot inexpressible rather than merely discouraged.
///
/// # The closure is synchronous, and that is load-bearing
///
/// It cannot await, so it cannot call back into this function and cannot be driven by
/// anything but the caller that already holds the lock. There is no reentrancy to
/// deadlock on and no second lock order to get wrong.
///
/// # Readers need no lock
///
/// [`read_sync_state`] is unaffected: the write is an atomic replace, so a concurrent
/// reader sees the previous record or the new one and never a torn mix. And the lock is
/// in-process, which is enough because one process owns a vault (the desktop holds a
/// single instance, the browser a single tab).
pub async fn update_sync_state<T>(
    io: &dyn crate::vault_io::VaultIo,
    dir: &Path,
    mutate: impl FnOnce(&mut SyncState) -> (T, Persist),
) -> Result<T, SyncConfigError> {
    let _guard = WRITE_LOCK.lock().await;
    // An unreadable record fails here rather than defaulting: persisting over it would
    // destroy the cursor, the baselines and `meta_baseline_hex` in one step (see
    // [`read_sync_state`]).
    let mut state = read_sync_state(io, dir).await?;
    let (out, persist) = mutate(&mut state);
    if persist == Persist::Yes {
        write_record(io, dir, &state).await?;
    }
    Ok(out)
}

/// Persist what a RUNNING sync cycle changed, without reverting a field another writer
/// moved while the cycle was in flight.
///
/// A cycle cannot use the shape [`update_sync_state`] gives a command, and the reason is
/// structural rather than historical: it loads the record once, then mutates it as the
/// phases report back across a network round trip, so its copy IS the record for as long
/// as it runs. What it must not do is write that copy back whole, because a publish, an
/// enrolment or a member rotation can land in between, so it passes the record it
/// LOADED (`base`) and the record it holds (`cycle`), and only the fields that differ
/// between the two are adopted. Everything else keeps whatever the file says, which is
/// what makes this a merge rather than a clobber.
///
/// The four fields that have a second writer (`blobs`, `meta_baseline_hex`,
/// `pending_orphan_tombstones`, `rekey_rebase_pending`) are why the diff is against
/// `base` and not a fixed roster: a cycle that never touched one of them must not be
/// able to undo the command that did.
///
/// **`base` is advanced to `cycle` on every successful write, and that is not an
/// optimisation.** It means "what this cycle has already made the disk hold", so a value
/// the cycle sets, persists, and later sets BACK is still a change at the second
/// checkpoint. The whole-corpus flag does exactly that: a cycle clears it on entry
/// (myne#292) and recomputes it at the end, so comparing against the pre-cycle snapshot
/// would read the recomputed `true` as "unchanged" and never persist it.
pub async fn persist_cycle_state(
    io: &dyn crate::vault_io::VaultIo,
    dir: &Path,
    base: &mut SyncState,
    cycle: &SyncState,
) -> Result<(), SyncConfigError> {
    update_sync_state(io, dir, |disk| {
        disk.adopt_cycle_changes(base, cycle);
        ((), Persist::Yes)
    })
    .await?;
    *base = cycle.clone();
    Ok(())
}

/// Arm the next cycle to re-base its baseline instead of rejecting the server's head as
/// a forgery, and say whether this call is the one that armed it.
///
/// Both migration paths that move the head format need exactly this, and it is one
/// question with one answer (`decisions/protocol/0603`: the head format is keyed off the
/// vault generation). It is written here, once, because the failure of a half-applied
/// edit is a sync stall that reads as a forged head rather than as a compile error, and
/// because that failure is worth reporting: a caller that cannot raise the flag will
/// watch the next cycle refuse the head and log nothing that names this.
pub async fn arm_rekey_rebase(
    io: &dyn crate::vault_io::VaultIo,
    dir: &Path,
) -> Result<bool, SyncConfigError> {
    update_sync_state(io, dir, |state| {
        if state.rekey_rebase_pending {
            return (false, Persist::No);
        }
        state.rekey_rebase_pending = true;
        (true, Persist::Yes)
    })
    .await
}

/// Write one record to `<dir>/sync-state.json` (atomic replace).
///
/// Callers hold [`WRITE_LOCK`]; that is the whole reason this is private and the public
/// surface above is the mutation rather than the record.
async fn write_record(
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

/// Seed a WHOLE record. **Test and fixture code only**, and the cfg is the point.
///
/// A production caller holding a [`SyncState`] it read earlier is exactly the stale
/// snapshot myne-md/myne#964 is about, so the crate exposes no way to make that call:
/// production writes go through [`update_sync_state`], and the one caller that owns a
/// record outright (a fixture describing a vault, `core/examples/emit-vault-fixture.rs`)
/// builds under `test-support`. The lock is still taken, so a fixture cannot tear a
/// record a test is concurrently mutating.
#[cfg(any(test, feature = "test-support"))]
pub async fn write_sync_state(
    io: &dyn crate::vault_io::VaultIo,
    dir: &Path,
    state: &SyncState,
) -> Result<(), SyncConfigError> {
    let _guard = WRITE_LOCK.lock().await;
    write_record(io, dir, state).await
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

/// Record that a cycle COMPLETED, if the recorded stamp is old enough to be worth replacing.
///
/// Returns whether it wrote. A no-op on the common path: with a 30-second poll
/// interval this writes on roughly one cycle in 120, and reads the file it is
/// about to skip writing, which is the cheap half of an operation that has
/// just finished talking to a server.
///
/// **This is a REACHABILITY clock, not an upload clock.** Every pull-only cycle stamps it
/// (myne-md/myne#1027), which is right for its own consumer, the staleness banner measures
/// "how long has this device been failing to reach the server", and wrong for the one question
/// a user asks of it. [`record_upload_success`] is the other clock.
pub async fn record_sync_success(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &std::path::Path,
    now_ms: u64,
) -> bool {
    stamp_clock(
        io,
        vault_root,
        now_ms,
        |s| s.last_success_at_ms,
        |s, v| s.last_success_at_ms = v,
    )
    .await
}

/// Record that a cycle **uploaded** something (myne-md/myne#1027).
///
/// Called only from a cycle that pushed a blob or advanced the head, so the stamp answers the
/// question `last_success_at_ms` cannot: *when did this device last put anything on the
/// server?* A device that can only pull keeps the old value for ever, which is exactly the
/// signal that was missing when a published vault silently stopped uploading.
///
/// Coalesced like its sibling, one hour, for the reason its field carries: the write this
/// avoids is pure at-rest activity metadata.
pub async fn record_upload_success(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &std::path::Path,
    now_ms: u64,
) -> bool {
    stamp_clock(
        io,
        vault_root,
        now_ms,
        |s| s.last_upload_at_ms,
        |s, v| s.last_upload_at_ms = v,
    )
    .await
}

/// Write one of the two clocks, coalesced. The rule lives here once because the two stamps
/// differ only by which field they own: a second copy of "is it fresh enough to skip the write"
/// drifts the first time one window changes, and the at-rest reasoning behind it is stated
/// per-field, not per-clone.
async fn stamp_clock(
    io: &dyn crate::vault_io::VaultIo,
    vault_root: &std::path::Path,
    now_ms: u64,
    read: fn(&SyncState) -> Option<u64>,
    set: fn(&mut SyncState, Option<u64>),
) -> bool {
    // The freshness check runs INSIDE the locked mutation. Reading it outside and then
    // writing the whole record back is the shape myne-md/myne#964 is about, and this
    // clock is one of the two writers that made it live: it fires from a separate task
    // from the cycle it shares the record with.
    update_sync_state(io, vault_root, |state| {
        let fresh_enough =
            read(state).is_some_and(|prev| now_ms.saturating_sub(prev) < SUCCESS_STAMP_COALESCE_MS);
        if fresh_enough {
            return (false, Persist::No);
        }
        set(state, Some(now_ms));
        (true, Persist::Yes)
    })
    .await
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::VAULT_HEAD_FORMAT_V1;
    use std::collections::BTreeMap;

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

    /// **The chokepoint refuses a record it cannot read, and that refusal is the
    /// invariant every migrated call site now leans on.**
    ///
    /// `update_sync_state` reads before it mutates, so a record that exists and did not
    /// parse fails the whole update and nothing is written. That single check is what
    /// stops a device re-enrolling as new (cursor, VV log, every CAS baseline and
    /// `meta_baseline_hex` gone at once) now that the tolerant `unwrap_or_default()`
    /// reads are gone, so it owes a rejection test rather than only the happy path the
    /// other five callers exercise. Asserting the ERROR alone would pass on an
    /// implementation that wrote the default and reported afterwards, which is why the
    /// second assertion reads the bytes back.
    #[test]
    fn update_sync_state_refuses_an_unreadable_record_and_writes_nothing() {
        let dir = tmpdir("update-refuses-torn");
        let torn = br#"{"cursor":42,"vv_log":[],"bl"#;
        std::fs::write(dir.join(SYNC_STATE_FILE), torn).unwrap();

        let outcome = rt(super::update_sync_state(&IO, &dir, |state| {
            state.cursor = 99;
            ((), Persist::Yes)
        }));

        assert!(
            matches!(outcome, Err(SyncConfigError::Parse)),
            "an unreadable record must fail the update, not be replaced: {outcome:?}"
        );
        assert_eq!(
            std::fs::read(dir.join(SYNC_STATE_FILE)).unwrap(),
            torn.to_vec(),
            "the bytes on disk must be untouched: the failed read cannot license a write"
        );

        std::fs::remove_file(dir.join(SYNC_STATE_FILE)).ok();
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
    ///
    /// **The upload stamp is a DIFFERENT field and this is the test that keeps them apart**
    /// (myne-md/myne#1027): a pull-only cycle stamps the success clock and must not touch the
    /// upload clock, or the one number a user reads to answer "is my work on the server?"
    /// reports the pull it just did.
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
        assert_eq!(
            read_sync_state(dir).unwrap().last_upload_at_ms,
            None,
            "reaching the server is not uploading to it"
        );

        // A real upload stamps its own clock and leaves the success clock alone.
        assert!(rt(super::record_upload_success(&IO, dir, 1_200_000)));
        let after_upload = read_sync_state(dir).unwrap();
        assert_eq!(after_upload.last_upload_at_ms, Some(1_200_000));
        assert_eq!(
            after_upload.last_success_at_ms,
            Some(1_000_000),
            "the two clocks are independent"
        );

        // And the upload clock coalesces on the same hour, for the same at-rest reason.
        assert!(!rt(super::record_upload_success(&IO, dir, 1_201_000)));
        assert_eq!(
            read_sync_state(dir).unwrap().last_upload_at_ms,
            Some(1_200_000)
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
            last_upload_at_ms: None,
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
            last_bindings_check_ms: None,
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

    // The actor read's tests moved with the read, to `super::device_actor`'s own
    // module (myne-md/myne#958): `read_device_actor` no longer exists here, because a
    // test that exercised only this record would pass while the callers that read the
    // OTHER record kept answering differently.

    /// **The invariant: neither of two concurrent writers may lose the other's field.**
    ///
    /// This is the case myne-md/myne#964 was filed for and had no test for: two
    /// mutations in flight at once, each changing a different field. It replaces the
    /// ignored test that asserted the same invariant against the unlocked writer, and it
    /// asserts the invariant rather than the defect: both changes must be present once
    /// both writers return.
    ///
    /// Two parts of the fixture exist to make the DEFECT reachable, because a test that
    /// cannot reach it passes with the lock removed and proves nothing (myne-md/myne#613).
    /// The IO yields after each read has taken its snapshot, so both mutations read the
    /// same bytes and the second write carries a stale record. And it is a memory store
    /// rather than a temp directory: two concurrent atomic writes to one real path
    /// collide on their temp name, so the symptom there is an `Io(NotFound)` instead of
    /// the silent lost update this test is about.
    #[test]
    fn two_concurrent_writers_land_both_of_their_fields() {
        let dir = std::path::PathBuf::from("/vault");
        let io = std::sync::Arc::new(YieldsAfterRead::new());

        rt(async {
            // Seed a record, so both writers read the SAME existing bytes. Without it
            // both would read "absent" and the field the loser drops would be one the
            // winner also set, which is not the case the issue describes.
            super::update_sync_state(&*io, &dir, |state| {
                state.cursor = 1;
                ((), Persist::Yes)
            })
            .await
            .expect("seed");

            // Both writers are in flight before either finishes: `tokio::spawn` queues
            // each, and the yielding read suspends the first after it has taken its
            // snapshot.
            let cursor_writer = tokio::spawn({
                let io = io.clone();
                let dir = dir.clone();
                async move {
                    super::update_sync_state(&*io, &dir, |state| {
                        state.cursor = 7;
                        ((), Persist::Yes)
                    })
                    .await
                }
            });
            let baseline_writer = tokio::spawn({
                let io = io.clone();
                let dir = dir.clone();
                async move {
                    super::update_sync_state(&*io, &dir, |state| {
                        state.meta_baseline_hex = Some("ab".repeat(32));
                        ((), Persist::Yes)
                    })
                    .await
                }
            });

            cursor_writer
                .await
                .expect("writer task")
                .expect("cursor write");
            baseline_writer
                .await
                .expect("writer task")
                .expect("baseline write");

            let after = super::read_sync_state(&*io, &dir)
                .await
                .expect("state readable");
            assert_eq!(
                after.cursor, 7,
                "the first writer's cursor must survive the second writer's write"
            );
            assert_eq!(
                after.meta_baseline_hex.as_deref(),
                Some("ab".repeat(32).as_str()),
                "and the second writer's own field must land"
            );
        });
    }

    /// **A cycle's checkpoint must not revert a field it never touched.**
    ///
    /// The other half of myne-md/myne#964. A cycle holds its own copy of the record for
    /// the length of a network round trip, and commands keep writing through
    /// [`super::update_sync_state`] the whole time. When the cycle persists, the fields it
    /// CHANGED must land and the fields it did not must keep whatever the file says.
    /// Otherwise a publish or an enrolment that landed mid-cycle is undone by the cycle's
    /// next checkpoint, which is the same defect with the loss on the other side.
    #[test]
    fn a_cycle_checkpoint_adopts_only_the_fields_it_changed() {
        let dir = tmpdir("cycle-merge");
        std::fs::remove_file(dir.join(SYNC_STATE_FILE)).ok();
        write_sync_state(
            &dir,
            &SyncState {
                cursor: 1,
                meta_baseline_hex: Some("11".repeat(32)),
                ..SyncState::default()
            },
        )
        .unwrap();

        // The cycle loads the record and mutates two of its own fields.
        let mut base = read_sync_state(&dir).unwrap();
        let mut cycle = base.clone();
        cycle.cursor = 9;
        cycle.meta_baseline_hex = Some("22".repeat(32));

        // A command lands a field the cycle never touches, while the cycle is "on the
        // wire".
        rt(super::update_sync_state(&IO, &dir, |state| {
            state.namespace_hex = Some("cd".repeat(16));
            ((), Persist::Yes)
        }))
        .expect("command write");

        rt(super::persist_cycle_state(&IO, &dir, &mut base, &cycle)).expect("cycle checkpoint");

        let after = read_sync_state(&dir).unwrap();
        assert_eq!(after.cursor, 9, "the cycle's own field lands");
        assert_eq!(
            after.meta_baseline_hex.as_deref(),
            Some("22".repeat(32).as_str()),
            "a field the cycle DID change wins over the older disk value"
        );
        assert_eq!(
            after.namespace_hex.as_deref(),
            Some("cd".repeat(16).as_str()),
            "a field the cycle never touched keeps the command's write"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// **A collection is merged per ENTRY, and that is the granularity that matters.**
    ///
    /// `blobs` and `pending_orphan_tombstones` are the two fields a cycle touchés on
    /// almost every run AND a command writes into: `resolve_conflict` stores a CAS
    /// baseline, a group rotation and both re-key paths store one and queue a reclaim.
    /// Adopting either collection whole deletes the command's entry while it looks like
    /// a correct "the cycle changed this field, so take its copy" merge, which is why
    /// the loss was invisible on inspection (three dimensions and this test's shape).
    ///
    /// Red if either merge is written per field: the command's baseline and its queued
    /// tombstone both disappear.
    #[test]
    fn a_cycle_checkpoint_merges_the_two_shared_collections_per_entry() {
        let dir = tmpdir("cycle-merge-entry");
        std::fs::remove_file(dir.join(SYNC_STATE_FILE)).ok();
        write_sync_state(
            &dir,
            &SyncState {
                blobs: BTreeMap::from([("aa".repeat(16), blob_state(1))]),
                ..SyncState::default()
            },
        )
        .unwrap();

        let mut base = read_sync_state(&dir).unwrap();
        let mut cycle = base.clone();
        // The cycle pushes one blob and drains the queue as it reclaims it.
        cycle.blobs.insert("bb".repeat(16), blob_state(2));
        cycle
            .pending_orphan_tombstones
            .push(orphan("ff".repeat(16)));

        // ... and while it is on the wire a command resolves a conflict on a third
        // blob and queues a reclaim of its own.
        rt(super::update_sync_state(&IO, &dir, |state| {
            state.blobs.insert("cc".repeat(16), blob_state(3));
            state
                .pending_orphan_tombstones
                .push(orphan("ee".repeat(16)));
            ((), Persist::Yes)
        }))
        .expect("command write");

        rt(super::persist_cycle_state(&IO, &dir, &mut base, &cycle)).expect("cycle checkpoint");

        let after = read_sync_state(&dir).unwrap();
        assert_eq!(
            after.blobs.get(&"bb".repeat(16)).map(|b| b.version),
            Some(2),
            "the cycle's own baseline lands"
        );
        assert_eq!(
            after.blobs.get(&"cc".repeat(16)).map(|b| b.version),
            Some(3),
            "a baseline the command wrote mid-cycle survives the checkpoint"
        );
        assert_eq!(
            after.blobs.get(&"aa".repeat(16)).map(|b| b.version),
            Some(1),
            "a baseline neither side touched is left alone"
        );
        let queued: Vec<&str> = after
            .pending_orphan_tombstones
            .iter()
            .map(|t| t.blob_id_hex.as_str())
            .collect();
        assert!(
            queued.contains(&"ee".repeat(16).as_str()),
            "a reclaim the command queued mid-cycle survives: {queued:?}"
        );
        assert!(
            queued.contains(&"ff".repeat(16).as_str()),
            "the cycle's own queued reclaim is persisted: {queued:?}"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// A cycle's REMOVAL of a baseline wins even over a command that wrote the same key
    /// back, because the cycle decided later and the removal is what keeps a retired
    /// sync-id from being re-pushed at a stale CAS base.
    #[test]
    fn a_cycle_checkpoint_removes_the_baselines_it_dropped() {
        let dir = tmpdir("cycle-merge-remove");
        std::fs::remove_file(dir.join(SYNC_STATE_FILE)).ok();
        write_sync_state(
            &dir,
            &SyncState {
                blobs: BTreeMap::from([
                    ("aa".repeat(16), blob_state(1)),
                    ("bb".repeat(16), blob_state(2)),
                ]),
                ..SyncState::default()
            },
        )
        .unwrap();

        let mut base = read_sync_state(&dir).unwrap();
        let mut cycle = base.clone();
        cycle.blobs.remove(&"aa".repeat(16));

        rt(super::persist_cycle_state(&IO, &dir, &mut base, &cycle)).expect("cycle checkpoint");

        let after = read_sync_state(&dir).unwrap();
        assert!(
            !after.blobs.contains_key(&"aa".repeat(16)),
            "a baseline the cycle dropped stays dropped"
        );
        assert_eq!(
            after.blobs.get(&"bb".repeat(16)).map(|b| b.version),
            Some(2)
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    fn blob_state(version: u64) -> BlobSyncState {
        BlobSyncState {
            version,
            content_nonce_hex: "11".repeat(24),
            doc_heads_hex: Vec::new(),
        }
    }

    fn orphan(id: String) -> OrphanTombstone {
        OrphanTombstone {
            blob_id_hex: id,
            base_version: 7,
            content_nonce_hex: "22".repeat(24),
        }
    }

    /// **A value the cycle carries back to where it started is still a change.**
    ///
    /// `corpus_complete` is cleared on cycle entry and recomputed at the end, so a cycle
    /// that legitimately ends with it set changes it TWICE and its final value equals the
    /// snapshot the cycle loaded. A merge that compared only pre-cycle against final would
    /// call that "unchanged" and never persist the recomputed `true`, leaving the
    /// attachment sweep declining forever, which is the state myne#292 is about.
    #[test]
    fn a_cycle_checkpoint_persists_a_value_carried_back_to_its_starting_point() {
        let dir = tmpdir("cycle-aba");
        std::fs::remove_file(dir.join(SYNC_STATE_FILE)).ok();
        write_sync_state(
            &dir,
            &SyncState {
                corpus_complete: true,
                ..SyncState::default()
            },
        )
        .unwrap();

        let mut base = read_sync_state(&dir).unwrap();
        let mut cycle = base.clone();

        // Entry: cleared, and persisted on its own so a cycle that dies in the pull does
        // not leave the previous cycle's `true` on disk.
        cycle.corpus_complete = false;
        rt(super::persist_cycle_state(&IO, &dir, &mut base, &cycle)).expect("entry persist");
        assert!(
            !read_sync_state(&dir).unwrap().corpus_complete,
            "the entry clear must land"
        );

        // The cycle completes and recomputes the flag to its starting value.
        cycle.corpus_complete = true;
        rt(super::persist_cycle_state(&IO, &dir, &mut base, &cycle)).expect("success persist");
        assert!(
            read_sync_state(&dir).unwrap().corpus_complete,
            "the recomputed flag must land, even though it equals the pre-cycle value"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// An in-memory store that yields AFTER each read has taken its snapshot.
    ///
    /// Two effects, both needed: it forces a second mutation to interleave, and it makes
    /// the first one's read the pre-write bytes even though the write lands before that
    /// reader resumes: a stale snapshot, deterministically.
    struct YieldsAfterRead(crate::vault_io::test_io::MemoryVaultIo);

    impl YieldsAfterRead {
        fn new() -> Self {
            Self(crate::vault_io::test_io::MemoryVaultIo::new())
        }
    }

    #[async_trait::async_trait]
    impl crate::vault_io::VaultIo for YieldsAfterRead {
        async fn read(&self, path: &Path) -> crate::vault_io::IoResult<Vec<u8>> {
            let snapshot = self.0.read(path).await;
            // Yielded even when the read FAILED: `read_candidates`' default impl turns
            // `NotFound` into an empty list, so returning early here would let a writer
            // that found no record run to completion without ever interleaving.
            crate::task::yield_now().await;
            snapshot
        }

        async fn read_prefix(&self, path: &Path, len: usize) -> crate::vault_io::IoResult<Vec<u8>> {
            self.0.read_prefix(path, len).await
        }

        async fn write(
            &self,
            path: &Path,
            bytes: &[u8],
            opts: crate::vault_io::WriteOpts,
        ) -> crate::vault_io::IoResult<()> {
            self.0.write(path, bytes, opts).await
        }

        async fn remove_file(&self, path: &Path) -> crate::vault_io::IoResult<()> {
            self.0.remove_file(path).await
        }

        async fn remove_dir_all(&self, path: &Path) -> crate::vault_io::IoResult<()> {
            self.0.remove_dir_all(path).await
        }

        async fn create_dir_all(&self, path: &Path) -> crate::vault_io::IoResult<()> {
            self.0.create_dir_all(path).await
        }

        async fn read_dir(
            &self,
            path: &Path,
        ) -> crate::vault_io::IoResult<Vec<crate::vault_io::DirEntry>> {
            self.0.read_dir(path).await
        }

        async fn exists(&self, path: &Path) -> crate::vault_io::IoResult<bool> {
            self.0.exists(path).await
        }

        async fn is_dir(&self, path: &Path) -> crate::vault_io::IoResult<bool> {
            self.0.is_dir(path).await
        }

        async fn stat(
            &self,
            path: &Path,
        ) -> crate::vault_io::IoResult<Option<crate::vault_io::FileStat>> {
            self.0.stat(path).await
        }

        async fn rename(&self, from: &Path, to: &Path) -> crate::vault_io::IoResult<()> {
            self.0.rename(from, to).await
        }
    }
}
