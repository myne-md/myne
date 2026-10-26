// SPDX-License-Identifier: AGPL-3.0
//! The owner-side **rotation outbox** (myne-md/myne#797).
//!
//! A member removal commits locally before it can reach the network: the group
//! rotation re-keys every local blob and rewrites `vault.meta` in one journaled
//! commit, and only then are the per-member packages POSTed to the vault-scoped
//! relay. Before this module existed those packages lived only in the call
//! frame, and `.rekey-journal` was removed before the POSTs, so a process death
//! between the rotation and the delivery left every remaining member stranded on
//! the retired epoch for good: re-running removal fails `MemberNotFound`, and
//! nothing on disk remembered who was owed what.
//!
//! So the rotation writes the sealed packages (opaque, recipient-sealed frames ,
//! the server stores them verbatim and so can this device) to a device-local
//! record BEFORE the network is touched, and every drain is idempotent:
//!
//! - a recipient is removed from `pending` only after its own POST succeeded, so
//!   a crash mid-loop retries exactly the recipients that did not land;
//! - the server ignores a write at an epoch not greater than the stored one, but
//!   the client does not rely on that: a duplicate can only happen if the process
//!   died between a successful POST and the outbox rewrite, and the record it
//!   would overwrite is the same epoch and byte-identical frame;
//! - the rotation itself is NEVER re-run. The drain derives everything it needs
//!   (meta epoch, retirement ids, the removed person) from this record, so a
//!   retry after `MemberNotFound` is impossible by construction.
//!
//! The record is device-local, never synced and never backed up, and it is
//! magic-less for the same reason `.rekey-journal` is: it is transient recovery
//! bookkeeping, not a `protocol.md` §10.3 blob family.

use crate::host::HostCtx;
use crate::plugins::vault_unlock::state::VaultRuntimeState;
use crate::vault_io::{VaultIo, WriteOpts};
use serde::{Deserialize, Serialize};
use std::path::Path;

use super::devices::SyncDeviceError;
use super::person_account::{
    endpoint_from_host, ensure_owner_member_token, post_group_package_request,
    retire_namespace_request, revoke_member_request,
};
use super::transport::SyncTransport;

/// Device-local file name under the vault root.
pub const ROTATION_OUTBOX_FILE: &str = "vault.rotation-outbox";

const OUTBOX_VERSION: u64 = 1;

/// One recipient's owner-signed, recipient-sealed package, held verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingRotationPackage {
    pub person_id_hex: String,
    /// Base64 of [`protocol::person_invite::encode_signed_group_package`].
    pub package_b64: String,
}

/// The durable record of one committed rotation whose delivery is not finished.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RotationOutbox {
    version: u64,
    pub account_hash_hex: String,
    pub retired_epoch: u64,
    pub replacement_epoch: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reclaim_sync_ids_hex: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed_person_id_hex: Option<String>,
    /// Recipients whose POST has not been confirmed yet.
    pub pending: Vec<PendingRotationPackage>,
    /// Removals inherited from a rotation that was superseded before it drained.
    ///
    /// A revoke and a namespace retirement have no counterpart in the newer
    /// rotation, so replacing the record wholesale dropped them: the first
    /// removed member kept a live server token and the retired epoch stayed
    /// writable (myne-md/myne#797). They are carried here and retried on every
    /// drain, which is safe because both calls are idempotent.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inherited_removals: Vec<String>,
    /// Retired-epoch namespaces inherited the same way.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub inherited_retirements: Vec<RetirementObligation>,
}

/// One superseded rotation's namespace retirement, carried forward by
/// [`RotationOutbox::inherited_retirements`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RetirementObligation {
    pub retired_epoch: u64,
    pub replacement_epoch: u64,
    pub reclaim_sync_ids_hex: Vec<String>,
}

impl RotationOutbox {
    pub fn new(
        account_hash_hex: String,
        retired_epoch: u64,
        replacement_epoch: u64,
        reclaim_sync_ids_hex: Vec<String>,
        removed_person_id_hex: Option<String>,
        pending: Vec<PendingRotationPackage>,
    ) -> Self {
        Self {
            version: OUTBOX_VERSION,
            account_hash_hex,
            retired_epoch,
            replacement_epoch,
            reclaim_sync_ids_hex,
            removed_person_id_hex,
            pending,
            inherited_removals: Vec::new(),
            inherited_retirements: Vec::new(),
        }
    }

    fn is_current(&self) -> bool {
        self.version == OUTBOX_VERSION
    }
}

/// Read the outbox. `Ok(None)` on absent; a present-but-unparseable file is
/// `Err` rather than "absent", because treating it as absent would strand the
/// recipients the (unreadable) record was written to protect.
pub async fn read_rotation_outbox(
    io: &dyn VaultIo,
    vault_root: &Path,
) -> Result<Option<RotationOutbox>, SyncDeviceError> {
    match io.read(&vault_root.join(ROTATION_OUTBOX_FILE)).await {
        Ok(bytes) => {
            let record: RotationOutbox =
                serde_json::from_slice(&bytes).map_err(|_| SyncDeviceError::Internal)?;
            Ok(record.is_current().then_some(record))
        }
        Err(crate::io_failure_kind::IoFailureKind::NotFound) => Ok(None),
        Err(_) => Err(SyncDeviceError::Internal),
    }
}

async fn write_rotation_outbox(
    io: &dyn VaultIo,
    vault_root: &Path,
    record: &RotationOutbox,
) -> Result<(), SyncDeviceError> {
    let bytes = serde_json::to_vec(record).map_err(|_| SyncDeviceError::Internal)?;
    io.write(
        &vault_root.join(ROTATION_OUTBOX_FILE),
        &bytes,
        WriteOpts::default(),
    )
    .await
    .map_err(|_| SyncDeviceError::Internal)
}

async fn remove_rotation_outbox(
    io: &dyn VaultIo,
    vault_root: &Path,
) -> Result<(), SyncDeviceError> {
    match io.remove_file(&vault_root.join(ROTATION_OUTBOX_FILE)).await {
        Ok(()) | Err(crate::io_failure_kind::IoFailureKind::NotFound) => Ok(()),
        Err(_) => Err(SyncDeviceError::Internal),
    }
}

/// Persist a committed rotation's delivery obligations. Called by the rotation
/// itself (inside [`super::member_removal::rotate_group_from_host`]) so a crash
/// on the next line still leaves the packages durable, and again by the command
/// that performs the delivery (idempotent).
///
/// A record for a NEWER replacement epoch replaces an older one; an equal or
/// older epoch is ignored rather than clobbering a rotation already in flight.
pub async fn record_rotation_outbox(
    io: &dyn VaultIo,
    vault_root: &Path,
    record: RotationOutbox,
) -> Result<(), SyncDeviceError> {
    let mut record = record;
    if let Some(existing) = read_rotation_outbox(io, vault_root).await? {
        // An EQUAL epoch is a retry of a rotation that never committed: the
        // record must be replaced, because the retry generated fresh keys and
        // fresh frames, and the old ones open nothing the vault now holds. Only a
        // strictly-newer record wins without being written.
        if record.replacement_epoch < existing.replacement_epoch {
            return Ok(());
        }
        // Carry the superseded record's unfinished obligations forward. Every
        // surviving member is a recipient of the newer rotation, so the PACKAGES
        // are genuinely superseded; a revoke and a namespace retirement are not,
        // and dropping them leaves a removed device able to read the retired
        // epoch forever (myne-md/myne#797).
        record.inherited_removals = existing.inherited_removals;
        if let Some(pid) = existing.removed_person_id_hex {
            record.inherited_removals.push(pid);
        }
        record.inherited_retirements = existing.inherited_retirements;
        if existing.retired_epoch != 0 && !existing.reclaim_sync_ids_hex.is_empty() {
            record.inherited_retirements.push(RetirementObligation {
                retired_epoch: existing.retired_epoch,
                replacement_epoch: existing.replacement_epoch,
                reclaim_sync_ids_hex: existing.reclaim_sync_ids_hex,
            });
        }
    }
    write_rotation_outbox(io, vault_root, &record).await
}

/// Drain the outbox over an already-built transport: push the rotated
/// `vault.meta`, deliver every pending package, record the namespace retirement,
/// revoke the removed member, and rewrite the outbox after each successful
/// recipient so a crash retries only what did not land. Returns `true` when the
/// outbox is finished (and therefore removed).
///
/// `meta_bytes` is read by the caller from disk rather than stored in the
/// outbox: the outbox protects the PACKAGES, and re-reading the local meta at
/// drain time is what makes a retry idempotent even if a later credential change
/// rewrote it in between.
#[allow(clippy::too_many_arguments)]
pub fn drain_rotation_outbox_with_transport(
    transport: &dyn SyncTransport,
    owner_token_hex: &str,
    record: &mut RotationOutbox,
    meta_bytes: &[u8],
    push_meta: bool,
) -> Result<(), SyncDeviceError> {
    use base64::Engine as _;

    // The rotated meta must reach the server before anything else: a removed
    // device must not pull the new epoch even once before its token dies. When a
    // NEWER rotation owns the server's copy this record's meta must not be
    // pushed, and the caller says so rather than this function guessing.
    if push_meta {
        super::enroll::put_vault_meta(transport, owner_token_hex, meta_bytes)
            .map_err(|_| SyncDeviceError::Transport)?;
    }

    let mut first_error: Option<SyncDeviceError> = None;
    let mut delivered: Vec<usize> = Vec::new();
    for (idx, pending) in record.pending.iter().enumerate() {
        let frame = base64::engine::general_purpose::STANDARD
            .decode(&pending.package_b64)
            .map_err(|_| SyncDeviceError::Internal)?;
        match post_group_package_request(
            transport,
            owner_token_hex,
            &record.account_hash_hex,
            &pending.person_id_hex,
            record.replacement_epoch,
            &frame,
        ) {
            Ok(()) => delivered.push(idx),
            Err(e) => {
                first_error.get_or_insert(e);
            }
        }
    }
    if !delivered.is_empty() {
        // Advance the in-memory record so this call does not re-POST a delivered
        // recipient. The caller owns the durable write (this function is sync and
        // runs inside `run_blocking`); a crash before that write can only cause a
        // duplicate POST of a byte-identical frame at the same epoch, which the
        // server ignores, and the very next drain rewrites the record.
        for idx in delivered.into_iter().rev() {
            record.pending.remove(idx);
        }
    }
    // The retirement and the revoke run REGARDLESS of a package failure, and
    // before this call returns: withholding a revocation because one recipient's
    // POST failed leaves a removed device able to pull the retired epoch, which
    // is the worse outcome (the immediate path already reasons this way). The
    // record is persisted by the caller on both arms, so a retry re-runs only
    // what did not land; both calls are idempotent.
    let mut retirements = record.inherited_retirements.clone();
    if record.retired_epoch != 0
        && record.replacement_epoch == record.retired_epoch + 1
        && !record.reclaim_sync_ids_hex.is_empty()
    {
        retirements.push(RetirementObligation {
            retired_epoch: record.retired_epoch,
            replacement_epoch: record.replacement_epoch,
            reclaim_sync_ids_hex: record.reclaim_sync_ids_hex.clone(),
        });
    }
    for obligation in &retirements {
        if let Err(e) = retire_namespace_request(
            transport,
            owner_token_hex,
            &record.account_hash_hex,
            obligation.retired_epoch,
            obligation.replacement_epoch,
            &obligation.reclaim_sync_ids_hex,
        ) {
            first_error.get_or_insert(e);
        }
    }
    let mut removals = record.inherited_removals.clone();
    if let Some(pid) = record.removed_person_id_hex.clone() {
        removals.push(pid);
    }
    for pid in &removals {
        if let Err(e) =
            revoke_member_request(transport, owner_token_hex, &record.account_hash_hex, pid)
        {
            first_error.get_or_insert(e);
        }
    }
    match first_error {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Drop the outbox (delivery finished, or a newer rotation replaced it).
pub async fn clear_rotation_outbox(
    io: &dyn VaultIo,
    vault_root: &Path,
) -> Result<(), SyncDeviceError> {
    remove_rotation_outbox(io, vault_root).await
}

/// Resolve everything a drain needs from this device and run it. Best-effort:
/// callers log and retry next cycle / next unlock. A no-op when no outbox
/// exists.
pub async fn drain_rotation_outbox_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
) -> Result<bool, SyncDeviceError> {
    let root = crate::paths::active_vault_root_from_base(
        &host.app_data_dir().map_err(|_| SyncDeviceError::Internal)?,
        state.active_vault_id().await,
    );
    let Some(record) = read_rotation_outbox(io, &root).await? else {
        return Ok(false);
    };
    let owner_person_id = state
        .clone_person_id()
        .await
        .ok_or(SyncDeviceError::NotEnrolled)?;
    let owner_token = ensure_owner_member_token(
        host,
        io,
        state,
        &crate::account::person_identity::hex_lower(&owner_person_id),
    )
    .await?;
    let meta_bytes = io
        .read(&root.join("vault.meta"))
        .await
        .map_err(|_| SyncDeviceError::Internal)?;
    // The local meta decides whether this rotation COMMITTED at all.
    //
    //   local < replacement  -> the rotation never reached its own commit (the
    //                           outbox is written before the mutation precisely
    //                           so a failure can abort cleanly). Its packages,
    //                           retirement and revoke all describe an epoch this
    //                           vault is not on, and running any of them would
    //                           post keys nobody adopted and retire the epoch the
    //                           vault is still writing. Discard it.
    //   local == replacement -> the record's own commit: deliver everything.
    //   local >  replacement -> superseded: deliver its packages and its
    //                           obligations, but never push its meta.
    // Generation-agnostic: on `NTV7` (every vault born under an identity, and every vault an
    // owner shares now) the `NTV6`-only reader answered `None`, which skipped the
    // never-committed discard check AND left `meta_is_replacement` false, so a rotation's
    // meta was never pushed and the remaining members stayed on the retired epoch.
    let parsed_epoch = protocol::parse_b2b_tail_any(&meta_bytes)
        .map(|b2b| b2b.group_key_epoch)
        .ok();
    // Discard ONLY on positive evidence that the rotation never committed: the
    // meta parsed AND no rekey journal is left. A failed roll-forward leaves the
    // journal behind on purpose (the next unlock retries it), and that vault IS
    // at the replacement epoch once it succeeds; discarding on the unparsed or
    // journal-present state would delete the only copy of the pending packages
    // and strand every remaining member (myne-md/myne#797).
    let journal_left = io
        .exists(&root.join(super::member_removal::REKEY_JOURNAL))
        .await
        .unwrap_or(true);
    if let Some(local_epoch) = parsed_epoch {
        if local_epoch < record.replacement_epoch && !journal_left {
            tracing::warn!(
                stage = "rotation_outbox_drain",
                event = "uncommitted_rotation_discarded",
                local_epoch,
                replacement_epoch = record.replacement_epoch,
                "discarding a rotation record whose rotation never committed"
            );
            remove_rotation_outbox(io, &root).await?;
            return Ok(false);
        }
    }
    let meta_is_replacement = parsed_epoch == Some(record.replacement_epoch);
    let url = endpoint_from_host(host, io).await?;
    let expected_epoch = record.replacement_epoch;
    let mut drain_record = record.clone();
    // The record comes BACK on the failure arm: the caller persists what did
    // land, so a retry re-POSTs only the recipients that did not, and the revoke
    // is not withheld behind a package failure (myne-md/myne#797).
    let (failure, drained) = match crate::task::run_blocking(move || {
        match super::http_transport::build_transport(&url) {
            Err(_) => (Some(SyncDeviceError::Transport), drain_record),
            Ok(transport) => {
                let failure = drain_rotation_outbox_with_transport(
                    transport.as_ref(),
                    &owner_token,
                    &mut drain_record,
                    &meta_bytes,
                    meta_is_replacement,
                )
                .err();
                (failure, drain_record)
            }
        }
    })
    .await
    {
        Ok(pair) => pair,
        Err(_) => (Some(SyncDeviceError::Internal), record.clone()),
    };

    // Only write when this record is still the file's: a rotation that committed
    // between the read and this write owns the outbox now, and overwriting it
    // with our older snapshot would drop its packages. Re-POSTing a delivered
    // recipient is harmless (same frame, same epoch, the server ignores it), so
    // skipping the write loses nothing.
    let current_epoch = read_rotation_outbox(io, &root)
        .await?
        .map(|r| r.replacement_epoch);
    if current_epoch == Some(expected_epoch) {
        // Remove ONLY on a clean pass. A failed retirement or revoke leaves an
        // obligation with no counterpart anywhere else, and deleting the record
        // would drop it after one attempt; the retry is idempotent.
        match failure {
            None => remove_rotation_outbox(io, &root).await?,
            Some(_) => write_rotation_outbox(io, &root, &drained).await?,
        }
    }
    match failure {
        Some(e) => Err(e),
        None => Ok(true),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::sync::transport::{FakeTransport, HttpMethod};

    fn pending(person: &str, frame: &[u8]) -> PendingRotationPackage {
        use base64::Engine as _;
        PendingRotationPackage {
            person_id_hex: person.to_string(),
            package_b64: base64::engine::general_purpose::STANDARD.encode(frame),
        }
    }

    /// myne-md/myne#797, GAP 3. A single recipient's failure must not abandon the
    /// rest, a retry must re-POST ONLY the recipient that did not land, and the
    /// second attempt must finish (retire + revoke) rather than re-running the
    /// rotation.
    #[test]
    fn outbox_retries_only_undelivered_recipients_and_finishes() {
        let t = FakeTransport::new();
        t.on(
            HttpMethod::Put,
            "/vault.meta",
            200,
            b"{\"ok\":true}".to_vec(),
        );
        t.on(
            HttpMethod::Put,
            "/b2b/vaults/aa/group-packages/bb",
            200,
            b"{\"ok\":true}".to_vec(),
        );
        t.on(
            HttpMethod::Put,
            "/b2b/vaults/aa/group-packages/cc",
            500,
            Vec::new(),
        );
        t.on(
            HttpMethod::Post,
            "/b2b/vaults/aa/retire",
            200,
            b"{\"ok\":true}".to_vec(),
        );
        t.on(
            HttpMethod::Delete,
            "/b2b/vaults/aa/members/dd",
            200,
            b"{\"ok\":true}".to_vec(),
        );

        let mut record = RotationOutbox::new(
            "aa".to_string(),
            1,
            2,
            vec!["e1".to_string()],
            Some("dd".to_string()),
            vec![pending("bb", b"frame-bb"), pending("cc", b"frame-cc")],
        );

        drain_rotation_outbox_with_transport(&t, "tok", &mut record, b"meta", true)
            .expect_err("one recipient failed");
        assert_eq!(record.pending.len(), 1, "only the failed recipient is left");
        assert_eq!(record.pending[0].person_id_hex, "cc");
        let first = t.requests();
        assert_eq!(
            first[0].1, "/vault.meta",
            "the rotated meta is pushed before any package"
        );
        assert_eq!(
            first
                .iter()
                .filter(|r| r.1.contains("/group-packages/bb"))
                .count(),
            1,
            "a delivered recipient is not re-POSTed"
        );
        // The retirement and the revoke run even though one package failed:
        // withholding a revocation behind a delivery retry leaves a removed
        // device able to read the retired epoch, which the immediate path
        // already refuses to do (myne-md/myne#797).
        assert!(
            first.iter().any(|r| r.1 == "/b2b/vaults/aa/retire"),
            "the retirement is attempted on the same pass as the failure"
        );
        assert!(
            first.iter().any(|r| r.1 == "/b2b/vaults/aa/members/dd"),
            "and so is the revoke"
        );

        // The recipient's delivery now succeeds: the drain finishes the rotation
        // WITHOUT touching the rotation itself.
        t.on(
            HttpMethod::Put,
            "/b2b/vaults/aa/group-packages/cc",
            200,
            b"{\"ok\":true}".to_vec(),
        );
        drain_rotation_outbox_with_transport(&t, "tok", &mut record, b"meta", true)
            .expect("drained");
        assert!(record.pending.is_empty());
        let all = t.requests();
        assert_eq!(
            all.iter()
                .filter(|r| r.1.contains("/group-packages/bb"))
                .count(),
            1,
            "bb was posted exactly once across both attempts"
        );
        assert_eq!(
            all.iter()
                .filter(|r| r.1.contains("/group-packages/cc"))
                .count(),
            2,
            "cc was retried exactly once"
        );
        assert!(
            all.iter().any(|r| r.1 == "/b2b/vaults/aa/retire"),
            "the retirement is re-attempted on the retry (idempotent)"
        );
        assert!(all.iter().any(|r| r.1 == "/b2b/vaults/aa/members/dd"));
    }

    /// The record is the feature's durability and the only copy of each pending
    /// package: it must survive a process restart, and a superseded rotation must
    /// hand its revoke and namespace retirement to the newer record instead of
    /// dropping them (myne-md/myne#797).
    #[test]
    fn the_outbox_survives_a_restart_and_a_superseded_rotation_keeps_its_obligations() {
        crate::test_support::block_on(async {
            use crate::test_support::ScopedTempDir;
            use crate::vault_io::StdVaultIo;

            let dir = ScopedTempDir::new("rotation-outbox-durable").expect("tempdir");
            let io = StdVaultIo;
            let root = dir.path();

            let first = RotationOutbox::new(
                "aa".to_string(),
                1,
                2,
                vec!["e1".to_string()],
                Some("dd".to_string()),
                vec![pending("bb", b"frame-bb"), pending("cc", b"frame-cc")],
            );
            record_rotation_outbox(&io, root, first)
                .await
                .expect("persist");

            // A restart: nothing in memory, read from disk.
            let read = read_rotation_outbox(&io, root)
                .await
                .expect("read")
                .expect("present");
            assert_eq!(read.replacement_epoch, 2);
            assert_eq!(read.pending.len(), 2);
            assert_eq!(read.removed_person_id_hex.as_deref(), Some("dd"));

            // A second removal commits before the first delivered.
            let second = RotationOutbox::new(
                "aa".to_string(),
                2,
                3,
                vec!["e2".to_string()],
                Some("ee".to_string()),
                vec![pending("ff", b"frame-ff")],
            );
            record_rotation_outbox(&io, root, second)
                .await
                .expect("supersede");

            let read = read_rotation_outbox(&io, root)
                .await
                .expect("read")
                .expect("present");
            assert_eq!(read.replacement_epoch, 3, "the newest rotation owns it");
            assert_eq!(read.pending.len(), 1, "its packages are the live set");
            assert!(
                read.inherited_removals.contains(&"dd".to_string()),
                "the superseded removal's revoke is carried, not dropped"
            );
            assert_eq!(
                read.inherited_retirements.len(),
                1,
                "and so is its namespace retirement"
            );
            assert_eq!(read.inherited_retirements[0].retired_epoch, 1);
        });
    }

    /// A replayed/duplicate delivery is the same epoch and the same frame, so the
    /// server's latest-per-recipient rule is sufficient even though the client
    /// does not rely on it alone: the second drain sends byte-identical bytes.
    #[test]
    fn a_duplicate_post_carries_the_same_epoch_and_frame() {
        let t = FakeTransport::new();
        t.on(HttpMethod::Put, "/vault.meta", 200, b"{}".to_vec());
        t.on(
            HttpMethod::Put,
            "/b2b/vaults/aa/group-packages/bb",
            200,
            b"{}".to_vec(),
        );
        let mut record = RotationOutbox::new(
            "aa".to_string(),
            0,
            2,
            Vec::new(),
            None,
            vec![pending("bb", b"frame-bb")],
        );
        drain_rotation_outbox_with_transport(&t, "tok", &mut record, b"meta", true).expect("drain");
        // Simulate the crash window: the record still lists bb (persist did not
        // happen), so a retry re-POSTs identical bytes at the same epoch.
        let mut replay = RotationOutbox::new(
            "aa".to_string(),
            0,
            2,
            Vec::new(),
            None,
            vec![pending("bb", b"frame-bb")],
        );
        drain_rotation_outbox_with_transport(&t, "tok", &mut replay, b"meta", true)
            .expect("replay");
        let posts: Vec<_> = t
            .requests()
            .into_iter()
            .filter(|r| r.1.contains("/group-packages/bb"))
            .collect();
        assert_eq!(posts.len(), 2);
        assert_eq!(posts[0].2, posts[1].2, "byte-identical replay");
    }
}
