// SPDX-License-Identifier: AGPL-3.0
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
//! `getrandom`, `bip39`) is recorded in `design-notes.md`
//! "2026-04-28 — Rust-side primitives: RustCrypto stack as primary".

#![no_std]
#![forbid(unsafe_code)]
// Coverage hygiene: when measured under `cargo +nightly llvm-cov`
// (cargo-llvm-cov sets `cfg(coverage_nightly)`), enable the
// `coverage_attribute` feature so the inline `#[cfg(test)] mod tests`
// blocks can opt out of coverage via `#[coverage(off)]`. Unit-test code —
// including the `#[ignore]`d vector-emitter helpers — is not product code,
// so counting it deflates the figure (mirrors the frontend, whose tests
// live outside `src/` and never enter the denominator). On the pinned
// stable toolchain `cfg(coverage_nightly)` is false, so this is inert and
// `cargo test`/`build`/`clippy` are unaffected.
#![cfg_attr(coverage_nightly, feature(coverage_attribute))]

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
/// Pinned by `design-notes.md` 2026-05-06 entry; spec amendment in
/// `docs/spec/protocol.md` § 9.2 (SHOULD-tone). Larger payloads belong
/// to the Phase 1.5+ attachment subsystem (spec § 11).
pub const MAX_PLAINTEXT_LEN: usize = 16 * 1024 * 1024;

pub mod account_number;
pub mod aead;
pub mod attachment_blob;
pub mod attachment_text_blob;
pub mod attachments_catalog;
pub mod blob;
pub(crate) mod blob_envelope;
pub(crate) mod canonical_json;
pub mod capture_blob;
pub mod dictionary_blob;
pub mod embeddings_blob;
pub mod error;
pub mod graph_layout_blob;
pub mod kdf;
pub mod manifest;
pub mod paired_extension;
pub mod password_policy;
pub mod phrase;
pub mod prefs;
pub mod quick_unlock_blob;
pub mod saved_view;
pub mod scram;
pub mod search_blob;
pub mod share_import_blob;
pub mod subkey;
pub mod template;
pub mod themes_blob;
pub mod types;
pub mod vault_head;
pub mod vault_indices_blob;
pub mod vault_meta;
pub mod workspace_blob;

/// Test-only shared formatting helpers (`hex_lower` / `json_escape`) for the
/// `#[ignore]`-gated vector generators. Compiled only under `#[cfg(test)]`.
#[cfg(test)]
pub(crate) mod test_vector_fmt;

pub use account_number::{
    damm32_table, generate_account_number, parse_account_number, AccountNumber,
    ACCOUNT_NUMBER_HASH_LEN,
};
pub use aead::{
    aad_ai_embeddings_blob, aad_attachment_text_blob, aad_custom_themes_blob,
    aad_graph_layout_blob, aad_note_content_encrypt, aad_note_item_key_wrap, aad_password_wrap,
    aad_personal_dictionary_blob, aad_prefs_blob, aad_quick_unlock_blob, aad_recovery_wrap,
    aad_search_index_blob, aad_vault_indices_blob, aad_vault_items_key_wrap, aad_workspace_blob,
    aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN, AEAD_NONCE_LEN, CTX_COMMITMENT_TAG_LEN,
};
pub use attachment_blob::{
    aad_encrypt_attachment, aad_wrap_attachment_key, compute_attachment_id, decode_attachment_blob,
    encode_attachment_blob, encode_attachment_blob_raw, AttachmentBlobError, ATTACHMENT_BLOB_MAGIC,
    ATTACHMENT_BLOB_PROTOCOL_VERSION, ATTACHMENT_BLOB_RESERVED, ATTACHMENT_ID_LEN,
    MAX_ATTACHMENT_LEN,
};
pub use attachment_text_blob::{
    decode_attachment_text_blob, encode_attachment_text_blob, encode_attachment_text_blob_raw,
    AttachmentTextBlobError, ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN,
    ATTACHMENT_TEXT_BLOB_EXTRACTOR_VERSION, ATTACHMENT_TEXT_BLOB_HEADER_LEN,
    ATTACHMENT_TEXT_BLOB_MAGIC, ATTACHMENT_TEXT_BLOB_PROTOCOL_VERSION,
    MAX_ATTACHMENT_TEXT_PLAINTEXT_LEN,
};
pub use attachments_catalog::{
    aad_attachments_catalog, decode_attachments_catalog, encode_attachments_catalog,
    encode_attachments_catalog_raw, read_or_empty, AttachmentMeta, AttachmentsCatalog,
    CatalogBlobError, CATALOG_BLOB_ACCOUNT_HASH_LEN, CATALOG_BLOB_HEADER_LEN, CATALOG_BLOB_MAGIC,
    CATALOG_BLOB_PROTOCOL_VERSION, CATALOG_BLOB_RESERVED, MAX_CATALOG_PLAINTEXT_LEN,
};
pub use blob::{
    decode_note, encode_new_note, encode_new_note_blob_raw, encode_update, encode_update_blob_raw,
    DecryptError, DecryptedNote,
};
pub use dictionary_blob::{
    decode_dictionary_blob, encode_dictionary_blob, encode_dictionary_blob_raw,
    DictionaryBlobError, DICTIONARY_BLOB_ACCOUNT_HASH_LEN, DICTIONARY_BLOB_FORMAT_V1,
    DICTIONARY_BLOB_HEADER_LEN, DICTIONARY_BLOB_MAGIC, DICTIONARY_BLOB_PROTOCOL_VERSION,
    MAX_DICTIONARY_PLAINTEXT_LEN,
};
pub use embeddings_blob::{
    decode_embeddings_blob, encode_embeddings_blob, encode_embeddings_blob_raw,
    EmbeddingsBlobError, EMBEDDINGS_BLOB_ACCOUNT_HASH_LEN, EMBEDDINGS_BLOB_FORMAT_V1,
    EMBEDDINGS_BLOB_HEADER_LEN, EMBEDDINGS_BLOB_MAGIC, EMBEDDINGS_BLOB_PROTOCOL_VERSION,
    MAX_EMBEDDINGS_PLAINTEXT_LEN,
};
pub use error::ProtocolError;
pub use graph_layout_blob::{
    decode_graph_layout_blob, encode_graph_layout_blob, encode_graph_layout_blob_raw,
    GraphLayoutBlobError, GRAPH_LAYOUT_BLOB_ACCOUNT_HASH_LEN, GRAPH_LAYOUT_BLOB_FORMAT_VERSION,
    GRAPH_LAYOUT_BLOB_HEADER_LEN, GRAPH_LAYOUT_BLOB_MAGIC, GRAPH_LAYOUT_BLOB_PROTOCOL_VERSION,
    MAX_GRAPH_LAYOUT_PLAINTEXT_LEN,
};
pub use kdf::{
    derive_password_wrap_key, derive_recovery_wrap_key, derive_recovery_wrap_key_from_normalized,
    ARGON2_OUTPUT_LEN, ARGON2_SALT_LEN,
};
pub use manifest::{
    compute_manifest_hash, decode_manifest, encode_manifest, ManifestEntry, ManifestError,
    MANIFEST_DOMAIN_PREFIX, MANIFEST_FORMAT_V1, MANIFEST_HASH_LEN, MANIFEST_ID_LEN,
    MANIFEST_PROTOCOL_VERSION,
};
pub use paired_extension::{
    canonical_encode_paired_extensions, parse_paired_extensions_array, PairedExtension,
    PairedExtensionParseError,
};
pub use password_policy::{validate_min_length, MIN_PASSWORD_LEN};
pub use phrase::{
    generate_recovery_phrase, normalize_user_phrase, RecoveryPhrase, RECOVERY_PHRASE_ENTROPY_BYTES,
    RECOVERY_PHRASE_WORD_COUNT,
};
pub use prefs::{
    decode_prefs_blob, encode_prefs_blob, encode_prefs_blob_raw, EditorLayout, PrefsBlobError,
    PrefsView, ThemeChoice, MAX_PREFS_PLAINTEXT_LEN, PREFS_BLOB_ACCOUNT_HASH_LEN,
    PREFS_BLOB_HEADER_LEN, PREFS_BLOB_MAGIC, PREFS_BLOB_PROTOCOL_VERSION, PREFS_BLOB_RESERVED,
};
pub use saved_view::{
    canonical_decode_saved_view, canonical_encode_saved_view, canonical_encode_saved_views,
    parse_saved_views_array, FilterNode, PropertyOp, SavedView, SavedViewParseError, SortDirection,
    ViewSort, ViewType,
};
pub use scram::{
    scram_client_final_message, scram_client_proof, ScramClientOutput, SCRAM_CBIND_NAME,
};
pub use search_blob::{
    decode_search_index_blob, encode_search_index_blob, encode_search_index_blob_raw,
    SearchBlobError, MAX_SEARCH_INDEX_PLAINTEXT_LEN, SEARCH_BLOB_ACCOUNT_HASH_LEN,
    SEARCH_BLOB_HEADER_LEN, SEARCH_BLOB_INDEX_FORMAT_V1, SEARCH_BLOB_MAGIC,
    SEARCH_BLOB_PROTOCOL_VERSION,
};
pub use subkey::{derive_subkey, SubkeyRole};
pub use template::{render, supported_tokens, RenderContext};
pub use themes_blob::{
    decode_themes_blob, encode_themes_blob, encode_themes_blob_raw, ThemesBlobError,
    MAX_THEMES_PLAINTEXT_LEN, THEMES_BLOB_ACCOUNT_HASH_LEN, THEMES_BLOB_FORMAT_V1,
    THEMES_BLOB_HEADER_LEN, THEMES_BLOB_MAGIC, THEMES_BLOB_PROTOCOL_VERSION,
};
pub use types::{
    generate_root_key, parse_kdf_params, serialize_kdf_params, validate_kdf_params, KdfParams,
    DEFAULT_V0_1_KDF_PARAMS, KDF_PARAMS_CANONICAL_LEN, MAX_KDF_M_KIB, MAX_KDF_P, MAX_KDF_T,
    MIN_KDF_M_KIB, MIN_KDF_P, MIN_KDF_T,
};
pub use vault_head::{
    compute_head_id, compute_vault_head_mac, decode_head_state, encode_head_state,
    head_fingerprint, open_vault_head, vv_dominance, Dominance, SealedHead, VaultHead,
    VaultHeadError, VvEntry, DEVICE_ID_LEN, HEAD_FINGERPRINT_CHARS, HEAD_ID_LEN, HEAD_MAC_LEN,
    VAULT_HEAD_ACCOUNT_HASH_LEN, VAULT_HEAD_DOMAIN_PREFIX, VAULT_HEAD_FINGERPRINT_DOMAIN,
    VAULT_HEAD_FORMAT_V1, VAULT_HEAD_MANIFEST_HASH_LEN, VAULT_HEAD_PROTOCOL_VERSION,
    VAULT_HEAD_STATE_MAGIC,
};
pub use vault_indices_blob::{
    decode_vault_indices_blob, encode_vault_indices_blob, encode_vault_indices_blob_raw,
    VaultIndicesBlobError, MAX_VAULT_INDICES_PLAINTEXT_LEN, VAULT_INDICES_BLOB_ACCOUNT_HASH_LEN,
    VAULT_INDICES_BLOB_FORMAT_V1, VAULT_INDICES_BLOB_HEADER_LEN, VAULT_INDICES_BLOB_MAGIC,
    VAULT_INDICES_BLOB_PROTOCOL_VERSION,
};
pub use vault_meta::{
    derive_items_key, parse_vault_meta, rewrite_vault_meta_password_side, serialize_vault_meta,
    VaultMeta, VAULT_META_ACCOUNT_HASH_LEN, VAULT_META_ITEMS_KEY_ID_LEN, VAULT_META_LEN,
    VAULT_META_MAGIC, VAULT_META_NONCE_LEN, VAULT_META_PROTOCOL_VERSION, VAULT_META_RESERVED,
    VAULT_META_SALT_RANDOM_LEN, VAULT_META_WRAPPED_ITEMS_KEY_LEN, VAULT_META_WRAPPED_ROOT_KEY_LEN,
};
pub use workspace_blob::{
    decode_workspace_blob, encode_workspace_blob, encode_workspace_blob_raw, WorkspaceBlobError,
    MAX_WORKSPACE_PLAINTEXT_LEN, WORKSPACE_BLOB_ACCOUNT_HASH_LEN, WORKSPACE_BLOB_FORMAT_VERSION,
    WORKSPACE_BLOB_HEADER_LEN, WORKSPACE_BLOB_MAGIC, WORKSPACE_BLOB_PROTOCOL_VERSION,
};
