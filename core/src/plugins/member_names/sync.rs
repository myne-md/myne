// SPDX-License-Identifier: AGPL-3.0

//! The sync-facing surface of the member-names family: the group-tier keyspace
//! resolver, the family's 16-byte sync discriminator, and the decryption-free
//! reader the orchestrator's phase uses.
//!
//! **Why this module is UNGATED (it compiles for `wasm32`) while [`super::commands`]
//! is not.** `plugins::sync::orchestrator` is target-independent by design: the
//! browser client reuses the engine and brings its own transport
//! (`sync/mod.rs`), so a call from there into a `#[cfg(not(target_arch = "wasm32"))]`
//! item breaks the wasm build with an `E0433` naming a path that is correctly gated
//! out, while every native gate stays green (`core/AGENTS.md`). So nothing here
//! touches a session, a host or the person plane: `protocol`, `VaultIo`, the store,
//! and `vault.meta` as bytes.
//!
//! **Why the resolver is here rather than in either caller.** The command layer and
//! the sync engine must derive the SAME key from the SAME read. Keeping a copy in
//! each is the drift that let the themes phase derive v0.1 on a migrated vault while
//! its command layer went version-aware, so a theme edit stopped being published
//! with no error anywhere (myne-md/myne#436). One resolver, two callers.

use super::error::MemberNamesError;
use super::store::MemberNamesKey;
use crate::vault_io::VaultIo;
use protocol::aead::AEAD_KEY_LEN;
use protocol::{GroupKey, GroupRole};
use std::path::Path;
use zeroize::Zeroizing;

/// The derived key and the two bindings a seal needs, resolved from a group-held
/// session and `vault.meta`.
///
/// The KEK is a GROUP-tier role because every member reads every name and only
/// members read any. The epoch rides the AAD, so a blob sealed in a retired epoch
/// fails the AEAD rather than being read under a key that no longer applies.
pub struct ResolvedNames {
    /// `derive_group_subkey_v0_2(group_key, GroupRole::MemberNamesKey)`.
    pub key: Zeroizing<[u8; AEAD_KEY_LEN]>,
    /// The vault's `account_number_hash`, from `vault.meta`.
    pub account_number_hash: [u8; 16],
    /// The vault's live group-key epoch.
    pub group_key_epoch: u64,
}

impl ResolvedNames {
    /// The borrow the store's entry points take.
    pub fn borrow(&self) -> MemberNamesKey<'_> {
        MemberNamesKey {
            key: &self.key,
            account_number_hash: &self.account_number_hash,
            group_key_epoch: self.group_key_epoch,
        }
    }
}

/// The family's KEK and its two bindings, for a caller that ALREADY holds the epoch
/// and the account hash.
///
/// This is the ONE place the derivation lives, and the split is deliberate: a caller
/// that has just parsed `vault.meta` for another purpose (the roster command parses it
/// for the roster itself) must not read the file a second time, because the two reads
/// could observe different bytes. `resolve_names_from_group_key` is the reader that
/// parses it when the caller does not have the pair yet.
pub fn names_key_for_group(
    group_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: [u8; 16],
    group_key_epoch: u64,
) -> ResolvedNames {
    let key =
        protocol::derive_group_subkey_v0_2(&GroupKey::new(*group_key), GroupRole::MemberNamesKey);
    ResolvedNames {
        key,
        account_number_hash,
        group_key_epoch,
    }
}

/// Resolve the family's keyspace from the raw group key and `vault.meta`. The meta
/// is read ONCE, so the account hash and the epoch cannot come from two different
/// files.
///
/// A `vault.meta` that is not `NTV6` is [`MemberNamesError::NotASharedVault`]: this
/// family does not exist in a pre-B2B vault, where there is no `group_key` a member
/// could read a member-writable name with. A caller holding only the owner root
/// answers that before it gets here.
pub async fn resolve_names_from_group_key(
    io: &dyn VaultIo,
    group_key: &[u8; AEAD_KEY_LEN],
    vault_dir: &Path,
) -> Result<ResolvedNames, MemberNamesError> {
    let bytes = io
        .read(&vault_dir.join("vault.meta"))
        .await
        .map_err(|io_error_kind| MemberNamesError::Io { io_error_kind })?;
    let b2b =
        protocol::parse_vault_meta_ntv6(&bytes).map_err(|_| MemberNamesError::NotASharedVault)?;
    Ok(names_key_for_group(
        group_key,
        b2b.base.account_number_hash,
        b2b.group_key_epoch,
    ))
}

/// The family's reserved 16-byte sync-plane blob-id:
/// `DeriveGroupSubkey(group_key, "member-names-sync-id")[0..16]` (`protocol.md`
/// §3.4, `decisions/protocol/0666`): the `themes_sync_id` archetype.
///
/// It is derived from the GROUP key rather than the owner root, which is what lets
/// a member address the same blob the owner wrote. It therefore ROTATES with the
/// group key on member removal, and a rotation moves it in two halves that must be
/// read as one:
///
/// - the blob is RE-SEALED from the retired epoch's group tier to the new one, by the
///   dedicated group-to-group step in `sync::member_removal::rotate_group_from_host`
///   (step 5c), because this family has no `NTV5` form and its AAD binds
///   `group_key_epoch`, so it cannot ride `vault_migrate::b2b::SHARED_SINGLETONS`;
/// - the retired epoch's id is queued for server reclaim by
///   `sync::member_removal::group_rotation_reclaim_sync_ids`, which names
///   `GroupRole::MemberNamesSyncId` for exactly this reason.
///
/// The two land together on purpose. Reclaiming the id without re-sealing would have
/// the server DELETE the blob and leave nothing at the new epoch; re-sealing without
/// reclaiming would leave the retired epoch's record readable to the member just
/// removed, who still holds the old group key. `myne-md/myne#851`; the wiring was
/// absent when this family first landed and is the `progress.md` entry it points at.
///
/// The role string is written whole in `protocol` and must never be spelled here:
/// a truncated KEY derivation would instead leak key material to the sync plane
/// (`shared_sync_id`'s own rule).
pub fn names_sync_id(group_key: &[u8; AEAD_KEY_LEN]) -> [u8; 16] {
    let sub = protocol::derive_group_subkey_v0_2(
        &GroupKey::new(*group_key),
        GroupRole::MemberNamesSyncId,
    );
    let mut id = [0u8; 16];
    id.copy_from_slice(&sub[..16]);
    id
}

/// The newest LOCAL copy of the store that DECODES, raw bytes. `None` when the file
/// is absent or no copy opens.
///
/// "That decodes", not "the newest that parses a header": on the web container a torn
/// slot can carry a valid header over a torn payload, and handing those bytes to the
/// push would publish an empty name store to every peer (myne#301, the shape that wiped
/// `vault.themes`). The sync phase is the one caller; the store's own read additionally
/// sweeps the superseded slots once a survivor is proven.
pub async fn read_verified_names_bytes(
    io: &dyn VaultIo,
    vault_dir: &Path,
    key: &MemberNamesKey<'_>,
) -> Option<Vec<u8>> {
    let candidates = io
        .read_candidates(&vault_dir.join(super::MEMBER_NAMES_FILE))
        .await
        .ok()?;
    candidates.into_iter().find(|bytes| {
        protocol::decode_member_names_blob(
            key.key,
            key.account_number_hash,
            key.group_key_epoch,
            bytes,
        )
        .is_ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const GROUP: [u8; AEAD_KEY_LEN] = [0x77; AEAD_KEY_LEN];

    fn group_id(role: GroupRole) -> [u8; 16] {
        let sub = protocol::derive_group_subkey_v0_2(&GroupKey::new(GROUP), role);
        let mut id = [0u8; 16];
        id.copy_from_slice(&sub[..16]);
        id
    }

    /// The discriminator is deterministic, group-derived, and distinct from every
    /// sibling shared singleton's id. Two families sharing an id would make one
    /// family's push overwrite the other's blob.
    #[test]
    fn names_sync_id_is_deterministic_group_derived_and_distinct() {
        assert_eq!(names_sync_id(&GROUP), names_sync_id(&GROUP));
        assert_eq!(
            names_sync_id(&GROUP),
            group_id(GroupRole::MemberNamesSyncId)
        );
        for role in [
            GroupRole::CatalogSyncId,
            GroupRole::PrefsSyncId,
            GroupRole::ThemesSyncId,
            GroupRole::PersonalDictSyncId,
        ] {
            assert_ne!(
                names_sync_id(&GROUP),
                group_id(role),
                "{role:?} must not collide with the member-names id"
            );
        }
        assert_ne!(names_sync_id(&GROUP), names_sync_id(&[0x11; AEAD_KEY_LEN]));
    }

    /// The KEK and the discriminator must come from DIFFERENT roles: collapsing them
    /// would put key material into a server-visible id.
    #[test]
    fn the_kek_and_the_sync_id_are_different_derivations() {
        let kek =
            protocol::derive_group_subkey_v0_2(&GroupKey::new(GROUP), GroupRole::MemberNamesKey);
        assert_ne!(names_sync_id(&GROUP), kek[..16]);
    }
}
