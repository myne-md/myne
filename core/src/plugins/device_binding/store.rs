// SPDX-License-Identifier: AGPL-3.0

//! The device-binding store: the read-modify-write against `vault.device-bindings`,
//! with no host and no session in sight.
//!
//! Every entry point takes [`DeviceBindingKey`] (the derived group-tier KEK plus the two
//! bindings the seal needs), and the writers additionally take the signing person and
//! the device id the row is keyed by, so the whole module runs over a temp vault
//! directory. The command layer resolves those from a live session; that split is what
//! makes `cargo test -p myne-core --lib plugins::device_binding` exercise the real
//! read-modify-write rather than a mock.

use super::error::DeviceBindingError;
use super::DEVICE_BINDINGS_FILE;
use crate::vault_io::{VaultIo, WriteOpts};
use protocol::aead::AEAD_KEY_LEN;
use protocol::{
    decode_device_binding_blob, encode_device_binding_blob, merge_device_bindings,
    sign_device_binding, DeviceBindingsMap,
};
use std::path::Path;
use std::sync::OnceLock;
use tokio::sync::Mutex;

/// Per-plugin write serialization, the `member_names` / `themes` / `prefs` mutex twin.
/// Every read-modify-write of the whole-map blob takes it, so consecutive mutations
/// commit FIFO and never lose an update.
///
/// It exists because this family has a SECOND writer that the command layer cannot see:
/// the sync orchestrator's `vault.device-bindings` phase merges a pulled copy into the
/// same map. Without one lock across both, a claim landing between the phase's read and
/// its write is overwritten by the merge, and the device silently falls out of the map
/// it just claimed itself into.
///
/// **This mutex is only HALF the gate a writer owes.** A writer must ALSO hold
/// `crate::singleton_quiesce::shared()` across the whole read-modify-write, taken right
/// after this lock, exactly as `member_names::store::write_mutex` states the pair. This
/// blob is a shared singleton whose KEK comes from the group tier, so a group rotation
/// re-seals it at a new `group_key_epoch` under the exclusive side of that barrier; a
/// write that read under the retired epoch and lands after the rotation publishes a blob
/// no session can open, and the next read collapses it to the empty map over every
/// member's real row.
///
/// The writers are `claim_own_binding_with_dir` (the unlock-time claim and the command)
/// and `sync_device_bindings_phase` in `plugins/sync/orchestrator.rs`. The member-removal
/// tombstone is written by `sync::member_removal::rotate_group_from_host`, which holds the
/// EXCLUSIVE side of the barrier for the whole rotation and therefore already excludes the
/// shared side every other writer takes.
pub fn write_mutex() -> &'static Mutex<()> {
    static M: OnceLock<Mutex<()>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(()))
}

/// The derived key and the bindings one seal needs. `group_key_epoch` rides the AAD,
/// so a blob sealed in a retired epoch fails the AEAD rather than being read under a
/// key that no longer applies.
pub struct DeviceBindingKey<'a> {
    /// `derive_group_subkey_v0_2(group_key, GroupRole::DeviceBindingKey)`.
    pub key: &'a [u8; AEAD_KEY_LEN],
    /// The vault's `account_number_hash`, from `vault.meta`.
    pub account_number_hash: &'a [u8; 16],
    /// The vault's live group-key epoch.
    pub group_key_epoch: u64,
}

/// Whether a claim actually wrote, so a caller (and the test that pins the idempotence)
/// can tell a no-op from a real write rather than inferring it from a file mtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClaimOutcome {
    /// The row was already present, live, and bound to this very person. Nothing was
    /// written and the file's bytes are untouched.
    AlreadyCurrent,
    /// A row was written: the device had no row, its row named a different person (an
    /// identity change), or its row was tombstoned.
    Written,
    /// **Nothing was decided, and nothing was written.** The key store refused to answer, so
    /// the claim could not tell "this device has no key" from "this device's key is
    /// unreachable", and either write would be a guess. Distinct from `AlreadyCurrent`
    /// because the logs are the whole forensic trail for this defect class: reporting
    /// "already current" for a device with no row at all is the opposite of the state
    /// (myne-md/myne#983 review, D8).
    Deferred,
}

/// Lowercase hex, the rendering every id in this family uses. The device id and the
/// person fingerprint are both public material (a device is a device, and a fingerprint
/// is a hash of a public key), so nothing here needs zeroizing.
pub fn device_id_hex(device_id: &[u8; 16]) -> String {
    crate::account::person_identity::hex_lower(device_id)
}

fn fingerprint_hex(fingerprint: &[u8; protocol::person_key::PERSON_FINGERPRINT_LEN]) -> String {
    crate::account::person_identity::hex_lower(fingerprint)
}

/// Read the map. `NotFound` is the empty map, because a vault where no device has claimed
/// itself is a vault with no bindings and that is the fact. A file that exists but does
/// not decrypt is an ERROR, not an empty map: answering empty for a damaged store is what
/// lets the next write persist that emptiness over every other device's real row, and the
/// rows it drops carry no tombstone for a later merge to notice
/// (`device_binding_blob.rs` "Fall-back-to-empty" states the shape).
pub async fn read_device_bindings_in_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    key: &DeviceBindingKey<'_>,
) -> Result<DeviceBindingsMap, DeviceBindingError> {
    use crate::singleton::{open_newest_and_sweep, OpenOutcome};
    match open_newest_and_sweep(io, &vault_dir.join(DEVICE_BINDINGS_FILE), |bytes| {
        decode_device_binding_blob(key.key, key.account_number_hash, key.group_key_epoch, bytes)
    })
    .await
    {
        Ok(map) => Ok(map),
        Err(OpenOutcome::Absent) => Ok(DeviceBindingsMap::new()),
        Err(OpenOutcome::Io(io_error_kind)) => Err(DeviceBindingError::Io { io_error_kind }),
        Err(OpenOutcome::Undecodable(_)) => {
            tracing::warn!(
                event = "device_bindings_undecryptable",
                "vault.device-bindings exists but no copy could be decrypted; refusing to treat it as empty"
            );
            Err(DeviceBindingError::StoreUnreadable)
        }
    }
}

/// Seal `map` and write it at the vault root. An EMPTY map removes the file instead
/// (best effort), so an empty store leaves no file and reads back as empty.
pub async fn write_device_bindings_in_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    key: &DeviceBindingKey<'_>,
    map: &DeviceBindingsMap,
) -> Result<(), DeviceBindingError> {
    let path = vault_dir.join(DEVICE_BINDINGS_FILE);
    if map.is_empty() {
        let _ = io.remove_file(&path).await;
        return Ok(());
    }
    let blob =
        encode_device_binding_blob(key.key, key.account_number_hash, key.group_key_epoch, map)
            .map_err(|_| DeviceBindingError::Codec)?;
    io.write(&path, &blob, WriteOpts::default())
        .await
        .map_err(|io_error_kind| DeviceBindingError::Io { io_error_kind })
}

/// The version a new row takes: strictly ABOVE whatever the row holds, so a stale copy
/// can never win the merge. A row's version is a counter rather than a clock, because a
/// clock skew between two devices must not decide which binding wins (`beats` states the
/// tie-break the counter feeds).
fn next_version(map: &DeviceBindingsMap, device_hex: &str) -> u64 {
    map.get(device_hex)
        .map(|entry| entry.version.saturating_add(1))
        .unwrap_or(1)
}

/// Claim `device_id` for `person`, signed by that very person. Idempotent: a row that is
/// already present, live and bound to this person is left exactly as it is, so an unlock
/// that finds a current binding writes nothing at all.
///
/// Writes in three cases, and the rule is stated rather than implied because the third is
/// a policy this layer owns rather than one the codec dictates:
///
/// - the device has no row (the first claim);
/// - the row names a DIFFERENT person, which is the identity change that would otherwise
///   orphan the device, so it is re-written at a strictly higher version;
/// - the row is a tombstone. The codec's own `beats` gives a tombstone the win only at an
///   EQUAL version, so a strictly higher re-claim is the re-bind it was written to allow;
///   what a removal is actually enforced by is the group-key rotation, after which the
///   removed device cannot open the re-sealed map at all, not by the row (see
///   `merge_device_bindings` and `beats`).
pub async fn claim_self_in_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    key: &DeviceBindingKey<'_>,
    person: &protocol::PersonKeyPair,
    device_id: &[u8; 16],
    device_public: Option<&protocol::device_key::DevicePublicHalf>,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<(DeviceBindingsMap, ClaimOutcome), DeviceBindingError> {
    claim_self_in_dir_with(
        io,
        vault_dir,
        key,
        person,
        device_id,
        device_public,
        rng,
        false,
    )
    .await
}

/// Re-write this device's own row at a strictly higher version, whether or not the row it
/// finds is already current. This is the ONE write that can separate a `ConflictingBinding`.
///
/// `beats` resolves a disagreement by version first, so two rows for one device that hold the
/// SAME version and name different people (or carry different device halves) have no winner
/// and `merge_device_bindings` answers `ConflictingBinding` for the WHOLE map. One such row
/// therefore freezes the binding store for every member on every later cycle, silently, and
/// the only side of that pair this device may move is its own. Writing it at `version + 1`
/// makes this device's copy strictly newer, and the ordinary merge then resolves in its
/// favour.
///
/// **It repairs a conflict and nothing else.** It cannot stop a peer holding the group key
/// from writing a row naming someone else, and it does not make that row verify: attribution
/// stays legibility rather than proof (§9.30.4). What it stops is the forgery ALSO being a
/// permanent denial of the store. Bounded to one write per cycle by the caller, under the
/// same two gates as every other writer.
pub async fn reclaim_self_in_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    key: &DeviceBindingKey<'_>,
    person: &protocol::PersonKeyPair,
    device_id: &[u8; 16],
    device_public: Option<&protocol::device_key::DevicePublicHalf>,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<(DeviceBindingsMap, ClaimOutcome), DeviceBindingError> {
    claim_self_in_dir_with(
        io,
        vault_dir,
        key,
        person,
        device_id,
        device_public,
        rng,
        true,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn claim_self_in_dir_with(
    io: &dyn VaultIo,
    vault_dir: &Path,
    key: &DeviceBindingKey<'_>,
    person: &protocol::PersonKeyPair,
    device_id: &[u8; 16],
    device_public: Option<&protocol::device_key::DevicePublicHalf>,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
    bump: bool,
) -> Result<(DeviceBindingsMap, ClaimOutcome), DeviceBindingError> {
    let mut map = read_device_bindings_in_dir(io, vault_dir, key).await?;
    let id = device_id_hex(device_id);
    let mine = fingerprint_hex(person.fingerprint());
    if let Some(existing) = map.get(&id) {
        // Current means: live, naming this person, AND (when this device holds a
        // device key) carrying that key's public half. The third clause is what makes
        // an upgraded device re-sign itself ONCE: a `v1` row that names the right
        // person is otherwise "current" forever, and its device key would never be
        // published, so the device could never author a `0x03` head that peers resolve.
        // `None` means this device CANNOT publish halves: either the platform keeps no
        // device key at all, or the store would not give back the one it was asked for. A
        // row that already publishes halves is therefore NOT current, which is the whole
        // repair: it is rewritten as a `v1` row one version up, so peers stop resolving a
        // signer that no longer exists and this device falls back to the person signature
        // until a later unlock can publish again (myne-md/myne#983). Treating `None` as a
        // match made that repair a no-op on exactly the state it exists for.
        let halves_match = match device_public {
            None => !crate::plugins::sync::authority::row_publishes_halves(existing),
            Some(public) => {
                existing.device_ed_pk.as_deref() == Some(public.ed_pk_hex().as_str())
                    && existing.device_mldsa_vk.as_deref() == Some(public.mldsa_vk_hex().as_str())
            }
        };
        if !bump && !existing.tombstone && existing.person_fingerprint == mine && halves_match {
            return Ok((map, ClaimOutcome::AlreadyCurrent));
        }
    }
    let version = next_version(&map, &id);
    // A row written by a device that holds a device key is a `v2` row: the halves go
    // INSIDE the person's signature, which is what lets a peer verify the heads that
    // device authors (`decisions/protocol/0733` decision 3). A platform with no
    // storage rung keeps writing a `v1` row, unchanged.
    let row = match device_public {
        Some(public) => protocol::sign_device_binding_v2(
            person,
            device_id,
            person.fingerprint(),
            version,
            false,
            public,
            rng,
        ),
        None => sign_device_binding(person, device_id, person.fingerprint(), version, false, rng),
    }
    .map_err(|_| DeviceBindingError::Codec)?;
    map.insert(id, row);
    write_device_bindings_in_dir(io, vault_dir, key, &map).await?;
    Ok((map, ClaimOutcome::Written))
}

/// Bind `device_id` to `person` on ANOTHER device's behalf, signed by that person
/// (`decisions/protocol/0735`).
///
/// This is `claim_self_in_dir`'s sibling, and the difference is the whole feature: the
/// person key signs a row for a device that is not this one, because a device that joined
/// without the recovery phrase holds no person key and therefore cannot claim itself. The
/// admitting device does hold one, and it is the device the user already trusts.
///
/// Idempotent in the same direction: a row that is live, names this person and carries
/// these halves is left alone. A tombstone is re-claimed at a strictly higher version, the
/// re-bind `beats` was written to allow; what enforces a removal is the group-key rotation,
/// not the row.
pub async fn admit_other_in_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    key: &DeviceBindingKey<'_>,
    person: &protocol::PersonKeyPair,
    device_id: &[u8; 16],
    device_public: Option<&protocol::device_key::DevicePublicHalf>,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<(DeviceBindingsMap, ClaimOutcome), DeviceBindingError> {
    let mut map = read_device_bindings_in_dir(io, vault_dir, key).await?;
    let id = device_id_hex(device_id);
    let mine = fingerprint_hex(person.fingerprint());
    if let Some(existing) = map.get(&id) {
        let halves_match = match device_public {
            // Deliberately NOT the self-claim's rule. The self-claim knows whether its OWN
            // store answered, because it just read it; this path only knows what the joining
            // device chose to SEND, and "sent no halves" cannot be told from "has no halves".
            // Demoting another device's published key on that basis would strip it with the
            // admitting owner's signature, one version up, so the row is left alone and that
            // device repairs itself on its own next claim (myne-md/myne#983 review, D4+D8).
            None => true,
            Some(public) => {
                existing.device_ed_pk.as_deref() == Some(public.ed_pk_hex().as_str())
                    && existing.device_mldsa_vk.as_deref() == Some(public.mldsa_vk_hex().as_str())
            }
        };
        if !existing.tombstone && existing.person_fingerprint == mine && halves_match {
            return Ok((map, ClaimOutcome::AlreadyCurrent));
        }
    }
    let version = next_version(&map, &id);
    let row = match device_public {
        Some(public) => protocol::sign_device_binding_v2(
            person,
            device_id,
            person.fingerprint(),
            version,
            false,
            public,
            rng,
        ),
        None => sign_device_binding(person, device_id, person.fingerprint(), version, false, rng),
    }
    .map_err(|_| DeviceBindingError::Codec)?;
    map.insert(id, row);
    write_device_bindings_in_dir(io, vault_dir, key, &map).await?;
    Ok((map, ClaimOutcome::Written))
}

/// Merge a PULLED copy of the blob into the local map, entry by entry, and persist the
/// result. A pulled copy that does not decode is refused rather than merged as empty
/// (the same direction the read path takes), because `merge(local, empty) == local` would
/// silently discard a peer's claim.
///
/// The second value is whether the map moved: `false` means the merge was a no-op, so the
/// caller can adopt the pulled bytes verbatim instead of re-encrypting an already
/// agreeing store under a fresh nonce and pushing it forever.
pub async fn merge_pulled_blob_in_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    key: &DeviceBindingKey<'_>,
    pulled: &[u8],
) -> Result<(DeviceBindingsMap, bool), DeviceBindingError> {
    let local = read_device_bindings_in_dir(io, vault_dir, key).await?;
    let remote = decode_device_binding_blob(
        key.key,
        key.account_number_hash,
        key.group_key_epoch,
        pulled,
    )
    .map_err(|_| DeviceBindingError::Codec)?;
    // `merge_device_bindings` has exactly ONE refusal, and it is not a malformed-map
    // refusal: two copies carry the same device under two DIFFERENT people at the SAME
    // version, which has no winner. It is surfaced as its own arm so the caller can retry
    // with a fresh claim rather than read it as corruption.
    let merged = merge_device_bindings(&local, &remote)
        .map_err(|_| DeviceBindingError::ConflictingBinding)?;
    if merged == local {
        return Ok((local, false));
    }
    write_device_bindings_in_dir(io, vault_dir, key, &merged).await?;
    Ok((merged, true))
}

/// Tombstone every live row bound to `person_fingerprint_hex`, signed by the vault OWNER,
/// and persist the result: the read-modify-write wrapper over [`tombstone_devices_for_person`]
/// for a caller that holds no staged batch of its own.
///
/// **A member removal does NOT go through here.** That path is
/// `sync::member_removal`'s step (5d), which calls `tombstone_devices_for_person` directly and
/// stages the result into the rotation's single commit, because this wrapper writes to disk
/// and writing the retired epoch's ciphertext before the new one exists would open a window
/// in which the map is on disk in a form nobody can open. So the callers of this function
/// today are the tests that want the persisted round trip, not production; it stays because
/// the owner tombstone write is a coherent entry point a device-retirement flow would want,
/// and because it is the only way a row that is not the caller's own is ever written: an
/// owner signature is accepted on the READ side for a tombstone only, never for a live row
/// (`verify_device_binding_removal` refuses a live one).
///
/// Keyed by the removed person's FINGERPRINT rather than by a device id, deliberately and
/// not as a convenience: the operation a removal performs is "this person's devices stop
/// being bound", and a device-id keyed entry point is exactly what a single-device
/// retirement would reach for. A retired device keeps its binding, because its past
/// revisions were genuinely that person's, so no caller here has a device to name.
///
/// Returns the live rows it tombstoned, which is what a test asserts is non-empty and a
/// caller can log. Idempotent: an already-tombstoned row is skipped, so a retried removal
/// does not climb the version counter.
pub async fn tombstone_member_devices_in_dir(
    io: &dyn VaultIo,
    vault_dir: &Path,
    key: &DeviceBindingKey<'_>,
    owner: &protocol::PersonKeyPair,
    person_fingerprint_hex: &str,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<(DeviceBindingsMap, usize), DeviceBindingError> {
    let map = read_device_bindings_in_dir(io, vault_dir, key).await?;
    let (map, tombstoned) = tombstone_devices_for_person(map, owner, person_fingerprint_hex, rng)?;
    if tombstoned > 0 {
        write_device_bindings_in_dir(io, vault_dir, key, &map).await?;
    }
    Ok((map, tombstoned))
}

/// The map half of the removal tombstone, split out because the group rotation needs it
/// WITHOUT the write: a removal re-seals the whole store from the retired epoch to the new
/// one and must stage the tombstoned map into that single re-seal, not write the old epoch's
/// ciphertext to disk first and re-seal a moment later (the window in between is exactly
/// what `singleton_quiesce` exists to close, and it is wider than one write).
///
/// One definition of "who this removal tombstones" and one signer, so the direct path and
/// the rotation path cannot diverge on which rows go away.
pub fn tombstone_devices_for_person(
    mut map: DeviceBindingsMap,
    owner: &protocol::PersonKeyPair,
    person_fingerprint_hex: &str,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<(DeviceBindingsMap, usize), DeviceBindingError> {
    let targets: Vec<String> = map
        .iter()
        .filter(|(_, entry)| !entry.tombstone && entry.person_fingerprint == person_fingerprint_hex)
        .map(|(device, _)| device.clone())
        .collect();
    if targets.is_empty() {
        return Ok((map, 0));
    }
    let Some(fingerprint) = decode_fingerprint_hex(person_fingerprint_hex) else {
        return Err(DeviceBindingError::Codec);
    };
    for device in &targets {
        let Some(device_id) = decode_device_id_hex(device) else {
            return Err(DeviceBindingError::Codec);
        };
        let version = next_version(&map, device);
        let row = sign_device_binding(owner, &device_id, &fingerprint, version, true, rng)
            .map_err(|_| DeviceBindingError::Codec)?;
        map.insert(device.clone(), row);
    }
    Ok((map, targets.len()))
}

/// How many rows a device list would render: the live view's size. A tombstone is a merge
/// input, not a row a user sees.
pub fn live_row_count(map: &DeviceBindingsMap) -> usize {
    protocol::live_device_bindings(map).len()
}

// Lenient (`protocol::hex::decode_ci`): both values arrive inside a peer's
// device-binding row, so their case is not this client's to fix (R1.2).
fn decode_device_id_hex(s: &str) -> Option<[u8; 16]> {
    protocol::hex::decode_ci(s)
}

fn decode_fingerprint_hex(s: &str) -> Option<[u8; protocol::person_key::PERSON_FINGERPRINT_LEN]> {
    protocol::hex::decode_ci(s)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{block_on, ScopedTempDir};
    use crate::vault_io::StdVaultIo;
    use protocol::{verify_device_binding, verify_device_binding_removal};
    use rand_core::{TryCryptoRng, TryRng};
    use sha2::Digest as _;

    const ACCT: [u8; 16] = [0x33; 16];
    const EPOCH: u64 = 4;
    /// Three distinct enrolled device ids, so a test can tell "this device" from
    /// "that device" without a real enrollment.
    const DEV_A: [u8; 16] = [0xA1; 16];
    const DEV_B: [u8; 16] = [0xB2; 16];
    const DEV_C: [u8; 16] = [0xC3; 16];

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

    /// Run `f` with a [`DeviceBindingKey`] borrowed from a buffer that outlives
    /// the call, so the key struct never points at a temporary.
    fn with_key<T>(f: impl FnOnce(&DeviceBindingKey<'_>) -> T) -> T {
        let k = key();
        f(&DeviceBindingKey {
            key: &k,
            account_number_hash: &ACCT,
            group_key_epoch: EPOCH,
        })
    }

    /// The bytes the store actually holds, read back through the same seam the
    /// sync phase reads. `None` when the file is absent, which is how an empty
    /// store is represented.
    fn stored_bytes(io: &StdVaultIo, dir: &Path) -> Option<Vec<u8>> {
        block_on(io.read(&dir.join(DEVICE_BINDINGS_FILE))).ok()
    }

    /// Acceptance criterion 1: unlocking a vault writes this device's binding
    /// once, and a second unlock writes nothing new.
    ///
    /// Both halves matter. The first is the feature. The second is what keeps an
    /// unlock loop from re-sealing the whole map on every launch: the file's bytes
    /// must be literally untouched, not merely equal after a re-encrypt, because a
    /// fresh nonce is what the sync phase reads as "this device has something to
    /// push" and a claim that churns would push the same map forever.
    #[test]
    fn an_unlock_claims_once_and_the_second_unlock_writes_nothing() {
        let dir = ScopedTempDir::new("device-binding-claim").unwrap();
        let io = StdVaultIo;
        let me = pair(b"me");
        let mut rng = SeededRng(1);

        with_key(|k| {
            let (map, outcome) = block_on(claim_self_in_dir(
                &io,
                dir.path(),
                k,
                &me,
                &DEV_A,
                None,
                &mut rng,
            ))
            .expect("first claim");
            assert_eq!(outcome, ClaimOutcome::Written);
            assert_eq!(live_row_count(&map), 1);
            let row = map.get(&device_id_hex(&DEV_A)).expect("the row exists");
            assert_eq!(row.version, 1, "a first claim starts the counter");
            assert!(!row.tombstone);
            assert_eq!(row.person_fingerprint, fingerprint_hex(me.fingerprint()));
            assert!(
                verify_device_binding(&me.public_half(), &DEV_A, row),
                "the row verifies against the signer's own public half, and against no other"
            );
            assert!(
                !verify_device_binding(&pair(b"someone-else").public_half(), &DEV_A, row),
                "a co-member's public half does NOT verify this row: the claimed fingerprint \
                 must equal the verifying key's own fingerprint"
            );
            let first = stored_bytes(&io, dir.path()).expect("the store exists after a claim");

            let (again, outcome2) = block_on(claim_self_in_dir(
                &io,
                dir.path(),
                k,
                &me,
                &DEV_A,
                None,
                &mut rng,
            ))
            .expect("second claim");
            assert_eq!(
                outcome2,
                ClaimOutcome::AlreadyCurrent,
                "a row that is present, live and bound to this very person is left alone"
            );
            assert_eq!(live_row_count(&again), 1);
            assert_eq!(
                again.get(&device_id_hex(&DEV_A)).unwrap().version,
                1,
                "the version counter did not climb on a no-op"
            );
            let second = stored_bytes(&io, dir.path()).expect("the store still exists");
            assert_eq!(
                first, second,
                "byte-identical: the second unlock re-sealed nothing at all"
            );
        });
    }

    /// The ONE write that separates a `ConflictingBinding` pair (myne-md/myne#976).
    ///
    /// The codec refuses the WHOLE map when two copies bind one device to two people at the
    /// same version, so one such row froze the store for every member on every later cycle,
    /// silently and permanently. A device may only move its OWN side, so the repair is
    /// [`reclaim_self_in_dir`]: the same claim, at a strictly higher version, whether or not
    /// the row it finds already looks current.
    ///
    /// **Why the assertion is the MERGE and not the version.** Reverting the bump leaves
    /// every other assertion here true: the row is still this device's, still verifies, and
    /// `claim_self_in_dir` reports `AlreadyCurrent`, which is a perfectly good outcome for a
    /// claim. What breaks is the pair, and the pair is what the repair exists for: the
    /// version climb is only how it is achieved.
    #[test]
    fn a_reclaim_at_a_higher_version_separates_a_conflict() {
        let dir = ScopedTempDir::new("device-binding-reclaim").unwrap();
        let io = StdVaultIo;
        let me = pair(b"me");
        let them = pair(b"them");
        let mut rng = SeededRng(7);

        with_key(|k| {
            block_on(claim_self_in_dir(
                &io,
                dir.path(),
                k,
                &me,
                &DEV_A,
                None,
                &mut rng,
            ))
            .expect("the first claim");
            let claimed = block_on(read_device_bindings_in_dir(&io, dir.path(), k))
                .expect("read back the claim");
            assert_eq!(claimed.get(&device_id_hex(&DEV_A)).unwrap().version, 1);

            // A peer's copy of the SAME device bound to a DIFFERENT person at the SAME
            // version: the one pair `merge_device_bindings` refuses.
            let mut their_copy = protocol::DeviceBindingsMap::new();
            their_copy.insert(
                device_id_hex(&DEV_A),
                protocol::sign_device_binding(
                    &them,
                    &DEV_A,
                    them.fingerprint(),
                    1,
                    false,
                    &mut rng,
                )
                .expect("sign the peer's row"),
            );
            assert!(
                protocol::merge_device_bindings(&claimed, &their_copy).is_err(),
                "the fixture must be a pair the codec really refuses, or this test measures \
                 nothing"
            );

            let (reclaimed, outcome) = block_on(reclaim_self_in_dir(
                &io,
                dir.path(),
                k,
                &me,
                &DEV_A,
                None,
                &mut rng,
            ))
            .expect("the repair");
            assert_eq!(
                outcome,
                ClaimOutcome::Written,
                "a repair must WRITE even though the row it found named the right person, \
                 which is the whole difference from a plain claim"
            );
            let mine = reclaimed.get(&device_id_hex(&DEV_A)).unwrap();
            assert_eq!(
                mine.version, 2,
                "the repair moves ONE version past the pair"
            );
            assert_eq!(mine.person_fingerprint, fingerprint_hex(me.fingerprint()));
            assert!(verify_device_binding(&me.public_half(), &DEV_A, mine));

            let merged = protocol::merge_device_bindings(&reclaimed, &their_copy)
                .expect("the pair now has a winner, so the merge stops refusing the map");
            assert_eq!(
                merged.get(&device_id_hex(&DEV_A)).map(|row| row.version),
                Some(2),
                "and the winner is the higher version, whichever side it is merged from"
            );
            let other_order = protocol::merge_device_bindings(&their_copy, &reclaimed)
                .expect("the refusal is symmetric and so is the repair");
            assert_eq!(merged, other_order, "merge stays commutative");
        });
    }

    /// Acceptance criterion 2: two devices claiming themselves concurrently both
    /// survive a merge.
    ///
    /// This is the criterion the sister `member-names` family lost. Two devices
    /// each hold a store containing only their own row; the merge a pull produces
    /// is entry by entry, so neither row may displace the other, and the result may
    /// not depend on which side was read first.
    #[test]
    fn two_devices_claiming_themselves_both_survive_a_merge() {
        let dir_a = ScopedTempDir::new("device-binding-a").unwrap();
        let dir_b = ScopedTempDir::new("device-binding-b").unwrap();
        let io = StdVaultIo;
        let ann = pair(b"ann");
        let bob = pair(b"bob");
        let mut rng = SeededRng(7);

        with_key(|k| {
            block_on(claim_self_in_dir(
                &io,
                dir_a.path(),
                k,
                &ann,
                &DEV_A,
                None,
                &mut rng,
            ))
            .expect("a claims itself");
            block_on(claim_self_in_dir(
                &io,
                dir_b.path(),
                k,
                &bob,
                &DEV_B,
                None,
                &mut rng,
            ))
            .expect("b claims itself");

            // Each side holds exactly its own row: nothing has been merged yet.
            assert_eq!(
                live_row_count(
                    &block_on(read_device_bindings_in_dir(&io, dir_a.path(), k)).unwrap()
                ),
                1
            );
            assert_eq!(
                live_row_count(
                    &block_on(read_device_bindings_in_dir(&io, dir_b.path(), k)).unwrap()
                ),
                1
            );

            // A pulls B's blob. Both claims survive.
            let from_b = stored_bytes(&io, dir_b.path()).expect("b's store");
            let (merged, changed) =
                block_on(merge_pulled_blob_in_dir(&io, dir_a.path(), k, &from_b)).expect("merge");
            assert!(changed, "a row was added, so the merge is not a no-op");
            assert_eq!(live_row_count(&merged), 2, "both devices are bound");
            let a_hex = device_id_hex(&DEV_A);
            let b_hex = device_id_hex(&DEV_B);
            assert!(
                merged.contains_key(&a_hex),
                "the local claim was not overwritten"
            );
            assert!(merged.contains_key(&b_hex), "the pulled claim was taken");
            assert!(verify_device_binding(
                &ann.public_half(),
                &DEV_A,
                merged.get(&a_hex).unwrap()
            ));
            assert!(verify_device_binding(
                &bob.public_half(),
                &DEV_B,
                merged.get(&b_hex).unwrap()
            ));

            // The reverse direction converges on the same map, so the merge is
            // order independent rather than "last writer wins".
            let from_a = stored_bytes(&io, dir_a.path()).expect("a's merged store");
            let (reverse, changed_reverse) =
                block_on(merge_pulled_blob_in_dir(&io, dir_b.path(), k, &from_a)).expect("merge");
            assert!(changed_reverse, "b gains a's row");
            assert_eq!(reverse, merged, "merge(a,b) == merge(b,a)");

            // And a second pass over the SAME bytes is a no-op, which is what stops
            // two converged devices from re-pushing the same map every cycle.
            let (_, changed_again) =
                block_on(merge_pulled_blob_in_dir(&io, dir_b.path(), k, &from_a)).expect("merge");
            assert!(!changed_again, "a converged store does not churn");
        });
    }

    /// Acceptance criterion 3: a claim written while offline reconciles on the next
    /// cycle with no user-visible failure.
    ///
    /// "Offline" is exactly the shape where no remote copy of the family exists, so
    /// the local store is the only copy there is. Two things must hold: the claim is
    /// on disk in a form the sync phase's push path can decode, and a reconcile
    /// against a peer whose copy PREDATES this device's join (it carries the peer's
    /// row and nothing about ours) takes both rather than replacing the local map
    /// with the older one.
    /// The upgrade path a device takes the first time it holds a device key
    /// (`decisions/protocol/0733` decision 3): its `v1` row is re-signed ONCE as a `v2`
    /// row carrying the device public halves, and a third claim writes nothing.
    ///
    /// What this pins is the idempotence clause nobody would notice breaking: without
    /// the halves in the "already current" test, a device that upgraded would keep its
    /// `v1` row forever, its halves would never reach the store, and `cycle.rs` would
    /// decline to author `0x03` heads for the rest of the device's life with no error
    /// anywhere.
    #[test]
    fn a_device_key_upgrades_a_v1_row_to_v2_once() {
        let dir = ScopedTempDir::new("device-binding-upgrade").unwrap();
        let io = StdVaultIo;
        let ann = pair(b"ann");
        let mut rng = SeededRng(11);
        let device_public =
            protocol::device_key::DeviceKeyPair::generate_raw(&[0x41; 32], &[0x42; 32])
                .public_half();

        with_key(|k| {
            // Before the device holds a key: a v1 row, no halves.
            let (map, outcome) = block_on(claim_self_in_dir(
                &io,
                dir.path(),
                k,
                &ann,
                &DEV_A,
                None,
                &mut rng,
            ))
            .expect("first claim");
            assert_eq!(outcome, ClaimOutcome::Written);
            let row = map.get(&device_id_hex(&DEV_A)).expect("a row");
            assert!(
                row.device_ed_pk.is_none(),
                "a pre-key row carries no halves"
            );

            // With a key: re-signed as v2, carrying exactly this device's halves.
            let (map, outcome) = block_on(claim_self_in_dir(
                &io,
                dir.path(),
                k,
                &ann,
                &DEV_A,
                Some(&device_public),
                &mut rng,
            ))
            .expect("upgrade claim");
            assert_eq!(outcome, ClaimOutcome::Written);
            let row = map.get(&device_id_hex(&DEV_A)).expect("a row");
            assert_eq!(
                row.device_ed_pk.as_deref(),
                Some(device_public.ed_pk_hex().as_str())
            );
            assert_eq!(
                row.device_mldsa_vk.as_deref(),
                Some(device_public.mldsa_vk_hex().as_str())
            );
            assert!(
                protocol::verify_device_binding(&ann.public_half(), &DEV_A, row),
                "the upgraded row is signed by the person it claims"
            );
            assert_eq!(
                protocol::device_public_half_from_entry(row),
                Some(device_public),
                "the halves a peer resolves out of the row are the device's own"
            );

            // Third claim: already current, so nothing is written.
            let (_, outcome) = block_on(claim_self_in_dir(
                &io,
                dir.path(),
                k,
                &ann,
                &DEV_A,
                Some(&device_public),
                &mut rng,
            ))
            .expect("third claim");
            assert_eq!(outcome, ClaimOutcome::AlreadyCurrent);
        });
    }

    #[test]
    fn a_claim_written_offline_reconciles_without_a_user_visible_failure() {
        let dir = ScopedTempDir::new("device-binding-offline").unwrap();
        let peer_dir = ScopedTempDir::new("device-binding-peer").unwrap();
        let io = StdVaultIo;
        let me = pair(b"offline-me");
        let peer = pair(b"peer");
        let mut rng = SeededRng(3);

        with_key(|k| {
            // Nothing remote exists. The claim is a plain success, not an error the
            // caller has to swallow.
            let (map, outcome) = block_on(claim_self_in_dir(
                &io,
                dir.path(),
                k,
                &me,
                &DEV_A,
                None,
                &mut rng,
            ))
            .expect("an offline claim is not a failure");
            assert_eq!(outcome, ClaimOutcome::Written);
            assert_eq!(live_row_count(&map), 1);

            // What the phase pushes is the claim itself: the local bytes decode, and
            // they carry this device. A store whose bytes did not decode would make
            // the push path skip the family silently.
            let mine = stored_bytes(&io, dir.path()).expect("the local claim is on disk");
            let decoded =
                decode_device_binding_blob(k.key, k.account_number_hash, k.group_key_epoch, &mine)
                    .expect("the phase can decode what it is about to push");
            assert!(decoded.contains_key(&device_id_hex(&DEV_A)));

            // The peer's copy was sealed before this device joined, so it holds only
            // the peer's row.
            let (peer_map, _) = block_on(claim_self_in_dir(
                &io,
                peer_dir.path(),
                k,
                &peer,
                &DEV_B,
                None,
                &mut rng,
            ))
            .expect("peer claims");
            assert_eq!(peer_map.len(), 1);
            let peer_blob = stored_bytes(&io, peer_dir.path()).expect("peer store");

            let (merged, changed) =
                block_on(merge_pulled_blob_in_dir(&io, dir.path(), k, &peer_blob))
                    .expect("the reconcile is not a user-visible failure");
            assert!(changed);
            assert!(
                merged.contains_key(&device_id_hex(&DEV_A)),
                "the offline claim survived a reconcile against a copy that predates it"
            );
            assert!(merged.contains_key(&device_id_hex(&DEV_B)));
            assert_eq!(live_row_count(&merged), 2);
        });
    }

    /// Acceptance criterion 4, first half: removing a member tombstones their
    /// bindings, and the row that stops a stale copy from resurrecting the binding is
    /// signed by the OWNER, not by the person being removed.
    #[test]
    fn removing_a_member_tombstones_every_device_bound_to_them() {
        let dir = ScopedTempDir::new("device-binding-removal").unwrap();
        let io = StdVaultIo;
        let owner = pair(b"owner");
        let removed = pair(b"removed");
        let keeper = pair(b"keeper");
        let mut rng = SeededRng(11);

        with_key(|k| {
            // Two devices of the person about to be removed, one of a member who stays.
            let mut map = DeviceBindingsMap::new();
            for dev in [DEV_A, DEV_B] {
                map.insert(
                    device_id_hex(&dev),
                    sign_device_binding(&removed, &dev, removed.fingerprint(), 1, false, &mut rng)
                        .unwrap(),
                );
            }
            map.insert(
                device_id_hex(&DEV_C),
                sign_device_binding(&keeper, &DEV_C, keeper.fingerprint(), 1, false, &mut rng)
                    .unwrap(),
            );
            block_on(write_device_bindings_in_dir(&io, dir.path(), k, &map)).unwrap();
            assert_eq!(live_row_count(&map), 3);

            let (after, tombstoned) = block_on(tombstone_member_devices_in_dir(
                &io,
                dir.path(),
                k,
                &owner,
                &fingerprint_hex(removed.fingerprint()),
                &mut rng,
            ))
            .expect("removal");
            assert_eq!(tombstoned, 2, "both of the removed person's devices");

            for dev in [DEV_A, DEV_B] {
                let row = after
                    .get(&device_id_hex(&dev))
                    .expect("the row stays on disk");
                assert!(row.tombstone, "the live view drops it, the row remains");
                assert_eq!(
                    row.version, 2,
                    "strictly above the live row, so a stale copy cannot outrank it"
                );
                assert!(
                    verify_device_binding_removal(&owner.public_half(), &dev, row),
                    "an owner signature is what the read side accepts for a non-self row"
                );
                assert!(
                    !verify_device_binding(&removed.public_half(), &dev, row),
                    "and the removed person's own half does not verify a tombstone"
                );
            }

            let kept = after
                .get(&device_id_hex(&DEV_C))
                .expect("the other member's row");
            assert!(!kept.tombstone, "a different person's device is untouched");
            assert!(verify_device_binding(&keeper.public_half(), &DEV_C, kept));
            assert_eq!(live_row_count(&after), 1);

            // A retried removal is a no-op: a tombstoned row is skipped, so the
            // version counter does not climb and the row is not rewritten.
            let (again, n) = block_on(tombstone_member_devices_in_dir(
                &io,
                dir.path(),
                k,
                &owner,
                &fingerprint_hex(removed.fingerprint()),
                &mut rng,
            ))
            .expect("retry");
            assert_eq!(n, 0, "nothing left to tombstone");
            assert_eq!(again, after, "a retried removal changes nothing");

            // A fingerprint no live row names is a no-op too, not an error: the
            // caller is a removal that has already run or that names a person with
            // no devices here.
            let (untouched, none) = block_on(tombstone_member_devices_in_dir(
                &io,
                dir.path(),
                k,
                &owner,
                &fingerprint_hex(pair(b"never-seen").fingerprint()),
                &mut rng,
            ))
            .expect("an absent person is not an error");
            assert_eq!(none, 0);
            assert_eq!(untouched, after);
        });
    }

    /// The row an admitting device writes for ANOTHER device (`0735`): signed by the
    /// person who holds the key, naming the device that does not, and carrying that
    /// device's signing halves inside the signature so a peer can resolve the heads it
    /// later authors.
    ///
    /// This is the property the whole phrase-free join rests on. A device that joined
    /// without the recovery phrase holds no person key, so it cannot claim itself; the
    /// admitting device is the one that can, and the row it writes has to be
    /// indistinguishable from a self-claim to every READER, or peers would refuse the new
    /// device's heads.
    #[test]
    fn admit_other_writes_a_row_the_read_side_verifies() {
        with_key(|k| {
            let dir = ScopedTempDir::new("admit_other").unwrap();
            let io = StdVaultIo;
            let owner = pair(b"owner-admitting");
            let mut rng = SeededRng(11);
            let new_device = DEV_B;
            let halves =
                protocol::device_key::DeviceKeyPair::generate_raw(&[0x51; 32], &[0x52; 32])
                    .public_half();

            let (map, outcome) = block_on(admit_other_in_dir(
                &io,
                dir.path(),
                k,
                &owner,
                &new_device,
                Some(&halves),
                &mut rng,
            ))
            .expect("admit");
            assert_eq!(outcome, ClaimOutcome::Written);
            let row = map.get(&device_id_hex(&new_device)).expect("the row");
            // The READ side is the test, not the writer's own return value: a row the
            // admitting device believes in and a peer refuses would be the failure that
            // matters, and only `verify_device_binding` speaks for the peer.
            assert!(
                verify_device_binding(&owner.public_half(), &new_device, row),
                "a peer must accept the admitted row against the person's half"
            );
            assert_eq!(
                row.device_ed_pk.as_deref(),
                Some(halves.ed_pk_hex().as_str())
            );
            assert!(!row.tombstone);

            // A second admit is a no-op: the same person, the same halves, nothing to say.
            let (again, outcome) = block_on(admit_other_in_dir(
                &io,
                dir.path(),
                k,
                &owner,
                &new_device,
                Some(&halves),
                &mut rng,
            ))
            .expect("re-admit");
            assert_eq!(outcome, ClaimOutcome::AlreadyCurrent);
            assert_eq!(again, map);

            // Different halves are a REAL change (the device re-minted its key) and climb
            // the version, because `beats` decides the merge on it.
            let rotated =
                protocol::device_key::DeviceKeyPair::generate_raw(&[0x61; 32], &[0x62; 32])
                    .public_half();
            let (after, outcome) = block_on(admit_other_in_dir(
                &io,
                dir.path(),
                k,
                &owner,
                &new_device,
                Some(&rotated),
                &mut rng,
            ))
            .expect("re-admit with new halves");
            assert_eq!(outcome, ClaimOutcome::Written);
            let row = after.get(&device_id_hex(&new_device)).expect("the row");
            assert_eq!(row.version, 2, "a changed row must outrank the old one");
            assert_eq!(
                row.device_ed_pk.as_deref(),
                Some(rotated.ed_pk_hex().as_str())
            );
            assert!(verify_device_binding(
                &owner.public_half(),
                &new_device,
                row
            ));
        });
    }

    /// Acceptance criterion 4, second half: retiring ONE device writes no tombstone.
    ///
    /// The retirement entry point is a sync-server call, so it is driven here over
    /// the in-crate fake. The assertion is not that the call succeeds but that the
    /// store is byte-identical afterwards: a retired device keeps its binding,
    /// because its past revisions were genuinely that person's, and the only
    /// tombstone entry point in this module is keyed by a person fingerprint, so
    /// there is no device-keyed call a retirement could make even if it wanted to.
    #[test]
    fn retiring_one_device_writes_no_tombstone() {
        use crate::plugins::sync::devices::revoke_device;
        use crate::plugins::sync::transport::{FakeTransport, HttpMethod};

        let dir = ScopedTempDir::new("device-binding-retire").unwrap();
        let io = StdVaultIo;
        let keeper = pair(b"keeper");
        let mut rng = SeededRng(13);

        with_key(|k| {
            let mut map = DeviceBindingsMap::new();
            map.insert(
                device_id_hex(&DEV_C),
                sign_device_binding(&keeper, &DEV_C, keeper.fingerprint(), 1, false, &mut rng)
                    .unwrap(),
            );
            block_on(write_device_bindings_in_dir(&io, dir.path(), k, &map)).unwrap();
            let before = stored_bytes(&io, dir.path()).expect("the store exists");

            let transport = FakeTransport::new();
            transport.on(HttpMethod::Post, "/auth/devices/revoke", 200, Vec::new());
            revoke_device(&transport, "token", &DEV_C).expect("the retirement call itself");

            let after = stored_bytes(&io, dir.path()).expect("the store still exists");
            assert_eq!(
                before, after,
                "a device retirement writes nothing into the binding family: no tombstone, no \
                 re-seal, not one byte"
            );
            let reread = block_on(read_device_bindings_in_dir(&io, dir.path(), k)).unwrap();
            let row = reread.get(&device_id_hex(&DEV_C)).expect("the row");
            assert!(
                !row.tombstone,
                "the retired device is still bound to its person"
            );
            assert_eq!(live_row_count(&reread), 1);
        });
    }

    /// **The repair this whole change exists for, on the store side.**
    ///
    /// A live `v2` row publishes this device's halves, and then the device loses them (a
    /// keychain item removed, a store that stopped answering, a platform that never had
    /// one). The next claim hands the writer `None`, and that must NOT read as "current":
    /// with `None` treated as a match the row stayed published, peers kept resolving a
    /// signer that no longer existed, and the sync cycle kept refusing with
    /// `device_key_missing` while the repair button did nothing at all. The row is
    /// rewritten one version up, without halves, so the device falls back to the person
    /// signature honestly.
    #[test]
    fn a_device_that_lost_its_key_unpublishes_the_halves_it_left_behind() {
        let dir = ScopedTempDir::new("device-binding-orphan").unwrap();
        let io = StdVaultIo;
        let owner = pair(b"orphan-owner");
        let halves = protocol::device_key::DeviceKeyPair::generate_raw(&[0x71; 32], &[0x72; 32])
            .public_half();
        let mut rng = SeededRng(23);

        with_key(|k| {
            block_on(claim_self_in_dir(
                &io,
                dir.path(),
                k,
                &owner,
                &DEV_A,
                Some(&halves),
                &mut rng,
            ))
            .expect("the first claim publishes the halves");
            let published =
                block_on(read_device_bindings_in_dir(&io, dir.path(), k)).expect("the store");
            let before = published.get(&device_id_hex(&DEV_A)).expect("the v2 row");
            assert!(
                crate::plugins::sync::authority::row_publishes_halves(before),
                "fixture check: the row really does publish halves"
            );
            let published_version = before.version;

            // The same device claims again, and this time the store has nothing to give back.
            let (map, outcome) = block_on(claim_self_in_dir(
                &io,
                dir.path(),
                k,
                &owner,
                &DEV_A,
                None,
                &mut rng,
            ))
            .expect("the repair claim");
            assert_eq!(
                outcome,
                ClaimOutcome::Written,
                "a row publishing halves we cannot honour is stale, not current"
            );
            let row = map.get(&device_id_hex(&DEV_A)).expect("the row");
            assert_eq!(
                row.version,
                published_version + 1,
                "the rewrite climbs, so a peer's merge adopts it"
            );
            assert!(
                !crate::plugins::sync::authority::row_publishes_halves(row),
                "the row must stop publishing halves this device cannot sign with"
            );
            assert!(verify_device_binding(&owner.public_half(), &DEV_A, row));

            // And it settles: claiming again with nothing to publish is a genuine no-op, so
            // the repair does not climb the version on every unlock.
            let (_, outcome2) = block_on(claim_self_in_dir(
                &io,
                dir.path(),
                k,
                &owner,
                &DEV_A,
                None,
                &mut rng,
            ))
            .expect("the next unlock");
            assert_eq!(outcome2, ClaimOutcome::AlreadyCurrent);
        });
    }

    /// Acceptance criterion 5: when the person's identity changes, the next unlock
    /// re-writes the entry under the new fingerprint.
    ///
    /// The row is keyed by the DEVICE, so an identity change does not add a row: it
    /// re-points the existing one at the new fingerprint, at a strictly higher
    /// version so the stale copy loses the merge.
    #[test]
    fn an_identity_change_rewrites_the_row_under_the_new_fingerprint() {
        let dir = ScopedTempDir::new("device-binding-identity").unwrap();
        let io = StdVaultIo;
        let old = pair(b"identity-v1");
        let new = pair(b"identity-v2");
        let mut rng = SeededRng(17);
        assert_ne!(
            old.fingerprint(),
            new.fingerprint(),
            "fixture check: the two identities really are different people"
        );

        with_key(|k| {
            block_on(claim_self_in_dir(
                &io,
                dir.path(),
                k,
                &old,
                &DEV_A,
                None,
                &mut rng,
            ))
            .expect("the device claims itself under the first identity");
            let before = stored_bytes(&io, dir.path()).expect("the first store");

            let (map, outcome) = block_on(claim_self_in_dir(
                &io,
                dir.path(),
                k,
                &new,
                &DEV_A,
                None,
                &mut rng,
            ))
            .expect("the next unlock re-claims");
            assert_eq!(
                outcome,
                ClaimOutcome::Written,
                "a row naming a different person is stale, not current"
            );
            assert_eq!(
                map.len(),
                1,
                "the same device: a re-point, not a second row"
            );
            let row = map.get(&device_id_hex(&DEV_A)).expect("the row");
            assert_eq!(row.person_fingerprint, fingerprint_hex(new.fingerprint()));
            assert_eq!(row.version, 2, "strictly above the row it replaces");
            assert!(verify_device_binding(&new.public_half(), &DEV_A, row));
            assert!(
                !verify_device_binding(&old.public_half(), &DEV_A, row),
                "the old identity no longer verifies the row"
            );
            let after = stored_bytes(&io, dir.path()).expect("the re-sealed store");
            assert_ne!(before, after, "the store really moved");

            // And the claim is idempotent again under the new identity, so an unlock
            // loop does not climb the version on every launch.
            let (_, outcome3) = block_on(claim_self_in_dir(
                &io,
                dir.path(),
                k,
                &new,
                &DEV_A,
                None,
                &mut rng,
            ))
            .expect("a third unlock");
            assert_eq!(outcome3, ClaimOutcome::AlreadyCurrent);
        });
    }

    /// The row a removal tombstoned is re-claimed at a strictly higher version, which
    /// is what makes the claim rule's third case a real re-bind rather than a silent
    /// no-op.
    ///
    /// This is the policy this layer owns and the codec does not state: `beats` lets a
    /// tombstone win only at an EQUAL version, so a strictly higher live row is the
    /// re-bind the codec was written to allow. What a removal is actually ENFORCED by
    /// is the group-key rotation, after which the removed device cannot open the
    /// re-sealed map at all; the version rule is what keeps a device that is still a
    /// member from being locked out by its own stale tombstone.
    #[test]
    fn a_tombstoned_row_is_re_claimed_strictly_above_the_tombstone() {
        let dir = ScopedTempDir::new("device-binding-rebind").unwrap();
        let io = StdVaultIo;
        let owner = pair(b"owner");
        let me = pair(b"me");
        let mut rng = SeededRng(19);

        with_key(|k| {
            let _ = block_on(claim_self_in_dir(
                &io,
                dir.path(),
                k,
                &me,
                &DEV_A,
                None,
                &mut rng,
            ))
            .expect("claim");
            // An owner-signed tombstone lands on the row, as a removal would write it.
            let (tombstoned, n) = block_on(tombstone_member_devices_in_dir(
                &io,
                dir.path(),
                k,
                &owner,
                &fingerprint_hex(me.fingerprint()),
                &mut rng,
            ))
            .expect("removal");
            assert_eq!(n, 1);
            assert!(tombstoned.get(&device_id_hex(&DEV_A)).unwrap().tombstone);
            assert_eq!(live_row_count(&tombstoned), 0);

            let (reclaimed, outcome) = block_on(claim_self_in_dir(
                &io,
                dir.path(),
                k,
                &me,
                &DEV_A,
                None,
                &mut rng,
            ))
            .expect("re-claim");
            assert_eq!(
                outcome,
                ClaimOutcome::Written,
                "a tombstoned row is not 'current', so the device re-binds"
            );
            let row = reclaimed.get(&device_id_hex(&DEV_A)).unwrap();
            assert!(!row.tombstone);
            assert_eq!(row.version, 3, "above the tombstone it replaces");
            assert!(verify_device_binding(&me.public_half(), &DEV_A, row));
            assert_eq!(live_row_count(&reclaimed), 1);
        });
    }

    /// A store that exists but does not decrypt is an ERROR, never the empty map.
    ///
    /// Answering empty for a damaged store is what lets the next write persist that
    /// emptiness over every other device's real row, and the rows it drops carry no
    /// tombstone for a later merge to notice.
    #[test]
    fn an_undecryptable_store_is_refused_rather_than_read_as_empty() {
        let dir = ScopedTempDir::new("device-binding-damaged").unwrap();
        let io = StdVaultIo;

        // A well-formed-looking file under the wrong key: right magic, unopenable
        // ciphertext, which is what an epoch mismatch or a rotated group key produces.
        block_on(io.write(
            &dir.path().join(DEVICE_BINDINGS_FILE),
            &[0u8; 128],
            WriteOpts::default(),
        ))
        .unwrap();

        with_key(|k| {
            let err = block_on(read_device_bindings_in_dir(&io, dir.path(), k))
                .expect_err("a damaged store is an error");
            assert_eq!(err, DeviceBindingError::StoreUnreadable);
        });
    }

    /// The merge refuses a pulled copy it cannot decode, rather than merging it as
    /// empty. `merge(local, empty) == local` is a silent no-op that a caller reads as
    /// "no new claims" while every peer's row is discarded.
    #[test]
    fn a_pulled_blob_that_does_not_decode_is_never_merged_in() {
        let dir = ScopedTempDir::new("device-binding-badpull").unwrap();
        let io = StdVaultIo;
        let me = pair(b"me");
        let mut rng = SeededRng(23);

        with_key(|k| {
            let _ = block_on(claim_self_in_dir(
                &io,
                dir.path(),
                k,
                &me,
                &DEV_A,
                None,
                &mut rng,
            ))
            .expect("claim");
            let before = stored_bytes(&io, dir.path()).expect("the store");

            let err = block_on(merge_pulled_blob_in_dir(&io, dir.path(), k, &[0u8; 128]))
                .expect_err("a pulled copy that does not decode is refused");
            assert_eq!(err, DeviceBindingError::Codec);
            let after = stored_bytes(&io, dir.path()).expect("the store is untouched");
            assert_eq!(before, after, "a refused merge writes nothing");
        });
    }
}
