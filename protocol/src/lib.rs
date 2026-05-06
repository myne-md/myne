//! Myne v0.1 cryptographic protocol primitives.
//!
//! This crate is `#![no_std]` + `alloc`. It provides every cryptographic
//! primitive the desktop client needs to create, unlock, and persist a Myne
//! vault. State (e.g. in-flight vault-creation sessions) lives in callers,
//! not here — the crate is composed of pure functions and value types.
//!
//! The protocol specification lives at `docs/spec/protocol.md` (in the main
//! `myne` repository). Each `pub` function carries a doc comment naming its
//! protocol section so reviewers can walk spec → code by following imports.
//!
//! Library choice (`hkdf`, `argon2`, `chacha20poly1305`, `sha2`, `zeroize`,
//! `getrandom`, `bip39`) is recorded in `docs/decisions.md`
//! "2026-04-28 — Rust-side primitives: RustCrypto stack as primary".

#![no_std]
#![forbid(unsafe_code)]

extern crate alloc;

/// Per-note plaintext upper bound, inclusive (`16 MiB`). The per-note
/// `.myn` blob's `ciphertext_len` field (`docs/spec/protocol.md` § 9.2,
/// 4-byte big-endian at offset 72+N) is capped at
/// `MAX_PLAINTEXT_LEN + 32` — the trailing `+ 32` is the CTX commitment
/// tag that follows the ciphertext.
///
/// **Encoder symmetry.** The encoder rejects `plaintext.len() >
/// MAX_PLAINTEXT_LEN` at the boundary with
/// [`ProtocolError::PlaintextTooLarge`]; the decoder rejects
/// `ciphertext_len > MAX_PLAINTEXT_LEN + 32` as a parse-level failure
/// **before** any allocation that would scale with the advertised
/// length. Without the cap, a hostile blob declaring
/// `ciphertext_len = 0xFFFFFFFF` would attempt a ~4 GiB allocation
/// before any AEAD verification could fire (the CTX commitment check
/// is post-allocation by construction).
///
/// Pinned by `docs/decisions.md` 2026-05-06 entry; spec amendment in
/// `docs/spec/protocol.md` § 9.2 (SHOULD-tone). Larger payloads belong
/// to the Phase 1.5+ attachment subsystem (spec § 11).
pub const MAX_PLAINTEXT_LEN: usize = 16 * 1024 * 1024;

pub mod account_number;
pub mod aead;
pub mod blob;
pub mod error;
pub mod kdf;
pub mod password_policy;
pub mod phrase;
pub mod subkey;
pub mod types;
pub mod vault_meta;

pub use account_number::{
    generate_account_number, parse_account_number, AccountNumber, ACCOUNT_NUMBER_HASH_LEN,
};
pub use aead::{
    aad_note_content_encrypt, aad_note_item_key_wrap, aad_password_wrap, aad_recovery_wrap,
    aad_vault_items_key_wrap, aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN, AEAD_NONCE_LEN,
    CTX_COMMITMENT_TAG_LEN,
};
pub use blob::{
    decode_note, encode_new_note, encode_new_note_blob_raw, encode_update, encode_update_blob_raw,
    DecryptError, DecryptedNote,
};
pub use error::ProtocolError;
pub use kdf::{
    derive_password_wrap_key, derive_recovery_wrap_key, derive_recovery_wrap_key_from_normalized,
    ARGON2_OUTPUT_LEN, ARGON2_SALT_LEN,
};
pub use password_policy::{validate_min_length, MIN_PASSWORD_LEN};
pub use phrase::{
    generate_recovery_phrase, normalize_user_phrase, RecoveryPhrase, RECOVERY_PHRASE_ENTROPY_BYTES,
    RECOVERY_PHRASE_WORD_COUNT,
};
pub use subkey::{derive_subkey, SubkeyRole};
pub use types::{
    generate_root_key, parse_kdf_params, serialize_kdf_params, KdfParams, DEFAULT_V0_1_KDF_PARAMS,
    KDF_PARAMS_CANONICAL_LEN,
};
pub use vault_meta::{
    parse_vault_meta, rewrite_vault_meta_password_side, serialize_vault_meta, VaultMeta,
    VAULT_META_ACCOUNT_HASH_LEN, VAULT_META_ITEMS_KEY_ID_LEN, VAULT_META_LEN, VAULT_META_MAGIC,
    VAULT_META_NONCE_LEN, VAULT_META_PROTOCOL_VERSION, VAULT_META_RESERVED,
    VAULT_META_SALT_RANDOM_LEN, VAULT_META_WRAPPED_ITEMS_KEY_LEN, VAULT_META_WRAPPED_ROOT_KEY_LEN,
};
