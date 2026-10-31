// SPDX-License-Identifier: AGPL-3.0
//! `NTV7`: the person-wrapped `vault.meta` generation (myne-md/myne#911).
//!
//! `NTV6` made the vault B2B: an owner-wrapped group key, a group-key epoch and
//! a signed roster. `NTV7` keeps that tail **byte for byte** and changes what
//! the credential side says about recovery:
//!
//! - the **password wrap stays**, unchanged in layout and AAD, so daily unlock
//!   is exactly what it was;
//! - the **recovery-phrase wrap is absent**, and its three fields (the recovery
//!   salt, the recovery nonce, the recovery-wrapped `root_key`) MUST be all
//!   zero. The person's identity phrase replaces it: `root_key` is sealed to the
//!   owner's person key with the same PQ-hybrid envelope the member group-key
//!   package uses.
//!
//! The all-zero requirement is **structural, not advisory**. A blob that carries
//! a live phrase wrap beside a person wrap describes a vault whose saved phrase
//! either does or does not still open it, and nothing on disk would say which.
//! So the writer refuses to emit one and the parser refuses to accept one, in
//! both directions: a half-migrated file fails closed instead of parsing as
//! something it is not (the same shape `NTV6` uses for its own tail).
//!
//! **Frame** (`445 + roster_len + 1208`, trailing bytes invalid):
//!
//! ```text
//! 0    4    magic "NTV7"
//! 4    1    protocol_version 0x02
//! 5    1    reserved 0x00
//! 6    339  the base layout of §9.3, with the three phrase-wrap fields zero
//! 345  24   group_key_nonce
//! 369  64   enc_group_key          (owner-wrapped group key)
//! 433  8    group_key_epoch        (big-endian, never 0)
//! 441  4    signed_roster_len      (big-endian)
//! 445  n    signed_roster_envelope (sealed under the group tier)
//! +n   1088 person wrap: ML-KEM-768 ciphertext
//! +1088 32  person wrap: classical ephemeral Ed25519 public key
//! +1120 24  person wrap: AEAD nonce
//! +1144 64  person wrap: root_key ciphertext (32) + CTX commitment (32)
//! ```
//!
//! The base is written through the shared [`serialize_vault_meta`] with the
//! header patched afterwards, exactly as `NTV6` does, so a byte at any offset
//! past the header cannot drift from the §9.3 contract.
//!
//! **What the person wrap is bound to.** Its AAD
//! ([`crate::person_key::aad_person_wrap_root_key`]) carries the recipient
//! fingerprint and the vault's `items_key_id`, and deliberately not the vault
//! id (a joining device mints its own) and not `account_number_hash` (this
//! generation keeps the account number out of vault cryptography). The binding
//! to `items_key_id` is what stops a `root_key` sealed for one vault being
//! dropped into another that happens to have the same owner.

use crate::aead::{AEAD_KEY_LEN, AEAD_NONCE_LEN};
use crate::error::ProtocolError;
use crate::person_key::{
    aad_person_wrap_root_key, PersonKeyPair, PersonPublicHalf, SealedToMember, PERSON_CT_LEN,
    PERSON_ED25519_PK_LEN,
};
use crate::vault_meta::{
    serialize_vault_meta, VaultMeta, VAULT_META_ITEMS_KEY_ID_LEN, VAULT_META_LEN, VAULT_META_MAGIC,
    VAULT_META_PROTOCOL_VERSION, VAULT_META_WRAPPED_ITEMS_KEY_LEN, VAULT_META_WRAPPED_ROOT_KEY_LEN,
};
use crate::vault_meta_v0_2::{B2B_META_FIXED_LEN, B2B_ROSTER_ENVELOPE_CAP};
use alloc::vec::Vec;
use zeroize::Zeroizing;

/// `NTV7` magic (offset 0). "Myne Next-major vault v7": the person-wrapped
/// generation. A reader that predates it MUST reject the magic rather than
/// treating the frame as an `NTV6` extension.
pub const VAULT_META_NTV7_MAGIC: [u8; 4] = *b"NTV7";

/// `protocol_version` byte (offset 4). `NTV7` keeps v0.2's content generation;
/// only the credential side and the tail's last field differ, and both are
/// framed by the magic.
pub const VAULT_META_NTV7_PROTOCOL_VERSION: u8 = 0x02;

/// The person wrap's wrapped-`root_key` field: 32-byte ciphertext followed by
/// the 32-byte CTX commitment (`aead_seal_ctx`'s framing, `protocol.md` §5.1).
///
/// The Poly1305 tag is NOT stored: `aead_seal_ctx` folds it into the CTX
/// commitment and recomputes it at open, which is why a wrapped 32-byte key is
/// 64 bytes here exactly as it is in `enc_root_key_password`
/// (`VAULT_META_WRAPPED_ROOT_KEY_LEN`). Reading "wrapped key" as 80 bytes
/// (ciphertext + stored tag + commitment) is the trap this constant exists to
/// prevent.
pub const PERSON_WRAP_WRAPPED_ROOT_KEY_LEN: usize = AEAD_KEY_LEN + 32;

/// The whole fixed-width person envelope appended after the roster.
pub const PERSON_WRAP_LEN: usize =
    PERSON_CT_LEN + PERSON_ED25519_PK_LEN + AEAD_NONCE_LEN + PERSON_WRAP_WRAPPED_ROOT_KEY_LEN;

/// The frame's length with an empty roster: base + B2B tail + person wrap.
pub const NTV7_FIXED_LEN: usize = B2B_META_FIXED_LEN + PERSON_WRAP_LEN;

/// The `root_key` sealed to one person, in the frame order this generation
/// writes it.
///
/// Not a second envelope design: these are exactly the fields of
/// [`SealedToMember`] (`ml_kem_ct`, `ed_ephemeral_pk`, `nonce`, `ciphertext`),
/// laid out in a fixed-width frame so `vault.meta` length is a constant. The
/// ciphertext is fixed-width here only because the plaintext is (`root_key`),
/// which the open path re-checks rather than assumes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonWrap {
    pub ml_kem_ct: [u8; PERSON_CT_LEN],
    pub ed_ephemeral_pk: [u8; PERSON_ED25519_PK_LEN],
    pub nonce: [u8; AEAD_NONCE_LEN],
    pub wrapped_root_key: [u8; PERSON_WRAP_WRAPPED_ROOT_KEY_LEN],
}

/// A parsed `NTV7` metadata frame. Every field is mandatory, as in `NTV6`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersonWrappedVaultMeta {
    pub base: VaultMeta,
    pub group_key_nonce: [u8; AEAD_NONCE_LEN],
    pub enc_group_key: [u8; VAULT_META_WRAPPED_ITEMS_KEY_LEN],
    pub group_key_epoch: u64,
    pub signed_roster_envelope: Vec<u8>,
    pub person_wrap: PersonWrap,
}

impl PersonWrappedVaultMeta {
    /// The `NTV6`-shaped view of this frame, for the helpers that already take
    /// one (`unlock_group_key_ntv6`, `unlock_items_key_ntv6`, roster openers).
    ///
    /// The tail is `NTV6`'s **byte for byte** (this generation's whole design is
    /// "keep that tail and change the credential side"), so re-deriving the
    /// group-tier unwrap here would be a second implementation of one layout.
    /// The clone is a few hundred bytes on an unlock path that already runs
    /// Argon2id.
    pub fn as_ntv6_tail(&self) -> crate::vault_meta_v0_2::B2bVaultMeta {
        crate::vault_meta_v0_2::B2bVaultMeta {
            base: self.base.clone(),
            group_key_nonce: self.group_key_nonce,
            enc_group_key: self.enc_group_key,
            group_key_epoch: self.group_key_epoch,
            signed_roster_envelope: self.signed_roster_envelope.clone(),
        }
    }
}

/// The three fields the phrase wrap occupied, all of which must be zero for a
/// generation that has retired it.
///
/// Shared with `NTV8`, which retires the phrase wrap for a different reason (no
/// second credential at all, rather than a person wrap replacing it). One
/// predicate, because "the phrase does not open this file" must not be spelled
/// two ways that could disagree.
pub(crate) fn phrase_wrap_is_absent(base: &VaultMeta) -> bool {
    base.random_salt_recovery == [0u8; crate::vault_meta::VAULT_META_SALT_RANDOM_LEN]
        && base.nonce_recovery_wrap == [0u8; AEAD_NONCE_LEN]
        && base.enc_root_key_recovery == [0u8; VAULT_META_WRAPPED_ROOT_KEY_LEN]
}

/// Whether a `signed_roster_len` is one the `NTV6` tail bounds allow. Shared by
/// every generation that carries that tail.
pub(crate) fn roster_len_is_plausible(len: usize) -> bool {
    (crate::person_invite::SEALED_GROUP_ROSTER_MIN_LEN..=B2B_ROSTER_ENVELOPE_CAP).contains(&len)
}

/// Serialize an `NTV7` frame.
///
/// Refuses, rather than silently repairing: a base carrying a live phrase wrap
/// (`InvalidVaultMeta`), a base carrying the §9.3.1 membership field (it would
/// shift every offset past the base), `group_key_epoch == 0`, and a roster
/// envelope outside the `NTV6` bounds. Refusing is the point: a writer that
/// zeroed the caller's recovery wrap would hide a vault that still holds one.
pub fn serialize_vault_meta_ntv7(meta: &PersonWrappedVaultMeta) -> Result<Vec<u8>, ProtocolError> {
    if meta.base.membership.is_some()
        || !phrase_wrap_is_absent(&meta.base)
        || meta.group_key_epoch == 0
        || !roster_len_is_plausible(meta.signed_roster_envelope.len())
    {
        return Err(ProtocolError::InvalidVaultMeta);
    }
    let mut out = serialize_vault_meta(&meta.base).to_vec();
    out[0..4].copy_from_slice(&VAULT_META_NTV7_MAGIC);
    out[4] = VAULT_META_NTV7_PROTOCOL_VERSION;
    out[5] = 0x00;
    out.extend_from_slice(&meta.group_key_nonce);
    out.extend_from_slice(&meta.enc_group_key);
    out.extend_from_slice(&meta.group_key_epoch.to_be_bytes());
    out.extend_from_slice(&(meta.signed_roster_envelope.len() as u32).to_be_bytes());
    out.extend_from_slice(&meta.signed_roster_envelope);
    out.extend_from_slice(&meta.person_wrap.ml_kem_ct);
    out.extend_from_slice(&meta.person_wrap.ed_ephemeral_pk);
    out.extend_from_slice(&meta.person_wrap.nonce);
    out.extend_from_slice(&meta.person_wrap.wrapped_root_key);
    Ok(out)
}

/// Parse the B2B tail from ANY generation that carries one (`NTV6`, `NTV7` or
/// `NTV8`), rejecting everything else.
///
/// The three generations share that tail byte for byte (§9.3.2, §9.3.5), so every
/// consumer that needs the epoch, the owner-wrapped group key or the roster
/// asks this one question instead of comparing a magic. `NTV7` and `NTV8` go
/// through their own strict parsers first, which is what enforces each
/// generation's own rules (a zero recovery wrap, and on `NTV7` the person
/// envelope's exact length). A vault born `NTV8` has no person wrap, so a
/// consumer that needs one asks the magic rather than this function.
pub fn parse_b2b_tail_any(
    bytes: &[u8],
) -> Result<crate::vault_meta_v0_2::B2bVaultMeta, ProtocolError> {
    match crate::vault_meta_v0_2::vault_meta_generation(bytes) {
        crate::vault_meta_v0_2::VaultMetaGeneration::Person => {
            parse_vault_meta_ntv7(bytes).map(|meta| meta.as_ntv6_tail())
        }
        crate::vault_meta_v0_2::VaultMetaGeneration::PersonNoWrap => {
            crate::vault_meta_ntv8::parse_vault_meta_ntv8(bytes).map(|meta| meta.as_ntv6_tail())
        }
        crate::vault_meta_v0_2::VaultMetaGeneration::B2b => {
            crate::vault_meta_v0_2::parse_vault_meta_ntv6(bytes)
        }
        crate::vault_meta_v0_2::VaultMetaGeneration::Legacy => Err(ProtocolError::InvalidVaultMeta),
    }
}

/// Rewrite the PASSWORD side of an `NTV7` frame, keeping everything else byte
/// for byte: the group-key tail, the roster and the person wrap (myne-md/myne#911
/// review).
///
/// The `NTV6` sibling exists because the versioned v0.2 rewrite re-serializes as
/// `NTV5` and drops the tail. This generation adds a second thing that rewrite
/// would drop, the person wrap, and a third rule it would break: `NTV7` requires
/// the recovery-phrase fields to be all zero, which the v0.2 rewrite preserves
/// rather than re-derives, so they stay zero here.
pub fn rewrite_vault_meta_password_side_ntv7(
    existing: &PersonWrappedVaultMeta,
    root_key: &[u8; AEAD_KEY_LEN],
    new_password: &str,
    fresh_salt: &[u8; crate::kdf::ARGON2_SALT_LEN],
    fresh_nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, ProtocolError> {
    let rewritten_base = crate::vault_meta_v0_2::rewrite_vault_meta_password_side_v0_2(
        &existing.base,
        root_key,
        new_password,
        fresh_salt,
        fresh_nonce,
    )?;
    let base = crate::vault_meta_v0_2::parse_vault_meta_v0_2(&rewritten_base)?;
    serialize_vault_meta_ntv7(&PersonWrappedVaultMeta {
        base,
        group_key_nonce: existing.group_key_nonce,
        enc_group_key: existing.enc_group_key,
        group_key_epoch: existing.group_key_epoch,
        signed_roster_envelope: existing.signed_roster_envelope.clone(),
        person_wrap: existing.person_wrap.clone(),
    })
}

/// Parse a strict `NTV7` frame without opening the person wrap, the group-key
/// package or the roster envelope.
///
/// Rejects a non-`NTV7` magic, a version or reserved byte that is not `NTV7`'s,
/// any other total length, a roster length outside the bounds, `group_key_epoch
/// == 0`, and (structurally) a non-zero phrase-wrap field.
pub fn parse_vault_meta_ntv7(bytes: &[u8]) -> Result<PersonWrappedVaultMeta, ProtocolError> {
    if bytes.len() < NTV7_FIXED_LEN
        || bytes.get(0..4) != Some(VAULT_META_NTV7_MAGIC.as_slice())
        || bytes[4] != VAULT_META_NTV7_PROTOCOL_VERSION
        || bytes[5] != 0x00
    {
        return Err(ProtocolError::InvalidVaultMeta);
    }
    let roster_len_start = VAULT_META_LEN + AEAD_NONCE_LEN + VAULT_META_WRAPPED_ITEMS_KEY_LEN + 8;
    let roster_len = u32::from_be_bytes(
        bytes[roster_len_start..roster_len_start + 4]
            .try_into()
            .unwrap(),
    ) as usize;
    if !roster_len_is_plausible(roster_len) || bytes.len() != NTV7_FIXED_LEN + roster_len {
        return Err(ProtocolError::InvalidVaultMeta);
    }

    // The base fields live at identical offsets in every generation; present
    // them under the v0.1 header so the one v0.1 parser owns their meaning.
    let mut as_v0_1 = [0u8; VAULT_META_LEN];
    as_v0_1.copy_from_slice(&bytes[..VAULT_META_LEN]);
    as_v0_1[0..4].copy_from_slice(&VAULT_META_MAGIC);
    as_v0_1[4] = VAULT_META_PROTOCOL_VERSION;
    let base = crate::vault_meta::parse_vault_meta(&as_v0_1)?;
    if !phrase_wrap_is_absent(&base) {
        return Err(ProtocolError::InvalidVaultMeta);
    }

    let nonce_start = VAULT_META_LEN;
    let enc_start = nonce_start + AEAD_NONCE_LEN;
    let epoch_start = enc_start + VAULT_META_WRAPPED_ITEMS_KEY_LEN;
    let mut group_key_nonce = [0u8; AEAD_NONCE_LEN];
    group_key_nonce.copy_from_slice(&bytes[nonce_start..enc_start]);
    let mut enc_group_key = [0u8; VAULT_META_WRAPPED_ITEMS_KEY_LEN];
    enc_group_key.copy_from_slice(&bytes[enc_start..epoch_start]);
    let group_key_epoch =
        u64::from_be_bytes(bytes[epoch_start..roster_len_start].try_into().unwrap());
    if group_key_epoch == 0 {
        return Err(ProtocolError::InvalidVaultMeta);
    }

    let wrap_start = B2B_META_FIXED_LEN + roster_len;
    let ed_start = wrap_start + PERSON_CT_LEN;
    let wrap_nonce_start = ed_start + PERSON_ED25519_PK_LEN;
    let wrapped_start = wrap_nonce_start + AEAD_NONCE_LEN;
    let mut person_wrap = PersonWrap {
        ml_kem_ct: [0u8; PERSON_CT_LEN],
        ed_ephemeral_pk: [0u8; PERSON_ED25519_PK_LEN],
        nonce: [0u8; AEAD_NONCE_LEN],
        wrapped_root_key: [0u8; PERSON_WRAP_WRAPPED_ROOT_KEY_LEN],
    };
    person_wrap
        .ml_kem_ct
        .copy_from_slice(&bytes[wrap_start..ed_start]);
    person_wrap
        .ed_ephemeral_pk
        .copy_from_slice(&bytes[ed_start..wrap_nonce_start]);
    person_wrap
        .nonce
        .copy_from_slice(&bytes[wrap_nonce_start..wrapped_start]);
    person_wrap
        .wrapped_root_key
        .copy_from_slice(&bytes[wrapped_start..wrapped_start + PERSON_WRAP_WRAPPED_ROOT_KEY_LEN]);

    Ok(PersonWrappedVaultMeta {
        base,
        group_key_nonce,
        enc_group_key,
        group_key_epoch,
        signed_roster_envelope: bytes[B2B_META_FIXED_LEN..wrap_start].to_vec(),
        person_wrap,
    })
}

/// Seal `root_key` to the owner's person key for an `NTV7` vault.
///
/// `_raw` convention: every random byte (the ML-KEM encapsulation, the classical
/// ephemeral seed, the nonce) comes from `rng`, which the caller MUST source
/// from a CSPRNG. There is deliberately no `getrandom` convenience here, matching
/// [`crate::person_invite::seal_group_roster`]: the person plane's seals all take
/// the caller's rng, because the caller is the one that knows whether it is on a
/// path allowed to touch an entropy source.
///
/// The owner's **public** half is enough, which is the point: a new vault's wrap
/// is written while the person session may be locked, so no phrase is needed at
/// vault creation.
pub fn seal_root_key_to_person_raw(
    owner: &PersonPublicHalf,
    root_key: &[u8; AEAD_KEY_LEN],
    items_key_id: &[u8; VAULT_META_ITEMS_KEY_ID_LEN],
    rng: &mut (impl rand_core::CryptoRng + ?Sized),
) -> Result<PersonWrap, ProtocolError> {
    let aad = aad_person_wrap_root_key(owner.fingerprint(), items_key_id);
    let sealed = owner.seal_to_member_with_aad(root_key, &aad, rng)?;
    if sealed.ciphertext.len() != PERSON_WRAP_WRAPPED_ROOT_KEY_LEN {
        return Err(ProtocolError::AeadFailure);
    }
    let mut wrapped_root_key = [0u8; PERSON_WRAP_WRAPPED_ROOT_KEY_LEN];
    wrapped_root_key.copy_from_slice(&sealed.ciphertext);
    Ok(PersonWrap {
        ml_kem_ct: sealed.ml_kem_ct,
        ed_ephemeral_pk: sealed.ed_ephemeral_pk,
        nonce: sealed.nonce,
        wrapped_root_key,
    })
}

/// Open an `NTV7` vault's person wrap with the owner's person keypair.
///
/// `items_key_id` MUST be the vault's own (read from the same frame), which is
/// the AAD's vault binding. Returns [`ProtocolError::AeadFailure`] for a wrong
/// person, a wrong vault, a tampered frame or a truncated plaintext, all
/// non-distinguishing per §6.4.
pub fn open_person_wrapped_root_key(
    owner: &PersonKeyPair,
    wrap: &PersonWrap,
    items_key_id: &[u8; VAULT_META_ITEMS_KEY_ID_LEN],
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, ProtocolError> {
    let aad = aad_person_wrap_root_key(owner.fingerprint(), items_key_id);
    let sealed = SealedToMember {
        ml_kem_ct: wrap.ml_kem_ct,
        ed_ephemeral_pk: wrap.ed_ephemeral_pk,
        nonce: wrap.nonce,
        ciphertext: wrap.wrapped_root_key.to_vec(),
    };
    let plaintext = owner.open_sealed_with_aad(&sealed, &aad)?;
    // Fixed-width on disk is not evidence about what the AEAD returned.
    if plaintext.len() != AEAD_KEY_LEN {
        return Err(ProtocolError::AeadFailure);
    }
    let mut out = Zeroizing::new([0u8; AEAD_KEY_LEN]);
    out.copy_from_slice(&plaintext);
    Ok(out)
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::test_vector_fmt::SeededRng;
    use crate::types::MetaVersion;

    const ROOT: [u8; 32] = [0x11; 32];
    const ITEMS_ID: [u8; 16] = [0x22; 16];
    const ACCT: [u8; 16] = [0x33; 16];

    fn fixture_kem(label: &[u8]) -> [u8; 64] {
        use sha2::Digest as _;
        let mut out = [0u8; 64];
        out[..32].copy_from_slice(&sha2::Sha256::digest([label, b"-d"].concat()));
        out[32..].copy_from_slice(&sha2::Sha256::digest([label, b"-z"].concat()));
        out
    }

    fn fixture_seed(label: &[u8]) -> [u8; 32] {
        use sha2::Digest as _;
        sha2::Sha256::digest(label).into()
    }

    fn owner_pair() -> PersonKeyPair {
        PersonKeyPair::generate_raw(
            &fixture_kem(b"ntv7-owner-kem"),
            &fixture_seed(b"ntv7-owner-ed25519"),
            &fixture_seed(b"ntv7-owner-mldsa"),
        )
    }

    /// A base with the phrase wrap retired: password wrap present, the three
    /// recovery fields zero.
    fn base_without_phrase_wrap() -> VaultMeta {
        let mut base = crate::vault_meta_v0_2::parse_vault_meta_v0_2(&serialized_base())
            .expect("parse base NTV5");
        base.random_salt_recovery = [0u8; crate::vault_meta::VAULT_META_SALT_RANDOM_LEN];
        base.nonce_recovery_wrap = [0u8; AEAD_NONCE_LEN];
        base.enc_root_key_recovery = [0u8; VAULT_META_WRAPPED_ROOT_KEY_LEN];
        base
    }

    fn serialized_base() -> [u8; VAULT_META_LEN] {
        crate::vault_meta_v0_2::encode_vault_meta_v0_2_raw(
            &ROOT,
            &[0x44; 32],
            &ITEMS_ID,
            "correct horse battery staple",
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
            &ACCT,
            &crate::types::KdfParams {
                m_kib: 8,
                t: 1,
                p: 1,
                argon2_version: 0x13,
            },
            &[0x01; 16],
            &[0x02; 16],
            &[0x03; 24],
            &[0x04; 24],
            &[0x05; 24],
        )
        .expect("encode base")
    }

    fn roster_envelope() -> Vec<u8> {
        let signed = crate::person_invite::SignedGroupRoster {
            payload: alloc::vec![0xC3; 32],
            signature: crate::person_key::PersonSigned {
                ed25519_sig: [0xD4; crate::person_key::PERSON_ED25519_SIG_LEN],
                mldsa_sig: alloc::vec![0xE5; crate::person_key::PERSON_MLDSA_SIG_LEN],
            },
        };
        crate::person_invite::seal_group_roster(
            &[0x77; 32],
            &ACCT,
            1,
            &[0x66; AEAD_NONCE_LEN],
            &signed,
        )
        .expect("sealed roster")
    }

    fn ntv7_fixture() -> PersonWrappedVaultMeta {
        let owner = owner_pair();
        let mut rng = SeededRng::new(7);
        PersonWrappedVaultMeta {
            base: base_without_phrase_wrap(),
            group_key_nonce: [0xA1; AEAD_NONCE_LEN],
            enc_group_key: [0xB2; VAULT_META_WRAPPED_ITEMS_KEY_LEN],
            group_key_epoch: 1,
            signed_roster_envelope: roster_envelope(),
            person_wrap: seal_root_key_to_person_raw(
                &owner.public_half(),
                &ROOT,
                &ITEMS_ID,
                &mut rng,
            )
            .expect("seal root key"),
        }
    }

    #[test]
    fn ntv7_round_trips_and_still_serves_the_base_fields() {
        let meta = ntv7_fixture();
        let bytes = serialize_vault_meta_ntv7(&meta).expect("serialize NTV7");
        assert_eq!(&bytes[..4], b"NTV7");
        assert_eq!(bytes[4], 0x02);
        assert_eq!(bytes[5], 0x00);
        assert_eq!(
            bytes.len(),
            NTV7_FIXED_LEN + meta.signed_roster_envelope.len()
        );
        assert_eq!(parse_vault_meta_ntv7(&bytes), Ok(meta.clone()));
        // Every singleton/index/sync reader goes through the base dispatcher, so
        // it must serve an NTV7 vault's base fields unchanged.
        assert_eq!(
            crate::vault_meta_v0_2::parse_vault_meta_any(&bytes),
            Ok(meta.base.clone())
        );
    }

    #[test]
    fn ntv7_is_refused_by_every_reader_that_predates_it() {
        let bytes = serialize_vault_meta_ntv7(&ntv7_fixture()).expect("serialize");
        // The v0.1 reader (magic), the v0.2 base reader (magic) and the NTV6
        // reader (magic) all refuse rather than mis-parsing the tail.
        assert_eq!(
            crate::vault_meta::parse_vault_meta(&bytes[..VAULT_META_LEN]),
            Err(ProtocolError::InvalidVaultMeta)
        );
        assert_eq!(
            crate::vault_meta_v0_2::parse_vault_meta_v0_2(&bytes),
            Err(ProtocolError::InvalidVaultMeta)
        );
        assert_eq!(
            crate::vault_meta_v0_2::parse_vault_meta_ntv6(&bytes),
            Err(ProtocolError::InvalidVaultMeta)
        );
        // Generation-wise it is a v0.2 frame, so an NTV7 vault does not need a
        // fifth client generation.
        assert_eq!(
            crate::vault_meta_v0_2::meta_version_of(&bytes),
            Some(MetaVersion::V0_2)
        );
    }

    #[test]
    fn a_live_phrase_wrap_is_refused_in_both_directions() {
        // Writer: refuses to emit a frame that still carries a recovery wrap.
        let meta = ntv7_fixture();
        let mut with_salt = meta.clone();
        with_salt.base.random_salt_recovery = [0x09; 16];
        assert_eq!(
            serialize_vault_meta_ntv7(&with_salt),
            Err(ProtocolError::InvalidVaultMeta)
        );
        let mut with_nonce = meta.clone();
        with_nonce.base.nonce_recovery_wrap = [0x09; AEAD_NONCE_LEN];
        assert_eq!(
            serialize_vault_meta_ntv7(&with_nonce),
            Err(ProtocolError::InvalidVaultMeta)
        );
        let mut with_ciphertext = meta.clone();
        with_ciphertext.base.enc_root_key_recovery = [0x09; VAULT_META_WRAPPED_ROOT_KEY_LEN];
        assert_eq!(
            serialize_vault_meta_ntv7(&with_ciphertext),
            Err(ProtocolError::InvalidVaultMeta)
        );

        // Reader: a byte poked into each of the three fields after the fact is a
        // structural rejection, not a parse that quietly believes the phrase
        // still works.
        let good = serialize_vault_meta_ntv7(&meta.clone()).expect("serialize");
        for offset in [49usize, 153, 177] {
            let mut bytes = good.clone();
            bytes[offset] = 0x7F;
            assert_eq!(
                parse_vault_meta_ntv7(&bytes),
                Err(ProtocolError::InvalidVaultMeta),
                "offset {offset} must be structurally zero"
            );
        }
    }

    #[test]
    fn the_person_wrap_opens_the_root_key() {
        let owner = owner_pair();
        let mut rng = SeededRng::new(11);
        let wrap =
            seal_root_key_to_person_raw(&owner.public_half(), &ROOT, &ITEMS_ID, &mut rng).unwrap();
        assert_eq!(
            wrap.wrapped_root_key.len(),
            PERSON_WRAP_WRAPPED_ROOT_KEY_LEN
        );
        let opened = open_person_wrapped_root_key(&owner, &wrap, &ITEMS_ID).expect("open");
        assert_eq!(*opened, ROOT);
    }

    #[test]
    fn a_tampered_person_wrap_fails_closed() {
        let owner = owner_pair();
        let mut rng = SeededRng::new(13);
        let good_owner = owner_pair();
        let wrap =
            seal_root_key_to_person_raw(&good_owner.public_half(), &ROOT, &ITEMS_ID, &mut rng)
                .unwrap();

        // Each half of the hybrid envelope, and the AEAD field itself.
        let mutate = |f: &dyn Fn(&mut PersonWrap)| {
            let mut w = wrap.clone();
            f(&mut w);
            assert_eq!(
                open_person_wrapped_root_key(&owner, &w, &ITEMS_ID),
                Err(ProtocolError::AeadFailure)
            );
        };
        mutate(&|w| w.ml_kem_ct[0] ^= 0xFF);
        mutate(&|w| w.ed_ephemeral_pk[0] ^= 0xFF);
        mutate(&|w| w.nonce[0] ^= 0xFF);
        mutate(&|w| w.wrapped_root_key[0] ^= 0xFF);
        mutate(&|w| w.wrapped_root_key[PERSON_WRAP_WRAPPED_ROOT_KEY_LEN - 1] ^= 0x01);

        // The AAD binding: another vault's items_key_id, and a different person.
        assert_eq!(
            open_person_wrapped_root_key(&owner, &wrap, &[0x99; 16]),
            Err(ProtocolError::AeadFailure)
        );
        let other = PersonKeyPair::generate_raw(
            &fixture_kem(b"ntv7-other-kem"),
            &fixture_seed(b"ntv7-other-ed25519"),
            &fixture_seed(b"ntv7-other-mldsa"),
        );
        assert_eq!(
            open_person_wrapped_root_key(&other, &wrap, &ITEMS_ID),
            Err(ProtocolError::AeadFailure)
        );
    }

    #[test]
    fn the_frame_rejects_any_other_length_or_epoch() {
        let meta = ntv7_fixture();
        let good = serialize_vault_meta_ntv7(&meta).expect("serialize");

        let mut trailing = good.clone();
        trailing.push(0x00);
        assert_eq!(
            parse_vault_meta_ntv7(&trailing),
            Err(ProtocolError::InvalidVaultMeta)
        );
        assert_eq!(
            parse_vault_meta_ntv7(&good[..good.len() - 1]),
            Err(ProtocolError::InvalidVaultMeta)
        );

        let mut zero_epoch = good.clone();
        zero_epoch[433..441].copy_from_slice(&0u64.to_be_bytes());
        assert_eq!(
            parse_vault_meta_ntv7(&zero_epoch),
            Err(ProtocolError::InvalidVaultMeta)
        );

        // The roster length is the frame's own arithmetic: a length that does
        // not land exactly on the end is a rejection, not a guess.
        let mut wrong_roster = good.clone();
        wrong_roster[441..445].copy_from_slice(&1u32.to_be_bytes());
        assert_eq!(
            parse_vault_meta_ntv7(&wrong_roster),
            Err(ProtocolError::InvalidVaultMeta)
        );

        // A writer refuses the same epoch rule from its side.
        let mut meta = meta;
        meta.group_key_epoch = 0;
        assert_eq!(
            serialize_vault_meta_ntv7(&meta),
            Err(ProtocolError::InvalidVaultMeta)
        );
    }

    // ---- KAT vector regenerator (companion repo) ---------------------

    /// Emits the `vault-meta-ntv7` cross-implementation vector set for
    /// `myne-test-vectors/vectors/vault-meta-ntv7/v0.2/cases.json`.
    ///
    /// Three case kinds: `roundtrip` (parse then re-serialize is byte-identical,
    /// plus the field extractions a port must agree on), `parse_fail` (every
    /// structural rejection, the three phrase-wrap fields included), and the
    /// `person_wrap_open` pair, which pins that a frame opens to ONE root key
    /// under a given person keypair and that tampering fails closed.
    ///
    /// **Why the open cases carry seeds rather than a keypair.** ML-KEM
    /// encapsulation is randomized, so no port can be asked to mint our exact
    /// person-wrap bytes; what crosses the boundary is (a) DETERMINISTIC keys
    /// derived from the three seeds and (b) the OUTCOME (this root key, or a
    /// refusal). The committed file is reproducible for us because the generator
    /// drives the seal from a fixed seed; that is an emitter property, not part
    /// of the contract.
    ///
    /// `#[ignore]`. Run:
    /// `cargo test -p protocol --lib emit_vault_meta_ntv7_vectors_for_paste -- --ignored`
    #[test]
    #[ignore]
    fn emit_vault_meta_ntv7_vectors_for_paste() {
        extern crate std;
        use crate::test_vector_fmt::{hex_lower, SeededRng};
        use alloc::format;
        use alloc::string::String;

        let meta = ntv7_fixture();
        let blob = serialize_vault_meta_ntv7(&meta).expect("serialize NTV7");
        let roster_len = meta.signed_roster_envelope.len();
        let blob_hex = hex_lower(&blob);
        assert_eq!(blob.len(), NTV7_FIXED_LEN + roster_len);
        assert_eq!(parse_vault_meta_ntv7(&blob).as_ref(), Ok(&meta));

        let owner = owner_pair();

        let mut dump = String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"vault-meta-ntv7\",\n");
        dump.push_str("  \"protocol_version\": \"v0.2\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §9.3.2 + §9.3.3 (NTV7) + §5.2 (person-wrap-root-key)\",\n");
        dump.push_str("  \"description\": \"Pins the NTV7 vault.meta generation: the NTV6 frame byte for byte, with the three recovery-phrase wrap fields structurally zero and a fixed 1208-byte person envelope sealing root_key to the owner's person key. A conformant port parses the frame, must refuse a non-zero phrase-wrap field and any length other than 445 + roster_len + 1208, and must open the person wrap only under the recipient key and the frame's own items_key_id. `parse_fail` cases are expected to return the one non-distinguishing invalid-metadata result. Generated by `cargo test -p protocol --lib emit_vault_meta_ntv7_vectors_for_paste -- --ignored --nocapture`.\",\n");
        dump.push_str("  \"cases\": [\n");

        // 1. roundtrip
        let w = &meta.person_wrap;
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"vault-meta-ntv7/v0.2/frame-roundtrip\",\n");
        dump.push_str("      \"description\": \"A full NTV7 frame: base with the phrase wrap zeroed, the NTV6 tail (group-key package, epoch 1, sealed roster), then the person envelope sealed to the fixture owner. parse then re-serialize must reproduce these bytes exactly, and the tail fields must be read back at their offsets.\",\n");
        dump.push_str("      \"case_kind\": \"roundtrip\",\n");
        dump.push_str(&format!("      \"input_blob_hex\": \"{blob_hex}\",\n"));
        dump.push_str(&format!("      \"expected_blob_hex\": \"{blob_hex}\",\n"));
        dump.push_str(&format!(
            "      \"expected_group_key_epoch\": {},\n",
            meta.group_key_epoch
        ));
        dump.push_str(&format!(
            "      \"expected_signed_roster_len\": {roster_len},\n"
        ));
        dump.push_str(&format!(
            "      \"expected_base_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&meta.base.account_number_hash)
        ));
        dump.push_str(&format!(
            "      \"expected_base_items_key_id_hex\": \"{}\",\n",
            hex_lower(&meta.base.items_key_id)
        ));
        dump.push_str(&format!(
            "      \"expected_person_wrap_ml_kem_ct_hex\": \"{}\",\n",
            hex_lower(&w.ml_kem_ct)
        ));
        dump.push_str(&format!(
            "      \"expected_person_wrap_ed_ephemeral_pk_hex\": \"{}\",\n",
            hex_lower(&w.ed_ephemeral_pk)
        ));
        dump.push_str(&format!(
            "      \"expected_person_wrap_nonce_hex\": \"{}\",\n",
            hex_lower(&w.nonce)
        ));
        dump.push_str(&format!(
            "      \"expected_person_wrap_wrapped_root_key_hex\": \"{}\"\n",
            hex_lower(&w.wrapped_root_key)
        ));
        dump.push_str("    },\n");

        // 2. parse_fail
        struct Fail {
            slug: &'static str,
            description: &'static str,
            reason: &'static str,
            mutate: fn(&mut alloc::vec::Vec<u8>),
        }
        let fails: [Fail; 8] = [
            Fail {
                slug: "parse-fail-ntv6-magic",
                description: "The same frame with its magic relabelled NTV6. An NTV6 reader treats the tail as ending there, so NTV7 must be its own magic and this is the case that holds a reader to the magic rather than to the layout.",
                reason: "magic is not NTV7",
                mutate: |b| b[0..4].copy_from_slice(b"NTV6"),
            },
            Fail {
                slug: "parse-fail-protocol-version",
                description: "protocol_version byte 0x01 instead of 0x02.",
                reason: "wrong protocol_version byte",
                mutate: |b| b[4] = 0x01,
            },
            Fail {
                slug: "parse-fail-reserved",
                description: "reserved byte 0x01 instead of 0x00.",
                reason: "reserved byte must be 0x00",
                mutate: |b| b[5] = 0x01,
            },
            Fail {
                slug: "parse-fail-live-recovery-salt",
                description: "A byte written into the recovery SALT (offset 49). NTV7 retires the phrase wrap, so a frame that still carries any byte of it is structurally invalid rather than a vault whose saved phrase may or may not still work.",
                reason: "non-zero recovery salt",
                mutate: |b| b[49] = 0x7F,
            },
            Fail {
                slug: "parse-fail-live-recovery-nonce",
                description: "A byte written into the recovery wrap NONCE (offset 153). Same structural rule as the salt.",
                reason: "non-zero recovery nonce",
                mutate: |b| b[153] = 0x7F,
            },
            Fail {
                slug: "parse-fail-live-recovery-ciphertext",
                description: "A byte written into the recovery-wrapped root_key (offset 177). Same structural rule: the third and last field the phrase wrap occupied.",
                reason: "non-zero recovery-wrapped root_key",
                mutate: |b| b[177] = 0x7F,
            },
            Fail {
                slug: "parse-fail-trailing-byte",
                description: "One byte appended after the person envelope. The frame length is fixed at 445 + roster_len + 1208, so trailing bytes are a rejection and not an extension point.",
                reason: "trailing bytes after the person envelope",
                mutate: |b| b.push(0x00),
            },
            Fail {
                slug: "parse-fail-zero-epoch",
                description: "group_key_epoch forced to 0 (bytes 433..441). An epoch of zero is not a valid group-key generation in any NTV6-derived frame.",
                reason: "group_key_epoch == 0",
                mutate: |b| b[433..441].copy_from_slice(&0u64.to_be_bytes()),
            },
        ];
        for f in fails.iter() {
            let mut bytes = blob.clone();
            (f.mutate)(&mut bytes);
            assert!(
                parse_vault_meta_ntv7(&bytes).is_err(),
                "[{}] the fixture must be rejected before it is emitted",
                f.slug
            );
            dump.push_str("    {\n");
            dump.push_str(&format!(
                "      \"vector_id\": \"vault-meta-ntv7/v0.2/{}\",\n",
                f.slug
            ));
            dump.push_str(&format!("      \"description\": \"{}\",\n", f.description));
            dump.push_str("      \"case_kind\": \"parse_fail\",\n");
            dump.push_str(&format!(
                "      \"input_blob_hex\": \"{}\",\n",
                hex_lower(&bytes)
            ));
            dump.push_str("      \"expected_kind\": \"invalid_meta\",\n");
            dump.push_str(&format!(
                "      \"informational_reason\": \"{}\"\n",
                f.reason
            ));
            dump.push_str("    },\n");
        }

        // 3. person wrap open / open_fail
        let mut rng = SeededRng::new(7);
        let wrap = seal_root_key_to_person_raw(&owner.public_half(), &ROOT, &ITEMS_ID, &mut rng)
            .expect("seal root key");
        assert_eq!(
            open_person_wrapped_root_key(&owner, &wrap, &ITEMS_ID).as_deref(),
            Ok(&ROOT)
        );

        struct OpenFail {
            slug: &'static str,
            description: &'static str,
            reason: &'static str,
            mutate: fn(&mut PersonWrap),
            wrong_items_key_id: bool,
        }
        let open_fails: [OpenFail; 3] = [
            OpenFail {
                slug: "person-wrap-fail-ml-kem-ct",
                description: "One ML-KEM ciphertext bit flipped. The PQ half decapsulates to a different secret, so the hybrid wrap key differs and the AEAD refuses.",
                reason: "tampered ML-KEM ciphertext",
                mutate: |w| w.ml_kem_ct[0] ^= 0xFF,
                wrong_items_key_id: false,
            },
            OpenFail {
                slug: "person-wrap-fail-nonce",
                description: "One nonce bit flipped. The nonce is keystream input for XChaCha20-Poly1305 as well as CTX commitment input, so a changed nonce is a different keystream and a failed tag.",
                reason: "tampered nonce",
                mutate: |w| w.nonce[0] ^= 0xFF,
                wrong_items_key_id: false,
            },
            OpenFail {
                slug: "person-wrap-fail-wrong-vault",
                description: "The AAD's vault binding: the SAME frame opened with another vault's items_key_id. This is the case that pins why items_key_id is in the AAD at all; without it a root_key sealed for one vault would open in another of the same owner.",
                reason: "items_key_id from a different vault",
                mutate: |_w| {},
                wrong_items_key_id: true,
            },
        ];

        let write_seeds = |dump: &mut String| {
            dump.push_str(&format!(
                "      \"input_kem_seed_hex\": \"{}\",\n",
                hex_lower(&fixture_kem(b"ntv7-owner-kem"))
            ));
            dump.push_str(&format!(
                "      \"input_ed25519_seed_hex\": \"{}\",\n",
                hex_lower(&fixture_seed(b"ntv7-owner-ed25519"))
            ));
            dump.push_str(&format!(
                "      \"input_mldsa_seed_hex\": \"{}\",\n",
                hex_lower(&fixture_seed(b"ntv7-owner-mldsa"))
            ));
        };
        let write_wrap = |dump: &mut String, w: &PersonWrap| {
            dump.push_str(&format!(
                "      \"input_person_wrap_ml_kem_ct_hex\": \"{}\",\n",
                hex_lower(&w.ml_kem_ct)
            ));
            dump.push_str(&format!(
                "      \"input_person_wrap_ed_ephemeral_pk_hex\": \"{}\",\n",
                hex_lower(&w.ed_ephemeral_pk)
            ));
            dump.push_str(&format!(
                "      \"input_person_wrap_nonce_hex\": \"{}\",\n",
                hex_lower(&w.nonce)
            ));
            dump.push_str(&format!(
                "      \"input_person_wrap_wrapped_root_key_hex\": \"{}\",\n",
                hex_lower(&w.wrapped_root_key)
            ));
        };

        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"vault-meta-ntv7/v0.2/person-wrap-opens\",\n");
        dump.push_str("      \"description\": \"The owner's deterministic keypair (from the three seeds) opens the person envelope to the vault's root_key, under the frame's own items_key_id. A port derives the hybrid wrap key from the ML-KEM decapsulation and the Ed25519 static DH, then AEAD-opens under role 'person-wrap-root-key' bound to its fingerprint and that items_key_id.\",\n");
        dump.push_str("      \"case_kind\": \"person_wrap_open\",\n");
        write_seeds(&mut dump);
        dump.push_str(&format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&ITEMS_ID)
        ));
        write_wrap(&mut dump, &wrap);
        dump.push_str(&format!(
            "      \"expected_root_key_hex\": \"{}\"\n",
            hex_lower(&ROOT)
        ));
        dump.push_str("    },\n");

        for f in open_fails.iter() {
            let mut w = wrap.clone();
            (f.mutate)(&mut w);
            let items_key_id = if f.wrong_items_key_id {
                [0x99u8; 16]
            } else {
                ITEMS_ID
            };
            assert_eq!(
                open_person_wrapped_root_key(&owner, &w, &items_key_id),
                Err(ProtocolError::AeadFailure),
                "[{}] must fail closed before it is emitted",
                f.slug
            );
            dump.push_str("    {\n");
            dump.push_str(&format!(
                "      \"vector_id\": \"vault-meta-ntv7/v0.2/{}\",\n",
                f.slug
            ));
            dump.push_str(&format!("      \"description\": \"{}\",\n", f.description));
            dump.push_str("      \"case_kind\": \"person_wrap_open_fail\",\n");
            write_seeds(&mut dump);
            dump.push_str(&format!(
                "      \"input_items_key_id_hex\": \"{}\",\n",
                hex_lower(&items_key_id)
            ));
            write_wrap(&mut dump, &w);
            dump.push_str("      \"expected_kind\": \"aead_fail\",\n");
            dump.push_str(&format!(
                "      \"informational_reason\": \"{}\"\n",
                f.reason
            ));
            dump.push_str("    },\n");
        }

        // Drop the comma the last case left behind, so the JSON stays valid.
        assert!(dump.ends_with(",\n"));
        dump.truncate(dump.len() - 2);
        dump.push('\n');
        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_vault_meta_ntv7_vectors.json", dump.as_bytes())
            .expect("write vault-meta-ntv7 vectors dump");
        std::println!("{dump}");
    }
}
