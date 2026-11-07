// SPDX-License-Identifier: AGPL-3.0
//! Explicit `NTV6` to `NTV7` upgrade: append the person wrap, retire the phrase wrap
//! (myne-md/myne#911 task 10).
//!
//! This is the second explicit, owner-approved format change in the product, and the
//! only one that **destroys a credential**. `NTV7` keeps `NTV6`'s group-key tail
//! byte for byte and changes the credential side: the password wrap stays exactly
//! where it was, the recovery-phrase wrap's three fields are zeroed, and `root_key`
//! is sealed to the owner's person key. The saved vault phrase therefore stops
//! opening the vault the moment this commits, which is why the surface warns before
//! it runs and why nothing here is triggered by an unlock (`protocol.md` §10.4).
//!
//! **One atomic write, no journal.** Unlike [`super::b2b`], which reseals every
//! shared singleton and so needs a durable roll-forward record, this step writes
//! exactly one file. [`VaultIo::write`] is an atomic replace, so a failure leaves
//! the previous `vault.meta` in place with no partial state to recover: either the
//! vault still has its phrase wrap or it has the person wrap, never both.
//!
//! **The phrase wrap is zeroed here, at this call site.** It is deliberately not a
//! protocol helper: a function that zeroed a base's recovery wrap on request could
//! be pointed at a live vault by any other caller, and the serializer's own refusal
//! of a live phrase wrap is what keeps a half-migrated blob from parsing. The three
//! assignments below are the only place in the tree that intentionally discards a
//! recovery credential.
//!
//! **The owner binding is verified before anything is written.** The roster sealed
//! inside the frame names the owner, and the person wrap is sealed to whatever
//! public half the caller supplies. Sealing it to a person the roster does not name
//! would produce a vault whose only second credential belongs to somebody else, and
//! nothing on disk would say so. [`protocol::person_invite::verify_group_roster`]
//! checks both signature halves against that public half and that the payload's
//! owner fingerprint is that half's fingerprint, so the check is the same one every
//! member package already uses rather than a second opinion.

use crate::host::HostCtx;
use crate::vault_io::{VaultIo, WriteOpts};
use protocol::person_key::PersonPublicHalf;
use sha2::{Digest, Sha256};
use std::path::Path;
use zeroize::Zeroizing;

/// Failure of the `NTV7` upgrade. Serde-serialized to the IPC surface
/// (`#[serde(tag = "kind")]`), one variant per remedy the UI can offer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind")]
pub enum Ntv7UpgradeError {
    /// The vault already carries the `NTV7` magic. Idempotent, nothing written.
    AlreadyUpgraded,
    /// The vault is a pre-v0.2 (`MYV1`) vault. The whole-vault v0.1 → v0.2
    /// migration owns that hop; this command never re-keys content.
    MigrationRequired,
    /// `vault.meta` is unreadable, truncated, or not a generation this can carry.
    InvalidVaultMeta,
    /// The group-key package, the roster envelope or a seal did not open. A
    /// tampered frame fails here rather than producing a frame we would write.
    CannotDecrypt,
    /// The person the caller wants to seal to is not the roster's owner.
    PersonMismatch,
    /// This device holds no person identity (no `person-auth.json`, or one whose
    /// public halves are empty). The remedy is creating an identity, not retrying.
    PersonRequired,
    /// An identity exists but its keypair is not in the session, and this path
    /// needs it (an `NTV5` source must SIGN its first roster).
    IdentityLocked,
    /// The caller is a member of this vault. A member does not author the
    /// credential side of an owner-signed frame.
    NotOwner,
    /// The vault has been shared with at least one other person. The
    /// person-wrapped generation carries the B2B tail but the member plane
    /// (invite, removal, rotation adoption) is not taught to write it yet, so
    /// upgrading a shared vault would leave every member on a frame nothing can
    /// re-author. Refused rather than half-supported (myne-md/myne#911 review).
    SharedVault,
    /// No vault is open. `root_key` is the sealed plaintext; there is no other way
    /// to produce the envelope.
    NotUnlocked,
    /// The CSPRNG was unavailable.
    Csprng,
    /// A filesystem read or write failed. The previous metadata is intact.
    Io,
    /// Another auth-pipeline operation is in flight (myne-md/myne#434). Reject,
    /// never queue.
    AuthOperationInProgress,
}

/// The committed generation's summary, as the frontend sees it. Carries no key
/// material.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Ntv7UpgradeView {
    /// The generation the frame was upgraded FROM (`"NTV5"` or `"NTV6"`).
    pub upgraded_from: &'static str,
    /// The group-key epoch the committed frame carries.
    pub group_key_epoch: u64,
}

/// The generation a frame on disk carries, as far as this command cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceGeneration {
    /// v0.2 owner-only metadata. Needs the B2B migration first.
    Ntv5,
    /// v0.2 B2B metadata. Directly upgradable.
    Ntv6,
    /// Already the person-wrapped generation.
    Ntv7,
}

/// Read the generation of `vault.meta` bytes without parsing the rest.
pub fn source_generation(meta_bytes: &[u8]) -> Result<SourceGeneration, Ntv7UpgradeError> {
    match meta_bytes.get(..4) {
        Some(magic) if magic == protocol::VAULT_META_NTV6_MAGIC.as_slice() => {
            Ok(SourceGeneration::Ntv6)
        }
        Some(magic) if magic == protocol::VAULT_META_NTV7_MAGIC.as_slice() => {
            Ok(SourceGeneration::Ntv7)
        }
        Some(magic) if magic == protocol::VAULT_META_V0_2_MAGIC.as_slice() => {
            Ok(SourceGeneration::Ntv5)
        }
        // `MYV1` is a real vault that needs the whole-vault migration; anything
        // else is not a frame this reader knows.
        Some(magic) if magic == protocol::VAULT_META_MAGIC.as_slice() => {
            Err(Ntv7UpgradeError::MigrationRequired)
        }
        _ => Err(Ntv7UpgradeError::InvalidVaultMeta),
    }
}

/// What a committed upgrade changed, so the caller can refresh its own anchors.
#[derive(Debug)]
pub struct Ntv7UpgradeOutput {
    /// SHA-256 of the committed `NTV7` bytes. The caller must move its in-memory
    /// CAS anchor to this hash, or the next `change_password` reads this write as
    /// external tampering.
    pub new_meta_hash: [u8; 32],
    /// The group-key epoch the committed frame carries. Read from the frame this
    /// function just built, so the caller does not re-read the file to report it.
    pub group_key_epoch: u64,
}

/// Append the person wrap to an `NTV6` vault and zero its phrase wrap.
///
/// `owner_public` is the owner's person public half, which the device already
/// holds in `person-auth.json`, so this needs no unlocked person session for an
/// `NTV6` source. An `NTV5` source is refused with
/// [`Ntv7UpgradeError::MigrationRequired`] because its group-key tail does not
/// exist yet; the command chains [`super::b2b`] first, which DOES need the private
/// half to sign the first roster.
///
/// Writes once. A failure leaves the previous bytes in place.
pub async fn upgrade_vault_to_ntv7(
    io: &dyn VaultIo,
    vault_root: &Path,
    root_key: &[u8; 32],
    owner_public: &PersonPublicHalf,
) -> Result<Ntv7UpgradeOutput, Ntv7UpgradeError> {
    let meta_path = vault_root.join("vault.meta");
    let meta_bytes = io
        .read(&meta_path)
        .await
        .map_err(|_| Ntv7UpgradeError::Io)?;
    match source_generation(&meta_bytes)? {
        SourceGeneration::Ntv7 => return Err(Ntv7UpgradeError::AlreadyUpgraded),
        SourceGeneration::Ntv5 => return Err(Ntv7UpgradeError::MigrationRequired),
        SourceGeneration::Ntv6 => {}
    }

    let ntv6 = protocol::parse_vault_meta_ntv6(&meta_bytes)
        .map_err(|_| Ntv7UpgradeError::InvalidVaultMeta)?;
    let account_hash = ntv6.base.account_number_hash;

    // 1. The roster's owner must be the person we are about to seal to. This
    //    opens the group-key package and the roster envelope, so a tampered frame
    //    is refused before any write rather than carried forward.
    let group_key = protocol::unlock_group_key_ntv6(&ntv6, &protocol::OwnerKey::new(*root_key))
        .map_err(|_| Ntv7UpgradeError::CannotDecrypt)?;
    let signed_roster = protocol::person_invite::open_group_roster(
        &group_key,
        &account_hash,
        ntv6.group_key_epoch,
        &ntv6.signed_roster_envelope,
    )
    .ok_or(Ntv7UpgradeError::CannotDecrypt)?;
    let roster = protocol::person_invite::verify_group_roster(
        protocol::person_invite::RosterTrust::person_only(owner_public),
        &signed_roster,
        &account_hash,
    )
    .map_err(|_| Ntv7UpgradeError::PersonMismatch)?;

    // A shared vault is refused, and the reason is a ROLLOUT one rather than a
    // capability one. The member plane now reads and writes the person generation
    // (invite, accept, removal and the two member-writable families all read the
    // tail through `parse_b2b_tail_any`), so the frame itself would be fine. What is
    // not fine is the fleet: a client that predates `NTV7` REJECTS the magic outright
    // (`protocol.md` §10.3, by design), and a shared vault's members are other
    // people's devices, which this operator does not upgrade. Changing the
    // generation under a live second person would therefore take their vault away
    // until each of them updates.
    //
    // The count is LIVE rows only, and the owner is one of them. Counting
    // `members.len()` made a vault that was shared and then un-shared permanently
    // un-upgradable: a removed member keeps a `Tombstone` row, which is the normal
    // post-removal shape (`member_removal` asserts it), so a legitimately
    // owner-only vault was refused "this vault is shared" with no remedy
    // (myne-md/myne#911 review). Every other reader of this payload filters first.
    let live_others = roster
        .members
        .iter()
        .filter(|m| m.state == protocol::person_invite::GroupMemberState::Live)
        .count()
        .saturating_sub(1);
    if live_others > 0 {
        return Err(Ntv7UpgradeError::SharedVault);
    }

    // 2. Retire the phrase wrap. The only intentional discard of a recovery
    //    credential in the tree; see the module docs for why it lives here.
    let mut base = ntv6.base.clone();
    base.random_salt_recovery = [0u8; protocol::VAULT_META_SALT_RANDOM_LEN];
    base.nonce_recovery_wrap = [0u8; protocol::AEAD_NONCE_LEN];
    base.enc_root_key_recovery = [0u8; protocol::VAULT_META_WRAPPED_ROOT_KEY_LEN];

    // 3. Seal root_key to the owner's person key.
    let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
    let person_wrap =
        protocol::seal_root_key_to_person_raw(owner_public, root_key, &base.items_key_id, &mut rng)
            .map_err(|_| Ntv7UpgradeError::CannotDecrypt)?;

    let group_key_epoch = ntv6.group_key_epoch;
    let frame = protocol::PersonWrappedVaultMeta {
        base,
        group_key_nonce: ntv6.group_key_nonce,
        enc_group_key: ntv6.enc_group_key,
        group_key_epoch,
        signed_roster_envelope: ntv6.signed_roster_envelope,
        person_wrap,
    };
    let bytes = protocol::serialize_vault_meta_ntv7(&frame)
        .map_err(|_| Ntv7UpgradeError::InvalidVaultMeta)?;
    io.write(&meta_path, &bytes, WriteOpts::default())
        .await
        .map_err(|_| Ntv7UpgradeError::Io)?;
    Ok(Ntv7UpgradeOutput {
        new_meta_hash: Sha256::digest(&bytes).into(),
        group_key_epoch,
    })
}

/// Drop the person wrap the explicit upgrade just wrote, and answer the hash the
/// runtime's CAS anchor must move to (myne-md/myne#938, `decisions/protocol/0758`).
///
/// `NTV7` is never written again as a TERMINAL state, so the frame this command
/// leaves behind is `NTV8`. Without this step the row would commit an `NTV7`
/// frame, whose phrase still opens the vault, so the copy above the button would
/// be wrong from the moment it succeeded until the next unlock truncated it; the
/// identity-phrase door would also reappear on the unlock screen for that window,
/// because `vault_is_person_wrapped` answers on the magic.
///
/// The truncation is [`super::ntv8::upgrade_vault_to_ntv8`], the same code the
/// unlock tail runs, so the format move has one implementation. A FAILURE is
/// swallowed here, deliberately, and it is the opposite call from the
/// `mark_vault_meta_dirty` one in the caller: a swallowed marker error leaves a
/// state nothing retries, whereas a swallowed truncation leaves a perfectly good
/// `NTV7` vault that opens with its password and is upgraded on its next unlock.
/// The user's request ("retire my vault phrase") is then only partially delivered
/// for one session, which is worth a warning and not worth failing a command whose
/// durable work already landed.
///
/// The returned hash is the bytes ON DISK after this call in both arms, so the
/// caller moves the anchor exactly once (`current_hash` to this) instead of twice,
/// where the first move would land on a hash nothing matches.
async fn truncate_after_explicit_upgrade(
    io: &dyn VaultIo,
    meta_path: &Path,
    ntv7_hash: [u8; 32],
) -> [u8; 32] {
    match super::ntv8::upgrade_vault_to_ntv8(io, meta_path).await {
        Ok(Some(done)) => {
            // The same coarse event the unlock tail emits: one trace line per
            // generation move, whichever path performed it.
            tracing::info!(
                event = "vault_meta_upgraded",
                from = "NTV7",
                to = "NTV8",
                group_key_epoch = done.group_key_epoch,
                "dropped the person wrap of root_key on the explicit upgrade"
            );
            done.new_meta_hash
        }
        // Unreachable by construction, since the caller just wrote an `NTV7`
        // frame. A real arm rather than an `expect`, because a panic in a command
        // that has already written the vault is worse than a stale hash.
        Ok(None) => ntv7_hash,
        Err(error) => {
            tracing::warn!(
                error = ?error,
                "the vault phrase was retired but the person wrap was not dropped; the next unlock retries"
            );
            ntv7_hash
        }
    }
}

/// **Upgrade the open vault to `NTV7`** (myne-md/myne#911 task 10).
///
/// The only IPC entry point. Desktop-only for now: mobile and web have no person
/// plane until tasks 12 and 13, and the surface that offers this lives in desktop
/// Settings.
///
/// Gated exactly as the other command wrappers are (`vault_unlock/commands.rs`):
/// `myne-core` compiles without the `tauri-ipc` feature for the wasm entry crate,
/// where the `tauri` crate is not in the graph at all.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub async fn vault_upgrade_to_ntv7<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: tauri::State<'_, crate::plugins::vault_unlock::state::VaultRuntimeState>,
) -> Result<Ntv7UpgradeView, Ntv7UpgradeError> {
    upgrade_vault_to_ntv7_from_host(
        &crate::host::tauri_host::TauriHost::new(app),
        state.inner(),
        &crate::vault_io::StdVaultIo,
    )
    .await
}

/// Host-taking core for [`vault_upgrade_to_ntv7`], so tests drive the whole
/// upgrade under a temp vault with no Tauri runtime.
///
/// `NTV5` sources are chained: the owner B2B migration runs first (it mints the
/// group key and signs the roster), then the person wrap is appended. That is two
/// atomic writes of their own, not one transaction, by design: a crash between
/// them leaves a working `NTV6` vault whose phrase still opens it, and re-running
/// the command finishes the job.
pub async fn upgrade_vault_to_ntv7_from_host(
    host: &dyn HostCtx,
    state: &crate::plugins::vault_unlock::state::VaultRuntimeState,
    io: &dyn VaultIo,
) -> Result<Ntv7UpgradeView, Ntv7UpgradeError> {
    use crate::plugins::vault_unlock::state::{Slot, VaultAuthority};

    // Peek the slot, then drop the guard before any await (the tokio RwLock
    // deadlock shape documented on `sync_invite_member`).
    let (root_key, items_key, authority) = {
        let slot = state.slot_read_active().await;
        match &*slot {
            Slot::Unlocked(uv) => {
                let authority = uv.authority();
                let root_key = uv
                    .owner_root_key()
                    .map(|key| Zeroizing::new(**key))
                    .ok_or(Ntv7UpgradeError::NotOwner)?;
                let items_key = Zeroizing::new(*uv.items_key);
                (root_key, items_key, authority)
            }
            _ => return Err(Ntv7UpgradeError::NotUnlocked),
        }
    };
    if matches!(authority, VaultAuthority::Member) {
        return Err(Ntv7UpgradeError::NotOwner);
    }

    // The owner's public half must be the one the user's CURRENT phrase derives,
    // so it comes from the SESSION pair and nowhere else (myne-md/myne#911
    // review). Reading it from `person-auth.json` looked convenient, because it is
    // readable while the identity session is locked, and it is wrong: a pre-`0604`
    // CSPRNG keypair is MIGRATED to the deterministic one on its first phrase
    // unlock (`account::person_identity::migrate_pair`), which rewrites
    // `person-auth.json` and moves the fingerprint. The person wrap's AAD binds
    // that fingerprint, so a frame sealed to the old halves opens under no key the
    // user can ever produce again, and the vault still unlocks with its password,
    // so nothing looks wrong until the day the password is gone. Requiring the
    // session costs the user one phrase entry and closes that window.
    let owner_public = state
        .clone_person_identity()
        .await
        .ok_or(Ntv7UpgradeError::IdentityLocked)?
        .public_half();

    let vault_id = state.active_vault_id().await;
    let root = crate::paths::active_vault_root_from_base(
        &host.app_data_dir().map_err(|_| Ntv7UpgradeError::Io)?,
        vault_id,
    );
    let meta_path = root.join("vault.meta");

    // The whole-blob rewrite is a lifecycle mutation: hold the permit across it so
    // a concurrent `change_password` cannot land between the read and the commit.
    let _permit = state
        .auth_permits()
        .try_acquire()
        .map_err(|_| Ntv7UpgradeError::AuthOperationInProgress)?;

    let before = io
        .read(&meta_path)
        .await
        .map_err(|_| Ntv7UpgradeError::Io)?;
    let generation = source_generation(&before)?;
    if generation == SourceGeneration::Ntv7 {
        return Err(Ntv7UpgradeError::AlreadyUpgraded);
    }

    // An `NTV5` source has no group-key tail, so the owner B2B migration has to
    // run first. It needs the PRIVATE half to sign the first roster, which is the
    // one place this command asks for an unlocked identity.
    let mut upgraded_from = "NTV6";
    if generation == SourceGeneration::Ntv5 {
        let owner = state
            .clone_person_identity()
            .await
            .ok_or(Ntv7UpgradeError::IdentityLocked)?;
        let owner_person_id = state
            .clone_person_id()
            .await
            .ok_or(Ntv7UpgradeError::IdentityLocked)?;
        let old_hash = crate::vault_meta_hash::vault_meta_sha256(&before);
        let out = crate::plugins::vault_migrate::b2b::migrate_owner_vault_to_ntv6(
            io,
            &root,
            &root_key,
            &items_key,
            &owner,
            &owner_person_id,
            // The owner's own row carries an empty display name at birth too
            // (vault creation writes `String::new()`); a name is set later from
            // `vault.member-names`, which has no group tier to write into before
            // this migration.
            "",
        )
        .await
        .map_err(map_b2b_error)?;
        if let Some(id) = vault_id {
            state
                .refresh_meta_hash_if(id, old_hash, out.new_meta_hash)
                .await;
            state.set_group_key(id, out.group_key).await;
        }
        // The head format moves to `0x02` signed with the generation, so the next
        // cycle must re-base rather than reject the server's still-HMAC head as a
        // forgery (`decisions/protocol/0603`).
        let _ = crate::plugins::sync::state::arm_rekey_rebase(io, &root).await;
        // The vault is `NTV6` now: seal the person-identity carrier under the held
        // root_key so a later unlock installs the session with no phrase
        // (myne-md/myne#792). Best-effort, and NATIVE-ONLY: the carrier module is
        // `#[cfg(not(target_arch = "wasm32"))]` because a browser has no keychain
        // to seal it under, and this function still compiles for wasm32 even
        // though the web refuses the command (`vault-migrate` is
        // `Class::Unsupported` there).
        #[cfg(not(target_arch = "wasm32"))]
        if let Some(person_id) = state.clone_person_id().await {
            crate::plugins::sync::person_vault_carrier::refresh_carrier_best_effort(
                host, io, state, &person_id, &owner,
            )
            .await;
        }
        upgraded_from = "NTV5";
    }

    // Re-read: after a chained B2B migration the bytes on disk are the `NTV6` frame
    // this step consumes, and its hash is what the CAS anchor currently holds.
    let current = io
        .read(&meta_path)
        .await
        .map_err(|_| Ntv7UpgradeError::Io)?;
    let current_hash = crate::vault_meta_hash::vault_meta_sha256(&current);
    let out = upgrade_vault_to_ntv7(io, &root, &root_key, &owner_public).await?;
    let group_key_epoch = out.group_key_epoch;
    let new_meta_hash = truncate_after_explicit_upgrade(io, &meta_path, out.new_meta_hash).await;

    if let Some(id) = vault_id {
        state
            .refresh_meta_hash_if(id, current_hash, new_meta_hash)
            .await;
        // **Delete the carrier, if one exists (myne-md/myne#911 review).** The
        // chained `NTV5` step above writes one deliberately, and an earlier unlock
        // may have written one too. On an `NTV7` vault that file is a cross-vault
        // key escalation rather than a convenience: the frame already seals
        // `root_key` to the person key, so a carrier sealed under this vault's
        // `root_key` lets one vault's password (or a PIN that yields it) unwrap the
        // person keypair and from it every other owned vault's `root_key`, offline.
        // `carrier_applies` refuses to USE one for a Person frame, but the file
        // itself is sealed under `root_key` alone, so only deleting it closes the
        // path for someone reading the disk directly. It is deleted even though the
        // command now finishes on `NTV8`, where there is no person wrap to escalate
        // through: a carrier is a device-local copy of the person keypair that no
        // generation needs once the vault opens with its password alone, and leaving
        // one behind would be a copy kept for no reader.
        #[cfg(not(target_arch = "wasm32"))]
        crate::plugins::sync::person_vault_carrier::delete_person_vault_carrier(
            host,
            io,
            id.as_uuid().as_bytes(),
        )
        .await;
    }
    // The new frame has to REACH the other devices, and nothing else will push it:
    // the sync loop's meta phase pushes only when `allow_push` (a content edit
    // advanced the counter) or when this marker is set (myne#293). The upgrade
    // edits no note, so without the marker the server keeps the old frame, every
    // other device keeps accepting the retired vault phrase, and the warning this
    // command shows ("every device must be updated first") would describe a state
    // that never arrives.
    //
    // A failure here FAILS the command (myne-md/myne#911 review). The comment used
    // to call this best-effort "like `change_password`", but nothing retries it:
    // re-running the command answers `AlreadyUpgraded` before reaching this line,
    // so a swallowed error leaves exactly the state §10.4.2 point 6 forbids while
    // the UI reports success. Making it a failure is recoverable and honest: the
    // frame is already written, and the retry re-enters at the marker.
    crate::plugins::sync::state::mark_vault_meta_dirty(io, &root)
        .await
        .map_err(|_| Ntv7UpgradeError::Io)?;
    Ok(Ntv7UpgradeView {
        upgraded_from,
        group_key_epoch,
    })
}

/// One mapping for the chained B2B step, so the UI sees this command's closed
/// union rather than a nested one.
fn map_b2b_error(error: crate::plugins::vault_migrate::b2b::B2bMigrationError) -> Ntv7UpgradeError {
    use crate::plugins::vault_migrate::b2b::B2bMigrationError as B2b;
    match error {
        B2b::AlreadyMigrated => Ntv7UpgradeError::AlreadyUpgraded,
        B2b::MigrationRequired => Ntv7UpgradeError::MigrationRequired,
        B2b::InvalidVaultMeta => Ntv7UpgradeError::InvalidVaultMeta,
        B2b::CannotDecrypt => Ntv7UpgradeError::CannotDecrypt,
        B2b::Csprng => Ntv7UpgradeError::Csprng,
        B2b::Io => Ntv7UpgradeError::Io,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{block_on, ScopedTempDir};
    use crate::vault_io::StdVaultIo;
    use protocol::KdfParams;

    const FAST_KDF: KdfParams = KdfParams {
        m_kib: 8,
        t: 1,
        p: 1,
        argon2_version: 0x13,
    };

    /// The owner fixture. Both halves must come from the same seed, because the
    /// roster is signed with the private half and verified against the public one.
    fn owner() -> protocol::PersonKeyPair {
        protocol::PersonKeyPair::generate_raw(&[1u8; 64], &[2u8; 32], &[3u8; 32])
    }

    fn other_person() -> protocol::PersonKeyPair {
        protocol::PersonKeyPair::generate_raw(&[9u8; 64], &[8u8; 32], &[7u8; 32])
    }

    /// A pre-upgrade `NTV5` vault on disk, built with the protocol's own raw
    /// encoder so the fixture cannot drift from the layout.
    fn fixture_ntv5(root: &Path, root_key: &[u8; 32], items: &[u8; 32], account: &[u8; 16]) {
        let bytes = protocol::encode_vault_meta_v0_2_raw(
            root_key,
            items,
            &[3u8; 16],
            "password",
            "abandon abandon abandon",
            account,
            &FAST_KDF,
            &[2u8; protocol::ARGON2_SALT_LEN],
            &[4u8; protocol::ARGON2_SALT_LEN],
            &[5u8; protocol::AEAD_NONCE_LEN],
            &[6u8; protocol::AEAD_NONCE_LEN],
            &[8u8; protocol::AEAD_NONCE_LEN],
        )
        .expect("fixture NTV5");
        std::fs::write(root.join("vault.meta"), bytes).expect("meta");
    }

    /// An `NTV6` vault: the fixture above pushed through the real B2B migration.
    async fn fixture_ntv6(dir: &ScopedTempDir, root_key: &[u8; 32], items: &[u8; 32]) {
        fixture_ntv5(dir.path(), root_key, items, &[1u8; 16]);
        crate::plugins::vault_migrate::b2b::migrate_owner_vault_to_ntv6(
            &StdVaultIo,
            dir.path(),
            root_key,
            items,
            &owner(),
            &[0x11u8; 16],
            "Owner",
        )
        .await
        .expect("b2b migration");
    }

    /// The explicit upgrade's TERMINAL frame is `NTV8`, and the hash it hands the
    /// CAS anchor is the one on disk (myne-md/myne#938).
    ///
    /// Three claims, each a way the chain can be wrong while every other test stays
    /// green. If the truncation is not chained, the vault keeps a person wrap and
    /// its phrase still opens it. If the hash returned is the `NTV7` frame's,
    /// `refresh_meta_hash_if` matches nothing and the runtime pushes a stale
    /// `vault.meta` on the next cycle. And if a re-run moved the anchor again, a
    /// caller retrying after a crash would point it at bytes no longer on disk.
    #[test]
    fn the_explicit_upgrade_commits_ntv8_and_returns_the_hash_of_what_it_wrote() {
        block_on(async {
            let dir = ScopedTempDir::new("ntv7-then-ntv8").expect("tempdir");
            let root_key = [7u8; 32];
            let items = [9u8; 32];
            fixture_ntv6(&dir, &root_key, &items).await;

            // The primitive still writes `NTV7`: it is the intermediate frame, and
            // the truncation consumes it.
            let intermediate =
                upgrade_vault_to_ntv7(&StdVaultIo, dir.path(), &root_key, &owner().public_half())
                    .await
                    .expect("upgrade to ntv7");
            let ntv7_bytes = std::fs::read(dir.path().join("vault.meta")).expect("meta");
            assert_eq!(&ntv7_bytes[..4], protocol::VAULT_META_NTV7_MAGIC.as_slice());
            assert_eq!(
                intermediate.new_meta_hash,
                <[u8; 32]>::from(Sha256::digest(&ntv7_bytes)),
                "the intermediate hash must be the intermediate frame's, or the fixture is lying"
            );

            let meta_path = dir.path().join("vault.meta");
            let committed = truncate_after_explicit_upgrade(
                &StdVaultIo,
                &meta_path,
                intermediate.new_meta_hash,
            )
            .await;

            let after = std::fs::read(&meta_path).expect("meta");
            assert_eq!(
                &after[..4],
                protocol::VAULT_META_NTV8_MAGIC.as_slice(),
                "the explicit upgrade must not leave an NTV7 frame behind"
            );
            assert_eq!(
                committed,
                <[u8; 32]>::from(Sha256::digest(&after)),
                "the hash handed to the CAS anchor must be the bytes on disk"
            );
            assert_ne!(
                committed, intermediate.new_meta_hash,
                "returning the NTV7 hash would leave the anchor on a frame nothing wrote"
            );

            // No person wrap, so the phrase has nothing to open: the claim the copy
            // above the button now makes.
            let frame = protocol::parse_vault_meta_ntv8(&after).expect("ntv8");
            let opened = protocol::unlock_root_key_v0_2_password(
                &frame.base,
                "password",
                &frame.base.account_number_hash,
            )
            .expect("password unlock");
            assert_eq!(&*opened, &root_key);
            assert_eq!(
                frame.base.enc_root_key_recovery,
                [0u8; protocol::VAULT_META_WRAPPED_ROOT_KEY_LEN]
            );

            // A second call has nothing to do and must not move the anchor: it
            // answers the hash it was handed, which is what a retry after a crash
            // relies on.
            let again = truncate_after_explicit_upgrade(&StdVaultIo, &meta_path, committed).await;
            assert_eq!(again, committed);
            let unchanged = std::fs::read(&meta_path).expect("meta");
            assert_eq!(unchanged, after, "an already-NTV8 vault is not rewritten");
        });
    }

    #[test]
    fn upgrade_appends_the_person_wrap_and_retires_the_phrase() {
        block_on(async {
            let dir = ScopedTempDir::new("ntv7-upgrade").expect("tempdir");
            let root_key = [7u8; 32];
            let items = [9u8; 32];
            fixture_ntv6(&dir, &root_key, &items).await;

            let before = std::fs::read(dir.path().join("vault.meta")).expect("meta");
            let before_ntv6 = protocol::parse_vault_meta_ntv6(&before).expect("ntv6");
            assert_ne!(
                before_ntv6.base.enc_root_key_recovery,
                [0u8; protocol::VAULT_META_WRAPPED_ROOT_KEY_LEN],
                "the fixture must carry a live phrase wrap, or this test proves nothing"
            );

            let out =
                upgrade_vault_to_ntv7(&StdVaultIo, dir.path(), &root_key, &owner().public_half())
                    .await
                    .expect("upgrade");

            let after = std::fs::read(dir.path().join("vault.meta")).expect("meta");
            assert_eq!(&after[..4], protocol::VAULT_META_NTV7_MAGIC.as_slice());
            let hash: [u8; 32] = Sha256::digest(&after).into();
            assert_eq!(out.new_meta_hash, hash);

            let frame = protocol::parse_vault_meta_ntv7(&after).expect("ntv7");
            assert_eq!(
                frame.base.random_salt_recovery,
                [0u8; protocol::VAULT_META_SALT_RANDOM_LEN]
            );
            assert_eq!(
                frame.base.nonce_recovery_wrap,
                [0u8; protocol::AEAD_NONCE_LEN]
            );
            assert_eq!(
                frame.base.enc_root_key_recovery,
                [0u8; protocol::VAULT_META_WRAPPED_ROOT_KEY_LEN]
            );
            // The group tier is carried over byte for byte.
            assert_eq!(frame.enc_group_key, before_ntv6.enc_group_key);
            assert_eq!(
                frame.signed_roster_envelope,
                before_ntv6.signed_roster_envelope
            );

            // The password still opens it, byte for byte.
            let opened = protocol::unlock_root_key_v0_2_password(
                &frame.base,
                "password",
                &frame.base.account_number_hash,
            )
            .expect("password unlock");
            assert_eq!(&*opened, &root_key);

            // The owner's keypair opens the person wrap, and only that keypair.
            let opened_person = protocol::open_person_wrapped_root_key(
                &owner(),
                &frame.person_wrap,
                &frame.base.items_key_id,
            )
            .expect("person wrap");
            assert_eq!(&*opened_person, &root_key);
            assert!(
                protocol::open_person_wrapped_root_key(
                    &other_person(),
                    &frame.person_wrap,
                    &frame.base.items_key_id
                )
                .is_err(),
                "another person's key must not open this vault"
            );

            // The phrase wrap that used to open it is gone, not merely ignored.
            assert!(
                protocol::unlock_root_key_v0_2_recovery(
                    &frame.base,
                    "abandon abandon abandon",
                    &frame.base.account_number_hash,
                )
                .is_err(),
                "the retired vault phrase must not open the upgraded vault"
            );

            // An older reader refuses the magic rather than mis-parsing the frame.
            assert!(protocol::parse_vault_meta_ntv6(&after).is_err());
        });
    }

    #[test]
    fn an_already_upgraded_vault_is_not_rewritten() {
        block_on(async {
            let dir = ScopedTempDir::new("ntv7-idempotent").expect("tempdir");
            let root_key = [7u8; 32];
            fixture_ntv6(&dir, &root_key, &[9u8; 32]).await;
            upgrade_vault_to_ntv7(&StdVaultIo, dir.path(), &root_key, &owner().public_half())
                .await
                .expect("first upgrade");
            let first = std::fs::read(dir.path().join("vault.meta")).expect("meta");

            let err =
                upgrade_vault_to_ntv7(&StdVaultIo, dir.path(), &root_key, &owner().public_half())
                    .await
                    .expect_err("second upgrade");
            assert_eq!(err, Ntv7UpgradeError::AlreadyUpgraded);
            let second = std::fs::read(dir.path().join("vault.meta")).expect("meta");
            assert_eq!(first, second, "an idempotent refusal must write nothing");
        });
    }

    #[test]
    fn sealing_to_a_person_the_roster_does_not_name_is_refused() {
        block_on(async {
            let dir = ScopedTempDir::new("ntv7-wrong-person").expect("tempdir");
            let root_key = [7u8; 32];
            fixture_ntv6(&dir, &root_key, &[9u8; 32]).await;
            let before = std::fs::read(dir.path().join("vault.meta")).expect("meta");

            let err = upgrade_vault_to_ntv7(
                &StdVaultIo,
                dir.path(),
                &root_key,
                &other_person().public_half(),
            )
            .await
            .expect_err("wrong person");
            assert_eq!(err, Ntv7UpgradeError::PersonMismatch);
            let after = std::fs::read(dir.path().join("vault.meta")).expect("meta");
            assert_eq!(before, after, "a refusal must leave the metadata untouched");
        });
    }

    #[test]
    fn an_ntv5_source_is_refused_so_the_roster_cannot_be_skipped() {
        block_on(async {
            let dir = ScopedTempDir::new("ntv7-ntv5").expect("tempdir");
            let root_key = [7u8; 32];
            fixture_ntv5(dir.path(), &root_key, &[9u8; 32], &[1u8; 16]);
            let err =
                upgrade_vault_to_ntv7(&StdVaultIo, dir.path(), &root_key, &owner().public_half())
                    .await
                    .expect_err("ntv5 source");
            assert_eq!(err, Ntv7UpgradeError::MigrationRequired);
        });
    }

    #[test]
    fn a_failed_write_leaves_the_original_metadata() {
        block_on(async {
            use crate::vault_io::{DirEntry, FileStat, IoResult};
            use std::sync::atomic::{AtomicUsize, Ordering};

            /// Fails the Nth write, so the one write this upgrade performs is the
            /// one that fails. `VaultIo::write` is an atomic replace, so "the
            /// original metadata survives" is the claim under test rather than a
            /// property of the fixture.
            struct FailWriteIo {
                fail_at: usize,
                writes: AtomicUsize,
            }

            #[async_trait::async_trait]
            impl VaultIo for FailWriteIo {
                async fn read(&self, path: &Path) -> IoResult<Vec<u8>> {
                    StdVaultIo.read(path).await
                }
                async fn read_prefix(&self, path: &Path, len: usize) -> IoResult<Vec<u8>> {
                    StdVaultIo.read_prefix(path, len).await
                }
                async fn write(&self, path: &Path, bytes: &[u8], opts: WriteOpts) -> IoResult<()> {
                    if self.writes.fetch_add(1, Ordering::SeqCst) + 1 == self.fail_at {
                        return Err(crate::io_failure_kind::IoFailureKind::Other);
                    }
                    StdVaultIo.write(path, bytes, opts).await
                }
                async fn remove_file(&self, path: &Path) -> IoResult<()> {
                    StdVaultIo.remove_file(path).await
                }
                async fn remove_dir_all(&self, path: &Path) -> IoResult<()> {
                    StdVaultIo.remove_dir_all(path).await
                }
                async fn create_dir_all(&self, path: &Path) -> IoResult<()> {
                    StdVaultIo.create_dir_all(path).await
                }
                async fn read_dir(&self, path: &Path) -> IoResult<Vec<DirEntry>> {
                    StdVaultIo.read_dir(path).await
                }
                async fn stat(&self, path: &Path) -> IoResult<Option<FileStat>> {
                    StdVaultIo.stat(path).await
                }
                async fn exists(&self, path: &Path) -> IoResult<bool> {
                    StdVaultIo.exists(path).await
                }
                async fn is_dir(&self, path: &Path) -> IoResult<bool> {
                    StdVaultIo.is_dir(path).await
                }
                async fn rename(&self, from: &Path, to: &Path) -> IoResult<()> {
                    StdVaultIo.rename(from, to).await
                }
            }

            let dir = ScopedTempDir::new("ntv7-write-fail").expect("tempdir");
            let root_key = [7u8; 32];
            fixture_ntv6(&dir, &root_key, &[9u8; 32]).await;
            let before = std::fs::read(dir.path().join("vault.meta")).expect("meta");

            let io = FailWriteIo {
                fail_at: 1,
                writes: AtomicUsize::new(0),
            };
            let err = upgrade_vault_to_ntv7(&io, dir.path(), &root_key, &owner().public_half())
                .await
                .expect_err("the write fails");
            assert_eq!(err, Ntv7UpgradeError::Io);
            let after = std::fs::read(dir.path().join("vault.meta")).expect("meta");
            assert_eq!(
                before, after,
                "a failed write must leave the previous metadata byte-identical"
            );
            // And the vault still opens with the password it had, so a failed
            // upgrade is a no-op rather than a half-migrated vault.
            let frame = protocol::parse_vault_meta_ntv6(&after).expect("still NTV6");
            assert!(protocol::unlock_root_key_v0_2_password(
                &frame.base,
                "password",
                &frame.base.account_number_hash,
            )
            .is_ok());
        });
    }

    #[test]
    fn a_tampered_roster_fails_before_any_write() {
        block_on(async {
            let dir = ScopedTempDir::new("ntv7-tampered").expect("tempdir");
            let root_key = [7u8; 32];
            let items = [9u8; 32];
            fixture_ntv6(&dir, &root_key, &items).await;
            let bytes = std::fs::read(dir.path().join("vault.meta")).expect("meta");
            let mut frame = protocol::parse_vault_meta_ntv6(&bytes).expect("ntv6");
            // Flip a byte inside the sealed roster envelope.
            let last = frame.signed_roster_envelope.len() - 1;
            frame.signed_roster_envelope[last] ^= 0x01;
            let mutated = protocol::serialize_vault_meta_ntv6(&frame).expect("reserialize");
            std::fs::write(dir.path().join("vault.meta"), &mutated).expect("meta");

            let err =
                upgrade_vault_to_ntv7(&StdVaultIo, dir.path(), &root_key, &owner().public_half())
                    .await
                    .expect_err("tampered roster");
            assert_eq!(err, Ntv7UpgradeError::CannotDecrypt);
            let after = std::fs::read(dir.path().join("vault.meta")).expect("meta");
            assert_eq!(
                mutated, after,
                "a refusal must leave the metadata untouched"
            );
        });
    }
}
