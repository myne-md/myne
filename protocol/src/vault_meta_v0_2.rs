// SPDX-License-Identifier: AGPL-3.0
//! v0.2 `vault.meta` codecs: migration-only `NTV5` and B2B `NTV6`.
//! `NTV5` carries the whole-vault-migration key hierarchy
//! (`docs/spec/protocol.md` §10.4.1, automerge-sync-migration #420); `NTV6`
//! adds the mandatory group-key package, epoch and signed roster envelope.
//!
//! Byte-identical **layout** to the v0.1 `MYV1` `vault.meta` (§9.3, 345 bytes):
//! `magic · version · reserved · account_number_hash · kdf_params ·
//! salt_password · salt_recovery · nonce_password · enc_root_key_password ·
//! nonce_recovery · enc_root_key_recovery · items_key_id · items_key_nonce ·
//! enc_items_key`. It differs from `MYV1` in exactly the three ways that
//! domain-separate v0.2 from v0.1 (§10.5), the same shape as the `NC05` note
//! (§10.7):
//!
//! 1. the 4-byte magic is [`VAULT_META_V0_2_MAGIC`] (`b"NTV5"`), not `b"MYV1"`;
//! 2. the `protocol_version` byte is [`VAULT_META_V0_2_PROTOCOL_VERSION`]
//!    (`0x02`);
//! 3. the wrap keys and their AADs are v0.2: `root_key` is wrapped under
//!    `derive_password_wrap_key_v0_2` / `derive_recovery_wrap_key_..._v0_2`
//!    (v0.2 salt domains) with `aad_password_wrap_v0_2` / `aad_recovery_wrap_v0_2`,
//!    and `itemsKey` under `derive_subkey_v0_2(root_key, ItemsKeyWrap)` with
//!    `aad_vault_items_key_wrap_v0_2`.
//!
//! This is the target the §10.4.1 migration writes: a fresh v0.2 `root_key`
//! (random, minted by the migration), wrapped under **both** credentials (the
//! phrase-required rule), plus a fresh v0.2 `itemsKey`. A v0.1 client refuses an
//! `NTV5` `vault.meta` (§10.5) — the fleet anti-downgrade gate.
//!
//! `_raw` takes all randomness from the caller (migration-supplied) per the
//! crate's `_raw` convention; the `getrandom` convenience wrapper is
//! [`encode_vault_meta_v0_2`].

use crate::aead::{
    aad_membership_blob, aad_membership_roster_blob, aad_password_wrap_v0_2,
    aad_recovery_wrap_v0_2, aad_vault_items_key_wrap_v0_2, aead_open_ctx, aead_seal_ctx,
    AEAD_KEY_LEN, AEAD_NONCE_LEN,
};
use crate::error::ProtocolError;
use crate::kdf::{
    derive_password_wrap_key_v0_2, derive_recovery_wrap_key_from_normalized_v0_2, ARGON2_SALT_LEN,
};
use crate::subkey::{derive_subkey_v0_2, SubkeyRole};
use crate::types::{KdfParams, MetaVersion};
use crate::vault_meta::{
    parse_vault_meta, serialize_vault_meta, Membership, MembershipRoster, VaultMeta,
    MEMBERSHIP_ACCOUNT_ID_LEN, MEMBERSHIP_CIPHERTEXT_LEN, MEMBERSHIP_FIELD_LEN,
    MEMBERSHIP_ROSTER_CT_CAP, MEMBERSHIP_ROSTER_NONCE_LEN, VAULT_META_ITEMS_KEY_ID_LEN,
    VAULT_META_LEN, VAULT_META_MAGIC, VAULT_META_PROTOCOL_VERSION,
    VAULT_META_V0_2_WITH_MEMBERSHIP_LEN, VAULT_META_WRAPPED_ITEMS_KEY_LEN,
    VAULT_META_WRAPPED_ROOT_KEY_LEN,
};
use alloc::vec::Vec;
use zeroize::Zeroizing;

/// `NTV5` magic (offset 0) — the v0.2 `vault.meta` family (`protocol.md` §10.3
/// registry). "Myne Next-major vault v5" placeholder, finalized for v0.2 by #420.
pub const VAULT_META_V0_2_MAGIC: [u8; 4] = *b"NTV5";

/// `protocol_version` byte (offset 4) for the v0.2 `vault.meta` — `0x02`.
pub const VAULT_META_V0_2_PROTOCOL_VERSION: u8 = 0x02;

/// `NTV6` magic for the B2B vault metadata frame.
pub const VAULT_META_NTV6_MAGIC: [u8; 4] = *b"NTV6";

/// The B2B frame retains v0.2's content protocol generation.
pub const VAULT_META_NTV6_PROTOCOL_VERSION: u8 = 0x02;

/// A parsed `NTV6` metadata frame. All B2B fields are mandatory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct B2bVaultMeta {
    pub base: VaultMeta,
    pub group_key_nonce: [u8; AEAD_NONCE_LEN],
    pub enc_group_key: [u8; VAULT_META_WRAPPED_ITEMS_KEY_LEN],
    pub group_key_epoch: u64,
    pub signed_roster_envelope: Vec<u8>,
}

const B2B_ROSTER_ENVELOPE_CAP: usize = MEMBERSHIP_ROSTER_CT_CAP;
const B2B_META_FIXED_LEN: usize =
    VAULT_META_LEN + AEAD_NONCE_LEN + VAULT_META_WRAPPED_ITEMS_KEY_LEN + 8 + 4;

/// Serialize an `NTV6` B2B metadata frame. The caller supplies a previously
/// authenticated owner-wrapped group key and signed roster envelope; their
/// cryptographic construction belongs to the owner and roster codecs.
pub fn serialize_vault_meta_ntv6(meta: &B2bVaultMeta) -> Result<Vec<u8>, ProtocolError> {
    if meta.base.membership.is_some()
        || meta.group_key_epoch == 0
        || meta.signed_roster_envelope.len() < crate::person_invite::SEALED_GROUP_ROSTER_MIN_LEN
        || meta.signed_roster_envelope.len() > B2B_ROSTER_ENVELOPE_CAP
    {
        return Err(ProtocolError::InvalidVaultMeta);
    }
    let mut out = serialize_vault_meta(&meta.base).to_vec();
    out[0..4].copy_from_slice(&VAULT_META_NTV6_MAGIC);
    out[4] = VAULT_META_NTV6_PROTOCOL_VERSION;
    out[5] = 0x00;
    out.extend_from_slice(&meta.group_key_nonce);
    out.extend_from_slice(&meta.enc_group_key);
    out.extend_from_slice(&meta.group_key_epoch.to_be_bytes());
    out.extend_from_slice(&(meta.signed_roster_envelope.len() as u32).to_be_bytes());
    out.extend_from_slice(&meta.signed_roster_envelope);
    Ok(out)
}

/// Rewrite an `NTV6` `vault.meta`'s password side (fresh salt + nonce), carrying
/// the B2B tail (owner-wrapped group key, epoch, sealed roster) byte-identical.
///
/// The v0.2 rewrite returns `NTV5` bytes for the base; re-serializing those as
/// `NTV5` would DROP the tail and lock the vault out, so this re-frames the
/// rewritten base as `NTV6` with the original tail. Used by recovery and
/// change-password on a migrated vault.
pub fn rewrite_vault_meta_password_side_ntv6(
    existing: &B2bVaultMeta,
    root_key: &[u8; AEAD_KEY_LEN],
    new_password: &str,
    fresh_salt: &[u8; ARGON2_SALT_LEN],
    fresh_nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, ProtocolError> {
    let rewritten_base = rewrite_vault_meta_password_side_v0_2(
        &existing.base,
        root_key,
        new_password,
        fresh_salt,
        fresh_nonce,
    )?;
    let base = parse_vault_meta_v0_2(&rewritten_base)?;
    serialize_vault_meta_ntv6(&B2bVaultMeta {
        base,
        group_key_nonce: existing.group_key_nonce,
        enc_group_key: existing.enc_group_key,
        group_key_epoch: existing.group_key_epoch,
        signed_roster_envelope: existing.signed_roster_envelope.clone(),
    })
}

/// Parse a strict `NTV6` B2B metadata frame without opening its encrypted
/// group-key package or roster envelope.
pub fn parse_vault_meta_ntv6(bytes: &[u8]) -> Result<B2bVaultMeta, ProtocolError> {
    if bytes.len() < B2B_META_FIXED_LEN
        || bytes.get(0..4) != Some(VAULT_META_NTV6_MAGIC.as_slice())
        || bytes[4] != VAULT_META_NTV6_PROTOCOL_VERSION
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
    if !(crate::person_invite::SEALED_GROUP_ROSTER_MIN_LEN..=B2B_ROSTER_ENVELOPE_CAP)
        .contains(&roster_len)
        || bytes.len() != B2B_META_FIXED_LEN + roster_len
    {
        return Err(ProtocolError::InvalidVaultMeta);
    }
    let mut as_v0_1 = [0u8; VAULT_META_LEN];
    as_v0_1.copy_from_slice(&bytes[..VAULT_META_LEN]);
    as_v0_1[0..4].copy_from_slice(&VAULT_META_MAGIC);
    as_v0_1[4] = VAULT_META_PROTOCOL_VERSION;
    let base = parse_vault_meta(&as_v0_1)?;
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
    Ok(B2bVaultMeta {
        base,
        group_key_nonce,
        enc_group_key,
        group_key_epoch,
        signed_roster_envelope: bytes[B2B_META_FIXED_LEN..].to_vec(),
    })
}

/// Serialize a [`VaultMeta`] as an `NTV5` (v0.2) blob — byte-identical to the
/// `MYV1` layout (§9.3) with the `NTV5` magic + `0x02` version. The field bytes
/// are produced by the shared [`serialize_vault_meta`], so a v0.1/v0.2 layout
/// drift is impossible by construction.
///
/// When `meta.membership` is `Some`, the sealed membership field (§9.3.1) is
/// appended after the base 345-byte layout and the `reserved` byte at offset 5
/// is set to `0x01`, producing a 417-byte blob. When it is `None`, the blob is
/// the base 345 bytes with `reserved` `0x00` (an unmigrated vault). The return
/// type is `Vec<u8>` because the field is optional and the length varies.
pub fn serialize_vault_meta_v0_2(meta: &VaultMeta) -> Vec<u8> {
    let mut out = serialize_vault_meta(meta).to_vec();
    out[0..4].copy_from_slice(&VAULT_META_V0_2_MAGIC);
    out[4] = VAULT_META_V0_2_PROTOCOL_VERSION;
    if let Some(membership) = &meta.membership {
        match &membership.roster {
            None => {
                // The 0580 single-account shape: reserved 0x01, 417 bytes.
                out[5] = 0x01;
                out.extend_from_slice(&membership.nonce);
                out.extend_from_slice(&membership.enc);
            }
            Some(roster) => {
                // The B2B shape (b2b-identity-substrate task 3): reserved
                // 0x02, then the single-account field, then the roster
                // envelope (nonce + capped ciphertext).
                out[5] = 0x02;
                out.extend_from_slice(&membership.nonce);
                out.extend_from_slice(&membership.enc);
                out.extend_from_slice(&roster.nonce);
                out.extend_from_slice(&(roster.enc.len() as u32).to_be_bytes());
                out.extend_from_slice(&roster.enc);
            }
        }
    }
    out
}

/// Parse an `NTV5` slice into a [`VaultMeta`]. Accepts both the base 345-byte
/// layout (no membership field, `reserved` `0x00`) and the 417-byte layout with
/// the membership field (`reserved` `0x01`). Rejects a wrong length, non-`NTV5`
/// magic, non-`0x02` version, or a `reserved` byte other than `0x00`/`0x01` with
/// [`ProtocolError::InvalidVaultMeta`].
///
/// After validating the magic + version, it delegates the field extraction to the
/// shared [`parse_vault_meta`] by presenting the identical trailing bytes under
/// the v0.1 magic/version — `NTV5` and `MYV1` differ ONLY in bytes `[0..5]`, and
/// no extracted field lives there — so the two parsers can never disagree about
/// what a byte at any later offset means. The membership field (when present) is
/// read from the trailing 72 bytes and carried as `membership: Some(..)`; it is
/// NOT AEAD-opened here (that needs `root_key`, which the parser does not hold).
pub fn parse_vault_meta_v0_2(bytes: &[u8]) -> Result<VaultMeta, ProtocolError> {
    if bytes.len() != VAULT_META_LEN && bytes.len() < VAULT_META_V0_2_WITH_MEMBERSHIP_LEN {
        return Err(ProtocolError::InvalidVaultMeta);
    }
    if bytes[0..4] != VAULT_META_V0_2_MAGIC {
        return Err(ProtocolError::InvalidVaultMeta);
    }
    if bytes[4] != VAULT_META_V0_2_PROTOCOL_VERSION {
        return Err(ProtocolError::InvalidVaultMeta);
    }
    let reserved = bytes[5];
    if reserved > 0x02 {
        return Err(ProtocolError::InvalidVaultMeta);
    }
    let has_membership = reserved >= 0x01;
    let has_roster = reserved == 0x02;
    if has_membership && bytes.len() < VAULT_META_V0_2_WITH_MEMBERSHIP_LEN {
        return Err(ProtocolError::InvalidVaultMeta);
    }
    if !has_membership && bytes.len() != VAULT_META_LEN {
        return Err(ProtocolError::InvalidVaultMeta);
    }

    // Roster envelope (reserved 0x02 only): 24-byte nonce + u32 BE ciphertext
    // length + ciphertext, directly after the single-account field.
    let roster = if has_roster {
        let base = VAULT_META_V0_2_WITH_MEMBERSHIP_LEN;
        // Envelope order (the serializer's): roster nonce (24) || u32 BE ct
        // length || ciphertext. The length field sits AFTER the nonce.
        let nonce_start = base;
        let len_start = base + MEMBERSHIP_ROSTER_NONCE_LEN;
        if bytes.len() < len_start + 4 {
            return Err(ProtocolError::InvalidVaultMeta);
        }
        let ct_len = u32::from_be_bytes([
            bytes[len_start],
            bytes[len_start + 1],
            bytes[len_start + 2],
            bytes[len_start + 3],
        ]) as usize;
        if ct_len == 0 || ct_len > MEMBERSHIP_ROSTER_CT_CAP {
            return Err(ProtocolError::InvalidVaultMeta);
        }
        let ct_start = len_start + 4;
        let expected = ct_start + ct_len;
        if bytes.len() != expected {
            return Err(ProtocolError::InvalidVaultMeta);
        }
        let mut roster_nonce = [0u8; MEMBERSHIP_ROSTER_NONCE_LEN];
        roster_nonce
            .copy_from_slice(&bytes[nonce_start..nonce_start + MEMBERSHIP_ROSTER_NONCE_LEN]);
        let mut enc = alloc::vec::Vec::with_capacity(ct_len);
        enc.extend_from_slice(&bytes[ct_start..expected]);
        Some(MembershipRoster {
            nonce: roster_nonce,
            enc,
        })
    } else {
        if has_membership && bytes.len() != VAULT_META_V0_2_WITH_MEMBERSHIP_LEN {
            return Err(ProtocolError::InvalidVaultMeta);
        }
        None
    };

    let mut as_v0_1 = [0u8; VAULT_META_LEN];
    as_v0_1.copy_from_slice(&bytes[..VAULT_META_LEN]);
    as_v0_1[0..4].copy_from_slice(&VAULT_META_MAGIC);
    as_v0_1[4] = VAULT_META_PROTOCOL_VERSION;
    as_v0_1[5] = 0x00;
    let mut meta = parse_vault_meta(&as_v0_1)?;

    if has_membership {
        let mut nonce = [0u8; AEAD_NONCE_LEN];
        nonce.copy_from_slice(&bytes[VAULT_META_LEN..VAULT_META_LEN + AEAD_NONCE_LEN]);
        let mut enc = [0u8; MEMBERSHIP_CIPHERTEXT_LEN];
        enc.copy_from_slice(
            &bytes[VAULT_META_LEN + AEAD_NONCE_LEN..VAULT_META_LEN + MEMBERSHIP_FIELD_LEN],
        );
        meta.membership = Some(Membership { nonce, enc, roster });
    }

    Ok(meta)
}

/// Classify a `vault.meta` blob by its magic — `MYV1` → [`MetaVersion::V0_1`],
/// `NTV5` → [`MetaVersion::V0_2`], anything else → `None`. Every version-aware
/// reader uses this to pick its crypto generation from the vault it just read.
pub fn meta_version_of(bytes: &[u8]) -> Option<MetaVersion> {
    match bytes.get(0..4) {
        Some(m) if m == VAULT_META_MAGIC.as_slice() => Some(MetaVersion::V0_1),
        Some(m) if m == VAULT_META_V0_2_MAGIC.as_slice() => Some(MetaVersion::V0_2),
        Some(m) if m == VAULT_META_NTV6_MAGIC.as_slice() => Some(MetaVersion::V0_2),
        _ => None,
    }
}

/// Parse a `vault.meta` of ANY generation into its base [`VaultMeta`],
/// dispatching on the magic: `NTV5` → [`parse_vault_meta_v0_2`], `NTV6` → the
/// v0.2 base prefix of the B2B frame, otherwise the v0.1 [`parse_vault_meta`].
/// The extracted fields (`account_number_hash`, `kdf_params`, `items_key_id`,
/// the wrapped keys) live at identical offsets in every layout, so a caller that
/// only needs those fields is version-agnostic — which is exactly what lets
/// every singleton/index/sync reader keep working on a migrated vault without a
/// bespoke branch.
///
/// An `NTV6` frame is the v0.2 base (345 bytes) plus a B2B tail, so this parses
/// the base prefix and ignores the tail; the NTV6-specific fields (owner-wrapped
/// group key, epoch, signed roster) go through [`parse_vault_meta_ntv6`]. This
/// is a READ of the base only: it never treats the tail as a base field.
pub fn parse_vault_meta_any(bytes: &[u8]) -> Result<VaultMeta, ProtocolError> {
    match bytes.get(0..4) {
        Some(m) if m == VAULT_META_V0_2_MAGIC.as_slice() => parse_vault_meta_v0_2(bytes),
        Some(m) if m == VAULT_META_MAGIC.as_slice() => parse_vault_meta(bytes),
        Some(m) if m == VAULT_META_NTV6_MAGIC.as_slice() => {
            // The frame's base prefix carries the NTV6 magic, so patch the
            // header back to the shared base layout before parsing — exactly as
            // `parse_vault_meta_ntv6` does. The base FIELDS are byte-identical
            // across every generation; only the header differs.
            let mut base = [0u8; VAULT_META_LEN];
            base.copy_from_slice(
                bytes
                    .get(..VAULT_META_LEN)
                    .ok_or(ProtocolError::InvalidVaultMeta)?,
            );
            base[0..4].copy_from_slice(&VAULT_META_MAGIC);
            base[4] = VAULT_META_PROTOCOL_VERSION;
            parse_vault_meta(&base)
        }
        _ => Err(ProtocolError::InvalidVaultMeta),
    }
}

/// Build an `NTV5` `vault.meta` from caller-supplied randomness (`_raw`: the
/// migration MUST source every salt/nonce and the new `root_key`/`items_key` from
/// a CSPRNG). Wraps `root_key` under both the v0.2 password and recovery wrap
/// keys, and `items_key` under `derive_subkey_v0_2(root_key, ItemsKeyWrap)`.
///
/// `phrase_normalized` is the §7.4-normalized recovery phrase (the migration
/// requires it, §10.4.1). `kdf_params` carry over from the vault being migrated
/// (a re-parameterisation at migration is out of scope, mirroring §4.2). Errors:
/// [`ProtocolError::KdfFailure`] / [`ProtocolError::AeadFailure`].
#[allow(clippy::too_many_arguments)]
pub fn encode_vault_meta_v0_2_raw(
    root_key: &[u8; AEAD_KEY_LEN],
    items_key: &[u8; AEAD_KEY_LEN],
    items_key_id: &[u8; VAULT_META_ITEMS_KEY_ID_LEN],
    password: &str,
    phrase_normalized: &str,
    account_number_hash: &[u8; 16],
    kdf_params: &KdfParams,
    salt_password: &[u8; ARGON2_SALT_LEN],
    salt_recovery: &[u8; ARGON2_SALT_LEN],
    nonce_password: &[u8; AEAD_NONCE_LEN],
    nonce_recovery: &[u8; AEAD_NONCE_LEN],
    items_key_nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<[u8; VAULT_META_LEN], ProtocolError> {
    // (1) Wrap root_key under the v0.2 password wrap key.
    let pw_key =
        derive_password_wrap_key_v0_2(password, salt_password, account_number_hash, kdf_params)?;
    let enc_pw = aead_seal_ctx(
        &pw_key,
        nonce_password,
        root_key,
        &aad_password_wrap_v0_2(kdf_params),
    )?;
    debug_assert_eq!(enc_pw.len(), VAULT_META_WRAPPED_ROOT_KEY_LEN);
    let mut enc_root_key_password = [0u8; VAULT_META_WRAPPED_ROOT_KEY_LEN];
    enc_root_key_password.copy_from_slice(&enc_pw);

    // (2) Wrap root_key under the v0.2 recovery wrap key (phrase REQUIRED).
    let rec_key = derive_recovery_wrap_key_from_normalized_v0_2(
        phrase_normalized,
        salt_recovery,
        account_number_hash,
        kdf_params,
    )?;
    let enc_rec = aead_seal_ctx(
        &rec_key,
        nonce_recovery,
        root_key,
        &aad_recovery_wrap_v0_2(kdf_params),
    )?;
    let mut enc_root_key_recovery = [0u8; VAULT_META_WRAPPED_ROOT_KEY_LEN];
    enc_root_key_recovery.copy_from_slice(&enc_rec);

    // (3) Wrap items_key under derive_subkey_v0_2(root_key, ItemsKeyWrap).
    let items_wrap_key = derive_subkey_v0_2(root_key, SubkeyRole::ItemsKeyWrap);
    let enc_items = aead_seal_ctx(
        &items_wrap_key,
        items_key_nonce,
        items_key,
        &aad_vault_items_key_wrap_v0_2(items_key_id),
    )?;
    let mut enc_items_key = [0u8; VAULT_META_WRAPPED_ITEMS_KEY_LEN];
    enc_items_key.copy_from_slice(&enc_items);

    let meta = VaultMeta {
        account_number_hash: *account_number_hash,
        kdf_params: *kdf_params,
        random_salt_password: *salt_password,
        random_salt_recovery: *salt_recovery,
        nonce_password_wrap: *nonce_password,
        enc_root_key_password,
        nonce_recovery_wrap: *nonce_recovery,
        enc_root_key_recovery,
        items_key_id: *items_key_id,
        items_key_nonce: *items_key_nonce,
        enc_items_key,
        membership: None,
    };
    let out = serialize_vault_meta_v0_2(&meta);
    debug_assert_eq!(out.len(), VAULT_META_LEN);
    let mut arr = [0u8; VAULT_META_LEN];
    arr.copy_from_slice(&out);
    Ok(arr)
}

/// Unwrap the v0.2 `root_key` from an `NTV5` `vault.meta` under the **password**
/// (the v0.2 unlock-by-password path). Non-distinguishing AEAD failure
/// ([`ProtocolError::AeadFailure`]) on a wrong password / tampered blob (§6.4).
pub fn unlock_root_key_v0_2_password(
    meta: &VaultMeta,
    password: &str,
    account_number_hash: &[u8; 16],
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, ProtocolError> {
    let pw_key = derive_password_wrap_key_v0_2(
        password,
        &meta.random_salt_password,
        account_number_hash,
        &meta.kdf_params,
    )?;
    let pt = aead_open_ctx(
        &pw_key,
        &meta.nonce_password_wrap,
        &meta.enc_root_key_password,
        &aad_password_wrap_v0_2(&meta.kdf_params),
    )?;
    to_key(pt)
}

/// Unwrap the v0.2 `root_key` from an `NTV5` `vault.meta` under the **recovery
/// phrase** (`phrase_normalized`, §7.4). Same non-distinguishing failure as the
/// password path — this is the wrap the phrase-required migration rule protects,
/// so it MUST open (otherwise recovery was stranded).
pub fn unlock_root_key_v0_2_recovery(
    meta: &VaultMeta,
    phrase_normalized: &str,
    account_number_hash: &[u8; 16],
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, ProtocolError> {
    let rec_key = derive_recovery_wrap_key_from_normalized_v0_2(
        phrase_normalized,
        &meta.random_salt_recovery,
        account_number_hash,
        &meta.kdf_params,
    )?;
    let pt = aead_open_ctx(
        &rec_key,
        &meta.nonce_recovery_wrap,
        &meta.enc_root_key_recovery,
        &aad_recovery_wrap_v0_2(&meta.kdf_params),
    )?;
    to_key(pt)
}

/// Unwrap the current B2B `group_key` with the owner's root-tier key.
pub fn unlock_group_key_ntv6(
    meta: &B2bVaultMeta,
    owner_key: &crate::subkey::OwnerKey,
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, ProtocolError> {
    let wrap_key =
        crate::subkey::derive_owner_subkey_v0_2(owner_key, crate::subkey::OwnerRole::GroupKeyWrap);
    let plaintext = aead_open_ctx(
        &wrap_key,
        &meta.group_key_nonce,
        &meta.enc_group_key,
        &crate::aead::aad_vault_group_key_wrap_v0_2(
            &meta.base.account_number_hash,
            meta.group_key_epoch,
        ),
    )?;
    to_key(plaintext)
}

/// Unwrap `itemsKey` through the B2B group tier.
pub fn unlock_items_key_ntv6(
    meta: &B2bVaultMeta,
    group_key: &crate::subkey::GroupKey,
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, ProtocolError> {
    let wrap_key =
        crate::subkey::derive_group_subkey_v0_2(group_key, crate::subkey::GroupRole::ItemsKeyWrap);
    let plaintext = aead_open_ctx(
        &wrap_key,
        &meta.base.items_key_nonce,
        &meta.base.enc_items_key,
        &aad_vault_items_key_wrap_v0_2(&meta.base.items_key_id),
    )?;
    to_key(plaintext)
}

/// Re-wrap `root_key` under a NEW v0.2 password wrap (fresh salt + nonce),
/// carrying the recovery + `itemsKey` sections byte-identical — the `NTV5` analog
/// of [`crate::vault_meta::rewrite_vault_meta_password_side`]. A migrated vault's
/// password change stays fully v0.2 (v0.2 salt domain + AAD prefix + `NTV5`
/// framing). The KDF params carry over from `existing`.
pub fn rewrite_vault_meta_password_side_v0_2(
    existing: &VaultMeta,
    root_key: &[u8; AEAD_KEY_LEN],
    new_password: &str,
    fresh_salt: &[u8; ARGON2_SALT_LEN],
    fresh_nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, ProtocolError> {
    let kdf_params = existing.kdf_params;
    let password_wrap_key = derive_password_wrap_key_v0_2(
        new_password,
        fresh_salt,
        &existing.account_number_hash,
        &kdf_params,
    )?;
    let aad = aad_password_wrap_v0_2(&kdf_params);
    let sealed = aead_seal_ctx(&password_wrap_key, fresh_nonce, root_key, &aad)?;
    debug_assert_eq!(sealed.len(), VAULT_META_WRAPPED_ROOT_KEY_LEN);
    let mut enc_root_key_password = [0u8; VAULT_META_WRAPPED_ROOT_KEY_LEN];
    enc_root_key_password.copy_from_slice(&sealed);

    let new_meta = VaultMeta {
        account_number_hash: existing.account_number_hash,
        kdf_params,
        random_salt_password: *fresh_salt,
        random_salt_recovery: existing.random_salt_recovery,
        nonce_password_wrap: *fresh_nonce,
        enc_root_key_password,
        nonce_recovery_wrap: existing.nonce_recovery_wrap,
        enc_root_key_recovery: existing.enc_root_key_recovery,
        items_key_id: existing.items_key_id,
        items_key_nonce: existing.items_key_nonce,
        enc_items_key: existing.enc_items_key,
        membership: existing.membership.clone(),
    };
    Ok(serialize_vault_meta_v0_2(&new_meta))
}

/// Generation dispatcher for the password-side rewrite — the mirror of
/// [`crate::derive_subkey_versioned`] one layer up, so a caller (change-password,
/// recover) threads a single [`MetaVersion`] instead of hand-branching a
/// `MYV1`-vs-`NTV5` bool at the call site. Both arms are byte-preserving on the
/// recovery + itemsKey sections; only the salt domain, AAD prefix and meta
/// framing differ by generation.
pub fn rewrite_vault_meta_password_side_versioned(
    version: MetaVersion,
    existing: &VaultMeta,
    root_key: &[u8; AEAD_KEY_LEN],
    new_password: &str,
    fresh_salt: &[u8; ARGON2_SALT_LEN],
    fresh_nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, ProtocolError> {
    match version {
        MetaVersion::V0_1 => crate::vault_meta::rewrite_vault_meta_password_side(
            existing,
            root_key,
            new_password,
            fresh_salt,
            fresh_nonce,
        )
        .map(|arr| arr.to_vec()),
        MetaVersion::V0_2 => rewrite_vault_meta_password_side_v0_2(
            existing,
            root_key,
            new_password,
            fresh_salt,
            fresh_nonce,
        ),
    }
}

/// Re-derive the v0.2 singleton `itemsKey` from `root_key` + a parsed `NTV5`
/// [`VaultMeta`] — the v0.2 mirror of [`crate::vault_meta::derive_items_key`],
/// under `derive_subkey_v0_2` + the v0.2 items-key-wrap AAD.
pub fn derive_items_key_v0_2(
    root_key: &[u8; AEAD_KEY_LEN],
    meta: &VaultMeta,
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, ProtocolError> {
    let items_wrap_key = derive_subkey_v0_2(root_key, SubkeyRole::ItemsKeyWrap);
    let pt = aead_open_ctx(
        &items_wrap_key,
        &meta.items_key_nonce,
        &meta.enc_items_key,
        &aad_vault_items_key_wrap_v0_2(&meta.items_key_id),
    )?;
    to_key(pt)
}

/// Serialize a [`VaultMeta`] in the generation named by `version` —
/// [`crate::vault_meta::serialize_vault_meta`] (`MYV1`) for
/// [`MetaVersion::V0_1`], [`serialize_vault_meta_v0_2`] (`NTV5`) for
/// [`MetaVersion::V0_2`].
///
/// For the sites that re-serialize a meta they just parsed. `VaultMeta` carries
/// no generation, so the naked `serialize_vault_meta` re-stamps `MYV1` over
/// whatever it was handed — and on a v0.2 record that produces a blob claiming
/// v0.1 over v0.2 wrap bytes, which no credential opens and which strands every
/// `NC05` note behind an unreachable `itemsKey`.
pub fn serialize_vault_meta_versioned(version: MetaVersion, meta: &VaultMeta) -> Vec<u8> {
    match version {
        MetaVersion::V0_1 => crate::vault_meta::serialize_vault_meta(meta).to_vec(),
        MetaVersion::V0_2 => serialize_vault_meta_v0_2(meta),
    }
}

/// Re-derive the singleton `itemsKey` under the generation named by `version` —
/// [`crate::vault_meta::derive_items_key`] for [`MetaVersion::V0_1`],
/// [`derive_items_key_v0_2`] for [`MetaVersion::V0_2`].
///
/// **Every post-`root_key` unlock path should call THIS, not either twin.** A
/// parsed [`VaultMeta`] carries no generation of its own — the magic is consumed
/// by the parser and never reaches the struct — so a call site holding only a
/// `VaultMeta` has nothing to remind it that `derive_items_key` pins v0.1. That
/// is not hypothetical: quick-unlock called the v0.1 twin directly, and a
/// PIN/biometric unlock of a migrated vault failed on every attempt while the
/// password path beside it branched correctly (`meta_version_of` on the bytes
/// the reader already holds is where `version` comes from).
pub fn derive_items_key_versioned(
    version: MetaVersion,
    root_key: &[u8; AEAD_KEY_LEN],
    meta: &VaultMeta,
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, ProtocolError> {
    match version {
        MetaVersion::V0_1 => crate::vault_meta::derive_items_key(root_key, meta),
        MetaVersion::V0_2 => derive_items_key_v0_2(root_key, meta),
    }
}

/// Coerce a decrypted-key `Zeroizing<Vec<u8>>` to a fixed 32-byte key, rejecting
/// a wrong length (a structurally-invalid unwrap) as [`ProtocolError::AeadFailure`].
fn to_key(
    pt: Zeroizing<alloc::vec::Vec<u8>>,
) -> Result<Zeroizing<[u8; AEAD_KEY_LEN]>, ProtocolError> {
    if pt.len() != AEAD_KEY_LEN {
        return Err(ProtocolError::AeadFailure);
    }
    let mut k = Zeroizing::new([0u8; AEAD_KEY_LEN]);
    k.copy_from_slice(&pt);
    Ok(k)
}

/// Seal the account id into a [`Membership`] field (`vault.meta` §9.3.1), under
/// `membership_key = derive_subkey_v0_2(root_key, MembershipKey)` with the
/// `aad_membership_blob` AAD. `_raw`: the caller supplies the nonce (CSPRNG).
///
/// The account id is a 16-byte UUIDv7. The seal is `NTV5`-only, so the KEK and
/// AAD are both v0.2. Returns the sealed field; the caller attaches it to a
/// [`VaultMeta`] and serializes with [`serialize_vault_meta_v0_2`].
pub fn seal_membership_raw(
    root_key: &[u8; AEAD_KEY_LEN],
    account_id: &[u8; MEMBERSHIP_ACCOUNT_ID_LEN],
    account_number_hash: &[u8; 16],
    nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Membership, ProtocolError> {
    let membership_key = derive_subkey_v0_2(root_key, SubkeyRole::MembershipKey);
    let aad = aad_membership_blob(account_number_hash);
    let sealed = aead_seal_ctx(&membership_key, nonce, account_id, &aad)?;
    debug_assert_eq!(sealed.len(), MEMBERSHIP_CIPHERTEXT_LEN);
    let mut enc = [0u8; MEMBERSHIP_CIPHERTEXT_LEN];
    enc.copy_from_slice(&sealed);
    Ok(Membership {
        nonce: *nonce,
        enc,
        roster: None,
    })
}

/// Seal a B2B roster envelope (b2b-identity-substrate, myne-md/myne#698 task
/// 3) under the SAME `membership_key` as the single-account field, with the
/// roster AAD role (`aad_membership_roster_blob`): the vault binding comes
/// from the same `account_number_hash`, so a roster from another vault
/// fails AEAD. `plaintext` is the ENGINE-OPAQUE roster bytes (the merge
/// layer's canonical encoding); the cap is enforced here so the write path
/// and the parser agree on [`MEMBERSHIP_ROSTER_CT_CAP`].
///
/// Returns [`ProtocolError::AeadFailure`] when the sealed plaintext would
/// exceed the cap (write-side refusal; read-side the parser rejects the
/// length before decrypting).
pub fn seal_membership_roster_raw(
    root_key: &[u8; AEAD_KEY_LEN],
    plaintext: &[u8],
    account_number_hash: &[u8; 16],
    nonce: &[u8; MEMBERSHIP_ROSTER_NONCE_LEN],
) -> Result<MembershipRoster, ProtocolError> {
    if plaintext.is_empty() || plaintext.len() + 32 > MEMBERSHIP_ROSTER_CT_CAP {
        return Err(ProtocolError::InvalidVaultMeta);
    }
    let membership_key = derive_subkey_v0_2(root_key, SubkeyRole::MembershipKey);
    let aad = aad_membership_roster_blob(account_number_hash);
    let enc = aead_seal_ctx(&membership_key, nonce, plaintext, &aad)?;
    Ok(MembershipRoster { nonce: *nonce, enc })
}

/// Unseal the B2B roster envelope. Same binding as
/// [`unseal_membership`]: a tampered envelope or a wrong `root_key`
/// answers [`ProtocolError::AeadFailure`] (non-distinguishing, §7.3).
pub fn unseal_membership_roster(
    root_key: &[u8; AEAD_KEY_LEN],
    roster: &MembershipRoster,
    account_number_hash: &[u8; 16],
) -> Result<Zeroizing<Vec<u8>>, ProtocolError> {
    let membership_key = derive_subkey_v0_2(root_key, SubkeyRole::MembershipKey);
    let aad = aad_membership_roster_blob(account_number_hash);
    aead_open_ctx(&membership_key, &roster.nonce, &roster.enc, &aad)
}

/// Unseal the account id from a [`Membership`] field. Returns
/// [`ProtocolError::AeadFailure`] on a tampered field or a wrong `root_key` (the
/// field is bound to its vault via `account_number_hash` in the AAD, so a field
/// copied from another vault fails here). The caller maps the failure to its own
/// non-distinguishing error; a tampered membership field must never surface as a
/// partial read.
pub fn unseal_membership(
    root_key: &[u8; AEAD_KEY_LEN],
    membership: &Membership,
    account_number_hash: &[u8; 16],
) -> Result<Zeroizing<[u8; MEMBERSHIP_ACCOUNT_ID_LEN]>, ProtocolError> {
    let membership_key = derive_subkey_v0_2(root_key, SubkeyRole::MembershipKey);
    let aad = aad_membership_blob(account_number_hash);
    let pt = aead_open_ctx(&membership_key, &membership.nonce, &membership.enc, &aad)?;
    if pt.len() != MEMBERSHIP_ACCOUNT_ID_LEN {
        return Err(ProtocolError::AeadFailure);
    }
    let mut account_id = Zeroizing::new([0u8; MEMBERSHIP_ACCOUNT_ID_LEN]);
    account_id.copy_from_slice(&pt);
    Ok(account_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: [u8; 32] = [0x11; 32];
    const ITEMS: [u8; 32] = [0x22; 32];
    const ITEMS_ID: [u8; 16] = [0x33; 16];
    const ACCT: [u8; 16] = [0x44; 16];
    const PASSWORD: &str = "correct horse battery staple";
    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

    // Fast Argon2id params for tests (never a production path).
    fn fast_params() -> KdfParams {
        KdfParams {
            m_kib: 8,
            t: 1,
            p: 1,
            argon2_version: 0x13,
        }
    }

    /// A minimal v0.2 meta carrying a fixture roster extension. Built from
    /// the REAL encoded base (`encode()`, fast params), so the base-345
    /// parse inside the roster parser is exercised for real; the roster
    /// ciphertext bytes are fixture filler (framing only; the AEAD tests
    /// use real seals).
    fn roster_meta_fixture() -> VaultMeta {
        let mut meta = parse_vault_meta_v0_2(&encode()).expect("parse base NTV5");
        meta.membership = Some(Membership {
            nonce: [0x11; AEAD_NONCE_LEN],
            enc: [0x22; MEMBERSHIP_CIPHERTEXT_LEN],
            roster: Some(MembershipRoster {
                nonce: [0x33; MEMBERSHIP_ROSTER_NONCE_LEN],
                enc: alloc::vec![0x55; 64],
            }),
        });
        meta
    }

    fn encode() -> [u8; VAULT_META_LEN] {
        encode_vault_meta_v0_2_raw(
            &ROOT,
            &ITEMS,
            &ITEMS_ID,
            PASSWORD,
            PHRASE,
            &ACCT,
            &fast_params(),
            &[0x01; 16],
            &[0x02; 16],
            &[0x03; 24],
            &[0x04; 24],
            &[0x05; 24],
        )
        .expect("encode NTV5")
    }

    fn ntv6_fixture() -> B2bVaultMeta {
        let signed_roster = crate::person_invite::SignedGroupRoster {
            payload: alloc::vec![0xC3; 32],
            signature: crate::person_key::PersonSigned {
                ed25519_sig: [0xD4; crate::person_key::PERSON_ED25519_SIG_LEN],
                mldsa_sig: alloc::vec![0xE5; crate::person_key::PERSON_MLDSA_SIG_LEN],
            },
        };
        // The roster is sealed under the group tier, so the fixture needs a
        // group key (any fixed one: these tests only round-trip and validate).
        let group_key = [0x77u8; 32];
        let signed_roster_envelope = crate::person_invite::seal_group_roster(
            &group_key,
            &ACCT,
            1,
            &[0x66; AEAD_NONCE_LEN],
            &signed_roster,
        )
        .expect("sealed roster");
        B2bVaultMeta {
            base: parse_vault_meta_v0_2(&encode()).expect("parse base NTV5"),
            group_key_nonce: [0xA1; AEAD_NONCE_LEN],
            enc_group_key: [0xB2; VAULT_META_WRAPPED_ITEMS_KEY_LEN],
            group_key_epoch: 1,
            signed_roster_envelope,
        }
    }

    #[test]
    fn ntv6_b2b_meta_round_trips_and_pre_ntv6_readers_refuse_it() {
        let meta = ntv6_fixture();
        let bytes = serialize_vault_meta_ntv6(&meta).expect("serialize NTV6");
        assert_eq!(&bytes[..4], b"NTV6");
        assert_eq!(bytes[4], 0x02);
        assert_eq!(meta_version_of(&bytes), Some(MetaVersion::V0_2));
        assert_eq!(parse_vault_meta_ntv6(&bytes), Ok(meta.clone()));
        // The base-only reader accepts NTV6 and returns the v0.2 base, so every
        // singleton/index/sync reader keeps working on a B2B-migrated vault.
        assert_eq!(parse_vault_meta_any(&bytes), Ok(meta.base));
        assert_eq!(
            parse_vault_meta_v0_2(&bytes),
            Err(ProtocolError::InvalidVaultMeta)
        );
        assert_eq!(
            parse_vault_meta(&bytes),
            Err(ProtocolError::InvalidVaultMeta)
        );
    }

    #[test]
    fn ntv6_writer_requires_epoch_and_signed_roster() {
        let mut meta = ntv6_fixture();
        meta.group_key_epoch = 0;
        assert_eq!(
            serialize_vault_meta_ntv6(&meta),
            Err(ProtocolError::InvalidVaultMeta)
        );

        meta.group_key_epoch = 1;
        meta.signed_roster_envelope.clear();
        assert_eq!(
            serialize_vault_meta_ntv6(&meta),
            Err(ProtocolError::InvalidVaultMeta)
        );

        meta.signed_roster_envelope = alloc::vec![0xC3; 32];
        assert_eq!(
            serialize_vault_meta_ntv6(&meta),
            Err(ProtocolError::InvalidVaultMeta)
        );
    }

    #[test]
    fn ntv6_reader_rejects_every_structural_malformed_class() {
        let valid = serialize_vault_meta_ntv6(&ntv6_fixture()).expect("serialize NTV6");
        let mut cases = alloc::vec::Vec::new();

        let mut wrong_magic = valid.clone();
        wrong_magic[3] = b'5';
        cases.push(wrong_magic);

        let mut wrong_version = valid.clone();
        wrong_version[4] = 0x01;
        cases.push(wrong_version);

        let mut zero_epoch = valid.clone();
        let epoch_start = VAULT_META_LEN + AEAD_NONCE_LEN + VAULT_META_WRAPPED_ITEMS_KEY_LEN;
        zero_epoch[epoch_start..epoch_start + 8].fill(0);
        cases.push(zero_epoch);

        let mut zero_roster_len = valid.clone();
        let roster_len_start = epoch_start + 8;
        zero_roster_len[roster_len_start..roster_len_start + 4].fill(0);
        cases.push(zero_roster_len);

        let mut trailing = valid.clone();
        trailing.push(0);
        cases.push(trailing);

        cases.push(valid[..valid.len() - 1].to_vec());
        cases.push(valid[..B2B_META_FIXED_LEN - 1].to_vec());

        for malformed in cases {
            assert_eq!(
                parse_vault_meta_ntv6(&malformed),
                Err(ProtocolError::InvalidVaultMeta)
            );
        }
    }

    #[test]
    fn ntv5_header_is_the_v0_2_family() {
        let blob = encode();
        assert_eq!(&blob[0..4], b"NTV5");
        assert_eq!(blob[4], 0x02);
        assert_eq!(blob.len(), VAULT_META_LEN);
    }

    #[test]
    fn root_key_unwraps_under_both_credentials_and_items_key_derives() {
        // The phrase-required rule's whole point: BOTH credentials recover the
        // SAME new root_key, so recovery is never stranded (§10.4.1).
        let blob = encode();
        let meta = parse_vault_meta_v0_2(&blob).expect("parse NTV5");

        let via_pw =
            unlock_root_key_v0_2_password(&meta, PASSWORD, &ACCT).expect("password unlock");
        let via_rec = unlock_root_key_v0_2_recovery(&meta, PHRASE, &ACCT).expect("recovery unlock");
        assert_eq!(*via_pw, ROOT, "password unwraps the minted root_key");
        assert_eq!(
            *via_rec, ROOT,
            "recovery unwraps the SAME root_key (not stranded)"
        );

        // And the v0.2 itemsKey re-derives under the new root_key.
        let items = derive_items_key_v0_2(&via_pw, &meta).expect("items_key derive");
        assert_eq!(*items, ITEMS);
    }

    #[test]
    fn wrong_password_and_wrong_phrase_fail_non_distinguishing() {
        let meta = parse_vault_meta_v0_2(&encode()).expect("parse");
        assert!(matches!(
            unlock_root_key_v0_2_password(&meta, "wrong password", &ACCT),
            Err(ProtocolError::AeadFailure)
        ));
        let wrong_phrase = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";
        assert!(matches!(
            unlock_root_key_v0_2_recovery(&meta, wrong_phrase, &ACCT),
            Err(ProtocolError::AeadFailure)
        ));
    }

    #[test]
    fn a_v0_1_parser_refuses_ntv5_and_vice_versa() {
        // §10.5 anti-downgrade: a v0.1 client MUST refuse an NTV5 vault.meta
        // (never half-parse it), and the v0.2 parser refuses a MYV1 blob.
        let ntv5 = encode();
        assert!(matches!(
            parse_vault_meta(&ntv5),
            Err(ProtocolError::InvalidVaultMeta)
        ));
        // A blob with the MYV1 magic is rejected by the v0.2 parser.
        let mut as_myv1 = ntv5;
        as_myv1[0..4].copy_from_slice(&VAULT_META_MAGIC);
        as_myv1[4] = 0x01;
        assert!(matches!(
            parse_vault_meta_v0_2(&as_myv1),
            Err(ProtocolError::InvalidVaultMeta)
        ));
    }

    #[test]
    fn an_ntv5_wrap_does_not_verify_under_the_v0_1_aad() {
        // Domain separation at the vault.meta layer: the v0.2 password wrap binds
        // the v0.2 AAD, so opening it with the v0.1 AAD (same wrap key) fails.
        let params = fast_params();
        let pw_key =
            derive_password_wrap_key_v0_2(PASSWORD, &[0x01; 16], &ACCT, &params).expect("kdf");
        let sealed = aead_seal_ctx(
            &pw_key,
            &[0x03; 24],
            &ROOT,
            &aad_password_wrap_v0_2(&params),
        )
        .expect("seal");
        // v0.1 AAD must NOT open it.
        assert!(aead_open_ctx(
            &pw_key,
            &[0x03; 24],
            &sealed,
            &crate::aead::aad_password_wrap(&params)
        )
        .is_err());
        // Its own v0.2 AAD does (control).
        assert!(aead_open_ctx(
            &pw_key,
            &[0x03; 24],
            &sealed,
            &aad_password_wrap_v0_2(&params)
        )
        .is_ok());
    }

    #[test]
    fn rewrite_password_side_v0_2_swaps_the_password_and_preserves_recovery() {
        // The migrated-vault change-password primitive (#420 Task 6): re-wrap
        // `root_key` under a NEW v0.2 password, carrying the recovery + itemsKey
        // sections byte-identical. The NEW password must unlock the SAME root_key,
        // the OLD one must stop working, and the phrase must still recover it.
        const NEW_PASSWORD: &str = "an entirely different rekey passphrase";
        let existing = parse_vault_meta_v0_2(&encode()).expect("parse NTV5");

        let rewritten = rewrite_vault_meta_password_side_v0_2(
            &existing,
            &ROOT,
            NEW_PASSWORD,
            &[0x77; 16],
            &[0x88; 24],
        )
        .expect("rewrite v0.2 password side");
        assert_eq!(&rewritten[0..4], VAULT_META_V0_2_MAGIC.as_slice());
        assert_eq!(rewritten[4], VAULT_META_V0_2_PROTOCOL_VERSION);
        let after = parse_vault_meta_v0_2(&rewritten).expect("parse rewritten NTV5");

        // NEW password unlocks the SAME root_key.
        assert_eq!(
            *unlock_root_key_v0_2_password(&after, NEW_PASSWORD, &ACCT).expect("new pw unlocks"),
            ROOT
        );
        // OLD password no longer unlocks (real re-wrap, not a no-op).
        assert!(unlock_root_key_v0_2_password(&after, PASSWORD, &ACCT).is_err());
        // Recovery is byte-preserved: the phrase still unlocks the same root_key.
        assert_eq!(
            *unlock_root_key_v0_2_recovery(&after, PHRASE, &ACCT).expect("phrase unlocks"),
            ROOT
        );
        // The itemsKey wrap is byte-preserved (derives the same itemsKey).
        assert_eq!(
            *derive_items_key_v0_2(&ROOT, &after).expect("items key"),
            ITEMS
        );
    }

    #[test]
    fn membership_seal_unseal_round_trips() {
        let account_id = [0xAB; MEMBERSHIP_ACCOUNT_ID_LEN];
        let nonce = [0xCD; AEAD_NONCE_LEN];
        let membership = seal_membership_raw(&ROOT, &account_id, &ACCT, &nonce).expect("seal");
        let recovered = unseal_membership(&ROOT, &membership, &ACCT).expect("unseal");
        assert_eq!(*recovered, account_id);
    }

    #[test]
    fn membership_tamper_fails_closed() {
        let account_id = [0xAB; MEMBERSHIP_ACCOUNT_ID_LEN];
        let nonce = [0xCD; AEAD_NONCE_LEN];
        let mut membership = seal_membership_raw(&ROOT, &account_id, &ACCT, &nonce).expect("seal");
        membership.enc[0] ^= 0x01;
        assert!(matches!(
            unseal_membership(&ROOT, &membership, &ACCT),
            Err(ProtocolError::AeadFailure)
        ));
    }

    #[test]
    fn membership_binds_account_number_hash() {
        // A field sealed for one vault must not open under another vault's hash.
        let account_id = [0xAB; MEMBERSHIP_ACCOUNT_ID_LEN];
        let nonce = [0xCD; AEAD_NONCE_LEN];
        let membership = seal_membership_raw(&ROOT, &account_id, &ACCT, &nonce).expect("seal");
        let other_hash = [0xEE; 16];
        assert!(matches!(
            unseal_membership(&ROOT, &membership, &other_hash),
            Err(ProtocolError::AeadFailure)
        ));
    }

    #[test]
    fn serialize_with_membership_is_417_bytes_and_round_trips() {
        let account_id = [0xAB; MEMBERSHIP_ACCOUNT_ID_LEN];
        let nonce = [0xCD; AEAD_NONCE_LEN];
        let membership = seal_membership_raw(&ROOT, &account_id, &ACCT, &nonce).expect("seal");

        let mut meta = parse_vault_meta_v0_2(&encode()).expect("parse base NTV5");
        meta.membership = Some(membership);

        let blob = serialize_vault_meta_v0_2(&meta);
        assert_eq!(blob.len(), VAULT_META_V0_2_WITH_MEMBERSHIP_LEN);
        assert_eq!(blob[5], 0x01, "reserved byte flags the membership field");

        let parsed = parse_vault_meta_v0_2(&blob).expect("parse 417-byte NTV5");
        let m = parsed.membership.expect("membership present");
        assert_eq!(
            *unseal_membership(&ROOT, &m, &ACCT).expect("unseal"),
            account_id
        );
    }

    #[test]
    fn serialize_without_membership_is_345_bytes() {
        let meta = parse_vault_meta_v0_2(&encode()).expect("parse base NTV5");
        let blob = serialize_vault_meta_v0_2(&meta);
        assert_eq!(blob.len(), VAULT_META_LEN);
        assert_eq!(blob[5], 0x00, "reserved byte stays 0x00 when absent");
    }

    #[test]
    fn parse_rejects_reserved_byte_above_the_allocated_range() {
        // 0x00/0x01/0x02 are allocated (base / single-account / roster); 0x03 is
        // the first unallocated value the newer-reads-older rule must reject.
        // This used 0x02 until the roster extension allocated it, at which point
        // the test passed only because the 345-byte fixture is shorter than the
        // roster-present length and the LENGTH check rejected it, not the
        // reserved-byte check the name described.
        let mut blob = encode().to_vec();
        blob[5] = 0x03;
        assert!(matches!(
            parse_vault_meta_v0_2(&blob),
            Err(ProtocolError::InvalidVaultMeta)
        ));
    }

    #[test]
    fn parse_rejects_membership_flag_with_wrong_length() {
        // reserved=0x01 but only 345 bytes: the flag promises a field that is not
        // there, which is a structural reject, not a silent absent read.
        let mut blob = encode().to_vec();
        blob[5] = 0x01;
        assert!(matches!(
            parse_vault_meta_v0_2(&blob),
            Err(ProtocolError::InvalidVaultMeta)
        ));
    }

    /// Emit the `v0.2` cross-impl vectors for `vault-meta` (`NTV5`) as JSON,
    /// ready to paste into the companion repo (myne-md/myne#441).
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act, not a side
    /// effect of `cargo test` — the same discipline every other emitter follows.
    /// Run with:
    /// `cargo test -p protocol --lib emit_vault_meta_v0_2_vectors_for_paste -- --ignored --nocapture`
    ///
    /// # Why these two families, and why together
    ///
    /// §10.4.1 point 6 froze the `MY?5` `protocol_version` byte as a **split**:
    /// item- and meta-scoped v0.2 blobs carry `0x02`, KEK-singleton families
    /// carry `0x01`. A port has to reproduce both, and until now nothing outside
    /// this repository pinned either. `vault-meta` is the `0x02` side (and the
    /// file that decides which key hierarchy a vault opens under at all);
    /// The `0x01` side is pinned by the `vault-themes` v0.2 emitter, which lives
    /// beside its own codec in `themes_blob.rs` — each family's generator sits
    /// with the thing it generates.
    ///
    /// The load-bearing case in each is the **cross-version rejection**: a
    /// `MYV1` blob MUST NOT parse as v0.2 and an `NTV5` blob MUST NOT parse as
    /// v0.1 (§10.5 anti-downgrade). A round-trip alone would pass for an
    /// implementation that ignored the magic entirely.
    #[test]
    #[ignore]
    fn emit_vault_meta_v0_2_vectors_for_paste() {
        extern crate std;

        fn hex(b: &[u8]) -> alloc::string::String {
            let mut s = alloc::string::String::with_capacity(b.len() * 2);
            for x in b {
                s.push_str(&alloc::format!("{x:02x}"));
            }
            s
        }

        // --- vault-meta / v0.2 (NTV5) ---------------------------------------
        // Byte patterns distinct from the v0.1 category's 0xDA..0xE3 so a
        // cross-category diff cannot silently show one set for the other.
        let meta = VaultMeta {
            account_number_hash: [0x5A; 16],
            kdf_params: fast_params(),
            random_salt_password: [0x5B; 16],
            random_salt_recovery: [0x5C; 16],
            nonce_password_wrap: [0x5D; 24],
            enc_root_key_password: [0x5E; 64],
            nonce_recovery_wrap: [0x5F; 24],
            enc_root_key_recovery: [0x60; 64],
            items_key_id: [0x61; 16],
            items_key_nonce: [0x62; 24],
            enc_items_key: [0x63; 64],
            membership: None,
        };
        let ntv5 = serialize_vault_meta_v0_2(&meta);
        assert_eq!(&ntv5[0..4], VAULT_META_V0_2_MAGIC.as_slice());
        assert_eq!(ntv5[4], VAULT_META_V0_2_PROTOCOL_VERSION, "0x02 side");
        parse_vault_meta_v0_2(&ntv5).expect("canonical NTV5 must parse");
        let myv1 = crate::serialize_vault_meta(&meta);
        assert!(
            parse_vault_meta_v0_2(&myv1).is_err(),
            "a MYV1 blob must not parse as v0.2"
        );
        assert!(
            crate::parse_vault_meta(&ntv5).is_err(),
            "an NTV5 blob must not parse as v0.1"
        );

        std::println!("=== vectors/vault-meta/v0.2/cases.json ===");
        std::println!("{{");
        std::println!("  \"schema\": \"vault-meta\",");
        std::println!("  \"protocol_version\": \"v0.2\",");
        std::println!("  \"spec_section\": \"protocol.md §9.3 + §10.4.1 + §10.5\",");
        std::println!("  \"description\": \"Pins serialize_vault_meta_v0_2 + parse_vault_meta_v0_2 (NTV5). Identical 345-byte layout to MYV1 with bytes [0..5] swapped to magic NTV5 + protocol_version 0x02 — the 0x02 side of the frozen §10.4.1 md.6 split. The two reject cases are the load-bearing ones: §10.5 anti-downgrade means a MYV1 blob must not parse as v0.2 and an NTV5 blob must not parse as v0.1, which a round-trip alone would not catch in an implementation that ignored the magic. Generated by `cargo test -p protocol --lib emit_vault_meta_v0_2_vectors_for_paste -- --ignored --nocapture`.\",");
        std::println!("  \"cases\": [");
        std::println!("    {{");
        std::println!("      \"vector_id\": \"vault-meta/v0.2/canonical-roundtrip\",");
        std::println!("      \"description\": \"Hand-crafted fixture, byte patterns 0x5A..0x63 (distinct from the v0.1 category's 0xDA..0xE3 so a cross-category diff cannot show one set for the other). FAST_TEST_KDF params.\",");
        std::println!("      \"case_kind\": \"roundtrip\",");
        std::println!(
            "      \"input_account_number_hash_hex\": \"{}\",",
            hex(&meta.account_number_hash)
        );
        std::println!("      \"input_kdf_params\": {{ \"m_kib\": {}, \"t\": {}, \"p\": {}, \"argon2_version_hex\": \"{:02x}\" }},", meta.kdf_params.m_kib, meta.kdf_params.t, meta.kdf_params.p, meta.kdf_params.argon2_version);
        std::println!(
            "      \"input_random_salt_password_hex\": \"{}\",",
            hex(&meta.random_salt_password)
        );
        std::println!(
            "      \"input_random_salt_recovery_hex\": \"{}\",",
            hex(&meta.random_salt_recovery)
        );
        std::println!(
            "      \"input_nonce_password_wrap_hex\": \"{}\",",
            hex(&meta.nonce_password_wrap)
        );
        std::println!(
            "      \"input_enc_root_key_password_hex\": \"{}\",",
            hex(&meta.enc_root_key_password)
        );
        std::println!(
            "      \"input_nonce_recovery_wrap_hex\": \"{}\",",
            hex(&meta.nonce_recovery_wrap)
        );
        std::println!(
            "      \"input_enc_root_key_recovery_hex\": \"{}\",",
            hex(&meta.enc_root_key_recovery)
        );
        std::println!(
            "      \"input_items_key_id_hex\": \"{}\",",
            hex(&meta.items_key_id)
        );
        std::println!(
            "      \"input_items_key_nonce_hex\": \"{}\",",
            hex(&meta.items_key_nonce)
        );
        std::println!(
            "      \"input_enc_items_key_hex\": \"{}\",",
            hex(&meta.enc_items_key)
        );
        std::println!("      \"expected_blob_hex\": \"{}\"", hex(&ntv5));
        std::println!("    }},");
        std::println!("    {{");
        std::println!("      \"vector_id\": \"vault-meta/v0.2/rejects-v0-1-magic\",");
        std::println!("      \"description\": \"§10.5 anti-downgrade: the SAME fields serialized as MYV1 must be rejected by the v0.2 parser. Bytes [5..] are byte-identical to the roundtrip case, so only the magic + version separate them.\",");
        std::println!("      \"case_kind\": \"parse_fail\",");
        std::println!("      \"input_blob_hex\": \"{}\",", hex(&myv1));
        std::println!("      \"expected_error\": \"invalid_vault_meta\"");
        std::println!("    }},");
        std::println!("    {{");
        std::println!("      \"vector_id\": \"vault-meta/v0.2/v0-1-parser-rejects-ntv5\",");
        std::println!("      \"description\": \"The other direction: a v0.1 client must refuse an NTV5 blob rather than half-parse it (§10.5, the fleet safety gate for a cut-over vault reached by an un-upgraded client).\",");
        std::println!("      \"case_kind\": \"parse_fail_v0_1\",");
        std::println!("      \"input_blob_hex\": \"{}\",", hex(&ntv5));
        std::println!("      \"expected_error\": \"invalid_vault_meta\"");
        std::println!("    }}");
        std::println!("  ]");
        std::println!("}}");
    }

    /// Emit the membership-field vectors for `vault-meta/v0.2` as a JSON array
    /// fragment, ready to splice into the companion repo's `cases.json`. The
    /// three cases pin the field's three states: absent (345 bytes, `reserved`
    /// 0x00), present (417 bytes, `reserved` 0x01, a known account id sealed
    /// under a known root_key), and tampered (a flipped ciphertext byte must
    /// fail `unseal_membership` closed). Driven through the live codec so the
    /// vectors pin the bytes, not an opinion about the bytes.
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act. Run with:
    /// `cargo test -p protocol --lib emit_membership_vectors_for_paste -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn emit_membership_vectors_for_paste() {
        extern crate std;

        fn hex(b: &[u8]) -> alloc::string::String {
            let mut s = alloc::string::String::with_capacity(b.len() * 2);
            for x in b {
                s.push_str(&alloc::format!("{x:02x}"));
            }
            s
        }

        // A base NTV5 meta (no membership) built from the same fixture the
        // canonical-roundtrip case uses, so the absent case is byte-comparable.
        let base = parse_vault_meta_v0_2(&encode()).expect("parse base NTV5");
        let absent = serialize_vault_meta_v0_2(&base);
        assert_eq!(absent.len(), VAULT_META_LEN);

        // Present: seal a known account id under a known root_key.
        let account_id = [0xAB; MEMBERSHIP_ACCOUNT_ID_LEN];
        let nonce = [0xCD; AEAD_NONCE_LEN];
        let membership = seal_membership_raw(&ROOT, &account_id, &ACCT, &nonce).expect("seal");
        let mut present_meta = base.clone();
        present_meta.membership = Some(membership.clone());
        let present = serialize_vault_meta_v0_2(&present_meta);
        assert_eq!(present.len(), VAULT_META_V0_2_WITH_MEMBERSHIP_LEN);

        // Tampered: flip a ciphertext byte; unseal must fail closed.
        let mut tampered = membership.clone();
        tampered.enc[0] ^= 0x01;
        assert!(unseal_membership(&ROOT, &tampered, &ACCT).is_err());
        let mut tampered_meta = base.clone();
        tampered_meta.membership = Some(tampered);
        let tampered_blob = serialize_vault_meta_v0_2(&tampered_meta);

        std::println!("[");
        std::println!("  {{");
        std::println!("    \"vector_id\": \"vault-meta/v0.2/membership-absent\",");
        std::println!("    \"description\": \"An NTV5 vault.meta with no membership field: 345 bytes, reserved byte 0x00. parse_vault_meta_v0_2 must accept it and report membership: None (unmigrated). Generated by `cargo test -p protocol --lib emit_membership_vectors_for_paste -- --ignored --nocapture`.\",");
        std::println!("    \"case_kind\": \"membership_absent\",");
        std::println!("    \"input_blob_hex\": \"{}\",", hex(&absent));
        std::println!("    \"expected_membership\": \"absent\"");
        std::println!("  }},");
        std::println!("  {{");
        std::println!("    \"vector_id\": \"vault-meta/v0.2/membership-present\",");
        std::println!("    \"description\": \"An NTV5 vault.meta with the membership field present: 417 bytes, reserved byte 0x01, a 16-byte account id sealed under membership_key (root_key = 0x11.., account_number_hash = 0x44.., nonce = 0xCD..). parse_vault_meta_v0_2 must accept it and unseal_membership must recover the account id.\",");
        std::println!("    \"case_kind\": \"membership_present\",");
        std::println!("    \"input_blob_hex\": \"{}\",", hex(&present));
        std::println!("    \"input_root_key_hex\": \"{}\",", hex(&ROOT));
        std::println!("    \"input_account_number_hash_hex\": \"{}\",", hex(&ACCT));
        std::println!("    \"expected_account_id_hex\": \"{}\"", hex(&account_id));
        std::println!("  }},");
        std::println!("  {{");
        std::println!("    \"vector_id\": \"vault-meta/v0.2/membership-tampered\",");
        std::println!("    \"description\": \"The membership-present blob with the first ciphertext byte flipped. unseal_membership must fail closed (AeadFailure), never a partial read.\",");
        std::println!("    \"case_kind\": \"membership_tampered\",");
        std::println!("    \"input_blob_hex\": \"{}\",", hex(&tampered_blob));
        std::println!("    \"input_root_key_hex\": \"{}\",", hex(&ROOT));
        std::println!("    \"input_account_number_hash_hex\": \"{}\",", hex(&ACCT));
        std::println!("    \"tamper_offset\": 369,");
        std::println!("    \"expected_error\": \"aead_failure\"");
        std::println!("  }}");
        std::println!("]");
    }
    #[test]
    fn b2b_roster_round_trip() {
        let mut meta = roster_meta_fixture();
        meta.membership = Some(Membership {
            nonce: [0x11; AEAD_NONCE_LEN],
            enc: [0x22; MEMBERSHIP_CIPHERTEXT_LEN],
            roster: Some(MembershipRoster {
                nonce: [0x33; MEMBERSHIP_ROSTER_NONCE_LEN],
                enc: alloc::vec![0x55; 64],
            }),
        });
        let bytes = serialize_vault_meta_v0_2(&meta);
        assert_eq!(bytes[5], 0x02, "roster shape is reserved byte 0x02");
        // 345 + 72 (single-account field) + 24 (roster nonce) + 4 (len) + 64 (ct) = 509
        assert_eq!(
            bytes.len(),
            VAULT_META_V0_2_WITH_MEMBERSHIP_LEN + MEMBERSHIP_ROSTER_NONCE_LEN + 4 + 64
        );
        let parsed = parse_vault_meta_v0_2(&bytes).expect("roster meta parses");
        let membership = parsed.membership.expect("membership present");
        let roster = membership.roster.expect("roster present");
        assert_eq!(roster.nonce, [0x33; MEMBERSHIP_ROSTER_NONCE_LEN]);
        assert_eq!(roster.enc, alloc::vec![0x55; 64]);
    }

    #[test]
    fn b2b_roster_parser_rejects_over_cap_and_zero_len() {
        // Build a valid 0x02 blob, then tamper the u32 length field past the cap.
        let mut meta = roster_meta_fixture();
        meta.membership = Some(Membership {
            nonce: [0x11; AEAD_NONCE_LEN],
            enc: [0x22; MEMBERSHIP_CIPHERTEXT_LEN],
            roster: Some(MembershipRoster {
                nonce: [0x33; MEMBERSHIP_ROSTER_NONCE_LEN],
                enc: alloc::vec![0x55; 64],
            }),
        });
        let mut bytes = serialize_vault_meta_v0_2(&meta);
        let len_start = VAULT_META_V0_2_WITH_MEMBERSHIP_LEN + MEMBERSHIP_ROSTER_NONCE_LEN;
        // Over-cap length: the parser must reject BEFORE reading ciphertext.
        bytes[len_start] = 0xFF;
        bytes[len_start + 1] = 0xFF;
        bytes[len_start + 2] = 0xFF;
        bytes[len_start + 3] = 0xFF;
        assert_eq!(
            parse_vault_meta_v0_2(&bytes).unwrap_err(),
            ProtocolError::InvalidVaultMeta
        );
    }

    #[test]
    fn b2b_roster_parser_rejects_length_mismatch_closed() {
        let mut meta = roster_meta_fixture();
        meta.membership = Some(Membership {
            nonce: [0x11; AEAD_NONCE_LEN],
            enc: [0x22; MEMBERSHIP_CIPHERTEXT_LEN],
            roster: Some(MembershipRoster {
                nonce: [0x33; MEMBERSHIP_ROSTER_NONCE_LEN],
                enc: alloc::vec![0x55; 64],
            }),
        });
        let mut bytes = serialize_vault_meta_v0_2(&meta);
        // Drop one ciphertext byte: declared length no longer matches.
        bytes.pop();
        assert_eq!(
            parse_vault_meta_v0_2(&bytes).unwrap_err(),
            ProtocolError::InvalidVaultMeta
        );
    }

    #[test]
    fn b2b_roster_seal_unseal_round_trip_and_vault_binding() {
        let plaintext = alloc::vec![0xAB; 128];
        let nonce = [0x44; MEMBERSHIP_ROSTER_NONCE_LEN];
        let roster =
            seal_membership_roster_raw(&ROOT, &plaintext, &ACCT, &nonce).expect("roster seal");
        let opened = unseal_membership_roster(&ROOT, &roster, &ACCT).expect("roster unseal");
        assert_eq!(plaintext.as_slice(), &opened[..]);

        // The vault binding: the SAME roster under a DIFFERENT account hash
        // must fail AEAD (a roster copied across vaults cannot regroup).
        let other_hash = [0x77u8; 16];
        let result = unseal_membership_roster(&ROOT, &roster, &other_hash);
        assert_eq!(result.unwrap_err(), ProtocolError::AeadFailure);
    }

    #[test]
    fn b2b_roster_cap_refuses_over_cap_plaintext() {
        let nonce = [0x44; MEMBERSHIP_ROSTER_NONCE_LEN];
        let over_cap = alloc::vec![0u8; MEMBERSHIP_ROSTER_CT_CAP];
        let result = seal_membership_roster_raw(&ROOT, &over_cap, &ACCT, &nonce);
        // plaintext.len() + 32 > cap: the +32 tag would push past the cap.
        assert_eq!(result.unwrap_err(), ProtocolError::InvalidVaultMeta);
    }

    /// The B2B **roster extension** vector emitter (myne-md/myne#698 task
    /// 11): pins the NTV5 `reserved` byte `0x02` layout. the roster
    /// envelope (nonce || u32 BE len || ct) after the 72 single-account
    /// bytes. for the same fixture roots as the membership family. Six
    /// cases: absent, present (round-trip + unseal), tampered (fail
    /// closed), cap-refused (over-cap length rejected by the parser
    /// BEFORE reading ciphertext), and a seal/unseal pair with a known
    /// plaintext under a known wrap key.
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act. Run
    /// with: `cargo test -p protocol --lib emit_roster_vectors_for_paste -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn emit_roster_vectors_for_paste() {
        extern crate std;
        fn hex(b: &[u8]) -> alloc::string::String {
            let mut s = alloc::string::String::with_capacity(b.len() * 2);
            for x in b {
                s.push_str(&alloc::format!("{x:02x}"));
            }
            s
        }
        let base = parse_vault_meta_v0_2(&encode()).expect("parse base NTV5");
        // Present-with-roster: the single-account field + a real roster
        // seal. The roster plaintext is a canonical fixture the merge
        // layer's schema pins (owner row, version 1).
        let account_id = [0xAB; MEMBERSHIP_ACCOUNT_ID_LEN];
        let mem_nonce = [0xCD; AEAD_NONCE_LEN];
        let membership = seal_membership_raw(&ROOT, &account_id, &ACCT, &mem_nonce).expect("seal");
        let roster_plaintext = b"{\"member_fp\":\"aa\"}".to_vec();
        let roster_nonce = [0xEE; MEMBERSHIP_ROSTER_NONCE_LEN];
        let roster = seal_membership_roster_raw(&ROOT, &roster_plaintext, &ACCT, &roster_nonce)
            .expect("roster seal");
        let mut roster_meta = base.clone();
        roster_meta.membership = Some(Membership {
            nonce: membership.nonce,
            enc: membership.enc,
            roster: Some(roster.clone()),
        });
        let roster_blob = serialize_vault_meta_v0_2(&roster_meta);
        assert_eq!(roster_blob[5], 0x02);
        assert_eq!(
            roster_blob.len(),
            VAULT_META_V0_2_WITH_MEMBERSHIP_LEN
                + MEMBERSHIP_ROSTER_NONCE_LEN
                + 4
                + roster.enc.len()
        );
        // Parsed back: the roster envelope round-trips.
        let parsed = parse_vault_meta_v0_2(&roster_blob).expect("roster meta parses");
        let parsed_roster = parsed
            .membership
            .as_ref()
            .and_then(|m| m.roster.as_ref())
            .expect("roster present");
        assert_eq!(parsed_roster.nonce, roster.nonce);
        assert_eq!(parsed_roster.enc, roster.enc);
        // Over-cap: the length field pushed past the cap rejects.
        let mut over_cap = roster_blob.clone();
        let len_start = VAULT_META_V0_2_WITH_MEMBERSHIP_LEN + MEMBERSHIP_ROSTER_NONCE_LEN;
        over_cap[len_start] = 0xFF;
        over_cap[len_start + 1] = 0xFF;
        over_cap[len_start + 2] = 0xFF;
        over_cap[len_start + 3] = 0xFF;
        assert!(parse_vault_meta_v0_2(&over_cap).is_err());
        // Tampered roster ct: unseal fails closed.
        let mut tampered_roster = roster.clone();
        let mid = tampered_roster.enc.len() / 2;
        tampered_roster.enc[mid] ^= 0x01;
        assert!(unseal_membership_roster(&ROOT, &tampered_roster, &ACCT).is_err());
        let mut tampered_meta = base.clone();
        tampered_meta.membership = Some(Membership {
            nonce: membership.nonce,
            enc: membership.enc,
            roster: Some(tampered_roster),
        });
        let tampered_blob = serialize_vault_meta_v0_2(&tampered_meta);
        std::println!("[");
        std::println!("  {{");
        std::println!("    \"vector_id\": \"vault-meta/v0.2/roster-present\",");
        std::println!("    \"description\": \"An NTV5 vault.meta with the B2B roster extension: reserved byte 0x02, 417 + 24 + 4 + N bytes, the roster envelope (nonce 0xEE.., u32 BE length, ciphertext) after the 72 single-account bytes, sealed under membership_key with the roster AAD. parse_vault_meta_v0_2 must accept it and unseal_membership_roster must recover the roster plaintext under root_key = 0x11.., account_number_hash = 0x44..\",");
        std::println!("    \"case_kind\": \"roster_present\",");
        std::println!("    \"input_blob_hex\": \"{}\",", hex(&roster_blob));
        std::println!("    \"input_root_key_hex\": \"{}\",", hex(&ROOT));
        std::println!("    \"input_account_number_hash_hex\": \"{}\",", hex(&ACCT));
        std::println!(
            "    \"input_roster_nonce_hex\": \"{}\",",
            hex(&roster.nonce)
        );
        std::println!(
            "    \"expected_roster_plaintext_utf8\": \"{{\\\"member_fp\\\":\\\"aa\\\"}}\","
        );
        std::println!("    \"tamper_offset\": {}", mid);
        std::println!("  }},");
        std::println!("  {{");
        std::println!("    \"vector_id\": \"vault-meta/v0.2/roster-tampered\",");
        std::println!("    \"description\": \"The roster-present blob with the middle roster ciphertext byte flipped. unseal_membership_roster must fail closed (AeadFailure), never a partial read.\",");
        std::println!("    \"case_kind\": \"roster_tampered\",");
        std::println!("    \"input_blob_hex\": \"{}\",", hex(&tampered_blob));
        std::println!("    \"input_root_key_hex\": \"{}\",", hex(&ROOT));
        std::println!("    \"input_account_number_hash_hex\": \"{}\",", hex(&ACCT));
        std::println!("    \"expected_error\": \"aead_failure\"");
        std::println!("  }},");
        std::println!("  {{");
        std::println!("    \"vector_id\": \"vault-meta/v0.2/roster-over-cap\",");
        std::println!("    \"description\": \"The roster-present blob with the u32 BE ciphertext-length field pushed past the 64 KiB cap. parse_vault_meta_v0_2 must reject the length BEFORE reading any ciphertext (InvalidVaultMeta), so the cap is enforced at the frame layer.\",");
        std::println!("    \"case_kind\": \"roster_over_cap\",");
        std::println!("    \"input_blob_hex\": \"{}\",", hex(&over_cap));
        std::println!("    \"input_root_key_hex\": \"{}\",", hex(&ROOT));
        std::println!("    \"input_account_number_hash_hex\": \"{}\",", hex(&ACCT));
        std::println!("    \"tamper_offset\": {},", len_start);
        std::println!("    \"expected_error\": \"invalid_vault_meta\"");
        std::println!("  }}");
        std::println!("]");
    }

    /// Emit a single `roster_role` vector: a real two-row canonical roster
    /// (owner + member) carrying the vault `role` field, sealed through the
    /// live codec. The roster JSON matches `myne-core`'s `encode_roster`
    /// output byte-for-byte (outer keys in BTreeMap order, per-entry fields
    /// in declaration order, default values omitted); it was derived from a
    /// run of that encoder over fixture-shaped (shape-valid) public halves,
    /// not hand-shaped. The halves here are fixture bytes of the right
    /// length, not live keypairs: key validity is pinned by the
    /// `person-keypair` vectors, while this case pins that a roster carrying
    /// roles seals, parses, and unseals through the real `vault.meta`
    /// framing. Additive: the existing roster cases are untouched.
    ///
    /// `#[ignore]` because emitting vectors is a deliberate act. Run with:
    /// `cargo test -p protocol --lib emit_roster_role_vector_for_paste -- --ignored --nocapture`
    /// and paste the printed object into
    /// `myne-test-vectors/vectors/vault-meta/v0.2/cases.json` (plus the
    /// `case_kind` enum and branch in `schema/v0.2/vault-meta.json`, plus a
    /// runner arm and coverage entry in `protocol/tests/vectors.rs`).
    #[test]
    #[ignore]
    fn emit_roster_role_vector_for_paste() {
        extern crate std;
        fn rep(unit: &str, n: usize) -> alloc::string::String {
            let mut s = alloc::string::String::new();
            for _ in 0..n {
                s.push_str(unit);
            }
            s
        }
        fn hex(b: &[u8]) -> alloc::string::String {
            let mut s = alloc::string::String::with_capacity(b.len() * 2);
            for x in b {
                s.push_str(&alloc::format!("{x:02x}"));
            }
            s
        }
        fn escape_json_str(s: &str) -> alloc::string::String {
            let mut out = alloc::string::String::with_capacity(s.len() + 2);
            out.push('"');
            for c in s.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    _ => out.push(c),
                }
            }
            out.push('"');
            out
        }
        let base = parse_vault_meta_v0_2(&encode()).expect("parse base NTV5");
        let account_id = [0xAB; MEMBERSHIP_ACCOUNT_ID_LEN];
        let mem_nonce = [0xCD; AEAD_NONCE_LEN];
        let membership = seal_membership_raw(&ROOT, &account_id, &ACCT, &mem_nonce).expect("seal");
        // Canonical two-row roster: owner ("00..") then member ("ff..") in
        // BTreeMap order. The owner spells `"role":"owner"`; the member omits
        // the default. Joined times differ so the rows are not byte-twins.
        let owner_fp = rep("00", 32);
        let member_fp = rep("ff", 32);
        let owner_row = alloc::format!(
            "\"{fp}\":{{\"fingerprint_hex\":\"{fp}\",\"display_name\":\"Owner\",\"wrapped_items_key_hex\":\"{wrap}\",\"member_kem_ek_hex\":\"{kem}\",\"member_ed_pk_hex\":\"{ed}\",\"member_mldsa_vk_hex\":\"{vk}\",\"version\":1,\"role\":\"owner\",\"joined_at\":1700000000}}",
            fp = owner_fp,
            wrap = rep("ab", 32),
            kem = rep("cd", 1184),
            ed = rep("ef", 32),
            vk = rep("01", 1952),
        );
        let member_row = alloc::format!(
            "\"{fp}\":{{\"fingerprint_hex\":\"{fp}\",\"display_name\":\"Member\",\"wrapped_items_key_hex\":\"{wrap}\",\"member_kem_ek_hex\":\"{kem}\",\"member_ed_pk_hex\":\"{ed}\",\"member_mldsa_vk_hex\":\"{vk}\",\"version\":1,\"joined_at\":1700000001}}",
            fp = member_fp,
            wrap = rep("ab", 32),
            kem = rep("cd", 1184),
            ed = rep("ef", 32),
            vk = rep("01", 1952),
        );
        let roster_plaintext = alloc::format!(
            "{{{owner},{member}}}",
            owner = owner_row,
            member = member_row
        );
        let roster_plaintext_bytes = roster_plaintext.as_bytes().to_vec();
        // Structural self-checks: the owner spells its role, the member omits
        // the default. A mismatch here means the hand-built JSON drifted from
        // `encode_roster` and the case must not ship.
        assert!(roster_plaintext.contains("\"role\":\"owner\""));
        assert!(!roster_plaintext.contains("\"role\":\"member\""));
        let roster_nonce = [0xDD; MEMBERSHIP_ROSTER_NONCE_LEN];
        let roster =
            seal_membership_roster_raw(&ROOT, &roster_plaintext_bytes, &ACCT, &roster_nonce)
                .expect("roster seal");
        let mut roster_meta = base.clone();
        roster_meta.membership = Some(Membership {
            nonce: membership.nonce,
            enc: membership.enc,
            roster: Some(roster.clone()),
        });
        let roster_blob = serialize_vault_meta_v0_2(&roster_meta);
        assert_eq!(roster_blob[5], 0x02);
        let parsed = parse_vault_meta_v0_2(&roster_blob).expect("roster meta parses");
        let back = unseal_membership_roster(
            &ROOT,
            parsed
                .membership
                .as_ref()
                .and_then(|m| m.roster.as_ref())
                .expect("roster"),
            &ACCT,
        )
        .expect("unseal");
        assert_eq!(back.as_slice(), roster_plaintext_bytes.as_slice());
        std::println!("  {{");
        std::println!("    \"vector_id\": \"vault-meta/v0.2/roster-role\",");
        std::println!("    \"description\": \"An NTV5 vault.meta with a real two-row canonical roster (owner + member) carrying the vault role field: the owner row spells role owner, the member row omits the default, sealed under membership_key with the roster AAD. parse_vault_meta_v0_2 must accept it and unseal_membership_roster must recover the exact plaintext under root_key = 0x11.., account_number_hash = 0x44..\",");
        std::println!("    \"case_kind\": \"roster_role\",");
        std::println!("    \"input_blob_hex\": \"{}\",", hex(&roster_blob));
        std::println!("    \"input_root_key_hex\": \"{}\",", hex(&ROOT));
        std::println!("    \"input_account_number_hash_hex\": \"{}\",", hex(&ACCT));
        std::println!(
            "    \"input_roster_nonce_hex\": \"{}\",",
            hex(&roster.nonce)
        );
        std::println!(
            "    \"expected_roster_plaintext_utf8\": {}",
            escape_json_str(&roster_plaintext)
        );
        std::println!("  }},");
    }
}
