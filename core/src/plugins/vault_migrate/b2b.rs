// SPDX-License-Identifier: AGPL-3.0
//! Explicit NTV5 to NTV6 owner migration with durable roll-forward recovery.

use crate::io_failure_kind::IoFailureKind;
use crate::vault_io::{VaultIo, WriteOpts};
use protocol::{GroupKey, GroupRole, MetaVersion, OwnerKey, OwnerRole, SubkeyRole};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

pub const B2B_MIGRATION_JOURNAL: &str = ".b2b-migration-journal";
const JOURNAL_MAGIC: &[u8; 4] = b"B2BJ";
const JOURNAL_VERSION: u8 = 1;
const STAGED_SUFFIX: &str = ".b2btmp";
pub(crate) const SHARED_SINGLETONS: &[&str] = &[
    "vault.prefs",
    "vault.search",
    "vault.attachments",
    "vault.workspace",
    "vault.dictionary",
    "vault.indices",
    "vault.themes",
    "vault.graph",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum B2bMigrationError {
    AlreadyMigrated,
    MigrationRequired,
    InvalidVaultMeta,
    CannotDecrypt,
    Csprng,
    Io,
}

pub struct B2bMigrationOutput {
    pub group_key: Zeroizing<[u8; 32]>,
    pub singletons_migrated: usize,
    /// SHA-256 of the committed `NTV6` `vault.meta` bytes. The caller refreshes
    /// its in-memory CAS anchor with this, or the next change-password reads
    /// the migration's own write as external tampering.
    pub new_meta_hash: [u8; 32],
}

struct JournalEntry {
    filename: String,
    hash: [u8; 32],
}

struct Journal {
    meta: Vec<u8>,
    entries: Vec<JournalEntry>,
}

type DecodeOpaque<E> = fn(&[u8; 32], &[u8; 16], &[u8]) -> Result<Zeroizing<Vec<u8>>, E>;
type EncodeOpaque<E> = fn(&[u8; 32], &[u8; 16], &[u8]) -> Result<Vec<u8>, E>;

/// Migrate an unlocked owner vault after the user explicitly starts its first
/// B2B action. The caller owns the lifecycle permit and lock ordering.
///
/// `owner_person_id` is the owner's own `person_id_hash`, from the session's
/// person identity. It is written onto the owner's roster row so the roster can
/// map that row to the owner's `vault.member-names` record (the store is keyed
/// by person id, and the member list resolves a name by looking the row's person
/// id up in it). Omitting it is not cosmetic: the owner's own chosen name would
/// never resolve, so the list would keep offering "Set a name" and every other
/// member would read the owner as a bare fingerprint.
pub async fn migrate_owner_vault_to_ntv6(
    io: &dyn VaultIo,
    vault_root: &Path,
    root_key: &[u8; 32],
    items_key: &[u8; 32],
    owner: &protocol::PersonKeyPair,
    owner_person_id: &[u8; 16],
    owner_display_name: &str,
) -> Result<B2bMigrationOutput, B2bMigrationError> {
    let meta_path = vault_root.join("vault.meta");
    let meta_bytes = io
        .read(&meta_path)
        .await
        .map_err(|_| B2bMigrationError::Io)?;
    if meta_bytes.get(..4) == Some(protocol::VAULT_META_NTV6_MAGIC.as_slice()) {
        return Err(B2bMigrationError::AlreadyMigrated);
    }
    if meta_bytes.get(..4) != Some(protocol::VAULT_META_V0_2_MAGIC.as_slice()) {
        return Err(B2bMigrationError::InvalidVaultMeta);
    }
    let mut base = protocol::parse_vault_meta_v0_2(&meta_bytes)
        .map_err(|_| B2bMigrationError::InvalidVaultMeta)?;
    let account_hash = base.account_number_hash;
    let epoch = 1u64;

    let mut group_bytes = Zeroizing::new([0u8; 32]);
    getrandom::getrandom(group_bytes.as_mut()).map_err(|_| B2bMigrationError::Csprng)?;
    let group_key = GroupKey::new(*group_bytes);
    let owner_key = OwnerKey::new(*root_key);

    let mut group_key_nonce = [0u8; protocol::AEAD_NONCE_LEN];
    let mut items_key_nonce = [0u8; protocol::AEAD_NONCE_LEN];
    getrandom::getrandom(&mut group_key_nonce).map_err(|_| B2bMigrationError::Csprng)?;
    getrandom::getrandom(&mut items_key_nonce).map_err(|_| B2bMigrationError::Csprng)?;

    let enc_group = protocol::aead_seal_ctx(
        &protocol::derive_owner_subkey_v0_2(&owner_key, OwnerRole::GroupKeyWrap),
        &group_key_nonce,
        group_bytes.as_ref(),
        &protocol::aad_vault_group_key_wrap_v0_2(&account_hash, epoch),
    )
    .map_err(|_| B2bMigrationError::CannotDecrypt)?;
    let enc_items = protocol::aead_seal_ctx(
        &protocol::derive_group_subkey_v0_2(&group_key, GroupRole::ItemsKeyWrap),
        &items_key_nonce,
        items_key,
        &protocol::aad_vault_items_key_wrap_v0_2(&base.items_key_id),
    )
    .map_err(|_| B2bMigrationError::CannotDecrypt)?;
    // A present-but-unreadable legacy roster is a REFUSAL, not "no members":
    // collapsing it to `None` would carry an empty roster into `NTV6` and strand
    // every member on the retired `itemsKey` with no row (the harm the loop below
    // documents). Absent membership is the single-user case and is `None` here.
    let legacy_roster = match base.membership.as_ref().and_then(|m| m.roster.as_ref()) {
        None => None,
        Some(env) => {
            let plaintext = protocol::unseal_membership_roster(root_key, env, &account_hash)
                .map_err(|_| B2bMigrationError::CannotDecrypt)?;
            Some(
                crate::plugins::sync::roster::parse_roster(&plaintext)
                    .ok_or(B2bMigrationError::InvalidVaultMeta)?,
            )
        }
    };
    base.items_key_nonce = items_key_nonce;
    base.enc_items_key.copy_from_slice(&enc_items);
    base.membership = None;

    let owner_public = owner.public_half();
    let owner_fingerprint = hex_lower(owner_public.fingerprint());
    let mut rng = rand_core::UnwrapErr(crate::rng::OsRng);
    let mut members = vec![protocol::person_invite::GroupRosterMember {
        fingerprint_hex: owner_fingerprint.clone(),
        // The owner's own person id, so the roster can map this row to the name
        // the owner writes in `vault.member-names` (keyed by person id). The old
        // `None` here left the owner's own name unresolvable on every device.
        person_id_hex: Some(hex_lower(owner_person_id)),
        display_name: owner_display_name.to_owned(),
        role: protocol::person_invite::GroupRosterRole::Owner,
        state: protocol::person_invite::GroupMemberState::Live,
        wrapped_group_key_hex: None,
        member_kem_ek_hex: hex_lower(owner_public.kem_ek()),
        member_ed_pk_hex: hex_lower(owner_public.ed_pk()),
        member_mldsa_vk_hex: hex_lower(owner_public.mldsa_vk()),
        previous_fingerprint_hex: None,
        continuity: protocol::person_invite::GroupKeyContinuity::Current,
        transition_hex: None,
    }];
    // Carry every LIVE legacy member into the NTV6 roster with a fresh
    // group-key package. The migration is the one place their NTV5 `itemsKey`
    // wraps are replaced; dropping the rows silently would strand every member
    // (they keep the retired `itemsKey` and are in no roster).
    if let Some(legacy) = legacy_roster {
        for (fingerprint, row) in legacy.iter() {
            if row.deleted || fingerprint == &owner_fingerprint {
                continue;
            }
            let public = protocol::person_key::PersonPublicHalf::from_parts_hex(
                &row.member_kem_ek_hex,
                &row.member_ed_pk_hex,
                &row.member_mldsa_vk_hex,
            )
            .map_err(|_| B2bMigrationError::InvalidVaultMeta)?;
            let package = protocol::person_invite::create_group_package(
                owner,
                &public,
                &group_bytes,
                &account_hash,
                epoch,
                &mut rng,
            )
            .map_err(|_| B2bMigrationError::CannotDecrypt)?;
            let payload = protocol::person_invite::verify_group_package(&owner_public, &package)
                .map_err(|_| B2bMigrationError::CannotDecrypt)?;
            members.push(protocol::person_invite::GroupRosterMember {
                fingerprint_hex: fingerprint.clone(),
                // A row migrated from the pre-B2B membership roster names no
                // person account, so there is nothing to revoke server-side.
                person_id_hex: None,
                display_name: row.display_name.clone(),
                role: protocol::person_invite::GroupRosterRole::Member,
                state: protocol::person_invite::GroupMemberState::Live,
                wrapped_group_key_hex: Some(payload.wrapped_group_key_hex),
                member_kem_ek_hex: row.member_kem_ek_hex.clone(),
                member_ed_pk_hex: row.member_ed_pk_hex.clone(),
                member_mldsa_vk_hex: row.member_mldsa_vk_hex.clone(),
                previous_fingerprint_hex: row.previous_fingerprint_hex.clone(),
                continuity: crate::plugins::sync::roster::continuity_of(row),
                transition_hex: row.transition_hex.clone(),
            });
        }
    }
    let roster = protocol::person_invite::GroupRosterPayload {
        account_number_hash_hex: hex_lower(&account_hash),
        group_key_epoch: epoch,
        owner_fingerprint_hex: owner_fingerprint.clone(),
        members,
    };
    let signed_roster = protocol::person_invite::sign_group_roster(owner, &roster, &mut rng)
        .map_err(|_| B2bMigrationError::CannotDecrypt)?;
    let mut roster_nonce = [0u8; protocol::AEAD_NONCE_LEN];
    getrandom::getrandom(&mut roster_nonce).map_err(|_| B2bMigrationError::Csprng)?;
    let signed_roster_envelope = protocol::person_invite::seal_group_roster(
        &group_bytes,
        &account_hash,
        epoch,
        &roster_nonce,
        &signed_roster,
    )
    .ok_or(B2bMigrationError::InvalidVaultMeta)?;
    let mut enc_group_key = [0u8; protocol::VAULT_META_WRAPPED_ITEMS_KEY_LEN];
    enc_group_key.copy_from_slice(&enc_group);
    let new_meta = protocol::serialize_vault_meta_ntv6(&protocol::B2bVaultMeta {
        base,
        group_key_nonce,
        enc_group_key,
        group_key_epoch: epoch,
        signed_roster_envelope,
    })
    .map_err(|_| B2bMigrationError::InvalidVaultMeta)?;

    // Quiesce: hold every shared-singleton writer off for the whole reseal, from
    // before the first singleton is read to after the commit marker is written
    // (myne-md/myne#711 task 15). Held until this function returns.
    let _quiesce = crate::singleton_quiesce::exclusive().await;
    let mut staged = Vec::new();
    for filename in SHARED_SINGLETONS {
        let path = vault_root.join(filename);
        let old_blob = match io.read(&path).await {
            Ok(bytes) => bytes,
            Err(IoFailureKind::NotFound) => continue,
            Err(_) => return Err(B2bMigrationError::Io),
        };
        let new_blob = reseal_shared_singleton(
            filename,
            &old_blob,
            SingletonOldTier::Root(root_key),
            &group_key,
            &account_hash,
        )?;
        staged.push((path, new_blob));
    }

    stage_all(io, &staged).await?;
    let journal = Journal {
        meta: new_meta.clone(),
        entries: staged
            .iter()
            .map(|(path, bytes)| JournalEntry {
                filename: path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default()
                    .to_owned(),
                hash: Sha256::digest(bytes).into(),
            })
            .collect(),
    };
    io.write(
        &vault_root.join(B2B_MIGRATION_JOURNAL),
        &encode_journal(&journal)?,
        WriteOpts::default(),
    )
    .await
    .map_err(|_| B2bMigrationError::Io)?;
    publish_and_verify(io, vault_root, &journal).await?;
    io.write(&meta_path, &new_meta, WriteOpts::default())
        .await
        .map_err(|_| B2bMigrationError::Io)?;
    // A failed unlink is NOT silent: a stale journal makes the next unlock's
    // recovery compare live bytes against the journal's recorded hashes, so any
    // later singleton write would turn every subsequent unlock into a refusal.
    if io
        .remove_file(&vault_root.join(B2B_MIGRATION_JOURNAL))
        .await
        .is_err()
    {
        tracing::warn!(
            stage = "b2b_migration",
            event = "journal_remove_failed",
            "the migration journal could not be removed; the next unlock may refuse"
        );
    }

    Ok(B2bMigrationOutput {
        group_key: group_bytes,
        singletons_migrated: staged.len(),
        new_meta_hash: Sha256::digest(&new_meta).into(),
    })
}

/// Complete or roll back an interrupted B2B migration. A present journal is
/// the durable commit intent and always rolls forward; orphan temps roll back.
pub async fn recover_pending_b2b_migration(
    io: &dyn VaultIo,
    vault_root: &Path,
) -> Result<Option<Vec<u8>>, B2bMigrationError> {
    let journal_path = vault_root.join(B2B_MIGRATION_JOURNAL);
    let committed = io
        .exists(&journal_path)
        .await
        .map_err(|_| B2bMigrationError::Io)?;
    if !committed {
        for filename in SHARED_SINGLETONS {
            let _ = io
                .remove_file(&staged_path(&vault_root.join(filename)))
                .await;
        }
        return Ok(None);
    }
    let bytes = io
        .read(&journal_path)
        .await
        .map_err(|_| B2bMigrationError::Io)?;
    let journal = decode_journal(&bytes)?;
    publish_and_verify(io, vault_root, &journal).await?;
    io.write(
        &vault_root.join("vault.meta"),
        &journal.meta,
        WriteOpts::default(),
    )
    .await
    .map_err(|_| B2bMigrationError::Io)?;
    io.remove_file(&journal_path)
        .await
        .map_err(|_| B2bMigrationError::Io)?;
    Ok(Some(journal.meta))
}

/// Which tier the OLD seal of a shared singleton came from.
///
/// The migration reads the old blobs under the owner root tier; a group
/// rotation reads them under the previous GROUP tier. The NEW seal is always
/// the group tier. Kept an explicit enum rather than two functions so the
/// per-family role match (and its registry pairing) stays in one place.
pub(crate) enum SingletonOldTier<'a> {
    Root(&'a [u8; 32]),
    Group(&'a GroupKey),
}

pub(crate) fn reseal_shared_singleton(
    filename: &str,
    blob: &[u8],
    old_tier: SingletonOldTier<'_>,
    new_group: &GroupKey,
    account_hash: &[u8; 16],
) -> Result<Vec<u8>, B2bMigrationError> {
    macro_rules! keys {
        ($old:expr, $group:expr) => {
            (
                match old_tier {
                    SingletonOldTier::Root(root) => protocol::derive_subkey_v0_2(root, $old),
                    SingletonOldTier::Group(group) => {
                        protocol::derive_group_subkey_v0_2(group, $group)
                    }
                },
                protocol::derive_group_subkey_v0_2(new_group, $group),
            )
        };
    }
    let result = match filename {
        "vault.prefs" => {
            let (old, new) = keys!(SubkeyRole::PrefsKey, GroupRole::PrefsKey);
            let value =
                protocol::decode_prefs_blob_versioned(MetaVersion::V0_2, &old, account_hash, blob)
                    .map_err(|_| B2bMigrationError::CannotDecrypt)?;
            protocol::encode_prefs_blob_versioned(MetaVersion::V0_2, &new, account_hash, &value)
                .map_err(|_| B2bMigrationError::CannotDecrypt)
        }
        "vault.attachments" => {
            let (old, new) = keys!(
                SubkeyRole::AttachmentsCatalogKey,
                GroupRole::AttachmentsCatalogKey
            );
            let value = protocol::decode_attachments_catalog_versioned(
                MetaVersion::V0_2,
                &old,
                account_hash,
                blob,
            )
            .map_err(|_| B2bMigrationError::CannotDecrypt)?;
            protocol::encode_attachments_catalog_versioned(
                MetaVersion::V0_2,
                &new,
                account_hash,
                &value,
            )
            .map_err(|_| B2bMigrationError::CannotDecrypt)
        }
        "vault.dictionary" => {
            let (old, new) = keys!(SubkeyRole::PersonalDictKey, GroupRole::PersonalDictKey);
            let value = protocol::decode_dictionary_blob_versioned(
                MetaVersion::V0_2,
                &old,
                account_hash,
                blob,
            )
            .map_err(|_| B2bMigrationError::CannotDecrypt)?;
            // The re-seal is payload-opaque, so the inner generation byte must
            // keep describing the bytes it carries: a pre-#640 `0x01` body stays
            // `0x01` and the next local write upgrades it. Stamping the current
            // byte over it is a relabel every reader then refuses
            // (myne-md/myne#640; the same rule as `reseal_kek_singleton`).
            let format = protocol::dictionary_blob_format(blob)
                .filter(|f| protocol::DICTIONARY_BLOB_SUPPORTED_FORMATS.contains(f))
                .unwrap_or(protocol::DICTIONARY_BLOB_FORMAT_CURRENT);
            protocol::encode_dictionary_blob_versioned_with_format(
                MetaVersion::V0_2,
                &new,
                account_hash,
                &value,
                format,
            )
            .map_err(|_| B2bMigrationError::CannotDecrypt)
        }
        "vault.themes" => {
            let (old, new) = keys!(SubkeyRole::CustomThemesKey, GroupRole::CustomThemesKey);
            let value =
                protocol::decode_themes_blob_versioned(MetaVersion::V0_2, &old, account_hash, blob)
                    .map_err(|_| B2bMigrationError::CannotDecrypt)?;
            protocol::encode_themes_blob_versioned(MetaVersion::V0_2, &new, account_hash, &value)
                .map_err(|_| B2bMigrationError::CannotDecrypt)
        }
        "vault.search" => reseal_opaque(
            blob,
            &keys!(SubkeyRole::SearchIndexKey, GroupRole::SearchIndexKey),
            account_hash,
            protocol::decode_search_index_blob,
            protocol::encode_search_index_blob,
        ),
        "vault.workspace" => reseal_opaque(
            blob,
            &keys!(SubkeyRole::SessionStateKey, GroupRole::SessionStateKey),
            account_hash,
            protocol::decode_workspace_blob,
            protocol::encode_workspace_blob,
        ),
        "vault.indices" => reseal_opaque(
            blob,
            &keys!(SubkeyRole::VaultIndicesKey, GroupRole::VaultIndicesKey),
            account_hash,
            protocol::decode_vault_indices_blob,
            protocol::encode_vault_indices_blob,
        ),
        "vault.graph" => reseal_opaque(
            blob,
            &keys!(SubkeyRole::GraphLayoutKey, GroupRole::GraphLayoutKey),
            account_hash,
            protocol::decode_graph_layout_blob,
            protocol::encode_graph_layout_blob,
        ),
        _ => Err(B2bMigrationError::InvalidVaultMeta),
    }?;
    Ok(result)
}

fn reseal_opaque<E1, E2>(
    blob: &[u8],
    keys: &(Zeroizing<[u8; 32]>, Zeroizing<[u8; 32]>),
    account_hash: &[u8; 16],
    decode: DecodeOpaque<E1>,
    encode: EncodeOpaque<E2>,
) -> Result<Vec<u8>, B2bMigrationError> {
    let plaintext =
        decode(&keys.0, account_hash, blob).map_err(|_| B2bMigrationError::CannotDecrypt)?;
    encode(&keys.1, account_hash, &plaintext).map_err(|_| B2bMigrationError::CannotDecrypt)
}

async fn stage_all(
    io: &dyn VaultIo,
    staged: &[(PathBuf, Vec<u8>)],
) -> Result<(), B2bMigrationError> {
    let mut written: Vec<PathBuf> = Vec::new();
    for (path, bytes) in staged {
        let tmp = staged_path(path);
        if io.write(&tmp, bytes, WriteOpts::default()).await.is_err() {
            for path in written {
                let _ = io.remove_file(&path).await;
            }
            let _ = io.remove_file(&tmp).await;
            return Err(B2bMigrationError::Io);
        }
        written.push(tmp);
    }
    Ok(())
}

async fn publish_and_verify(
    io: &dyn VaultIo,
    root: &Path,
    journal: &Journal,
) -> Result<(), B2bMigrationError> {
    for entry in &journal.entries {
        if !SHARED_SINGLETONS.contains(&entry.filename.as_str()) {
            return Err(B2bMigrationError::InvalidVaultMeta);
        }
        let destination = root.join(&entry.filename);
        let tmp = staged_path(&destination);
        if io.exists(&tmp).await.map_err(|_| B2bMigrationError::Io)? {
            let bytes = io.read(&tmp).await.map_err(|_| B2bMigrationError::Io)?;
            if Sha256::digest(&bytes).as_slice() != entry.hash {
                return Err(B2bMigrationError::InvalidVaultMeta);
            }
            io.write(&destination, &bytes, WriteOpts::default())
                .await
                .map_err(|_| B2bMigrationError::Io)?;
            io.remove_file(&tmp)
                .await
                .map_err(|_| B2bMigrationError::Io)?;
        }
        let live = io
            .read(&destination)
            .await
            .map_err(|_| B2bMigrationError::Io)?;
        if Sha256::digest(&live).as_slice() != entry.hash {
            return Err(B2bMigrationError::InvalidVaultMeta);
        }
    }
    Ok(())
}

fn staged_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(STAGED_SUFFIX);
    path.with_file_name(name)
}

fn encode_journal(journal: &Journal) -> Result<Vec<u8>, B2bMigrationError> {
    let meta_len: u32 = journal
        .meta
        .len()
        .try_into()
        .map_err(|_| B2bMigrationError::InvalidVaultMeta)?;
    let entry_count: u16 = journal
        .entries
        .len()
        .try_into()
        .map_err(|_| B2bMigrationError::InvalidVaultMeta)?;
    let mut out = Vec::new();
    out.extend_from_slice(JOURNAL_MAGIC);
    out.push(JOURNAL_VERSION);
    out.extend_from_slice(&meta_len.to_be_bytes());
    out.extend_from_slice(&entry_count.to_be_bytes());
    out.extend_from_slice(&journal.meta);
    for entry in &journal.entries {
        let name = entry.filename.as_bytes();
        let name_len: u8 = name
            .len()
            .try_into()
            .map_err(|_| B2bMigrationError::InvalidVaultMeta)?;
        out.push(name_len);
        out.extend_from_slice(name);
        out.extend_from_slice(&entry.hash);
    }
    Ok(out)
}

fn decode_journal(bytes: &[u8]) -> Result<Journal, B2bMigrationError> {
    if bytes.len() < 11 || &bytes[..4] != JOURNAL_MAGIC || bytes[4] != JOURNAL_VERSION {
        return Err(B2bMigrationError::InvalidVaultMeta);
    }
    let meta_len = u32::from_be_bytes(bytes[5..9].try_into().unwrap()) as usize;
    let entry_count = u16::from_be_bytes(bytes[9..11].try_into().unwrap()) as usize;
    let meta_end = 11usize
        .checked_add(meta_len)
        .ok_or(B2bMigrationError::InvalidVaultMeta)?;
    if meta_end > bytes.len() || protocol::parse_vault_meta_ntv6(&bytes[11..meta_end]).is_err() {
        return Err(B2bMigrationError::InvalidVaultMeta);
    }
    let mut cursor = meta_end;
    let mut entries = Vec::with_capacity(entry_count);
    for _ in 0..entry_count {
        let name_len = *bytes
            .get(cursor)
            .ok_or(B2bMigrationError::InvalidVaultMeta)? as usize;
        cursor += 1;
        let name_end = cursor
            .checked_add(name_len)
            .ok_or(B2bMigrationError::InvalidVaultMeta)?;
        let hash_end = name_end
            .checked_add(32)
            .ok_or(B2bMigrationError::InvalidVaultMeta)?;
        if hash_end > bytes.len() {
            return Err(B2bMigrationError::InvalidVaultMeta);
        }
        let filename = std::str::from_utf8(&bytes[cursor..name_end])
            .map_err(|_| B2bMigrationError::InvalidVaultMeta)?
            .to_owned();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&bytes[name_end..hash_end]);
        entries.push(JournalEntry { filename, hash });
        cursor = hash_end;
    }
    if cursor != bytes.len() {
        return Err(B2bMigrationError::InvalidVaultMeta);
    }
    Ok(Journal {
        meta: bytes[11..meta_end].to_vec(),
        entries,
    })
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io_failure_kind::IoFailureKind;
    use crate::test_support::{block_on, ScopedTempDir};
    use crate::vault_io::{DirEntry, FileStat, IoResult, StdVaultIo};
    use protocol::KdfParams;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const FAST_KDF: KdfParams = KdfParams {
        m_kib: 8,
        t: 1,
        p: 1,
        argon2_version: 0x13,
    };

    fn fixture_meta(root: &[u8; 32], items: &[u8; 32], account: &[u8; 16]) -> Vec<u8> {
        protocol::encode_vault_meta_v0_2_raw(
            root,
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
        .expect("fixture NTV5")
        .to_vec()
    }

    fn owner() -> protocol::PersonKeyPair {
        protocol::PersonKeyPair::generate_raw(&[1u8; 64], &[2u8; 32], &[3u8; 32])
    }

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
                return Err(IoFailureKind::Other);
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

    #[test]
    fn migration_commits_ntv6_last_and_preserves_content_bodies() {
        block_on(async {
            let dir = ScopedTempDir::new("b2b-migration").expect("tempdir");
            let root = dir.path();
            let owner_root = [7u8; 32];
            let items = [9u8; 32];
            let account = [1u8; 16];
            std::fs::write(
                root.join("vault.meta"),
                fixture_meta(&owner_root, &items, &account),
            )
            .expect("meta");
            std::fs::create_dir_all(root.join("notes")).expect("notes dir");
            std::fs::create_dir_all(root.join("attachments")).expect("attachments dir");
            std::fs::write(root.join("notes").join("body.myn"), b"note-ciphertext").expect("note");
            std::fs::write(
                root.join("attachments").join("body"),
                b"attachment-ciphertext",
            )
            .expect("attachment");

            let out = migrate_owner_vault_to_ntv6(
                &StdVaultIo,
                root,
                &owner_root,
                &items,
                &owner(),
                &[0x11u8; 16],
                "Owner",
            )
            .await
            .expect("migration");
            assert_eq!(out.singletons_migrated, 0);
            assert_eq!(
                std::fs::read(root.join("notes").join("body.myn")).unwrap(),
                b"note-ciphertext"
            );
            assert_eq!(
                std::fs::read(root.join("attachments").join("body")).unwrap(),
                b"attachment-ciphertext"
            );
            let meta = std::fs::read(root.join("vault.meta")).unwrap();
            let parsed = protocol::parse_vault_meta_ntv6(&meta).expect("ntv6");
            assert!(!root.join(B2B_MIGRATION_JOURNAL).exists());

            // The owner row carries the person id, so the roster can map it to the
            // owner's `vault.member-names` record. Without it the owner's own name
            // never resolves on any device.
            let envelope = protocol::person_invite::open_group_roster(
                &out.group_key,
                &parsed.base.account_number_hash,
                parsed.group_key_epoch,
                &parsed.signed_roster_envelope,
            )
            .expect("roster opens under the group key");
            let roster = protocol::person_invite::verify_group_roster(
                &owner().public_half(),
                &envelope,
                &parsed.base.account_number_hash,
            )
            .expect("roster verifies");
            let owner_row = roster
                .members
                .iter()
                .find(|m| m.role == protocol::person_invite::GroupRosterRole::Owner)
                .expect("owner row");
            assert_eq!(
                owner_row.person_id_hex.as_deref(),
                Some("11".repeat(16).as_str())
            );
        });
    }

    /// The re-seal is payload-opaque, so a pre-#640 `0x01` dictionary must come
    /// out of the NTV6 migration still labelled `0x01`: stamping the current byte
    /// over old bytes makes every reader refuse the family for good
    /// (myne-md/myne#640, the same rule `reseal_kek_singleton` states).
    #[test]
    fn a_v0_1_dictionary_keeps_its_generation_byte_across_the_migration() {
        block_on(async {
            let dir = ScopedTempDir::new("b2b-dict-format").expect("tempdir");
            let root = dir.path();
            let owner_root = [7u8; 32];
            let items = [9u8; 32];
            let account = [1u8; 16];
            std::fs::write(
                root.join("vault.meta"),
                fixture_meta(&owner_root, &items, &account),
            )
            .expect("meta");
            std::fs::create_dir_all(root.join("notes")).expect("notes dir");
            std::fs::create_dir_all(root.join("attachments")).expect("attachments dir");

            let v1 = crate::plugins::sync::dictionary_payload::PersonalDictionaryV1 {
                personal_words: vec!["myne".to_string()],
                ignore_words: vec![],
            }
            .encode();
            let kek = protocol::derive_subkey_v0_2(&owner_root, SubkeyRole::PersonalDictKey);
            let mut blob =
                protocol::encode_dictionary_blob_versioned(MetaVersion::V0_2, &kek, &account, &v1)
                    .expect("seed MYD5");
            // A genuine pre-#640 body: the format byte is not in the AAD, so this
            // is exactly what an older writer's blob looks like.
            blob[5] = protocol::DICTIONARY_BLOB_FORMAT_V1;
            std::fs::write(root.join("vault.dictionary"), &blob).expect("dictionary");

            migrate_owner_vault_to_ntv6(
                &StdVaultIo,
                root,
                &owner_root,
                &items,
                &owner(),
                &[0x11u8; 16],
                "Owner",
            )
            .await
            .expect("migration");

            let out = std::fs::read(root.join("vault.dictionary")).unwrap();
            assert_eq!(
                protocol::dictionary_blob_format(&out),
                Some(protocol::DICTIONARY_BLOB_FORMAT_V1),
                "the header must keep describing the payload the re-seal carried"
            );
        });
    }

    #[test]
    fn recovery_rolls_back_orphan_temps_without_a_journal() {
        block_on(async {
            let dir = ScopedTempDir::new("b2b-rollback").expect("tempdir");
            let root = dir.path();
            std::fs::write(staged_path(&root.join("vault.prefs")), b"staged").unwrap();
            assert_eq!(
                recover_pending_b2b_migration(&StdVaultIo, root).await,
                Ok(None)
            );
            assert!(!staged_path(&root.join("vault.prefs")).exists());
        });
    }

    #[test]
    fn committed_recovery_refuses_a_missing_or_wrong_staged_value() {
        block_on(async {
            let dir = ScopedTempDir::new("b2b-fail-closed").expect("tempdir");
            let root = dir.path();
            let owner_root = [7u8; 32];
            let items = [9u8; 32];
            let account = [1u8; 16];
            let old_meta = fixture_meta(&owner_root, &items, &account);
            std::fs::write(root.join("vault.meta"), &old_meta).unwrap();
            let owner = owner();

            // Build a valid committed journal through the production migration,
            // then reconstruct the interrupted state with one expected target wrong.
            migrate_owner_vault_to_ntv6(
                &StdVaultIo,
                root,
                &owner_root,
                &items,
                &owner,
                &[0x11u8; 16],
                "Owner",
            )
            .await
            .unwrap();
            let ntv6 = std::fs::read(root.join("vault.meta")).unwrap();
            let journal = Journal {
                meta: ntv6,
                entries: vec![JournalEntry {
                    filename: "vault.prefs".into(),
                    hash: Sha256::digest(b"expected").into(),
                }],
            };
            std::fs::write(root.join("vault.meta"), &old_meta).unwrap();
            std::fs::write(root.join("vault.prefs"), b"wrong").unwrap();
            std::fs::write(
                root.join(B2B_MIGRATION_JOURNAL),
                encode_journal(&journal).unwrap(),
            )
            .unwrap();

            assert_eq!(
                recover_pending_b2b_migration(&StdVaultIo, root).await,
                Err(B2bMigrationError::InvalidVaultMeta)
            );
            assert_eq!(std::fs::read(root.join("vault.meta")).unwrap(), old_meta);
            assert!(root.join(B2B_MIGRATION_JOURNAL).exists());
        });
    }

    #[test]
    fn every_durable_write_recovers_to_one_complete_hierarchy() {
        block_on(async {
            for fail_at in 1..=4 {
                let dir = ScopedTempDir::new("b2b-fault-phase").expect("tempdir");
                let root = dir.path();
                let owner_root = [7u8; 32];
                let items = [9u8; 32];
                let account = [1u8; 16];
                let old_meta = fixture_meta(&owner_root, &items, &account);
                std::fs::write(root.join("vault.meta"), &old_meta).unwrap();
                let old_prefs_key =
                    protocol::derive_subkey_v0_2(&owner_root, protocol::SubkeyRole::PrefsKey);
                let old_prefs = protocol::encode_prefs_blob_versioned(
                    MetaVersion::V0_2,
                    &old_prefs_key,
                    &account,
                    &protocol::PrefsView::default(),
                )
                .unwrap();
                std::fs::write(root.join("vault.prefs"), &old_prefs).unwrap();
                let failing = FailWriteIo {
                    fail_at,
                    writes: AtomicUsize::new(0),
                };

                assert_eq!(
                    migrate_owner_vault_to_ntv6(
                        &failing,
                        root,
                        &owner_root,
                        &items,
                        &owner(),
                        &[0x11u8; 16],
                        "Owner",
                    )
                    .await
                    .map(|_| ()),
                    Err(B2bMigrationError::Io),
                    "write phase {fail_at} must be injected"
                );
                recover_pending_b2b_migration(&StdVaultIo, root)
                    .await
                    .expect("recovery");

                let meta = std::fs::read(root.join("vault.meta")).unwrap();
                let prefs = std::fs::read(root.join("vault.prefs")).unwrap();
                if fail_at <= 2 {
                    assert_eq!(meta, old_meta, "phase {fail_at} rolls back");
                    protocol::decode_prefs_blob_versioned(
                        MetaVersion::V0_2,
                        &old_prefs_key,
                        &account,
                        &prefs,
                    )
                    .expect("old hierarchy remains complete");
                } else {
                    let ntv6 = protocol::parse_vault_meta_ntv6(&meta)
                        .expect("phase after journal rolls forward");
                    let owner_key = OwnerKey::new(owner_root);
                    let group_bytes = protocol::aead_open_ctx(
                        &protocol::derive_owner_subkey_v0_2(&owner_key, OwnerRole::GroupKeyWrap),
                        &ntv6.group_key_nonce,
                        &ntv6.enc_group_key,
                        &protocol::aad_vault_group_key_wrap_v0_2(&account, ntv6.group_key_epoch),
                    )
                    .expect("owner opens group key");
                    let mut group_array = [0u8; 32];
                    group_array.copy_from_slice(&group_bytes);
                    let group_key = GroupKey::new(group_array);
                    let prefs_key =
                        protocol::derive_group_subkey_v0_2(&group_key, GroupRole::PrefsKey);
                    protocol::decode_prefs_blob_versioned(
                        MetaVersion::V0_2,
                        &prefs_key,
                        &account,
                        &prefs,
                    )
                    .expect("new hierarchy is complete");
                }
                assert!(!root.join(B2B_MIGRATION_JOURNAL).exists());
                assert!(!staged_path(&root.join("vault.prefs")).exists());
            }
        });
    }
}
