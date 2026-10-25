// SPDX-License-Identifier: AGPL-3.0
//! Member removal (B2B identity substrate, myne-md/myne#698 tasks 4 and 7):
//! the caller that ties the roster merge, the rekey pipeline, and the
//! `vault.meta` re-seal together.
//!
//! The crypto primitives live in `protocol` (`person_rekey::rekey_note_blob`,
//! `rekey_attachment_blob`, `wrap_items_key_to_member`, `roster::apply_rekey`)
//! because they are the same on every client. This module is the ORCHESTRATION
//! that needs the vault's `root_key` and its directory tree, so it runs where
//! the slot does: it is the production caller those primitives were missing.
//!
//! # What removal does, in order
//!
//! 1. Unseal the roster extension and parse it.
//! 2. Mint a fresh `itemsKey` + wrap nonce, and a fresh per-note / per-attachment
//!    nonce for each blob.
//! 3. Walk `notes/*.myn`, `attachments/*` and `snapshots/*.myn`: rewrite each
//!    blob's per-entry key wrap under the new `itemsKey`, content ciphertext
//!    byte-identical (`rekey_note_blob` / `rekey_attachment_blob`).
//! 4. Re-seal the vault's `enc_items_key` under the new key, in place in the
//!    `vault.meta` copy.
//! 5. Tombstone the removed member and advance every remaining member's row
//!    with a fresh per-recipient wrap of the new `itemsKey`
//!    (`roster::apply_rekey` + `wrap_items_key_to_member`).
//! 6. Re-seal the roster into `vault.meta` (`seal_membership_roster_raw`).
//! 7. Update the live slot's `items_key` so the running session keeps working.
//!
//! # Failure direction: all-or-nothing via a rekey journal
//!
//! A partial rekey (some blobs under the new key, some under the old) is
//! strictly worse than a failed removal, because it is invisible until a blob
//! fails to open. So the write path is a two-phase commit whose commit point is
//! the new `vault.meta`:
//!
//! 1. Build every rewritten blob and the new `vault.meta` **in memory**. Any
//!    failure here aborts with the vault untouched (nothing has been written).
//! 2. **Stage** every rewritten blob to its `<path>.rekeytmp` sibling.
//! 3. Write the rekey journal (the new `vault.meta` bytes).
//!    This is the point past which the batch is committed.
//! 4. Publish every staged blob, then write the new `vault.meta` LAST.
//! 5. Remove the journal, swap the slot key, refresh the anchor.
//!
//! [`recover_pending_rekey`] runs at unlock: a journal present means the batch
//! was committed and must roll FORWARD (re-write the meta, publish every staged
//! blob); a journal absent means roll BACK (delete every stale `.tmp`). Because
//! step 2 completes before step 3, a crash before the journal leaves no new
//! bytes live, and a crash after it leaves every new byte reconstructible from
//! the staged `.tmp` plus the journal's meta. The old `itemsKey` is never needed
//! by recovery, which is what makes this recoverable where a meta-first or
//! meta-last single-phase write is not.

use crate::host::HostCtx;
use crate::plugins::vault_unlock::state::{Slot, VaultRuntimeState};
use crate::vault_io::{VaultIo, WriteOpts};
use protocol::{AEAD_KEY_LEN, AEAD_NONCE_LEN};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

/// The device-local rekey journal file at the vault root. Device-local and
/// magic-less by design: it is a transient recovery marker, not a §10.3 blob
/// family, and it never syncs or backs up.
pub const REKEY_JOURNAL: &str = ".rekey-journal";

/// Member-removal errors. Closed enum; no path or secret ever crosses IPC.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MemberRemovalError {
    /// The LEGACY `NTV5` removal path ([`remove_member_from_host`]) is parked and
    /// refuses with this before touching the vault. The canonical B2B rotation
    /// ([`rotate_group_from_host`], which `sync_remove_member` runs) does NOT
    /// produce it, so a live caller never sees this variant; it survives because
    /// the parked body is still compiled and still tested.
    RemovalUnavailable,
    /// No vault is unlocked.
    VaultLocked,
    /// The vault carries no roster extension (a 0580 single-account vault).
    NoRoster,
    /// The named member is not a live row.
    MemberNotFound,
    /// A blob failed to open (wrong key or tampering, non-distinguishing).
    CannotDecrypt,
    /// `vault.meta` parse or re-seal failed.
    InvalidVaultMeta,
    /// File IO failed.
    Io,
    /// Another `vault.meta`-lifecycle mutation holds the auth permit
    /// (a concurrent change-password rotation or delete). The removal did not
    /// start; retry once that operation settles. Reported distinctly from
    /// `VaultLocked` so the caller retries instead of re-enrolling.
    Busy,
}

impl MemberRemovalError {
    /// The reason carried by [`MemberRemovalError::RemovalUnavailable`]. The
    /// only variant that carries a message: every other failure is rendered
    /// from its kind by the caller, while a parked entry point owes the
    /// caller the reason in words.
    pub fn unavailable_message(&self) -> Option<&'static str> {
        match self {
            MemberRemovalError::RemovalUnavailable => {
                Some("Member removal is disabled until the roster wire ships.")
            }
            _ => None,
        }
    }
}

/// The testable core: remove `member_fingerprint_hex` from the active vault.
///
/// PARKED until the roster wire ships: refuses with
/// [`MemberRemovalError::RemovalUnavailable`] before touching the vault (no
/// permit taken, no slot read, no IO). The rotation below is local-only with
/// no peer propagation and no tombstone convergence, so running it would
/// strand peers on the retired key. The body stays compiled behind the
/// refusal (unreachable code is still type-checked), so lifting the gate is
/// deleting the refusal plus the `allow`, not reconstructing the pipeline.
#[allow(unreachable_code)]
pub async fn remove_member_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    member_fingerprint_hex: &str,
) -> Result<(), MemberRemovalError> {
    // While parked the parameters go unused: name them for the live pipeline
    // so lifting the gate is deleting these two lines, not renaming the API.
    let _ = (host, io, state, member_fingerprint_hex);
    return Err(MemberRemovalError::RemovalUnavailable);
    // Serialize against every other `vault.meta`-lifecycle mutation. A rekey is
    // a whole-blob read-modify-write of `vault.meta`; a `change_password`
    // running concurrently writes its new password-side while this holds the
    // meta it read, and the write below would then persist the OLD password
    // wrap over it (both blobs stay AEAD-valid, so nothing detects the revert).
    // Same reason `vault_delete` takes the permit.
    let _permit = match state.auth_permits().try_acquire() {
        Ok(p) => p,
        Err(_) => return Err(MemberRemovalError::Busy),
    };
    // Slot snapshot FIRST, notes mutex second: the slot→notes order is the one
    // every other writer uses (`note_update` holds the slot guard across
    // `notes_write_mutex`), and inverting it deadlocks against a queued slot
    // writer. The snapshot is cloned out so no slot guard is held while the
    // notes lock is taken below.
    let slot = state.slot_read_active().await;
    let (root_key, items_key_id, old_items_key, old_meta_hash) = match &*slot {
        Slot::Unlocked(uv) => (
            Zeroizing::new(**uv.owner_root_key().ok_or(MemberRemovalError::VaultLocked)?),
            uv.items_key_id,
            Zeroizing::new(*uv.items_key),
            uv.vault_meta_bytes_hash,
        ),
        _ => return Err(MemberRemovalError::VaultLocked),
    };
    drop(slot);

    let vault_root = active_vault_root(host, state).await?;
    let meta_path = vault_root.join("vault.meta");
    let meta_bytes = io
        .read(&meta_path)
        .await
        .map_err(|_| MemberRemovalError::Io)?;
    let version = protocol::meta_version_of(&meta_bytes).unwrap_or(protocol::MetaVersion::V0_1);
    let mut meta = protocol::parse_vault_meta_any(&meta_bytes)
        .map_err(|_| MemberRemovalError::InvalidVaultMeta)?;
    let account_number_hash = meta.account_number_hash;

    // (2) The roster extension must exist and carry the member.
    let roster_env = meta
        .membership
        .as_ref()
        .and_then(|m| m.roster.as_ref())
        .ok_or(MemberRemovalError::NoRoster)?;
    let roster_plaintext =
        protocol::unseal_membership_roster(&root_key, roster_env, &account_number_hash)
            .map_err(|_| MemberRemovalError::CannotDecrypt)?;
    let roster = super::roster::parse_roster(&roster_plaintext)
        .ok_or(MemberRemovalError::InvalidVaultMeta)?;
    if roster
        .get(member_fingerprint_hex)
        .filter(|m| !m.deleted)
        .is_none()
    {
        return Err(MemberRemovalError::MemberNotFound);
    }

    // (3) Mint the new itemsKey. Its id does NOT change (the content AAD binds
    // it), and `root_key` is untouched: this rotates the content-encryption
    // key, not the vault identity.
    let new_items_key = Zeroizing::new(random_key()?);
    let mut new_items_key_nonce = [0u8; AEAD_NONCE_LEN];
    getrandom::getrandom(&mut new_items_key_nonce).map_err(|_| MemberRemovalError::Io)?;

    // (4) Rewrite every note, attachment, snapshot, conflict and quarantine blob
    // in memory, under ONE notes-write-mutex hold spanning the walk, the
    // build, and the commit below: a concurrent save landing mid-walk would
    // otherwise be overwritten by `publish_all` (if it lands after the walk's
    // read) or left sealed under the retired key (if it lands before the slot
    // swap), and a save landing BETWEEN a split build lock and commit lock
    // would do the same. One acquisition also avoids self-deadlock (async
    // mutexes are not reentrant). The mutex is taken AFTER the slot snapshot
    // above and dropped BEFORE the slot swap below, so the slot→notes order
    // is never inverted (`note_update` holds the slot guard across this same
    // mutex).
    let _notes_guard = crate::plugins::notes::commands::notes_write_mutex()
        .lock()
        .await;
    let mut staged = rekey_content_blobs(
        io,
        &vault_root,
        &items_key_id,
        &old_items_key,
        &new_items_key,
    )
    .await?;

    let items_wrap_key =
        protocol::derive_subkey_versioned(version, &root_key, protocol::SubkeyRole::ItemsKeyWrap);
    let aad_items = if version == protocol::MetaVersion::V0_2 {
        protocol::aad_vault_items_key_wrap_v0_2(&items_key_id)
    } else {
        protocol::aad_vault_items_key_wrap(&items_key_id)
    };
    let new_enc_items = protocol::aead_seal_ctx(
        &items_wrap_key,
        &new_items_key_nonce,
        &new_items_key[..],
        &aad_items,
    )
    .map_err(|_| MemberRemovalError::InvalidVaultMeta)?;
    meta.items_key_nonce = new_items_key_nonce;
    meta.enc_items_key
        .copy_from_slice(&new_enc_items[..protocol::VAULT_META_WRAPPED_ITEMS_KEY_LEN]);

    // (6) Roster: tombstone the removed member, advance the rest with fresh
    // wraps of the new itemsKey.
    // Panics on an OS CSPRNG failure (the `CryptoRng` bound the person
    // surfaces take needs an infallible source; `rng.rs` documents that
    // posture). Not a recoverable state on a supported platform.
    let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
    let mut new_wraps: std::collections::BTreeMap<String, String> =
        std::collections::BTreeMap::new();
    for (fp, entry) in roster.iter() {
        if fp == member_fingerprint_hex || entry.deleted {
            continue;
        }
        let member_public = protocol::person_key::PersonPublicHalf::from_parts_hex(
            &entry.member_kem_ek_hex,
            &entry.member_ed_pk_hex,
            &entry.member_mldsa_vk_hex,
        )
        .map_err(|_| MemberRemovalError::InvalidVaultMeta)?;
        let wrapped = protocol::person_rekey::wrap_items_key_to_member(
            &new_items_key,
            &member_public,
            &account_number_hash,
            &mut rng,
        )
        .map_err(|_| MemberRemovalError::CannotDecrypt)?;
        new_wraps.insert(fp.clone(), super::invite::wrapped_hex(&wrapped));
    }
    let updated_roster = super::roster::apply_rekey(&roster, member_fingerprint_hex, &new_wraps);
    let updated_plaintext = super::roster::encode_roster(&updated_roster);
    let mut roster_nonce = [0u8; protocol::MEMBERSHIP_ROSTER_NONCE_LEN];
    getrandom::getrandom(&mut roster_nonce).map_err(|_| MemberRemovalError::Io)?;
    let new_roster_env = protocol::seal_membership_roster_raw(
        &root_key,
        &updated_plaintext,
        &account_number_hash,
        &roster_nonce,
    )
    .map_err(|_| MemberRemovalError::InvalidVaultMeta)?;
    if let Some(membership) = meta.membership.as_mut() {
        membership.roster = Some(new_roster_env);
    }

    let new_meta_bytes = protocol::serialize_vault_meta_versioned(version, &meta);

    // (7) Commit: stage every blob, write the journal, PUBLISH the blobs, write
    // the meta LAST. The journal is the commit point; a crash before it rolls
    // back (temps deleted at unlock), a crash after it rolls forward. Meta-last
    // means an interruption before the meta write leaves the vault on the OLD
    // key with every new blob reconstructible from its `.rekeytmp`, and a
    // completed publish is what makes the new key reachable.
    //
    // Still under the SAME `_notes_guard` from (4): no second `lock()`, no
    // gap for a concurrent save to land in.
    stage_all(io, &staged).await?;
    write_journal(io, &vault_root.join(REKEY_JOURNAL), &new_meta_bytes).await?;
    publish_all(io, &staged).await?;
    io.write(&meta_path, &new_meta_bytes, WriteOpts::default())
        .await
        .map_err(|_| MemberRemovalError::Io)?;
    let _ = io.remove_file(&vault_root.join(REKEY_JOURNAL)).await;
    // Release the notes mutex BEFORE touching the slot: `replace_items_key`
    // takes the slot write lock, and holding notes across it would invert the
    // slot→notes order against `note_update`.
    drop(_notes_guard);

    // (8) The running session keeps the same itemsKey by value; swap the
    // slot's copy so note CRUD does not fail until the next unlock re-derives
    // it from the rewritten meta.
    let id = state
        .active_vault_id()
        .await
        .ok_or(MemberRemovalError::VaultLocked)?;
    state.replace_items_key(id, new_items_key).await;

    // (9) The removed member must reach the peers, and this device's meta is
    // now ahead of the server. Mark it dirty so the sync meta phase pushes the
    // rotated key instead of adopting the server's stale copy, and refresh the
    // slot's CAS anchor so the next change-password does not read our own
    // out-of-band write as external tampering.
    //
    // Best-effort with one immediate retry: the marker write is idempotent,
    // so a second attempt is cheap and needs no signature change. A persistent
    // failure still converges rather than stranding the removal: the meta
    // phase pushes on baseline divergence too (`meta_baseline_hex` still
    // holds the pre-removal hash while `vault.meta` already carries the
    // rotated key), so the marker only accelerates the baseline-lost corner
    // instead of gating the push.
    if let Err(first) = crate::plugins::sync::state::mark_vault_meta_dirty(io, &vault_root).await {
        // One immediate retry before giving up (see the guarantee above).
        if let Err(e) = crate::plugins::sync::state::mark_vault_meta_dirty(io, &vault_root).await {
            tracing::warn!(stage = "member_removal", first_error = ?first, error = ?e, "meta-dirty marker write failed twice");
        }
    }
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    sha2::Digest::update(&mut hasher, &new_meta_bytes);
    let new_hash: [u8; 32] = sha2::Digest::finalize(hasher).into();
    state
        .refresh_meta_hash_if(id, old_meta_hash, new_hash)
        .await;

    Ok(())
}

/// Re-key every content blob sealed under the vault `itemsKey`: notes,
/// attachments, snapshots, conflicts and quarantine. Content ciphertext is
/// byte-identical; only each per-entry wrap and its nonce change. The caller
/// holds the notes write mutex across this walk and the commit.
async fn rekey_content_blobs(
    io: &dyn VaultIo,
    vault_root: &Path,
    items_key_id: &[u8; 16],
    old_items_key: &[u8; AEAD_KEY_LEN],
    new_items_key: &[u8; AEAD_KEY_LEN],
) -> Result<Vec<(PathBuf, Vec<u8>)>, MemberRemovalError> {
    let mut staged: Vec<(PathBuf, Vec<u8>)> = Vec::new();

    let notes_dir = vault_root.join("notes");
    for entry in read_dir_or_absent(io, &notes_dir).await? {
        if entry.is_dir {
            continue;
        }
        let Some(uuid_hex) = entry.name.strip_suffix(".myn") else {
            continue;
        };
        let note_uuid = parse_uuid(uuid_hex).ok_or(MemberRemovalError::InvalidVaultMeta)?;
        let path = notes_dir.join(&entry.name);
        let blob = io.read(&path).await.map_err(|_| MemberRemovalError::Io)?;
        if let Some(rekeyed) = rekey_note_maybe(
            &blob,
            &note_uuid,
            items_key_id,
            old_items_key,
            new_items_key,
        )? {
            staged.push((path, rekeyed));
        }
    }

    let attachments_dir = vault_root.join("attachments");
    for entry in read_dir_or_absent(io, &attachments_dir).await? {
        if entry.is_dir {
            continue;
        }
        // Strict: the attachment filename is this client's own writer's output,
        // so an uppercase id is a second identity for one blob (R1.2).
        let Some(attachment_id) = protocol::hex::decode_lower::<32>(&entry.name) else {
            continue;
        };
        let path = attachments_dir.join(&entry.name);
        let blob = io.read(&path).await.map_err(|_| MemberRemovalError::Io)?;
        if let Some(rekeyed) = rekey_attachment_maybe(
            &blob,
            &attachment_id,
            items_key_id,
            old_items_key,
            new_items_key,
        )? {
            staged.push((path, rekeyed));
        }
    }

    // Snapshots hold byte-verbatim note blobs sealed under the SAME `itemsKey`,
    // so they must be re-wrapped in the same pass: leaving them would destroy
    // version history on the new key and leave the removed member able to
    // decrypt it. The note uuid is the first half of
    // `<note-uuid>__<snapshot-uuid>.myn`.
    let snapshots_dir = vault_root.join("snapshots");
    for entry in read_dir_or_absent(io, &snapshots_dir).await? {
        if entry.is_dir {
            continue;
        }
        let Some((note_uuid_str, _)) = crate::snapshot_store::parse_snapshot_filename(&entry.name)
        else {
            continue;
        };
        let note_uuid = parse_uuid(&note_uuid_str).ok_or(MemberRemovalError::InvalidVaultMeta)?;
        let path = snapshots_dir.join(&entry.name);
        let blob = io.read(&path).await.map_err(|_| MemberRemovalError::Io)?;
        if let Some(rekeyed) = rekey_note_maybe(
            &blob,
            &note_uuid,
            items_key_id,
            old_items_key,
            new_items_key,
        )? {
            staged.push((path, rekeyed));
        }
    }

    // `conflicts/<id>.myn` and `quarantine/<uuid>.myn` hold full note blobs
    // sealed under the SAME `itemsKey`, decrypted with the slot's key, so they
    // MUST be re-wrapped in the same pass: leaving them would make a user's
    // quarantined and conflicted revisions undecryptable the moment a member is
    // removed.
    for dir_name in ["conflicts", "quarantine"] {
        let dir = vault_root.join(dir_name);
        for entry in read_dir_or_absent(io, &dir).await? {
            if entry.is_dir {
                continue;
            }
            // The quarantine writer names a duplicate `<uuid>-<n>.myn` (or plain
            // `<uuid>.myn`); use the engine's own suffix-tolerant parser so an
            // engine-written name never aborts the removal with
            // `InvalidVaultMeta` naming the meta rather than the file.
            let note_uuid = super::conflict::parse_quarantine_file_name(&entry.name)
                .or_else(|| entry.name.strip_suffix(".myn").and_then(parse_uuid))
                .ok_or(MemberRemovalError::InvalidVaultMeta)?;
            let path = dir.join(&entry.name);
            let blob = io.read(&path).await.map_err(|_| MemberRemovalError::Io)?;
            if let Some(rekeyed) = rekey_note_maybe(
                &blob,
                &note_uuid,
                items_key_id,
                old_items_key,
                new_items_key,
            )? {
                staged.push((path, rekeyed));
            }
        }
    }

    Ok(staged)
}

/// Test-only fault-injection points for the member-local re-key (myne-md/myne#797).
/// In non-test builds the enum has only [`MemberRekeyFault::None`], so the matches
/// compile out and the production path is byte-identical to a seam-free one.
#[derive(Clone, Copy)]
enum MemberRekeyFault {
    None,
    /// Every blob staged, no journal yet: a crash before the commit point, which
    /// recovery must ROLL BACK.
    #[cfg(test)]
    StopAfterStage,
    /// Journal written, nothing published: a crash after the commit point, which
    /// recovery must ROLL FORWARD.
    #[cfg(test)]
    StopAfterJournal,
    /// Every blob published, marker not yet written: the state a transient I/O
    /// error or a process death leaves, where the next attempt must SKIP the
    /// already-re-keyed blobs rather than fail on them (myne-md/myne#797).
    #[cfg(test)]
    StopAfterPublish,
}

/// Re-key this device's LOCAL content blobs from the retired `itemsKey` to the
/// new one, as part of a member's adoption of an owner group rotation
/// (myne-md/myne#797).
///
/// **Why this exists at all.** The owner-side rotation already rewrites every
/// blob it holds, but a MEMBER's device may hold notes, attachments and
/// snapshots the server has never seen. Those per-entry key wraps are sealed
/// under the retired `itemsKey`, so installing the new keys on the slot without
/// re-wrapping them makes every unsynced local blob unreadable: and there is no
/// server copy to re-pull. This is the member-side counterpart of
/// [`rekey_content_blobs`], with the same two-phase journal and the same
/// `items_key_id` / content-ciphertext invariants.
///
/// `journal_meta_bytes` is the `vault.meta` the re-keyed blobs belong to. It is
/// what [`recover_pending_rekey`] writes on roll-forward; writing the bytes
/// already on disk is a byte-identical no-op for a member, and it keeps ONE
/// recovery path and ONE `.rekeytmp` suffix shared with the owner pipeline.
///
/// Idempotency comes from the epoch marker, not from re-trying the crypto: a
/// caller that has already completed a re-key for `epoch` skips it (the blobs
/// no longer open under the retired key). `epoch` advances the device-local
/// [`crate::plugins::sync::state::CONTENT_EPOCH_FILE`] only after every staged
/// blob has been published and the journal still records the same meta.
pub async fn rekey_local_content_for_member(
    io: &dyn VaultIo,
    vault_root: &Path,
    items_key_id: &[u8; 16],
    old_items_key: &[u8; AEAD_KEY_LEN],
    new_items_key: &[u8; AEAD_KEY_LEN],
    journal_meta_bytes: &[u8],
    epoch: u64,
) -> Result<(), MemberRemovalError> {
    member_rekey_inner(
        io,
        vault_root,
        items_key_id,
        old_items_key,
        new_items_key,
        journal_meta_bytes,
        epoch,
        MemberRekeyFault::None,
        false,
    )
    .await
}

#[cfg_attr(not(test), allow(unused_variables))]
#[allow(clippy::too_many_arguments)]
async fn member_rekey_inner(
    io: &dyn VaultIo,
    vault_root: &Path,
    items_key_id: &[u8; 16],
    old_items_key: &[u8; AEAD_KEY_LEN],
    new_items_key: &[u8; AEAD_KEY_LEN],
    journal_meta_bytes: &[u8],
    epoch: u64,
    fault: MemberRekeyFault,
    holds_notes_lock: bool,
) -> Result<(), MemberRemovalError> {
    let _notes_guard = if holds_notes_lock {
        None
    } else {
        Some(
            crate::plugins::notes::commands::notes_write_mutex()
                .lock()
                .await,
        )
    };
    let staged =
        rekey_content_blobs(io, vault_root, items_key_id, old_items_key, new_items_key).await?;
    if staged.is_empty() {
        // No local content under the retired key (a fresh member device, or a
        // re-key that already completed). Record the epoch so the caller stops
        // treating the content as stale.
        crate::plugins::sync::state::write_content_epoch(io, vault_root, epoch)
            .await
            .map_err(|_| MemberRemovalError::Io)?;
        return Ok(());
    }
    stage_all(io, &staged).await?;
    #[cfg(test)]
    if let MemberRekeyFault::StopAfterStage = fault {
        return Err(MemberRemovalError::Io);
    }
    write_journal(io, &vault_root.join(REKEY_JOURNAL), journal_meta_bytes).await?;
    #[cfg(test)]
    if let MemberRekeyFault::StopAfterJournal = fault {
        return Err(MemberRemovalError::Io);
    }
    publish_all(io, &staged).await?;
    #[cfg(test)]
    if let MemberRekeyFault::StopAfterPublish = fault {
        return Err(MemberRemovalError::Io);
    }
    // Marker BEFORE the journal is removed: a crash between the two leaves the
    // journal for recovery, which re-publishes (idempotently) and re-writes the
    // marker. A marker written after the journal would be the ambiguous order.
    crate::plugins::sync::state::write_content_epoch(io, vault_root, epoch)
        .await
        .map_err(|_| MemberRemovalError::Io)?;
    let _ = io.remove_file(&vault_root.join(REKEY_JOURNAL)).await;
    drop(_notes_guard);
    Ok(())
}

/// One remaining member's delivery package, addressed by its server-side
/// `person_id_hash` (lowercase hex) so the owner can POST it to the vault-scoped
/// route `PUT /b2b/vaults/{account_hash}/group-packages/{person_id}`
/// (`collab-b2b-sessions` task 1). The removed member is never a recipient.
pub struct GroupPackageDelivery {
    pub person_id_hex: String,
    pub package: protocol::person_invite::SignedGroupPackage,
}

/// The outcome of one local canonical group rotation. The retirement records are
/// returned rather than persisted: they are sync-plane records whose transport
/// and retention are Grill 4's, and this model deliberately writes none of them
/// into the vault.
pub struct GroupRotationOutput {
    pub new_epoch: u64,
    /// One owner-signed group package per REMAINING live member that carries a
    /// `person_id_hex` (`collab-b2b-sessions` task 1): the delivery half of the
    /// rotation. The removed member gets none, its roster row is a tombstone
    /// with no wrap. The owner POSTs each to the recipient's vault-scoped route;
    /// a member fetches its own, verifies against the pinned owner public half
    /// and unwraps the new `group_key`. A remaining member migrated from a
    /// pre-B2B roster has no person account to address, so it is skipped here.
    pub packages: Vec<GroupPackageDelivery>,
    pub retirements: Vec<protocol::person_invite::SignedGroupRetirement>,
    /// The retired epoch's shared-singleton sync-ids (hex), for the owner-only
    /// namespace-retirement call (`reclaim_sync_ids_hex`). Empty when the local
    /// sync plane was not enrolled.
    pub reclaim_sync_ids_hex: Vec<String>,
}

/// Address each rotation package by its recipient's `person_id_hex`, joined
/// against the NEW signed roster. A package's payload names the recipient
/// FINGERPRINT; the roster row for that fingerprint carries the
/// `person_id_hash` the delivery route `PUT /b2b/vaults/{account_hash}/
/// group-packages/{person_id}` is keyed on. A remaining member with no person
/// account (a row migrated from the pre-B2B roster) has no server address and is
/// skipped rather than addressed with a placeholder.
fn address_packages(
    packages: Vec<protocol::person_invite::SignedGroupPackage>,
    roster: &protocol::person_invite::GroupRosterPayload,
) -> Result<Vec<GroupPackageDelivery>, MemberRemovalError> {
    let mut addressed = Vec::with_capacity(packages.len());
    for package in packages {
        let payload: protocol::person_invite::GroupPackagePayload =
            serde_json::from_slice(&package.payload)
                .map_err(|_| MemberRemovalError::InvalidVaultMeta)?;
        let Some(person_id_hex) = roster
            .members
            .iter()
            .find(|m| m.fingerprint_hex == payload.recipient_fingerprint_hex)
            .and_then(|m| m.person_id_hex.clone())
        else {
            continue;
        };
        addressed.push(GroupPackageDelivery {
            person_id_hex,
            package,
        });
    }
    Ok(addressed)
}

/// Persist a committed rotation's per-recipient delivery packages to the
/// device-local outbox (myne-md/myne#797). A device with no sync plane has no
/// account address and nothing to deliver, so it is a no-op there.
#[cfg(not(target_arch = "wasm32"))]
#[allow(clippy::too_many_arguments)]
async fn record_rotation_outbox_for_delivery(
    io: &dyn VaultIo,
    vault_root: &Path,
    packages: &[GroupPackageDelivery],
    account_number_hash: &[u8; 16],
    replacement_epoch: u64,
    removed_person_id_hex: Option<&str>,
    reclaim_sync_ids_hex: &[String],
) -> Result<(), super::devices::SyncDeviceError> {
    use super::rotation_outbox::{PendingRotationPackage, RotationOutbox};
    use base64::Engine as _;
    let sync_state = crate::plugins::sync::state::read_sync_state(io, vault_root)
        .await
        .map_err(|_| super::devices::SyncDeviceError::Internal)?;
    if sync_state
        .account_hash_hex
        .as_deref()
        .unwrap_or_default()
        .is_empty()
    {
        return Ok(());
    }
    let mut pending = Vec::with_capacity(packages.len());
    for delivery in packages {
        let frame = protocol::person_invite::encode_signed_group_package(&delivery.package)
            .ok_or(super::devices::SyncDeviceError::Internal)?;
        pending.push(PendingRotationPackage {
            person_id_hex: delivery.person_id_hex.clone(),
            package_b64: base64::engine::general_purpose::STANDARD.encode(&frame),
        });
    }
    let record = RotationOutbox::new(
        crate::plugins::sync::to_hex(account_number_hash),
        replacement_epoch.saturating_sub(1),
        replacement_epoch,
        reclaim_sync_ids_hex.to_vec(),
        removed_person_id_hex.map(str::to_string),
        pending,
    );
    super::rotation_outbox::record_rotation_outbox(io, vault_root, record).await
}

/// The retired epoch's shared-singleton sync-plane blob-ids (hex) in an `NTV6`
/// vault. Every shared singleton whose sync-id is derived from the GROUP key is
/// addressed by a group-derived id (decision 0609), so a rotation to a new
/// `group_key` retires each of them: the attachments catalog, `vault.prefs`,
/// `vault.themes`, `vault.dictionary` (myne-md/myne#640), `vault.member-names`
/// (myne-md/myne#851) and `vault.device-bindings` (`MYU5`, §9.30,
/// myne-md/myne#852).
///
/// **This list and the re-seal set are one decision, not two.** Retiring an id
/// whose blob was not re-sealed DELETES the family server-side and leaves
/// nothing behind, which is why `rotate_group_from_host` re-seals this same set
/// from the old group key to the new one in the step before it queues these.
/// `vault.member-names` and `vault.device-bindings` are group-tier-ONLY: no
/// `NTV5` form, so neither can go through
/// `vault_migrate::b2b::SHARED_SINGLETONS`, whose members are promoted from
/// the owner root tier and whose re-seal therefore takes a `SingletonOldTier`.
/// Each re-seal is the dedicated group-to-group step in the rotation, because
/// their AAD binds `group_key_epoch` and that helper's signature does not carry
/// an epoch.
fn group_rotation_reclaim_sync_ids(old_group_key: &[u8; 32]) -> Vec<String> {
    let group = protocol::GroupKey::new(*old_group_key);
    [
        protocol::GroupRole::CatalogSyncId,
        protocol::GroupRole::PrefsSyncId,
        protocol::GroupRole::ThemesSyncId,
        protocol::GroupRole::PersonalDictSyncId,
        protocol::GroupRole::MemberNamesSyncId,
        protocol::GroupRole::DeviceBindingSyncId,
    ]
    .into_iter()
    .map(|role| {
        let sub = protocol::derive_group_subkey_v0_2(&group, role);
        let mut id = [0u8; 16];
        id.copy_from_slice(&sub[..16]);
        crate::plugins::sync::to_hex(&id)
    })
    .collect()
}

/// **The local canonical group rotation** (B2B, myne-md/myne#712 task 7).
///
/// Rotates an `NTV6` vault's shared authority when a member is removed, without
/// any peer propagation (that is Grill 4's wire work). One pass:
///
/// 1. verify the current signed roster under the pinned owner identity;
/// 2. mint a fresh random `group_key` (epoch + 1) and a fresh `itemsKey`;
/// 3. re-wrap every content blob's per-entry key under the new `itemsKey` —
///    content ciphertext and every identifier byte-identical;
/// 4. re-seal the shared singletons from the OLD group key to the NEW one,
///    `vault.member-names` included (group-tier-only, so it takes the dedicated
///    epoch-aware step rather than the `SHARED_SINGLETONS` loop);
/// 5. rebuild the signed roster: the removed row becomes a tombstone, every
///    remaining live member gets a fresh package at the new epoch (the removed
///    member gets none), and emit the two owner-signed retirement records;
/// 6. re-seal `vault.meta` (`enc_group_key` under the owner root tier,
///    `enc_items_key` under the new group tier) at the new epoch;
/// 7. commit via the rekey journal (meta LAST) and swap the live session's
///    group tier + `itemsKey` so it keeps reading.
///
/// The legacy NTV5 `remove_member_from_host` stays parked; this is the canonical
/// local model it is replaced by.
pub async fn rotate_group_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    owner: &protocol::person_key::PersonKeyPair,
    removed_fingerprint_hex: &str,
) -> Result<GroupRotationOutput, MemberRemovalError> {
    use protocol::person_invite::{rotate_group_roster_signed_by, verify_group_roster};

    let _permit = match state.auth_permits().try_acquire() {
        Ok(p) => p,
        Err(_) => return Err(MemberRemovalError::Busy),
    };

    let (root_key, items_key_id, old_items_key, old_group_key, old_meta_hash) = {
        let slot = state.slot_read_active().await;
        match &*slot {
            Slot::Unlocked(uv) => {
                let root =
                    Zeroizing::new(**uv.owner_root_key().ok_or(MemberRemovalError::VaultLocked)?);
                let group = Zeroizing::new(
                    **uv.group_key
                        .as_ref()
                        .ok_or(MemberRemovalError::InvalidVaultMeta)?,
                );
                (
                    root,
                    uv.items_key_id,
                    Zeroizing::new(*uv.items_key),
                    group,
                    uv.vault_meta_bytes_hash,
                )
            }
            _ => return Err(MemberRemovalError::VaultLocked),
        }
    };

    let vault_root = active_vault_root(host, state).await?;
    let meta_path = vault_root.join("vault.meta");
    let meta_bytes = io
        .read(&meta_path)
        .await
        .map_err(|_| MemberRemovalError::Io)?;
    // Both tail generations rotate the same way: the roster, the group key and the
    // epoch are `NTV6` objects, and `NTV7` only adds the person wrap around them. The
    // gate therefore admits both, and the wrap is carried to the writer below so the
    // frame is re-emitted in the generation it arrived in (dropping it would retire
    // the owner's only phrase-independent credential).
    if !matches!(
        protocol::vault_meta_generation(&meta_bytes),
        protocol::VaultMetaGeneration::B2b | protocol::VaultMetaGeneration::Person
    ) {
        return Err(MemberRemovalError::InvalidVaultMeta);
    }
    let b2b_meta = protocol::parse_b2b_tail_any(&meta_bytes)
        .map_err(|_| MemberRemovalError::InvalidVaultMeta)?;
    let person_wrap =
        if protocol::vault_meta_generation(&meta_bytes) == protocol::VaultMetaGeneration::Person {
            Some(
                protocol::parse_vault_meta_ntv7(&meta_bytes)
                    .map_err(|_| MemberRemovalError::InvalidVaultMeta)?
                    .person_wrap,
            )
        } else {
            None
        };
    let account_number_hash = b2b_meta.base.account_number_hash;
    // Captured rather than read off `b2b_meta` later: `base` is moved out of it at
    // step (6), while the `vault.member-names` re-seal in between needs the RETIRED
    // epoch, which rides that family's AAD (`aad_member_names_blob`).
    let old_epoch = b2b_meta.group_key_epoch;

    // (1) The current roster is sealed under the OLD group key at the current
    // epoch; open it, then verify the owner signature.
    let current_envelope = protocol::person_invite::open_group_roster(
        &old_group_key,
        &account_number_hash,
        b2b_meta.group_key_epoch,
        &b2b_meta.signed_roster_envelope,
    )
    .ok_or(MemberRemovalError::InvalidVaultMeta)?;
    // The owner signs rosters with its device key once it holds one
    // (`decisions/protocol/0731` stage 2), so the rotation reads back either class.
    let owner_public = owner.public_half();
    let bindings_key = crate::plugins::device_binding::bindings_key_for_group(
        &old_group_key,
        account_number_hash,
        b2b_meta.group_key_epoch,
    );
    let own_device = crate::plugins::sync::device_identity::load_for_fallback("member_removal")
        .map(|key| key.public_half());
    let owner_devices = crate::plugins::sync::roster_trust::device_halves_for_owner(
        io,
        &vault_root,
        Some(&bindings_key.borrow()),
        own_device.as_ref(),
        None,
        &owner_public,
    )
    .await;
    let mut current_roster = verify_group_roster(
        crate::plugins::sync::roster_trust::trust(&owner_public, &owner_devices),
        &current_envelope,
        &account_number_hash,
    )
    .map_err(|_| MemberRemovalError::InvalidVaultMeta)?;
    // Heal an old vault's owner row on this write: a vault migrated
    // before the owner row carried a person id cannot resolve the owner's chosen
    // name anywhere, and a removal is an owner-signed roster write like an invite.
    // Done BEFORE the rotate so the new signed roster inherits the fill.
    if let Some(person_id) = state.clone_person_id().await {
        let owner_fingerprint_hex =
            crate::account::person_identity::hex_lower(owner.public_half().fingerprint());
        super::roster::backfill_owner_person_id(
            &mut current_roster,
            &owner_fingerprint_hex,
            &person_id,
        );
    }

    // Captured from the CURRENT roster before the rotate consumes it: the
    // outbox needs the removed member's server address for the revoke, exactly
    // as the command does today.
    // Only the non-wasm outbox consumes this; the wasm build casts no record and
    // must not carry an unused binding (the `wasm-protocol` clippy gate is `-D
    // warnings`, myne-md/myne#797).
    #[cfg(not(target_arch = "wasm32"))]
    let removed_person_id_hex = current_roster
        .members
        .iter()
        .find(|m| m.fingerprint_hex == removed_fingerprint_hex)
        .and_then(|m| m.person_id_hex.clone());

    // (2) Fresh keys + nonces.
    let new_group_key = Zeroizing::new(random_key()?);
    let new_items_key = Zeroizing::new(random_key()?);
    let mut group_key_nonce = [0u8; protocol::AEAD_NONCE_LEN];
    let mut items_key_nonce = [0u8; protocol::AEAD_NONCE_LEN];
    getrandom::getrandom(&mut group_key_nonce).map_err(|_| MemberRemovalError::Io)?;
    getrandom::getrandom(&mut items_key_nonce).map_err(|_| MemberRemovalError::Io)?;

    // (3)/(4) One notes-mutex hold across the walk, the build and the commit.
    let _notes_guard = crate::plugins::notes::commands::notes_write_mutex()
        .lock()
        .await;
    let mut staged = rekey_content_blobs(
        io,
        &vault_root,
        &items_key_id,
        &old_items_key,
        &new_items_key,
    )
    .await?;

    let old_group = protocol::GroupKey::new(*old_group_key);
    let new_group = protocol::GroupKey::new(*new_group_key);
    // Quiesce: hold every shared-singleton writer off for the whole reseal until
    // the commit marker is written (myne-md/myne#711 task 15). Held until this
    // function returns.
    let _quiesce = crate::singleton_quiesce::exclusive().await;
    for filename in crate::plugins::vault_migrate::b2b::SHARED_SINGLETONS {
        let path = vault_root.join(filename);
        let blob = match io.read(&path).await {
            Ok(bytes) => bytes,
            Err(crate::io_failure_kind::IoFailureKind::NotFound) => continue,
            Err(_) => return Err(MemberRemovalError::Io),
        };
        let resealed = crate::plugins::vault_migrate::b2b::reseal_shared_singleton(
            filename,
            &blob,
            crate::plugins::vault_migrate::b2b::SingletonOldTier::Group(&old_group),
            &new_group,
            &account_number_hash,
        )
        .map_err(|_| MemberRemovalError::CannotDecrypt)?;
        staged.push((path, resealed));
    }

    // (5) New signed roster, remaining-member packages, retirement records.
    let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
    // Signed by the owner's DEVICE key when it holds one, with the attestation each
    // package must carry so a member can verify the rotated roster (`0731` stage 2).
    // Absent on a platform with no device-key rung, which keeps the person-key path.
    let owner_public_for_rotation = owner.public_half();
    let bindings_for_rotation = crate::plugins::device_binding::bindings_key_for_group(
        &old_group_key,
        account_number_hash,
        b2b_meta.group_key_epoch,
    );
    let rotation_device =
        crate::plugins::sync::device_identity::load_for_fallback("rotation_roster");
    let rotation_attestation = match (
        &rotation_device,
        super::state::read_sync_state(io, &vault_root).await,
    ) {
        (Some(device_key), Ok(sync_state)) => {
            match sync_state
                .device_id_hex
                .as_deref()
                .and_then(super::devices::hex16)
            {
                Some(device_id) => {
                    let attestation = crate::plugins::sync::roster_trust::own_attestation(
                        io,
                        &vault_root,
                        &bindings_for_rotation.borrow(),
                        &owner_public_for_rotation,
                        &device_id,
                    )
                    .await;
                    attestation.filter(|a| a.device_public_half() == Some(device_key.public_half()))
                }
                None => None,
            }
        }
        _ => None,
    };
    // Both or neither: a device signature with no attestation is a rotation nobody can
    // open, so the device is only used when the attestation is really there.
    let (rotation_device, rotation_attestation) = match (&rotation_device, &rotation_attestation) {
        (Some(device_key), Some(attestation)) => (Some(device_key), Some(attestation)),
        _ => (None, None),
    };
    let rotated = rotate_group_roster_signed_by(
        owner,
        rotation_device,
        rotation_attestation,
        &current_roster,
        removed_fingerprint_hex,
        &new_group_key,
        &account_number_hash,
        &items_key_id,
        &mut rng,
    )
    .map_err(|_| MemberRemovalError::InvalidVaultMeta)?;

    // (5b) Address each remaining member's package by its server-side
    // `person_id_hash` so the owner can POST it to the vault-scoped delivery
    // route (`collab-b2b-sessions` task 1).
    let new_roster = protocol::person_invite::parse_group_roster(&rotated.signed_roster.payload)
        .ok_or(MemberRemovalError::InvalidVaultMeta)?;
    let packages = address_packages(rotated.packages, &new_roster)?;

    // (5c) Re-seal `vault.member-names` from the retired epoch's group tier to
    // the new one. Separate from the `SHARED_SINGLETONS` loop above for two
    // reasons, both structural rather than stylistic: this family has NO `NTV5`
    // (`root_key`) form, so it is always a group-to-group move while that loop's
    // helper takes either old tier, and its AAD binds `group_key_epoch`, which
    // that helper's signature does not carry. The retired epoch's blob opens
    // under the key the member just removed STILL HOLDS, so skipping this would
    // both keep the name map readable to them and leave it unreadable to everyone
    // else, whose session moves to the new group key at step (8). It must land
    // with the reclaim entry in `group_rotation_reclaim_sync_ids`, which retires
    // this blob's old sync-plane id.
    match io
        .read(&vault_root.join(crate::plugins::member_names::MEMBER_NAMES_FILE))
        .await
    {
        Ok(blob) => {
            let old_names_key =
                protocol::derive_group_subkey_v0_2(&old_group, protocol::GroupRole::MemberNamesKey);
            let new_names_key =
                protocol::derive_group_subkey_v0_2(&new_group, protocol::GroupRole::MemberNamesKey);
            let map = protocol::decode_member_names_blob(
                &old_names_key,
                &account_number_hash,
                old_epoch,
                &blob,
            )
            .map_err(|_| MemberRemovalError::CannotDecrypt)?;
            let resealed = protocol::encode_member_names_blob(
                &new_names_key,
                &account_number_hash,
                rotated.new_epoch,
                &map,
            )
            .map_err(|_| MemberRemovalError::CannotDecrypt)?;
            staged.push((
                vault_root.join(crate::plugins::member_names::MEMBER_NAMES_FILE),
                resealed,
            ));
        }
        // Unconditional for the same reason step (5d) below is: the sync-id is
        // retired either way, so a device that holds no local copy must still stage
        // an empty map at the new epoch or the server deletes the retired-epoch blob
        // and leaves every peer stuck on bytes their new key cannot open.
        Err(crate::io_failure_kind::IoFailureKind::NotFound) => {
            let new_names_key =
                protocol::derive_group_subkey_v0_2(&new_group, protocol::GroupRole::MemberNamesKey);
            let resealed = protocol::encode_member_names_blob(
                &new_names_key,
                &account_number_hash,
                rotated.new_epoch,
                &protocol::MemberNamesMap::new(),
            )
            .map_err(|_| MemberRemovalError::CannotDecrypt)?;
            staged.push((
                vault_root.join(crate::plugins::member_names::MEMBER_NAMES_FILE),
                resealed,
            ));
        }
        Err(_) => return Err(MemberRemovalError::Io),
    }

    // (5d) Tombstone the removed member's device bindings and re-seal
    // `vault.device-bindings` into the new epoch, in ONE staged write.
    //
    // The two halves are one operation rather than two, and that is the whole shape of
    // this step. Re-sealing alone would carry the removed member's live rows into a blob
    // they can no longer read, which leaves every other member's device list claiming a
    // person who is not in the vault. Tombstoning alone, into the retired epoch's blob,
    // would be invisible to everyone the moment step (8) moves their session to the new
    // group key.
    //
    // The tombstone is signed by the OWNER, and that is the only signer the read side
    // accepts for a row that is not the caller's own (`verify_device_binding_removal`).
    // It is written HERE rather than through the store's own entry point because that
    // entry point writes to disk, and writing the retired epoch's ciphertext first would
    // leave a window in which the map is on disk in a form nobody can open.
    //
    // Only rows bound to the REMOVED person tombstone. A retired device keeps its binding:
    // its past revisions were genuinely that person's, so revoking one device is not a
    // fact this family has anything to say about, and `sync::devices::revoke_device` writes
    // nothing here.
    match io
        .read(&vault_root.join(crate::plugins::device_binding::DEVICE_BINDINGS_FILE))
        .await
    {
        Ok(blob) => {
            let old_bindings_key = protocol::derive_group_subkey_v0_2(
                &old_group,
                protocol::GroupRole::DeviceBindingKey,
            );
            let new_bindings_key = protocol::derive_group_subkey_v0_2(
                &new_group,
                protocol::GroupRole::DeviceBindingKey,
            );
            let mut map = protocol::decode_device_binding_blob(
                &old_bindings_key,
                &account_number_hash,
                old_epoch,
                &blob,
            )
            .map_err(|_| MemberRemovalError::CannotDecrypt)?;
            let mut tombstone_rng = rand_core::UnwrapErr(crate::rng::OsRng);
            map = match crate::plugins::device_binding::tombstone_devices_for_person(
                map,
                owner,
                removed_fingerprint_hex,
                &mut tombstone_rng,
            ) {
                Ok((map, _tombstoned)) => map,
                // A malformed row (a key that is not 16 hex bytes, a fingerprint that is
                // not 32) cannot be tombstoned and cannot be trusted either. Refusing the
                // whole rotation is the honest answer: the alternative is a re-seal that
                // silently carries a row nobody could verify.
                Err(_) => return Err(MemberRemovalError::InvalidVaultMeta),
            };
            let resealed = protocol::encode_device_binding_blob(
                &new_bindings_key,
                &account_number_hash,
                rotated.new_epoch,
                &map,
            )
            .map_err(|_| MemberRemovalError::CannotDecrypt)?;
            staged.push((
                vault_root.join(crate::plugins::device_binding::DEVICE_BINDINGS_FILE),
                resealed,
            ));
        }
        // The id is reclaimed whether or not this device happens to hold the blob
        // (`group_rotation_reclaim_sync_ids` lists it unconditionally), so the
        // re-seal has to be unconditional too. Skipping it here would have the
        // server DELETE the retired-epoch blob and leave nothing at the new id,
        // and a peer whose local copy is still sealed at the retired epoch could
        // neither open it (the AAD binds `group_key_epoch`) nor repair it: its
        // `read_verified_bindings_bytes` answers `None` for bytes that do not
        // decode, so the sync phase computes itself clean and never replaces the
        // file, and that device's attribution stays blank for good. An absent file
        // and an empty map are the same thing to every reader of this family, so
        // staging the empty map at the new epoch is what keeps the two halves of
        // the rotation landing together.
        Err(crate::io_failure_kind::IoFailureKind::NotFound) => {
            let new_bindings_key = protocol::derive_group_subkey_v0_2(
                &new_group,
                protocol::GroupRole::DeviceBindingKey,
            );
            let resealed = protocol::encode_device_binding_blob(
                &new_bindings_key,
                &account_number_hash,
                rotated.new_epoch,
                &protocol::DeviceBindingsMap::new(),
            )
            .map_err(|_| MemberRemovalError::CannotDecrypt)?;
            staged.push((
                vault_root.join(crate::plugins::device_binding::DEVICE_BINDINGS_FILE),
                resealed,
            ));
        }
        Err(_) => return Err(MemberRemovalError::Io),
    }

    // (6) Re-seal the NTV6 metadata at the new epoch.
    let mut base = b2b_meta.base;
    let enc_items = protocol::aead_seal_ctx(
        &protocol::derive_group_subkey_v0_2(&new_group, protocol::GroupRole::ItemsKeyWrap),
        &items_key_nonce,
        &new_items_key[..],
        &protocol::aad_vault_items_key_wrap_v0_2(&items_key_id),
    )
    .map_err(|_| MemberRemovalError::InvalidVaultMeta)?;
    base.items_key_nonce = items_key_nonce;
    base.enc_items_key
        .copy_from_slice(&enc_items[..protocol::VAULT_META_WRAPPED_ITEMS_KEY_LEN]);
    let enc_group = protocol::aead_seal_ctx(
        &protocol::derive_owner_subkey_v0_2(
            &protocol::OwnerKey::new(*root_key),
            protocol::OwnerRole::GroupKeyWrap,
        ),
        &group_key_nonce,
        &new_group_key[..],
        &protocol::aad_vault_group_key_wrap_v0_2(&account_number_hash, rotated.new_epoch),
    )
    .map_err(|_| MemberRemovalError::InvalidVaultMeta)?;
    let mut enc_group_key = [0u8; protocol::VAULT_META_WRAPPED_ITEMS_KEY_LEN];
    enc_group_key.copy_from_slice(&enc_group[..protocol::VAULT_META_WRAPPED_ITEMS_KEY_LEN]);
    let mut roster_nonce = [0u8; protocol::AEAD_NONCE_LEN];
    getrandom::getrandom(&mut roster_nonce).map_err(|_| MemberRemovalError::Io)?;
    let signed_roster_envelope = protocol::person_invite::seal_group_roster(
        &new_group_key,
        &account_number_hash,
        rotated.new_epoch,
        &roster_nonce,
        &rotated.signed_roster,
    )
    .ok_or(MemberRemovalError::InvalidVaultMeta)?;
    let new_meta_bytes = match person_wrap {
        Some(person_wrap) => {
            protocol::serialize_vault_meta_ntv7(&protocol::PersonWrappedVaultMeta {
                base,
                group_key_nonce,
                enc_group_key,
                group_key_epoch: rotated.new_epoch,
                signed_roster_envelope,
                person_wrap,
            })
        }
        None => protocol::serialize_vault_meta_ntv6(&protocol::B2bVaultMeta {
            base,
            group_key_nonce,
            enc_group_key,
            group_key_epoch: rotated.new_epoch,
            signed_roster_envelope,
        }),
    }
    .map_err(|_| MemberRemovalError::InvalidVaultMeta)?;

    // (6b) Persist the delivery obligations BEFORE the first mutation. This is
    // the record the rotation exists to survive: a crash after the commit with no
    // outbox strands every remaining member on the retired epoch, because
    // re-running removal answers `MemberNotFound` (myne-md/myne#797). Writing it
    // here is what makes its failure abortable: nothing has changed yet, so the
    // caller can retry. A record whose meta never reaches `replacement_epoch` is
    // discarded by the drain rather than delivered.
    let reclaim_sync_ids_hex = group_rotation_reclaim_sync_ids(&old_group_key);
    #[cfg(not(target_arch = "wasm32"))]
    if !packages.is_empty() || removed_person_id_hex.is_some() {
        record_rotation_outbox_for_delivery(
            io,
            &vault_root,
            &packages,
            &account_number_hash,
            rotated.new_epoch,
            removed_person_id_hex.as_deref(),
            &reclaim_sync_ids_hex,
        )
        .await
        .map_err(|_| MemberRemovalError::Io)?;
    }
    // (7) Journaled commit: stage, journal, publish, meta LAST.
    stage_all(io, &staged).await?;
    write_journal(io, &vault_root.join(REKEY_JOURNAL), &new_meta_bytes).await?;
    publish_all(io, &staged).await?;
    io.write(&meta_path, &new_meta_bytes, WriteOpts::default())
        .await
        .map_err(|_| MemberRemovalError::Io)?;
    // The local content is now wrapped under the new epoch. Recorded before the
    // journal is removed so a crash between the two has recovery write the same
    // fact (myne-md/myne#797); a member's re-key uses the same marker.
    let _ =
        crate::plugins::sync::state::write_content_epoch(io, &vault_root, rotated.new_epoch).await;
    let _ = io.remove_file(&vault_root.join(REKEY_JOURNAL)).await;
    // Release notes BEFORE touching the slot (`slot→notes` order).
    drop(_notes_guard);

    // (8) The running session moves to the new tiers.
    let id = state
        .active_vault_id()
        .await
        .ok_or(MemberRemovalError::VaultLocked)?;
    state.replace_items_key(id, new_items_key).await;
    state.set_group_key(id, new_group_key).await;

    // (9) Mark the meta dirty so sync pushes the rotation, and refresh the CAS
    // anchor so the next change-password is not read as external tampering.
    if let Err(first) = crate::plugins::sync::state::mark_vault_meta_dirty(io, &vault_root).await {
        if let Err(e) = crate::plugins::sync::state::mark_vault_meta_dirty(io, &vault_root).await {
            tracing::warn!(stage = "group_rotation", first_error = ?first, error = ?e, "meta-dirty marker write failed twice");
        }
    }
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    sha2::Digest::update(&mut hasher, &new_meta_bytes);
    let new_hash: [u8; 32] = sha2::Digest::finalize(hasher).into();
    state
        .refresh_meta_hash_if(id, old_meta_hash, new_hash)
        .await;

    // (10) Re-base the sync plane: the shared-singleton sync-ids are group-derived
    // in an `NTV6` vault, so the rotation moved them. Queue the retired epoch's
    // ids for server reclaim and drop their baselines (decision 0609).
    rebase_sync_plane_for_group_rotation(io, &vault_root, &old_group_key).await;

    Ok(GroupRotationOutput {
        new_epoch: rotated.new_epoch,
        // The per-member delivery packages the rotation already built, now
        // addressed by recipient `person_id_hash` for the delivery route
        // (`collab-b2b-sessions` task 1).
        packages,
        retirements: rotated.retirements,
        reclaim_sync_ids_hex,
    })
}

/// Re-base the sync plane for a group rotation (myne-md/myne#711 task 30,
/// `decisions/protocol/0609`). In an `NTV6` vault the reserved sync-ids of the
/// shared singletons (attachments catalog, prefs, themes, member names and
/// `vault.device-bindings` (`MYU5`, §9.30, myne-md/myne#852)) are
/// derived from the group key, so a rotation to a new epoch moves them. Each retired epoch's id
/// that this device holds a baseline for is queued as an orphan tombstone (the
/// next push flags it on the server so horizon-GC reclaims the stranded record)
/// and its baseline dropped, the same shape as
/// `vault_migrate::rebase_sync_plane_after_rekey` for a root re-key.
///
/// Content addresses (note UUIDs, attachment ids, conversation/entry ids) do
/// NOT move: those baselines stay. A device that did not perform the rotation
/// learns of it from the greater `vault.meta` epoch and clears all baselines
/// through the existing epoch-adoption path.
async fn rebase_sync_plane_for_group_rotation(
    io: &dyn VaultIo,
    vault_root: &Path,
    old_group_key: &[u8; 32],
) {
    use crate::plugins::sync::state::{read_sync_state, write_sync_state, OrphanTombstone};
    let Ok(mut state) = read_sync_state(io, vault_root).await else {
        // Present and unreadable: leave it alone, exactly as the root re-key
        // does; a human has to look at it.
        return;
    };
    if state.device_id_hex.is_none() {
        return; // never enrolled: there is no sync plane to re-base
    }
    let mut changed = false;
    for hex in group_rotation_reclaim_sync_ids(old_group_key) {
        if let Some(baseline) = state.blobs.get(&hex) {
            // Queue the tombstone BEFORE dropping the baseline: the removal
            // takes the `base_version` the tombstone push CASes against. If the
            // tombstone cannot be minted (RNG failure), leave the baseline so the
            // next cycle can retry rather than dropping it un-tombstoned.
            let mut nonce = [0u8; 24];
            if getrandom::getrandom(&mut nonce).is_err() {
                tracing::warn!(
                    stage = "group_rotation",
                    "could not mint a reclaim nonce; leaving the baseline for the next attempt"
                );
                continue;
            }
            state.pending_orphan_tombstones.push(OrphanTombstone {
                blob_id_hex: hex.clone(),
                base_version: baseline.version,
                content_nonce_hex: crate::plugins::sync::to_hex(&nonce),
            });
            state.blobs.remove(&hex);
            changed = true;
        }
    }
    if changed {
        if let Err(e) = write_sync_state(io, vault_root, &state).await {
            tracing::warn!(
                stage = "group_rotation",
                error = ?e,
                "sync-plane rebase state write failed; the next cycle may strand the retired ids"
            );
        }
    }
}

/// The removed member's addressable `person_id_hash` from the current signed
/// roster, when the row carries one (myne-md/myne#711 task 14). `None` for a row
/// migrated from the pre-B2B roster, which has no person account to revoke.
pub async fn member_person_id_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    owner: &protocol::person_key::PersonKeyPair,
    fingerprint_hex: &str,
) -> Result<Option<String>, MemberRemovalError> {
    let group_key = {
        let slot = state.slot_read_active().await;
        match &*slot {
            Slot::Unlocked(uv) => Zeroizing::new(
                **uv.group_key
                    .as_ref()
                    .ok_or(MemberRemovalError::InvalidVaultMeta)?,
            ),
            _ => return Err(MemberRemovalError::VaultLocked),
        }
    };
    let vault_root = active_vault_root(host, state).await?;
    let meta_bytes = io
        .read(&vault_root.join("vault.meta"))
        .await
        .map_err(|_| MemberRemovalError::Io)?;
    let b2b_meta = protocol::parse_b2b_tail_any(&meta_bytes)
        .map_err(|_| MemberRemovalError::InvalidVaultMeta)?;
    let account_number_hash = b2b_meta.base.account_number_hash;
    let envelope = protocol::person_invite::open_group_roster(
        &group_key,
        &account_number_hash,
        b2b_meta.group_key_epoch,
        &b2b_meta.signed_roster_envelope,
    )
    .ok_or(MemberRemovalError::InvalidVaultMeta)?;
    // Either class, for the same reason the rotation accepts both: the roster of a vault
    // whose owner signs with a device key is a `v2`-class roster.
    let owner_public = owner.public_half();
    let mut owner_devices: Vec<protocol::device_key::DevicePublicHalf> = Vec::new();
    if let Ok(sync_state) = crate::plugins::sync::state::read_sync_state(io, &vault_root).await {
        if let Some(attestation) = sync_state.owner_device.as_ref() {
            if attestation.verifies_against(&owner_public) {
                if let Some(half) = attestation.device_public_half() {
                    owner_devices.push(half);
                }
            }
        }
    }
    if let Some(key) = crate::plugins::sync::device_identity::load_for_fallback("rotation_verify") {
        owner_devices.push(key.public_half());
    }
    let roster = protocol::person_invite::verify_group_roster(
        crate::plugins::sync::roster_trust::trust(&owner_public, &owner_devices),
        &envelope,
        &account_number_hash,
    )
    .map_err(|_| MemberRemovalError::InvalidVaultMeta)?;
    Ok(roster
        .members
        .iter()
        .find(|m| m.fingerprint_hex == fingerprint_hex)
        .and_then(|m| m.person_id_hex.clone()))
}

/// Recover an interrupted rekey. Runs at unlock, before any other read.
///
/// A journal present means the commit point was reached: republish every staged
/// `.rekeytmp` and write the new `vault.meta`. A journal absent means the batch
/// never committed: delete every stale `.rekeytmp`. Idempotent.
///
/// Every step is confirmed before its input is dropped: a temp is removed only
/// after its destination write succeeds, and the journal is removed only after
/// every temp published and the meta landed. On ANY failure the journal and the
/// remaining temps are left in place for the next unlock, so a transient error
/// can never turn a committed batch into a half-rekeyed vault.
pub async fn recover_pending_rekey(
    io: &dyn VaultIo,
    vault_root: &Path,
) -> Result<Option<Vec<u8>>, ()> {
    let journal = vault_root.join(REKEY_JOURNAL);
    // A probe ERROR is not "absent": treating it as absent would take the
    // roll-back branch and delete a committed batch's only copies. Only a
    // confirmed absent journal rolls back; any other error changes nothing.
    let committed = match io.exists(&journal).await {
        Ok(v) => v,
        Err(_) => return Err(()),
    };

    let mut failed = false;
    // The vault root is scanned too: the group rotation stages the SHARED
    // SINGLETONS (`vault.prefs`, `vault.search`, …) as root-level
    // `<name>.rekeytmp`, and a recovery that only walked `REKEY_DIRS` would
    // leave a committed rotation's singletons unpublished — a crash there reads
    // as a vault whose settings silently reverted.
    let scan_dirs = core::iter::once(vault_root.to_path_buf())
        .chain(REKEY_DIRS.iter().map(|name| vault_root.join(name)));
    for dir in scan_dirs {
        let entries = match io.read_dir(&dir).await {
            Ok(e) => e,
            Err(crate::io_failure_kind::IoFailureKind::NotFound) => continue,
            Err(_) => {
                failed = true;
                continue;
            }
        };
        for entry in entries.iter().filter(|e| !e.is_dir) {
            let Some(base) = entry.name.strip_suffix(".rekeytmp") else {
                continue;
            };
            let tmp = dir.join(&entry.name);
            if committed {
                let Ok(bytes) = io.read(&tmp).await else {
                    failed = true;
                    continue;
                };
                if io
                    .write(&dir.join(base), &bytes, WriteOpts::default())
                    .await
                    .is_err()
                {
                    failed = true;
                    continue;
                }
            }
            let _ = io.remove_file(&tmp).await;
        }
    }

    // The meta bytes the recovery wrote, returned so the caller can re-derive
    // the slot's `itemsKey` from them: the session opened against the OLD meta,
    // so without this the running session holds the retired key against blobs
    // that are now sealed under the new one, and every note read fails.
    let mut recovered_meta: Option<Vec<u8>> = None;
    if committed && !failed {
        match io.read(&journal).await {
            Ok(new_meta) => {
                if io
                    .write(
                        &vault_root.join("vault.meta"),
                        &new_meta,
                        WriteOpts::default(),
                    )
                    .await
                    .is_err()
                {
                    failed = true;
                } else {
                    // The committed batch is a rotation when its meta carries the
                    // B2B tail, in EITHER generation (`NTV7` is the birth format and
                    // keeps the `NTV6` tail byte for byte); record that the local
                    // content is now at that epoch, so a member's adoption (and the
                    // owner's own next cycle) can tell "keys installed, blobs still
                    // retired" from "both landed". Asking for the `NTV6` frame only
                    // skipped this write on every person-born vault, which is now
                    // every shared vault.
                    if let Ok(b2b) = protocol::parse_b2b_tail_any(&new_meta) {
                        let _ = crate::plugins::sync::state::write_content_epoch(
                            io,
                            vault_root,
                            b2b.group_key_epoch,
                        )
                        .await;
                    }
                    recovered_meta = Some(new_meta);
                }
            }
            Err(_) => failed = true,
        }
    }

    if failed {
        // Leave the journal: the next unlock retries the idempotent recovery.
        return Err(());
    }
    if committed {
        let _ = io.remove_file(&journal).await;
    }
    Ok(recovered_meta)
}

/// Read a directory, treating absence as empty and any other error as fatal.
async fn read_dir_or_absent(
    io: &dyn VaultIo,
    dir: &Path,
) -> Result<Vec<crate::vault_io::DirEntry>, MemberRemovalError> {
    match io.read_dir(dir).await {
        Ok(entries) => Ok(entries),
        Err(crate::io_failure_kind::IoFailureKind::NotFound) => Ok(Vec::new()),
        Err(_) => Err(MemberRemovalError::Io),
    }
}

/// Re-wrap one note or snapshot blob under the new `itemsKey` with a fresh
/// nonce (content ciphertext preserved).
fn rekey_note(
    blob: &[u8],
    note_uuid: &[u8; 16],
    items_key_id: &[u8; 16],
    old_items_key: &[u8; AEAD_KEY_LEN],
    new_items_key: &[u8; AEAD_KEY_LEN],
) -> Result<Vec<u8>, MemberRemovalError> {
    let nonce = fresh_nonce()?;
    protocol::person_rekey::rekey_note_blob(
        blob,
        note_uuid,
        items_key_id,
        old_items_key,
        new_items_key,
        &nonce,
    )
    .map(|r| r.blob)
    .map_err(|_| MemberRemovalError::CannotDecrypt)
}

/// Re-wrap a note-shaped blob, **tolerating a blob already re-keyed**.
///
/// A crash between `publish_all` and the content-epoch marker leaves the live
/// blobs under the NEW key with the journal still present and no marker, so the
/// next attempt opens the first blob with the retired key and would answer
/// `CannotDecrypt`. That turned one I/O error into a permanent lockout: the
/// journal's own roll-forward runs after a successful unlock, and this path runs
/// inside the unlock (myne-md/myne#797). `Ok(None)` therefore means "already
/// under the new key, nothing to stage", proved by re-wrapping under that key
/// rather than guessed from the marker.
fn rekey_note_maybe(
    blob: &[u8],
    note_uuid: &[u8; 16],
    items_key_id: &[u8; 16],
    old_items_key: &[u8; AEAD_KEY_LEN],
    new_items_key: &[u8; AEAD_KEY_LEN],
) -> Result<Option<Vec<u8>>, MemberRemovalError> {
    match rekey_note(blob, note_uuid, items_key_id, old_items_key, new_items_key) {
        Ok(rekeyed) => Ok(Some(rekeyed)),
        Err(MemberRemovalError::CannotDecrypt) => {
            // Same shape, same keys: an open that succeeds here is proof the blob
            // is already wrapped under the new key.
            match rekey_note(blob, note_uuid, items_key_id, new_items_key, new_items_key) {
                Ok(_) => Ok(None),
                Err(_) => Err(MemberRemovalError::CannotDecrypt),
            }
        }
        Err(e) => Err(e),
    }
}

/// Attachment-shaped twin of [`rekey_note_maybe`], same contract and same reason.
fn rekey_attachment_maybe(
    blob: &[u8],
    attachment_id: &[u8; 32],
    items_key_id: &[u8; 16],
    old_items_key: &[u8; AEAD_KEY_LEN],
    new_items_key: &[u8; AEAD_KEY_LEN],
) -> Result<Option<Vec<u8>>, MemberRemovalError> {
    let attempt = |old: &[u8; AEAD_KEY_LEN]| {
        protocol::person_rekey::rekey_attachment_blob(
            blob,
            attachment_id,
            items_key_id,
            old,
            new_items_key,
            &fresh_nonce()?,
        )
        .map_err(|_| MemberRemovalError::CannotDecrypt)
    };
    match attempt(old_items_key) {
        Ok(rekeyed) => Ok(Some(rekeyed)),
        Err(MemberRemovalError::CannotDecrypt) => match attempt(new_items_key) {
            Ok(_) => Ok(None),
            Err(_) => Err(MemberRemovalError::CannotDecrypt),
        },
        Err(e) => Err(e),
    }
}

fn fresh_nonce() -> Result<[u8; AEAD_NONCE_LEN], MemberRemovalError> {
    let mut nonce = [0u8; AEAD_NONCE_LEN];
    getrandom::getrandom(&mut nonce).map_err(|_| MemberRemovalError::Io)?;
    Ok(nonce)
}

/// The staged temp for a rekey blob. DISTINCT from `atomic_write::tmp_path`
/// (`<path>.tmp`) ON PURPOSE: `note_txn`'s rename journal treats every
/// `notes/<uuid>.myn.tmp` as ITS staging, and `recover_pending_rename` deletes
/// them when no `.rename-journal` is present. Sharing that name meant a
/// committed rekey batch's temps were deleted at the next unlock by the rename
/// recovery, which runs first, leaving the notes under the retired `itemsKey`
/// while `vault.meta` named the new one. The `.rekeytmp` suffix is outside the
/// note/rename grammar, so the two recoverers never see each other's temps.
fn rekey_tmp(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    let mut tmp_name = name;
    tmp_name.push(".rekeytmp");
    path.with_file_name(tmp_name)
}

/// Every directory the rekey walks and the recovery scans. `conflicts/` and
/// `quarantine/` hold full note blobs sealed under the same `itemsKey`, so they
/// are re-keyed in the same pass: skipping them would leave a removal's
/// quarantined and keep-both revisions undecryptable under the new key.
const REKEY_DIRS: [&str; 5] = [
    "notes",
    "attachments",
    "snapshots",
    "conflicts",
    "quarantine",
];

/// Stage every blob to its `.rekeytmp` sibling. On any failure, delete the
/// temps staged so far and abort with the vault untouched.
async fn stage_all(
    io: &dyn VaultIo,
    staged: &[(PathBuf, Vec<u8>)],
) -> Result<(), MemberRemovalError> {
    let mut written: Vec<PathBuf> = Vec::with_capacity(staged.len());
    for (path, bytes) in staged {
        let tmp = rekey_tmp(path);
        if io.write(&tmp, bytes, WriteOpts::default()).await.is_err() {
            for t in &written {
                let _ = io.remove_file(t).await;
            }
            let _ = io.remove_file(&tmp).await;
            return Err(MemberRemovalError::Io);
        }
        written.push(tmp);
    }
    Ok(())
}

/// Publish every staged blob: copy the temp's bytes to the destination, then
/// drop the temp.
///
/// A failed destination write RE-STAGES the temp before moving on, exactly as
/// `note_txn::publish_staged` does (myne#300): `io.write(path, …)` is
/// `atomic_write`, whose own temp name is `tmp_path(path)` (not ours), so its
/// failure-path cleanup cannot delete `.rekeytmp`; the re-stage makes that
/// explicit and keeps the bytes for the roll-forward. Any failure leaves the
/// journal in place and returns `Err`, so the next unlock republishes.
async fn publish_all(
    io: &dyn VaultIo,
    staged: &[(PathBuf, Vec<u8>)],
) -> Result<(), MemberRemovalError> {
    let mut failed = false;
    for (path, _) in staged {
        let tmp = rekey_tmp(path);
        let bytes = match io.read(&tmp).await {
            Ok(b) => b,
            // The staged bytes are gone (a crash mid-stage). Keep going: the
            // journal stays and the next unlock re-publishes what exists.
            Err(_) => {
                failed = true;
                continue;
            }
        };
        if io.write(path, &bytes, WriteOpts::default()).await.is_err() {
            // Re-stage so the roll-forward has the bytes.
            let _ = io.write(&tmp, bytes.as_slice(), WriteOpts::default()).await;
            failed = true;
            continue;
        }
        let _ = io.remove_file(&tmp).await;
    }
    if failed {
        // Journal deliberately left in place: recovery republishes.
        return Err(MemberRemovalError::Io);
    }
    Ok(())
}

async fn write_journal(
    io: &dyn VaultIo,
    path: &Path,
    new_meta: &[u8],
) -> Result<(), MemberRemovalError> {
    io.write(path, new_meta, WriteOpts::default())
        .await
        .map_err(|_| MemberRemovalError::Io)
}

async fn active_vault_root(
    host: &dyn HostCtx,
    state: &VaultRuntimeState,
) -> Result<PathBuf, MemberRemovalError> {
    let base = host.app_data_dir().map_err(|_| MemberRemovalError::Io)?;
    Ok(crate::paths::active_vault_root_from_base(
        &base,
        state.active_vault_id().await,
    ))
}

fn random_key() -> Result<[u8; AEAD_KEY_LEN], MemberRemovalError> {
    let mut key = [0u8; AEAD_KEY_LEN];
    // No zero check by design: a CSPRNG-uniform 256-bit draw landing on zero
    // is negligible, and the closed error below covers the only real failure
    // (the OS RNG failing), rather than a check that can never fire.
    getrandom::getrandom(&mut key)
        .map(|()| key)
        .map_err(|_| MemberRemovalError::Io)
}

fn parse_uuid(s: &str) -> Option<[u8; 16]> {
    let uuid = uuid::Uuid::parse_str(s).ok()?;
    Some(*uuid.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PARKED: the removal entry point refuses before touching the vault, with
    /// the named error carrying the reason. The vault is untouched — no permit
    /// taken, no slot read, no IO — so this runs against a default (locked,
    /// empty) state on a nonexistent base dir.
    #[test]
    fn removal_is_refused_until_the_roster_wire_ships() {
        use crate::host::test_host::TestHost;
        use crate::test_support::block_on;
        use crate::vault_io::StdVaultIo;

        let host = TestHost::new("/nonexistent-base");
        let state = VaultRuntimeState::default();
        let err = block_on(remove_member_from_host(
            &host,
            &StdVaultIo,
            &state,
            &"ab".repeat(32),
        ))
        .expect_err("removal must refuse while parked");
        assert_eq!(err, MemberRemovalError::RemovalUnavailable);
        assert_eq!(
            err.unavailable_message(),
            Some("Member removal is disabled until the roster wire ships.")
        );
    }

    /// Only `RemovalUnavailable` carries a message; every other failure is
    /// rendered from its kind by the caller.
    #[test]
    fn only_the_parked_refusal_carries_a_message() {
        assert!(MemberRemovalError::VaultLocked
            .unavailable_message()
            .is_none());
        assert!(MemberRemovalError::Busy.unavailable_message().is_none());
    }

    #[test]
    fn parse_uuid_accepts_canonical_hyphenated_and_rejects_junk() {
        // The shape `NoteId::Display` writes: lowercase hyphenated, 36 chars.
        let canonical = "018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a5b";
        let parsed = parse_uuid(canonical).expect("canonical form parses");
        assert_eq!(parsed.len(), 16);
        // Round-trips through the same renderer the filenames use.
        let rendered = uuid::Uuid::from_bytes(parsed).hyphenated().to_string();
        assert_eq!(rendered, canonical);
        assert!(parse_uuid("not-a-uuid").is_none());
        assert!(parse_uuid("").is_none());
    }

    #[test]
    fn parse_hex_rejects_uppercase_and_short() {
        assert!(protocol::hex::decode_lower::<32>(&"ab".repeat(32)).is_some());
        assert!(protocol::hex::decode_lower::<32>(&"AB".repeat(32)).is_none());
        assert!(protocol::hex::decode_lower::<32>("abcd").is_none());
    }

    /// The rekey temp name is OUTSIDE the note/rename grammar, so
    /// `note_txn::is_myn_tmp` never matches it and the rename recovery cannot
    /// delete a committed rekey batch's staging.
    #[test]
    fn rekey_tmp_is_distinct_from_the_note_txn_temp() {
        let p = PathBuf::from("/v/notes/018f2a3b-4c5d-7e6f-8a9b-0c1d2e3f4a5b.myn");
        let rekey = rekey_tmp(&p);
        let txn = crate::atomic_write::tmp_path(&p);
        assert_ne!(rekey, txn, "the two recoverers must not share a temp name");
        assert!(rekey.to_string_lossy().ends_with(".myn.rekeytmp"));
        // `is_myn_tmp` is the rename journal's predicate; it must reject ours.
        let name = rekey.file_name().unwrap().to_string_lossy().to_string();
        assert!(!name.ends_with(".myn.tmp"));
    }

    #[cfg(any(test, feature = "test-support"))]
    #[test]
    fn recovery_rolls_a_committed_batch_forward() {
        use crate::test_support::{block_on, ScopedTempDir};
        use crate::vault_io::StdVaultIo;

        let dir = ScopedTempDir::new("rekey-recovery").expect("tempdir");
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join("notes")).expect("notes dir");
        // A staged blob that has NOT been published, and a journal marking the
        // batch committed.
        std::fs::write(root.join("notes/note.myn.rekeytmp"), b"rekeyed-bytes").expect("stage");
        std::fs::write(root.join(REKEY_JOURNAL), b"new-meta").expect("journal");

        block_on(recover_pending_rekey(&StdVaultIo, &root)).expect("recovery ok");

        assert_eq!(
            std::fs::read(root.join("notes/note.myn")).expect("published"),
            b"rekeyed-bytes"
        );
        assert!(!root.join("notes/note.myn.rekeytmp").exists());
        assert!(!root.join(REKEY_JOURNAL).exists());
        assert_eq!(
            std::fs::read(root.join("vault.meta")).expect("meta written"),
            b"new-meta"
        );
    }

    /// myne-md/myne#797, GAP 1. A member's own unsynced note is wrapped under
    /// the retired `itemsKey`; adopting a rotation without re-keying it makes it
    /// unreadable forever (no server copy). This drives the re-key directly,
    /// through both crash points, and proves the blob moves and recovery is
    /// coherent in each direction.
    #[test]
    fn member_local_rekey_moves_an_unsynced_note_and_recovers_from_a_crash() {
        use crate::test_support::{block_on, ScopedTempDir};
        use crate::vault_io::StdVaultIo;

        block_on(async {
            let dir = ScopedTempDir::new("member-rekey").expect("tempdir");
            let root = dir.path().to_path_buf();
            std::fs::create_dir_all(root.join("notes")).expect("notes dir");
            let old_items = [0x11u8; 32];
            let new_items = [0x22u8; 32];
            let note_uuid = [0xAAu8; 16];
            let note_path = root.join("notes").join(format!(
                "{}.myn",
                uuid::Uuid::from_bytes(note_uuid).hyphenated()
            ));
            let blob = protocol::encode_new_note_blob_raw(
                &old_items,
                &ROT_ITEMS_ID,
                &note_uuid,
                &[0x55u8; 32],
                &[8u8; 24],
                &[9u8; 24],
                b"unsynced-body",
            )
            .expect("note blob");
            std::fs::write(&note_path, &blob).expect("write note");

            // A crash BEFORE the journal (staged, not committed) rolls BACK: the
            // note must still open under the retired key.
            member_rekey_inner(
                &StdVaultIo,
                &root,
                &ROT_ITEMS_ID,
                &old_items,
                &new_items,
                b"member-meta",
                2,
                MemberRekeyFault::StopAfterStage,
                false,
            )
            .await
            .expect_err("staged-only is an aborted batch");
            assert!(!root.join(REKEY_JOURNAL).exists());
            recover_pending_rekey(&StdVaultIo, &root)
                .await
                .expect("roll back");
            let bytes = std::fs::read(&note_path).expect("note read");
            assert!(
                crate::plugins::notes::decode::decode_note_any(
                    &bytes,
                    &note_uuid,
                    &old_items,
                    &ROT_ITEMS_ID
                )
                .is_ok(),
                "an aborted re-key leaves the retired-key blob intact"
            );

            // A crash AFTER the journal rolls FORWARD: the note must open under
            // the NEW key, and the content-epoch marker must record it.
            member_rekey_inner(
                &StdVaultIo,
                &root,
                &ROT_ITEMS_ID,
                &old_items,
                &new_items,
                b"member-meta",
                2,
                MemberRekeyFault::StopAfterJournal,
                false,
            )
            .await
            .expect_err("journal-without-publish is a committed pending batch");
            assert!(root.join(REKEY_JOURNAL).exists());
            recover_pending_rekey(&StdVaultIo, &root)
                .await
                .expect("roll forward");
            let bytes = std::fs::read(&note_path).expect("note read");
            assert!(
                crate::plugins::notes::decode::decode_note_any(
                    &bytes,
                    &note_uuid,
                    &new_items,
                    &ROT_ITEMS_ID
                )
                .is_ok(),
                "recovery republishes the staged blob under the new itemsKey"
            );
            assert!(
                crate::plugins::notes::decode::decode_note_any(
                    &bytes,
                    &note_uuid,
                    &old_items,
                    &ROT_ITEMS_ID
                )
                .is_err(),
                "the retired key no longer opens it"
            );
            assert!(!root.join(REKEY_JOURNAL).exists());

            // The direct success path records the epoch marker (the recovery
            // above cannot: its journal is a non-NTV6 sentinel, which is
            // deliberately not treated as a rotation).
            let dir2 = ScopedTempDir::new("member-rekey-marker").expect("tempdir");
            let root2 = dir2.path().to_path_buf();
            std::fs::create_dir_all(root2.join("notes")).expect("notes dir");
            let uuid2 = [0xBBu8; 16];
            let blob2 = protocol::encode_new_note_blob_raw(
                &old_items,
                &ROT_ITEMS_ID,
                &uuid2,
                &[0x56u8; 32],
                &[0x18u8; 24],
                &[0x19u8; 24],
                b"second-body",
            )
            .expect("note blob");
            std::fs::write(
                root2.join("notes").join(format!(
                    "{}.myn",
                    uuid::Uuid::from_bytes(uuid2).hyphenated()
                )),
                &blob2,
            )
            .expect("write note");
            rekey_local_content_for_member(
                &StdVaultIo,
                &root2,
                &ROT_ITEMS_ID,
                &old_items,
                &new_items,
                b"member-meta",
                2,
            )
            .await
            .expect("re-key commits");
            assert_eq!(
                crate::plugins::sync::state::read_content_epoch(&StdVaultIo, &root2)
                    .await
                    .expect("marker readable"),
                Some(2),
                "the content-epoch marker advanced with the re-key"
            );
        });
    }

    /// A transient I/O error (or a process death) between publishing the re-keyed
    /// blobs and writing the content-epoch marker used to brick the vault: the
    /// next attempt opened the first already-re-keyed blob with the RETIRED key,
    /// answered `CannotDecrypt`, and aborted the whole batch inside the unlock,
    /// where the journal's roll-forward is unreachable (myne-md/myne#797). The
    /// retry must skip what already landed and finish.
    #[test]
    fn a_rekey_retried_after_a_crash_before_the_marker_finishes() {
        use crate::test_support::{block_on, ScopedTempDir};
        use crate::vault_io::StdVaultIo;

        block_on(async {
            let dir = ScopedTempDir::new("member-rekey-retry").expect("tempdir");
            let root = dir.path().to_path_buf();
            std::fs::create_dir_all(root.join("notes")).expect("notes dir");
            let old_items = [0x11u8; 32];
            let new_items = [0x22u8; 32];
            let note_uuid = [0xBBu8; 16];
            let note_path = root.join("notes").join(format!(
                "{}.myn",
                uuid::Uuid::from_bytes(note_uuid).hyphenated()
            ));
            let blob = protocol::encode_new_note_blob_raw(
                &old_items,
                &ROT_ITEMS_ID,
                &note_uuid,
                &[0x55u8; 32],
                &[8u8; 24],
                &[9u8; 24],
                b"unsynced-body",
            )
            .expect("note blob");
            std::fs::write(&note_path, &blob).expect("write note");

            // Published, marker NOT written: the exact torn state.
            member_rekey_inner(
                &StdVaultIo,
                &root,
                &ROT_ITEMS_ID,
                &old_items,
                &new_items,
                b"member-meta",
                2,
                MemberRekeyFault::StopAfterPublish,
                false,
            )
            .await
            .expect_err("simulated crash after publish");
            assert!(
                crate::plugins::sync::state::read_content_epoch(&StdVaultIo, &root)
                    .await
                    .expect("marker readable")
                    .is_none(),
                "the fixture must leave the marker unwritten"
            );

            // The retry must complete rather than fail on the published blob.
            rekey_local_content_for_member(
                &StdVaultIo,
                &root,
                &ROT_ITEMS_ID,
                &old_items,
                &new_items,
                b"member-meta",
                2,
            )
            .await
            .expect("a retry after the torn publish completes");

            assert_eq!(
                crate::plugins::sync::state::read_content_epoch(&StdVaultIo, &root)
                    .await
                    .expect("marker readable"),
                Some(2),
                "and records the epoch"
            );
            let bytes = std::fs::read(&note_path).expect("note read");
            assert!(
                crate::plugins::notes::decode::decode_note_any(
                    &bytes,
                    &note_uuid,
                    &new_items,
                    &ROT_ITEMS_ID
                )
                .is_ok(),
                "the note now opens under the new key"
            );
        });
    }

    // ── Local canonical group rotation (myne-md/myne#712 task 7) ─────────────
    use crate::plugins::vault_unlock::state::UnlockedVault;
    use crate::test_support::{block_on, ScopedTempDir, FAST_TEST_KDF};
    use crate::vault_io::StdVaultIo;
    use protocol::person_invite::{
        GroupKeyContinuity, GroupMemberState, GroupRosterMember, GroupRosterPayload,
        GroupRosterRole,
    };
    use protocol::person_key::PersonKeyPair;

    const ROT_ACCT: [u8; 16] = [0x44; 16];
    const ROT_ITEMS_ID: [u8; 16] = [0x07; 16];
    const ROT_ROOT: [u8; 32] = [0x11; 32];
    /// The person id of the live `vault.member-names` row the rotation fixture seeds,
    /// so a test can address the row it expects to survive.
    const ROT_MEMBER_ID: [u8; 16] = [0x66; 16];
    /// The one enrolled device the fixture binds to the member who is removed. Nothing in
    /// the removal reads it except to carry it into the tombstone, so a fixed value holds
    /// the shape step (5d) acts on.
    const ROT_DEVICE_ID: [u8; 16] = [0x77; 16];

    /// Seal a one-row `vault.member-names` map at `epoch` under `group_key`, through the
    /// family's own codec, so the rotation's re-seal runs against the real shape rather
    /// than a hand-built envelope.
    fn seed_names_blob(
        root: &std::path::Path,
        owner: &PersonKeyPair,
        group_key: &[u8; 32],
        epoch: u64,
        person_id: &[u8; 16],
        name: &str,
    ) {
        let key = protocol::derive_group_subkey_v0_2(
            &protocol::GroupKey::new(*group_key),
            protocol::GroupRole::MemberNamesKey,
        );
        let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
        let row = protocol::sign_member_name(owner, person_id, 1, false, name, &mut rng)
            .expect("sign name row");
        let mut map = protocol::MemberNamesMap::new();
        map.insert(rot_hex(person_id), row);
        let blob = protocol::encode_member_names_blob(&key, &ROT_ACCT, epoch, &map)
            .expect("seal names blob");
        std::fs::write(
            root.join(crate::plugins::member_names::MEMBER_NAMES_FILE),
            blob,
        )
        .expect("write names blob");
    }

    /// A real vault carries a `vault.device-bindings` map too, and step (5d) re-seals it
    /// into the new epoch the same way step (5c) re-seals the names map, with one thing
    /// more: it tombstones every row bound to the removed person, signed by the OWNER.
    /// Without a live row here the rotation's `io.read` hits the `NotFound` arm, writes
    /// nothing, and the step's whole body is unexercised while the test stays green, so
    /// this seeds one device bound to the member who is about to be removed.
    ///
    /// The device id is arbitrary: a real row is keyed by the enrolled device id that
    /// device's own unlock wrote, and nothing in this step reads the id except to carry
    /// it into the tombstone, so a fixed one holds the shape the removal acts on.
    fn seed_bindings_blob(
        root: &std::path::Path,
        claimant: &PersonKeyPair,
        group_key: &[u8; 32],
        epoch: u64,
        person_fingerprint_hex: &str,
        device_id: &[u8; 16],
    ) {
        use protocol::{sign_device_binding, DeviceBindingsMap};
        let key = protocol::derive_group_subkey_v0_2(
            &protocol::GroupKey::new(*group_key),
            protocol::GroupRole::DeviceBindingKey,
        );
        let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
        // Signed by the CLAIMING person, which is the member: a row is only ever accepted
        // against the public half of the person it names, and the owner's signature is
        // accepted on a tombstone alone. A row signed by the owner here would make the
        // `verify_device_binding_removal` assertion below pass for the wrong reason.
        let mut fingerprint = [0u8; protocol::person_key::PERSON_FINGERPRINT_LEN];
        fingerprint.copy_from_slice(
            &protocol::hex::decode_lower::<{ protocol::person_key::PERSON_FINGERPRINT_LEN }>(
                person_fingerprint_hex,
            )
            .expect("a 64-hex fingerprint"),
        );
        let row = sign_device_binding(claimant, device_id, &fingerprint, 1, false, &mut rng)
            .expect("sign binding row");
        let mut map = DeviceBindingsMap::new();
        map.insert(
            crate::plugins::device_binding::store::device_id_hex(device_id),
            row,
        );
        let blob = protocol::encode_device_binding_blob(&key, &ROT_ACCT, epoch, &map)
            .expect("seal bindings blob");
        std::fs::write(
            root.join(crate::plugins::device_binding::DEVICE_BINDINGS_FILE),
            blob,
        )
        .expect("write bindings blob");
    }

    fn rot_pair(seed: u8) -> PersonKeyPair {
        let mut kem = [0u8; protocol::person_key::PERSON_DK_SEED_LEN];
        kem[..32].copy_from_slice(&[seed; 32]);
        kem[32..].copy_from_slice(&[seed ^ 0x5A; 32]);
        PersonKeyPair::generate_raw(
            &kem,
            &[seed.wrapping_add(1); 32],
            &[seed.wrapping_add(2); 32],
        )
    }

    fn rot_hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    fn rot_row(
        pair: &PersonKeyPair,
        role: GroupRosterRole,
        state: GroupMemberState,
        wrapped: Option<String>,
    ) -> GroupRosterMember {
        let public = pair.public_half();
        GroupRosterMember {
            fingerprint_hex: rot_hex(pair.fingerprint()),
            person_id_hex: None,
            display_name: if role == GroupRosterRole::Owner {
                "Owner".into()
            } else {
                "Member".into()
            },
            role,
            state,
            wrapped_group_key_hex: wrapped,
            member_kem_ek_hex: rot_hex(public.kem_ek()),
            member_ed_pk_hex: rot_hex(public.ed_pk()),
            member_mldsa_vk_hex: rot_hex(public.mldsa_vk()),
            previous_fingerprint_hex: None,
            continuity: GroupKeyContinuity::Current,
            transition_hex: None,
        }
    }

    /// `address_packages` joins a package's recipient FINGERPRINT to the new
    /// roster row's `person_id_hex`, and skips a remaining member with no person
    /// account (a row migrated from the pre-B2B roster).
    #[test]
    fn address_packages_keys_each_delivery_on_its_recipient_person_id() {
        let owner = PersonKeyPair::generate_raw(&[0xB1u8; 64], &[0xB2u8; 32], &[0xB3u8; 32]);
        let addressed_member =
            PersonKeyPair::generate_raw(&[0xC1u8; 64], &[0xC2u8; 32], &[0xC3u8; 32]);
        let legacy_member =
            PersonKeyPair::generate_raw(&[0xD1u8; 64], &[0xD2u8; 32], &[0xD3u8; 32]);
        let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
        let group_key = [0x7Au8; 32];
        let p_addressed = protocol::person_invite::create_group_package(
            &owner,
            &addressed_member.public_half(),
            &group_key,
            &ROT_ACCT,
            2,
            &mut rng,
        )
        .expect("package addressed");
        let p_legacy = protocol::person_invite::create_group_package(
            &owner,
            &legacy_member.public_half(),
            &group_key,
            &ROT_ACCT,
            2,
            &mut rng,
        )
        .expect("package legacy");
        let pid = "12".repeat(16);
        let mut roster = GroupRosterPayload {
            account_number_hash_hex: rot_hex(&ROT_ACCT),
            group_key_epoch: 2,
            owner_fingerprint_hex: rot_hex(owner.fingerprint()),
            members: vec![
                rot_row(
                    &addressed_member,
                    GroupRosterRole::Member,
                    GroupMemberState::Live,
                    None,
                ),
                rot_row(
                    &legacy_member,
                    GroupRosterRole::Member,
                    GroupMemberState::Live,
                    None,
                ),
            ],
        };
        // Stamp the server-side person id on ONE remaining member only.
        for m in &mut roster.members {
            if m.fingerprint_hex == rot_hex(addressed_member.fingerprint()) {
                m.person_id_hex = Some(pid.clone());
            }
        }

        let addressed =
            address_packages(vec![p_addressed.clone(), p_legacy], &roster).expect("address");
        assert_eq!(
            addressed.len(),
            1,
            "only the member carrying a person id is addressed"
        );
        assert_eq!(addressed[0].person_id_hex, pid);
        assert_eq!(
            protocol::person_invite::encode_signed_group_package(&addressed[0].package),
            protocol::person_invite::encode_signed_group_package(&p_addressed),
            "the delivered package is the one the rotation built"
        );
    }

    /// Build a real `NTV6` vault at `<base>/data/vaults/<id>/` with one note
    /// sealed under the epoch-1 group-derived `itemsKey` and a roster of owner +
    /// one member, plus the matching owner-held slot.
    async fn seed_ntv6_group_vault(
        base: &std::path::Path,
        owner: &PersonKeyPair,
        member: &PersonKeyPair,
    ) -> (
        crate::vault_id::VaultId,
        PathBuf,
        [u8; 32],
        [u8; 32],
        VaultRuntimeState,
    ) {
        let items_key = [0x31u8; 32];
        let group_key_old = [0x41u8; 32];
        let group_old = protocol::GroupKey::new(group_key_old);

        let mut base_meta = protocol::parse_vault_meta_v0_2(
            &protocol::encode_vault_meta_v0_2_raw(
                &ROT_ROOT,
                &items_key,
                &ROT_ITEMS_ID,
                "pw",
                "abandon abandon abandon",
                &ROT_ACCT,
                &FAST_TEST_KDF,
                &[1u8; 16],
                &[2u8; 16],
                &[3u8; 24],
                &[4u8; 24],
                &[5u8; 24],
            )
            .expect("encode NTV5"),
        )
        .expect("parse NTV5");
        let items_nonce = [6u8; 24];
        let enc_items = protocol::aead_seal_ctx(
            &protocol::derive_group_subkey_v0_2(&group_old, protocol::GroupRole::ItemsKeyWrap),
            &items_nonce,
            &items_key,
            &protocol::aad_vault_items_key_wrap_v0_2(&ROT_ITEMS_ID),
        )
        .expect("seal items");
        base_meta.items_key_nonce = items_nonce;
        base_meta
            .enc_items_key
            .copy_from_slice(&enc_items[..protocol::VAULT_META_WRAPPED_ITEMS_KEY_LEN]);

        let group_nonce = [7u8; 24];
        let enc_group = protocol::aead_seal_ctx(
            &protocol::derive_owner_subkey_v0_2(
                &protocol::OwnerKey::new(ROT_ROOT),
                protocol::OwnerRole::GroupKeyWrap,
            ),
            &group_nonce,
            &group_key_old,
            &protocol::aad_vault_group_key_wrap_v0_2(&ROT_ACCT, 1),
        )
        .expect("seal group");

        let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
        let package = protocol::person_invite::create_group_package(
            owner,
            &member.public_half(),
            &group_key_old,
            &ROT_ACCT,
            1,
            &mut rng,
        )
        .expect("package");
        let package_payload =
            protocol::person_invite::verify_group_package(&owner.public_half(), &package)
                .expect("verify package");
        let roster = GroupRosterPayload {
            account_number_hash_hex: rot_hex(&ROT_ACCT),
            group_key_epoch: 1,
            owner_fingerprint_hex: rot_hex(owner.fingerprint()),
            members: vec![
                rot_row(
                    member,
                    GroupRosterRole::Member,
                    GroupMemberState::Live,
                    Some(package_payload.wrapped_group_key_hex),
                ),
                rot_row(owner, GroupRosterRole::Owner, GroupMemberState::Live, None),
            ],
        };
        let signed_roster =
            protocol::person_invite::sign_group_roster(owner, &roster, &mut rng).expect("sign");
        let meta = protocol::B2bVaultMeta {
            base: base_meta,
            group_key_nonce: group_nonce,
            enc_group_key: enc_group.try_into().expect("64B"),
            group_key_epoch: 1,
            signed_roster_envelope: protocol::person_invite::seal_group_roster(
                &group_key_old,
                &ROT_ACCT,
                1,
                &[0xE7; protocol::AEAD_NONCE_LEN],
                &signed_roster,
            )
            .expect("seal roster"),
        };
        let meta_bytes = protocol::serialize_vault_meta_ntv6(&meta).expect("serialize NTV6");

        let id = crate::vault_id::VaultId::mint();
        // `TestHost::new(base)` resolves app_data_dir to `<base>/data`, so the
        // vault lives under it (mirroring the production layout).
        let root = crate::paths::vault_root_for_id_from_base(&base.join("data"), id);
        std::fs::create_dir_all(root.join("notes")).expect("notes dir");
        std::fs::write(root.join("vault.meta"), &meta_bytes).expect("meta");

        let note_uuid = [0xAAu8; 16];
        let note = protocol::encode_new_note_blob_raw(
            &items_key,
            &ROT_ITEMS_ID,
            &note_uuid,
            &[0x55u8; 32],
            &[8u8; 24],
            &[9u8; 24],
            b"rotated-body",
        )
        .expect("note blob");
        let note_path = root.join("notes").join(format!(
            "{}.myn",
            uuid::Uuid::from_bytes(note_uuid).hyphenated()
        ));
        std::fs::write(&note_path, &note).expect("write note");

        // A real vault carries a `vault.member-names` map, and it is the one shared
        // singleton whose re-seal is NOT the `SHARED_SINGLETONS` loop (`MYO5` is
        // group-tier only and its AAD binds the epoch), so the fixture seeds one at
        // epoch 1. Without it a rotation test would prove nothing about step 5c.
        seed_names_blob(&root, owner, &group_key_old, 1, &ROT_MEMBER_ID, "Member");

        // And the binding map, for step (5d) and for exactly the reason above: the
        // rotation re-seals `MYU5` into the new epoch and tombstones the removed
        // member's rows on the way, and with no row to act on both halves of that step
        // are skipped over a green test.
        seed_bindings_blob(
            &root,
            member,
            &group_key_old,
            1,
            &rot_hex(member.fingerprint()),
            &ROT_DEVICE_ID,
        );

        let state = VaultRuntimeState::default();
        state
            .set_unlocked(
                id,
                UnlockedVault::owner(
                    zeroize::Zeroizing::new(ROT_ROOT),
                    Some(zeroize::Zeroizing::new(group_key_old)),
                    zeroize::Zeroizing::new(items_key),
                    ROT_ITEMS_ID,
                    0,
                    crate::vault_meta_hash::vault_meta_sha256(&meta_bytes),
                ),
            )
            .await;
        (id, root, items_key, group_key_old, state)
    }

    #[test]
    fn group_rotation_tombstones_the_member_and_rewraps_content_under_the_new_key() {
        block_on(async {
            let owner = rot_pair(0x10);
            let member = rot_pair(0x20);
            let base = ScopedTempDir::new("group-rotation").expect("tempdir");
            let (id, root, _old_items, _old_group, state) =
                seed_ntv6_group_vault(base.path(), &owner, &member).await;
            let host = crate::host::test_host::TestHost::new(base.path());

            let out = rotate_group_from_host(
                &host,
                &StdVaultIo,
                &state,
                &owner,
                &rot_hex(member.fingerprint()),
            )
            .await
            .expect("rotation commits");

            assert_eq!(out.new_epoch, 2);
            assert_eq!(out.retirements.len(), 2);
            // `collab-b2b-sessions` task 1: the delivery packages are carried out.
            // This vault's ONLY member is the one removed, so there are none to
            // deliver; `person_invite`'s own rotation test covers the remaining-member
            // case (one package per remaining member, none for the removed one).
            assert!(
                out.packages.is_empty(),
                "a removed member gets no package and no member remains"
            );
            for record in &out.retirements {
                let payload = protocol::person_invite::verify_group_retirement(
                    &owner.public_half(),
                    record,
                    &ROT_ACCT,
                    &ROT_ITEMS_ID,
                )
                .expect("retirement verifies");
                assert_eq!(payload.retired_epoch, 1);
                assert_eq!(payload.replacement_epoch, 2);
            }

            // On-disk meta is NTV6 at epoch 2, member tombstoned, no wrap.
            let meta_bytes = std::fs::read(root.join("vault.meta")).expect("meta");
            assert_eq!(
                meta_bytes.get(..4),
                Some(protocol::VAULT_META_NTV6_MAGIC.as_slice())
            );
            let b2b = protocol::parse_vault_meta_ntv6(&meta_bytes).expect("parse NTV6");
            assert_eq!(b2b.group_key_epoch, 2);
            let rotated_group =
                protocol::unlock_group_key_ntv6(&b2b, &protocol::OwnerKey::new(ROT_ROOT))
                    .expect("group reopens");
            let envelope = protocol::person_invite::open_group_roster(
                &rotated_group,
                &ROT_ACCT,
                b2b.group_key_epoch,
                &b2b.signed_roster_envelope,
            )
            .expect("open sealed roster");
            let roster = protocol::person_invite::verify_group_roster(
                protocol::person_invite::RosterTrust::person_only(&owner.public_half()),
                &envelope,
                &ROT_ACCT,
            )
            .expect("verify roster");
            let removed = roster
                .members
                .iter()
                .find(|m| m.fingerprint_hex == rot_hex(member.fingerprint()))
                .expect("removed row");
            assert_eq!(removed.state, GroupMemberState::Tombstone);
            assert!(removed.wrapped_group_key_hex.is_none());

            // The note is re-wrapped under the NEW itemsKey and still opens with
            // its original uuid and byte-identical plaintext.
            let note_uuid = [0xAAu8; 16];
            let note_path = root.join("notes").join(format!(
                "{}.myn",
                uuid::Uuid::from_bytes(note_uuid).hyphenated()
            ));
            let blob = std::fs::read(&note_path).expect("note");
            let new_root = protocol::unlock_root_key_v0_2_password(&b2b.base, "pw", &ROT_ACCT)
                .expect("root reopens");
            let group = protocol::unlock_group_key_ntv6(&b2b, &protocol::OwnerKey::new(*new_root))
                .expect("group reopens");
            let group_key = protocol::GroupKey::new(*group);
            let new_items =
                protocol::unlock_items_key_ntv6(&b2b, &group_key).expect("items reopens");
            let decoded = crate::plugins::notes::decode::decode_note_any(
                &blob,
                &note_uuid,
                &new_items,
                &ROT_ITEMS_ID,
            )
            .expect("note opens under the rotated key");
            assert_eq!(&decoded[..], b"rotated-body");

            // (5c) `vault.member-names` moved to the new epoch. Asserted through the
            // READER path the app uses (`resolve_names` off the live session), not
            // through a key this test derived for itself: the property that was missing
            // is "the name map is still readable after a removal", and a re-seal that
            // used the wrong key or the wrong epoch would satisfy a self-derived check
            // only if the test reproduced the same mistake.
            let names_path = root.join(crate::plugins::member_names::MEMBER_NAMES_FILE);
            let names_bytes = std::fs::read(&names_path).expect("the names blob is still there");
            let resolved =
                crate::plugins::member_names::commands::resolve_names(&StdVaultIo, &state, &root)
                    .await
                    .expect("the session resolves the names KEK after the rotation");
            assert_eq!(
                resolved.group_key_epoch, out.new_epoch,
                "the session moved to the new epoch"
            );
            let reopened = protocol::decode_member_names_blob(
                &resolved.key,
                &resolved.account_number_hash,
                resolved.group_key_epoch,
                &names_bytes,
            )
            .expect("the re-sealed map opens under the SESSION's key at the new epoch");
            assert!(
                reopened.contains_key(&rot_hex(&ROT_MEMBER_ID)),
                "the row survived the rotation"
            );
            assert_eq!(
                reopened[&rot_hex(&ROT_MEMBER_ID)].name,
                "Member",
                "and its name is intact"
            );
            assert!(
                protocol::decode_member_names_blob(
                    &resolved.key,
                    &resolved.account_number_hash,
                    1,
                    &names_bytes,
                )
                .is_err(),
                "the re-sealed blob must NOT open at the retired epoch: that is what \
                 makes the epoch binding load-bearing"
            );

            // (5d) `vault.device-bindings` moved to the new epoch AND the removed
            // member's row tombstoned, in the one staged write. Asserted here for the
            // reason step (5c) is asserted two blocks up and by the same fixture: a
            // re-seal that used the wrong key or the wrong epoch, or a tombstone signed
            // by the wrong person, satisfies every other check in this test. The
            // fixture seeds one live row bound to the member (`seed_bindings_blob`), so
            // the tombstone half has something to act on.
            let bindings_path = root.join(crate::plugins::device_binding::DEVICE_BINDINGS_FILE);
            let bindings_bytes =
                std::fs::read(&bindings_path).expect("the bindings blob is still there");
            let new_bindings_key = protocol::derive_group_subkey_v0_2(
                &protocol::GroupKey::new(*rotated_group),
                protocol::GroupRole::DeviceBindingKey,
            );
            let rebound = protocol::decode_device_binding_blob(
                &new_bindings_key,
                &ROT_ACCT,
                2,
                &bindings_bytes,
            )
            .expect("the re-sealed map opens under the NEW group key at the new epoch");
            assert!(
                protocol::decode_device_binding_blob(
                    &new_bindings_key,
                    &ROT_ACCT,
                    1,
                    &bindings_bytes,
                )
                .is_err(),
                "and must NOT open at the retired epoch: the epoch is in the AAD"
            );
            let device_key = crate::plugins::device_binding::store::device_id_hex(&ROT_DEVICE_ID);
            let tombstoned = rebound
                .get(&device_key)
                .expect("the row survived the removal");
            assert!(
                tombstoned.tombstone,
                "the removed member's device must be tombstoned: their row is what every \
                 other member's device list would otherwise keep naming them from"
            );
            assert!(
                protocol::verify_device_binding_removal(
                    &owner.public_half(),
                    &ROT_DEVICE_ID,
                    tombstoned,
                ),
                "the removal tombstone carries the OWNER's hybrid signature over the \
                 removed person's fingerprint, which is the only signer the read side \
                 accepts for a row that is not the caller's own"
            );
            assert!(
                !protocol::live_device_bindings(&rebound).contains_key(&device_key),
                "and a tombstone is a merge input rather than a row a device list renders"
            );

            // The running session moved to the new tiers.
            assert_eq!(state.active_vault_id().await, Some(id));
        });
    }

    /// The other half of step (5d), and the one nothing else in this file reaches: a
    /// rotation on a device that holds NO `vault.device-bindings` file.
    ///
    /// `group_rotation_reclaim_sync_ids` retires the family's group-derived sync-id
    /// unconditionally, so the re-seal has to be unconditional too. Skipping it left
    /// the server deleting the retired-epoch blob with nothing staged at the new id,
    /// and every peer still holding a copy sealed at the retired epoch was then stuck:
    /// its bytes no longer open (the AAD binds `group_key_epoch`), so
    /// `read_verified_bindings_bytes` answers `None` for them, so its sync phase
    /// computes itself clean and never replaces the file, and that device's
    /// attribution stayed blank permanently. The assertion is the staged write, not
    /// the absence of an error: an empty map at the NEW epoch is what makes the two
    /// halves land together.
    #[cfg(any(test, feature = "test-support"))]
    #[test]
    fn group_rotation_with_no_local_names_or_bindings_blob_still_reseals_empty_ones() {
        use crate::test_support::{block_on, ScopedTempDir};
        use crate::vault_io::StdVaultIo;

        block_on(async {
            let owner = rot_pair(0x10);
            let member = rot_pair(0x20);
            let base = ScopedTempDir::new("group-rotation-no-bindings").expect("tempdir");
            let (_id, root, _old_items, _old_group, state) =
                seed_ntv6_group_vault(base.path(), &owner, &member).await;
            let host = crate::host::test_host::TestHost::new(base.path());

            // The state this test exists for: this device never claimed itself, holds no
            // bindings file at all, and holds no names file either. Both are the ordinary
            // state of a member who has not yet synced those two families down, and both
            // steps (5c and 5d) retire a sync-id unconditionally, so both owe an empty
            // re-seal on a device that has nothing to re-seal.
            let bindings_path = root.join(crate::plugins::device_binding::DEVICE_BINDINGS_FILE);
            std::fs::remove_file(&bindings_path).expect("the seeded bindings blob is removed");
            let names_path = root.join(crate::plugins::member_names::MEMBER_NAMES_FILE);
            std::fs::remove_file(&names_path).expect("the seeded names blob is removed");

            rotate_group_from_host(
                &host,
                &StdVaultIo,
                &state,
                &owner,
                &rot_hex(member.fingerprint()),
            )
            .await
            .expect("rotation commits");

            let bytes = std::fs::read(&bindings_path)
                .expect("a blob is staged at the new epoch even when none was held");
            let new_group = protocol::unlock_group_key_ntv6(
                &protocol::parse_vault_meta_ntv6(
                    &std::fs::read(root.join("vault.meta")).expect("meta"),
                )
                .expect("parse NTV6"),
                &protocol::OwnerKey::new(ROT_ROOT),
            )
            .expect("group reopens");
            let new_key = protocol::derive_group_subkey_v0_2(
                &protocol::GroupKey::new(*new_group),
                protocol::GroupRole::DeviceBindingKey,
            );
            let map = protocol::decode_device_binding_blob(&new_key, &ROT_ACCT, 2, &bytes)
                .expect("the staged blob opens under the NEW group key at the new epoch");
            assert!(
                map.is_empty(),
                "an absent file and an empty map are the same thing to every reader, so the \
                 staged map carries no rows and resurrects nothing"
            );

            // The member-names family carries the same two halves and the same latent
            // shape, so it is asserted here rather than in a second copy of this test.
            let names_bytes = std::fs::read(&names_path)
                .expect("a names blob is staged at the new epoch even when none was held");
            let new_names_key = protocol::derive_group_subkey_v0_2(
                &protocol::GroupKey::new(*new_group),
                protocol::GroupRole::MemberNamesKey,
            );
            let names =
                protocol::decode_member_names_blob(&new_names_key, &ROT_ACCT, 2, &names_bytes)
                    .expect("the staged names blob opens under the NEW group key at the new epoch");
            assert!(names.is_empty());
        });
    }

    #[cfg(any(test, feature = "test-support"))]
    #[test]
    fn recovery_rolls_an_uncommitted_batch_back() {
        use crate::test_support::{block_on, ScopedTempDir};
        use crate::vault_io::StdVaultIo;

        let dir = ScopedTempDir::new("rekey-recovery").expect("tempdir");
        let root = dir.path().to_path_buf();
        std::fs::create_dir_all(root.join("notes")).expect("notes dir");
        // A stale staged temp with NO journal: the batch never committed.
        std::fs::write(root.join("notes/note.myn.rekeytmp"), b"stale").expect("stage");
        std::fs::write(root.join("notes/live.myn"), b"live").expect("live");

        block_on(recover_pending_rekey(&StdVaultIo, &root)).expect("recovery ok");

        assert!(
            !root.join("notes/note.myn.rekeytmp").exists(),
            "temp deleted"
        );
        assert_eq!(
            std::fs::read(root.join("notes/live.myn")).expect("live intact"),
            b"live"
        );
        assert!(!root.join("notes/note.myn").exists(), "nothing fabricated");
    }

    // The shared-singleton sync-ids are group-derived in an `NTV6` vault, so a
    // rotation moves them. The retired epoch's ids must be queued for reclaim and
    // their baselines dropped, or the next cycle strands the old server records.
    #[test]
    fn a_group_rotation_rebases_the_group_derived_singleton_sync_ids() {
        block_on(async {
            let tmp = ScopedTempDir::new("rotation-rebase").expect("tempdir");
            let io = StdVaultIo;
            let old_group = [0x5Au8; 32];

            // `vault.member-names` (myne-md/myne#851) and `vault.device-bindings`
            // (`MYU5`, myne-md/myne#852) are both in this set. Pinned by NAME rather
            // than by count, because the failure this guards is a family whose id is
            // retired without its blob being re-sealed, and a count would still pass
            // if an unrelated role were swapped in for it.
            for (role, family) in [
                (protocol::GroupRole::PersonalDictSyncId, "vault.dictionary"),
                (protocol::GroupRole::MemberNamesSyncId, "vault.member-names"),
                (
                    protocol::GroupRole::DeviceBindingSyncId,
                    "vault.device-bindings",
                ),
            ] {
                let sub =
                    protocol::derive_group_subkey_v0_2(&protocol::GroupKey::new(old_group), role);
                let mut id = [0u8; 16];
                id.copy_from_slice(&sub[..16]);
                assert!(
                    group_rotation_reclaim_sync_ids(&old_group)
                        .contains(&crate::plugins::sync::to_hex(&id)),
                    "the retired epoch's `{family}` id must be reclaimed, or the removed \
                     member keeps reading the family under the group key they still hold"
                );
            }

            let old_sub = protocol::derive_group_subkey_v0_2(
                &protocol::GroupKey::new(old_group),
                protocol::GroupRole::CatalogSyncId,
            );
            let mut old_id = [0u8; 16];
            old_id.copy_from_slice(&old_sub[..16]);
            let old_hex = crate::plugins::sync::to_hex(&old_id);

            let mut st = crate::plugins::sync::state::SyncState {
                device_id_hex: Some("aa".repeat(16)),
                ..Default::default()
            };
            st.blobs.insert(
                old_hex.clone(),
                crate::plugins::sync::state::BlobSyncState {
                    version: 3,
                    content_nonce_hex: "bb".repeat(24),
                    doc_heads_hex: Vec::new(),
                },
            );
            crate::plugins::sync::state::write_sync_state(&io, tmp.path(), &st)
                .await
                .expect("seed state");

            rebase_sync_plane_for_group_rotation(&io, tmp.path(), &old_group).await;

            let after = crate::plugins::sync::state::read_sync_state(&io, tmp.path())
                .await
                .expect("read state");
            assert!(
                !after.blobs.contains_key(&old_hex),
                "the retired epoch's baseline is dropped"
            );
            assert!(
                after
                    .pending_orphan_tombstones
                    .iter()
                    .any(|t| t.blob_id_hex == old_hex && t.base_version == 3),
                "the retired epoch's id is queued for server reclaim"
            );
        });
    }
}
