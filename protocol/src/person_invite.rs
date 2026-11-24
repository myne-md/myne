// SPDX-License-Identifier: AGPL-3.0-only
//! The vault invite envelope (B2B identity substrate, myne-md/myne#698
//! tasks 5-6).
//!
//! An invite is ONE message a vault owner sends to a prospective member:
//! the vault's `itemsKey` wrapped to that member's person public half
//! ([`crate::person_key::PersonWrappedKey`]), plus the owner's identity
//! fingerprint and the owner's double signature (Ed25519 + ML-DSA-65,
//! side by side) over the canonical-JSON payload. The recipient verifies
//! BOTH halves, runs the SAS compare on the embedded fingerprints, and
//! unwraps.
//!
//! The envelope is wire-framed with a length-prefixed canonical-JSON body;
//! the crypto lives in [`crate::person_key`].
//!
//! # Randomness
//!
//! Every constructor that takes caller-supplied randomness carries the
//! crate's `_raw` suffix; convenience wrappers pull from `getrandom`.

use crate::aead::{AAD_PREFIX_V0_2, AEAD_NONCE_LEN, PROTOCOL_VERSION_V0_2};
use crate::person_key::{
    PersonSigned, PERSON_CT_LEN, PERSON_ED25519_PK_LEN, PERSON_ED25519_SIG_LEN,
    PERSON_MLDSA_SIG_LEN,
};
use alloc::string::String;
use alloc::vec::Vec;
use serde::{Deserialize, Serialize};

/// Domain prefix for the invite signature class. A rotation notice signs a
/// DIFFERENT class (its own prefix), so a signature over one class cannot
/// be replayed as another.
pub const INVITE_PREFIX: &[u8] = b"myne.vault-invite v1|";

/// Signature class for an owner-authored NTV6 group roster.
pub const GROUP_ROSTER_PREFIX: &[u8] = b"myne.group-roster v1|";

/// Signature class for a **device-signed** owner roster (`decisions/protocol/0731`
/// stage 2, `0733`).
///
/// The roster names PEOPLE and its payload still carries the owner's person
/// fingerprint; only the key that signs it moves. A distinct class rather than a byte
/// inside the payload, so the two classes cannot be confused at verification, and a
/// reader that predates this refuses a device-signed roster rather than guessing.
pub const GROUP_ROSTER_PREFIX_V2: &[u8] = b"myne.group-roster v2|";

/// Signature class for one recipient's group-key package.
pub const GROUP_PACKAGE_PREFIX: &[u8] = b"myne.group-package v1|";

/// Signature class for a visible person-key continuity transition.
pub const PERSON_KEY_TRANSITION_PREFIX: &[u8] = b"myne.person-key-transition v1|";

/// Signature class for an owner-authored group-epoch retirement record.
pub const GROUP_RETIREMENT_PREFIX: &[u8] = b"myne.group-retirement v1|";

const WRAPPED_32_BYTE_KEY_LEN: usize = 32 + PERSON_CT_LEN + 24 + 64;
const SIGNED_GROUP_FRAME_OVERHEAD: usize = 4 + PERSON_ED25519_SIG_LEN + PERSON_MLDSA_SIG_LEN;
const SIGNED_GROUP_FRAME_CAP: usize = 65_536;

/// Role recorded in the owner-signed NTV6 group roster.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GroupRosterRole {
    Owner,
    Member,
}

/// Membership state. Removed people remain as signed tombstones.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GroupMemberState {
    Live,
    Tombstone,
}

/// User-visible identity continuity state for a roster row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum GroupKeyContinuity {
    Current,
    Changed,
    OwnerConfirmed,
}

/// One canonical NTV6 group-roster row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupRosterMember {
    pub fingerprint_hex: String,
    /// The member's addressable `person_id_hash` (lowercase hex), when known.
    /// Owner-supplied at invite time; it is what the server's per-vault
    /// membership binding is keyed on, so the owner needs it in the roster to
    /// revoke a removed member (myne-md/myne#711 task 14,
    /// `decisions/protocol/0607`). Absent on a row migrated from a pre-B2B
    /// membership roster, whose members have no person account to revoke.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub person_id_hex: Option<String>,
    pub display_name: String,
    pub role: GroupRosterRole,
    pub state: GroupMemberState,
    pub wrapped_group_key_hex: Option<String>,
    pub member_kem_ek_hex: String,
    pub member_ed_pk_hex: String,
    pub member_mldsa_vk_hex: String,
    pub previous_fingerprint_hex: Option<String>,
    pub continuity: GroupKeyContinuity,
    /// Hex of a `SignedPersonKeyTransition` when the row's identity changed and
    /// the superseded key proved continuity. Absent when the member never
    /// changed identity, or when the change was only owner-confirmed (then the
    /// continuity is `OwnerConfirmed` and this is `None`). The record lets any
    /// member verifier check the change is cryptographic rather than asserted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition_hex: Option<String>,
}

/// Canonical owner-authored roster payload. Members are strictly sorted by
/// fingerprint so one semantic roster has one signed byte representation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupRosterPayload {
    pub account_number_hash_hex: String,
    pub group_key_epoch: u64,
    pub owner_fingerprint_hex: String,
    pub members: Vec<GroupRosterMember>,
}

/// Signed canonical group roster. The owner public half is obtained from the
/// pinned identity, not trusted from this envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedGroupRoster {
    pub payload: Vec<u8>,
    pub signature: PersonSigned,
}

/// One member's canonical group-key package payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupPackagePayload {
    pub account_number_hash_hex: String,
    pub group_key_epoch: u64,
    pub recipient_fingerprint_hex: String,
    pub wrapped_group_key_hex: String,
    /// The owner's device attestation, present once the owner signs rosters with a
    /// device key. OPTIONAL and omitted when absent, so a package from a build without
    /// a device key encodes exactly the bytes the previous release reads.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_device: Option<OwnerDeviceAttestation>,
}

/// Owner-signed recipient package.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedGroupPackage {
    pub payload: Vec<u8>,
    pub signature: PersonSigned,
}

/// The owner's own device, as it travels inside an invite package so a recipient can
/// resolve the DEVICE that signed the roster (`decisions/protocol/0733`).
///
/// Carrying the whole person-signed row rather than the two public halves is
/// deliberate: the recipient verifies the person's signature over the row ITSELF,
/// against the owner public half it pinned out of band, instead of trusting the
/// package's word that these halves belong to the owner. The bytes are the same; the
/// difference is who has to be believed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OwnerDeviceAttestation {
    /// The device's 16-byte id, lowercase hex (the `device_id` the roster's signature
    /// was made under is not in the roster, so the recipient needs it here).
    pub device_id_hex: String,
    /// The person-signed binding row for that device (`MYU5`, `format_version 0x02`,
    /// which is the schema that carries the device public halves).
    pub entry: crate::device_binding_blob::DeviceBindingEntry,
}

impl OwnerDeviceAttestation {
    /// The device public halves the row carries, when the row is complete.
    #[must_use]
    pub fn device_public_half(&self) -> Option<crate::device_key::DevicePublicHalf> {
        crate::device_binding_blob::device_public_half_from_entry(&self.entry)
    }

    /// The device id as raw bytes.
    #[must_use]
    pub fn device_id(&self) -> Option<[u8; 16]> {
        if !is_lower_hex_of_len(&self.device_id_hex, 16) {
            return None;
        }
        let bytes = crate::hex::decode_lower::<16>(&self.device_id_hex)?;
        Some(bytes)
    }

    /// Whether the OWNER personally signed this row, which is the only thing that
    /// makes the halves inside it usable as a roster signer. Checked against the owner
    /// public half the caller already trusts, exactly like a binding row read from the
    /// store.
    #[must_use]
    pub fn verifies_against(&self, owner: &crate::person_key::PersonPublicHalf) -> bool {
        let Some(device_id) = self.device_id() else {
            return false;
        };
        self.entry.device_ed_pk.is_some()
            && !self.entry.tombstone
            && crate::device_binding_blob::verify_device_binding(owner, &device_id, &self.entry)
    }
}

fn encode_signed_group_frame(payload: &[u8], signature: &PersonSigned) -> Option<Vec<u8>> {
    if payload.is_empty()
        || payload.len() + SIGNED_GROUP_FRAME_OVERHEAD > SIGNED_GROUP_FRAME_CAP
        || signature.mldsa_sig.len() != PERSON_MLDSA_SIG_LEN
    {
        return None;
    }
    let mut out = Vec::with_capacity(payload.len() + SIGNED_GROUP_FRAME_OVERHEAD);
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    out.extend_from_slice(&signature.ed25519_sig);
    out.extend_from_slice(&signature.mldsa_sig);
    Some(out)
}

/// Decode a signed group frame into its payload and signature.
///
/// Public because a PORT has to do exactly this before it can verify anything, and because
/// the companion category's runner drives it over whole frames rather than hand-built
/// envelopes. Not a second codec: `decode_signed_group_package` and the roster reader both
/// call this one.
pub fn decode_signed_group_frame_public(bytes: &[u8]) -> Option<(Vec<u8>, PersonSigned)> {
    decode_signed_group_frame(bytes)
}

/// Encode a signed group frame. Public for the same reason: the vectors pin whole frames,
/// and the generator needs to produce them.
#[must_use]
pub fn encode_signed_group_frame_public(
    payload: &[u8],
    signature: &PersonSigned,
) -> Option<Vec<u8>> {
    encode_signed_group_frame(payload, signature)
}

fn decode_signed_group_frame(bytes: &[u8]) -> Option<(Vec<u8>, PersonSigned)> {
    if bytes.len() < SIGNED_GROUP_FRAME_OVERHEAD {
        return None;
    }
    let payload_len = u32::from_be_bytes(bytes[..4].try_into().ok()?) as usize;
    if payload_len == 0
        || payload_len + SIGNED_GROUP_FRAME_OVERHEAD != bytes.len()
        || bytes.len() > SIGNED_GROUP_FRAME_CAP
    {
        return None;
    }
    let ed_start = 4 + payload_len;
    let ml_start = ed_start + PERSON_ED25519_SIG_LEN;
    let mut ed25519_sig = [0u8; PERSON_ED25519_SIG_LEN];
    ed25519_sig.copy_from_slice(&bytes[ed_start..ml_start]);
    Some((
        bytes[4..ed_start].to_vec(),
        PersonSigned {
            ed25519_sig,
            mldsa_sig: bytes[ml_start..].to_vec(),
        },
    ))
}

/// Canonical binary envelope stored in the NTV6 signed-roster field.
pub fn encode_signed_group_roster(envelope: &SignedGroupRoster) -> Option<Vec<u8>> {
    encode_signed_group_frame(&envelope.payload, &envelope.signature)
}

/// Strict parser for the NTV6 signed-roster field.
pub fn decode_signed_group_roster(bytes: &[u8]) -> Option<SignedGroupRoster> {
    let (payload, signature) = decode_signed_group_frame(bytes)?;
    Some(SignedGroupRoster { payload, signature })
}

/// Canonical binary recipient-package envelope.
pub fn encode_signed_group_package(package: &SignedGroupPackage) -> Option<Vec<u8>> {
    encode_signed_group_frame(&package.payload, &package.signature)
}

/// Strict parser for a canonical recipient-package envelope.
pub fn decode_signed_group_package(bytes: &[u8]) -> Option<SignedGroupPackage> {
    let (payload, signature) = decode_signed_group_frame(bytes)?;
    Some(SignedGroupPackage { payload, signature })
}

fn class_message(prefix: &[u8], payload: &[u8]) -> Vec<u8> {
    let mut message = Vec::with_capacity(prefix.len() + payload.len());
    message.extend_from_slice(prefix);
    message.extend_from_slice(payload);
    message
}

/// Strict lowercase hex of an exact byte length (the length-scoped spelling of
/// [`crate::hex::is_lower_hex`]; `protocol.md` §3.1's ids travel as one
/// lowercase spelling).
fn is_lower_hex_of_len(s: &str, byte_len: usize) -> bool {
    s.len() == byte_len * 2 && crate::hex::is_lower_hex(s)
}

fn encode_wrapped_key(wrapped: &crate::person_key::PersonWrappedKey) -> String {
    let mut bytes = Vec::with_capacity(WRAPPED_32_BYTE_KEY_LEN);
    bytes.extend_from_slice(&wrapped.ed_ephemeral_pk);
    bytes.extend_from_slice(&wrapped.ml_kem_ct);
    bytes.extend_from_slice(&wrapped.nonce);
    bytes.extend_from_slice(&wrapped.wrapped_key);
    crate::hex::encode_lower(&bytes)
}

/// Encode, sort and validate a canonical NTV6 group roster payload.
pub fn encode_group_roster(payload: &GroupRosterPayload) -> Option<Vec<u8>> {
    let mut canonical = payload.clone();
    canonical
        .members
        .sort_by(|a, b| a.fingerprint_hex.cmp(&b.fingerprint_hex));
    validate_group_roster(&canonical)?;
    serde_json::to_vec(&canonical).ok()
}

/// Strictly parse canonical roster bytes. Unknown fields, unsorted rows and
/// non-canonical JSON are rejected by re-encoding and comparing byte-for-byte.
pub fn parse_group_roster(bytes: &[u8]) -> Option<GroupRosterPayload> {
    let payload: GroupRosterPayload = serde_json::from_slice(bytes).ok()?;
    validate_group_roster(&payload)?;
    if serde_json::to_vec(&payload).ok()?.as_slice() != bytes {
        return None;
    }
    Some(payload)
}

fn validate_group_roster(payload: &GroupRosterPayload) -> Option<()> {
    if payload.group_key_epoch == 0
        || !is_lower_hex_of_len(&payload.account_number_hash_hex, 16)
        || !is_lower_hex_of_len(&payload.owner_fingerprint_hex, 32)
        || payload.members.is_empty()
    {
        return None;
    }
    let mut previous: Option<&str> = None;
    let mut owner_count = 0usize;
    for member in &payload.members {
        if !is_lower_hex_of_len(&member.fingerprint_hex, 32)
            || member
                .person_id_hex
                .as_deref()
                .is_some_and(|p| !is_lower_hex_of_len(p, 16))
            || previous.is_some_and(|p| p >= member.fingerprint_hex.as_str())
        {
            return None;
        }
        previous = Some(&member.fingerprint_hex);
        let public = crate::person_key::PersonPublicHalf::from_parts_hex(
            &member.member_kem_ek_hex,
            &member.member_ed_pk_hex,
            &member.member_mldsa_vk_hex,
        )
        .ok()?;
        if crate::hex::encode_lower(public.fingerprint()) != member.fingerprint_hex {
            return None;
        }
        if member.role == GroupRosterRole::Owner {
            owner_count += 1;
            if member.state != GroupMemberState::Live
                || member.fingerprint_hex != payload.owner_fingerprint_hex
            {
                return None;
            }
        }
        match (member.role, member.state, &member.wrapped_group_key_hex) {
            (GroupRosterRole::Member, GroupMemberState::Live, Some(wrapped))
                if is_lower_hex_of_len(wrapped, WRAPPED_32_BYTE_KEY_LEN) => {}
            (GroupRosterRole::Owner, GroupMemberState::Live, None)
            | (_, GroupMemberState::Tombstone, None) => {}
            _ => return None,
        }
        if let Some(old) = &member.previous_fingerprint_hex {
            if !is_lower_hex_of_len(old, 32) || old == &member.fingerprint_hex {
                return None;
            }
        }
        match (&member.previous_fingerprint_hex, member.continuity) {
            (None, GroupKeyContinuity::Current)
            | (Some(_), GroupKeyContinuity::Changed | GroupKeyContinuity::OwnerConfirmed) => {}
            _ => return None,
        }
    }
    (owner_count == 1).then_some(())
}

/// Double-sign a canonical roster under its dedicated message class.
pub fn sign_group_roster(
    owner: &crate::person_key::PersonKeyPair,
    payload: &GroupRosterPayload,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<SignedGroupRoster, crate::person_key::PersonKeyError> {
    let payload =
        encode_group_roster(payload).ok_or(crate::person_key::PersonKeyError::SignatureVerify)?;
    let signature = owner.sign(&class_message(GROUP_ROSTER_PREFIX, &payload), rng)?;
    Ok(SignedGroupRoster { payload, signature })
}

/// Double-sign a canonical roster with a DEVICE key (`decisions/protocol/0731` stage 2).
///
/// The payload is unchanged: it still names the owner by PERSON fingerprint, and the
/// roster's semantic content is still people. What moves is the key that vouches for it,
/// which is the whole point of the stage: inviting and removing stop needing the phrase
/// once the owner's device holds a signing key.
///
/// The `SignedGroupRoster` frame is class-agnostic bytes (a 64-byte Ed25519 half and a
/// 3309-byte ML-DSA half), so a device signature fits it byte for byte and no envelope
/// changes. Which key may verify a given envelope is decided by the class prefix it was
/// signed under, never by the frame.
pub fn sign_group_roster_with_device(
    device: &crate::device_key::DeviceKeyPair,
    payload: &GroupRosterPayload,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<SignedGroupRoster, crate::person_key::PersonKeyError> {
    let payload =
        encode_group_roster(payload).ok_or(crate::person_key::PersonKeyError::SignatureVerify)?;
    let signature = device
        .sign(&class_message(GROUP_ROSTER_PREFIX_V2, &payload), rng)
        .map_err(|_| crate::person_key::PersonKeyError::SignatureVerify)?;
    Ok(SignedGroupRoster {
        payload,
        signature: PersonSigned {
            ed25519_sig: signature.ed25519_sig,
            mldsa_sig: signature.mldsa_sig,
        },
    })
}

/// Who a roster may have been signed by: the owner's PERSON key, and any device this
/// reader believes is bound to that owner.
///
/// A roster is signed by exactly one of them, so verification walks the candidate list
/// and stops at the class that matches. Two lists rather than one because the two
/// classes are not interchangeable: a person signed `v1`, a device signed `v2`, and a
/// signature from one class must never satisfy the other.
#[derive(Clone, Copy)]
pub struct RosterTrust<'a> {
    /// The owner's person public half, from the out-of-band identity code (a member) or
    /// from the held identity (the owner).
    pub owner_person: &'a crate::person_key::PersonPublicHalf,
    /// Device public halves that may have signed this roster. Empty on the owner's
    /// creation and migration paths, which sign with the person key.
    pub owner_devices: &'a [crate::device_key::DevicePublicHalf],
}

impl<'a> RosterTrust<'a> {
    /// Person key only, which is what every roster before stage 2 was signed with and
    /// what the creation and `NTV5` migration paths still use.
    #[must_use]
    pub fn person_only(owner_person: &'a crate::person_key::PersonPublicHalf) -> Self {
        Self {
            owner_person,
            owner_devices: &[],
        }
    }
}

/// Verify both signature halves, the canonical roster structure, AND that the
/// roster is for the vault the reader is opening.
///
/// The vault binding is load-bearing and mirrors [`open_group_package`]: without
/// it a malicious server (A1) could replay a genuine owner-signed roster from
/// another of the SAME owner's vaults, and a rotation would then tombstone and
/// repackage against a foreign member set.
pub fn verify_group_roster(
    trust: RosterTrust<'_>,
    envelope: &SignedGroupRoster,
    expected_account_number_hash: &[u8; 16],
) -> Result<GroupRosterPayload, crate::person_key::PersonKeyError> {
    // The PERSON class first: it is what every roster before stage 2 used, and a
    // failure there costs one verification while the common case stays one attempt.
    let person_ok = trust
        .owner_person
        .verify(
            &class_message(GROUP_ROSTER_PREFIX, &envelope.payload),
            &envelope.signature,
        )
        .is_ok();
    let signed_by_device = if person_ok {
        false
    } else {
        let message = class_message(GROUP_ROSTER_PREFIX_V2, &envelope.payload);
        let signature = crate::device_key::DeviceSigned {
            ed25519_sig: envelope.signature.ed25519_sig,
            mldsa_sig: envelope.signature.mldsa_sig.clone(),
        };
        let mut matched = false;
        for device in trust.owner_devices {
            if device.verify(&message, &signature).is_ok() {
                matched = true;
                break;
            }
        }
        if !matched {
            return Err(crate::person_key::PersonKeyError::SignatureVerify);
        }
        true
    };
    let payload = parse_group_roster(&envelope.payload)
        .ok_or(crate::person_key::PersonKeyError::SignatureVerify)?;
    // The owner binding is checked the same way in both classes: the payload names the
    // OWNER, so a device-signed roster still has to name the person this reader pinned.
    if crate::hex::encode_lower(trust.owner_person.fingerprint()) != payload.owner_fingerprint_hex
        || payload.account_number_hash_hex != crate::hex::encode_lower(expected_account_number_hash)
    {
        return Err(crate::person_key::PersonKeyError::SignatureVerify);
    }
    // A device signature is only accepted when the device list was non-empty; that is
    // implied by reaching here, and stated so a reader changing this function keeps it.
    let _ = signed_by_device;
    Ok(payload)
}

/// Build and sign one recipient's group-key package.
pub fn create_group_package(
    owner: &crate::person_key::PersonKeyPair,
    recipient: &crate::person_key::PersonPublicHalf,
    group_key: &[u8; 32],
    account_number_hash: &[u8; 16],
    group_key_epoch: u64,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<SignedGroupPackage, crate::person_key::PersonKeyError> {
    create_group_package_with_attestation(
        owner,
        recipient,
        group_key,
        account_number_hash,
        group_key_epoch,
        None,
        rng,
    )
}

/// [`create_group_package`] carrying the owner's device attestation, which a recipient
/// needs to verify a roster the owner signed with a DEVICE key rather than the person
/// key (`decisions/protocol/0733`).
///
/// A package WITHOUT the attestation is still valid and still verifies a person-signed
/// roster: the field is optional, and its absence means "this owner authors rosters with
/// the person key", which is every build that predates the change and every platform
/// with no device-key rung.
pub fn create_group_package_with_attestation(
    owner: &crate::person_key::PersonKeyPair,
    recipient: &crate::person_key::PersonPublicHalf,
    group_key: &[u8; 32],
    account_number_hash: &[u8; 16],
    group_key_epoch: u64,
    owner_device: Option<&OwnerDeviceAttestation>,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<SignedGroupPackage, crate::person_key::PersonKeyError> {
    if group_key_epoch == 0 {
        return Err(crate::person_key::PersonKeyError::AeadFailure);
    }
    // An attestation that does not verify against the signer is refused HERE rather
    // than shipped: a package carrying a row its own author did not sign would leave
    // every recipient unable to resolve the roster, one network round trip away from
    // the mistake.
    if let Some(attestation) = owner_device {
        if !attestation.verifies_against(&owner.public_half()) {
            return Err(crate::person_key::PersonKeyError::SignatureVerify);
        }
    }
    let wrapped = recipient.wrap_key(group_key, account_number_hash, rng)?;
    let payload = GroupPackagePayload {
        account_number_hash_hex: crate::hex::encode_lower(account_number_hash),
        group_key_epoch,
        recipient_fingerprint_hex: crate::hex::encode_lower(recipient.fingerprint()),
        wrapped_group_key_hex: encode_wrapped_key(&wrapped),
        owner_device: owner_device.cloned(),
    };
    let payload =
        serde_json::to_vec(&payload).map_err(|_| crate::person_key::PersonKeyError::AeadFailure)?;
    let signature = owner.sign(&class_message(GROUP_PACKAGE_PREFIX, &payload), rng)?;
    Ok(SignedGroupPackage { payload, signature })
}

/// Verify the owner signature and parse one canonical group package without
/// opening it. Used to compare the package against the signed roster first.
pub fn verify_group_package(
    owner: &crate::person_key::PersonPublicHalf,
    package: &SignedGroupPackage,
) -> Result<GroupPackagePayload, crate::person_key::PersonKeyError> {
    owner.verify(
        &class_message(GROUP_PACKAGE_PREFIX, &package.payload),
        &package.signature,
    )?;
    let payload: GroupPackagePayload = serde_json::from_slice(&package.payload)
        .map_err(|_| crate::person_key::PersonKeyError::AeadFailure)?;
    if serde_json::to_vec(&payload).ok().as_deref() != Some(package.payload.as_slice())
        || payload.group_key_epoch == 0
        || !is_lower_hex_of_len(&payload.account_number_hash_hex, 16)
        || !is_lower_hex_of_len(&payload.recipient_fingerprint_hex, 32)
        || !is_lower_hex_of_len(&payload.wrapped_group_key_hex, WRAPPED_32_BYTE_KEY_LEN)
    {
        return Err(crate::person_key::PersonKeyError::AeadFailure);
    }
    Ok(payload)
}

/// Verify and open a recipient package at exactly the expected vault and epoch.
pub fn open_group_package(
    owner: &crate::person_key::PersonPublicHalf,
    recipient: &crate::person_key::PersonKeyPair,
    package: &SignedGroupPackage,
    expected_account_number_hash: &[u8; 16],
    expected_epoch: u64,
) -> Result<zeroize::Zeroizing<[u8; 32]>, crate::person_key::PersonKeyError> {
    let payload = verify_group_package(owner, package)?;
    if payload.group_key_epoch != expected_epoch
        || payload.account_number_hash_hex != crate::hex::encode_lower(expected_account_number_hash)
        || payload.recipient_fingerprint_hex != crate::hex::encode_lower(recipient.fingerprint())
    {
        return Err(crate::person_key::PersonKeyError::AeadFailure);
    }
    let wrapped = decode_wrapped_hex(&payload.wrapped_group_key_hex)?;
    recipient.unwrap_key(&wrapped, expected_account_number_hash)
}

/// Which namespace an `NTV6` group-key epoch retirement applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum RetiredNamespaceKind {
    /// The group-key namespace: the retired epoch's `group_key` and every wrap
    /// under it. `namespace_id` is the vault's account-number hash.
    GroupKey = 0x01,
    /// The content namespace: the `itemsKey` lineage the retired group key
    /// wrapped. `namespace_id` is the vault's `items_key_id`.
    ItemsKey = 0x02,
}

impl RetiredNamespaceKind {
    fn from_byte(byte: u8) -> Option<Self> {
        match byte {
            0x01 => Some(Self::GroupKey),
            0x02 => Some(Self::ItemsKey),
            _ => None,
        }
    }
}

/// Canonical owner-authored group-epoch retirement record.
///
/// FIXED BINARY (33 bytes over a zero-length body), deliberately not JSON and
/// deliberately carrying NO timestamp. A wall-clock field would be
/// user-meaningful metadata the retirement deliberately does not expose, and
/// the epoch pair is the only ordering signal a verifier needs. A retired
/// epoch must be followed by its immediate successor: an epoch that skips or
/// repeats is refused, so two devices cannot mine a competing "next" epoch.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GroupRetirementPayload {
    pub retired_epoch: u64,
    pub replacement_epoch: u64,
    pub namespace_kind: RetiredNamespaceKind,
    pub namespace_id: [u8; 16],
}

/// The canonical 33-byte retirement payload: retired+replacement epochs, the
/// namespace kind byte, the 16-byte namespace id.
pub const GROUP_RETIREMENT_PAYLOAD_LEN: usize = 8 + 8 + 1 + 16;

/// Encode a retirement payload to its fixed 33-byte form. `None` when the
/// epoch pair is not a strict immediate succession, which is the one structural
/// rule that keeps the record canonical.
pub fn encode_group_retirement(payload: &GroupRetirementPayload) -> Option<Vec<u8>> {
    if payload.retired_epoch == 0 || payload.replacement_epoch != payload.retired_epoch + 1 {
        return None;
    }
    let mut out = Vec::with_capacity(GROUP_RETIREMENT_PAYLOAD_LEN);
    out.extend_from_slice(&payload.retired_epoch.to_be_bytes());
    out.extend_from_slice(&payload.replacement_epoch.to_be_bytes());
    out.push(payload.namespace_kind as u8);
    out.extend_from_slice(&payload.namespace_id);
    Some(out)
}

/// Strictly parse the fixed 33-byte retirement payload. Trailing bytes are a
/// rejection (§10.3.1 strict-trailing discipline).
pub fn parse_group_retirement(bytes: &[u8]) -> Option<GroupRetirementPayload> {
    if bytes.len() != GROUP_RETIREMENT_PAYLOAD_LEN {
        return None;
    }
    let retired_epoch = u64::from_be_bytes(bytes[0..8].try_into().ok()?);
    let replacement_epoch = u64::from_be_bytes(bytes[8..16].try_into().ok()?);
    let namespace_kind = RetiredNamespaceKind::from_byte(bytes[16])?;
    let mut namespace_id = [0u8; 16];
    namespace_id.copy_from_slice(&bytes[17..33]);
    let payload = GroupRetirementPayload {
        retired_epoch,
        replacement_epoch,
        namespace_kind,
        namespace_id,
    };
    if encode_group_retirement(&payload).as_deref() != Some(bytes) {
        return None;
    }
    Some(payload)
}

/// Owner-signed retirement record. The owner public half is obtained from the
/// pinned identity, not trusted from this envelope.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedGroupRetirement {
    pub payload: Vec<u8>,
    pub signature: PersonSigned,
}

/// Canonical binary envelope for a signed retirement record (same frame as the
/// roster/package: u32 length, payload, Ed25519 sig, ML-DSA sig).
pub fn encode_signed_group_retirement(record: &SignedGroupRetirement) -> Option<Vec<u8>> {
    encode_signed_group_frame(&record.payload, &record.signature)
}

/// Strictly parse a signed retirement envelope.
pub fn decode_signed_group_retirement(bytes: &[u8]) -> Option<SignedGroupRetirement> {
    let (payload, signature) = decode_signed_group_frame(bytes)?;
    parse_group_retirement(&payload)?;
    Some(SignedGroupRetirement { payload, signature })
}

/// Double-sign a canonical retirement payload under its dedicated class.
pub fn sign_group_retirement(
    owner: &crate::person_key::PersonKeyPair,
    payload: &GroupRetirementPayload,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<SignedGroupRetirement, crate::person_key::PersonKeyError> {
    let payload = encode_group_retirement(payload)
        .ok_or(crate::person_key::PersonKeyError::SignatureVerify)?;
    let signature = owner.sign(&class_message(GROUP_RETIREMENT_PREFIX, &payload), rng)?;
    Ok(SignedGroupRetirement { payload, signature })
}

/// Verify BOTH signature halves against the pinned owner public half and parse
/// the fixed payload. Both halves are mandatory: a retirement a server could
/// forge would let it retire an epoch it never saw.
/// Verify BOTH signature halves against the pinned owner public half, parse the
/// fixed payload, and **bind the record to the verifying vault**: a
/// `GroupKey`-namespace retirement must name this vault's `account_number_hash`
/// and an `ItemsKey`-namespace one must name its `items_key_id`. A retirement
/// copied from another vault therefore fails here instead of being accepted as
/// a legitimate epoch change (the Grill 3 review's D4 finding).
pub fn verify_group_retirement(
    owner: &crate::person_key::PersonPublicHalf,
    envelope: &SignedGroupRetirement,
    account_number_hash: &[u8; 16],
    items_key_id: &[u8; 16],
) -> Result<GroupRetirementPayload, crate::person_key::PersonKeyError> {
    owner.verify(
        &class_message(GROUP_RETIREMENT_PREFIX, &envelope.payload),
        &envelope.signature,
    )?;
    let payload = parse_group_retirement(&envelope.payload)
        .ok_or(crate::person_key::PersonKeyError::SignatureVerify)?;
    let expected = match payload.namespace_kind {
        RetiredNamespaceKind::GroupKey => account_number_hash,
        RetiredNamespaceKind::ItemsKey => items_key_id,
    };
    if &payload.namespace_id != expected {
        return Err(crate::person_key::PersonKeyError::SignatureVerify);
    }
    Ok(payload)
}

/// The canonical person-key transition payload length: the superseded
/// identity's three public halves plus the replacement fingerprint.
pub const PERSON_KEY_TRANSITION_PAYLOAD_LEN: usize = crate::person_key::PERSON_EK_LEN
    + crate::person_key::PERSON_ED25519_PK_LEN
    + crate::person_key::PERSON_MLDSA_VK_LEN
    + crate::person_key::PERSON_FINGERPRINT_LEN;

/// Canonical person-key transition payload (`decisions/protocol/0604`): the
/// SUPERSEDED identity's public halves plus the REPLACEMENT fingerprint.
///
/// FIXED BINARY, no timestamp. The record is signed by the superseded key, so a
/// verifier holding only this payload can rebuild the old public half, recompute
/// the old fingerprint, and check both signature halves; the new fingerprint
/// must equal the live roster row's. It exists because a deterministic identity
/// migration changes a person's fingerprint, and the change must be
/// cryptographic continuity rather than a silent edit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonKeyTransitionPayload {
    pub old_kem_ek: [u8; crate::person_key::PERSON_EK_LEN],
    pub old_ed_pk: [u8; crate::person_key::PERSON_ED25519_PK_LEN],
    pub old_mldsa_vk: [u8; crate::person_key::PERSON_MLDSA_VK_LEN],
    pub new_fingerprint: [u8; crate::person_key::PERSON_FINGERPRINT_LEN],
}

/// Encode the transition payload to its fixed binary form.
#[must_use]
pub fn encode_person_key_transition(payload: &PersonKeyTransitionPayload) -> Vec<u8> {
    let mut out = Vec::with_capacity(PERSON_KEY_TRANSITION_PAYLOAD_LEN);
    out.extend_from_slice(&payload.old_kem_ek);
    out.extend_from_slice(&payload.old_ed_pk);
    out.extend_from_slice(&payload.old_mldsa_vk);
    out.extend_from_slice(&payload.new_fingerprint);
    out
}

/// Strictly parse the fixed transition payload (trailing bytes are a rejection).
#[must_use]
pub fn parse_person_key_transition(bytes: &[u8]) -> Option<PersonKeyTransitionPayload> {
    if bytes.len() != PERSON_KEY_TRANSITION_PAYLOAD_LEN {
        return None;
    }
    let ek_end = crate::person_key::PERSON_EK_LEN;
    let ed_end = ek_end + crate::person_key::PERSON_ED25519_PK_LEN;
    let ml_end = ed_end + crate::person_key::PERSON_MLDSA_VK_LEN;
    let mut old_kem_ek = [0u8; crate::person_key::PERSON_EK_LEN];
    let mut old_ed_pk = [0u8; crate::person_key::PERSON_ED25519_PK_LEN];
    let mut old_mldsa_vk = [0u8; crate::person_key::PERSON_MLDSA_VK_LEN];
    let mut new_fingerprint = [0u8; crate::person_key::PERSON_FINGERPRINT_LEN];
    old_kem_ek.copy_from_slice(&bytes[..ek_end]);
    old_ed_pk.copy_from_slice(&bytes[ek_end..ed_end]);
    old_mldsa_vk.copy_from_slice(&bytes[ed_end..ml_end]);
    new_fingerprint.copy_from_slice(&bytes[ml_end..]);
    Some(PersonKeyTransitionPayload {
        old_kem_ek,
        old_ed_pk,
        old_mldsa_vk,
        new_fingerprint,
    })
}

/// Person-signed transition record (same binary frame as the roster/package).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignedPersonKeyTransition {
    pub payload: Vec<u8>,
    pub signature: PersonSigned,
}

/// Canonical binary envelope for a signed transition record.
#[must_use]
pub fn encode_signed_person_key_transition(record: &SignedPersonKeyTransition) -> Option<Vec<u8>> {
    encode_signed_group_frame(&record.payload, &record.signature)
}

/// Strictly parse a signed transition envelope.
#[must_use]
pub fn decode_signed_person_key_transition(bytes: &[u8]) -> Option<SignedPersonKeyTransition> {
    let (payload, signature) = decode_signed_group_frame(bytes)?;
    parse_person_key_transition(&payload)?;
    Some(SignedPersonKeyTransition { payload, signature })
}

/// Double-sign a transition payload with the SUPERSEDED key under its dedicated
/// class. The old key is available only at the moment of migration, which is why
/// the record must be minted then.
pub fn sign_person_key_transition(
    superseded: &crate::person_key::PersonKeyPair,
    payload: &PersonKeyTransitionPayload,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<SignedPersonKeyTransition, crate::person_key::PersonKeyError> {
    let payload = encode_person_key_transition(payload);
    let signature = superseded.sign(&class_message(PERSON_KEY_TRANSITION_PREFIX, &payload), rng)?;
    Ok(SignedPersonKeyTransition { payload, signature })
}

/// Verify BOTH signature halves against the superseded key carried in the
/// payload, and return `(old_fingerprint, new_fingerprint)`. Both halves are
/// mandatory: a transition a server or a third party could forge would let it
/// claim a key change that never happened.
pub fn verify_person_key_transition(
    envelope: &SignedPersonKeyTransition,
) -> Result<
    (
        [u8; crate::person_key::PERSON_FINGERPRINT_LEN],
        [u8; crate::person_key::PERSON_FINGERPRINT_LEN],
    ),
    crate::person_key::PersonKeyError,
> {
    let payload = parse_person_key_transition(&envelope.payload)
        .ok_or(crate::person_key::PersonKeyError::SignatureVerify)?;
    let superseded = crate::person_key::PersonPublicHalf::from_parts(
        &payload.old_kem_ek,
        &payload.old_ed_pk,
        &payload.old_mldsa_vk,
    );
    superseded.verify(
        &class_message(PERSON_KEY_TRANSITION_PREFIX, &envelope.payload),
        &envelope.signature,
    )?;
    Ok((*superseded.fingerprint(), payload.new_fingerprint))
}

/// The minimum length of a sealed roster envelope: a 24-byte nonce plus the
/// 32-byte CTX tag of an empty ciphertext. Anything shorter cannot be a seal.
pub const SEALED_GROUP_ROSTER_MIN_LEN: usize = AEAD_NONCE_LEN + 32;

/// Seal an owner-signed roster for storage in an `NTV6` `vault.meta`'s
/// `signed_roster_envelope`.
///
/// The envelope is `nonce (24) || AEAD(encode_signed_group_roster(frame))` under
/// `derive_group_subkey_v0_2(group_key, GroupRole::GroupRosterKey)`, with
/// `aad_group_roster_blob(account_number_hash, group_key_epoch)`. Sealing is
/// load-bearing: the roster carries user-authored display names, fingerprints
/// and public halves, so an unsealed frame would disclose the collaboration
/// graph to the sync server (A1) and to any at-rest observer.
pub fn seal_group_roster(
    group_key: &[u8; 32],
    account_number_hash: &[u8; 16],
    group_key_epoch: u64,
    nonce: &[u8; AEAD_NONCE_LEN],
    roster: &SignedGroupRoster,
) -> Option<Vec<u8>> {
    let frame = encode_signed_group_roster(roster)?;
    let key = crate::subkey::derive_group_subkey_v0_2(
        &crate::subkey::GroupKey::new(*group_key),
        crate::subkey::GroupRole::GroupRosterKey,
    );
    let aad = crate::aead::aad_group_roster_blob(account_number_hash, group_key_epoch);
    let sealed = crate::aead::aead_seal_ctx(&key, nonce, &frame, &aad).ok()?;
    let mut out = Vec::with_capacity(AEAD_NONCE_LEN + sealed.len());
    out.extend_from_slice(nonce);
    out.extend_from_slice(&sealed);
    Some(out)
}

/// Open a sealed roster envelope with the vault's current group key and epoch.
/// `None` on any failure (wrong key, wrong vault/epoch AAD, tamper, or a frame
/// that does not decode) — non-distinguishing, per §6.4. The caller MUST then
/// `verify_group_roster` the result against the pinned owner public half.
pub fn open_group_roster(
    group_key: &[u8; 32],
    account_number_hash: &[u8; 16],
    group_key_epoch: u64,
    envelope: &[u8],
) -> Option<SignedGroupRoster> {
    if envelope.len() < SEALED_GROUP_ROSTER_MIN_LEN {
        return None;
    }
    let nonce: [u8; AEAD_NONCE_LEN] = envelope[..AEAD_NONCE_LEN].try_into().ok()?;
    let key = crate::subkey::derive_group_subkey_v0_2(
        &crate::subkey::GroupKey::new(*group_key),
        crate::subkey::GroupRole::GroupRosterKey,
    );
    let aad = crate::aead::aad_group_roster_blob(account_number_hash, group_key_epoch);
    let plaintext =
        crate::aead::aead_open_ctx(&key, &nonce, &envelope[AEAD_NONCE_LEN..], &aad).ok()?;
    decode_signed_group_roster(&plaintext)
}

/// Whether `incoming` may supersede `current`.
///
/// Strictly greater wins; an EQUAL epoch is refused rather than tie-broken,
/// because two conflicting signed rosters at the same epoch cannot both be
/// canonical and picking one would let a server choose; a lower epoch is a
/// rollback. Returns the accepted epoch.
pub fn accept_newer_epoch(current: u64, incoming: u64) -> Option<u64> {
    (incoming > current).then_some(incoming)
}

/// Require a verified package to match the same signed roster epoch and row.
pub fn package_matches_roster(roster: &GroupRosterPayload, package: &GroupPackagePayload) -> bool {
    roster.group_key_epoch == package.group_key_epoch
        && roster.account_number_hash_hex == package.account_number_hash_hex
        && roster.members.iter().any(|member| {
            member.state == GroupMemberState::Live
                && member.fingerprint_hex == package.recipient_fingerprint_hex
                && member.wrapped_group_key_hex.as_deref()
                    == Some(package.wrapped_group_key_hex.as_str())
        })
}

/// The result of one local canonical group rotation: the new signed roster, the
/// fresh per-recipient packages for every REMAINING member, and the retirement
/// records for the retired epoch.
pub struct RotatedGroup {
    pub signed_roster: SignedGroupRoster,
    pub packages: Vec<SignedGroupPackage>,
    pub retirements: Vec<SignedGroupRetirement>,
    pub new_epoch: u64,
}

/// Build the LOCAL canonical group rotation for removing one member.
///
/// Mints nothing secret itself: the caller supplies the fresh random
/// `group_key` (and separately a fresh `itemsKey` for the header rewrap), so
/// entropy stays at the boundary. This composes the existing primitives into
/// the one canonical shape:
///
/// - the removed row becomes a signed TOMBSTONE with no wrap;
/// - every other LIVE member gets a fresh package wrapping the NEW group key at
///   `new_epoch` (the owner row keeps no wrap — the owner holds `root_key`);
/// - the new roster is signed under `myne.group-roster v1|`;
/// - two retirement records are signed under `myne.group-retirement v1|`: the
///   retired group-key namespace (id = account-number hash) and the retired
///   content namespace (id = `items_key_id`), both `retired → retired + 1` so a
///   competing successor cannot be mined;
/// - `new_epoch` is `current + 1`, which is what makes a conflicting equal epoch
///   impossible by construction.
///
/// It refuses a removed fingerprint that is not a live member, and an epoch that
/// `accept_newer_epoch` would not accept (i.e. the arithmetic overflow case).
pub fn rotate_group_roster(
    owner: &crate::person_key::PersonKeyPair,
    current: &GroupRosterPayload,
    removed_fingerprint_hex: &str,
    new_group_key: &[u8; 32],
    account_number_hash: &[u8; 16],
    items_key_id: &[u8; 16],
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<RotatedGroup, crate::person_key::PersonKeyError> {
    rotate_group_roster_signed_by(
        owner,
        None,
        None,
        current,
        removed_fingerprint_hex,
        new_group_key,
        account_number_hash,
        items_key_id,
        rng,
    )
}

/// [`rotate_group_roster`] with the roster and the per-member packages signed by the
/// owner's DEVICE key, and each package carrying the attestation a recipient needs to
/// verify that roster (`decisions/protocol/0731` stage 2, `0733`).
///
/// `device` and `attestation` travel together and are either both `Some` or both `None`:
/// a device-signed roster whose packages carry no attestation is a rotation no member can
/// open, so the pair is a single decision at this boundary rather than two parameters a
/// caller could get half right. Passing `None` for both is exactly
/// [`rotate_group_roster`].
///
/// Removal stays PERSON-signed on the retirement records either way. Those records are
/// not read by members to decide what to open: they name a retired namespace for the
/// server's reclaim path, and every member's trust decision is the roster. Moving them
/// would widen this change for no friction removed.
#[allow(clippy::too_many_arguments)]
pub fn rotate_group_roster_signed_by(
    owner: &crate::person_key::PersonKeyPair,
    device: Option<&crate::device_key::DeviceKeyPair>,
    attestation: Option<&OwnerDeviceAttestation>,
    current: &GroupRosterPayload,
    removed_fingerprint_hex: &str,
    new_group_key: &[u8; 32],
    account_number_hash: &[u8; 16],
    items_key_id: &[u8; 16],
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<RotatedGroup, crate::person_key::PersonKeyError> {
    use crate::person_key::PersonPublicHalf;
    // One decision, checked here: a device signature without an attestation would make
    // every member's roster verification fail, one network round trip after the mistake.
    if device.is_some() != attestation.is_some() {
        return Err(crate::person_key::PersonKeyError::SignatureVerify);
    }
    if let Some(attestation) = attestation {
        if !attestation.verifies_against(&owner.public_half()) {
            return Err(crate::person_key::PersonKeyError::SignatureVerify);
        }
    }
    let removed = current
        .members
        .iter()
        .find(|m| m.fingerprint_hex == removed_fingerprint_hex && m.state == GroupMemberState::Live)
        .ok_or(crate::person_key::PersonKeyError::SignatureVerify)?;
    if removed.role == GroupRosterRole::Owner {
        // Removing the owner is not a rotation; it is an owner transfer, which
        // this model does not express.
        return Err(crate::person_key::PersonKeyError::SignatureVerify);
    }
    let new_epoch = current
        .group_key_epoch
        .checked_add(1)
        .filter(|next| accept_newer_epoch(current.group_key_epoch, *next).is_some())
        .ok_or(crate::person_key::PersonKeyError::AeadFailure)?;

    let mut members = Vec::with_capacity(current.members.len());
    let mut packages = Vec::new();
    for member in &current.members {
        if member.fingerprint_hex == removed_fingerprint_hex {
            members.push(GroupRosterMember {
                state: GroupMemberState::Tombstone,
                wrapped_group_key_hex: None,
                ..member.clone()
            });
            continue;
        }
        if member.role == GroupRosterRole::Owner {
            members.push(member.clone());
            continue;
        }
        if member.state != GroupMemberState::Live {
            members.push(member.clone());
            continue;
        }
        let public = PersonPublicHalf::from_parts_hex(
            &member.member_kem_ek_hex,
            &member.member_ed_pk_hex,
            &member.member_mldsa_vk_hex,
        )?;
        let package = create_group_package_with_attestation(
            owner,
            &public,
            new_group_key,
            account_number_hash,
            new_epoch,
            attestation,
            rng,
        )?;
        let payload: GroupPackagePayload = serde_json::from_slice(&package.payload)
            .map_err(|_| crate::person_key::PersonKeyError::AeadFailure)?;
        members.push(GroupRosterMember {
            wrapped_group_key_hex: Some(payload.wrapped_group_key_hex),
            ..member.clone()
        });
        packages.push(package);
    }

    let new_roster = GroupRosterPayload {
        account_number_hash_hex: current.account_number_hash_hex.clone(),
        group_key_epoch: new_epoch,
        owner_fingerprint_hex: current.owner_fingerprint_hex.clone(),
        members,
    };
    let signed_roster = match device {
        Some(device) => sign_group_roster_with_device(device, &new_roster, rng)?,
        None => sign_group_roster(owner, &new_roster, rng)?,
    };

    let mut retirements = Vec::with_capacity(2);
    for (kind, id) in [
        (RetiredNamespaceKind::GroupKey, *account_number_hash),
        (RetiredNamespaceKind::ItemsKey, *items_key_id),
    ] {
        let record = sign_group_retirement(
            owner,
            &GroupRetirementPayload {
                retired_epoch: current.group_key_epoch,
                replacement_epoch: new_epoch,
                namespace_kind: kind,
                namespace_id: id,
            },
            rng,
        )?;
        retirements.push(record);
    }

    Ok(RotatedGroup {
        signed_roster,
        packages,
        retirements,
        new_epoch,
    })
}

/// The AAD bound into the invite payload envelope: v0.2 prefix + version +
/// role `"vault-invite-blob"`.
///
/// DISTINCT from `person_key::aad_person_wrap` on purpose: the payload
/// envelope is a different message class from a per-recipient `itemsKey`
/// wrap, so reusing that AAD would collapse two classes into one domain.
/// The role is sync-wire-only (no §10.3 family), so it binds nothing else:
/// the vault binding the member needs arrives on the inner
/// `wrapped_items_key_hex`, whose own AAD carries `account_number_hash`.
pub fn aad_vault_invite() -> Vec<u8> {
    const ROLE_STR_VAULT_INVITE: &[u8] = b"vault-invite-blob";
    let mut aad = Vec::with_capacity(AAD_PREFIX_V0_2.len() + 1 + 2 + ROLE_STR_VAULT_INVITE.len());
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    crate::aead::push_length_prefixed_u16_be(&mut aad, ROLE_STR_VAULT_INVITE);
    aad
}

/// The signed invite payload (the canonical-JSON inner plaintext).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InvitePayload {
    /// The vault owner's person fingerprint (64-char lowercase hex).
    pub owner_fingerprint_hex: String,
    /// The invited member's person fingerprint (64-char lowercase hex) :
    /// the SAS value both screens render at accept time.
    pub member_fingerprint_hex: String,
    /// The vault `itemsKey` wrapped to the member: lowercase hex of the
    /// wrapped-key pieces concatenated in fixed order
    /// (ed_ephemeral_pk || ml_kem_ct || nonce || wrapped_key).
    pub wrapped_items_key_hex: String,
    /// The vault's human-readable name (AS3-Sensitive, envelope-enclosed).
    pub vault_label: String,
    /// Unix epoch SECONDS the invite was created (user-meaningful,
    /// envelope-enclosed). TTL checks live host-side.
    pub created_at: u64,
}

/// The complete signed invite: the sealed payload frame + the owner's
/// public material so the member verifies without a key round-trip.
///
/// Every byte the member must trust arrives either AEAD-sealed to the
/// member (the payload frame) or signature-bound (the carried owner
/// halves, the fingerprints, the vault hash). Nothing the member acts on
/// is signed-plaintext.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultInvite {
    /// Sealed payload ciphertext: the canonical payload JSON AEAD-sealed
    /// to the member under the PQ-hybrid envelope (plaintext + 16 B tag
    /// + 32 B CTX).
    pub enc_payload: Vec<u8>,
    /// Nonce for the payload-frame AEAD.
    pub nonce: [u8; 24],
    /// ML-KEM ciphertext of the payload frame's fresh envelope (1088 B).
    pub env_ml_kem_ct: [u8; crate::person_key::PERSON_CT_LEN],
    /// Classical-half ephemeral public of the payload frame (32 B).
    pub env_ed_ephemeral_pk: [u8; crate::person_key::PERSON_ED25519_PK_LEN],
    /// The vault's `account_number_hash` (16 B, lowercase hex). Carried in
    /// the clear: a non-member has no other way to learn it, and it is not
    /// a secret (the sync server already keys accounts by its hash). It is
    /// not part of the outer signature; tampering it fails the inner
    /// per-recipient `itemsKey` unwrap, whose AAD binds it, so proof of
    /// receipt is what authenticates this field.
    pub account_number_hash_hex: String,
    /// The owner's ML-KEM encapsulation key (1184 B, lowercase hex),
    /// carried so the member reconstructs the full three-half public
    /// material and checks it against the claimed fingerprint.
    pub owner_kem_ek_hex: String,
    /// The owner's ML-DSA verifying key (1952 B, lowercase hex), carried so
    /// the member verifies without a key round-trip.
    pub owner_mldsa_vk_hex: String,
    /// The owner's Ed25519 public key (32 B, lowercase hex).
    pub owner_ed25519_pk_hex: String,
    /// The owner's fingerprint (the SAS compare value).
    pub owner_fingerprint_hex: String,
    /// The member's fingerprint (the SAS compare value).
    pub member_fingerprint_hex: String,
    /// The owner's double signature over `INVITE_PREFIX || env_ml_kem_ct
    /// || env_ed_ephemeral_pk || nonce || enc_payload`.
    pub signature: PersonSigned,
}

/// Canonical-JSON serialization of the invite payload.
pub fn encode_invite_payload(payload: &InvitePayload) -> Vec<u8> {
    serde_json::to_vec(payload).expect("canonical-JSON invite serialization is infallible")
}

/// The relay wire form of a whole [`VaultInvite`]: the byte fields hex-encoded
/// into a canonical-JSON object, so the owner can hand the frame to a member
/// over any transport (the roster route is Grill 4's `myne-md/myne#698`).
///
/// Reversible by [`vault_invite_from_wire`], which is what the accept side will
/// consume. The signature's two halves ride hex-encoded too, so the frame is a
/// single self-contained string.
pub fn vault_invite_to_wire(invite: &VaultInvite) -> String {
    let sig = &invite.signature;
    let obj = serde_json::json!({
        "enc_payload_hex": crate::hex::encode_lower(&invite.enc_payload),
        "nonce_hex": crate::hex::encode_lower(&invite.nonce),
        "env_ml_kem_ct_hex": crate::hex::encode_lower(&invite.env_ml_kem_ct),
        "env_ed_ephemeral_pk_hex": crate::hex::encode_lower(&invite.env_ed_ephemeral_pk),
        "account_number_hash_hex": invite.account_number_hash_hex,
        "owner_kem_ek_hex": invite.owner_kem_ek_hex,
        "owner_mldsa_vk_hex": invite.owner_mldsa_vk_hex,
        "owner_ed25519_pk_hex": invite.owner_ed25519_pk_hex,
        "owner_fingerprint_hex": invite.owner_fingerprint_hex,
        "member_fingerprint_hex": invite.member_fingerprint_hex,
        "signature_ed25519_hex": crate::hex::encode_lower(&sig.ed25519_sig),
        "signature_mldsa_hex": crate::hex::encode_lower(&sig.mldsa_sig),
    });
    serde_json::to_string(&obj).expect("canonical-JSON invite wire serialization is infallible")
}

/// Parse the wire form produced by [`vault_invite_to_wire`]. Any structural
/// problem (missing field, wrong length, uppercase hex) yields `None`.
pub fn vault_invite_from_wire(s: &str) -> Option<VaultInvite> {
    let v: serde_json::Value = serde_json::from_str(s).ok()?;
    let get = |k: &str| -> Option<&str> { v.get(k)?.as_str() };
    let dec = |k: &str| -> Option<Vec<u8>> { hex_decode_lower(get(k)?) };
    let nonce: [u8; 24] = dec("nonce_hex")?.try_into().ok()?;
    let env_ml_kem_ct: [u8; PERSON_CT_LEN] = dec("env_ml_kem_ct_hex")?.try_into().ok()?;
    let env_ed_ephemeral_pk: [u8; PERSON_ED25519_PK_LEN] =
        dec("env_ed_ephemeral_pk_hex")?.try_into().ok()?;
    let ed25519_sig: [u8; crate::person_key::PERSON_ED25519_SIG_LEN] =
        dec("signature_ed25519_hex")?.try_into().ok()?;
    Some(VaultInvite {
        enc_payload: dec("enc_payload_hex")?,
        nonce,
        env_ml_kem_ct,
        env_ed_ephemeral_pk,
        account_number_hash_hex: get("account_number_hash_hex")?.into(),
        owner_kem_ek_hex: get("owner_kem_ek_hex")?.into(),
        owner_mldsa_vk_hex: get("owner_mldsa_vk_hex")?.into(),
        owner_ed25519_pk_hex: get("owner_ed25519_pk_hex")?.into(),
        owner_fingerprint_hex: get("owner_fingerprint_hex")?.into(),
        member_fingerprint_hex: get("member_fingerprint_hex")?.into(),
        signature: PersonSigned {
            ed25519_sig,
            mldsa_sig: dec("signature_mldsa_hex")?,
        },
    })
}

/// Decode lowercase hex only (uppercase is rejected, matching the crate-wide
/// discipline).
fn hex_decode_lower(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let val = |b: u8| -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            _ => None,
        }
    };
    let mut out = Vec::with_capacity(s.len() / 2);
    for pair in s.as_bytes().chunks(2) {
        out.push((val(pair[0])? << 4) | val(pair[1])?);
    }
    Some(out)
}

/// Strict parse of the invite payload. Any structural violation (wrong
/// field type, uppercase or wrong-length fingerprint) yields `None`.
pub fn parse_invite_payload(bytes: &[u8]) -> Option<InvitePayload> {
    let payload: InvitePayload = serde_json::from_slice(bytes).ok()?;
    for fp in [
        &payload.owner_fingerprint_hex,
        &payload.member_fingerprint_hex,
    ] {
        if fp.len() != 64
            || fp
                .bytes()
                .any(|b| !b.is_ascii_hexdigit() || b.is_ascii_uppercase())
        {
            return None;
        }
    }
    Some(payload)
}

/// Mint a signed invite: the owner wraps the vault `itemsKey` to the
/// member (the [`crate::person_key::PersonWrappedKey`] pieces, hex
/// concatenated in fixed order), seals the canonical payload to the
/// member under a fresh PQ-hybrid envelope, and double-signs the sealed
/// frame with the message-class prefix.
#[allow(clippy::too_many_arguments)]
pub fn create_invite(
    owner: &crate::person_key::PersonKeyPair,
    member_public: &crate::person_key::PersonPublicHalf,
    items_key: &[u8; 32],
    account_number_hash: &[u8; 16],
    vault_label: &str,
    created_at_secs: u64,
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<VaultInvite, crate::person_key::PersonKeyError> {
    let wrapped = member_public.wrap_key(items_key, account_number_hash, rng)?;
    let mut pieces =
        Vec::with_capacity(PERSON_ED25519_PK_LEN + PERSON_CT_LEN + 24 + wrapped.wrapped_key.len());
    pieces.extend_from_slice(&wrapped.ed_ephemeral_pk);
    pieces.extend_from_slice(&wrapped.ml_kem_ct);
    pieces.extend_from_slice(&wrapped.nonce);
    pieces.extend_from_slice(&wrapped.wrapped_key);
    let wrapped_hex = hex_of(&pieces);

    let payload = InvitePayload {
        owner_fingerprint_hex: hex_of(owner.fingerprint()),
        member_fingerprint_hex: hex_of(member_public.fingerprint()),
        wrapped_items_key_hex: wrapped_hex,
        vault_label: vault_label.into(),
        created_at: created_at_secs,
    };
    let payload_bytes = encode_invite_payload(&payload);
    let sealed = member_public.seal_to_member_with_aad(&payload_bytes, &aad_vault_invite(), rng)?;

    // The double signature covers the sealed frame with the message-class
    // prefix: a signature over one class can never verify as another.
    let mut signed_bytes = Vec::with_capacity(
        INVITE_PREFIX.len()
            + sealed.ml_kem_ct.len()
            + sealed.ed_ephemeral_pk.len()
            + sealed.nonce.len()
            + sealed.ciphertext.len(),
    );
    signed_bytes.extend_from_slice(INVITE_PREFIX);
    signed_bytes.extend_from_slice(&sealed.ml_kem_ct);
    signed_bytes.extend_from_slice(&sealed.ed_ephemeral_pk);
    signed_bytes.extend_from_slice(&sealed.nonce);
    signed_bytes.extend_from_slice(&sealed.ciphertext);
    let signature = owner
        .sign(&signed_bytes, rng)
        .map_err(|_| crate::person_key::PersonKeyError::Csprng)?;

    let owner_half = owner.public_half();
    Ok(VaultInvite {
        enc_payload: sealed.ciphertext,
        nonce: sealed.nonce,
        env_ml_kem_ct: sealed.ml_kem_ct,
        env_ed_ephemeral_pk: sealed.ed_ephemeral_pk,
        account_number_hash_hex: hex_of(account_number_hash),
        owner_kem_ek_hex: hex_of(owner_half.kem_ek()),
        owner_mldsa_vk_hex: hex_of(owner_half.mldsa_vk()),
        owner_ed25519_pk_hex: hex_of(owner_half.ed_pk()),
        owner_fingerprint_hex: hex_of(owner.fingerprint()),
        member_fingerprint_hex: hex_of(member_public.fingerprint()),
        signature,
    })
}

/// Open an invite as the invited member: open the sealed frame, verify
/// BOTH signature halves over the sealed bytes, check the carried owner
/// material against the claimed fingerprint, decode the payload, and
/// unwrap the per-recipient `itemsKey` as proof of receipt.
///
/// Returns the payload and the unwrapped vault `itemsKey`. Every failure
/// mode collapses to [`crate::person_key::PersonKeyError::SignatureVerify`]
/// (identity/signature path) or `AeadFailure` (envelope/wrap path): the
/// wrong member cannot distinguish tampering from a foreign invite.
pub fn accept_invite(
    member: &crate::person_key::PersonKeyPair,
    invite: &VaultInvite,
) -> Result<(InvitePayload, zeroize::Zeroizing<[u8; 32]>), crate::person_key::PersonKeyError> {
    use crate::person_key::PersonKeyError;

    let account_number_hash: [u8; 16] = unhex_16(&invite.account_number_hash_hex)?;

    // Reconstruct the owner's full three-half public material and check it
    // against the claimed fingerprint BEFORE trusting any byte of it: a
    // substituted owner key beside a mismatched claim fails here, not at
    // the signature.
    let owner_half = crate::person_key::PersonPublicHalf::from_parts_hex(
        &invite.owner_kem_ek_hex,
        &invite.owner_ed25519_pk_hex,
        &invite.owner_mldsa_vk_hex,
    )?;
    if hex_of(owner_half.fingerprint()) != invite.owner_fingerprint_hex {
        return Err(PersonKeyError::SignatureVerify);
    }

    // Open the sealed frame with the member's own keypair.
    let sealed = crate::person_key::SealedToMember {
        ml_kem_ct: invite.env_ml_kem_ct,
        ed_ephemeral_pk: invite.env_ed_ephemeral_pk,
        nonce: invite.nonce,
        ciphertext: invite.enc_payload.clone(),
    };
    let _ = &sealed;
    let plaintext = member.open_sealed_with_aad(&sealed, &aad_vault_invite())?;

    // Verify both signature halves over the sealed frame with the class
    // prefix, exactly as minted.
    let mut signed_bytes = Vec::with_capacity(
        INVITE_PREFIX.len()
            + invite.env_ml_kem_ct.len()
            + invite.env_ed_ephemeral_pk.len()
            + invite.nonce.len()
            + invite.enc_payload.len(),
    );
    signed_bytes.extend_from_slice(INVITE_PREFIX);
    signed_bytes.extend_from_slice(&invite.env_ml_kem_ct);
    signed_bytes.extend_from_slice(&invite.env_ed_ephemeral_pk);
    signed_bytes.extend_from_slice(&invite.nonce);
    signed_bytes.extend_from_slice(&invite.enc_payload);
    owner_half.verify(&signed_bytes, &invite.signature)?;

    let payload = parse_invite_payload(&plaintext).ok_or(PersonKeyError::AeadFailure)?;
    if payload.member_fingerprint_hex != hex_of(member.fingerprint()) {
        return Err(PersonKeyError::FingerprintMismatch);
    }
    if payload.owner_fingerprint_hex != invite.owner_fingerprint_hex {
        return Err(PersonKeyError::SignatureVerify);
    }

    // Proof of receipt: unwrap the per-recipient itemsKey with the
    // member's own keypair. A member holding the right hex string but the
    // wrong keypair is indistinguishable from a stranger here, by design.
    let wrapped = decode_wrapped_hex(&payload.wrapped_items_key_hex)?;
    let items_key = member.unwrap_key(&wrapped, &account_number_hash)?;
    Ok((payload, items_key))
}

fn unhex_16(s: &str) -> Result<[u8; 16], crate::person_key::PersonKeyError> {
    use crate::person_key::PersonKeyError;
    if s.len() != 32
        || s.bytes()
            .any(|b| !b.is_ascii_hexdigit() || b.is_ascii_uppercase())
    {
        return Err(PersonKeyError::FingerprintMismatch);
    }
    fn val(b: u8) -> u8 {
        match b {
            b'0'..=b'9' => b - b'0',
            b'a'..=b'f' => b - b'a' + 10,
            _ => 0,
        }
    }
    let mut out = [0u8; 16];
    for (i, pair) in s.as_bytes().chunks(2).enumerate() {
        out[i] = (val(pair[0]) << 4) | val(pair[1]);
    }
    Ok(out)
}

fn decode_wrapped_hex(
    s: &str,
) -> Result<crate::person_key::PersonWrappedKey, crate::person_key::PersonKeyError> {
    use crate::person_key::{PersonKeyError, PERSON_CT_LEN, PERSON_ED25519_PK_LEN};
    fn val(b: u8) -> u8 {
        match b {
            b'0'..=b'9' => b - b'0',
            b'a'..=b'f' => b - b'a' + 10,
            _ => 0,
        }
    }
    if !s.len().is_multiple_of(2)
        || s.bytes()
            .any(|b| !b.is_ascii_hexdigit() || b.is_ascii_uppercase())
    {
        return Err(PersonKeyError::AeadFailure);
    }
    let bytes: Vec<u8> = s
        .as_bytes()
        .chunks(2)
        .map(|pair| (val(pair[0]) << 4) | val(pair[1]))
        .collect();
    if bytes.len() < PERSON_ED25519_PK_LEN + PERSON_CT_LEN + 24 + 48 {
        return Err(PersonKeyError::AeadFailure);
    }
    let mut ed_ephemeral_pk = [0u8; PERSON_ED25519_PK_LEN];
    let mut ml_kem_ct = [0u8; PERSON_CT_LEN];
    let mut nonce = [0u8; 24];
    ed_ephemeral_pk.copy_from_slice(&bytes[..PERSON_ED25519_PK_LEN]);
    ml_kem_ct.copy_from_slice(&bytes[PERSON_ED25519_PK_LEN..PERSON_ED25519_PK_LEN + PERSON_CT_LEN]);
    nonce.copy_from_slice(
        &bytes[PERSON_ED25519_PK_LEN + PERSON_CT_LEN..PERSON_ED25519_PK_LEN + PERSON_CT_LEN + 24],
    );
    let wrapped_key = bytes[PERSON_ED25519_PK_LEN + PERSON_CT_LEN + 24..].to_vec();
    Ok(crate::person_key::PersonWrappedKey {
        ml_kem_ct,
        ed_ephemeral_pk,
        wrapped_key,
        nonce,
    })
}

fn hex_of(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::new();
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::person_key::PersonKeyPair;
    use alloc::vec;

    const ACCT: [u8; 16] = [0x44; 16];

    fn fixture_seed(label: &[u8]) -> [u8; 32] {
        use sha2::Digest as _;
        let digest = sha2::Sha256::digest(label);
        let mut out = [0u8; 32];
        out.copy_from_slice(&digest);
        out
    }

    fn fixture_kem(label: &[u8]) -> [u8; crate::person_key::PERSON_DK_SEED_LEN] {
        let mut s = [0u8; crate::person_key::PERSON_DK_SEED_LEN];
        s[..32].copy_from_slice(&fixture_seed(label));
        s[32..].copy_from_slice(&fixture_seed(label));
        s
    }

    struct SeededRng(u64);

    impl rand_core::TryRng for SeededRng {
        type Error = core::convert::Infallible;
        fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
            Ok(0)
        }
        fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
            Ok(0)
        }
        fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
            use sha2::Digest as _;
            let ctr = self.0.wrapping_add(1);
            self.0 = ctr;
            let digest = sha2::Sha256::digest(ctr.to_le_bytes());
            let n = dst.len();
            dst[..n].copy_from_slice(&digest[..n]);
            Ok(())
        }
    }

    impl rand_core::TryCryptoRng for SeededRng {}

    fn owner_pair() -> PersonKeyPair {
        PersonKeyPair::generate_raw(
            &fixture_kem(b"owner-kem-dz"),
            &fixture_seed(b"owner-ed25519"),
            &fixture_seed(b"owner-mldsa"),
        )
    }

    fn member_pair() -> PersonKeyPair {
        PersonKeyPair::generate_raw(
            &fixture_kem(b"member-kem-dz"),
            &fixture_seed(b"member-ed25519"),
            &fixture_seed(b"member-mldsa"),
        )
    }

    fn second_member_pair() -> PersonKeyPair {
        PersonKeyPair::generate_raw(
            &fixture_kem(b"second-member-kem-dz"),
            &fixture_seed(b"second-member-ed25519"),
            &fixture_seed(b"second-member-mldsa"),
        )
    }

    fn roster_member(
        pair: &PersonKeyPair,
        role: GroupRosterRole,
        state: GroupMemberState,
        wrapped_group_key_hex: Option<String>,
    ) -> GroupRosterMember {
        let public = pair.public_half();
        GroupRosterMember {
            fingerprint_hex: hex_of(pair.fingerprint()),
            person_id_hex: None,
            display_name: if role == GroupRosterRole::Owner {
                "Owner".into()
            } else {
                "Member".into()
            },
            role,
            state,
            wrapped_group_key_hex,
            member_kem_ek_hex: hex_of(public.kem_ek()),
            member_ed_pk_hex: hex_of(public.ed_pk()),
            member_mldsa_vk_hex: hex_of(public.mldsa_vk()),
            previous_fingerprint_hex: None,
            continuity: GroupKeyContinuity::Current,
            transition_hex: None,
        }
    }

    fn device_pair(seed: u8) -> crate::device_key::DeviceKeyPair {
        crate::device_key::DeviceKeyPair::generate_raw(&[seed; 32], &[seed ^ 0x3c; 32])
    }

    /// A person-signed `v2` binding row for `device`, exactly what an invite package
    /// carries as its attestation.
    fn attestation(
        owner: &PersonKeyPair,
        device: &crate::device_key::DeviceKeyPair,
        device_id: [u8; 16],
    ) -> OwnerDeviceAttestation {
        let entry = crate::device_binding_blob::sign_device_binding_v2(
            owner,
            &device_id,
            owner.fingerprint(),
            1,
            false,
            &device.public_half(),
            &mut SeededRng(77),
        )
        .expect("sign binding row");
        OwnerDeviceAttestation {
            device_id_hex: hex_of(&device_id),
            entry,
        }
    }

    /// Vector generator for the `group-roster` companion category: the two signature
    /// CLASSES over one payload, the verification verdicts that separate them, and the
    /// package payload that carries (or omits) the owner device attestation.
    /// `#[ignore]`-gated; prints JSON to stdout.
    ///
    /// `cargo test -p protocol --lib emit_group_roster_vectors_for_paste -- --ignored --nocapture`
    #[test]
    #[ignore = "vector generator, prints JSON on demand"]
    fn emit_group_roster_vectors_for_paste() {
        extern crate std;
        use crate::test_vector_fmt::json_escape;
        use alloc::format;
        use alloc::string::String;
        use alloc::string::ToString as _;

        let owner = owner_pair();
        let member = member_pair();
        let device = device_pair(0x91);
        let device_id = [0x0d; 16];
        let group_key = fixture_seed(b"group-roster-vector-key");
        let attestation = attestation(&owner, &device, device_id);
        let epoch = 3u64;
        // A LIVE member row must carry a wrap in the CANONICAL payload, so the vector
        // roster carries a well-shaped one rather than an empty string.
        let wrapped = hex_of(&vec![0x5au8; WRAPPED_32_BYTE_KEY_LEN]);
        let roster = GroupRosterPayload {
            account_number_hash_hex: hex_of(&ACCT),
            group_key_epoch: epoch,
            owner_fingerprint_hex: hex_of(owner.fingerprint()),
            members: vec![
                roster_member(&owner, GroupRosterRole::Owner, GroupMemberState::Live, None),
                roster_member(
                    &member,
                    GroupRosterRole::Member,
                    GroupMemberState::Live,
                    Some(wrapped),
                ),
            ],
        };
        let person_signed =
            sign_group_roster(&owner, &roster, &mut SeededRng(31)).expect("person roster");
        let device_signed = sign_group_roster_with_device(&device, &roster, &mut SeededRng(32))
            .expect("device roster");
        let payload = person_signed.payload.clone();
        assert_eq!(payload, device_signed.payload, "one payload, two classes");
        let class_bytes = |prefix: &[u8]| -> String {
            let mut message = Vec::new();
            message.extend_from_slice(prefix);
            message.extend_from_slice(&payload);
            hex_of(&message)
        };

        let mut dump = String::new();
        dump.push_str("{\n  \"schema\": \"group-roster\",\n  \"protocol_version\": \"v0.2\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md \\u00a79.3.3\",\n");
        dump.push_str(&format!(
            "  \"description\": \"{}\",\n",
            json_escape(
                "Pins the owner-signed group roster's TWO signature classes (decisions/protocol/0731 stage 2 + 0733). The frame and the canonical payload are identical in both: what moves is the key that vouches for the roster, from the owner's person key under \"myne.group-roster v1|\" to one of the owner's devices under \"myne.group-roster v2|\". A reader MUST accept both and MUST resolve the device from an attestation it trusts (the owner_device field carried inside a person-signed group package), from its own device key, or from a verified vault.device-bindings row. The cases pin the exact signed message of each class, the verdicts that separate them, and the package payload that carries or omits the attestation. Generated by `cargo test -p protocol --lib emit_group_roster_vectors_for_paste -- --ignored --nocapture` (protocol/src/person_invite.rs)."
            )
        ));
        dump.push_str(&format!(
            "  \"informational_owner\": {{\"kem_ek_hex\": \"{}\", \"ed_pk_hex\": \"{}\", \"mldsa_vk_hex\": \"{}\"}},\n",
            hex_of(owner.public_half().kem_ek()),
            hex_of(owner.public_half().ed_pk()),
            hex_of(owner.public_half().mldsa_vk()),
        ));
        dump.push_str("\n  \"cases\": [\n");

        let mut n = 0usize;
        let total = 8usize;
        let mut case =
            |dump: &mut String, slug: &str, kind: &str, description: &str, body: &str| {
                n += 1;
                dump.push_str("    {\n");
                dump.push_str(&format!(
                    "      \"vector_id\": \"group-roster/v0.2/{slug}\",\n"
                ));
                dump.push_str(&format!(
                    "      \"description\": \"{}\",\n",
                    json_escape(description)
                ));
                dump.push_str(&format!("      \"case_kind\": \"{kind}\",\n"));
                dump.push_str(body);
                dump.push_str(if n < total { "    },\n" } else { "    }\n" });
            };

        case(
            &mut dump,
            "signed-bytes-v1-person-class",
            "signed_bytes",
            "The exact bytes a PERSON-signed roster's hybrid signature covers: the class prefix, then the canonical payload. Pinned rather than described so a port reproduces the message without guessing where the prefix ends.",
            &format!(
                "      \"input_class\": \"v1\",\n      \"input_payload_hex\": \"{}\",\n      \"expected_signed_bytes_hex\": \"{}\"\n",
                hex_of(&payload),
                class_bytes(GROUP_ROSTER_PREFIX)
            ),
        );
        case(
            &mut dump,
            "signed-bytes-v2-device-class",
            "signed_bytes",
            "The same payload under the DEVICE class. The two messages differ by their prefix and by nothing else, which is why a person signature can never satisfy a device verifier: the class is inside the bytes.",
            &format!(
                "      \"input_class\": \"v2\",\n      \"input_payload_hex\": \"{}\",\n      \"expected_signed_bytes_hex\": \"{}\"\n",
                hex_of(&payload),
                class_bytes(GROUP_ROSTER_PREFIX_V2)
            ),
        );

        // Four verdicts, and each turns on a DIFFERENT fact: the class decides which
        // key may verify, and the trust list decides whether that key is known.
        let other_device = crate::device_key::DeviceKeyPair::generate_raw(&[0x92; 32], &[0x93; 32]);
        let device_hex = hex_of(device.public_half().ed_pk());
        let device_vk_hex = hex_of(device.public_half().mldsa_vk());
        let other_hex = hex_of(other_device.public_half().ed_pk());
        let other_vk_hex = hex_of(other_device.public_half().mldsa_vk());
        for (slug, description, frame, device_field, expected) in [
            (
                "verify-v1-with-person-key",
                "The pre-stage-2 case every existing vault is in: a person-signed roster verified against the owner's public half. A device in the trust list would change nothing here, which is why the class is read from the frame rather than assumed from the list.",
                &person_signed,
                None,
                true,
            ),
            (
                "verify-v2-with-the-vouched-device",
                "The stage-2 case: a device-signed roster verified against the device the reader trusted, which it got from the attestation inside the invite package.",
                &device_signed,
                Some((device_hex.as_str(), device_vk_hex.as_str())),
                true,
            ),
            (
                "verify-v2-without-trusting-the-device",
                "A device-signed roster offered to a reader with no attestation. Refused: a roster carries no key of its own, so a device is only ever trusted because something else vouched for it.",
                &device_signed,
                None,
                false,
            ),
            (
                "verify-v2-with-another-device",
                "The substitution refusal: a device-signed roster offered with a DIFFERENT device in the trust list. The list is a set of specific keys, not a flag, so this is refused.",
                &device_signed,
                Some((other_hex.as_str(), other_vk_hex.as_str())),
                false,
            ),
        ] {
            let half = device_field.map(|(ed, vk)| {
                crate::device_key::DevicePublicHalf::from_parts_hex(ed, vk).expect("halves")
            });
            let devices: Vec<crate::device_key::DevicePublicHalf> = half.into_iter().collect();
            let got = verify_group_roster(
                RosterTrust {
                    owner_person: &owner.public_half(),
                    owner_devices: &devices,
                },
                frame,
                &ACCT,
            )
            .is_ok();
            assert_eq!(got, expected, "[{slug}] the case must match the codec");
            let body = format!(
                "      \"input_frame_hex\": \"{}\",\n      \"input_account_number_hash_hex\": \"{}\",\n      \"input_device_ed_pk_hex\": {},\n      \"input_device_mldsa_vk_hex\": {},\n      \"expected_verified\": {}\n",
                hex_of(&encode_signed_group_frame(&frame.payload, &frame.signature).expect("frame")),
                hex_of(&ACCT),
                device_field
                    .map(|(ed, _)| format!("\"{ed}\""))
                    .unwrap_or_else(|| "null".to_string()),
                device_field
                    .map(|(_, vk)| format!("\"{vk}\""))
                    .unwrap_or_else(|| "null".to_string()),
                expected,
            );
            case(&mut dump, slug, "verify", description, &body);
        }

        // The package payload, with and without the attestation.
        let with = create_group_package_with_attestation(
            &owner,
            &member.public_half(),
            &group_key,
            &ACCT,
            epoch,
            Some(&attestation),
            &mut SeededRng(33),
        )
        .expect("package with attestation");
        let without = create_group_package(
            &owner,
            &member.public_half(),
            &group_key,
            &ACCT,
            epoch,
            &mut SeededRng(34),
        )
        .expect("package without attestation");
        let with_payload = verify_group_package(&owner.public_half(), &with).expect("verify");
        let without_payload = verify_group_package(&owner.public_half(), &without).expect("verify");
        assert!(with_payload.owner_device.is_some());
        assert!(without_payload.owner_device.is_none());
        case(
            &mut dump,
            "package-payload-with-owner-device-attestation",
            "package_payload",
            "One recipient's canonical group-key package payload carrying the owner's device attestation: the device id and the owner's PERSON-SIGNED binding row, inside the payload the person key signs. A recipient verifies the row's own signature against the owner half it pinned out of band, which is what makes the device half usable without trusting the package's word for it.",
            &format!(
                "      \"input_payload_hex\": \"{}\",\n      \"expected_person_fingerprint_hex\": \"{}\",\n      \"expected_device_id_hex\": \"{}\",\n      \"expected_device_ed_pk_hex\": \"{}\"\n",
                hex_of(&with.payload),
                hex_of(owner.fingerprint()),
                hex_of(&device_id),
                device_hex
            ),
        );
        case(
            &mut dump,
            "package-payload-without-attestation",
            "package_payload",
            "The same package from a build with no device key: the field is ABSENT from the canonical payload rather than null, so the bytes are exactly what the previous release produced and an older reader verifies it unchanged. This is the case that makes the field additive rather than a format break.",
            &format!(
                "      \"input_payload_hex\": \"{}\",\n      \"expected_person_fingerprint_hex\": \"{}\",\n      \"expects_no_field\": \"owner_device\"\n",
                hex_of(&without.payload),
                hex_of(owner.fingerprint())
            ),
        );

        dump.push_str("  ]\n}\n");
        std::println!("{dump}");
    }

    #[test]
    fn a_device_signed_roster_verifies_only_when_the_device_is_vouched_for() {
        let owner = owner_pair();
        let device = device_pair(0x61);
        let roster = GroupRosterPayload {
            account_number_hash_hex: hex_of(&ACCT),
            group_key_epoch: 1,
            owner_fingerprint_hex: hex_of(owner.fingerprint()),
            members: vec![roster_member(
                &owner,
                GroupRosterRole::Owner,
                GroupMemberState::Live,
                None,
            )],
        };
        let signed =
            sign_group_roster_with_device(&device, &roster, &mut SeededRng(1)).expect("sign");

        // With the device vouched for: accepted, and the payload is the same semantic
        // roster a person-signed one carries.
        let devices = [device.public_half()];
        assert_eq!(
            verify_group_roster(
                RosterTrust {
                    owner_person: &owner.public_half(),
                    owner_devices: &devices,
                },
                &signed,
                &ACCT
            )
            .expect("device-signed roster verifies"),
            roster
        );

        // Person-only trust refuses it: a device signature is not a person signature,
        // and a reader with no reason to trust the device must not accept one.
        assert!(verify_group_roster(
            RosterTrust::person_only(&owner.public_half()),
            &signed,
            &ACCT
        )
        .is_err());

        // A DIFFERENT device in the trust list does not verify it either, so the list is
        // a set of specific keys and not a flag.
        let other = [device_pair(0x62).public_half()];
        assert!(verify_group_roster(
            RosterTrust {
                owner_person: &owner.public_half(),
                owner_devices: &other,
            },
            &signed,
            &ACCT
        )
        .is_err());

        // And a device-signed roster is still bound to its vault and to its owner.
        let mut other_acct = ACCT;
        other_acct[0] ^= 1;
        assert!(verify_group_roster(
            RosterTrust {
                owner_person: &owner.public_half(),
                owner_devices: &devices,
            },
            &signed,
            &other_acct
        )
        .is_err());
    }

    #[test]
    fn a_package_carries_the_owner_device_attestation_and_refuses_a_forged_one() {
        let owner = owner_pair();
        let member = member_pair();
        let stranger = second_member_pair();
        let device = device_pair(0x71);
        let device_id = [0x0b; 16];
        let group_key = fixture_seed(b"group-key-epoch-2");
        let good = attestation(&owner, &device, device_id);

        // The attestation travels inside the person-signed package.
        let package = create_group_package_with_attestation(
            &owner,
            &member.public_half(),
            &group_key,
            &ACCT,
            2,
            Some(&good),
            &mut SeededRng(2),
        )
        .expect("package with attestation");
        let payload = verify_group_package(&owner.public_half(), &package).expect("verify package");
        let carried = payload.owner_device.expect("the attestation travelled");
        assert_eq!(carried, good);
        // The recipient can resolve the device half out of it after checking the person
        // signature over the row itself.
        assert!(carried.verifies_against(&owner.public_half()));
        assert_eq!(carried.device_public_half(), Some(device.public_half()));

        // A package that does NOT carry one encodes exactly as before: the field is
        // omitted, which is what keeps a pre-stage-2 package byte-identical.
        let plain = create_group_package(
            &owner,
            &member.public_half(),
            &group_key,
            &ACCT,
            2,
            &mut SeededRng(3),
        )
        .expect("plain package");
        let plain_payload =
            verify_group_package(&owner.public_half(), &plain).expect("verify plain package");
        assert!(plain_payload.owner_device.is_none());
        assert!(
            !core::str::from_utf8(&plain.payload)
                .expect("utf8")
                .contains("owner_device"),
            "an absent attestation must be omitted from the canonical payload"
        );

        // A row signed by SOMEBODY ELSE is refused at creation: shipping it would make
        // every recipient fail to resolve the roster, one round trip later.
        let forged = attestation(&stranger, &device, device_id);
        assert!(create_group_package_with_attestation(
            &owner,
            &member.public_half(),
            &group_key,
            &ACCT,
            2,
            Some(&forged),
            &mut SeededRng(4),
        )
        .is_err());
    }

    #[test]
    fn a_rotation_signed_by_a_device_refuses_to_leave_its_packages_unattested() {
        let owner = owner_pair();
        let member = member_pair();
        let device = device_pair(0x81);
        let device_id = [0x0c; 16];
        let good = attestation(&owner, &device, device_id);
        let roster = GroupRosterPayload {
            account_number_hash_hex: hex_of(&ACCT),
            group_key_epoch: 5,
            owner_fingerprint_hex: hex_of(owner.fingerprint()),
            members: vec![
                roster_member(&owner, GroupRosterRole::Owner, GroupMemberState::Live, None),
                roster_member(
                    &member,
                    GroupRosterRole::Member,
                    GroupMemberState::Live,
                    None,
                ),
            ],
        };
        let new_group_key = fixture_seed(b"group-key-epoch-6");
        let items_key_id = [0x09; 16];

        // Device signature AND attestation: the rotated roster verifies against the
        // attested device, and each remaining member's package carries the attestation.
        let rotated = rotate_group_roster_signed_by(
            &owner,
            Some(&device),
            Some(&good),
            &roster,
            &hex_of(member.fingerprint()),
            &new_group_key,
            &ACCT,
            &items_key_id,
            &mut SeededRng(5),
        )
        .expect("rotate");
        let devices = [device.public_half()];
        verify_group_roster(
            RosterTrust {
                owner_person: &owner.public_half(),
                owner_devices: &devices,
            },
            &rotated.signed_roster,
            &ACCT,
        )
        .expect("rotated roster verifies against the device");
        // Only the owner remains, so there are no packages to check in this roster; the
        // pairing rule is what the two calls below pin.
        assert!(rotate_group_roster_signed_by(
            &owner,
            Some(&device),
            None,
            &roster,
            &hex_of(member.fingerprint()),
            &new_group_key,
            &ACCT,
            &items_key_id,
            &mut SeededRng(6),
        )
        .is_err());
        assert!(rotate_group_roster_signed_by(
            &owner,
            None,
            Some(&good),
            &roster,
            &hex_of(member.fingerprint()),
            &new_group_key,
            &ACCT,
            &items_key_id,
            &mut SeededRng(7),
        )
        .is_err());
    }

    #[test]
    fn group_package_opens_only_for_the_recipient_and_exact_epoch() {
        let owner = owner_pair();
        let member = member_pair();
        let stranger = second_member_pair();
        let group_key = fixture_seed(b"group-key-epoch-7");
        let package = create_group_package(
            &owner,
            &member.public_half(),
            &group_key,
            &ACCT,
            7,
            &mut SeededRng(10),
        )
        .expect("package");

        let opened = open_group_package(&owner.public_half(), &member, &package, &ACCT, 7)
            .expect("recipient opens");
        assert_eq!(*opened, group_key);
        assert!(open_group_package(&owner.public_half(), &member, &package, &ACCT, 8).is_err());
        assert!(open_group_package(&owner.public_half(), &stranger, &package, &ACCT, 7).is_err());

        let bytes = encode_signed_group_package(&package).expect("encode package");
        assert_eq!(decode_signed_group_package(&bytes), Some(package));
    }

    #[test]
    fn owner_signed_roster_verifies_without_a_root_or_membership_key() {
        let owner = owner_pair();
        let member = member_pair();
        let group_key = fixture_seed(b"group-key-epoch-1");
        let package = create_group_package(
            &owner,
            &member.public_half(),
            &group_key,
            &ACCT,
            1,
            &mut SeededRng(20),
        )
        .expect("package");
        let package_payload = verify_group_package(&owner.public_half(), &package).expect("verify");
        let roster = GroupRosterPayload {
            account_number_hash_hex: hex_of(&ACCT),
            group_key_epoch: 1,
            owner_fingerprint_hex: hex_of(owner.fingerprint()),
            members: alloc::vec![
                roster_member(
                    &member,
                    GroupRosterRole::Member,
                    GroupMemberState::Live,
                    Some(package_payload.wrapped_group_key_hex.clone()),
                ),
                roster_member(&owner, GroupRosterRole::Owner, GroupMemberState::Live, None,),
            ],
        };
        let signed = sign_group_roster(&owner, &roster, &mut SeededRng(30)).expect("sign");
        let bytes = encode_signed_group_roster(&signed).expect("frame");
        let decoded = decode_signed_group_roster(&bytes).expect("decode frame");
        let verified = verify_group_roster(
            RosterTrust::person_only(&owner.public_half()),
            &decoded,
            &ACCT,
        )
        .expect("verify roster");

        assert_eq!(verified.group_key_epoch, 1);
        assert!(package_matches_roster(&verified, &package_payload));
        assert!(owner
            .public_half()
            .verify(
                &class_message(GROUP_PACKAGE_PREFIX, &decoded.payload),
                &decoded.signature,
            )
            .is_err());

        let mut tampered = decoded.clone();
        tampered.signature.ed25519_sig[0] ^= 1;
        assert!(verify_group_roster(
            RosterTrust::person_only(&owner.public_half()),
            &tampered,
            &ACCT
        )
        .is_err());
    }

    #[test]
    fn roster_continuity_requires_a_previous_fingerprint_for_change_states() {
        let owner = owner_pair();
        let member = member_pair();
        let mut member_row = roster_member(
            &member,
            GroupRosterRole::Member,
            GroupMemberState::Tombstone,
            None,
        );
        member_row.previous_fingerprint_hex = Some("11".repeat(32));
        member_row.continuity = GroupKeyContinuity::Changed;
        let roster = GroupRosterPayload {
            account_number_hash_hex: hex_of(&ACCT),
            group_key_epoch: 2,
            owner_fingerprint_hex: hex_of(owner.fingerprint()),
            members: alloc::vec![
                roster_member(&owner, GroupRosterRole::Owner, GroupMemberState::Live, None,),
                member_row.clone(),
            ],
        };
        assert!(encode_group_roster(&roster).is_some());

        member_row.previous_fingerprint_hex = None;
        let invalid = GroupRosterPayload {
            members: alloc::vec![
                roster_member(&owner, GroupRosterRole::Owner, GroupMemberState::Live, None,),
                member_row,
            ],
            ..roster
        };
        assert!(encode_group_roster(&invalid).is_none());
    }

    #[test]
    fn removal_and_equal_epoch_package_mismatch_fail_closed() {
        let owner = owner_pair();
        let removed = member_pair();
        let remaining = second_member_pair();
        let old_key = fixture_seed(b"group-key-old");
        let new_key = fixture_seed(b"group-key-new");
        let old_package = create_group_package(
            &owner,
            &removed.public_half(),
            &old_key,
            &ACCT,
            1,
            &mut SeededRng(40),
        )
        .expect("old package");
        let replacement = create_group_package(
            &owner,
            &remaining.public_half(),
            &new_key,
            &ACCT,
            2,
            &mut SeededRng(50),
        )
        .expect("replacement");
        assert!(
            open_group_package(&owner.public_half(), &removed, &old_package, &ACCT, 2).is_err()
        );
        assert!(
            open_group_package(&owner.public_half(), &removed, &replacement, &ACCT, 2).is_err()
        );

        let replacement_payload =
            verify_group_package(&owner.public_half(), &replacement).expect("verify replacement");
        let mut mismatched = replacement_payload.clone();
        mismatched.wrapped_group_key_hex.replace_range(..2, "00");
        let roster = GroupRosterPayload {
            account_number_hash_hex: hex_of(&ACCT),
            group_key_epoch: 2,
            owner_fingerprint_hex: hex_of(owner.fingerprint()),
            members: alloc::vec![
                roster_member(&owner, GroupRosterRole::Owner, GroupMemberState::Live, None,),
                roster_member(
                    &removed,
                    GroupRosterRole::Member,
                    GroupMemberState::Tombstone,
                    None,
                ),
                roster_member(
                    &remaining,
                    GroupRosterRole::Member,
                    GroupMemberState::Live,
                    Some(replacement_payload.wrapped_group_key_hex.clone()),
                ),
            ],
        };
        assert!(package_matches_roster(&roster, &replacement_payload));
        assert!(!package_matches_roster(&roster, &mismatched));
    }

    #[test]
    fn create_then_accept_recovers_payload_and_items_key() {
        let owner = owner_pair();
        let member = member_pair();
        let items_key: [u8; 32] = fixture_seed(b"vault-items-key");
        let invite = create_invite(
            &owner,
            &member.public_half(),
            &items_key,
            &ACCT,
            "Team Vault",
            1_760_000_000,
            &mut SeededRng(0),
        )
        .expect("create succeeds");
        let (payload, opened) = accept_invite(&member, &invite).expect("accept succeeds");
        assert_eq!(*opened, items_key);
        assert_eq!(payload.vault_label, "Team Vault");
        assert_eq!(payload.member_fingerprint_hex, hex_of(member.fingerprint()));
        assert_eq!(payload.owner_fingerprint_hex, hex_of(owner.fingerprint()));
    }

    #[test]
    fn invite_wire_round_trips_and_still_accepts() {
        // The relay form (`vault_invite_to_wire`) is what the invitee will
        // receive; parsing it back must give a frame the member can still open,
        // so the wire codec cannot drop or reorder a byte the accept path needs.
        let owner = owner_pair();
        let member = member_pair();
        let items_key: [u8; 32] = fixture_seed(b"vault-items-key");
        let invite = create_invite(
            &owner,
            &member.public_half(),
            &items_key,
            &ACCT,
            "Team Vault",
            1_760_000_000,
            &mut SeededRng(0),
        )
        .expect("create succeeds");
        let wire = vault_invite_to_wire(&invite);
        let parsed = vault_invite_from_wire(&wire).expect("wire parses");
        assert_eq!(parsed, invite, "wire round-trip is byte-exact");
        let (_payload, opened) = accept_invite(&member, &parsed).expect("accept after wire");
        assert_eq!(*opened, items_key);
        // Rejections: uppercase hex and a missing field both fail closed.
        let mut value: serde_json::Value = serde_json::from_str(&wire).unwrap();
        value["nonce_hex"] = serde_json::Value::String("AB".repeat(24));
        assert!(vault_invite_from_wire(&alloc::format!("{value}")).is_none());
        assert!(vault_invite_from_wire("{not json").is_none());
    }

    #[test]
    fn accept_rejects_a_replayed_class_prefix() {
        // A signature minted for the invite class must not verify if the
        // verifier expects a different class: flip one prefix byte in the
        // signed bytes by tampering the sealed frame instead, which must
        // fail the signature (bind-then-sign covers the frame).
        let owner = owner_pair();
        let member = member_pair();
        let items_key: [u8; 32] = fixture_seed(b"vault-items-key");
        let mut invite = create_invite(
            &owner,
            &member.public_half(),
            &items_key,
            &ACCT,
            "Team Vault",
            1_760_000_000,
            &mut SeededRng(0),
        )
        .expect("create succeeds");
        invite.enc_payload[0] ^= 0x01;
        assert!(accept_invite(&member, &invite).is_err());
    }

    #[test]
    fn invite_payload_round_trips() {
        let payload = InvitePayload {
            owner_fingerprint_hex: "ab".repeat(32),
            member_fingerprint_hex: "cd".repeat(32),
            wrapped_items_key_hex: "ef".repeat(64),
            vault_label: "Team Vault".into(),
            created_at: 1_760_000_000,
        };
        let bytes = encode_invite_payload(&payload);
        let parsed = parse_invite_payload(&bytes).expect("canonical bytes parse");
        assert_eq!(encode_invite_payload(&parsed), bytes);
    }

    // ── Group retirement + local rotation (myne-md/myne#712 task 7) ──────────

    /// A roster with the owner plus two live members, each already wrapped at
    /// `epoch`, ready to be rotated.
    fn two_member_roster(owner: &PersonKeyPair, epoch: u64) -> GroupRosterPayload {
        let group_key = fixture_seed(b"roster-group-key");
        let mut rows = alloc::vec![roster_member(
            owner,
            GroupRosterRole::Owner,
            GroupMemberState::Live,
            None,
        )];
        for (pair, seed) in [(member_pair(), 61u64), (second_member_pair(), 62u64)] {
            let member = pair;
            let package = create_group_package(
                owner,
                &member.public_half(),
                &group_key,
                &ACCT,
                epoch,
                &mut SeededRng(seed),
            )
            .expect("package");
            let payload = verify_group_package(&owner.public_half(), &package).expect("verify");
            rows.push(roster_member(
                &member,
                GroupRosterRole::Member,
                GroupMemberState::Live,
                Some(payload.wrapped_group_key_hex),
            ));
        }
        GroupRosterPayload {
            account_number_hash_hex: hex_of(&ACCT),
            group_key_epoch: epoch,
            owner_fingerprint_hex: hex_of(owner.fingerprint()),
            members: rows,
        }
    }

    #[test]
    fn retirement_record_round_trips_and_rejects_bad_epochs() {
        let payload = GroupRetirementPayload {
            retired_epoch: 4,
            replacement_epoch: 5,
            namespace_kind: RetiredNamespaceKind::GroupKey,
            namespace_id: ACCT,
        };
        let bytes = encode_group_retirement(&payload).expect("encode");
        assert_eq!(bytes.len(), GROUP_RETIREMENT_PAYLOAD_LEN);
        assert_eq!(parse_group_retirement(&bytes), Some(payload));

        // A skip or a repeat is not a canonical successor.
        let mut skipped = payload;
        skipped.replacement_epoch = 6;
        assert!(encode_group_retirement(&skipped).is_none());
        let mut repeated = payload;
        repeated.replacement_epoch = 4;
        assert!(encode_group_retirement(&repeated).is_none());
        let mut zero = payload;
        zero.retired_epoch = 0;
        zero.replacement_epoch = 1;
        assert!(encode_group_retirement(&zero).is_none());

        // Trailing bytes are rejected (§10.3.1 strict-trailing).
        let mut long = bytes;
        long.push(0);
        assert!(parse_group_retirement(&long).is_none());
    }

    #[test]
    fn retirement_record_is_owner_signed_and_cannot_be_forged() {
        let owner = owner_pair();
        let attacker = second_member_pair();
        let payload = GroupRetirementPayload {
            retired_epoch: 1,
            replacement_epoch: 2,
            namespace_kind: RetiredNamespaceKind::ItemsKey,
            namespace_id: [0x11; 16],
        };
        let signed = sign_group_retirement(&owner, &payload, &mut SeededRng(70)).expect("sign");
        let verified =
            verify_group_retirement(&owner.public_half(), &signed, &[0u8; 16], &[0x11; 16])
                .expect("verify");
        assert_eq!(verified, payload);

        // A retirement naming another vault's items_key_id is refused: the record
        // is bound to the verifying vault (Grill 3 review D4).
        assert!(
            verify_group_retirement(&owner.public_half(), &signed, &[0u8; 16], &[0x99; 16])
                .is_err()
        );

        let bytes = encode_signed_group_retirement(&signed).expect("frame");
        let decoded = decode_signed_group_retirement(&bytes).expect("decode");
        assert_eq!(
            verify_group_retirement(&owner.public_half(), &decoded, &[0u8; 16], &[0x11; 16]),
            Ok(payload)
        );

        // A different signer's envelope does not verify under the pinned owner.
        let forged = sign_group_retirement(&attacker, &payload, &mut SeededRng(71)).expect("sign");
        assert!(
            verify_group_retirement(&owner.public_half(), &forged, &[0u8; 16], &[0x11; 16])
                .is_err()
        );
        // A cross-class replay fails: the roster class prefix differs.
        assert!(owner
            .public_half()
            .verify(
                &class_message(GROUP_ROSTER_PREFIX, &signed.payload),
                &signed.signature,
            )
            .is_err());
        // Tampering the epoch pair breaks the signature.
        let mut tampered = decoded;
        tampered.payload[0] ^= 1;
        assert!(
            verify_group_retirement(&owner.public_half(), &tampered, &[0u8; 16], &[0x11; 16])
                .is_err()
        );
    }

    #[test]
    fn person_key_transition_round_trips_and_rejects_tamper() {
        use crate::person_key::PersonKeyPair;
        let old = PersonKeyPair::generate_raw(&[1u8; 64], &[2u8; 32], &[3u8; 32]);
        let new = PersonKeyPair::generate_raw(&[4u8; 64], &[5u8; 32], &[6u8; 32]);
        let old_public = old.public_half();
        let payload = PersonKeyTransitionPayload {
            old_kem_ek: *old_public.kem_ek(),
            old_ed_pk: *old_public.ed_pk(),
            old_mldsa_vk: *old_public.mldsa_vk(),
            new_fingerprint: *new.fingerprint(),
        };
        let signed = sign_person_key_transition(&old, &payload, &mut SeededRng(80)).expect("sign");
        assert_eq!(
            verify_person_key_transition(&signed),
            Ok((*old.fingerprint(), *new.fingerprint()))
        );

        let bytes = encode_signed_person_key_transition(&signed).expect("frame");
        let decoded = decode_signed_person_key_transition(&bytes).expect("decode");
        assert_eq!(
            verify_person_key_transition(&decoded),
            Ok((*old.fingerprint(), *new.fingerprint()))
        );

        // A record signed by a key other than the superseded one does not verify.
        let forged = sign_person_key_transition(&new, &payload, &mut SeededRng(81)).expect("sign");
        assert!(verify_person_key_transition(&forged).is_err());

        // Either signature half alone is insufficient.
        let mut one_half = signed.clone();
        one_half.signature.ed25519_sig = [0u8; crate::person_key::PERSON_ED25519_SIG_LEN];
        assert!(verify_person_key_transition(&one_half).is_err());
        let mut other_half = signed.clone();
        other_half.signature.mldsa_sig = alloc::vec![0u8; other_half.signature.mldsa_sig.len()];
        assert!(verify_person_key_transition(&other_half).is_err());

        // A cross-class replay: the same signature under another class prefix
        // does not verify.
        assert!(old_public
            .verify(
                &class_message(GROUP_ROSTER_PREFIX, &signed.payload),
                &signed.signature,
            )
            .is_err());

        // Tampering the replacement fingerprint breaks the signature.
        let mut tampered = decoded;
        let mut parsed = parse_person_key_transition(&tampered.payload).expect("parse");
        parsed.new_fingerprint = [0xFF; 32];
        tampered.payload = encode_person_key_transition(&parsed);
        assert!(verify_person_key_transition(&tampered).is_err());

        // Strict trailing: an extra byte is a rejection.
        let mut long = bytes;
        long.push(0);
        assert!(decode_signed_person_key_transition(&long).is_none());
    }

    #[test]
    fn only_a_strictly_newer_epoch_supersedes() {
        assert_eq!(accept_newer_epoch(3, 4), Some(4));
        assert_eq!(accept_newer_epoch(3, 3), None, "equal epoch is refused");
        assert_eq!(accept_newer_epoch(4, 3), None, "a rollback is refused");
    }

    #[test]
    fn rotation_tombstones_the_removed_member_and_repackages_the_rest() {
        let owner = owner_pair();
        let removed = member_pair();
        let remaining = second_member_pair();
        let current = two_member_roster(&owner, 5);
        let new_group_key = fixture_seed(b"rotated-group-key-6");

        let rotated = rotate_group_roster(
            &owner,
            &current,
            &hex_of(removed.fingerprint()),
            &new_group_key,
            &ACCT,
            &[0x22; 16],
            &mut SeededRng(80),
        )
        .expect("rotate");

        assert_eq!(rotated.new_epoch, 6);
        // One package, for the REMAINING member only.
        assert_eq!(rotated.packages.len(), 1);

        let verified = verify_group_roster(
            RosterTrust::person_only(&owner.public_half()),
            &rotated.signed_roster,
            &ACCT,
        )
        .expect("roster");
        assert_eq!(verified.group_key_epoch, 6);
        let removed_row = verified
            .members
            .iter()
            .find(|m| m.fingerprint_hex == hex_of(removed.fingerprint()))
            .expect("tombstone row present");
        assert_eq!(removed_row.state, GroupMemberState::Tombstone);
        assert!(removed_row.wrapped_group_key_hex.is_none());
        let remaining_row = verified
            .members
            .iter()
            .find(|m| m.fingerprint_hex == hex_of(remaining.fingerprint()))
            .expect("remaining row present");
        assert_eq!(remaining_row.state, GroupMemberState::Live);
        assert!(remaining_row.wrapped_group_key_hex.is_some());

        // The remaining member opens the NEW group key from the fresh package;
        // the removed member's old wrap is gone from the roster and its
        // fingerprint appears in no package.
        let package = &rotated.packages[0];
        let opened = open_group_package(&owner.public_half(), &remaining, package, &ACCT, 6)
            .expect("remaining member opens");
        assert_eq!(*opened, new_group_key);
        let payload = verify_group_package(&owner.public_half(), package).expect("verify");
        assert_eq!(
            payload.recipient_fingerprint_hex,
            hex_of(remaining.fingerprint())
        );

        // Two retirement records, both `retired → retired + 1`, both verified.
        assert_eq!(rotated.retirements.len(), 2);
        for record in &rotated.retirements {
            let payload = verify_group_retirement(&owner.public_half(), record, &ACCT, &[0x22; 16])
                .expect("retirement verifies");
            assert_eq!(payload.retired_epoch, 5);
            assert_eq!(payload.replacement_epoch, 6);
        }
    }

    #[test]
    fn rotation_refuses_a_non_member_and_the_owner() {
        let owner = owner_pair();
        let current = two_member_roster(&owner, 1);
        let group_key = fixture_seed(b"g");
        // The owner cannot be removed by a rotation.
        assert!(rotate_group_roster(
            &owner,
            &current,
            &hex_of(owner.fingerprint()),
            &group_key,
            &ACCT,
            &[0x22; 16],
            &mut SeededRng(90),
        )
        .is_err());
        // A fingerprint that is not a live member is refused.
        assert!(rotate_group_roster(
            &owner,
            &current,
            &"ab".repeat(32),
            &group_key,
            &ACCT,
            &[0x22; 16],
            &mut SeededRng(91),
        )
        .is_err());
    }

    #[test]
    fn hex_of_lowercases_and_pads() {
        assert_eq!(hex_of(&[0x0a, 0xff]), "0aff");
    }

    #[test]
    fn parser_rejects_uppercase_and_wrong_length_fingerprints() {
        let mut payload = InvitePayload {
            owner_fingerprint_hex: "AB".repeat(32),
            member_fingerprint_hex: "cd".repeat(32),
            wrapped_items_key_hex: "ef".repeat(64),
            vault_label: "V".into(),
            created_at: 0,
        };
        let bytes = encode_invite_payload(&payload);
        assert!(parse_invite_payload(&bytes).is_none());
        payload.owner_fingerprint_hex = "ab".repeat(31);
        let bytes2 = encode_invite_payload(&payload);
        assert!(parse_invite_payload(&bytes2).is_none());
    }
    #[test]
    fn roster_member_person_id_is_optional_and_validated() {
        let owner = owner_pair();
        let member = member_pair();
        let wrapped = "a".repeat(WRAPPED_32_BYTE_KEY_LEN * 2);
        let base = || GroupRosterPayload {
            account_number_hash_hex: "33".repeat(16),
            group_key_epoch: 1,
            owner_fingerprint_hex: hex_of(owner.fingerprint()),
            members: alloc::vec![
                roster_member(&owner, GroupRosterRole::Owner, GroupMemberState::Live, None),
                roster_member(
                    &member,
                    GroupRosterRole::Member,
                    GroupMemberState::Live,
                    Some(wrapped.clone()),
                ),
            ],
        };
        // No person id: valid (a row migrated from the pre-B2B roster).
        assert!(encode_group_roster(&base()).is_some());
        // A valid person id round-trips.
        let mut with_pid = base();
        with_pid.members[1].person_id_hex = Some("11".repeat(16));
        let bytes = encode_group_roster(&with_pid).expect("valid person id");
        assert!(parse_group_roster(&bytes).is_some());
        // An invalid person id is refused.
        let mut bad = base();
        bad.members[1].person_id_hex = Some("zz".into());
        assert!(encode_group_roster(&bad).is_none());
    }
}
