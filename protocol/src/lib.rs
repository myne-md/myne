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
pub mod agent_memory_catalog_blob;
pub mod agent_memory_entry_blob;
pub mod agent_personality_blob;
pub mod attachment_blob;
pub mod attachment_text_blob;
pub mod attachments_catalog;
pub mod blob;
pub(crate) mod blob_envelope;
pub(crate) mod canonical_json;
pub mod capture_blob;
pub mod chats_blob;
pub mod chats_catalog_blob;
pub mod color_group;
pub mod crdt_note_blob;
pub mod dictionary_blob;
pub mod embeddings_blob;
pub mod error;
pub mod graph_layout_blob;
pub mod kdf;
pub mod manifest;
pub mod paired_extension;
pub mod password_policy;
pub mod person_invite;
pub mod person_key;
pub mod person_profile_blob;
pub mod person_rekey;
pub mod phrase;
pub mod prefs;
pub mod quick_unlock_blob;
pub mod saved_view;
pub mod scram;
pub mod search_blob;
pub mod share_import_blob;
pub mod singleton_migrate;
pub mod subkey;
pub mod template;
pub mod themes_blob;
pub mod types;
pub mod vault_head;
pub mod vault_indices_blob;
/// `MYL1` sealed label store (§9.22). Device-local like `capture_blob` /
/// `quick_unlock_blob` / `share_import_blob`, so it is deliberately absent from
/// the `pub use` block below and is reached as `protocol::vault_label_blob::…`.
pub mod vault_label_blob;
pub mod vault_meta;
pub mod vault_meta_v0_2;
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
    aad_agent_memory_blob, aad_agent_memory_blob_v0_2, aad_agent_memory_catalog,
    aad_agent_personality_blob, aad_ai_embeddings_blob, aad_attachment_text_blob, aad_chats_blob,
    aad_chats_blob_v0_2, aad_chats_catalog, aad_custom_themes_blob, aad_graph_layout_blob,
    aad_membership_blob, aad_membership_roster_blob, aad_note_content_encrypt,
    aad_note_item_key_wrap, aad_password_wrap, aad_password_wrap_v0_2, aad_person_binding_blob,
    aad_person_member_key_store, aad_person_profile_blob, aad_personal_dictionary_blob,
    aad_prefs_blob, aad_quick_unlock_blob, aad_recovery_wrap, aad_recovery_wrap_v0_2,
    aad_search_index_blob, aad_singleton_blob, aad_singleton_blob_v0_2,
    aad_vault_group_key_wrap_v0_2, aad_vault_indices_blob, aad_vault_items_key_wrap,
    aad_vault_items_key_wrap_v0_2, aad_workspace_blob, aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN,
    AEAD_NONCE_LEN, CTX_COMMITMENT_TAG_LEN, GROUP_KEY_WRAP_AAD_ROLE,
};
pub use agent_memory_catalog_blob::{
    decode_agent_memory_catalog_blob, decode_agent_memory_catalog_blob_versioned,
    encode_agent_memory_catalog_blob, encode_agent_memory_catalog_blob_raw,
    encode_agent_memory_catalog_blob_versioned, AgentMemoryCatalogError,
    AGENT_MEMORY_CATALOG_ACCOUNT_HASH_LEN, AGENT_MEMORY_CATALOG_BLOB_AAD_ROLE,
    AGENT_MEMORY_CATALOG_BLOB_MAGIC, AGENT_MEMORY_CATALOG_BLOB_PROTOCOL_VERSION,
    AGENT_MEMORY_CATALOG_BLOB_V0_2_MAGIC, AGENT_MEMORY_CATALOG_FORMAT_VERSION,
    AGENT_MEMORY_CATALOG_HEADER_LEN, MAX_AGENT_MEMORY_CATALOG_PLAINTEXT_LEN,
};
pub use agent_memory_entry_blob::{
    decode_agent_memory_blob, decode_agent_memory_blob_v0_2, decode_agent_memory_blob_versioned,
    encode_agent_memory_blob, encode_agent_memory_blob_raw, encode_agent_memory_blob_v0_2,
    encode_agent_memory_blob_v0_2_raw, encode_agent_memory_blob_versioned,
    reseal_agent_memory_blob_v0_2, AgentMemoryBlobError, AGENT_MEMORY_BLOB_AAD_ROLE,
    AGENT_MEMORY_BLOB_ACCOUNT_HASH_LEN, AGENT_MEMORY_BLOB_FORMAT_VERSION,
    AGENT_MEMORY_BLOB_HEADER_LEN, AGENT_MEMORY_BLOB_MAGIC, AGENT_MEMORY_BLOB_PROTOCOL_VERSION_V0_1,
    AGENT_MEMORY_BLOB_PROTOCOL_VERSION_V0_2, AGENT_MEMORY_BLOB_V0_2_MAGIC,
    MAX_AGENT_MEMORY_PLAINTEXT_LEN, MEMORY_ENTRY_ID_LEN,
};
pub use agent_personality_blob::{
    decode_agent_personality_blob, decode_agent_personality_blob_versioned,
    encode_agent_personality_blob, encode_agent_personality_blob_raw,
    encode_agent_personality_blob_versioned, AgentPersonalityBlobError,
    AGENT_PERSONALITY_ACCOUNT_HASH_LEN, AGENT_PERSONALITY_BLOB_AAD_ROLE,
    AGENT_PERSONALITY_BLOB_MAGIC, AGENT_PERSONALITY_BLOB_PROTOCOL_VERSION,
    AGENT_PERSONALITY_BLOB_V0_2_MAGIC, AGENT_PERSONALITY_FORMAT_VERSION,
    AGENT_PERSONALITY_HEADER_LEN, MAX_AGENT_PERSONALITY_PLAINTEXT_LEN,
};
pub use attachment_blob::{
    aad_encrypt_attachment, aad_encrypt_attachment_v0_2, aad_wrap_attachment_key,
    aad_wrap_attachment_key_v0_2, compute_attachment_id, decode_attachment_blob,
    decode_attachment_blob_v0_2, encode_attachment_blob, encode_attachment_blob_raw,
    encode_attachment_blob_v0_2, encode_attachment_blob_v0_2_raw, encode_attachment_blob_versioned,
    reseal_attachment_v0_2, AttachmentBlobError, ATTACHMENT_BLOB_MAGIC,
    ATTACHMENT_BLOB_PROTOCOL_VERSION, ATTACHMENT_BLOB_RESERVED, ATTACHMENT_BLOB_V0_2_MAGIC,
    ATTACHMENT_BLOB_V0_2_PROTOCOL_VERSION, ATTACHMENT_ID_LEN, MAX_ATTACHMENT_LEN,
};
pub use attachment_text_blob::{
    decode_attachment_text_blob, encode_attachment_text_blob, encode_attachment_text_blob_raw,
    AttachmentTextBlobError, ATTACHMENT_TEXT_BLOB_ACCOUNT_HASH_LEN,
    ATTACHMENT_TEXT_BLOB_EXTRACTOR_VERSION, ATTACHMENT_TEXT_BLOB_HEADER_LEN,
    ATTACHMENT_TEXT_BLOB_MAGIC, ATTACHMENT_TEXT_BLOB_PROTOCOL_VERSION,
    MAX_ATTACHMENT_TEXT_PLAINTEXT_LEN,
};
pub use attachments_catalog::{
    aad_attachments_catalog, decode_attachments_catalog, decode_attachments_catalog_versioned,
    encode_attachments_catalog, encode_attachments_catalog_raw,
    encode_attachments_catalog_versioned, read_or_empty, read_or_empty_versioned, AttachmentMeta,
    AttachmentsCatalog, CatalogBlobError, CATALOG_BLOB_ACCOUNT_HASH_LEN, CATALOG_BLOB_HEADER_LEN,
    CATALOG_BLOB_MAGIC, CATALOG_BLOB_PROTOCOL_VERSION, CATALOG_BLOB_RESERVED,
    CATALOG_BLOB_V0_2_MAGIC, MAX_CATALOG_PLAINTEXT_LEN,
};
pub use blob::{
    decode_note, encode_new_note, encode_new_note_blob_raw, encode_update, encode_update_blob_raw,
    DecryptError, DecryptedNote,
};
pub use chats_blob::{
    decode_chats_blob, decode_chats_blob_v0_2, decode_chats_blob_versioned, encode_chats_blob,
    encode_chats_blob_raw, encode_chats_blob_v0_2, encode_chats_blob_v0_2_raw,
    encode_chats_blob_versioned, reseal_chats_blob_v0_2, ChatsBlobError, CHATS_BLOB_AAD_ROLE,
    CHATS_BLOB_ACCOUNT_HASH_LEN, CHATS_BLOB_FORMAT_VERSION, CHATS_BLOB_HEADER_LEN,
    CHATS_BLOB_MAGIC, CHATS_BLOB_PROTOCOL_VERSION_V0_1, CHATS_BLOB_PROTOCOL_VERSION_V0_2,
    CHATS_BLOB_V0_2_MAGIC, CONVERSATION_ID_LEN, MAX_CHATS_PLAINTEXT_LEN,
};
pub use chats_catalog_blob::{
    decode_chats_catalog_blob, decode_chats_catalog_blob_versioned, encode_chats_catalog_blob,
    encode_chats_catalog_blob_raw, encode_chats_catalog_blob_versioned, ChatsCatalogError,
    CHATS_CATALOG_ACCOUNT_HASH_LEN, CHATS_CATALOG_BLOB_AAD_ROLE, CHATS_CATALOG_BLOB_MAGIC,
    CHATS_CATALOG_BLOB_PROTOCOL_VERSION, CHATS_CATALOG_BLOB_V0_2_MAGIC,
    CHATS_CATALOG_FORMAT_VERSION, CHATS_CATALOG_HEADER_LEN, MAX_CHATS_CATALOG_PLAINTEXT_LEN,
};
pub use color_group::{
    canonical_encode_color_groups, parse_color_groups_array, ColorGroup, ColorGroupParseError,
};
pub use crdt_note_blob::{
    decode_crdt_note_blob, encode_crdt_note_blob, encode_crdt_note_blob_raw, CannotDecryptCrdtNote,
    NC05_MAGIC, NC05_MAX_PLAINTEXT_LEN, NC05_PROTOCOL_VERSION,
};
pub use dictionary_blob::{
    decode_dictionary_blob, decode_dictionary_blob_versioned, encode_dictionary_blob,
    encode_dictionary_blob_raw, encode_dictionary_blob_versioned, DictionaryBlobError,
    DICTIONARY_BLOB_ACCOUNT_HASH_LEN, DICTIONARY_BLOB_FORMAT_V1, DICTIONARY_BLOB_HEADER_LEN,
    DICTIONARY_BLOB_MAGIC, DICTIONARY_BLOB_PROTOCOL_VERSION, DICTIONARY_BLOB_V0_2_MAGIC,
    MAX_DICTIONARY_PLAINTEXT_LEN,
};
pub use embeddings_blob::{
    decode_embeddings_blob, encode_embeddings_blob, encode_embeddings_blob_raw,
    EmbeddingsBlobError, EMBEDDINGS_BLOB_ACCOUNT_HASH_LEN, EMBEDDINGS_BLOB_FORMAT_V1,
    EMBEDDINGS_BLOB_FORMAT_V2, EMBEDDINGS_BLOB_HEADER_LEN, EMBEDDINGS_BLOB_MAGIC,
    EMBEDDINGS_BLOB_PROTOCOL_VERSION, MAX_EMBEDDINGS_PLAINTEXT_LEN,
};
pub use error::ProtocolError;
pub use graph_layout_blob::{
    decode_graph_layout_blob, encode_graph_layout_blob, encode_graph_layout_blob_raw,
    GraphLayoutBlobError, GRAPH_LAYOUT_BLOB_ACCOUNT_HASH_LEN, GRAPH_LAYOUT_BLOB_FORMAT_VERSION,
    GRAPH_LAYOUT_BLOB_HEADER_LEN, GRAPH_LAYOUT_BLOB_MAGIC, GRAPH_LAYOUT_BLOB_PROTOCOL_VERSION,
    MAX_GRAPH_LAYOUT_PLAINTEXT_LEN,
};
pub use kdf::{
    derive_password_wrap_key, derive_password_wrap_key_v0_2,
    derive_person_keypair_wrap_key_from_normalized, derive_person_server_auth_key,
    derive_person_server_auth_key_from_normalized, derive_person_vault_member_key,
    derive_person_vault_member_key_from_normalized, derive_person_vault_profile_key,
    derive_person_vault_profile_key_from_normalized, derive_recovery_wrap_key,
    derive_recovery_wrap_key_from_normalized, derive_recovery_wrap_key_from_normalized_v0_2,
    derive_recovery_wrap_key_v0_2, person_id_hash, person_profile_id, ARGON2_OUTPUT_LEN,
    ARGON2_SALT_LEN, PERSON_ID_PREFIX, PERSON_PROFILE_ID_PREFIX, PERSON_SERVER_AUTH_SALT_RANDOM,
    PERSON_VAULT_MEMBER_SALT_RANDOM, PERSON_VAULT_PROFILE_SALT_RANDOM,
    SALT_PREFIX_PERSON_SERVER_AUTH_V0_2, SALT_PREFIX_PERSON_VAULT_MEMBER_V0_2,
    SALT_PREFIX_PERSON_VAULT_PROFILE_V0_2,
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
pub use person_key::{
    compute_fingerprint, hybrid_wrap_key, PersonKeyError, PersonKeyPair, PersonPublicHalf,
    PersonSigned, PersonWrappedKey, SealedToMember, PERSON_CT_LEN, PERSON_DK_SEED_LEN,
    PERSON_ED25519_PK_LEN, PERSON_ED25519_SEED_LEN, PERSON_ED25519_SIG_LEN, PERSON_EK_LEN,
    PERSON_FINGERPRINT_LEN, PERSON_MLDSA_SEED_LEN, PERSON_MLDSA_SIG_LEN, PERSON_MLDSA_VK_LEN,
    PERSON_PLAINTEXT_LEN, PERSON_SEAL_NONCE_LEN, PERSON_SHARED_KEY_LEN,
};
pub use person_profile_blob::{
    decode_person_profile_blob, encode_person_profile_blob, encode_person_profile_blob_raw,
    PersonProfileBlobError, MAX_PERSON_PROFILE_PLAINTEXT_LEN, PERSON_PROFILE_BLOB_FORMAT_VERSION,
    PERSON_PROFILE_BLOB_HEADER_LEN, PERSON_PROFILE_BLOB_MAGIC,
    PERSON_PROFILE_BLOB_PROTOCOL_VERSION, PERSON_PROFILE_ID_LEN,
};
pub use phrase::{
    generate_recovery_phrase, normalize_user_phrase, RecoveryPhrase, RECOVERY_PHRASE_ENTROPY_BYTES,
    RECOVERY_PHRASE_WORD_COUNT,
};
pub use prefs::{
    canonical_clock_member_cost, canonical_plaintext_len, canonical_set_entry_cost,
    decode_prefs_blob, decode_prefs_blob_versioned, encode_prefs_blob, encode_prefs_blob_raw,
    encode_prefs_blob_versioned, EditorLayout, PrefsBlobError, PrefsView, ThemeChoice,
    MAX_PREFS_PLAINTEXT_LEN, PREFS_BLOB_ACCOUNT_HASH_LEN, PREFS_BLOB_HEADER_LEN, PREFS_BLOB_MAGIC,
    PREFS_BLOB_PROTOCOL_VERSION, PREFS_BLOB_RESERVED, PREFS_BLOB_V0_2_MAGIC,
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
pub use singleton_migrate::reseal_kek_envelope_v0_2;
pub use subkey::{
    derive_group_subkey_v0_2, derive_owner_subkey_v0_2, derive_subkey, derive_subkey_v0_2,
    derive_subkey_versioned, GroupKey, GroupRole, OwnerKey, OwnerRole, SubkeyRole,
};
pub use template::{render, supported_tokens, RenderContext};
pub use themes_blob::{
    decode_themes_blob, decode_themes_blob_versioned, encode_themes_blob, encode_themes_blob_raw,
    encode_themes_blob_versioned, ThemesBlobError, MAX_THEMES_PLAINTEXT_LEN,
    THEMES_BLOB_ACCOUNT_HASH_LEN, THEMES_BLOB_FORMAT_V1, THEMES_BLOB_HEADER_LEN, THEMES_BLOB_MAGIC,
    THEMES_BLOB_PROTOCOL_VERSION, THEMES_BLOB_V0_2_MAGIC,
};
pub use types::{
    generate_root_key, parse_kdf_params, serialize_kdf_params, validate_kdf_params, KdfParams,
    MetaVersion, DEFAULT_V0_1_KDF_PARAMS, KDF_PARAMS_CANONICAL_LEN, MAX_KDF_M_KIB, MAX_KDF_P,
    MAX_KDF_T, MIN_KDF_M_KIB, MIN_KDF_P, MIN_KDF_T,
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
    Membership, MembershipRoster, PersonBinding, VaultMeta, MEMBERSHIP_ACCOUNT_ID_LEN,
    MEMBERSHIP_CIPHERTEXT_LEN, MEMBERSHIP_FIELD_LEN, MEMBERSHIP_ROSTER_CT_CAP,
    MEMBERSHIP_ROSTER_FIELD_CAP, MEMBERSHIP_ROSTER_NONCE_LEN, PERSON_BINDING_BIT,
    PERSON_BINDING_CIPHERTEXT_LEN, PERSON_BINDING_FIELD_LEN, PERSON_BINDING_ID_LEN,
    VAULT_META_ACCOUNT_HASH_LEN, VAULT_META_ITEMS_KEY_ID_LEN, VAULT_META_LEN, VAULT_META_MAGIC,
    VAULT_META_NONCE_LEN, VAULT_META_PROTOCOL_VERSION, VAULT_META_RESERVED,
    VAULT_META_SALT_RANDOM_LEN, VAULT_META_V0_2_WITH_MEMBERSHIP_LEN,
    VAULT_META_WRAPPED_ITEMS_KEY_LEN, VAULT_META_WRAPPED_ROOT_KEY_LEN,
};
pub use vault_meta_v0_2::{
    derive_items_key_v0_2, derive_items_key_versioned, encode_vault_meta_v0_2_raw, meta_version_of,
    parse_vault_meta_any, parse_vault_meta_ntv6, parse_vault_meta_v0_2,
    rewrite_vault_meta_password_side_ntv6, rewrite_vault_meta_password_side_v0_2,
    rewrite_vault_meta_password_side_versioned, seal_membership_raw, seal_membership_roster_raw,
    seal_person_binding_raw, serialize_vault_meta_ntv6, serialize_vault_meta_v0_2,
    serialize_vault_meta_versioned, unlock_group_key_ntv6, unlock_items_key_ntv6,
    unlock_root_key_v0_2_password, unlock_root_key_v0_2_recovery, unseal_membership,
    unseal_membership_roster, unseal_person_binding, B2bVaultMeta, VAULT_META_NTV6_MAGIC,
    VAULT_META_NTV6_PROTOCOL_VERSION, VAULT_META_V0_2_MAGIC, VAULT_META_V0_2_PROTOCOL_VERSION,
};
pub use workspace_blob::{
    decode_workspace_blob, encode_workspace_blob, encode_workspace_blob_raw, WorkspaceBlobError,
    MAX_WORKSPACE_PLAINTEXT_LEN, WORKSPACE_BLOB_ACCOUNT_HASH_LEN, WORKSPACE_BLOB_FORMAT_VERSION,
    WORKSPACE_BLOB_HEADER_LEN, WORKSPACE_BLOB_MAGIC, WORKSPACE_BLOB_PROTOCOL_VERSION,
};
