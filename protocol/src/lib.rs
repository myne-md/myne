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

pub mod account_number;
pub mod aead;
pub mod error;
pub mod kdf;
pub mod phrase;
pub mod subkey;
pub mod types;
pub mod vault_meta;

pub use account_number::{
    generate_account_number, parse_account_number, AccountNumber, ACCOUNT_NUMBER_HASH_LEN,
};
pub use aead::{
    aad_items_key_wrap, aad_password_wrap, aad_recovery_wrap, aead_open_ctx, aead_seal_ctx,
    AEAD_KEY_LEN, AEAD_NONCE_LEN, CTX_COMMITMENT_TAG_LEN,
};
pub use error::ProtocolError;
pub use kdf::{
    derive_password_wrap_key, derive_recovery_wrap_key, derive_recovery_wrap_key_from_normalized,
    ARGON2_OUTPUT_LEN, ARGON2_SALT_LEN,
};
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
