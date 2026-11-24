// SPDX-License-Identifier: AGPL-3.0-only

//! The member-names store: the read-modify-write against `vault.member-names`, with
//! no host and no session in sight.
//!
//! Every entry point takes [`MemberNamesKey`] (the derived group-tier KEK plus the two
//! bindings the seal needs) and a [`MemberNamesWriter`] (the signing person and the
//! person id the row is keyed by), so the whole module runs over a temp vault
//! directory. The command layer resolves those from a live session; that is task 3b.

use super::error::MemberNamesError;
use super::MEMBER_NAMES_FILE;
use crate::vault_io::{VaultIo, WriteOpts};
use protocol::aead::AEAD_KEY_LEN;
use protocol::{
    decode_member_names_blob, encode_member_names_blob, merge_member_names, sign_member_name,
    MemberNamesMap, MAX_MEMBER_NAME_LEN,
};
use std::path::Path;
use std::sync::OnceLock;
use tokio::sync::Mutex;
use unicode_normalization::UnicodeNormalization;

/// Per-plugin write serialization, the `themes`/`prefs` mutex twin. Every
/// read-modify-write of the whole-map blob takes it, so consecutive mutations commit
/// FIFO and never lose an update.
///
/// It exists because this family has a SECOND writer that the command layer cannot see:
/// the sync orchestrator's `vault.member-names` phase merges a pulled copy into the same
/// map. Without one lock across both, a `set_mine` landing between the phase's read and
/// its write is overwritten by the merge, and the user watches a name they just chose
/// revert. `pub` so the phase can hold it, exactly as `sync_themes_phase` holds
/// `themes::commands::write_mutex`.
///
/// **This mutex is only HALF the gate a writer owes.** A writer must ALSO hold
/// `crate::singleton_quiesce::shared()` across the whole read-modify-write, taken right
/// after this lock, exactly as `prefs::writePref` does. This blob is a shared singleton
/// whose KEK comes from the group tier, so a group rotation re-seals it at a new
/// `group_key_epoch` under the exclusive side of that barrier; a write that read under
/// the retired epoch and lands after the rotation publishes a blob no session can open,
/// and the next read collapses it to the empty map over every member's real row. The
/// barrier's own module doc states the rule ("A writer MUST hold the shared side across
/// its ENTIRE read-modify-write, not just the final write"). The four writers are
/// `member_names_set_mine_with_dir` / `..._clear_mine_with_dir` /
/// `..._merge_pulled_with_dir` here, and `sync_member_names_phase` in
/// `plugins/sync/orchestrator.rs`.
pub fn write_mutex() -> &'static Mutex<()> {
    static M: OnceLock<Mutex<()>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(()))
}

/// The derived key and the bindings one seal needs. `group_key_epoch` rides the AAD,
/// so a blob sealed in a retired epoch fails the AEAD rather than being read under a
/// key that no longer applies.
pub struct MemberNamesKey<'a> {
    /// `derive_group_subkey_v0_2(group_key, GroupRole::MemberNamesKey)`.
    pub key: &'a [u8; AEAD_KEY_LEN],
    /// The vault's `account_number_hash`, from `vault.meta`.
    pub account_number_hash: &'a [u8; 16],
    /// The vault's live group-key epoch.
    pub group_key_epoch: u64,
}

/// Who is writing, and under which identity.
pub struct MemberNamesWriter<'a> {
    /// The signing person, who must be the person the row NAMES.
    pub person: &'a protocol::PersonKeyPair,
    /// The 16-byte `person_id_hash` the row is keyed by. It is derived from the
    /// person's phrase rather than from the keypair, so the caller supplies it.
    pub person_id: &'a [u8; 16],
}

/// Read the map. `NotFound` is the empty map, because a vault nobody has named is a
/// vault with no names and that is the fact. A file that exists but does not decrypt
/// is an ERROR, not an empty map: answering empty for a damaged store is what lets
/// the next write persist that emptiness over real rows.
pub async fn read_member_names_in_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    key: &MemberNamesKey<'_>,
) -> Result<MemberNamesMap, MemberNamesError> {
    use crate::singleton::{open_newest_and_sweep, OpenOutcome};
    match open_newest_and_sweep(io, &vault_dir.join(MEMBER_NAMES_FILE), |bytes| {
        decode_member_names_blob(key.key, key.account_number_hash, key.group_key_epoch, bytes)
    })
    .await
    {
        Ok(map) => Ok(map),
        Err(OpenOutcome::Absent) => Ok(MemberNamesMap::new()),
        Err(OpenOutcome::Io(io_error_kind)) => Err(MemberNamesError::Io { io_error_kind }),
        Err(OpenOutcome::Undecodable(_)) => {
            tracing::warn!(
                event = "member_names_undecryptable",
                "vault.member-names exists but no copy could be decrypted; refusing to treat it as empty"
            );
            Err(MemberNamesError::StoreUnreadable)
        }
    }
}

/// Seal `map` and write it at the vault root. An EMPTY map removes the file instead
/// (best effort), so an empty store leaves no file and reads back as empty.
pub async fn write_member_names_in_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    key: &MemberNamesKey<'_>,
    map: &MemberNamesMap,
) -> Result<(), MemberNamesError> {
    let path = vault_dir.join(MEMBER_NAMES_FILE);
    if map.is_empty() {
        let _ = io.remove_file(&path).await;
        return Ok(());
    }
    let blob = encode_member_names_blob(key.key, key.account_number_hash, key.group_key_epoch, map)
        .map_err(|_| MemberNamesError::Codec)?;
    io.write(&path, &blob, WriteOpts::default())
        .await
        .map_err(|io_error_kind| MemberNamesError::Io { io_error_kind })
}

/// A display name as the store keeps it: NFC-normalised, trimmed, and checked against
/// the cap in BYTES. The fold is what makes two devices agree that a composed and a
/// decomposed rendering of the same name are the same name.
fn canonical_name(name: &str) -> Result<String, MemberNamesError> {
    let folded = name.nfc().collect::<String>();
    let trimmed = folded.trim().to_string();
    if trimmed.is_empty() {
        return Err(MemberNamesError::NameEmpty);
    }
    if trimmed.len() > MAX_MEMBER_NAME_LEN {
        return Err(MemberNamesError::NameTooLong {
            max: MAX_MEMBER_NAME_LEN,
        });
    }
    Ok(trimmed)
}

/// The version a new row takes: strictly ABOVE whatever the row holds, so a stale copy
/// can never win the merge. A row's version is a counter rather than a clock, because
/// a clock skew between two devices must not decide whose rename wins.
fn next_version(map: &MemberNamesMap, person_id_hex: &str) -> u64 {
    map.get(person_id_hex)
        .map(|entry| entry.version.saturating_add(1))
        .unwrap_or(1)
}

fn person_id_hex(person_id: &[u8; 16]) -> String {
    crate::account::person_identity::hex_lower(person_id)
}

/// Set the caller's own display name, signed by the caller. Refuses an empty name and
/// one over the cap BEFORE touching the map, so a refusal never rewrites the store.
pub async fn set_my_name_in_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    key: &MemberNamesKey<'_>,
    writer: &MemberNamesWriter<'_>,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
    name: &str,
) -> Result<MemberNamesMap, MemberNamesError> {
    let canonical = canonical_name(name)?;
    let mut map = read_member_names_in_dir(io, vault_dir, key).await?;
    let id = person_id_hex(writer.person_id);
    let version = next_version(&map, &id);
    let row = sign_member_name(
        writer.person,
        writer.person_id,
        version,
        false,
        &canonical,
        rng,
    )
    .map_err(|_| MemberNamesError::Codec)?;
    map.insert(id, row);
    write_member_names_in_dir(io, vault_dir, key, &map).await?;
    Ok(map)
}

/// Clear the caller's own name by writing a SELF-SIGNED tombstone. Clearing is a
/// distinct operation from renaming, which is why an empty `name` is refused above
/// rather than treated as a clear.
pub async fn clear_my_name_in_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    key: &MemberNamesKey<'_>,
    writer: &MemberNamesWriter<'_>,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<MemberNamesMap, MemberNamesError> {
    let mut map = read_member_names_in_dir(io, vault_dir, key).await?;
    let id = person_id_hex(writer.person_id);
    let version = next_version(&map, &id);
    let row = sign_member_name(writer.person, writer.person_id, version, true, "", rng)
        .map_err(|_| MemberNamesError::Codec)?;
    map.insert(id, row);
    write_member_names_in_dir(io, vault_dir, key, &map).await?;
    Ok(map)
}

/// Tombstone another member's row, signed by the vault OWNER. This is how a name goes
/// away when a member is removed from the vault, and it is the only way a row that is
/// not the caller's own is ever written: an owner signature is accepted on the READ
/// side for a tombstone only, never for a live name.
///
/// **Nothing in the tree calls this, and the consequence is not cosmetic.** A member
/// removed from the vault keeps a LIVE row in the synced name map: the row's signature
/// is still valid, so every device renders their name, and no other path can clear it
/// (`member_names_set_mine` / `_clear_mine` touch the caller's own row only). The
/// rotation that removes them re-seals and re-addresses the map without touching the
/// row. So the wiring owed here is not "a nicer tombstone": until it lands, removal
/// does not remove a name. Two things the wiring must get right, neither of them
/// visible from this function: it has to be called with the session already on the
/// rotation's NEW group tier (a tombstone sealed at the retired epoch is one no reader
/// can open), and it has to take the same two gates every other writer of this blob
/// takes (`store::write_mutex` states them). Tracked by `myne-md/myne#797`; recorded in
/// the feature's `progress.md`.
pub async fn tombstone_member_in_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    key: &MemberNamesKey<'_>,
    owner: &protocol::PersonKeyPair,
    member_person_id: &[u8; 16],
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<MemberNamesMap, MemberNamesError> {
    let mut map = read_member_names_in_dir(io, vault_dir, key).await?;
    let id = person_id_hex(member_person_id);
    let version = next_version(&map, &id);
    let row = sign_member_name(owner, member_person_id, version, true, "", rng)
        .map_err(|_| MemberNamesError::Codec)?;
    map.insert(id, row);
    write_member_names_in_dir(io, vault_dir, key, &map).await?;
    Ok(map)
}

/// Merge a PULLED copy of the blob into the local map, entry by entry, and persist the
/// result. A pulled copy that does not decode is refused rather than merged as empty
/// (the same direction the read path takes), because `merge(local, empty) == local`
/// would silently discard a peer's rename.
pub async fn merge_pulled_blob_in_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    key: &MemberNamesKey<'_>,
    pulled: &[u8],
) -> Result<MemberNamesMap, MemberNamesError> {
    let local = read_member_names_in_dir(io, vault_dir, key).await?;
    let remote = decode_member_names_blob(
        key.key,
        key.account_number_hash,
        key.group_key_epoch,
        pulled,
    )
    .map_err(|_| MemberNamesError::Codec)?;
    let merged = merge_member_names(&local, &remote);
    write_member_names_in_dir(io, vault_dir, key, &merged).await?;
    Ok(merged)
}

/// How many rows a member list would render: the live view's size. A tombstone is a
/// merge input, not a row a user sees.
pub fn live_row_count(map: &MemberNamesMap) -> usize {
    protocol::live_member_names(map).len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{block_on, ScopedTempDir};
    use crate::vault_io::StdVaultIo;
    use rand_core::{TryCryptoRng, TryRng};
    use sha2::Digest as _;

    const ACCT: [u8; 16] = [0x33; 16];
    const EPOCH: u64 = 4;

    fn key() -> [u8; AEAD_KEY_LEN] {
        [0x44; AEAD_KEY_LEN]
    }

    fn hash32(label: &[u8]) -> [u8; 32] {
        let mut out = [0u8; 32];
        out.copy_from_slice(&sha2::Sha256::digest(label));
        out
    }

    fn pair(label: &[u8]) -> protocol::PersonKeyPair {
        let mut kem = [0u8; protocol::person_key::PERSON_DK_SEED_LEN];
        kem[..32].copy_from_slice(&hash32(label));
        kem[32..].copy_from_slice(&hash32(label));
        protocol::PersonKeyPair::generate_raw(&kem, &hash32(label), &hash32(label))
    }

    struct SeededRng(u64);

    impl TryRng for SeededRng {
        type Error = core::convert::Infallible;
        fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
            self.0 = self.0.wrapping_add(1);
            Ok(self.0 as u32)
        }
        fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
            self.0 = self.0.wrapping_add(1);
            Ok(self.0)
        }
        fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
            let mut off = 0;
            while off < dst.len() {
                self.0 = self.0.wrapping_add(1);
                let digest = sha2::Sha256::digest(self.0.to_le_bytes());
                let n = core::cmp::min(32, dst.len() - off);
                dst[off..off + n].copy_from_slice(&digest[..n]);
                off += n;
            }
            Ok(())
        }
    }

    impl TryCryptoRng for SeededRng {}

    fn person_id(byte: u8) -> [u8; 16] {
        [byte; 16]
    }

    #[test]
    fn write_read_clear_round_trip_and_the_version_climbs() {
        let dir = ScopedTempDir::new("member-names").unwrap();
        let io = StdVaultIo;
        let k = key();
        let key_ref = MemberNamesKey {
            key: &k,
            account_number_hash: &ACCT,
            group_key_epoch: EPOCH,
        };
        let ann = pair(b"ann");
        let ann_id = person_id(0x11);
        let w = MemberNamesWriter {
            person: &ann,
            person_id: &ann_id,
        };
        let mut rng = SeededRng(1);

        // Absent file: the empty map, not an error.
        let empty = block_on(read_member_names_in_dir(&io, dir.path(), &key_ref)).expect("read");
        assert!(empty.is_empty());

        let after = block_on(set_my_name_in_dir(
            &io,
            dir.path(),
            &key_ref,
            &w,
            &mut rng,
            "  Ada  ",
        ))
        .expect("set");
        let id_hex = person_id_hex(&ann_id);
        assert_eq!(after.get(&id_hex).unwrap().name, "Ada", "trimmed");
        assert_eq!(after.get(&id_hex).unwrap().version, 1);

        // A second write to the same row climbs the version rather than reusing it.
        let after2 = block_on(set_my_name_in_dir(
            &io,
            dir.path(),
            &key_ref,
            &w,
            &mut rng,
            "Ada L",
        ))
        .expect("set again");
        assert_eq!(after2.get(&id_hex).unwrap().version, 2);
        assert_eq!(live_row_count(&after2), 1);

        // Clear writes a self-signed tombstone; the live view drops it but the row
        // stays on disk so a stale copy cannot resurrect it.
        let cleared = block_on(clear_my_name_in_dir(
            &io,
            dir.path(),
            &key_ref,
            &w,
            &mut rng,
        ))
        .expect("clear");
        assert!(cleared.get(&id_hex).unwrap().tombstone);
        assert_eq!(live_row_count(&cleared), 0);
        let reread = block_on(read_member_names_in_dir(&io, dir.path(), &key_ref)).expect("read");
        assert!(reread.get(&id_hex).unwrap().tombstone);
    }

    #[test]
    fn an_empty_or_oversized_name_is_refused_before_the_store_is_touched() {
        let dir = ScopedTempDir::new("member-names").unwrap();
        let io = StdVaultIo;
        let k = key();
        let key_ref = MemberNamesKey {
            key: &k,
            account_number_hash: &ACCT,
            group_key_epoch: EPOCH,
        };
        let ann = pair(b"ann");
        let ann_id = person_id(0x11);
        let w = MemberNamesWriter {
            person: &ann,
            person_id: &ann_id,
        };
        let mut rng = SeededRng(2);
        assert_eq!(
            block_on(set_my_name_in_dir(
                &io,
                dir.path(),
                &key_ref,
                &w,
                &mut rng,
                "   "
            ))
            .unwrap_err(),
            MemberNamesError::NameEmpty
        );
        let long = "x".repeat(MAX_MEMBER_NAME_LEN + 1);
        assert_eq!(
            block_on(set_my_name_in_dir(
                &io,
                dir.path(),
                &key_ref,
                &w,
                &mut rng,
                &long
            ))
            .unwrap_err(),
            MemberNamesError::NameTooLong {
                max: MAX_MEMBER_NAME_LEN
            }
        );
        // Nothing was written by either refusal.
        assert!(
            block_on(read_member_names_in_dir(&io, dir.path(), &key_ref))
                .expect("read")
                .is_empty()
        );
    }

    #[test]
    fn a_concurrent_rename_of_a_different_row_survives_the_merge() {
        let dir = ScopedTempDir::new("member-names").unwrap();
        let io = StdVaultIo;
        let k = key();
        let key_ref = MemberNamesKey {
            key: &k,
            account_number_hash: &ACCT,
            group_key_epoch: EPOCH,
        };
        let ann = pair(b"ann");
        let bob = pair(b"bob");
        let (ann_id, bob_id) = (person_id(0x11), person_id(0x22));
        let mut rng = SeededRng(3);

        block_on(set_my_name_in_dir(
            &io,
            dir.path(),
            &key_ref,
            &MemberNamesWriter {
                person: &ann,
                person_id: &ann_id,
            },
            &mut rng,
            "Ada",
        ))
        .expect("ann");

        // A "pulled" copy carrying only Bob's row, as a second device would produce.
        let mut remote = MemberNamesMap::new();
        remote.insert(
            person_id_hex(&bob_id),
            sign_member_name(&bob, &bob_id, 1, false, "Grace", &mut rng).expect("sign"),
        );
        let blob = encode_member_names_blob(&k, &ACCT, EPOCH, &remote).expect("seal");
        let merged =
            block_on(merge_pulled_blob_in_dir(&io, dir.path(), &key_ref, &blob)).expect("merge");
        assert_eq!(merged.len(), 2, "both rows survive");
        assert_eq!(merged.get(&person_id_hex(&ann_id)).unwrap().name, "Ada");
        assert_eq!(merged.get(&person_id_hex(&bob_id)).unwrap().name, "Grace");
    }

    #[test]
    fn an_owner_signed_tombstone_removes_another_members_row() {
        let dir = ScopedTempDir::new("member-names").unwrap();
        let io = StdVaultIo;
        let k = key();
        let key_ref = MemberNamesKey {
            key: &k,
            account_number_hash: &ACCT,
            group_key_epoch: EPOCH,
        };
        let ann = pair(b"ann");
        let owner = pair(b"owner");
        let ann_id = person_id(0x11);
        let mut rng = SeededRng(4);
        block_on(set_my_name_in_dir(
            &io,
            dir.path(),
            &key_ref,
            &MemberNamesWriter {
                person: &ann,
                person_id: &ann_id,
            },
            &mut rng,
            "Ada",
        ))
        .expect("ann");
        let after = block_on(tombstone_member_in_dir(
            &io,
            dir.path(),
            &key_ref,
            &owner,
            &ann_id,
            &mut rng,
        ))
        .expect("tombstone");
        let row = after.get(&person_id_hex(&ann_id)).expect("row");
        assert!(row.tombstone);
        assert_eq!(row.version, 2, "above the row it replaces");
        // The owner's signature is accepted for the removal, and NOT as Ann's name.
        assert!(protocol::verify_member_removal(
            &owner.public_half(),
            &ann_id,
            row
        ));
        assert!(!protocol::verify_member_name(
            &ann.public_half(),
            &ann_id,
            row
        ));
        assert_eq!(live_row_count(&after), 0);
    }

    #[test]
    fn an_undecryptable_store_is_an_error_rather_than_an_empty_map() {
        let dir = ScopedTempDir::new("member-names").unwrap();
        let io = StdVaultIo;
        let k = key();
        let key_ref = MemberNamesKey {
            key: &k,
            account_number_hash: &ACCT,
            group_key_epoch: EPOCH,
        };
        // A file with our magic but a body no key opens: the store EXISTS and is
        // unreadable, which must not read as "no names".
        let mut blob = Vec::from(*b"MYO5");
        blob.extend_from_slice(&[0x01, 0x01]);
        blob.extend_from_slice(&[0u8; 24]);
        blob.extend_from_slice(&8u32.to_be_bytes());
        blob.extend_from_slice(&[0u8; 8]);
        block_on(io.write(
            &dir.path().join(MEMBER_NAMES_FILE),
            &blob,
            WriteOpts::default(),
        ))
        .expect("write");
        assert_eq!(
            block_on(read_member_names_in_dir(&io, dir.path(), &key_ref)).unwrap_err(),
            MemberNamesError::StoreUnreadable
        );
    }
}
