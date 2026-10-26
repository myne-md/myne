// SPDX-License-Identifier: AGPL-3.0
//! Which keys may have signed this vault's OWNER ROSTER (`decisions/protocol/0731`
//! stage 2, `0733`).
//!
//! A roster is signed by exactly one key: the owner's person key (every roster before
//! stage 2, and the creation and `NTV5` migration paths still), or a DEVICE key the
//! owner bound to itself. Answering "which devices may have signed it" is the same
//! question the head path answers for `0x03` heads, and it has the same three sources:
//!
//! * the PINNED attestation a member accepted (`sync-state.json`'s `owner_device`),
//!   which is what makes verification work before a group key is in hand;
//! * this device's own key, when it is one of the owner's devices;
//! * the rows of `vault.device-bindings` that name the owner, each verified against the
//!   owner's public half.
//!
//! **Every candidate is verified, not assumed.** A group-sealed map is writable by any
//! member, so a row nobody signed contributes no signer; and the pinned attestation is
//! re-verified here rather than trusted because it was checked once at accept: a state
//! file is on an untrusted disk (A4/A7), and a tampered pin would otherwise choose the
//! key that verifies every future roster.

use std::path::Path;

use protocol::device_key::DevicePublicHalf;
use protocol::person_invite::{OwnerDeviceAttestation, RosterTrust};

/// The device halves that may have signed `owner`'s roster for this vault.
///
/// `bindings` is the family's KEK+epoch borrow, `None` for a caller that has no group
/// key yet (creation, migration, a locked slot). `own` is the caller's own device half
/// and is only passed by an OWNER path. `pinned` is a member's stored attestation.
///
/// Order matters only for wall clock: the pinned attestation and the own key are checked
/// first, so the common case costs no store read.
pub async fn device_halves_for_owner(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    bindings: Option<&crate::plugins::device_binding::DeviceBindingKey<'_>>,
    own: Option<&DevicePublicHalf>,
    pinned: Option<&OwnerDeviceAttestation>,
    owner: &protocol::person_key::PersonPublicHalf,
) -> Vec<DevicePublicHalf> {
    let owner_fingerprint_hex = protocol::hex::encode_lower(owner.fingerprint());
    let mut out: Vec<DevicePublicHalf> = Vec::new();
    let mut push = |half: DevicePublicHalf| {
        if !out.contains(&half) {
            out.push(half);
        }
    };

    // 1. The pin a member accepted, re-verified against the owner's person half.
    if let Some(attestation) = pinned {
        if attestation.verifies_against(owner) {
            if let Some(half) = attestation.device_public_half() {
                push(half);
            }
        } else {
            tracing::warn!(
                stage = "roster_trust_pin",
                "the pinned owner-device attestation does not verify; ignoring it"
            );
        }
    }

    // 2. This device's own key, which an owner path supplies after checking that the
    //    device really is bound to this person (the caller owns that check: `cycle.rs`
    //    only authors `0x03` once its own row verifies).
    if let Some(half) = own {
        push(*half);
    }

    // 3. The verified rows of the binding store that name this owner.
    if let Some(bindings) = bindings {
        match crate::plugins::device_binding::read_device_bindings_in_dir(io, vault_dir, bindings)
            .await
        {
            Ok(map) => {
                // `partition_verified_bindings` needs a `Copy` public half; the roster's
                // owner is one value for the whole map.
                // The map key is the DEVICE and the claimed person lives inside the row,
                // so the partition is told which public half verifies a row's signature:
                // this owner's, for every row, because a row naming somebody else is
                // filtered out below and would never be a roster signer anyway.
                let owner_public = owner.clone();
                let (verified, _unverified) = protocol::partition_verified_bindings(
                    &map,
                    |_| Some(owner_public.clone()),
                    Some(owner),
                );
                for entry in verified.values() {
                    // A tombstone is a removal, not a signer, and a row naming somebody
                    // else is not this owner's. The codec already refused a malformed
                    // device id, so nothing here needs the raw bytes.
                    if entry.tombstone || entry.person_fingerprint != owner_fingerprint_hex {
                        continue;
                    }
                    if let Some(half) = protocol::device_public_half_from_entry(entry) {
                        push(half);
                    }
                }
            }
            Err(err) => {
                tracing::warn!(
                    stage = "roster_trust_store",
                    error = ?err,
                    "device-binding store unreadable; falling back to the keys already known"
                );
            }
        }
    }

    out
}

/// This device's own person-signed binding row, as an invite package carries it.
///
/// `None` when this device holds no device key, when its row has not been written yet,
/// or when the row does not verify against `owner`: in every one of those cases the
/// caller must keep signing rosters with the person key, because a package carrying an
/// attestation nobody can use would make every recipient fail to resolve the roster.
pub async fn own_attestation(
    io: &dyn crate::vault_io::VaultIo,
    vault_dir: &Path,
    bindings: &crate::plugins::device_binding::DeviceBindingKey<'_>,
    owner: &protocol::person_key::PersonPublicHalf,
    device_id: &[u8; 16],
) -> Option<OwnerDeviceAttestation> {
    let map = crate::plugins::device_binding::read_device_bindings_in_dir(io, vault_dir, bindings)
        .await
        .ok()?;
    let device_hex = protocol::hex::encode_lower(device_id);
    let entry = map.get(&device_hex)?.clone();
    let attestation = OwnerDeviceAttestation {
        device_id_hex: device_hex,
        entry,
    };
    // The row must be the OWNER's own and must carry the halves: both are what the
    // recipient needs, and neither is guessable from the rest of the package.
    if !attestation.verifies_against(owner) {
        return None;
    }
    attestation.device_public_half()?;
    Some(attestation)
}

/// Whether this vault's owner can sign rosters with a DEVICE key, which is the same
/// question as "is there a verified attestation for it here".
///
/// Kept separate from [`own_attestation`] so the writer reads as one decision: sign with
/// the device key exactly when an attestation exists to carry beside it.
#[must_use]
pub fn device_signing_available(attestation: Option<&OwnerDeviceAttestation>) -> bool {
    attestation.is_some_and(|a| a.device_public_half().is_some())
}

/// Build the [`RosterTrust`] a verifier passes in, borrowing the candidate list.
#[must_use]
pub fn trust<'a>(
    owner: &'a protocol::person_key::PersonPublicHalf,
    devices: &'a [DevicePublicHalf],
) -> RosterTrust<'a> {
    RosterTrust {
        owner_person: owner,
        owner_devices: devices,
    }
}

/// This device's own signing key together with the binding row that attests it, or
/// nothing at all.
///
/// Returned as a PAIR because the two are useless apart, and the pairing used to be a
/// comment at each of the two call sites that rebuilt this by hand: a device signature
/// with no attestation is a roster or a package nobody can open (the recipient has no way
/// to resolve the key), and an attestation with no signature is a promise. Making the
/// pair the return type means neither can be shipped alone by accident.
///
/// `None` covers four states, and only the first is a platform limit: no device-key rung,
/// no `sync-state.json` device id, no binding row for this device, or a row that names a
/// DIFFERENT key than the one that would sign. The last is the one that matters: the
/// recipient would otherwise resolve a key that never signed anything.
pub async fn own_device_signing_pair(
    io: &dyn crate::vault_io::VaultIo,
    root: &std::path::Path,
    group_key: &[u8; 32],
    account_number_hash: [u8; 16],
    epoch: u64,
    owner: &protocol::person_key::PersonPublicHalf,
) -> Option<(
    protocol::device_key::DeviceKeyPair,
    protocol::person_invite::OwnerDeviceAttestation,
)> {
    // No device key means no device signature, so there is nothing to attest.
    let device_key =
        crate::plugins::sync::device_identity::load_for_fallback("device_attestation")?;
    let sync_state = crate::plugins::sync::state::read_sync_state(io, root)
        .await
        .ok()?;
    let device_id = crate::plugins::sync::devices::hex16(sync_state.device_id_hex.as_deref()?)?;
    let bindings_key = crate::plugins::device_binding::bindings_key_for_group(
        group_key,
        account_number_hash,
        epoch,
    );
    let attestation = own_attestation(io, root, &bindings_key.borrow(), owner, &device_id).await?;
    (attestation.device_public_half() == Some(device_key.public_half()))
        .then_some((device_key, attestation))
}

#[cfg(test)]
mod tests {
    use super::*;
    use protocol::device_key::DeviceKeyPair;
    use protocol::person_key::PersonKeyPair;

    fn pair(seed: u8) -> PersonKeyPair {
        PersonKeyPair::generate_raw(&[seed; 64], &[seed ^ 1; 32], &[seed ^ 2; 32])
    }

    struct Rng(u64);
    impl rand_core::TryRng for Rng {
        type Error = core::convert::Infallible;
        fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
            Ok(0)
        }
        fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
            Ok(0)
        }
        fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
            use sha2::Digest as _;
            self.0 = self.0.wrapping_add(1);
            let digest = sha2::Sha256::digest(self.0.to_le_bytes());
            for chunk in dst.chunks_mut(digest.len()) {
                chunk.copy_from_slice(&digest[..chunk.len()]);
            }
            Ok(())
        }
    }
    impl rand_core::TryCryptoRng for Rng {}

    /// A pinned attestation is used when the owner really signed it, and IGNORED when the
    /// signature does not check out. The second half is the load-bearing one: a tampered
    /// pin would otherwise choose the key that verifies every future roster, which is the
    /// whole trust decision this module exists to make.
    #[test]
    fn a_pinned_attestation_is_used_only_after_its_own_signature_verifies() {
        let owner = pair(0x21);
        let stranger = pair(0x22);
        let device = DeviceKeyPair::generate_raw(&[0x31; 32], &[0x32; 32]);
        let device_id = [0x44u8; 16];
        let entry = protocol::device_binding_blob::sign_device_binding_v2(
            &owner,
            &device_id,
            owner.fingerprint(),
            1,
            false,
            &device.public_half(),
            &mut Rng(1),
        )
        .expect("sign row");
        let attestation = OwnerDeviceAttestation {
            device_id_hex: protocol::hex::encode_lower(&device_id),
            entry: entry.clone(),
        };

        assert!(attestation.verifies_against(&owner.public_half()));
        assert_eq!(attestation.device_public_half(), Some(device.public_half()));

        // The same row checked against a DIFFERENT owner: refused, because the row's
        // claimed fingerprint is the real owner's.
        assert!(!attestation.verifies_against(&stranger.public_half()));

        // A tombstone is a removal, not a signer.
        let mut tombstoned = attestation.clone();
        tombstoned.entry = protocol::device_binding_blob::sign_device_binding_v2(
            &owner,
            &device_id,
            owner.fingerprint(),
            2,
            true,
            &device.public_half(),
            &mut Rng(2),
        )
        .expect("sign tombstone");
        assert!(!tombstoned.verifies_against(&owner.public_half()));
    }

    /// A candidate list assembled from a pin is what a device-signed roster is verified
    /// against, end to end through this module's own entry point.
    #[test]
    fn the_assembled_trust_verifies_a_device_signed_roster() {
        use protocol::person_invite::{
            sign_group_roster_with_device, verify_group_roster, GroupKeyContinuity,
            GroupMemberState, GroupRosterMember, GroupRosterPayload, GroupRosterRole,
        };

        let owner = pair(0x41);
        let device = DeviceKeyPair::generate_raw(&[0x51; 32], &[0x52; 32]);
        let device_id = [0x55u8; 16];
        let account = [0x66u8; 16];
        let public = owner.public_half();
        let entry = protocol::device_binding_blob::sign_device_binding_v2(
            &owner,
            &device_id,
            owner.fingerprint(),
            1,
            false,
            &device.public_half(),
            &mut Rng(3),
        )
        .expect("sign row");
        let pinned = OwnerDeviceAttestation {
            device_id_hex: protocol::hex::encode_lower(&device_id),
            entry,
        };

        let roster = GroupRosterPayload {
            account_number_hash_hex: protocol::hex::encode_lower(&account),
            group_key_epoch: 1,
            owner_fingerprint_hex: protocol::hex::encode_lower(owner.fingerprint()),
            members: vec![GroupRosterMember {
                fingerprint_hex: protocol::hex::encode_lower(owner.fingerprint()),
                person_id_hex: None,
                display_name: "Owner".into(),
                role: GroupRosterRole::Owner,
                state: GroupMemberState::Live,
                wrapped_group_key_hex: None,
                member_kem_ek_hex: protocol::hex::encode_lower(public.kem_ek()),
                member_ed_pk_hex: protocol::hex::encode_lower(public.ed_pk()),
                member_mldsa_vk_hex: protocol::hex::encode_lower(public.mldsa_vk()),
                previous_fingerprint_hex: None,
                continuity: GroupKeyContinuity::Current,
                transition_hex: None,
            }],
        };
        let signed = sign_group_roster_with_device(&device, &roster, &mut Rng(4)).expect("sign");

        // The same resolution the cycle performs: trust built from the pin reaches the
        // device half, and the roster verifies.
        let mut devices: Vec<protocol::device_key::DevicePublicHalf> = Vec::new();
        if pinned.verifies_against(&public) {
            devices.extend(pinned.device_public_half());
        }
        assert_eq!(devices, vec![device.public_half()]);
        verify_group_roster(trust(&public, &devices), &signed, &account).expect("verifies");

        // Without the pin the same roster is refused, which is what makes the pin the
        // thing that authorizes the device rather than the roster carrying its own key.
        assert!(verify_group_roster(trust(&public, &[]), &signed, &account).is_err());
    }
}
