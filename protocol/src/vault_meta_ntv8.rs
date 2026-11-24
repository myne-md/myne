// SPDX-License-Identifier: AGPL-3.0-only
//! `NTV8`: the password-only `vault.meta` generation (myne-md/myne#938).
//!
//! `NTV7` gave an owner two credentials: the master password, and the identity
//! phrase that opens the person wrap. `NTV8` removes the second one. The
//! password is the only credential, the phrase is only an identity, and this
//! frame says so structurally rather than by a flag.
//!
//! The tail is `NTV6`'s byte for byte, as it is on `NTV7`: an owner-wrapped
//! group key, a strictly positive group-key epoch, and a sealed owner-signed
//! roster. What `NTV8` drops is exactly the 1208 bytes `NTV7` appended after the
//! roster:
//!
//! ```text
//! NTV7  [0..444 fixed][roster][1088 ct | 32 ed pk | 24 nonce | 64 wrapped root]
//! NTV8  [0..444 fixed][roster]
//! ```
//!
//! So an `NTV7` to `NTV8` upgrade is a truncation plus a header patch and
//! **re-wraps no key**: every byte from 6 to 344 keeps its offset, its AAD and
//! its meaning, which is why the password a user already has still opens the
//! file (§10.4.2).
//!
//! The three phrase-wrap fields (`random_salt_recovery_16`,
//! `nonce_recovery_wrap`, `enc_root_key_recovery`) stay present and MUST be all
//! zero, in both directions, exactly as on `NTV7`. They are kept rather than
//! compacted away because their offsets are part of the §9.3 base layout that
//! every generation shares: removing them would move `items_key_id` and the
//! `itemsKey` wrap, which is a re-wrap of every vault instead of a truncation of
//! one.
//!
//! **Frame** (`445 + roster_len`, any other length invalid):
//!
//! ```text
//! 0    4    magic "NTV8"
//! 4    1    protocol_version 0x02
//! 5    1    reserved 0x00
//! 6    339  the base layout of §9.3, three phrase-wrap fields zero
//! 345  24   group_key_nonce
//! 369  64   enc_group_key     (owner-wrapped group key)
//! 433  8    group_key_epoch   (big-endian, never 0)
//! 441  4    signed_roster_len (big-endian)
//! 445  n    signed_roster_envelope
//! ```
//!
//! A reader that predates this generation MUST reject the magic rather than
//! parsing the frame as an `NTV7` whose person wrap was never written: the two
//! differ only in length and magic, so a lenient reader would accept an
//! `NTV8` file and then wait for a credential the user no longer has.

use crate::aead::{AEAD_KEY_LEN, AEAD_NONCE_LEN};
use crate::error::ProtocolError;
use crate::vault_meta::{
    serialize_vault_meta, VaultMeta, VAULT_META_LEN, VAULT_META_MAGIC, VAULT_META_PROTOCOL_VERSION,
    VAULT_META_WRAPPED_ITEMS_KEY_LEN,
};
use crate::vault_meta_ntv7::{phrase_wrap_is_absent, roster_len_is_plausible};
use crate::vault_meta_v0_2::B2B_META_FIXED_LEN;
use alloc::vec::Vec;

/// `NTV8` magic (offset 0). "Myne Next-major vault v8": the password-only
/// generation. A pre-`NTV8` reader MUST reject it rather than treating the frame
/// as an `NTV7` with a short tail.
pub const VAULT_META_NTV8_MAGIC: [u8; 4] = *b"NTV8";

/// `protocol_version` byte (offset 4). `NTV8` keeps v0.2's content generation;
/// only the credential side and the tail's length differ, and both are framed by
/// the magic.
pub const VAULT_META_NTV8_PROTOCOL_VERSION: u8 = 0x02;

/// The frame's length with an empty roster: the base plus the B2B tail, with no
/// person wrap. The absence is the length, not a zero-filled block, so it cannot
/// be relaxed by a later writer without changing the number every parser
/// compares against.
pub const NTV8_FIXED_LEN: usize = B2B_META_FIXED_LEN;

/// A parsed `NTV8` metadata frame. Every field is mandatory, as in `NTV6`; the
/// one field `NTV7` has that this generation does not is the person wrap, and
/// there is no placeholder for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasswordOnlyVaultMeta {
    pub base: VaultMeta,
    pub group_key_nonce: [u8; AEAD_NONCE_LEN],
    pub enc_group_key: [u8; VAULT_META_WRAPPED_ITEMS_KEY_LEN],
    pub group_key_epoch: u64,
    pub signed_roster_envelope: Vec<u8>,
}

impl PasswordOnlyVaultMeta {
    /// The `NTV6`-shaped view of this frame, for the helpers that already take
    /// one (`unlock_group_key_ntv6`, `unlock_items_key_ntv6`, the roster
    /// openers).
    ///
    /// The tail is `NTV6`'s byte for byte, so re-deriving the group-tier unwrap
    /// here would be a second implementation of one layout. The clone is a few
    /// hundred bytes on a path that already runs Argon2id.
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

/// Serialize an `NTV8` frame.
///
/// Refuses, rather than silently repairing: a base carrying a live phrase wrap
/// (`InvalidVaultMeta`), a base carrying the §9.3.1 membership field (it would
/// shift every offset past the base), `group_key_epoch == 0`, and a roster
/// envelope outside the `NTV6` bounds. Refusing is the point: a writer that
/// zeroed the caller's recovery wrap would hide a vault that still holds one.
pub fn serialize_vault_meta_ntv8(meta: &PasswordOnlyVaultMeta) -> Result<Vec<u8>, ProtocolError> {
    if meta.base.membership.is_some()
        || !phrase_wrap_is_absent(&meta.base)
        || meta.group_key_epoch == 0
        || !roster_len_is_plausible(meta.signed_roster_envelope.len())
    {
        return Err(ProtocolError::InvalidVaultMeta);
    }
    let mut out = serialize_vault_meta(&meta.base).to_vec();
    out[0..4].copy_from_slice(&VAULT_META_NTV8_MAGIC);
    out[4] = VAULT_META_NTV8_PROTOCOL_VERSION;
    out[5] = 0x00;
    out.extend_from_slice(&meta.group_key_nonce);
    out.extend_from_slice(&meta.enc_group_key);
    out.extend_from_slice(&meta.group_key_epoch.to_be_bytes());
    out.extend_from_slice(&(meta.signed_roster_envelope.len() as u32).to_be_bytes());
    out.extend_from_slice(&meta.signed_roster_envelope);
    Ok(out)
}

/// Rewrite the PASSWORD side of an `NTV8` frame, keeping everything else byte
/// for byte: the group-key tail and the roster.
///
/// The sibling rewrites exist because the versioned v0.2 rewrite re-serializes as
/// `NTV5` and drops the tail. This generation adds no field that rewrite would
/// drop (it has no person wrap to lose), but it does need the tail carried and
/// the phrase-wrap fields left zero, which the v0.2 rewrite preserves rather than
/// re-derives.
pub fn rewrite_vault_meta_password_side_ntv8(
    existing: &PasswordOnlyVaultMeta,
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
    serialize_vault_meta_ntv8(&PasswordOnlyVaultMeta {
        base,
        group_key_nonce: existing.group_key_nonce,
        enc_group_key: existing.enc_group_key,
        group_key_epoch: existing.group_key_epoch,
        signed_roster_envelope: existing.signed_roster_envelope.clone(),
    })
}

/// Parse a strict `NTV8` frame without opening the group-key package or the
/// roster envelope.
///
/// Rejects a non-`NTV8` magic, a version or reserved byte that is not `NTV8`'s,
/// any total length other than `NTV8_FIXED_LEN + roster_len` (which is what
/// refuses an `NTV7` frame whose magic was patched and whose person wrap is still
/// there), a roster length outside the bounds, `group_key_epoch == 0`, and
/// (structurally) a non-zero phrase-wrap field.
pub fn parse_vault_meta_ntv8(bytes: &[u8]) -> Result<PasswordOnlyVaultMeta, ProtocolError> {
    if bytes.len() < NTV8_FIXED_LEN
        || bytes.get(0..4) != Some(VAULT_META_NTV8_MAGIC.as_slice())
        || bytes[4] != VAULT_META_NTV8_PROTOCOL_VERSION
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
    if !roster_len_is_plausible(roster_len) || bytes.len() != NTV8_FIXED_LEN + roster_len {
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

    Ok(PasswordOnlyVaultMeta {
        base,
        group_key_nonce,
        enc_group_key,
        group_key_epoch,
        signed_roster_envelope: bytes[B2B_META_FIXED_LEN..].to_vec(),
    })
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::person_key::PersonKeyPair;
    use crate::vault_meta::{VAULT_META_SALT_RANDOM_LEN, VAULT_META_WRAPPED_ROOT_KEY_LEN};
    use crate::vault_meta_ntv7::PERSON_WRAP_LEN;

    const ROOT: [u8; 32] = [0x11; 32];
    const ITEMS_ID: [u8; 16] = [0x22; 16];
    const ACCT: [u8; 16] = [0x33; 16];

    fn fixture_seed(label: &[u8]) -> [u8; 32] {
        use sha2::Digest as _;
        sha2::Sha256::digest(label).into()
    }

    fn fixture_kem(label: &[u8]) -> [u8; 64] {
        use sha2::Digest as _;
        let mut out = [0u8; 64];
        out[..32].copy_from_slice(&sha2::Sha256::digest([label, b"-d"].concat()));
        out[32..].copy_from_slice(&sha2::Sha256::digest([label, b"-z"].concat()));
        out
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

    /// A base with the phrase wrap retired: password wrap present, the three
    /// recovery fields zero.
    fn base_without_phrase_wrap() -> VaultMeta {
        let mut base = crate::vault_meta_v0_2::parse_vault_meta_v0_2(&serialized_base())
            .expect("parse base NTV5");
        base.random_salt_recovery = [0u8; VAULT_META_SALT_RANDOM_LEN];
        base.nonce_recovery_wrap = [0u8; AEAD_NONCE_LEN];
        base.enc_root_key_recovery = [0u8; VAULT_META_WRAPPED_ROOT_KEY_LEN];
        base
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

    fn ntv8_fixture() -> PasswordOnlyVaultMeta {
        PasswordOnlyVaultMeta {
            base: base_without_phrase_wrap(),
            group_key_nonce: [0xA1; AEAD_NONCE_LEN],
            enc_group_key: [0xB2; VAULT_META_WRAPPED_ITEMS_KEY_LEN],
            group_key_epoch: 1,
            signed_roster_envelope: roster_envelope(),
        }
    }

    /// The same base and tail as an `NTV7` frame, for the truncation tests.
    fn ntv7_frame() -> Vec<u8> {
        let owner = PersonKeyPair::generate_raw(
            &fixture_kem(b"ntv8-owner-kem"),
            &fixture_seed(b"ntv8-owner-ed25519"),
            &fixture_seed(b"ntv8-owner-mldsa"),
        );
        let mut rng = crate::test_vector_fmt::SeededRng::new(11);
        crate::vault_meta_ntv7::serialize_vault_meta_ntv7(
            &crate::vault_meta_ntv7::PersonWrappedVaultMeta {
                base: base_without_phrase_wrap(),
                group_key_nonce: [0xA1; AEAD_NONCE_LEN],
                enc_group_key: [0xB2; VAULT_META_WRAPPED_ITEMS_KEY_LEN],
                group_key_epoch: 1,
                signed_roster_envelope: roster_envelope(),
                person_wrap: crate::vault_meta_ntv7::seal_root_key_to_person_raw(
                    &owner.public_half(),
                    &ROOT,
                    &ITEMS_ID,
                    &mut rng,
                )
                .expect("seal root key"),
            },
        )
        .expect("serialize NTV7")
    }

    #[test]
    fn ntv8_round_trips_and_serves_the_base_fields() {
        let meta = ntv8_fixture();
        let bytes = serialize_vault_meta_ntv8(&meta).expect("serialize NTV8");
        assert_eq!(&bytes[..4], b"NTV8");
        assert_eq!(bytes[4], 0x02);
        assert_eq!(bytes[5], 0x00);
        assert_eq!(
            bytes.len(),
            NTV8_FIXED_LEN + meta.signed_roster_envelope.len()
        );
        assert_eq!(parse_vault_meta_ntv8(&bytes), Ok(meta.clone()));
        // Every singleton/index/sync reader goes through the base dispatcher, so
        // it must serve an NTV8 vault's base fields unchanged.
        assert_eq!(
            crate::vault_meta_v0_2::parse_vault_meta_any(&bytes),
            Ok(meta.base.clone())
        );
        // And the tail is reachable through the one shared opener.
        assert_eq!(
            crate::vault_meta_ntv7::parse_b2b_tail_any(&bytes),
            Ok(meta.as_ntv6_tail())
        );
        // An `NTV8` vault is a v0.2 vault, and this is the answer that decides
        // which crypto generation every singleton, index and sync reader uses
        // (myne-md/myne#938). Answering `None` here did not merely fail a
        // classification: the `ok_or(InvalidVaultMeta)` readers refused the vault
        // outright and the `unwrap_or(V0_1)` ones derived a v0.1 subkey and failed
        // the AEAD tag, so a freshly created password-only vault could not read
        // its own preferences.
        assert_eq!(
            crate::vault_meta_v0_2::meta_version_of(&bytes),
            Some(crate::types::MetaVersion::V0_2)
        );
    }

    /// The generation's central claim: the frame is the `NTV7` frame truncated,
    /// byte for byte, with only the header patched. This is what lets §10.4.2
    /// upgrade a vault without re-deriving the password wrap, so a test that
    /// fails here means an upgrade would lock a user out.
    #[test]
    fn ntv8_is_the_ntv7_frame_minus_its_person_wrap() {
        let ntv7 = ntv7_frame();
        let parsed = crate::vault_meta_ntv7::parse_vault_meta_ntv7(&ntv7).expect("parse NTV7");
        let ntv8 = serialize_vault_meta_ntv8(&PasswordOnlyVaultMeta {
            base: parsed.base,
            group_key_nonce: parsed.group_key_nonce,
            enc_group_key: parsed.enc_group_key,
            group_key_epoch: parsed.group_key_epoch,
            signed_roster_envelope: parsed.signed_roster_envelope,
        })
        .expect("serialize NTV8");

        assert_eq!(
            ntv8.len() + crate::vault_meta_ntv7::PERSON_WRAP_LEN,
            ntv7.len()
        );
        // Bytes 6..end of the short frame are the long frame's bytes 6..same,
        // untouched: the password wrap, the itemsKey wrap and the tail.
        assert_eq!(&ntv8[6..], &ntv7[6..ntv8.len()]);
        assert_eq!(&ntv8[..4], b"NTV8");
        assert_eq!(&ntv7[..4], b"NTV7");
    }

    #[test]
    fn ntv8_refuses_a_live_phrase_wrap_in_both_directions() {
        let mut meta = ntv8_fixture();
        meta.base.random_salt_recovery = [0x09; VAULT_META_SALT_RANDOM_LEN];
        assert_eq!(
            serialize_vault_meta_ntv8(&meta),
            Err(ProtocolError::InvalidVaultMeta)
        );

        // And the parser refuses a frame that carries one, so a caller that
        // hand-assembled bytes cannot smuggle a phrase door past the writer.
        let mut bytes = serialize_vault_meta_ntv8(&ntv8_fixture()).expect("serialize");
        bytes[49] = 0x09; // random_salt_recovery_16, §9.3 offset
        assert_eq!(
            parse_vault_meta_ntv8(&bytes),
            Err(ProtocolError::InvalidVaultMeta)
        );
    }

    #[test]
    fn ntv8_refuses_a_zero_epoch_and_a_bad_roster_length() {
        let mut meta = ntv8_fixture();
        meta.group_key_epoch = 0;
        assert_eq!(
            serialize_vault_meta_ntv8(&meta),
            Err(ProtocolError::InvalidVaultMeta)
        );

        let mut bytes = serialize_vault_meta_ntv8(&ntv8_fixture()).expect("serialize");
        // group_key_epoch sits at 433; zero it in place.
        bytes[433..441].copy_from_slice(&0u64.to_be_bytes());
        assert_eq!(
            parse_vault_meta_ntv8(&bytes),
            Err(ProtocolError::InvalidVaultMeta)
        );

        // A trailing byte is refused: the frame's length IS its claim.
        let mut bytes = serialize_vault_meta_ntv8(&ntv8_fixture()).expect("serialize");
        bytes.push(0x00);
        assert_eq!(
            parse_vault_meta_ntv8(&bytes),
            Err(ProtocolError::InvalidVaultMeta)
        );
    }

    /// The truncation is not something a reader may perform on its own: an
    /// `NTV7` frame handed to this parser is refused, even with the magic
    /// patched, because its person wrap is still there.
    #[test]
    fn an_ntv7_frame_is_refused_by_the_ntv8_parser() {
        let ntv7 = ntv7_frame();
        assert_eq!(
            parse_vault_meta_ntv8(&ntv7),
            Err(ProtocolError::InvalidVaultMeta)
        );

        let mut patched = ntv7.clone();
        patched[..4].copy_from_slice(&VAULT_META_NTV8_MAGIC);
        assert_eq!(
            parse_vault_meta_ntv8(&patched),
            Err(ProtocolError::InvalidVaultMeta)
        );
    }

    /// A pre-`NTV8` reader must not accept the new magic, and the two older
    /// parsers are the ones that exist today.
    #[test]
    fn older_parsers_refuse_the_ntv8_magic() {
        let bytes = serialize_vault_meta_ntv8(&ntv8_fixture()).expect("serialize");
        assert!(crate::vault_meta_ntv7::parse_vault_meta_ntv7(&bytes).is_err());
        assert!(crate::vault_meta_v0_2::parse_vault_meta_ntv6(&bytes).is_err());
        assert!(crate::vault_meta::parse_vault_meta(&bytes).is_err());

        // Length alone would refuse the test above, so the MAGIC refusal is
        // proven separately: pad the frame to exactly the length an `NTV7`
        // parser expects and it must still refuse.
        let mut padded = bytes.clone();
        padded.extend_from_slice(&[0u8; crate::vault_meta_ntv7::PERSON_WRAP_LEN]);
        assert_eq!(
            crate::vault_meta_ntv7::parse_vault_meta_ntv7(&padded),
            Err(ProtocolError::InvalidVaultMeta)
        );
        // And the frame's own parser reads that padding as the trailing bytes it
        // is, so neither side can be talked into accepting the other's shape.
        assert_eq!(
            parse_vault_meta_ntv8(&padded),
            Err(ProtocolError::InvalidVaultMeta)
        );
    }

    #[test]
    fn the_password_wrap_of_an_ntv8_frame_opens_and_a_tampered_kdf_block_does_not() {
        let bytes = serialize_vault_meta_ntv8(&ntv8_fixture()).expect("serialize");
        let parsed = parse_vault_meta_ntv8(&bytes).expect("parse");

        // The generation re-wraps nothing, so the EXISTING v0.2 password opener
        // must open this frame's wrap unchanged. If this ever fails, an `NTV7`
        // to `NTV8` upgrade would lock the user out of their own vault.
        let opened = crate::vault_meta_v0_2::unlock_root_key_v0_2_password(
            &parsed.base,
            "correct horse battery staple",
            &ACCT,
        )
        .expect("open password wrap");
        assert_eq!(&opened[..], &ROOT[..]);

        // The KDF block (§9.3 offset 22, 11 bytes) is bound into the wrap's AAD,
        // so moving one of its cost bytes moves the tag. Verified here on an
        // `NTV8` frame because that is the one that must not have changed the
        // binding; the low byte of `kdf_m_kib` keeps the derivation cheap.
        let mut tampered = bytes.clone();
        tampered[26] ^= 0x01;
        let parsed = parse_vault_meta_ntv8(&tampered).expect("the tag is not in the frame");
        assert_eq!(
            crate::vault_meta_v0_2::unlock_root_key_v0_2_password(
                &parsed.base,
                "correct horse battery staple",
                &ACCT,
            )
            .err(),
            Some(ProtocolError::AeadFailure)
        );
    }

    #[test]
    fn the_password_side_rewrite_keeps_the_tail_and_the_zeroed_phrase_fields() {
        let meta = ntv8_fixture();
        let rewritten = rewrite_vault_meta_password_side_ntv8(
            &meta,
            &ROOT,
            "a brand new master password",
            &[0x21; crate::kdf::ARGON2_SALT_LEN],
            &[0x31; AEAD_NONCE_LEN],
        )
        .expect("rewrite");

        let after = parse_vault_meta_ntv8(&rewritten).expect("parse rewritten");
        assert_eq!(after.group_key_epoch, meta.group_key_epoch);
        assert_eq!(after.enc_group_key, meta.enc_group_key);
        assert_eq!(after.group_key_nonce, meta.group_key_nonce);
        assert_eq!(after.signed_roster_envelope, meta.signed_roster_envelope);
        assert!(phrase_wrap_is_absent(&after.base));
        // Not the same password wrap: the point of a change-password.
        assert_ne!(
            after.base.enc_root_key_password,
            meta.base.enc_root_key_password
        );
    }
    /// Emit the `vault-meta-ntv8` cross-implementation vectors.
    ///
    /// ```bash
    /// cargo test -p protocol --lib emit_vault_meta_ntv8_vectors_for_paste -- --ignored
    /// # then paste /tmp/myne_vault_meta_ntv8_vectors.json over
    /// # myne-test-vectors/vectors/vault-meta-ntv8/v0.2/cases.json
    /// ```
    ///
    /// Every case is ASSERTED before it is emitted, so a broken fixture fails
    /// generation rather than being frozen into the contract.
    ///
    /// The password is part of the fixture on purpose. The frame alone cannot
    /// tell a port whether its salt domain, its AAD role or its Argon2id block
    /// layout still matches ours, and those three are exactly what an independent
    /// implementation gets wrong while parsing every field correctly. So each set
    /// carries both halves the task asks for: the expected `vault.meta` bytes AND
    /// the `root_key` those bytes open to under a fixed password, which is what
    /// makes a mismatch name which half diverged.
    #[test]
    #[ignore]
    fn emit_vault_meta_ntv8_vectors_for_paste() {
        extern crate std;
        use crate::kdf::ARGON2_SALT_LEN;
        use crate::test_vector_fmt::hex_lower;
        use crate::vault_meta::VAULT_META_SALT_RANDOM_LEN;
        use crate::vault_meta_v0_2::unlock_root_key_v0_2_password;
        use alloc::format;
        use alloc::string::String;

        const PASSWORD: &str = "correct horse battery staple";
        const WRONG_PASSWORD: &str = "correct horse battery stapler";

        let meta = ntv8_fixture();
        let blob = serialize_vault_meta_ntv8(&meta).expect("serialize NTV8");
        let roster_len = meta.signed_roster_envelope.len();
        let blob_hex = hex_lower(&blob);
        assert_eq!(blob.len(), NTV8_FIXED_LEN + roster_len);
        assert_eq!(parse_vault_meta_ntv8(&blob).as_ref(), Ok(&meta));

        // The premise the password cases rest on: this frame's base really does
        // seal ROOT under PASSWORD, so `expected_root_key_hex` is a claim about
        // the fixture rather than a constant copied next to it.
        let opened = unlock_root_key_v0_2_password(&meta.base, PASSWORD, &ACCT)
            .expect("the fixture password must open the fixture frame");
        assert_eq!(&*opened, &ROOT);
        assert_eq!(
            unlock_root_key_v0_2_password(&meta.base, WRONG_PASSWORD, &ACCT).err(),
            Some(ProtocolError::AeadFailure)
        );

        let ntv7 = ntv7_frame();
        let ntv7_roster_len = meta.signed_roster_envelope.len();
        assert_eq!(
            ntv7.len(),
            NTV8_FIXED_LEN + ntv7_roster_len + PERSON_WRAP_LEN
        );
        // The upgrade is a truncation plus a header patch, and this is the
        // premise the `upgrade` vector rests on: from the version byte to the end
        // of the roster, every surviving byte is identical, so no key is
        // re-wrapped and the same password still opens both frames.
        assert_eq!(&ntv7[..4], b"NTV7");
        assert_eq!(&blob[..4], b"NTV8");
        assert_eq!(
            &ntv7[4..NTV8_FIXED_LEN + ntv7_roster_len],
            &blob[4..],
            "the upgrade must be a truncation: every surviving byte after the magic identical"
        );

        let mut dump = String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"vault-meta-ntv8\",\n");
        dump.push_str("  \"protocol_version\": \"v0.2\",\n");
        dump.push_str(
            "  \"spec_section\": \"protocol.md §9.3.2 + §9.3.6 (NTV8) + §10.4.2 (the upgrade)\",
",
        );
        dump.push_str("  \"description\": \"Pins the NTV8 vault.meta generation: the NTV6 tail byte for byte with NO person wrap, so the master password is the only vault credential and the identity phrase opens nothing. Length is 445 + roster_len with any other length invalid, which is what makes the absence structural rather than a zeroed block a later writer could relax. Also pins the NTV7 to NTV8 upgrade, which is a truncation and re-wraps no key: the password a user already has still opens the file, and `upgrade-from-ntv7` carries that as one case (expected bytes AND the root_key they open to). `parse_fail` cases are expected to return the one non-distinguishing invalid-metadata result. Generated by `cargo test -p protocol --lib emit_vault_meta_ntv8_vectors_for_paste -- --ignored --nocapture`.\",\n");
        dump.push_str("  \"cases\": [\n");

        // 1. roundtrip: the creation set's bytes.
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"vault-meta-ntv8/v0.2/frame-roundtrip\",\n");
        dump.push_str("      \"description\": \"A full NTV8 frame as creation writes it: the 345-byte base with its three phrase-wrap fields zero and root_key sealed under the password, then the NTV6 tail (owner-wrapped group key, epoch 1, sealed roster) and nothing after the roster. parse then re-serialize must reproduce these bytes exactly, and every field must be read back at its offset.\",\n");
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
            "      \"expected_kdf_m_kib\": {},\n",
            meta.base.kdf_params.m_kib
        ));
        dump.push_str(&format!(
            "      \"expected_kdf_t\": {},\n",
            meta.base.kdf_params.t
        ));
        dump.push_str(&format!(
            "      \"expected_kdf_p\": {},\n",
            meta.base.kdf_params.p
        ));
        dump.push_str(&format!(
            "      \"expected_kdf_argon2_version\": {},\n",
            meta.base.kdf_params.argon2_version
        ));
        dump.push_str("      \"expected_phrase_wrap_zeroed\": true,\n");
        dump.push_str("      \"expected_person_wrap_absent\": true\n");
        dump.push_str("    },\n");

        // 2. password_opens: the creation set's root_key.
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"vault-meta-ntv8/v0.2/password-opens-the-frame\",\n");
        dump.push_str("      \"description\": \"The frame above, opened with its master password alone: Argon2id over the 'myne.v0.2 argon2id-password|' salt domain with the frame's own KDF parameters and account_number_hash, then AEAD-open of enc_root_key_password under the 'password-wrap' role bound to those parameters. This is the case that fails when a port's salt domain, AAD role or 11-byte KDF block drifts while it parses every field correctly.\",\n");
        dump.push_str("      \"case_kind\": \"password_opens\",\n");
        dump.push_str(&format!("      \"input_blob_hex\": \"{blob_hex}\",\n"));
        dump.push_str(&format!(
            "      \"input_password_utf8_hex\": \"{}\",\n",
            hex_lower(PASSWORD.as_bytes())
        ));
        dump.push_str(&format!(
            "      \"expected_root_key_hex\": \"{}\"\n",
            hex_lower(&ROOT)
        ));
        dump.push_str("    },\n");

        // 3. password_open_fail
        dump.push_str("    {\n");
        dump.push_str(
            "      \"vector_id\": \"vault-meta-ntv8/v0.2/password-fail-wrong-password\",\n",
        );
        dump.push_str("      \"description\": \"The same frame with a one-character-longer password. The refusal is the ONE non-distinguishing AEAD failure: a port must not report 'wrong password' in a way that distinguishes it from a tampered frame.\",\n");
        dump.push_str("      \"case_kind\": \"password_open_fail\",\n");
        dump.push_str(&format!("      \"input_blob_hex\": \"{blob_hex}\",\n"));
        dump.push_str(&format!(
            "      \"input_password_utf8_hex\": \"{}\",\n",
            hex_lower(WRONG_PASSWORD.as_bytes())
        ));
        dump.push_str("      \"expected_kind\": \"aead_fail\",\n");
        dump.push_str("      \"informational_reason\": \"a different password derives a different wrap key\"\n");
        dump.push_str("    },\n");

        // 4. upgrade: the upgrade set's expected bytes AND the root_key they open to.
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"vault-meta-ntv8/v0.2/upgrade-from-ntv7\",\n");
        dump.push_str("      \"description\": \"An NTV7 frame and what it must become on the first unlock under NTV8: the same bytes with the 1208-byte person envelope removed and the magic rewritten to NTV8. Nothing else moves, and no key is re-wrapped, which is why the SAME password opens the upgraded frame to the SAME root_key. A port that re-derives or re-wraps anything produces different bytes here, and a port that re-wraps the root key produces a frame this password no longer opens.\",\n");
        dump.push_str("      \"case_kind\": \"upgrade\",\n");
        dump.push_str(&format!(
            "      \"input_ntv7_blob_hex\": \"{}\",\n",
            hex_lower(&ntv7)
        ));
        dump.push_str(&format!("      \"expected_blob_hex\": \"{blob_hex}\",\n"));
        dump.push_str(&format!(
            "      \"expected_dropped_person_wrap_len\": {PERSON_WRAP_LEN},\n"
        ));
        dump.push_str(&format!(
            "      \"input_password_utf8_hex\": \"{}\",\n",
            hex_lower(PASSWORD.as_bytes())
        ));
        dump.push_str(&format!(
            "      \"expected_root_key_hex\": \"{}\"\n",
            hex_lower(&ROOT)
        ));
        dump.push_str("    },\n");

        // 5. parse_fail
        struct Fail {
            slug: &'static str,
            description: &'static str,
            reason: &'static str,
            /// `true` when the case's input is the REAL `NTV7` frame rather than a
            /// mutation of the `NTV8` one. Only the length rule needs it, and it
            /// needs it badly: a hand-assembled `NTV8`-magic frame with 1208 bytes
            /// glued on would be rejected on its magic, so it would pass while
            /// checking nothing. The fixture has to be a frame the `NTV7` parser
            /// accepts, or the case cannot say the length is what rejected it.
            seed_from_ntv7: bool,
            mutate: fn(&mut alloc::vec::Vec<u8>),
        }
        let fails: [Fail; 10] = [
            Fail {
                slug: "parse-fail-person-wrap-present",
                description: "A whole, valid NTV7 frame fed to an NTV8 reader: base and tail are byte-identical, so the ONLY things distinguishing the two generations are the magic and the 1208 bytes after the roster. A lenient reader would accept this and then wait for a person wrap credential the user no longer has; the length rule is what makes that impossible.",
                reason: "length is 445 + roster_len + 1208, not 445 + roster_len",
                seed_from_ntv7: true,
                mutate: |_b| {},
            },
            Fail {
                slug: "parse-fail-ntv6-magic",
                description: "The same frame with its magic relabelled NTV6. The tail is byte-identical to NTV6's, so this is the case that holds a reader to the magic rather than to the layout.",
                reason: "magic is not NTV8",
                seed_from_ntv7: false,
                mutate: |b| b[0..4].copy_from_slice(b"NTV6"),
            },
            Fail {
                slug: "parse-fail-ntv7-magic",
                description: "The same frame with its magic relabelled NTV7, which differs only in that it would demand 1208 more bytes. A reader keyed on the tail layout alone cannot tell the two apart.",
                reason: "magic is not NTV8",
                seed_from_ntv7: false,
                mutate: |b| b[0..4].copy_from_slice(b"NTV7"),
            },
            Fail {
                slug: "parse-fail-protocol-version",
                description: "protocol_version byte 0x01 instead of 0x02.",
                reason: "wrong protocol_version byte",
                seed_from_ntv7: false,
                mutate: |b| b[4] = 0x01,
            },
            Fail {
                slug: "parse-fail-reserved",
                description: "reserved byte 0x01 instead of 0x00.",
                reason: "reserved byte must be 0x00",
                seed_from_ntv7: false,
                mutate: |b| b[5] = 0x01,
            },
            Fail {
                slug: "parse-fail-live-recovery-salt",
                description: "A byte written into the recovery SALT (offset 49). NTV8 retires the phrase wrap, so a frame carrying any byte of it is structurally invalid rather than a vault whose saved phrase may or may not still work.",
                reason: "non-zero recovery salt",
                seed_from_ntv7: false,
                mutate: |b| b[49] = 0x7F,
            },
            Fail {
                slug: "parse-fail-live-recovery-nonce",
                description: "A byte written into the recovery wrap NONCE (offset 153). Same structural rule as the salt.",
                reason: "non-zero recovery nonce",
                seed_from_ntv7: false,
                mutate: |b| b[153] = 0x7F,
            },
            Fail {
                slug: "parse-fail-live-recovery-ciphertext",
                description: "A byte written into the recovery-wrapped root_key (offset 177). The third and last field the phrase wrap occupied.",
                reason: "non-zero recovery-wrapped root_key",
                seed_from_ntv7: false,
                mutate: |b| b[177] = 0x7F,
            },
            Fail {
                slug: "parse-fail-trailing-byte",
                description: "One byte appended after the roster. The frame length is fixed at 445 + roster_len, so trailing bytes are a rejection and not an extension point.",
                reason: "trailing bytes after the roster",
                seed_from_ntv7: false,
                mutate: |b| b.push(0x00),
            },
            Fail {
                slug: "parse-fail-zero-epoch",
                description: "group_key_epoch forced to 0 (bytes 433..441). An epoch of zero is not a valid group-key generation in any NTV6-derived frame.",
                reason: "group_key_epoch == 0",
                seed_from_ntv7: false,
                mutate: |b| b[433..441].copy_from_slice(&0u64.to_be_bytes()),
            },
        ];
        let _ = (ARGON2_SALT_LEN, VAULT_META_SALT_RANDOM_LEN);
        for f in fails.iter() {
            let mut bytes = if f.seed_from_ntv7 {
                ntv7.clone()
            } else {
                blob.clone()
            };
            (f.mutate)(&mut bytes);
            assert!(
                parse_vault_meta_ntv8(&bytes).is_err(),
                "[{}] the fixture must be rejected before it is emitted",
                f.slug
            );
            dump.push_str("    {\n");
            dump.push_str(&format!(
                "      \"vector_id\": \"vault-meta-ntv8/v0.2/{}\",\n",
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

        assert!(dump.ends_with(",\n"));
        dump.truncate(dump.len() - 2);
        dump.push('\n');
        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_vault_meta_ntv8_vectors.json", dump.as_bytes())
            .expect("write vault-meta-ntv8 vectors dump");
        std::println!("{dump}");
    }
}
