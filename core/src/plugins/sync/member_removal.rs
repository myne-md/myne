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

/// The testable core: remove `member_fingerprint_hex` from the active vault.
pub async fn remove_member_from_host(
    host: &dyn HostCtx,
    io: &dyn VaultIo,
    state: &VaultRuntimeState,
    member_fingerprint_hex: &str,
) -> Result<(), MemberRemovalError> {
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
            Zeroizing::new(*uv.root_key),
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
        let rekeyed = rekey_note(
            &blob,
            &note_uuid,
            &items_key_id,
            &old_items_key,
            &new_items_key,
        )?;
        staged.push((path, rekeyed));
    }

    let attachments_dir = vault_root.join("attachments");
    for entry in read_dir_or_absent(io, &attachments_dir).await? {
        if entry.is_dir {
            continue;
        }
        let Some(attachment_id) = parse_hex_32(&entry.name) else {
            continue;
        };
        let path = attachments_dir.join(&entry.name);
        let blob = io.read(&path).await.map_err(|_| MemberRemovalError::Io)?;
        let rekeyed = protocol::person_rekey::rekey_attachment_blob(
            &blob,
            &attachment_id,
            &items_key_id,
            &old_items_key,
            &new_items_key,
            &fresh_nonce()?,
        )
        .map_err(|_| MemberRemovalError::CannotDecrypt)?;
        staged.push((path, rekeyed));
    }

    // Snapshots hold byte-verbatim `MY01`/`NC05` note blobs sealed under the
    // SAME `itemsKey` (`snapshot_store.rs`), so they must be re-wrapped in the
    // same pass: leaving them would destroy version history on the new key and
    // leave the removed member able to decrypt it. The note uuid is the first
    // half of `<note-uuid>__<snapshot-uuid>.myn`.
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
        let rekeyed = rekey_note(
            &blob,
            &note_uuid,
            &items_key_id,
            &old_items_key,
            &new_items_key,
        )?;
        staged.push((path, rekeyed));
    }

    // `conflicts/<id>.myn` (staged keep-both revisions) and
    // `quarantine/<uuid>.myn` (dropped-note ciphertext) hold full note blobs
    // sealed under the SAME `itemsKey`, and both are decrypted with the slot's
    // key, so they MUST be re-wrapped in the same pass: leaving them would make
    // a user's quarantined and conflicted revisions undecryptable the moment a
    // member is removed. Both reuse `rekey_note_blob`; the note uuid is the file
    // stem in each.
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
            let rekeyed = rekey_note(
                &blob,
                &note_uuid,
                &items_key_id,
                &old_items_key,
                &new_items_key,
            )?;
            staged.push((path, rekeyed));
        }
    }

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
    if let Err(e) = crate::plugins::sync::state::mark_vault_meta_dirty(io, &vault_root).await {
        tracing::debug!(stage = "member_removal", error = ?e, "meta-dirty marker write failed");
    }
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    sha2::Digest::update(&mut hasher, &new_meta_bytes);
    let new_hash: [u8; 32] = sha2::Digest::finalize(hasher).into();
    state
        .refresh_meta_hash_if(id, old_meta_hash, new_hash)
        .await;

    Ok(())
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
    for dir in REKEY_DIRS {
        let dir = vault_root.join(dir);
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

fn parse_hex_32(hex: &str) -> Option<[u8; 32]> {
    parse_hex_n::<32>(hex)
}

fn parse_hex_n<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 {
        return None;
    }
    let mut out = [0u8; N];
    for (i, pair) in s.as_bytes().chunks(2).enumerate() {
        let hi = hex_val(pair[0])?;
        let lo = hex_val(pair[1])?;
        out[i] = (hi << 4) | lo;
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(parse_hex_32(&"ab".repeat(32)).is_some());
        assert!(parse_hex_32(&"AB".repeat(32)).is_none());
        assert!(parse_hex_32("abcd").is_none());
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
}
