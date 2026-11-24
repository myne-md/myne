// SPDX-License-Identifier: AGPL-3.0-only
//! Offensive red-team: integrity of the OTHER encrypted containers —
//! attachment blobs (MYA1) and the vault.meta wrapped-root-key (MYV1).
//!
//! Each test mounts a tamper/forgery and asserts rejection. A pass means an
//! attacker who can rewrite these on-disk structures cannot forge content or
//! the wrapped key. vault.meta uses WEAK Argon2 params only to keep the
//! key-derivation fast; integrity is independent of cost.

use protocol::{
    aad_password_wrap, aead_open_ctx, aead_seal_ctx, decode_attachment_blob,
    derive_password_wrap_key, encode_attachment_blob, parse_kdf_params, parse_vault_meta,
    serialize_vault_meta, validate_kdf_params, KdfParams, VaultMeta,
};

// ───────────────────────── Attachment (MYA1) integrity ────────────────────

const ITEMS_KEY: [u8; 32] = [0x07; 32];
const ITEMS_KEY_ID: [u8; 16] = [0xAB; 16];
const ATT_ID: [u8; 32] = [0x33; 32];
const CONTENT_TYPE: &[u8] = b"image/png";
const FILE: &[u8] = b"\x89PNG\r\n\x1a\n....secret attachment bytes....";

fn fresh_attachment() -> Vec<u8> {
    encode_attachment_blob(&ITEMS_KEY, &ITEMS_KEY_ID, &ATT_ID, CONTENT_TYPE, FILE).expect("encode")
}

#[test]
fn baseline_attachment_roundtrips() {
    let blob = fresh_attachment();
    let pt = decode_attachment_blob(&blob, &ATT_ID, CONTENT_TYPE, &ITEMS_KEY, &ITEMS_KEY_ID)
        .expect("decode");
    assert_eq!(&pt[..], FILE);
}

/// Exhaustive single-byte forgery on the attachment blob: every mutation
/// must be rejected.
#[test]
fn battery8_attachment_every_byte_mutation_rejected() {
    let blob = fresh_attachment();
    let mut accepted = Vec::new();
    for i in 0..blob.len() {
        let mut m = blob.clone();
        m[i] ^= 0xFF;
        if decode_attachment_blob(&m, &ATT_ID, CONTENT_TYPE, &ITEMS_KEY, &ITEMS_KEY_ID).is_ok() {
            accepted.push(i);
        }
    }
    assert!(
        accepted.is_empty(),
        "ATTACHMENT FORGERY: mutations accepted at {accepted:?}"
    );
}

/// content_type is AAD-bound: decrypting the same blob while claiming a
/// different MIME type must fail (prevents type-confusion).
#[test]
fn battery8_attachment_content_type_binding() {
    let blob = fresh_attachment();
    assert!(
        decode_attachment_blob(&blob, &ATT_ID, b"text/html", &ITEMS_KEY, &ITEMS_KEY_ID).is_err(),
        "content_type not authenticated — type-confusion possible"
    );
}

/// attachment_id is AAD-bound: a blob can't be replayed under a different
/// attachment identity.
#[test]
fn battery8_attachment_id_replay_rejected() {
    let blob = fresh_attachment();
    let other_id = [0x44; 32];
    assert!(
        decode_attachment_blob(&blob, &other_id, CONTENT_TYPE, &ITEMS_KEY, &ITEMS_KEY_ID).is_err(),
        "attachment_id replay not prevented"
    );
}

// ───────────────────────── vault.meta (MYV1) integrity ────────────────────

const WEAK: KdfParams = KdfParams {
    m_kib: 8,
    t: 1,
    p: 1,
    argon2_version: 0x13,
};
const PW: &str = "correct horse battery staple";
const SALT_PW: [u8; 16] = [0x31; 16];
const ACCT_HASH: [u8; 16] = [0x42; 16];
const NONCE_PW: [u8; 24] = [0x66; 24];
const ROOT_KEY: [u8; 32] = [0x55; 32];

/// Build a real serialized vault.meta whose password-wrapped root_key we can
/// then attack. Recovery + items_key regions are dummy (not under test).
fn build_meta() -> VaultMeta {
    let wrap_key = derive_password_wrap_key(PW, &SALT_PW, &ACCT_HASH, &WEAK).expect("wrap key");
    let aad = aad_password_wrap(&WEAK);
    let sealed = aead_seal_ctx(&wrap_key, &NONCE_PW, &ROOT_KEY, &aad).expect("seal");
    let mut enc_root = [0u8; 64];
    enc_root.copy_from_slice(&sealed);
    VaultMeta {
        account_number_hash: ACCT_HASH,
        kdf_params: WEAK,
        random_salt_password: SALT_PW,
        random_salt_recovery: [0; 16],
        nonce_password_wrap: NONCE_PW,
        enc_root_key_password: enc_root,
        nonce_recovery_wrap: [0; 24],
        enc_root_key_recovery: [0; 64],
        items_key_id: [0; 16],
        items_key_nonce: [0; 24],
        enc_items_key: [0; 64],
        membership: None,
        person_binding: None,
    }
}

/// Unwrap root_key from a (possibly tampered) parsed meta using the correct
/// password. Returns the recovered key bytes on success.
fn try_unwrap(meta: &VaultMeta) -> Option<[u8; 32]> {
    let wrap_key = derive_password_wrap_key(
        PW,
        &meta.random_salt_password,
        &meta.account_number_hash,
        &meta.kdf_params,
    )
    .ok()?;
    let aad = aad_password_wrap(&meta.kdf_params);
    let pt = aead_open_ctx(
        &wrap_key,
        &meta.nonce_password_wrap,
        &meta.enc_root_key_password,
        &aad,
    )
    .ok()?;
    let mut k = [0u8; 32];
    k.copy_from_slice(&pt);
    Some(k)
}

#[test]
fn baseline_vault_meta_unwraps_root_key() {
    let meta = build_meta();
    let bytes = serialize_vault_meta(&meta);
    let parsed = parse_vault_meta(&bytes).expect("parse");
    assert_eq!(
        try_unwrap(&parsed),
        Some(ROOT_KEY),
        "baseline unwrap must recover root_key"
    );
}

/// Forge the wrapped root_key: flip every byte of `enc_root_key_password`
/// (the 64-byte ciphertext+commitment) — none may still unwrap.
#[test]
fn battery8_vault_meta_wrapped_root_key_unforgeable() {
    let meta = build_meta();
    let mut accepted = Vec::new();
    for i in 0..64 {
        let mut m = meta.clone();
        m.enc_root_key_password[i] ^= 0xFF;
        if try_unwrap(&m).is_some() {
            accepted.push(i);
        }
    }
    assert!(
        accepted.is_empty(),
        "VAULT.META FORGERY: enc_root_key bytes {accepted:?} still unwrapped"
    );
}

/// Flip every byte of the password-wrap nonce — none may still unwrap.
#[test]
fn battery8_vault_meta_nonce_tamper_rejected() {
    let meta = build_meta();
    let mut accepted = Vec::new();
    for i in 0..24 {
        let mut m = meta.clone();
        m.nonce_password_wrap[i] ^= 0xFF;
        if try_unwrap(&m).is_some() {
            accepted.push(i);
        }
    }
    assert!(
        accepted.is_empty(),
        "VAULT.META nonce tamper accepted at {accepted:?}"
    );
}

/// KDF-params tamper is defeated by AAD binding: bumping t (cost) on an
/// existing vault.meta must break the unwrap. This empirically confirms the
/// mitigation that bounds the KDF-downgrade finding — a pure tamper of an
/// existing vault cannot downgrade it to a usable weak-params vault.
#[test]
fn battery8_vault_meta_param_tamper_breaks_unwrap() {
    let meta = build_meta();
    let mut tampered = meta.clone();
    tampered.kdf_params = KdfParams { t: 2, ..WEAK }; // t 1 -> 2 (still cheap)
    assert_eq!(
        try_unwrap(&tampered),
        None,
        "params tamper did NOT break unwrap — AAD binding mitigation failed"
    );
}

/// FIX VERIFIED (ceiling): a tampered vault.meta declaring m_kib = 4 TiB
/// still PARSES (encoding layer permissive), but `validate_kdf_params` —
/// called before any `derive_*` on the unlock path — REJECTS it, so the
/// multi-terabyte allocation never happens. This closes the pre-auth
/// OOM/DoS facet. We never derive here; parse + validate prove the gate.
#[test]
fn ceiling_rejects_oom_memory_cost() {
    let huge: [u8; 11] = [0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 1, 1, 0x13];
    let parsed = parse_kdf_params(&huge).expect("encoding layer still parses");
    assert_eq!(parsed.m_kib, 0xFFFF_FFFF, "parser remains permissive");
    assert!(
        validate_kdf_params(&parsed).is_err(),
        "CEILING REGRESSION: 4 TiB m_kib accepted by validate_kdf_params (OOM DoS)"
    );
}
