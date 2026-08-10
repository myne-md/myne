// SPDX-License-Identifier: AGPL-3.0
//! `NTV5` next-major (v0.2) `vault.meta` codec — the whole-vault-migration key
//! hierarchy (`docs/spec/protocol.md` §10.4.1, automerge-sync-migration #420).
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
    aad_password_wrap_v0_2, aad_recovery_wrap_v0_2, aad_vault_items_key_wrap_v0_2, aead_open_ctx,
    aead_seal_ctx, AEAD_KEY_LEN, AEAD_NONCE_LEN,
};
use crate::error::ProtocolError;
use crate::kdf::{
    derive_password_wrap_key_v0_2, derive_recovery_wrap_key_from_normalized_v0_2, ARGON2_SALT_LEN,
};
use crate::subkey::{derive_subkey_v0_2, SubkeyRole};
use crate::types::{KdfParams, MetaVersion};
use crate::vault_meta::{
    parse_vault_meta, serialize_vault_meta, VaultMeta, VAULT_META_ITEMS_KEY_ID_LEN, VAULT_META_LEN,
    VAULT_META_MAGIC, VAULT_META_PROTOCOL_VERSION, VAULT_META_WRAPPED_ITEMS_KEY_LEN,
    VAULT_META_WRAPPED_ROOT_KEY_LEN,
};
use zeroize::Zeroizing;

/// `NTV5` magic (offset 0) — the v0.2 `vault.meta` family (`protocol.md` §10.3
/// registry). "Myne Next-major vault v5" placeholder, finalized for v0.2 by #420.
pub const VAULT_META_V0_2_MAGIC: [u8; 4] = *b"NTV5";

/// `protocol_version` byte (offset 4) for the v0.2 `vault.meta` — `0x02`.
pub const VAULT_META_V0_2_PROTOCOL_VERSION: u8 = 0x02;

/// Serialize a [`VaultMeta`] as an `NTV5` (v0.2) blob — byte-identical to the
/// `MYV1` layout (§9.3) with the `NTV5` magic + `0x02` version. The field bytes
/// are produced by the shared [`serialize_vault_meta`], so a v0.1/v0.2 layout
/// drift is impossible by construction.
pub fn serialize_vault_meta_v0_2(meta: &VaultMeta) -> [u8; VAULT_META_LEN] {
    let mut out = serialize_vault_meta(meta);
    out[0..4].copy_from_slice(&VAULT_META_V0_2_MAGIC);
    out[4] = VAULT_META_V0_2_PROTOCOL_VERSION;
    out
}

/// Parse a 345-byte `NTV5` slice into a [`VaultMeta`]. Rejects a wrong length,
/// non-`NTV5` magic, or non-`0x02` version with [`ProtocolError::InvalidVaultMeta`].
///
/// After validating the magic + version, it delegates the field extraction to the
/// shared [`parse_vault_meta`] by presenting the identical trailing bytes under
/// the v0.1 magic/version — `NTV5` and `MYV1` differ ONLY in bytes `[0..5]`, and
/// no extracted field lives there — so the two parsers can never disagree about
/// what a byte at any later offset means.
pub fn parse_vault_meta_v0_2(bytes: &[u8]) -> Result<VaultMeta, ProtocolError> {
    if bytes.len() != VAULT_META_LEN {
        return Err(ProtocolError::InvalidVaultMeta);
    }
    if bytes[0..4] != VAULT_META_V0_2_MAGIC {
        return Err(ProtocolError::InvalidVaultMeta);
    }
    if bytes[4] != VAULT_META_V0_2_PROTOCOL_VERSION {
        return Err(ProtocolError::InvalidVaultMeta);
    }
    let mut as_v0_1 = [0u8; VAULT_META_LEN];
    as_v0_1.copy_from_slice(bytes);
    as_v0_1[0..4].copy_from_slice(&VAULT_META_MAGIC);
    as_v0_1[4] = VAULT_META_PROTOCOL_VERSION;
    parse_vault_meta(&as_v0_1)
}

/// Classify a `vault.meta` blob by its magic — `MYV1` → [`MetaVersion::V0_1`],
/// `NTV5` → [`MetaVersion::V0_2`], anything else → `None`. Every version-aware
/// reader uses this to pick its crypto generation from the vault it just read.
pub fn meta_version_of(bytes: &[u8]) -> Option<MetaVersion> {
    match bytes.get(0..4) {
        Some(m) if m == VAULT_META_MAGIC.as_slice() => Some(MetaVersion::V0_1),
        Some(m) if m == VAULT_META_V0_2_MAGIC.as_slice() => Some(MetaVersion::V0_2),
        _ => None,
    }
}

/// Parse a `vault.meta` of EITHER generation into a [`VaultMeta`], dispatching on
/// the magic: `NTV5` → [`parse_vault_meta_v0_2`], otherwise the v0.1
/// [`parse_vault_meta`]. The extracted fields (`account_number_hash`,
/// `kdf_params`, `items_key_id`, the wrapped keys) live at identical offsets in
/// both layouts, so a caller that only needs those fields is version-agnostic —
/// which is exactly what lets every singleton/index/sync reader keep working on a
/// migrated vault without a bespoke NTV5 branch.
pub fn parse_vault_meta_any(bytes: &[u8]) -> Result<VaultMeta, ProtocolError> {
    if bytes.get(0..4) == Some(VAULT_META_V0_2_MAGIC.as_slice()) {
        parse_vault_meta_v0_2(bytes)
    } else {
        parse_vault_meta(bytes)
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
    };
    Ok(serialize_vault_meta_v0_2(&meta))
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
) -> Result<[u8; VAULT_META_LEN], ProtocolError> {
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
    };
    Ok(serialize_vault_meta_v0_2(&new_meta))
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
}
