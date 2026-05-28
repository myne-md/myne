//! `vault.meta` 345-byte serialization — see `docs/spec/protocol.md` § 9.3.
//!
//! `vault.meta` is the per-vault state file written once at vault
//! creation and updated when the master password changes. Its layout
//! is fixed-offset, big-endian, and load-bearing: any drift in field
//! widths or offsets silently invalidates every existing vault under
//! v0.1.
//!
//! ## On-disk layout (spec § 9.3)
//!
//! ```text
//! Offset  Size  Field                  Notes
//! ------  ----  ---------------------  ------------------------------
//! 0       4     magic                  ASCII "MYV1"
//! 4       1     protocol_version       0x01
//! 5       1     reserved               0x00 (MUST)
//! 6       16    account_number_hash    SHA-256(account)[:16] (§8, §6)
//! 22      11    kdf_params_canonical   §4.3 — kdf_id, m, t, p, version
//! 33      16    random_salt_password   per-vault random salt
//! 49      16    random_salt_recovery   per-vault random salt
//! 65      24    nonce_password_wrap    XChaCha20-Poly1305 nonce
//! 89      64    enc_root_key_password  ciphertext (32) + CTX tag (32)
//! 153     24    nonce_recovery_wrap
//! 177     64    enc_root_key_recovery
//! 241     16    items_key_id           UUIDv7 of singleton itemsKey
//! 257     24    items_key_nonce
//! 281     64    enc_items_key
//! 345     ...   future fields          reserved for v0.1.x / v005
//! ```
//!
//! The 11-byte KDF parameter block at offset 22 is bound into both
//! wrap AADs ([`crate::aad_password_wrap`], [`crate::aad_recovery_wrap`])
//! so any tampering invalidates the AEAD tag on both wrapped
//! `root_key` copies (parameter-downgrade defense, spec § 4.3).
//!
//! **Note vs PRD:** The Task 10 PRD/RFC drafts cited a 241-byte
//! length, predating the addition of the `items_key_id`,
//! `items_key_nonce`, `enc_items_key` fields. Spec § 9.3 is normative;
//! the actual on-disk size is 345 bytes.

use crate::aead::{aad_password_wrap, aead_seal_ctx, AEAD_KEY_LEN, AEAD_NONCE_LEN};
use crate::error::ProtocolError;
use crate::kdf::{derive_password_wrap_key, ARGON2_SALT_LEN};
use crate::types::{parse_kdf_params, serialize_kdf_params, KdfParams, KDF_PARAMS_CANONICAL_LEN};

/// Magic bytes at offset 0 — ASCII `"MYV1"` (Myne Vault v1).
pub const VAULT_META_MAGIC: [u8; 4] = *b"MYV1";

/// `protocol_version` byte at offset 4 — `0x01` for v0.1.
pub const VAULT_META_PROTOCOL_VERSION: u8 = 0x01;

/// `reserved` byte at offset 5 — MUST be `0x00`.
pub const VAULT_META_RESERVED: u8 = 0x00;

/// Total `vault.meta` length per spec § 9.3.
pub const VAULT_META_LEN: usize = 345;

/// Length of `account_number_hash` (`account-number.md` § 6).
pub const VAULT_META_ACCOUNT_HASH_LEN: usize = 16;

/// Length of each per-vault Argon2id random salt (spec § 3.1).
pub const VAULT_META_SALT_RANDOM_LEN: usize = 16;

/// Length of an AEAD nonce (XChaCha20 192-bit, spec § 5.1).
pub const VAULT_META_NONCE_LEN: usize = 24;

/// Length of a wrapped `root_key` blob: 32-byte ciphertext + 32-byte
/// CTX commitment tag (spec § 9.3 enc_root_key_password / _recovery).
pub const VAULT_META_WRAPPED_ROOT_KEY_LEN: usize = 64;

/// Length of `items_key_id` (UUIDv7 — 16 bytes).
pub const VAULT_META_ITEMS_KEY_ID_LEN: usize = 16;

/// Length of the wrapped `itemsKey` blob (32-byte ct + 32-byte CTX).
pub const VAULT_META_WRAPPED_ITEMS_KEY_LEN: usize = 64;

/// In-memory representation of `vault.meta` per spec § 9.3.
///
/// The fixed `magic`, `protocol_version`, and `reserved` bytes at
/// offsets 0..6 are NOT struct fields — [`serialize_vault_meta`]
/// emits the spec-mandated values and [`parse_vault_meta`] rejects
/// any input that doesn't match. Carrying them as fields would let
/// callers construct invalid values.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultMeta {
    /// SHA-256(canonical account number)[:16] (§ 6 of `account-number.md`).
    pub account_number_hash: [u8; VAULT_META_ACCOUNT_HASH_LEN],
    /// Argon2id parameters used by both wrap-key derivations.
    pub kdf_params: KdfParams,
    /// Per-vault random salt for the password Argon2id call.
    pub random_salt_password: [u8; VAULT_META_SALT_RANDOM_LEN],
    /// Per-vault random salt for the recovery-phrase Argon2id call.
    pub random_salt_recovery: [u8; VAULT_META_SALT_RANDOM_LEN],
    /// 192-bit nonce used to AEAD-wrap `root_key` under the password
    /// wrap key.
    pub nonce_password_wrap: [u8; VAULT_META_NONCE_LEN],
    /// 64-byte blob: 32-byte ciphertext of `root_key` + 32-byte CTX tag.
    pub enc_root_key_password: [u8; VAULT_META_WRAPPED_ROOT_KEY_LEN],
    /// 192-bit nonce used to AEAD-wrap `root_key` under the recovery
    /// wrap key.
    pub nonce_recovery_wrap: [u8; VAULT_META_NONCE_LEN],
    /// 64-byte blob: 32-byte ciphertext + 32-byte CTX tag (recovery path).
    pub enc_root_key_recovery: [u8; VAULT_META_WRAPPED_ROOT_KEY_LEN],
    /// UUIDv7 identifying the singleton v0.1 `itemsKey` (spec § 3.3).
    /// Stored as raw bytes; UUID-typed parsing belongs at the call site.
    pub items_key_id: [u8; VAULT_META_ITEMS_KEY_ID_LEN],
    /// 192-bit nonce used to AEAD-wrap `itemsKey` under
    /// `itemsKey_wrap_key` (derived via `derive_subkey(root, ItemsKeyWrap)`).
    pub items_key_nonce: [u8; VAULT_META_NONCE_LEN],
    /// 64-byte blob: 32-byte ciphertext of `itemsKey` + 32-byte CTX tag.
    pub enc_items_key: [u8; VAULT_META_WRAPPED_ITEMS_KEY_LEN],
}

/// Serialize `meta` to its 345-byte canonical on-disk form (spec § 9.3).
///
/// Output offsets are fixed; magic / version / reserved bytes are
/// emitted from the spec-mandated constants. The KDF parameter block
/// at offset 22 is produced by [`serialize_kdf_params`] (Task 3) and
/// occupies exactly 11 bytes.
pub fn serialize_vault_meta(meta: &VaultMeta) -> [u8; VAULT_META_LEN] {
    let mut out = [0u8; VAULT_META_LEN];
    out[0..4].copy_from_slice(&VAULT_META_MAGIC);
    out[4] = VAULT_META_PROTOCOL_VERSION;
    out[5] = VAULT_META_RESERVED;
    out[6..22].copy_from_slice(&meta.account_number_hash);
    out[22..33].copy_from_slice(&serialize_kdf_params(&meta.kdf_params));
    out[33..49].copy_from_slice(&meta.random_salt_password);
    out[49..65].copy_from_slice(&meta.random_salt_recovery);
    out[65..89].copy_from_slice(&meta.nonce_password_wrap);
    out[89..153].copy_from_slice(&meta.enc_root_key_password);
    out[153..177].copy_from_slice(&meta.nonce_recovery_wrap);
    out[177..241].copy_from_slice(&meta.enc_root_key_recovery);
    out[241..257].copy_from_slice(&meta.items_key_id);
    out[257..281].copy_from_slice(&meta.items_key_nonce);
    out[281..345].copy_from_slice(&meta.enc_items_key);
    out
}

/// Parse a 345-byte slice into a [`VaultMeta`].
///
/// Rejects with [`ProtocolError::InvalidVaultMeta`]:
/// - Slice length != 345.
/// - Magic bytes != `"MYV1"`.
/// - `protocol_version` != `0x01`.
/// - `reserved` != `0x00`.
/// - KDF parameter block invalid (bubbled from [`parse_kdf_params`]).
///
/// Per spec § 7.3 / PRD's no-`String`-in-errors rule, a single error
/// variant covers all rejection causes.
pub fn parse_vault_meta(bytes: &[u8]) -> Result<VaultMeta, ProtocolError> {
    if bytes.len() != VAULT_META_LEN {
        return Err(ProtocolError::InvalidVaultMeta);
    }
    if bytes[0..4] != VAULT_META_MAGIC {
        return Err(ProtocolError::InvalidVaultMeta);
    }
    if bytes[4] != VAULT_META_PROTOCOL_VERSION {
        return Err(ProtocolError::InvalidVaultMeta);
    }
    if bytes[5] != VAULT_META_RESERVED {
        return Err(ProtocolError::InvalidVaultMeta);
    }

    let mut account_number_hash = [0u8; VAULT_META_ACCOUNT_HASH_LEN];
    account_number_hash.copy_from_slice(&bytes[6..22]);

    let kdf_canonical: &[u8; KDF_PARAMS_CANONICAL_LEN] = bytes[22..33]
        .try_into()
        .expect("11-byte slice by construction");
    let kdf_params = parse_kdf_params(kdf_canonical)?;

    let mut random_salt_password = [0u8; VAULT_META_SALT_RANDOM_LEN];
    random_salt_password.copy_from_slice(&bytes[33..49]);

    let mut random_salt_recovery = [0u8; VAULT_META_SALT_RANDOM_LEN];
    random_salt_recovery.copy_from_slice(&bytes[49..65]);

    let mut nonce_password_wrap = [0u8; VAULT_META_NONCE_LEN];
    nonce_password_wrap.copy_from_slice(&bytes[65..89]);

    let mut enc_root_key_password = [0u8; VAULT_META_WRAPPED_ROOT_KEY_LEN];
    enc_root_key_password.copy_from_slice(&bytes[89..153]);

    let mut nonce_recovery_wrap = [0u8; VAULT_META_NONCE_LEN];
    nonce_recovery_wrap.copy_from_slice(&bytes[153..177]);

    let mut enc_root_key_recovery = [0u8; VAULT_META_WRAPPED_ROOT_KEY_LEN];
    enc_root_key_recovery.copy_from_slice(&bytes[177..241]);

    let mut items_key_id = [0u8; VAULT_META_ITEMS_KEY_ID_LEN];
    items_key_id.copy_from_slice(&bytes[241..257]);

    let mut items_key_nonce = [0u8; VAULT_META_NONCE_LEN];
    items_key_nonce.copy_from_slice(&bytes[257..281]);

    let mut enc_items_key = [0u8; VAULT_META_WRAPPED_ITEMS_KEY_LEN];
    enc_items_key.copy_from_slice(&bytes[281..345]);

    Ok(VaultMeta {
        account_number_hash,
        kdf_params,
        random_salt_password,
        random_salt_recovery,
        nonce_password_wrap,
        enc_root_key_password,
        nonce_recovery_wrap,
        enc_root_key_recovery,
        items_key_id,
        items_key_nonce,
        enc_items_key,
    })
}

/// Rewrite the password-side of an existing `vault.meta` while
/// preserving the recovery-side and items_key fields byte-for-byte.
///
/// Used by the post-recovery password commit (`vault_complete_recovery`).
/// Pure and deterministic — same inputs produce identical output bytes;
/// no internal CSPRNG, no clock. Callers generate `fresh_salt` and
/// `fresh_nonce` via OS CSPRNG before invoking this helper.
///
/// The new password wrap-key is derived under `existing.kdf_params` —
/// preserving the security parameters the vault was created under. A
/// future "params upgrade" path would derive under a fresh
/// `KdfParams` argument; today's API is YAGNI-trimmed.
///
/// Pipeline: derive password_wrap_key (Argon2id) → build AAD → AEAD-
/// seal root_key (64-byte output) → assemble VaultMeta (password-side
/// fresh, recovery-side + items_key block byte-copied from `existing`)
/// → serialize. Recovery-side preservation is `recovery-flow.md` §4.4;
/// the `enc_items_key` block's AEAD AAD binds `items_key_id`, so binary
/// copy is the only safe path (parse-and-reserialize would risk silent
/// invariant drift).
///
/// Returns `KdfFailure` on Argon2id error or `AeadFailure` on seal
/// error (latter theoretically unreachable under v0.1 AAD widths).
///
/// `myne-test-vectors/vectors/vault_meta_rewrite/` pins the byte
/// mapping for cross-implementation conformance.
pub fn rewrite_vault_meta_password_side(
    existing: &VaultMeta,
    root_key: &[u8; AEAD_KEY_LEN],
    new_password: &str,
    fresh_salt: &[u8; ARGON2_SALT_LEN],
    fresh_nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<[u8; VAULT_META_LEN], ProtocolError> {
    let kdf_params = existing.kdf_params;

    let password_wrap_key = derive_password_wrap_key(
        new_password,
        fresh_salt,
        &existing.account_number_hash,
        &kdf_params,
    )?;

    let aad = aad_password_wrap(&kdf_params);
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

    Ok(serialize_vault_meta(&new_meta))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::aead::aead_open_ctx;
    use crate::types::DEFAULT_V0_1_KDF_PARAMS;

    /// Hand-crafted fixture: every byte in every field set to a unique
    /// repeating pattern so any swap or off-by-one drift in the
    /// serializer's offset tables surfaces as a clear hex mismatch.
    fn fixture_vault_meta() -> VaultMeta {
        VaultMeta {
            account_number_hash: [0x10; VAULT_META_ACCOUNT_HASH_LEN],
            kdf_params: DEFAULT_V0_1_KDF_PARAMS,
            random_salt_password: [0x20; VAULT_META_SALT_RANDOM_LEN],
            random_salt_recovery: [0x30; VAULT_META_SALT_RANDOM_LEN],
            nonce_password_wrap: [0x40; VAULT_META_NONCE_LEN],
            enc_root_key_password: [0x50; VAULT_META_WRAPPED_ROOT_KEY_LEN],
            nonce_recovery_wrap: [0x60; VAULT_META_NONCE_LEN],
            enc_root_key_recovery: [0x70; VAULT_META_WRAPPED_ROOT_KEY_LEN],
            items_key_id: [0x80; VAULT_META_ITEMS_KEY_ID_LEN],
            items_key_nonce: [0x90; VAULT_META_NONCE_LEN],
            enc_items_key: [0xA0; VAULT_META_WRAPPED_ITEMS_KEY_LEN],
        }
    }

    #[test]
    fn vault_meta_length_is_three_hundred_forty_five_bytes() {
        // Spec § 9.3: 4 + 1 + 1 + 16 + 11 + 16 + 16 + 24 + 64 + 24 + 64
        //           + 16 + 24 + 64 = 345
        assert_eq!(VAULT_META_LEN, 345);
    }

    #[test]
    fn magic_is_ascii_myv1() {
        assert_eq!(&VAULT_META_MAGIC, b"MYV1");
    }

    #[test]
    fn serialize_emits_correct_magic_version_reserved_bytes() {
        let bytes = serialize_vault_meta(&fixture_vault_meta());
        assert_eq!(&bytes[0..4], b"MYV1");
        assert_eq!(bytes[4], 0x01);
        assert_eq!(bytes[5], 0x00);
    }

    #[test]
    fn serialize_account_hash_lands_at_offset_six() {
        let bytes = serialize_vault_meta(&fixture_vault_meta());
        assert_eq!(&bytes[6..22], &[0x10; 16][..]);
    }

    #[test]
    fn serialize_kdf_block_lands_at_offset_22() {
        // Spec § 9.3 + § 4.3: bytes 22..33 = canonical KDF params.
        let bytes = serialize_vault_meta(&fixture_vault_meta());
        let expected_kdf = serialize_kdf_params(&DEFAULT_V0_1_KDF_PARAMS);
        assert_eq!(&bytes[22..33], &expected_kdf[..]);
    }

    #[test]
    fn serialize_each_field_lands_at_spec_offset() {
        // Walk every spec § 9.3 offset/length pair and confirm the
        // serializer placed the right pattern there. If anyone shuffles
        // the field order or recomputes offsets incorrectly, exactly
        // which slice fails surfaces immediately.
        let bytes = serialize_vault_meta(&fixture_vault_meta());
        assert_eq!(&bytes[33..49], &[0x20; 16][..], "random_salt_password @ 33");
        assert_eq!(&bytes[49..65], &[0x30; 16][..], "random_salt_recovery @ 49");
        assert_eq!(&bytes[65..89], &[0x40; 24][..], "nonce_password_wrap @ 65");
        assert_eq!(
            &bytes[89..153],
            &[0x50; 64][..],
            "enc_root_key_password @ 89"
        );
        assert_eq!(
            &bytes[153..177],
            &[0x60; 24][..],
            "nonce_recovery_wrap @ 153"
        );
        assert_eq!(
            &bytes[177..241],
            &[0x70; 64][..],
            "enc_root_key_recovery @ 177"
        );
        assert_eq!(&bytes[241..257], &[0x80; 16][..], "items_key_id @ 241");
        assert_eq!(&bytes[257..281], &[0x90; 24][..], "items_key_nonce @ 257");
        assert_eq!(&bytes[281..345], &[0xA0; 64][..], "enc_items_key @ 281");
    }

    #[test]
    fn round_trip_fixture() {
        let original = fixture_vault_meta();
        let bytes = serialize_vault_meta(&original);
        let parsed = parse_vault_meta(&bytes).expect("round-trip");
        assert_eq!(parsed, original);
    }

    #[test]
    fn parse_rejects_short_slice() {
        let bytes = [0u8; VAULT_META_LEN - 1];
        assert_eq!(
            parse_vault_meta(&bytes),
            Err(ProtocolError::InvalidVaultMeta)
        );
    }

    #[test]
    fn parse_rejects_long_slice() {
        let bytes = [0u8; VAULT_META_LEN + 1];
        assert_eq!(
            parse_vault_meta(&bytes),
            Err(ProtocolError::InvalidVaultMeta)
        );
    }

    #[test]
    fn parse_rejects_wrong_magic() {
        let mut bytes = serialize_vault_meta(&fixture_vault_meta());
        bytes[0] = b'X';
        assert_eq!(
            parse_vault_meta(&bytes),
            Err(ProtocolError::InvalidVaultMeta)
        );
    }

    #[test]
    fn parse_rejects_wrong_protocol_version() {
        let mut bytes = serialize_vault_meta(&fixture_vault_meta());
        bytes[4] = 0x02;
        assert_eq!(
            parse_vault_meta(&bytes),
            Err(ProtocolError::InvalidVaultMeta)
        );
    }

    #[test]
    fn parse_rejects_nonzero_reserved_byte() {
        let mut bytes = serialize_vault_meta(&fixture_vault_meta());
        bytes[5] = 0xFF;
        assert_eq!(
            parse_vault_meta(&bytes),
            Err(ProtocolError::InvalidVaultMeta)
        );
    }

    #[test]
    fn parse_propagates_kdf_params_error_as_invalid_vault_meta() {
        // KDF parse rejects kdf_id != 0x01; that error must surface as
        // InvalidVaultMeta (not as a separate variant) so § 9.3 has a
        // single rejection class.
        let mut bytes = serialize_vault_meta(&fixture_vault_meta());
        bytes[22] = 0x02; // kdf_id = bogus
        assert_eq!(
            parse_vault_meta(&bytes),
            Err(ProtocolError::InvalidVaultMeta)
        );
    }

    // ---- rewrite_vault_meta_password_side -------------------------------
    //
    // Pure / deterministic password-side re-wrap helper used by the
    // post-recovery password commit (vault_complete_recovery / A8f).
    // The function is byte-stable: same inputs produce identical output
    // bytes; no internal CSPRNG, no clock.

    /// Fast Argon2id parameters for tests. Matches the constant used
    /// by `vault_unlock` / `vault_recover` test suites — production
    /// never uses these.
    const FAST_TEST_KDF: KdfParams = KdfParams {
        m_kib: 8,
        t: 1,
        p: 1,
        argon2_version: 0x13,
    };

    /// Distinct byte patterns for every field so any swap or off-by-one
    /// surfaces as a clear hex mismatch in test assertions. Recovery-
    /// side and items_key fields are byte-pattern fixtures (not real
    /// AEAD seals); they don't need to decrypt to anything because
    /// `rewrite_vault_meta_password_side` only byte-copies them.
    fn fixture_existing_meta() -> VaultMeta {
        VaultMeta {
            account_number_hash: [0xAC; VAULT_META_ACCOUNT_HASH_LEN],
            kdf_params: FAST_TEST_KDF,
            random_salt_password: [0x11; VAULT_META_SALT_RANDOM_LEN],
            random_salt_recovery: [0x22; VAULT_META_SALT_RANDOM_LEN],
            nonce_password_wrap: [0x33; VAULT_META_NONCE_LEN],
            enc_root_key_password: [0x44; VAULT_META_WRAPPED_ROOT_KEY_LEN],
            nonce_recovery_wrap: [0x55; VAULT_META_NONCE_LEN],
            enc_root_key_recovery: [0x66; VAULT_META_WRAPPED_ROOT_KEY_LEN],
            items_key_id: [0x77; VAULT_META_ITEMS_KEY_ID_LEN],
            items_key_nonce: [0x88; VAULT_META_NONCE_LEN],
            enc_items_key: [0x99; VAULT_META_WRAPPED_ITEMS_KEY_LEN],
        }
    }

    const TEST_ROOT_KEY: [u8; AEAD_KEY_LEN] = [0xCC; AEAD_KEY_LEN];
    const TEST_FRESH_SALT: [u8; ARGON2_SALT_LEN] = [0xEF; ARGON2_SALT_LEN];
    const TEST_FRESH_NONCE: [u8; AEAD_NONCE_LEN] = [0xFE; AEAD_NONCE_LEN];

    #[test]
    fn rewrite_password_side_is_deterministic() {
        // Same inputs → same output bytes across two independent calls.
        // Pure-function discipline; no internal CSPRNG.
        let existing = fixture_existing_meta();
        let a = rewrite_vault_meta_password_side(
            &existing,
            &TEST_ROOT_KEY,
            "new-pw",
            &TEST_FRESH_SALT,
            &TEST_FRESH_NONCE,
        )
        .unwrap();
        let b = rewrite_vault_meta_password_side(
            &existing,
            &TEST_ROOT_KEY,
            "new-pw",
            &TEST_FRESH_SALT,
            &TEST_FRESH_NONCE,
        )
        .unwrap();
        assert_eq!(a, b, "rewrite must be byte-deterministic");
    }

    #[test]
    fn rewrite_preserves_recovery_side_byte_byte() {
        // recovery-flow.md § 4.4: random_salt_recovery,
        // nonce_recovery_wrap, enc_root_key_recovery byte-preserved.
        let existing = fixture_existing_meta();
        let bytes = rewrite_vault_meta_password_side(
            &existing,
            &TEST_ROOT_KEY,
            "new-pw",
            &TEST_FRESH_SALT,
            &TEST_FRESH_NONCE,
        )
        .unwrap();
        let parsed = parse_vault_meta(&bytes).expect("output round-trips");
        assert_eq!(parsed.random_salt_recovery, existing.random_salt_recovery);
        assert_eq!(parsed.nonce_recovery_wrap, existing.nonce_recovery_wrap);
        assert_eq!(parsed.enc_root_key_recovery, existing.enc_root_key_recovery);
    }

    #[test]
    fn rewrite_preserves_enc_items_key_block_byte_byte() {
        // Spec § 9.3 offset 281–344 — items_key_nonce + enc_items_key
        // share the AAD-bound `items_key_id`; binary copy is the only
        // way to keep the AEAD tag valid without re-deriving items_key.
        let existing = fixture_existing_meta();
        let bytes = rewrite_vault_meta_password_side(
            &existing,
            &TEST_ROOT_KEY,
            "new-pw",
            &TEST_FRESH_SALT,
            &TEST_FRESH_NONCE,
        )
        .unwrap();
        // Direct byte slice comparison at the spec offsets — stronger
        // than parse-then-compare because it catches any serializer-
        // side reshuffling of the items_key block.
        assert_eq!(
            &bytes[257..281],
            &existing.items_key_nonce[..],
            "items_key_nonce @ offset 257 must byte-equal existing"
        );
        assert_eq!(
            &bytes[281..345],
            &existing.enc_items_key[..],
            "enc_items_key @ offset 281 must byte-equal existing"
        );
    }

    #[test]
    fn rewrite_preserves_account_number_hash() {
        let existing = fixture_existing_meta();
        let bytes = rewrite_vault_meta_password_side(
            &existing,
            &TEST_ROOT_KEY,
            "new-pw",
            &TEST_FRESH_SALT,
            &TEST_FRESH_NONCE,
        )
        .unwrap();
        let parsed = parse_vault_meta(&bytes).unwrap();
        assert_eq!(parsed.account_number_hash, existing.account_number_hash);
    }

    #[test]
    fn rewrite_preserves_items_key_id() {
        let existing = fixture_existing_meta();
        let bytes = rewrite_vault_meta_password_side(
            &existing,
            &TEST_ROOT_KEY,
            "new-pw",
            &TEST_FRESH_SALT,
            &TEST_FRESH_NONCE,
        )
        .unwrap();
        let parsed = parse_vault_meta(&bytes).unwrap();
        assert_eq!(parsed.items_key_id, existing.items_key_id);
    }

    #[test]
    fn rewrite_password_side_round_trips_root_key() {
        // The strong end-to-end invariant: derive password_wrap_key
        // from the new password + fresh salt + KdfParams + existing
        // account_hash; AEAD-decrypt the output's enc_root_key_password
        // using the new nonce and AAD; recovered bytes must equal the
        // input root_key.
        let existing = fixture_existing_meta();
        let bytes = rewrite_vault_meta_password_side(
            &existing,
            &TEST_ROOT_KEY,
            "new-pw",
            &TEST_FRESH_SALT,
            &TEST_FRESH_NONCE,
        )
        .unwrap();
        let parsed = parse_vault_meta(&bytes).unwrap();

        // New nonce_password_wrap == fresh nonce; new
        // random_salt_password == fresh salt.
        assert_eq!(parsed.nonce_password_wrap, TEST_FRESH_NONCE);
        assert_eq!(parsed.random_salt_password, TEST_FRESH_SALT);

        // Re-derive the wrap key the way unlock would.
        let wrap_key = derive_password_wrap_key(
            "new-pw",
            &parsed.random_salt_password,
            &parsed.account_number_hash,
            &parsed.kdf_params,
        )
        .unwrap();
        let aad = aad_password_wrap(&parsed.kdf_params);
        let recovered_root_key = aead_open_ctx(
            &wrap_key,
            &parsed.nonce_password_wrap,
            &parsed.enc_root_key_password,
            &aad,
        )
        .expect("AEAD-open must succeed against the rewritten password side");
        assert_eq!(recovered_root_key.as_slice(), &TEST_ROOT_KEY[..]);
    }

    #[test]
    fn rewrite_output_round_trips_through_parse_vault_meta() {
        // Output bytes parse cleanly with no `ProtocolError`. Catches
        // any drift in magic / version / reserved / KDF block layout
        // that `serialize_vault_meta` could introduce.
        let existing = fixture_existing_meta();
        let bytes = rewrite_vault_meta_password_side(
            &existing,
            &TEST_ROOT_KEY,
            "new-pw",
            &TEST_FRESH_SALT,
            &TEST_FRESH_NONCE,
        )
        .unwrap();
        parse_vault_meta(&bytes).expect("output must parse cleanly");
    }

    #[test]
    fn rewrite_with_default_kdf_params_succeeds() {
        // Smoke test against the canonical v0.1 KDF parameter block
        // (`m=256 MiB, t=3, p=2`). This is slow (~1 s of Argon2id) so
        // we only run it once to confirm the helper does not silently
        // depend on test-only parameter values.
        let mut existing = fixture_existing_meta();
        existing.kdf_params = DEFAULT_V0_1_KDF_PARAMS;
        let bytes = rewrite_vault_meta_password_side(
            &existing,
            &TEST_ROOT_KEY,
            "new-pw",
            &TEST_FRESH_SALT,
            &TEST_FRESH_NONCE,
        )
        .expect("rewrite with DEFAULT_V0_1_KDF_PARAMS must succeed");
        let parsed = parse_vault_meta(&bytes).unwrap();
        // KdfParams equality compares each field; canonical params
        // round-trip cleanly.
        assert_eq!(parsed.kdf_params, DEFAULT_V0_1_KDF_PARAMS);
    }

    #[test]
    fn rewrite_different_passwords_produce_different_output() {
        // Sanity guard: changing only the password (with all other
        // inputs fixed) yields different output bytes — at minimum the
        // enc_root_key_password block differs.
        let existing = fixture_existing_meta();
        let a = rewrite_vault_meta_password_side(
            &existing,
            &TEST_ROOT_KEY,
            "password-a",
            &TEST_FRESH_SALT,
            &TEST_FRESH_NONCE,
        )
        .unwrap();
        let b = rewrite_vault_meta_password_side(
            &existing,
            &TEST_ROOT_KEY,
            "password-b",
            &TEST_FRESH_SALT,
            &TEST_FRESH_NONCE,
        )
        .unwrap();
        assert_ne!(a, b, "different passwords must yield different output");
        // Specifically: enc_root_key_password differs at offset 89..153.
        assert_ne!(&a[89..153], &b[89..153]);
        // But recovery-side and items_key bytes are identical (byte-
        // preserved from `existing` regardless of password).
        assert_eq!(&a[153..345], &b[153..345]);
    }

    /// One-shot helper: dump the byte-stable output of
    /// `rewrite_vault_meta_password_side` for a canonical fixed input
    /// set to `/tmp/myne_vault_meta_rewrite_vector.txt`, ready for
    /// paste into
    /// `myne-test-vectors/vectors/vault_meta_rewrite/v0.1/cases.json`.
    ///
    /// `#[ignore]` because regenerating vectors should be a deliberate
    /// act, not a side effect of `cargo test`. Run with
    /// `cargo test -p protocol --lib emit_vector_hex_for_paste -- --ignored`.
    /// Uses `std::fs::write` (test target links std even when the
    /// crate proper is `#![no_std]`) to avoid any `println!`-in-no_std
    /// awkwardness.
    #[test]
    #[ignore]
    fn emit_vector_hex_for_paste() {
        extern crate std;
        let existing = fixture_existing_meta();
        let existing_bytes = serialize_vault_meta(&existing);

        let bytes = rewrite_vault_meta_password_side(
            &existing,
            &TEST_ROOT_KEY,
            "new-pw",
            &TEST_FRESH_SALT,
            &TEST_FRESH_NONCE,
        )
        .unwrap();

        let mut dump = alloc::string::String::new();
        dump.push_str("---begin vector---\n");
        dump.push_str(&alloc::format!(
            "existing_vault_meta_hex: {}\n",
            hex_lower(&existing_bytes)
        ));
        dump.push_str(&alloc::format!(
            "root_key_hex: {}\n",
            hex_lower(&TEST_ROOT_KEY)
        ));
        dump.push_str(&alloc::format!(
            "new_password_utf8_hex: {}\n",
            hex_lower(b"new-pw")
        ));
        dump.push_str(&alloc::format!(
            "fresh_salt_hex: {}\n",
            hex_lower(&TEST_FRESH_SALT)
        ));
        dump.push_str(&alloc::format!(
            "fresh_nonce_hex: {}\n",
            hex_lower(&TEST_FRESH_NONCE)
        ));
        dump.push_str(&alloc::format!(
            "kdf_params: m_kib={} t={} p={} argon2_version=0x{:02x}\n",
            FAST_TEST_KDF.m_kib,
            FAST_TEST_KDF.t,
            FAST_TEST_KDF.p,
            FAST_TEST_KDF.argon2_version,
        ));
        dump.push_str(&alloc::format!(
            "expected_vault_meta_hex: {}\n",
            hex_lower(&bytes)
        ));
        dump.push_str("---end vector---\n");
        std::fs::write("/tmp/myne_vault_meta_rewrite_vector.txt", dump.as_bytes())
            .expect("write vector dump");
    }

    fn hex_lower(bytes: &[u8]) -> alloc::string::String {
        let mut s = alloc::string::String::with_capacity(bytes.len() * 2);
        for b in bytes {
            s.push_str(&alloc::format!("{:02x}", b));
        }
        s
    }

    #[test]
    fn rewrite_different_salts_produce_different_password_wrap_keys() {
        // Sanity guard: same password + different fresh_salt yields
        // different output (KDF salt enters Argon2id).
        let existing = fixture_existing_meta();
        let a = rewrite_vault_meta_password_side(
            &existing,
            &TEST_ROOT_KEY,
            "new-pw",
            &TEST_FRESH_SALT,
            &TEST_FRESH_NONCE,
        )
        .unwrap();
        let alt_salt: [u8; ARGON2_SALT_LEN] = [0xAA; ARGON2_SALT_LEN];
        let b = rewrite_vault_meta_password_side(
            &existing,
            &TEST_ROOT_KEY,
            "new-pw",
            &alt_salt,
            &TEST_FRESH_NONCE,
        )
        .unwrap();
        assert_ne!(a, b);
        // Salt @ offset 33..49 must be different by construction.
        assert_eq!(&a[33..49], &TEST_FRESH_SALT[..]);
        assert_eq!(&b[33..49], &alt_salt[..]);
    }
}
