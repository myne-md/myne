// SPDX-License-Identifier: AGPL-3.0
//! XChaCha20-Poly1305 with CTX commitment + AAD construction —
//! see `docs/spec/protocol.md` § 5.
//!
//! This module hosts:
//!
//! - AAD builders for the password-wrap and recovery-wrap AEAD calls —
//!   see [`aad_password_wrap`], [`aad_recovery_wrap`].
//! - AEAD seal/open with CTX commitment — see [`aead_seal_ctx`],
//!   [`aead_open_ctx`].
//!
//! ## CTX commitment construction (spec § 5.1)
//!
//! Plain XChaCha20-Poly1305 is **not key-committing** — Len–Grubbs–
//! Ristenpart's "Partitioning Oracle Attacks" (USENIX 2021). Myne v0.1
//! wraps the AEAD in the **CTX commitment** of Chan & Rogaway (ESORICS
//! 2022): the standard 16-byte Poly1305 tag `T` is fed (along with K,
//! N, AAD) into SHA-256, and the resulting 32-byte hash `T'` replaces
//! `T` on disk. `T` itself is **not stored** — it is recomputed at
//! decrypt time via Poly1305 and rehashed for comparison.
//!
//! ```text
//! seal:    ciphertext, T = XChaCha20-Poly1305-encrypt-detached(K, N, P, AD)
//!          T' = SHA-256(K[32] || N[24] || len(AD)[4 BE] || AD || T[16])
//!          on-disk = ciphertext || T'        (T discarded)
//!
//! open:    split on-disk into ciphertext and T'
//!          T_recomputed = Poly1305(K, N, AD, ciphertext)
//!          T'_expected = SHA-256(K[32] || N[24] || len(AD)[4 BE] || AD || T_recomputed[16])
//!          constant-time compare T'_expected == T'   → AeadFailure if not
//!          plaintext = XChaCha20_decrypt_no_auth(K, N, ciphertext)
//! ```
//!
//! RustCrypto's high-level `chacha20poly1305` crate does not expose
//! the Poly1305 tag separately from the integrity-checked decrypt
//! path, so this module composes [`chacha20::XChaCha20`] (stream
//! cipher) and [`poly1305::Poly1305`] (MAC) by hand. The composition
//! is byte-exact equivalent to RFC 8439 + extended-nonce; this is
//! verified in the test suite by cross-checking ciphertext output
//! against `chacha20poly1305::XChaCha20Poly1305`.
//!
//! ## Twin-prefix gotcha
//!
//! Two 10-byte ASCII prefixes are bound into different parts of the
//! protocol and differ only in their final byte:
//!
//! | Prefix          | Used by                          | Spec      |
//! |-----------------|----------------------------------|-----------|
//! | `"myne.v0.1 "`  | HKDF context strings (§ 3.2.2)   | trailing space |
//! | `"myne.v0.1\|"` | AEAD AAD construction (§ 5.2)    | trailing pipe  |
//!
//! Confusing them silently invalidates every vault under v0.1. Both
//! are tested for byte-equality against literal byte slices in this
//! module's test suite.

use crate::error::ProtocolError;
use crate::types::{serialize_kdf_params, KdfParams};
use alloc::vec::Vec;
use chacha20::cipher::{KeyIvInit, StreamCipher, StreamCipherSeek};
use chacha20::XChaCha20;
use poly1305::universal_hash::{KeyInit, UniversalHash};
use poly1305::Poly1305;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use zeroize::Zeroizing;

/// XChaCha20-Poly1305 AEAD key length: 256 bits.
pub const AEAD_KEY_LEN: usize = 32;

/// XChaCha20-Poly1305 nonce length: 192 bits (extended-nonce variant).
pub const AEAD_NONCE_LEN: usize = 24;

/// CTX commitment tag length: 32 bytes (SHA-256 output).
///
/// Replaces the 16-byte Poly1305 tag on disk per spec § 5.1.
pub const CTX_COMMITMENT_TAG_LEN: usize = 32;

/// ChaCha20 block size — 64 bytes per RFC 8439 §2.3. After consuming
/// the first 32 bytes of block 0 for the Poly1305 one-time key, the
/// stream cipher is advanced to block 1 (byte 64) before encrypting
/// the plaintext.
const CHACHA20_BLOCK_SIZE: u64 = 64;

/// Poly1305 tag length: 16 bytes.
const POLY1305_TAG_LEN: usize = 16;

/// AAD prefix bound into every Myne v0.1 AEAD tag
/// (`docs/spec/protocol.md` § 5.2). 10 ASCII bytes ending in pipe `|`.
/// `pub(crate)` so the attachment blob + catalog AAD builders bind the SAME
/// load-bearing prefix (a major-version constant) from one definition site
/// rather than re-declaring it.
pub(crate) const AAD_PREFIX_V0_1: &[u8] = b"myne.v0.1|";

/// `protocol_version` byte bound into every wrap AAD
/// (spec § 9.3 offset 4 = `0x01` for v0.1). `pub(crate)` for the same
/// single-source reason as [`AAD_PREFIX_V0_1`].
pub(crate) const PROTOCOL_VERSION_V0_1: u8 = 0x01;

/// AAD prefix bound into every Myne **next-major (v0.2)** AEAD tag
/// (`docs/spec/protocol.md` § 10.5). 10 ASCII bytes ending in pipe `|`,
/// mirroring [`AAD_PREFIX_V0_1`]'s shape but **domain-separating** the next
/// major from v0.1: an `NC05` tag built under this prefix MUST NOT verify under
/// v0.1's prefix, and vice versa — the § 10.5 forward-incompatibility contract,
/// proven in `crdt_note_blob`'s tests. Minted with the `NC05` CRDT note-type
/// (automerge-sync-migration, myne-md/myne#418). The v0.1 prefix is untouched.
pub(crate) const AAD_PREFIX_V0_2: &[u8] = b"myne.v0.2|";

/// `protocol_version` byte bound into every next-major (v0.2) wrap AAD and the
/// `NC05` blob header (offset 4). `0x02` for the next major.
pub(crate) const PROTOCOL_VERSION_V0_2: u8 = 0x02;

/// Registered role string for the password-derived wrap AAD
/// (spec § 3.1).
const ROLE_STR_PASSWORD_WRAP: &[u8] = b"password-wrap";

/// Registered role string for the recovery-phrase-derived wrap AAD
/// (spec § 3.1).
const ROLE_STR_RECOVERY_WRAP: &[u8] = b"recovery-wrap";

/// Registered role string for the custom-themes blob AAD (spec § 5.2).
///
/// Public, and module-scope rather than local to `aad_custom_themes_blob`,
/// because a second crate has to name this value: `myne-core`'s v0.2 migration
/// walks a table of KEK singletons and passes each family's role to
/// `aad_singleton_blob_v0_2`. Before this it spelled the literal itself, and
/// nothing compared the two spellings: not the compiler, not clippy, not a
/// test. A drift there would seal the re-encrypted blob under a role nothing
/// else uses, and the next read would fail authentication on a family that is
/// synced vault content.
///
/// Only the roles a second crate must name are exported. The other registered
/// roles in this file stay local to their builder, because nothing outside can
/// spell them wrong. Exporting one is a decision, not a default.
pub const ROLE_STR_CUSTOM_THEMES_BLOB: &[u8] = b"custom-themes-blob";

/// Registered role string for the personal-dictionary blob AAD (spec § 5.2).
/// Exported for the same reason as `ROLE_STR_CUSTOM_THEMES_BLOB` above.
pub const ROLE_STR_PERSONAL_DICT_BLOB: &[u8] = b"personal-dictionary-blob";

/// Registered AAD role for the owner-held shared group-key wrap.
pub const GROUP_KEY_WRAP_AAD_ROLE: &[u8] = b"group-key-wrap";

/// Build the AAD bound into the AEAD wrap of `root_key` under the
/// password-derived wrap key (spec § 3.1).
///
/// The returned bytes are passed verbatim to the AEAD seal/open
/// helpers (Task 8) at vault-creation time and unlock-by-password
/// time. Byte-exact correctness is load-bearing: the AAD is hashed
/// into both the Poly1305 tag and the CTX commitment tag, so any
/// drift silently invalidates the wrap.
///
/// Layout (37 bytes for default `KdfParams`):
///
/// ```text
/// "myne.v0.1|"                10 bytes  (AAD prefix, § 5.2)
/// 0x01                         1 byte   (protocol_version, § 9.3)
/// u16_be(13) || "password-wrap"  15 bytes  (length-prefixed role, § 3.1)
/// kdf_params_canonical         11 bytes  (§ 4.3, bound for downgrade defense)
/// ```
///
/// **Note on `account_number_hash`.** Spec § 3.1 mixes
/// `account_number_hash` into the wrap-key *salt* (via SHA-256 of the
/// salt prefix concat), **not** into the AAD. Earlier drafts of the
/// PRD listed `account_number_hash` as a parameter to this builder
/// for symmetry; the actual spec AAD definition (§ 3.1 + § 5.2)
/// omits it. The function signature here matches the spec.
pub fn aad_password_wrap(kdf_params: &KdfParams) -> Vec<u8> {
    build_wrap_aad(ROLE_STR_PASSWORD_WRAP, kdf_params)
}

/// Build the AAD bound into the AEAD wrap of the singleton v0.1
/// `itemsKey` (spec § 3.3 key hierarchy, § 9.3 offset 281).
///
/// Layout (27 bytes):
///
/// ```text
/// "myne.v0.1|"     10 bytes  (AAD prefix, § 5.2)
/// 0x01              1 byte   (protocol_version, § 9.3)
/// items_key_id     16 bytes  (UUIDv7 of the singleton v0.1 itemsKey)
/// ```
pub fn aad_vault_items_key_wrap(items_key_id: &[u8; 16]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(AAD_PREFIX_V0_1.len() + 1 + items_key_id.len());
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    aad.extend_from_slice(items_key_id);
    aad
}

/// Build the AAD bound into the AEAD wrap of `root_key` under the
/// recovery-phrase-derived wrap key (spec § 3.1).
///
/// Layout is identical to [`aad_password_wrap`] except the role
/// string is `"recovery-wrap"`. The two AADs differ only in their
/// role bytes, providing the role-separation guarantee that spec
/// § 3.1 mandates: "the two distinct ... salt prefixes ensure the two
/// Argon2id outputs are domain-separated even if the same secret were
/// ever used for both (which it MUST NOT be)."
pub fn aad_recovery_wrap(kdf_params: &KdfParams) -> Vec<u8> {
    build_wrap_aad(ROLE_STR_RECOVERY_WRAP, kdf_params)
}

/// **v0.2** password-wrap AAD (`spec/protocol.md` §10.4.1) — the next-major mirror
/// of [`aad_password_wrap`], stamped with [`AAD_PREFIX_V0_2`] + version
/// [`PROTOCOL_VERSION_V0_2`] instead of v0.1's. Binds the same `kdf_params`
/// canonical block (the §4.3 parameter-downgrade defense carries into v0.2), so a
/// v0.2 `NTV5` root-key wrap never verifies under a v0.1 AAD.
pub fn aad_password_wrap_v0_2(kdf_params: &KdfParams) -> Vec<u8> {
    build_wrap_aad_v0_2(ROLE_STR_PASSWORD_WRAP, kdf_params)
}

/// **v0.2** recovery-wrap AAD (`spec/protocol.md` §10.4.1) — the next-major mirror
/// of [`aad_recovery_wrap`]. Differs from [`aad_password_wrap_v0_2`] only in the
/// role bytes, the same role-separation guarantee v0.1 gives.
pub fn aad_recovery_wrap_v0_2(kdf_params: &KdfParams) -> Vec<u8> {
    build_wrap_aad_v0_2(ROLE_STR_RECOVERY_WRAP, kdf_params)
}

/// **v0.2** singleton-`itemsKey` wrap AAD (`spec/protocol.md` §10.4.1) — the
/// next-major mirror of [`aad_vault_items_key_wrap`]: `"myne.v0.2|" || 0x02 ||
/// items_key_id`. Binds the v0.2 vault's `itemsKey` identity into its wrap under
/// `derive_subkey_v0_2(root_key, ItemsKeyWrap)`.
pub fn aad_vault_items_key_wrap_v0_2(items_key_id: &[u8; 16]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(AAD_PREFIX_V0_2.len() + 1 + items_key_id.len());
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    aad.extend_from_slice(items_key_id);
    aad
}

/// Build the v0.2 AAD for the owner's wrapped shared group key.
pub fn aad_vault_group_key_wrap_v0_2(
    account_number_hash: &[u8; 16],
    group_key_epoch: u64,
) -> Vec<u8> {
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_2.len()
            + 1
            + 2
            + GROUP_KEY_WRAP_AAD_ROLE.len()
            + 8
            + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    push_length_prefixed_u16_be(&mut aad, GROUP_KEY_WRAP_AAD_ROLE);
    aad.extend_from_slice(&group_key_epoch.to_be_bytes());
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Generic **v0.1** KEK-singleton blob AAD — the uniform pattern every single-KEK
/// blob family (§9.5–§9.21) follows: `"myne.v0.1|" || 0x01 || u16_len(role) ||
/// role || account_number_hash`. The per-family builders ([`aad_prefs_blob`],
/// [`aad_custom_themes_blob`], [`aad_personal_dictionary_blob`], …) are exactly
/// this with a fixed role string; this generic form exists so the whole-vault
/// migration's re-seal (§10.4.1) can rebuild any family's AAD from its role.
/// `singleton_blob_generic_matches_the_per_family_builders` pins byte-equivalence.
pub fn aad_singleton_blob(role: &[u8], account_number_hash: &[u8; 16]) -> Vec<u8> {
    let mut aad =
        Vec::with_capacity(AAD_PREFIX_V0_1.len() + 1 + 2 + role.len() + account_number_hash.len());
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, role);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Generic **v0.2** KEK-singleton blob AAD — the next-major mirror of
/// [`aad_singleton_blob`], stamped with the v0.2 prefix + version. The migration
/// re-seals a KEK family by decoding under `aad_singleton_blob(role, hash)` and
/// re-encoding under this (§10.4.1).
pub fn aad_singleton_blob_v0_2(role: &[u8], account_number_hash: &[u8; 16]) -> Vec<u8> {
    let mut aad =
        Vec::with_capacity(AAD_PREFIX_V0_2.len() + 1 + 2 + role.len() + account_number_hash.len());
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    push_length_prefixed_u16_be(&mut aad, role);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Build the v0.2 AAD for a per-person private AI profile (`MYY5`, §9.28).
///
/// Layout: `"myne.v0.2|" || 0x02 || u16_len("person-profile-blob") || role ||
/// account_number_hash (16) || profile_id (16)`.
///
/// Binds BOTH the vault (`account_number_hash`) and the `(person, vault)`
/// profile id, so a profile sealed for one person in one vault cannot be
/// replayed as the same person's profile in another vault, nor as another
/// person's profile in the same vault. The KEK is person-private (derived from
/// the person's phrase), so neither the group key nor `root_key` can open it.
pub fn aad_person_profile_blob(account_number_hash: &[u8; 16], profile_id: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_PERSON_PROFILE_BLOB: &[u8] = b"person-profile-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_2.len()
            + 1
            + 2
            + ROLE_STR_PERSON_PROFILE_BLOB.len()
            + account_number_hash.len()
            + profile_id.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_PERSON_PROFILE_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad.extend_from_slice(profile_id);
    aad
}

/// Build the v0.2 AAD for the sealed owner-signed group roster in an `NTV6`
/// `vault.meta` (`protocol.md` §9.3.3).
///
/// Layout: `"myne.v0.2|" || 0x02 || u16_len("group-roster-blob") || role ||
/// account_number_hash (16) || group_key_epoch (8, big-endian)`.
///
/// Binding the vault AND the epoch keeps a roster sealed for one vault/epoch
/// from being replayed into another: the reader derives the same epoch from the
/// `vault.meta` it is opening, so a roster moved to a different epoch fails AEAD
/// verification rather than being silently served.
pub fn aad_group_roster_blob(account_number_hash: &[u8; 16], group_key_epoch: u64) -> Vec<u8> {
    const ROLE_STR_GROUP_ROSTER_BLOB: &[u8] = b"group-roster-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_2.len()
            + 1
            + 2
            + ROLE_STR_GROUP_ROSTER_BLOB.len()
            + account_number_hash.len()
            + 8,
    );
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_GROUP_ROSTER_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad.extend_from_slice(&group_key_epoch.to_be_bytes());
    aad
}

/// Build the AAD bound into the AEAD wrap of a per-note `item_key`
/// under the singleton v0.1 `itemsKey` (spec § 5.2 + § 6.2).
///
/// Layout (43 bytes):
///
/// ```text
/// "myne.v0.1|"     10 bytes  (AAD prefix, § 5.2)
/// 0x01              1 byte   (protocol_version, § 9.3)
/// items_key_id     16 bytes  (UUIDv7 of the singleton v0.1 itemsKey)
/// note_uuid        16 bytes  (UUIDv7 of the note; from the .myn filename, § 9.1)
/// ```
///
/// Distinct from [`aad_vault_items_key_wrap`] (no note_uuid). The
/// `vault_`/`note_` prefix retires the one-letter
/// `items_key`/`item_key` near-collision footgun — see
/// `protocol/AGENTS.md` for the naming-discipline rationale.
pub fn aad_note_item_key_wrap(items_key_id: &[u8; 16], note_uuid: &[u8; 16]) -> Vec<u8> {
    let mut aad =
        Vec::with_capacity(AAD_PREFIX_V0_1.len() + 1 + items_key_id.len() + note_uuid.len());
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    aad.extend_from_slice(items_key_id);
    aad.extend_from_slice(note_uuid);
    aad
}

/// Build the AAD bound into the AEAD encryption of the v0.1
/// `vault.prefs` blob (spec § 5.2 + § 9.5.3).
///
/// Layout (39 bytes):
///
/// ```text
/// "myne.v0.1|"             10 bytes  (AAD prefix, § 5.2)
/// 0x01                      1 byte   (protocol_version, § 9.3)
/// u16_be(10) || "prefs-blob" 12 bytes  (length-prefixed role, § 5.2)
/// account_number_hash      16 bytes  (vault identity binding, § 9.3 offset 6)
/// ```
///
/// `account_number_hash` (NOT `items_key_id`) binds vault identity —
/// `vault.prefs` lives outside the `items_key` lineage by design,
/// preserving prefs portability across the later epoch-rotation
/// `items_key` evolution (`decisions.md` 2026-05-27 "Vault preferences
/// blob: root_key-derived prefs_key").
pub fn aad_prefs_blob(account_number_hash: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_PREFS_BLOB: &[u8] = b"prefs-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len() + 1 + 2 + ROLE_STR_PREFS_BLOB.len() + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_PREFS_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Build the AAD bound into the AEAD encryption of the v0.1 search-index
/// blob (`vault.search`, MYND-29). Same shape as [`aad_prefs_blob`] with a
/// distinct role string `"search-index-blob"`, so the search index and the
/// prefs blob are cryptographically domain-separated — a blob of one kind can
/// never AEAD-verify under the other's key/AAD.
///
/// Layout (46 bytes):
///
/// ```text
/// "myne.v0.1|"                    10 bytes  (AAD prefix, § 5.2)
/// 0x01                             1 byte   (protocol_version, § 9.3)
/// u16_be(17) || "search-index-blob" 19 bytes  (length-prefixed role)
/// account_number_hash             16 bytes  (vault identity binding, § 9.3 offset 6)
/// ```
///
/// `account_number_hash` (NOT `items_key_id`) binds vault identity: the
/// search index lives outside the `items_key` lineage, same rationale as
/// `aad_prefs_blob`.
pub fn aad_search_index_blob(account_number_hash: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_SEARCH_INDEX_BLOB: &[u8] = b"search-index-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len()
            + 1
            + 2
            + ROLE_STR_SEARCH_INDEX_BLOB.len()
            + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_SEARCH_INDEX_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Build the AAD bound into the AEAD encryption of the v0.1 personal-dictionary
/// blob (`vault.dictionary`, `MYD1`, MYND-266). Same shape as
/// [`aad_prefs_blob`] / [`aad_search_index_blob`] with a distinct role string
/// `"personal-dictionary-blob"`, so the dictionary blob is cryptographically
/// domain-separated from prefs / search / workspace — a blob of one kind can
/// never AEAD-verify under another's key/AAD.
///
/// Layout (53 bytes):
///
/// ```text
/// "myne.v0.1|"                          10 bytes  (AAD prefix, § 5.2)
/// 0x01                                   1 byte   (protocol_version, § 9.3)
/// u16_be(24) || "personal-dictionary-blob" 26 bytes  (length-prefixed role)
/// account_number_hash                   16 bytes  (vault identity binding, § 9.3 offset 6)
/// ```
///
/// `account_number_hash` (NOT `items_key_id`) binds vault identity: the
/// dictionary lives outside the `items_key` lineage, same rationale as
/// `aad_prefs_blob`. DISTINCT from the subkey role `"personal-dictionary-key"`.
pub fn aad_personal_dictionary_blob(account_number_hash: &[u8; 16]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len()
            + 1
            + 2
            + ROLE_STR_PERSONAL_DICT_BLOB.len()
            + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_PERSONAL_DICT_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Build the AAD bound into the AEAD encryption of the v0.1 custom-themes blob
/// (`vault.themes`, `MYT1`, MYND-486). Same shape as
/// [`aad_personal_dictionary_blob`] / [`aad_vault_indices_blob`] with a distinct
/// role string `"custom-themes-blob"`, so the custom-themes store is
/// cryptographically domain-separated from prefs / search / workspace /
/// dictionary — a blob of one kind can never AEAD-verify under another's
/// key/AAD.
///
/// Layout (47 bytes):
///
/// ```text
/// "myne.v0.1|"                      10 bytes  (AAD prefix, § 5.2)
/// 0x01                               1 byte   (protocol_version, § 9.3)
/// u16_be(18) || "custom-themes-blob" 20 bytes (length-prefixed role)
/// account_number_hash               16 bytes  (vault identity binding, § 9.3 offset 6)
/// ```
///
/// `account_number_hash` (NOT `items_key_id`) binds vault identity: the
/// custom-themes blob lives outside the `items_key` lineage, same rationale as
/// `aad_prefs_blob` (the KEK derives directly from `root_key` via
/// `"myne.v0.1 custom-themes-key"`, so it survives a later epoch rotation).
/// DISTINCT from the subkey role `"custom-themes-key"`.
pub fn aad_custom_themes_blob(account_number_hash: &[u8; 16]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len()
            + 1
            + 2
            + ROLE_STR_CUSTOM_THEMES_BLOB.len()
            + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_CUSTOM_THEMES_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Build the AAD bound into the AEAD wrap of the v0.1 quick-unlock credential
/// blob (`vault.quickunlock`, `MYQ1`, MYND-329; `protocol.md` § 9.14.3). Same
/// shape as [`aad_personal_dictionary_blob`] with a distinct role string
/// `"quick-unlock-blob"`, and additionally binds the `provider_kind` byte so a
/// blob minted for one wrap-key provider (e.g. macOS biometric) can never
/// AEAD-verify reinterpreted as another (e.g. PIN).
///
/// Layout (47 bytes):
///
/// ```text
/// "myne.v0.1|"                       10 bytes  (AAD prefix, § 5.2)
/// 0x01                                1 byte   (protocol_version, § 9.14.1)
/// u16_be(17) || "quick-unlock-blob"  19 bytes  (length-prefixed role)
/// account_number_hash                16 bytes  (vault identity, § 9.3 offset 6)
/// provider_kind                       1 byte   (§ 9.14.1 offset 5)
/// ```
///
/// `account_number_hash` (NOT `items_key_id`) binds vault identity: the
/// quick-unlock blob wraps `root_key` itself and lives outside any `items_key`
/// lineage. The blob has no `DeriveSubkey` role (its KEK is provider-supplied,
/// not `root_key`-derived — that would be circular; § 3.4).
pub fn aad_quick_unlock_blob(account_number_hash: &[u8; 16], provider_kind: u8) -> Vec<u8> {
    const ROLE_STR_QUICK_UNLOCK_BLOB: &[u8] = b"quick-unlock-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len()
            + 1
            + 2
            + ROLE_STR_QUICK_UNLOCK_BLOB.len()
            + account_number_hash.len()
            + 1,
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_QUICK_UNLOCK_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad.push(provider_kind);
    aad
}

/// Build the AAD bound into the AEAD encryption of a v0.1 attachment-text blob
/// (`attachments-text/<id>`, `MYE1`, MYND-328; `protocol.md` § 9.15.3). Same
/// shape as [`aad_personal_dictionary_blob`] with a distinct role string
/// `"attachment-text-blob"`, and additionally binds the 32-byte `attachment_id`
/// and the `extractor_version` byte. The `attachment_id` binding is what makes a
/// single KEK safe across every attachment-text blob: a blob sealed for
/// attachment A can never AEAD-verify served as attachment B. Binding
/// `extractor_version` (also carried in the header byte) prevents a tampered
/// header byte from being silently accepted.
///
/// Layout (82 bytes):
///
/// ```text
/// "myne.v0.1|"                          10 bytes  (AAD prefix, § 5.2)
/// 0x01                                   1 byte   (protocol_version, § 9.15.1)
/// u16_be(20) || "attachment-text-blob"  22 bytes  (length-prefixed role)
/// account_number_hash                   16 bytes  (vault identity, § 9.3 offset 6)
/// attachment_id                         32 bytes  (binds blob to its attachment, § 9.9)
/// extractor_version                      1 byte   (binds the extractor generation, § 9.15.1)
/// ```
///
/// `account_number_hash` (NOT `items_key_id`) binds vault identity: the
/// attachment-text KEK derives directly from `root_key` via
/// `"myne.v0.1 attachment-text-key"`, independent of the `items_key` lineage
/// (survives a later epoch rotation, same rationale as prefs/search/dictionary).
/// DISTINCT from the subkey role `"attachment-text-key"`.
pub fn aad_attachment_text_blob(
    account_number_hash: &[u8; 16],
    attachment_id: &[u8; 32],
    extractor_version: u8,
) -> Vec<u8> {
    const ROLE_STR_ATTACHMENT_TEXT_BLOB: &[u8] = b"attachment-text-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len()
            + 1
            + 2
            + ROLE_STR_ATTACHMENT_TEXT_BLOB.len()
            + account_number_hash.len()
            + attachment_id.len()
            + 1,
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_ATTACHMENT_TEXT_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad.extend_from_slice(attachment_id);
    aad.push(extractor_version);
    aad
}

/// Build the AAD bound into the AEAD encryption of the v0.1 editor
/// workspace-state blob (`vault.workspace`, MYND-166). Same shape as
/// [`aad_prefs_blob`] / [`aad_search_index_blob`] with a distinct role
/// string `"workspace-blob"`, so the workspace blob is cryptographically
/// domain-separated from prefs and search — a blob of one kind can never
/// AEAD-verify under another's key/AAD.
///
/// Layout (43 bytes):
///
/// ```text
/// "myne.v0.1|"                  10 bytes  (AAD prefix, § 5.2)
/// 0x01                           1 byte   (protocol_version, § 9.3)
/// u16_be(14) || "workspace-blob" 16 bytes (length-prefixed role)
/// account_number_hash           16 bytes  (vault identity binding, § 9.3 offset 6)
/// ```
///
/// `account_number_hash` (NOT `items_key_id`) binds vault identity: the
/// workspace blob lives outside the `items_key` lineage, same rationale as
/// `aad_prefs_blob`.
pub fn aad_workspace_blob(account_number_hash: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_WORKSPACE_BLOB: &[u8] = b"workspace-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len() + 1 + 2 + ROLE_STR_WORKSPACE_BLOB.len() + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_WORKSPACE_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Build the AAD bound into the AEAD encryption of the v0.1 graph-layout blob
/// (`vault.graph`, `MYG1`, § 9.19). Same shape as [`aad_workspace_blob`] /
/// [`aad_prefs_blob`] with a distinct role string `"graph-layout-blob"`, so the
/// knowledge-graph layout cache is cryptographically domain-separated from
/// prefs / search / workspace / indices / embeddings — a blob of one kind can
/// never AEAD-verify under another's KEK + AAD.
///
/// ```text
/// "myne.v0.1|"                     10 bytes  (AAD prefix, § 5.2)
/// 0x01                              1 byte   (protocol_version, § 9.3)
/// u16_be(17) || "graph-layout-blob" 19 bytes (length-prefixed role)
/// account_number_hash              16 bytes  (vault identity binding, § 9.3 offset 6)
/// ```
///
/// `account_number_hash` (NOT `items_key_id`) binds vault identity: the
/// graph-layout blob lives outside the `items_key` lineage, same rationale as
/// `aad_prefs_blob` / `aad_workspace_blob`.
pub fn aad_graph_layout_blob(account_number_hash: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_GRAPH_LAYOUT_BLOB: &[u8] = b"graph-layout-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len()
            + 1
            + 2
            + ROLE_STR_GRAPH_LAYOUT_BLOB.len()
            + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_GRAPH_LAYOUT_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Build the AAD bound into the AEAD encryption of the v0.1 vault-indices
/// blob (`vault.indices`, `MYI1`, MYND-271; design MYND-31). Same shape as
/// [`aad_prefs_blob`] / [`aad_search_index_blob`] / [`aad_workspace_blob`] with
/// a distinct role string `"vault-indices-blob"`, so the structured-metadata
/// index blob is cryptographically domain-separated from prefs, search, and
/// workspace — a blob of one kind can never AEAD-verify under another's
/// key/AAD. DISTINCT from `aad_search_index_blob` (role `"search-index-blob"`):
/// `vault.indices` (structured metadata) and `vault.search` (BM25 full-text)
/// are separate blob families, one role each.
///
/// Layout (47 bytes):
///
/// ```text
/// "myne.v0.1|"                      10 bytes  (AAD prefix, § 5.2)
/// 0x01                               1 byte   (protocol_version, § 9.3)
/// u16_be(18) || "vault-indices-blob" 20 bytes (length-prefixed role)
/// account_number_hash               16 bytes  (vault identity binding, § 9.3 offset 6)
/// ```
///
/// `account_number_hash` (NOT `items_key_id`) binds vault identity: the
/// vault-indices blob lives outside the `items_key` lineage, same rationale as
/// `aad_prefs_blob` (the KEK derives directly from `root_key` via
/// `"myne.v0.1 vault-indices-key"`, so it survives a later epoch rotation).
pub fn aad_vault_indices_blob(account_number_hash: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_VAULT_INDICES_BLOB: &[u8] = b"vault-indices-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len()
            + 1
            + 2
            + ROLE_STR_VAULT_INDICES_BLOB.len()
            + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_VAULT_INDICES_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// AAD for the `vault.embeddings` AI-embeddings blob (`MYR1`, spec § 9.17.3).
///
/// ```text
/// AAD_ai_embeddings_blob =
///   AAD_prefix || protocol_version (1 B) || "ai-embeddings-blob" || account_number_hash (16 B)
/// ```
///
/// Mirrors [`aad_search_index_blob`] / [`aad_vault_indices_blob`] with a
/// DISTINCT role string `"ai-embeddings-blob"` — `vault.embeddings` (dense AI
/// vectors) is its own blob family (one magic / one KEK / one AAD role; `MYR1`
/// ≠ `MYS1` ≠ `MYI1`). `account_number_hash` (NOT `items_key_id`) binds vault
/// identity: the KEK derives directly from `root_key` via
/// `"myne.v0.1 ai-embeddings-key"`, so it survives a later epoch rotation. The
/// model-identity tuple that invalidates the cache on a model / dimension /
/// chunker change is carried INSIDE the engine-opaque payload (§ 9.17.2), NOT
/// this AAD — matching the `vault.search` `extractor_version` precedent.
pub fn aad_ai_embeddings_blob(account_number_hash: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_AI_EMBEDDINGS_BLOB: &[u8] = b"ai-embeddings-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len()
            + 1
            + 2
            + ROLE_STR_AI_EMBEDDINGS_BLOB.len()
            + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_AI_EMBEDDINGS_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Build the AAD bound into the AEAD encryption of the v0.1 AI conversations
/// catalog (`vault.chats`, `MYM1`, myne-md/myne#675; `protocol.md` § 9.23.2).
/// Same shape as [`aad_prefs_blob`] / [`aad_custom_themes_blob`] with a
/// distinct role string `"chats-catalog"`, so the catalog is cryptographically
/// domain-separated from every other singleton: a catalog blob can never
/// AEAD-verify under another family's key/AAD.
///
/// This builder stamps v0.1 ONLY (`AAD_PREFIX_V0_1` + `PROTOCOL_VERSION_V0_1`;
/// the v0.2 stamp lives in the dedicated `*_v0_2` mirrors): one magic travels
/// across generations and the generations separate at the AAD (§ 10.3.1), so a
/// cross-generation serve fails AEAD.
///
/// Layout (42 bytes for the v0.1 stamp):
///
/// ```text
/// "myne.v0.1|"                        10 bytes  (AAD prefix, § 5.2)
/// protocol_version                     1 byte   (caller's vault generation)
/// u16_be(13) || "chats-catalog"       15 bytes  (length-prefixed role)
/// account_number_hash                 16 bytes  (vault identity, § 9.3 offset 6)
/// ```
///
/// `account_number_hash` (NOT `items_key_id`) binds vault identity: the
/// catalog KEK derives directly from `root_key` via
/// `"myne.v0.1 chats-catalog-key"`, independent of the `itemsKey` lineage.
/// DISTINCT from the subkey role `"chats-catalog-key"` and from the per-file
/// role `"chats-blob"`.
///
/// The PREFIX follows the generation too (not just the version byte): `0x01`
/// stamps `"myne.v0.1|"`, `0x02` stamps `"myne.v0.2|"`. A v0.1-prefix/0x02-byte
/// (or v0.2-prefix/0x01-byte) hybrid matches nothing either generation seals,
/// so the two generations are separated at the AEAD layer, not just by the
/// magic. (The codecs validate the stamp before this builder is ever reached.)
pub fn aad_chats_catalog(account_number_hash: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_CHATS_CATALOG: &[u8] = b"chats-catalog";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len() + 1 + 2 + ROLE_STR_CHATS_CATALOG.len() + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_CHATS_CATALOG);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Build the AAD bound into the AEAD encryption of a per-conversation AI chat
/// blob (`chats/<conversation-id-hex>`, `MYJ1`, myne-md/myne#675;
/// `protocol.md` § 9.24.3). Follows the [`aad_attachment_text_blob`]
/// per-entry pattern with the 16-byte conversation id in the per-entry
/// position. This builder stamps v0.1 ONLY; the v0.2 stamp lives in the
/// dedicated `*_v0_2` mirror.
///
/// Layout (55 bytes for the v0.1 stamp):
///
/// ```text
/// "myne.v0.1|"                        10 bytes  (AAD prefix, § 5.2)
/// protocol_version                     1 byte   (caller's vault generation)
/// u16_be(10) || "chats-blob"          12 bytes  (length-prefixed role)
/// conversation_id                     16 bytes  (the conversation UUIDv7, § 9.24)
/// account_number_hash                 16 bytes  (vault identity, § 9.3 offset 6)
/// ```
///
/// Binding both ids prevents substituting one conversation's blob for another
/// within the same vault (the per-blob-safety property that lets ONE KEK
/// serve every conversation file, the `MYE1` archetype) and porting a blob
/// across vaults at the AEAD layer. `account_number_hash` (NOT `items_key_id`)
/// binds vault identity: `chats_key` derives via
/// `"myne.v0.1 chats-key"`, independent of the `items_key` lineage. DISTINCT
/// from the subkey role `"chats-key"` and from the singleton role
/// `"chats-catalog"`.
///
/// Like [`aad_chats_catalog`], the PREFIX follows the generation: `0x01`
/// stamps `"myne.v0.1|"`, `0x02` stamps `"myne.v0.2|"`, so no hybrid AAD is
/// expressible through the codec path.
pub fn aad_chats_blob(account_number_hash: &[u8; 16], conversation_id: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_CHATS_BLOB: &[u8] = b"chats-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len()
            + 1
            + 2
            + ROLE_STR_CHATS_BLOB.len()
            + conversation_id.len()
            + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_CHATS_BLOB);
    aad.extend_from_slice(conversation_id);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Generic **v0.2** conversation-file AAD, the next-major mirror of
/// [`aad_chats_blob`], stamped with the v0.2 prefix + version. The migration
/// re-seals a conversation file by decoding under `aad_chats_blob` and
/// re-encoding under this (§10.4.1).
pub fn aad_chats_blob_v0_2(account_number_hash: &[u8; 16], conversation_id: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_CHATS_BLOB: &[u8] = b"chats-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_2.len()
            + 1
            + 2
            + ROLE_STR_CHATS_BLOB.len()
            + conversation_id.len()
            + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_CHATS_BLOB);
    aad.extend_from_slice(conversation_id);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Build the AAD bound into the AEAD encryption of the agent-memory catalog
/// singleton (`vault.agent-memory`, `MYN1`, myne-md/myne#697; `protocol.md`
/// § 9.25.2). Mirrors [`aad_chats_catalog`] exactly, with the role string
/// `"agent-memory-catalog"` (20 ASCII bytes, length-prefixed: 2-B BE length
/// plus the 20 role bytes, 22 total) and the 16-byte `account_number_hash`
/// binding the catalog to its specific vault. Total AAD length is 49 bytes
/// (`10 + 1 + 22 + 16`). As with the whole `root_key`-derived singleton
/// family, `items_key_id` is **not** bound: the catalog KEK derives directly
/// from `root_key` via `"myne.v0.1 agent-memory-catalog-key"` (§ 3.4),
/// independent of the `itemsKey` lineage. DISTINCT from the subkey roles
/// `"agent-memory-catalog-key"` / `"agent-memory-catalog-sync-id"` and from
/// the per-entry role `"agent-memory-blob"`.
pub fn aad_agent_memory_catalog(account_number_hash: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_AGENT_MEMORY_CATALOG: &[u8] = b"agent-memory-catalog";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len()
            + 1
            + 2
            + ROLE_STR_AGENT_MEMORY_CATALOG.len()
            + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_AGENT_MEMORY_CATALOG);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Build the AAD bound into the AEAD seal of a per-entry agent-memory file
/// (`memories/<memory-id-hex>`, `MYX1`, myne-md/myne#697; `protocol.md`
/// § 9.26.3). Follows the [`aad_chats_blob`] per-entry pattern with the
/// 16-byte memory-entry id in the per-entry position.
///
/// Layout (62 bytes for the v0.1 stamp):
///
/// ```text
/// "myne.v0.1|"                        10 bytes  (AAD prefix, § 5.2)
/// protocol_version                     1 byte   (caller's vault generation)
/// u16_be(17) || "agent-memory-blob"   19 bytes  (length-prefixed role)
/// memory_entry_id                     16 bytes  (the entry UUIDv7, § 9.26)
/// account_number_hash                 16 bytes  (vault identity, § 9.3 offset 6)
/// ```
///
/// Binding both ids prevents substituting one entry's blob for another
/// within the same vault (the per-blob-safety property that lets ONE KEK
/// serve every entry file, the `MYE1` archetype) and porting a blob across
/// vaults at the AEAD layer. `account_number_hash` (NOT `items_key_id`)
/// binds vault identity: `agent_memory_key` derives via
/// `"myne.v0.1 agent-memory-key"`, independent of the `items_key` lineage.
/// DISTINCT from the subkey role `"agent-memory-key"` and from the singleton
/// role `"agent-memory-catalog"`.
pub fn aad_agent_memory_blob(
    account_number_hash: &[u8; 16],
    memory_entry_id: &[u8; 16],
) -> Vec<u8> {
    const ROLE_STR_AGENT_MEMORY_BLOB: &[u8] = b"agent-memory-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len()
            + 1
            + 2
            + ROLE_STR_AGENT_MEMORY_BLOB.len()
            + memory_entry_id.len()
            + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_AGENT_MEMORY_BLOB);
    aad.extend_from_slice(memory_entry_id);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Generic **v0.2** memory-entry AAD, the next-major mirror of
/// [`aad_agent_memory_blob`], stamped with the v0.2 prefix + version. The
/// migration re-seals a memory-entry file by decoding under
/// `aad_agent_memory_blob` and re-encoding under this (§10.4.1).
pub fn aad_agent_memory_blob_v0_2(
    account_number_hash: &[u8; 16],
    memory_entry_id: &[u8; 16],
) -> Vec<u8> {
    const ROLE_STR_AGENT_MEMORY_BLOB: &[u8] = b"agent-memory-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_2.len()
            + 1
            + 2
            + ROLE_STR_AGENT_MEMORY_BLOB.len()
            + memory_entry_id.len()
            + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_AGENT_MEMORY_BLOB);
    aad.extend_from_slice(memory_entry_id);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Build the AAD bound into the AEAD encryption of the agent-personality
/// singleton (`vault.personality`, `MYZ1`, myne-md/myne#697; `protocol.md`
/// § 9.27.2). Mirrors [`aad_prefs_blob`] exactly, with the role string
/// `"personality-blob"` (16 ASCII bytes, length-prefixed: 2-B BE length +
/// 16 = 18 bytes) and the 16-byte `account_number_hash` binding the blob to
/// its specific vault. Total AAD length: `10 + 1 + 18 + 16 = 45 bytes`. As
/// with the whole `root_key`-derived singleton family, `items_key_id` is
/// **not** bound: the personality KEK derives directly from `root_key` via
/// `"myne.v0.1 agent-personality-key"` (§ 3.4), independent of the
/// `itemsKey` lineage. DISTINCT from the subkey roles
/// `"agent-personality-key"` / `"agent-personality-sync-id"`.
pub fn aad_agent_personality_blob(account_number_hash: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_PERSONALITY_BLOB: &[u8] = b"personality-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len() + 1 + 2 + ROLE_STR_PERSONALITY_BLOB.len() + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_PERSONALITY_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad
}
/// Build the AAD bound into the AEAD seal of the vault membership field
/// (`vault.meta` §9.3.1, the account/vault split). The field is `NTV5`-only, so
/// this AAD is stamped with the **v0.2** prefix + version, mirroring
/// [`aad_prefs_blob`] in shape but under the v0.2 domain.
/// Build the AAD bound into the AEAD seal of the B2B **roster extension**
/// (b2b-identity-substrate, myne-md/myne#698 task 3; `vault.meta` §9.3.1
/// extension, NTV5 `reserved` byte `0x02`). Mirrors
/// [`aad_membership_blob`] with the role string `"membership-roster-blob"`
/// and the same 16-byte `account_number_hash` binding: the field stays
/// bound to its vault, so a roster copied from another vault fails AEAD
/// instead of silently regrouping. DISTINCT from `"membership-blob"` and
/// from `"person-keypair-blob"` (`person_key.rs`).
///
/// Layout (51 bytes):
///
/// ```text
/// "myne.v0.2|"                    10 bytes  (v0.2 AAD prefix, § 10.5)
/// 0x02                             1 byte   (protocol_version, § 9.3)
/// u16_be(22) || "membership-roster-blob"  24 bytes  (length-prefixed role, § 5.2)
/// account_number_hash             16 bytes  (vault identity binding, § 9.3 offset 6)
/// ```
pub fn aad_membership_roster_blob(account_number_hash: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_MEMBERSHIP_ROSTER_BLOB: &[u8] = b"membership-roster-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_2.len()
            + 1
            + 2
            + ROLE_STR_MEMBERSHIP_ROSTER_BLOB.len()
            + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_MEMBERSHIP_ROSTER_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Build the AAD bound into the AEAD seal of the vault membership field
/// (`vault.meta` §9.3.1, the account/vault split). The field is `NTV5`-only, so
/// this AAD is stamped with the **v0.2** prefix + version, mirroring
/// [`aad_prefs_blob`] in shape but under the v0.2 domain.
///
/// Layout (44 bytes):
///
/// ```text
/// "myne.v0.2|"                    10 bytes  (v0.2 AAD prefix, § 10.5)
/// 0x02                             1 byte   (protocol_version, § 9.3)
/// u16_be(15) || "membership-blob" 17 bytes  (length-prefixed role, § 5.2)
/// account_number_hash             16 bytes  (vault identity binding, § 9.3 offset 6)
/// ```
///
/// `account_number_hash` (NOT `items_key_id`) binds vault identity: the
/// membership field lives outside the `items_key` lineage, same rationale as
/// `aad_prefs_blob`. The KEK is `membership_key` (`SubkeyRole::MembershipKey`),
/// derived under the v0.2 context prefix.
pub fn aad_membership_blob(account_number_hash: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_MEMBERSHIP_BLOB: &[u8] = b"membership-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_2.len() + 1 + 2 + ROLE_STR_MEMBERSHIP_BLOB.len() + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_MEMBERSHIP_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Build the AAD bound into the AEAD seal of the vault's **person binding**
/// field (`vault.meta` §9.3.1 extension, myne-md/myne#768). The field records
/// which person identity a vault belongs to, so the identity-first first run can
/// show a vault under its person and a person's vaults can be enumerated.
///
/// `NTV5`-only, so stamped with the **v0.2** prefix + version like
/// [`aad_membership_blob`], whose shape it mirrors exactly. It binds
/// `account_number_hash` rather than `person_id_hash` for the same reason the
/// membership field does: the binding is to the VAULT's identity, so a
/// person-binding field copied from another vault fails AEAD rather than
/// silently re-labelling which person owns this vault. The sealed plaintext
/// carries the `person_id_hash`; the AAD carries the vault's salt binding.
///
/// The role string is DISTINCT from `"membership-blob"`, `"membership-roster-blob"`
/// and every person-keypair AAD: the person binding is a third, separate field
/// sealed under the same `membership_key`, and a role reused across fields
/// would let a swap between them verify.
///
/// Layout (44 bytes):
///
/// ```text
/// "myne.v0.2|"                        10 bytes  (v0.2 AAD prefix, § 10.5)
/// 0x02                                 1 byte   (protocol_version, § 9.3)
/// u16_be(19) || "person-binding-blob" 21 bytes  (length-prefixed role, § 5.2)
/// account_number_hash                 16 bytes  (vault identity binding)
/// ```
pub fn aad_person_binding_blob(account_number_hash: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_PERSON_BINDING_BLOB: &[u8] = b"person-binding-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_2.len()
            + 1
            + 2
            + ROLE_STR_PERSON_BINDING_BLOB.len()
            + account_number_hash.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_PERSON_BINDING_BLOB);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// Build the AAD bound into the AEAD encryption of a pending-capture blob
/// (`captures/<capture-id>`, `MYK1`, MYND watch-capture; `protocol.md`
/// § 9.18.3). Unlike every other § 9 blob AAD, it binds NEITHER
/// `account_number_hash` NOR `items_key_id`: a pending capture is enqueued
/// while the vault is **locked** and is vault-agnostic (it drains into
/// whichever vault unlocks first). Instead it binds the per-entry `capture_id`
/// (the 16-byte UUIDv7 that is also the device-local queue filename), so a
/// tampered header `capture_id` fails AEAD rather than silently re-labelling
/// the entry. The binding is on the header id, not the filename: a sealed
/// entry copied to a second name still opens, and it is the reader that must
/// notice (§ 9.18.4).
///
/// Layout (49 bytes):
///
/// ```text
/// "myne.v0.1|"                          10 bytes  (AAD prefix, § 5.2)
/// 0x01                                   1 byte   (protocol_version, § 9.18.1)
/// u16_be(20) || "pending-capture-blob"  22 bytes  (length-prefixed role)
/// capture_id                            16 bytes  (per-entry UUIDv7, § 9.18.1)
/// ```
///
/// The blob has no `DeriveSubkey` role — its KEK is a device-local key held in
/// the OS keychain, NOT `root_key`-derived (the queue must survive while
/// `root_key` is unavailable; § 3.4). DISTINCT from every vault-scoped blob
/// role.
pub fn aad_capture_blob(capture_id: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_PENDING_CAPTURE_BLOB: &[u8] = b"pending-capture-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len() + 1 + 2 + ROLE_STR_PENDING_CAPTURE_BLOB.len() + capture_id.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_PENDING_CAPTURE_BLOB);
    aad.extend_from_slice(capture_id);
    aad
}

/// Build the AAD bound into the AEAD encryption of a share-import staging blob
/// (`MYF1`, § 9.20.3). Binds the per-entry `share_id`; a DISTINCT device-local
/// role from every vault-scoped blob AND from `pending-capture-blob`.
///
/// Layout (46 bytes):
///
/// ```text
/// "myne.v0.1|"                      10 bytes  (AAD prefix, § 5.2)
/// 0x01                               1 byte   (protocol_version, § 9.20.3)
/// u16_be(17) || "share-import-blob" 19 bytes  (length-prefixed role)
/// share_id                          16 bytes  (per-entry id, § 9.20.3)
/// ```
///
/// Like `aad_capture_blob`, no `DeriveSubkey` role — the KEK is a device-local
/// key held in the OS keychain / Android Keystore, NOT `root_key`-derived (the
/// queue must survive while `root_key` is unavailable; § 3.4).
pub fn aad_share_import_blob(share_id: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_SHARE_IMPORT_BLOB: &[u8] = b"share-import-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len() + 1 + 2 + ROLE_STR_SHARE_IMPORT_BLOB.len() + share_id.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_SHARE_IMPORT_BLOB);
    aad.extend_from_slice(share_id);
    aad
}

/// Build the AAD bound into the AEAD encryption of a sealed label blob
/// (`vault.label`, `MYL1`, § 9.22.3). A DISTINCT device-local role from every
/// vault-scoped blob AND from `pending-capture-blob` / `share-import-blob`.
///
/// Layout (45 bytes):
///
/// ```text
/// "myne.v0.1|"                     10 bytes  (AAD prefix, § 5.2)
/// 0x01                              1 byte   (protocol_version, § 9.22.1)
/// u16_be(16) || "vault-label-blob" 18 bytes  (length-prefixed role)
/// vault_id                         16 bytes  (the UUIDv7 naming vaults/<id>/)
/// ```
///
/// Like `aad_capture_blob` and `aad_share_import_blob`, no `DeriveSubkey` role:
/// the KEK is a device-local key held in the OS keychain, NOT `root_key`-derived
/// (§ 3.4). It derives from neither because the label must be readable while the
/// vault is LOCKED, and it must be destroyable on its own so that deleting one
/// vault erases exactly one name.
///
/// Unlike those two it is **not vault-agnostic**: it binds the 16-byte `VaultId`
/// of the directory the blob lives in, and the caller passes the id it EXPECTS
/// rather than the one the blob claims. That is what closes, structurally, the
/// copied-to-another-name gap § 9.18.3 and § 9.20.3 both have to leave to a
/// reader-side check.
pub fn aad_vault_label_blob(vault_id: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_VAULT_LABEL_BLOB: &[u8] = b"vault-label-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len() + 1 + 2 + ROLE_STR_VAULT_LABEL_BLOB.len() + vault_id.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_VAULT_LABEL_BLOB);
    aad.extend_from_slice(vault_id);
    aad
}

/// AAD for the device-local member-vault key store (myne-md/myne#711 task 25):
/// the member's group and items keys sealed at rest. Binds the vault id the
/// reader expected AND the vault's account-number hash, so a store copied to
/// another vault name does not open. v0.2 prefix, matching the person plane.
pub fn aad_person_member_key_store(vault_id: &[u8; 16], account_number_hash: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_PERSON_MEMBER_KEY_STORE: &[u8] = b"person-member-key-store";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_2.len() + 1 + 2 + ROLE_STR_PERSON_MEMBER_KEY_STORE.len() + 32,
    );
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_PERSON_MEMBER_KEY_STORE);
    aad.extend_from_slice(vault_id);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// AAD for the device-local member vault-unlock credential store
/// (`vault.member-unlock`): the member's group and items keys plus their person
/// keypair sealed at rest under a member-chosen password, so a member vault
/// re-unlocks without the 24-word recovery phrase. A distinct device-local role
/// from `person-member-key-store` (the phrase store). Binds the vault id the
/// reader expected AND the vault's account-number hash, so a store copied to
/// another vault name or re-labelled to another account does not open. v0.2
/// prefix, matching the person plane.
pub fn aad_person_member_unlock_store(
    vault_id: &[u8; 16],
    account_number_hash: &[u8; 16],
) -> Vec<u8> {
    const ROLE_STR_PERSON_MEMBER_UNLOCK_STORE: &[u8] = b"person-member-unlock-store";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_2.len() + 1 + 2 + ROLE_STR_PERSON_MEMBER_UNLOCK_STORE.len() + 32,
    );
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_PERSON_MEMBER_UNLOCK_STORE);
    aad.extend_from_slice(vault_id);
    aad.extend_from_slice(account_number_hash);
    aad
}

/// AAD for the device-local, vault-bound person-identity carrier
/// (the device-local carrier file `<app_config_dir>/person-vault-carriers/<vault_id_hex>.json`): the person keypair sealed at rest
/// under the owner `root_key`, so an `NTV6` owner-vault unlock installs the
/// person session without the recovery phrase. Binds the vault id the reader
/// expected AND the person id, so a carrier copied to another vault, or one for
/// a different person, does not open. v0.2 prefix, matching the person plane.
pub fn aad_person_vault_carrier(vault_id: &[u8; 16], person_id: &[u8; 16]) -> Vec<u8> {
    const ROLE_STR_PERSON_VAULT_CARRIER_BLOB: &[u8] = b"person-vault-carrier-blob";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_2.len() + 1 + 2 + ROLE_STR_PERSON_VAULT_CARRIER_BLOB.len() + 32,
    );
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    push_length_prefixed_u16_be(&mut aad, ROLE_STR_PERSON_VAULT_CARRIER_BLOB);
    aad.extend_from_slice(vault_id);
    aad.extend_from_slice(person_id);
    aad
}

/// Build the AAD bound into the AEAD encryption of a note's
/// plaintext under its per-note `item_key` (spec § 5.2 + § 6.2).
///
/// Layout (58 bytes for v0.1's hardcoded `content_type`):
///
/// ```text
/// "myne.v0.1|"             10 bytes  (AAD prefix, § 5.2)
/// 0x01                      1 byte   (protocol_version, § 9.3)
/// items_key_id             16 bytes
/// note_uuid                16 bytes
/// u16_be(13) || "text/markdown"  15 bytes  (length-prefixed UTF-8, § 5.2)
/// ```
///
/// `content_type` is **hardcoded** to `"text/markdown"` in v0.1 per
/// spec § 5.2 — encoder and decoder both bind the same constant, so
/// any future next-major attachment type would diverge at the AAD prefix
/// level rather than via a parameter on this v0.1 helper. v0.1 and
/// a later major version are forward-incompatible by design (§ 10).
pub fn aad_note_content_encrypt(items_key_id: &[u8; 16], note_uuid: &[u8; 16]) -> Vec<u8> {
    const CONTENT_TYPE: &[u8] = b"text/markdown";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_1.len() + 1 + items_key_id.len() + note_uuid.len() + 2 + CONTENT_TYPE.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    aad.extend_from_slice(items_key_id);
    aad.extend_from_slice(note_uuid);
    push_length_prefixed_u16_be(&mut aad, CONTENT_TYPE);
    aad
}

/// Build the AAD bound into the AEAD wrap of a per-note `item_key` under the
/// vault `itemsKey` for the **next-major `NC05` CRDT note-type**
/// (`docs/spec/protocol.md` § 5.2 next-major row; automerge-sync-migration).
///
/// Byte-identical **layout** to [`aad_note_item_key_wrap`] (prefix · version ·
/// items_key_id · note_uuid) but stamped with the next-major prefix
/// [`AAD_PREFIX_V0_2`] + version [`PROTOCOL_VERSION_V0_2`], so an `NC05` wrap
/// tag is domain-separated from a v0.1 `MY01` one and neither opens the other.
pub fn aad_nc05_item_key_wrap(items_key_id: &[u8; 16], note_uuid: &[u8; 16]) -> Vec<u8> {
    let mut aad =
        Vec::with_capacity(AAD_PREFIX_V0_2.len() + 1 + items_key_id.len() + note_uuid.len());
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    aad.extend_from_slice(items_key_id);
    aad.extend_from_slice(note_uuid);
    aad
}

/// Build the AAD bound into the AEAD encryption of an `NC05` note's **opaque
/// Automerge payload** under its per-note `item_key` (automerge-sync-migration).
///
/// Byte-identical **layout** to [`aad_note_content_encrypt`] — `content_type`
/// stays the hardcoded `"text/markdown"` (the 4-byte magic, not the AAD,
/// discriminates the CRDT codec from `MY01`) — but stamped with the next-major
/// prefix [`AAD_PREFIX_V0_2`] + version [`PROTOCOL_VERSION_V0_2`].
pub fn aad_nc05_content_encrypt(items_key_id: &[u8; 16], note_uuid: &[u8; 16]) -> Vec<u8> {
    const CONTENT_TYPE: &[u8] = b"text/markdown";
    let mut aad = Vec::with_capacity(
        AAD_PREFIX_V0_2.len() + 1 + items_key_id.len() + note_uuid.len() + 2 + CONTENT_TYPE.len(),
    );
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    aad.extend_from_slice(items_key_id);
    aad.extend_from_slice(note_uuid);
    push_length_prefixed_u16_be(&mut aad, CONTENT_TYPE);
    aad
}

/// Append `bytes` to `buf` prefixed by its length as a 2-byte
/// big-endian unsigned integer per `protocol.md` § 5.2's
/// length-prefix convention.
///
/// Writer-style on purpose: the length-and-bytes pair is emitted as a
/// single call so a buggy caller cannot write a length without the
/// payload (or vice versa). Single source of truth for every
/// length-prefixed AAD field in this crate.
///
/// Panics — in **every** build, debug and release — if
/// `bytes.len() > u16::MAX`. v0.1 inputs (role strings of 13 bytes;
/// `content_type`, hardcoded 13 bytes for `.myn` and a sniffed MIME
/// string for `MYA1`) are bounded well below this limit, so the branch
/// is unreachable in practice; it exists to catch a future caller that
/// would otherwise silently truncate via `as u16` and emit an AAD that
/// two different payloads share. It was a `debug_assert!` until the
/// registry-chokepoint audit (epic #249): a release-absent check is not
/// the protection this comment claimed, and one comparison per AAD
/// build is nothing beside XChaCha20-Poly1305 + SHA-256.
pub(crate) fn push_length_prefixed_u16_be(buf: &mut Vec<u8>, bytes: &[u8]) {
    assert!(
        bytes.len() <= u16::MAX as usize,
        "length-prefixed bytes longer than u16 length-prefix can encode",
    );
    buf.extend_from_slice(&(bytes.len() as u16).to_be_bytes());
    buf.extend_from_slice(bytes);
}

/// Common AAD assembly. Length prefixes are encoded as **u16
/// big-endian** per `protocol.md` § 5.2.
fn build_wrap_aad(role: &[u8], kdf_params: &KdfParams) -> Vec<u8> {
    let kdf_canonical = serialize_kdf_params(kdf_params);

    let mut aad =
        Vec::with_capacity(AAD_PREFIX_V0_1.len() + 1 + 2 + role.len() + kdf_canonical.len());
    aad.extend_from_slice(AAD_PREFIX_V0_1);
    aad.push(PROTOCOL_VERSION_V0_1);
    push_length_prefixed_u16_be(&mut aad, role);
    aad.extend_from_slice(&kdf_canonical);
    aad
}

/// v0.2 mirror of [`build_wrap_aad`] — identical assembly under the next-major
/// prefix + version, so the wrap-AAD role-separation and KDF-param binding carry
/// into v0.2 unchanged (`spec/protocol.md` §10.4.1).
fn build_wrap_aad_v0_2(role: &[u8], kdf_params: &KdfParams) -> Vec<u8> {
    let kdf_canonical = serialize_kdf_params(kdf_params);

    let mut aad =
        Vec::with_capacity(AAD_PREFIX_V0_2.len() + 1 + 2 + role.len() + kdf_canonical.len());
    aad.extend_from_slice(AAD_PREFIX_V0_2);
    aad.push(PROTOCOL_VERSION_V0_2);
    push_length_prefixed_u16_be(&mut aad, role);
    aad.extend_from_slice(&kdf_canonical);
    aad
}

/// Encrypt `plaintext` under XChaCha20-Poly1305 with the CTX
/// commitment wrapper (spec § 5.1).
///
/// Returns `ciphertext || T'`, a single byte vector laid out exactly
/// as it lands on disk in `vault.meta` (e.g. § 9.3 offset 89's
/// `enc_root_key_password` field). The Poly1305 tag `T` is **not**
/// stored — only the 32-byte `T'` follows the ciphertext.
///
/// For a 32-byte plaintext (`root_key`) the output is exactly 64 bytes
/// (32 ciphertext + 32 commitment), matching spec § 9.3.
///
/// Failure mode: AAD longer than `u32::MAX` bytes — the `len(AD)[4 BE]`
/// field in the canonical CTX encoding cannot represent it. v0.1 AADs
/// are bounded at 37 bytes by [`aad_password_wrap`] / [`aad_recovery_wrap`],
/// so this is theoretically unreachable in practice.
pub fn aead_seal_ctx(
    key: &[u8; AEAD_KEY_LEN],
    nonce: &[u8; AEAD_NONCE_LEN],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, ProtocolError> {
    if aad.len() > u32::MAX as usize {
        return Err(ProtocolError::AeadFailure);
    }

    let mut chacha = XChaCha20::new(key.into(), nonce.into());

    // Block 0 (first 32 bytes): Poly1305 one-time key (RFC 8439 §2.6).
    // The remaining 32 bytes of block 0 are unused; we seek past them
    // before encrypting the plaintext (RFC 8439 §2.8 step 1 — the
    // counter is set to 1 for encryption).
    let mut poly_key = Zeroizing::new([0u8; 32]);
    chacha.apply_keystream(poly_key.as_mut_slice());
    chacha.seek(CHACHA20_BLOCK_SIZE);

    // Encrypt plaintext = ciphertext (XChaCha20 is a stream cipher;
    // encrypt and decrypt are the same XOR with the keystream).
    let mut ciphertext = plaintext.to_vec();
    chacha.apply_keystream(&mut ciphertext);

    // Compute Poly1305 MAC over (AAD || pad16 || ciphertext || pad16 ||
    // u64_le(len(AAD)) || u64_le(len(ciphertext))) per RFC 8439 §2.8.
    let poly_tag = poly1305_aead_mac(&poly_key, aad, &ciphertext);

    // CTX commitment T' = SHA-256(K || N || len(AD)[4 BE] || AD || T).
    let t_prime = ctx_canonical_hash(key, nonce, aad, &poly_tag);

    // Output: ciphertext || T'.
    let mut out = ciphertext;
    out.extend_from_slice(&t_prime);
    Ok(out)
}

/// Decrypt a CTX-wrapped XChaCha20-Poly1305 ciphertext.
///
/// `sealed` is the byte sequence produced by [`aead_seal_ctx`]:
/// `ciphertext || T'` where `T'` is the trailing 32-byte CTX
/// commitment. The function recomputes the Poly1305 tag over `(K, N,
/// AAD, ciphertext)`, derives `T'_expected`, and constant-time
/// compares against the supplied `T'`. On match, the ciphertext is
/// XOR-decrypted and returned in a [`Zeroizing`] wrapper.
///
/// Returns [`ProtocolError::AeadFailure`] for any of: short input
/// (less than 32 bytes), tag mismatch (wrong key, nonce, AAD, or
/// tampered ciphertext / `T'`), or AAD overflow. Per spec § 7.3 the
/// caller MUST NOT distinguish these cases to the user beyond
/// "phrase or vault is invalid".
pub fn aead_open_ctx(
    key: &[u8; AEAD_KEY_LEN],
    nonce: &[u8; AEAD_NONCE_LEN],
    sealed: &[u8],
    aad: &[u8],
) -> Result<Zeroizing<Vec<u8>>, ProtocolError> {
    if aad.len() > u32::MAX as usize {
        return Err(ProtocolError::AeadFailure);
    }
    if sealed.len() < CTX_COMMITMENT_TAG_LEN {
        return Err(ProtocolError::AeadFailure);
    }

    let split = sealed.len() - CTX_COMMITMENT_TAG_LEN;
    let ciphertext = &sealed[..split];
    let t_prime: &[u8; CTX_COMMITMENT_TAG_LEN] = sealed[split..]
        .try_into()
        .expect("trailing slice is exactly CTX_COMMITMENT_TAG_LEN by construction");

    let mut chacha = XChaCha20::new(key.into(), nonce.into());

    // Re-derive the Poly1305 one-time key.
    let mut poly_key = Zeroizing::new([0u8; 32]);
    chacha.apply_keystream(poly_key.as_mut_slice());
    chacha.seek(CHACHA20_BLOCK_SIZE);

    // Recompute T from (K, N, AAD, ciphertext).
    let poly_tag = poly1305_aead_mac(&poly_key, aad, ciphertext);

    // Recompute T'_expected and constant-time compare.
    let t_prime_expected = ctx_canonical_hash(key, nonce, aad, &poly_tag);
    if !bool::from(t_prime_expected.ct_eq(t_prime)) {
        return Err(ProtocolError::AeadFailure);
    }

    // Commitment verified ⇒ decrypt without re-checking Poly1305.
    let mut plaintext = Zeroizing::new(ciphertext.to_vec());
    chacha.apply_keystream(plaintext.as_mut_slice());
    Ok(plaintext)
}

/// Compute the Poly1305 AEAD MAC per RFC 8439 §2.8:
///
/// ```text
/// MAC = Poly1305(
///         key  = poly_key (32 bytes from XChaCha20 keystream block 0),
///         data = AAD || pad16(AAD)
///             || ciphertext || pad16(ciphertext)
///             || u64_le(len(AAD)) || u64_le(len(ciphertext))
///       )
/// ```
fn poly1305_aead_mac(poly_key: &[u8; 32], aad: &[u8], ciphertext: &[u8]) -> [u8; POLY1305_TAG_LEN] {
    let key = poly1305::Key::from_slice(poly_key);
    let mut mac = Poly1305::new(key);

    mac.update_padded(aad);
    mac.update_padded(ciphertext);

    let mut len_block = [0u8; 16];
    len_block[..8].copy_from_slice(&(aad.len() as u64).to_le_bytes());
    len_block[8..].copy_from_slice(&(ciphertext.len() as u64).to_le_bytes());
    let block = poly1305::Block::from_slice(&len_block);
    mac.update(core::slice::from_ref(block));

    let tag = mac.finalize();
    let mut out = [0u8; POLY1305_TAG_LEN];
    out.copy_from_slice(tag.as_slice());
    out
}

/// Canonical-encode `(K, N, AD, T)` per spec § 5.1.1 and hash with
/// SHA-256 to produce the CTX commitment tag `T'`:
///
/// ```text
/// T' = SHA-256( K[32] || N[24] || len(AD)[4 BE] || AD || T[16] )
/// ```
///
/// Length-prefixing AAD eliminates concatenation ambiguity per
/// Chan-Rogaway 2022 §3 (without it, an attacker could shift bytes
/// between the variable AAD region and an adjacent fixed region to
/// produce two distinct inputs with the same hash).
fn ctx_canonical_hash(
    key: &[u8; AEAD_KEY_LEN],
    nonce: &[u8; AEAD_NONCE_LEN],
    aad: &[u8],
    poly_tag: &[u8; POLY1305_TAG_LEN],
) -> [u8; CTX_COMMITMENT_TAG_LEN] {
    let mut h = Sha256::new();
    h.update(key);
    h.update(nonce);
    h.update((aad.len() as u32).to_be_bytes());
    h.update(aad);
    h.update(poly_tag);
    let result = h.finalize();
    let mut out = [0u8; CTX_COMMITMENT_TAG_LEN];
    out.copy_from_slice(&result);
    out
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use crate::test_vector_fmt::{hex_lower, json_escape};
    use crate::types::DEFAULT_V0_1_KDF_PARAMS;

    #[test]
    fn singleton_blob_generic_matches_the_per_family_builders() {
        // The migration re-seal (§10.4.1) decodes a KEK singleton under
        // `aad_singleton_blob(role, hash)`; that MUST be byte-identical to the
        // family's own AAD builder or the decode fails. Pin it for every
        // real-content KEK family the migration re-seals.
        let hash = [0x44u8; 16];
        assert_eq!(
            aad_singleton_blob(b"prefs-blob", &hash),
            aad_prefs_blob(&hash)
        );
        assert_eq!(
            aad_singleton_blob(b"custom-themes-blob", &hash),
            aad_custom_themes_blob(&hash)
        );
        assert_eq!(
            aad_singleton_blob(b"personal-dictionary-blob", &hash),
            aad_personal_dictionary_blob(&hash)
        );
        // And the v0.2 form differs from v0.1 for the same role (domain sep).
        assert_ne!(
            aad_singleton_blob(b"custom-themes-blob", &hash),
            aad_singleton_blob_v0_2(b"custom-themes-blob", &hash)
        );
    }

    /// Hand-derived golden bytes for `aad_password_wrap(default)`.
    ///
    /// 37 bytes total, broken down by spec § 3.1 + § 5.2 + § 4.3:
    /// - 10 bytes: `b"myne.v0.1|"`
    /// - 1 byte:   `0x01` (protocol_version)
    /// - 2 bytes:  `0x00 0x0D` (u16 BE length = 13)
    /// - 13 bytes: `b"password-wrap"`
    /// - 11 bytes: KDF canonical = `01 00 04 00 00 00 00 00 03 02 13`
    const AAD_PASSWORD_WRAP_DEFAULT_GOLDEN: [u8; 37] = [
        // "myne.v0.1|"
        0x6D, 0x79, 0x6E, 0x65, 0x2E, 0x76, 0x30, 0x2E, 0x31, 0x7C, // protocol_version
        0x01, // u16 BE 13
        0x00, 0x0D, // "password-wrap"
        0x70, 0x61, 0x73, 0x73, 0x77, 0x6F, 0x72, 0x64, 0x2D, 0x77, 0x72, 0x61, 0x70,
        // KDF canonical (default v0.1)
        0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x02, 0x13,
    ];

    /// Same shape as `AAD_PASSWORD_WRAP_DEFAULT_GOLDEN` with the role
    /// string replaced by `b"recovery-wrap"`.
    const AAD_RECOVERY_WRAP_DEFAULT_GOLDEN: [u8; 37] = [
        // "myne.v0.1|"
        0x6D, 0x79, 0x6E, 0x65, 0x2E, 0x76, 0x30, 0x2E, 0x31, 0x7C, // protocol_version
        0x01, // u16 BE 13
        0x00, 0x0D, // "recovery-wrap"
        0x72, 0x65, 0x63, 0x6F, 0x76, 0x65, 0x72, 0x79, 0x2D, 0x77, 0x72, 0x61, 0x70,
        // KDF canonical (default v0.1)
        0x01, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x02, 0x13,
    ];

    #[test]
    fn aad_prefix_is_exactly_myne_v0_1_with_pipe() {
        assert_eq!(AAD_PREFIX_V0_1, b"myne.v0.1|");
        assert_eq!(AAD_PREFIX_V0_1.len(), 10);
        assert_eq!(AAD_PREFIX_V0_1[9], b'|');
    }

    #[test]
    fn aad_prefix_differs_from_hkdf_prefix_only_in_final_byte() {
        // Twin-prefix gotcha: spec § 1.2 + § 5.2 lock both prefixes at
        // 10 bytes with bytes [0..9] identical and byte 9 different.
        // If anyone unifies the constants by mistake, every vault on
        // disk becomes unreadable.
        let aad_prefix = AAD_PREFIX_V0_1;
        let hkdf_prefix = b"myne.v0.1 ";
        assert_eq!(aad_prefix.len(), hkdf_prefix.len());
        for i in 0..9 {
            assert_eq!(aad_prefix[i], hkdf_prefix[i], "byte {i} differs");
        }
        assert_ne!(aad_prefix[9], hkdf_prefix[9]);
        assert_eq!(aad_prefix[9], b'|');
        assert_eq!(hkdf_prefix[9], b' ');
    }

    #[test]
    fn role_string_constants_match_spec_registry() {
        // Spec § 3.1 names "password-wrap" and "recovery-wrap"; both
        // happen to be 13 bytes. Length coincidence is incidental.
        assert_eq!(ROLE_STR_PASSWORD_WRAP, b"password-wrap");
        assert_eq!(ROLE_STR_RECOVERY_WRAP, b"recovery-wrap");
        assert_eq!(ROLE_STR_PASSWORD_WRAP.len(), 13);
        assert_eq!(ROLE_STR_RECOVERY_WRAP.len(), 13);
    }

    #[test]
    fn push_length_prefixed_u16_be_writes_zero_length_for_empty() {
        let mut buf = Vec::new();
        push_length_prefixed_u16_be(&mut buf, b"");
        assert_eq!(buf, [0x00, 0x00]);
    }

    #[test]
    fn push_length_prefixed_u16_be_writes_short_string() {
        let mut buf = Vec::new();
        push_length_prefixed_u16_be(&mut buf, b"text/markdown");
        assert_eq!(buf.len(), 2 + 13);
        assert_eq!(buf[0..2], [0x00, 0x0D]);
        assert_eq!(&buf[2..], b"text/markdown");
    }

    #[test]
    fn push_length_prefixed_u16_be_appends_does_not_replace() {
        // Prove the writer-style helper appends to an existing buffer
        // rather than overwriting — load-bearing for callers that
        // assemble AADs in-place.
        let mut buf = Vec::new();
        buf.extend_from_slice(&[0xAA, 0xBB]);
        push_length_prefixed_u16_be(&mut buf, b"hi");
        assert_eq!(buf.as_slice(), &[0xAA, 0xBB, 0x00, 0x02, b'h', b'i']);
    }

    #[test]
    fn push_length_prefixed_u16_be_writes_two_byte_length_at_or_above_256() {
        // 256 bytes triggers the high byte of the u16 length: 0x01 0x00.
        let payload = [0x42u8; 256];
        let mut buf = Vec::new();
        push_length_prefixed_u16_be(&mut buf, &payload);
        assert_eq!(buf.len(), 2 + 256);
        assert_eq!(buf[0..2], [0x01, 0x00]);
        assert!(buf[2..].iter().all(|b| *b == 0x42));
    }

    #[test]
    #[should_panic(expected = "longer than u16 length-prefix can encode")]
    fn push_length_prefixed_u16_be_panics_above_u16_max() {
        // The truncation guard is a release-present `assert!`, not a
        // `debug_assert!` (epic #249): `65536 as u16` is 0, so a caller
        // that overflowed would emit a zero-length prefix followed by
        // the payload — an AAD two different payloads can share, with
        // no error anywhere. Run under `cargo test --release` too: that
        // is the lane where a revert to `debug_assert!` shows up.
        let payload = alloc::vec![0x42u8; u16::MAX as usize + 1];
        let mut buf = Vec::new();
        push_length_prefixed_u16_be(&mut buf, &payload);
    }

    #[test]
    fn push_length_prefixed_u16_be_accepts_exactly_u16_max() {
        // The boundary the assert must NOT reject.
        let payload = alloc::vec![0x42u8; u16::MAX as usize];
        let mut buf = Vec::new();
        push_length_prefixed_u16_be(&mut buf, &payload);
        assert_eq!(buf[0..2], [0xFF, 0xFF]);
        assert_eq!(buf.len(), 2 + u16::MAX as usize);
    }

    #[test]
    fn aad_password_wrap_default_is_thirty_seven_bytes() {
        // 10 (prefix) + 1 (version) + 2 (length prefix) + 13 (role) +
        // 11 (KDF canonical) = 37.
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        assert_eq!(aad.len(), 37);
    }

    #[test]
    fn aad_password_wrap_default_matches_pinned_hex() {
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        assert_eq!(aad.as_slice(), &AAD_PASSWORD_WRAP_DEFAULT_GOLDEN[..]);
    }

    #[test]
    fn aad_recovery_wrap_default_matches_pinned_hex() {
        let aad = aad_recovery_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        assert_eq!(aad.as_slice(), &AAD_RECOVERY_WRAP_DEFAULT_GOLDEN[..]);
    }

    #[test]
    fn password_and_recovery_aads_differ_only_in_role_bytes() {
        // Spec § 3.1 role separation: the two AADs MUST differ. By
        // construction the only differing region is bytes 13..26 (the
        // 13-byte role string after the u16 length prefix).
        let pw = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        let rec = aad_recovery_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        assert_eq!(pw.len(), rec.len());
        for i in 0..pw.len() {
            if (13..26).contains(&i) {
                continue; // role-string region — expected to differ
            }
            assert_eq!(pw[i], rec[i], "byte {i} should match between the two AADs");
        }
        // And the two AADs as a whole are not equal.
        assert_ne!(pw, rec);
    }

    #[test]
    fn aad_changes_when_kdf_params_change() {
        // Parameter-downgrade defense (spec § 4.3 last paragraph):
        // tampering with any KDF byte changes the AAD, which fails
        // the AEAD tag check at unlock time.
        let baseline = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        let mut tampered = DEFAULT_V0_1_KDF_PARAMS;
        tampered.t = 4; // attacker tries different iterations
        let attacked = aad_password_wrap(&tampered);
        assert_ne!(baseline, attacked);
        // Specifically, the last 11 bytes (KDF canonical region)
        // should be the only difference.
        for i in 0..(baseline.len() - 11) {
            assert_eq!(baseline[i], attacked[i], "byte {i} unexpectedly differs");
        }
    }

    #[test]
    fn length_prefix_is_u16_big_endian() {
        // Bytes 11..13 (after 10-byte prefix + 1-byte version) carry
        // the u16-BE length of the role string. Both AADs use a
        // 13-byte role, so bytes 11..13 are 0x00 0x0D.
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        assert_eq!(aad[11], 0x00);
        assert_eq!(aad[12], 0x0D);
    }

    #[test]
    fn aad_prefs_blob_default_matches_pinned_hex() {
        // Spec § 5.2 + § 9.5.3: 39 bytes = prefix (10) + version (1) +
        // u16_be(10) + "prefs-blob" (10) + account_number_hash (16).
        let account_number_hash: [u8; 16] = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        let aad = aad_prefs_blob(&account_number_hash);
        let expected: [u8; 39] = [
            // "myne.v0.1|": 10 bytes
            0x6D, 0x79, 0x6E, 0x65, 0x2E, 0x76, 0x30, 0x2E, 0x31, 0x7C,
            // protocol_version
            0x01, // length-prefixed role string: u16_be(10) || "prefs-blob"
            0x00, 0x0A, // u16_be(10)
            0x70, 0x72, 0x65, 0x66, 0x73, 0x2D, 0x62, 0x6C, 0x6F, 0x62, // "prefs-blob"
            // account_number_hash
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        assert_eq!(aad.as_slice(), &expected[..]);
        assert_eq!(aad.len(), 39, "spec § 9.5.3 mandates 39-byte AAD");
    }

    #[test]
    fn aad_prefs_blob_changes_with_account_number_hash() {
        // Cross-vault binding: different account_number_hash ⇒
        // different AAD ⇒ AEAD verification fails when a vault.prefs
        // from vault A is placed in vault B's directory.
        let hash_a = [0x00; 16];
        let mut hash_b = [0x00; 16];
        hash_b[0] = 1;
        let aad_a = aad_prefs_blob(&hash_a);
        let aad_b = aad_prefs_blob(&hash_b);
        assert_ne!(aad_a, aad_b);
        // First 23 bytes (prefix + version + length-prefixed role) match —
        // only the account_number_hash region (bytes 23..39) differs.
        assert_eq!(&aad_a[..23], &aad_b[..23]);
    }

    #[test]
    fn aad_prefs_blob_distinct_from_vault_items_key_wrap_aad() {
        // Cross-AAD distinctness: even if a future collision aligned the
        // account_number_hash bytes with an items_key_id byte sequence,
        // the role string ("prefs-blob" length-prefixed vs no role
        // string at all) makes the two AADs structurally different.
        let id: [u8; 16] = [0x00; 16];
        let prefs_aad = aad_prefs_blob(&id);
        let items_aad = aad_vault_items_key_wrap(&id);
        assert_ne!(prefs_aad, items_aad);
        assert_ne!(prefs_aad.len(), items_aad.len());
    }

    #[test]
    fn aad_vault_indices_blob_default_matches_pinned_hex() {
        // Spec § 5.2 + § 9.8.3: 47 bytes = prefix (10) + version (1) +
        // u16_be(18) + "vault-indices-blob" (18) + account_number_hash (16).
        let account_number_hash: [u8; 16] = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        let aad = aad_vault_indices_blob(&account_number_hash);
        let expected: [u8; 47] = [
            // "myne.v0.1|": 10 bytes
            0x6D, 0x79, 0x6E, 0x65, 0x2E, 0x76, 0x30, 0x2E, 0x31, 0x7C,
            // protocol_version
            0x01, // length-prefixed role string: u16_be(18) || "vault-indices-blob"
            0x00, 0x12, // u16_be(18)
            0x76, 0x61, 0x75, 0x6C, 0x74, 0x2D, 0x69, 0x6E, 0x64, 0x69, 0x63, 0x65, 0x73, 0x2D,
            0x62, 0x6C, 0x6F, 0x62, // "vault-indices-blob"
            // account_number_hash
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        assert_eq!(aad.as_slice(), &expected[..]);
        assert_eq!(aad.len(), 47, "spec § 9.8.3 mandates 47-byte AAD");
    }

    #[test]
    fn aad_vault_indices_blob_changes_with_account_number_hash() {
        // Cross-vault binding: different account_number_hash ⇒ different AAD ⇒
        // a vault.indices from vault A fails AEAD in vault B.
        let hash_a = [0x00; 16];
        let mut hash_b = [0x00; 16];
        hash_b[0] = 1;
        let aad_a = aad_vault_indices_blob(&hash_a);
        let aad_b = aad_vault_indices_blob(&hash_b);
        assert_ne!(aad_a, aad_b);
        // First 31 bytes (prefix + version + length-prefixed 18-byte role)
        // match — only the account_number_hash region (bytes 31..47) differs.
        assert_eq!(&aad_a[..31], &aad_b[..31]);
    }

    #[test]
    fn aad_vault_indices_blob_distinct_from_search_index_blob() {
        // LOAD-BEARING: vault.indices (structured metadata) and vault.search
        // (BM25 full-text) are separate blob families. The AAD role strings
        // "vault-indices-blob" vs "search-index-blob" must differ so neither
        // blob can ever AEAD-verify under the other's AAD — the one-AAD-per-
        // family guarantee that mirrors one-magic-per-family (§10.3).
        let id: [u8; 16] = [0x00; 16];
        let indices_aad = aad_vault_indices_blob(&id);
        let search_aad = aad_search_index_blob(&id);
        assert_ne!(indices_aad, search_aad);
        // Also distinct from prefs and workspace.
        assert_ne!(indices_aad, aad_prefs_blob(&id));
        assert_ne!(indices_aad, aad_workspace_blob(&id));
    }

    #[test]
    fn aad_custom_themes_blob_default_matches_pinned_hex() {
        // Spec § 5.2 + § 9.21.3: 47 bytes = prefix (10) + version (1) +
        // u16_be(18) + "custom-themes-blob" (18) + account_number_hash (16).
        let account_number_hash: [u8; 16] = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        let aad = aad_custom_themes_blob(&account_number_hash);
        let expected: [u8; 47] = [
            // "myne.v0.1|": 10 bytes
            0x6D, 0x79, 0x6E, 0x65, 0x2E, 0x76, 0x30, 0x2E, 0x31, 0x7C,
            // protocol_version
            0x01, // length-prefixed role string: u16_be(18) || "custom-themes-blob"
            0x00, 0x12, // u16_be(18)
            0x63, 0x75, 0x73, 0x74, 0x6F, 0x6D, 0x2D, // "custom-"
            0x74, 0x68, 0x65, 0x6D, 0x65, 0x73, 0x2D, // "themes-"
            0x62, 0x6C, 0x6F, 0x62, // "blob"
            // account_number_hash
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        assert_eq!(aad.as_slice(), &expected[..]);
        assert_eq!(aad.len(), 47, "spec § 9.21.3 mandates 47-byte AAD");
        // Domain-separation: distinct from the structurally-identical dictionary
        // AAD (different role string) and from prefs — no cross-family verify.
        assert_ne!(aad, aad_personal_dictionary_blob(&account_number_hash));
        assert_ne!(aad, aad_prefs_blob(&account_number_hash));
        // Only the first 11 bytes (domain prefix + version) are shared with the
        // other vault-singleton AADs. Everything from the role's length prefix
        // onward is family-specific — the role string IS the domain separator,
        // so it must NOT match a sibling's (the two assert_ne! above).
        assert_eq!(&aad[..11], &aad_prefs_blob(&account_number_hash)[..11]);
    }

    #[test]
    fn aad_chats_catalog_default_matches_pinned_hex() {
        // Spec § 5.2 + § 9.23.2: 42 bytes = prefix (10) + version (1) +
        // u16_be(13) + "chats-catalog" (13) + account_number_hash (16).
        let account_number_hash: [u8; 16] = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        let aad = aad_chats_catalog(&account_number_hash);
        let expected: [u8; 42] = [
            // "myne.v0.1|": 10 bytes
            0x6D, 0x79, 0x6E, 0x65, 0x2E, 0x76, 0x30, 0x2E, 0x31, 0x7C,
            // protocol_version (the caller's vault generation; 0x01 here)
            0x01, // length-prefixed role string: u16_be(13) || "chats-catalog"
            0x00, 0x0D, // u16_be(13)
            0x63, 0x68, 0x61, 0x74, 0x73, 0x2D, // "chats-"
            0x63, 0x61, 0x74, 0x61, 0x6C, 0x6F, 0x67, // "catalog"
            // account_number_hash
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        assert_eq!(aad.as_slice(), &expected[..]);
        assert_eq!(aad.len(), 42, "spec § 9.23.2 mandates 42-byte AAD");
        // The v0.2 form comes from the generic singleton helper with the
        // same role string (no per-family v0.2 builder, the themes-family
        // convention): prefix AND version byte both follow the generation,
        // so no hybrid AAD is expressible.
        let aad_v2 = aad_singleton_blob_v0_2(b"chats-catalog", &account_number_hash);
        assert_ne!(aad, aad_v2);
        assert_eq!(aad_v2[10], 0x02);
        assert_eq!(&aad_v2[..10], b"myne.v0.2|");
        assert_eq!(&aad[..10], b"myne.v0.1|");
        // Domain-separation from the singleton siblings.
        assert_ne!(aad, aad_prefs_blob(&account_number_hash));
        assert_ne!(aad, aad_custom_themes_blob(&account_number_hash));
    }

    #[test]
    fn aad_chats_blob_default_matches_pinned_hex() {
        // Spec § 5.2 + § 9.24.3: 55 bytes = prefix (10) + version (1) +
        // u16_be(10) + "chats-blob" (10) + conversation_id (16) +
        // account_number_hash (16).
        let account_number_hash: [u8; 16] = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        let conversation_id: [u8; 16] = [
            0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
            0x18, 0x19,
        ];
        let aad = aad_chats_blob(&account_number_hash, &conversation_id);
        let expected: [u8; 55] = [
            // "myne.v0.1|": 10 bytes
            0x6D, 0x79, 0x6E, 0x65, 0x2E, 0x76, 0x30, 0x2E, 0x31, 0x7C,
            // protocol_version (the caller's vault generation; 0x01 here)
            0x01, // length-prefixed role string: u16_be(10) || "chats-blob"
            0x00, 0x0A, // u16_be(10)
            0x63, 0x68, 0x61, 0x74, 0x73, 0x2D, 0x62, 0x6C, 0x6F, 0x62, // "chats-blob"
            // conversation_id
            0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
            0x18, 0x19, // account_number_hash
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        assert_eq!(aad.as_slice(), &expected[..]);
        assert_eq!(aad.len(), 55, "spec § 9.24.3 mandates 55-byte AAD");
        // Per-entry binding: a different conversation_id produces a different
        // AAD in exactly the id region: the per-blob-safety property that
        // lets one KEK serve every conversation file.
        let other_id = [0x99u8; 16];
        let aad_other = aad_chats_blob(&account_number_hash, &other_id);
        assert_ne!(aad, aad_other);
        assert_eq!(&aad[..23], &aad_other[..23]);
        // The generation stamp (prefix + version byte) separates the
        // generations (§ 10.3, one magic per generation).
        let aad_v2 = aad_chats_blob_v0_2(&account_number_hash, &conversation_id);
        assert_ne!(aad, aad_v2);
        assert_eq!(&aad_v2[..10], b"myne.v0.2|");
        assert_eq!(&aad[..10], b"myne.v0.1|");
        // Domain-separation from the catalog sibling: same family, different
        // role + the per-entry id, so no cross-verify even at equal hashes.
        assert_ne!(aad, aad_chats_catalog(&account_number_hash));
    }

    #[test]
    fn aad_capture_blob_default_matches_pinned_hex() {
        // § 5.2 + § 9.18.3: 49 bytes = prefix (10) + version (1) +
        // u16_be(20) + "pending-capture-blob" (20) + capture_id (16).
        let capture_id: [u8; 16] = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        let aad = aad_capture_blob(&capture_id);
        let expected: [u8; 49] = [
            // "myne.v0.1|": 10 bytes
            0x6D, 0x79, 0x6E, 0x65, 0x2E, 0x76, 0x30, 0x2E, 0x31, 0x7C,
            // protocol_version
            0x01, // length-prefixed role: u16_be(20) || "pending-capture-blob"
            0x00, 0x14, // u16_be(20)
            0x70, 0x65, 0x6E, 0x64, 0x69, 0x6E, 0x67, 0x2D, // "pending-"
            0x63, 0x61, 0x70, 0x74, 0x75, 0x72, 0x65, 0x2D, // "capture-"
            0x62, 0x6C, 0x6F, 0x62, // "blob"
            // capture_id
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        assert_eq!(aad.as_slice(), &expected[..]);
        assert_eq!(aad.len(), 49, "spec § 9.18.3 mandates 49-byte AAD");
        // Vault-agnostic: distinct from a vault-scoped blob AAD (different role
        // + binds capture_id, not account_number_hash).
        assert_ne!(aad, aad_prefs_blob(&capture_id));
    }

    #[test]
    fn aad_share_import_blob_default_matches_pinned_hex() {
        // § 5.2 + § 9.20.3: 46 bytes = prefix (10) + version (1) +
        // u16_be(17) + "share-import-blob" (17) + share_id (16).
        let share_id: [u8; 16] = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        let aad = aad_share_import_blob(&share_id);
        let expected: [u8; 46] = [
            // "myne.v0.1|": 10 bytes
            0x6D, 0x79, 0x6E, 0x65, 0x2E, 0x76, 0x30, 0x2E, 0x31, 0x7C,
            // protocol_version
            0x01, // length-prefixed role: u16_be(17) || "share-import-blob"
            0x00, 0x11, // u16_be(17)
            0x73, 0x68, 0x61, 0x72, 0x65, 0x2D, // "share-"
            0x69, 0x6D, 0x70, 0x6F, 0x72, 0x74, 0x2D, // "import-"
            0x62, 0x6C, 0x6F, 0x62, // "blob"
            // share_id
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        assert_eq!(aad.as_slice(), &expected[..]);
        assert_eq!(aad.len(), 46, "spec § 9.20.3 mandates 46-byte AAD");
        // Vault-agnostic + distinct from the capture role (one-role-per-family).
        assert_ne!(aad, aad_prefs_blob(&share_id));
        assert_ne!(aad, aad_capture_blob(&share_id));
    }

    #[test]
    fn aad_vault_label_blob_default_matches_pinned_hex() {
        // § 5.2 + § 9.22.3: 45 bytes = prefix (10) + version (1) +
        // u16_be(16) + "vault-label-blob" (16) + vault_id (16).
        let vault_id: [u8; 16] = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        let aad = aad_vault_label_blob(&vault_id);
        let expected: [u8; 45] = [
            // "myne.v0.1|", 10 bytes
            0x6D, 0x79, 0x6E, 0x65, 0x2E, 0x76, 0x30, 0x2E, 0x31, 0x7C,
            // protocol_version
            0x01, // length-prefixed role: u16_be(16) || "vault-label-blob"
            0x00, 0x10, // u16_be(16)
            0x76, 0x61, 0x75, 0x6C, 0x74, 0x2D, // "vault-"
            0x6C, 0x61, 0x62, 0x65, 0x6C, 0x2D, // "label-"
            0x62, 0x6C, 0x6F, 0x62, // "blob"
            // vault_id
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        assert_eq!(aad.as_slice(), &expected[..]);
        assert_eq!(aad.len(), 45, "spec § 9.22.3 mandates 45-byte AAD");
        // Device-local, but vault-BOUND: distinct from the two vault-agnostic
        // queue roles AND from every vault-scoped singleton role, so no blob of
        // one family can ever AEAD-verify as another's.
        assert_ne!(aad, aad_prefs_blob(&vault_id));
        assert_ne!(aad, aad_capture_blob(&vault_id));
        assert_ne!(aad, aad_share_import_blob(&vault_id));
    }

    #[test]
    fn aad_vault_label_blob_separates_two_vaults() {
        // The whole point of the binding: one vault's AAD is never another's, so
        // a sealed name cannot be re-homed by moving its file.
        let a = [0x0Au8; 16];
        let b = [0x0Bu8; 16];
        assert_ne!(aad_vault_label_blob(&a), aad_vault_label_blob(&b));
        // And only the trailing 16 bytes differ; the framing is shared.
        assert_eq!(
            aad_vault_label_blob(&a)[..29],
            aad_vault_label_blob(&b)[..29]
        );
    }

    #[test]
    fn aad_vault_items_key_wrap_default_matches_pinned_hex() {
        // Hand-derived: prefix (10) + version (1) + items_key_id (16) = 27 bytes.
        let items_key_id: [u8; 16] = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        let aad = aad_vault_items_key_wrap(&items_key_id);
        let expected: [u8; 27] = [
            // "myne.v0.1|"
            0x6D, 0x79, 0x6E, 0x65, 0x2E, 0x76, 0x30, 0x2E, 0x31, 0x7C, // protocol_version
            0x01, // items_key_id
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF,
        ];
        assert_eq!(aad.as_slice(), &expected[..]);
    }

    #[test]
    fn aad_vault_items_key_wrap_changes_with_id() {
        // Different items_key_id ⇒ different AAD (the only variable
        // in the v0.1 layout).
        let id1 = [0x00; 16];
        let id2 = [0xFF; 16];
        assert_ne!(
            aad_vault_items_key_wrap(&id1),
            aad_vault_items_key_wrap(&id2)
        );
    }

    /// Shared per-note AAD test fixtures. `items_key_id` matches the
    /// pattern used by `aad_vault_items_key_wrap_default_matches_pinned_hex`;
    /// `note_uuid` is the byte-reverse of that pattern so a copy-paste
    /// confusion between the two parameters is visible at a glance in
    /// the golden bytes.
    const NOTE_AAD_FIXTURE_ITEMS_KEY_ID: [u8; 16] = [
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE,
        0xFF,
    ];
    const NOTE_AAD_FIXTURE_NOTE_UUID: [u8; 16] = [
        0xFF, 0xEE, 0xDD, 0xCC, 0xBB, 0xAA, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11,
        0x00,
    ];

    #[test]
    fn aad_note_item_key_wrap_default_matches_pinned_hex() {
        // Hand-derived per spec § 5.2:
        // prefix (10) + version (1) + items_key_id (16) + note_uuid (16) = 43 bytes.
        let aad =
            aad_note_item_key_wrap(&NOTE_AAD_FIXTURE_ITEMS_KEY_ID, &NOTE_AAD_FIXTURE_NOTE_UUID);
        let expected: [u8; 43] = [
            // "myne.v0.1|"
            0x6D, 0x79, 0x6E, 0x65, 0x2E, 0x76, 0x30, 0x2E, 0x31, 0x7C, // protocol_version
            0x01, // items_key_id
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF, // note_uuid
            0xFF, 0xEE, 0xDD, 0xCC, 0xBB, 0xAA, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22,
            0x11, 0x00,
        ];
        assert_eq!(aad.as_slice(), &expected[..]);
    }

    #[test]
    fn aad_note_item_key_wrap_changes_with_note_uuid() {
        // §6.5 cross-note rename protection: changing note_uuid alone
        // must change the AAD (else a renamed .myn would decrypt under
        // the old AAD).
        let uuid_a = [0x00; 16];
        let uuid_b = [0xFF; 16];
        assert_ne!(
            aad_note_item_key_wrap(&NOTE_AAD_FIXTURE_ITEMS_KEY_ID, &uuid_a),
            aad_note_item_key_wrap(&NOTE_AAD_FIXTURE_ITEMS_KEY_ID, &uuid_b),
        );
    }

    #[test]
    fn aad_note_item_key_wrap_extends_vault_items_key_wrap_with_note_uuid() {
        // Structural property: the per-note AAD is the singleton AAD
        // followed by note_uuid. A drift here would break parity with
        // §5.2's prose definition.
        let vault_aad = aad_vault_items_key_wrap(&NOTE_AAD_FIXTURE_ITEMS_KEY_ID);
        let note_aad =
            aad_note_item_key_wrap(&NOTE_AAD_FIXTURE_ITEMS_KEY_ID, &NOTE_AAD_FIXTURE_NOTE_UUID);
        assert_eq!(&note_aad[..vault_aad.len()], vault_aad.as_slice());
        assert_eq!(
            &note_aad[vault_aad.len()..],
            &NOTE_AAD_FIXTURE_NOTE_UUID[..]
        );
    }

    #[test]
    fn aad_note_content_encrypt_default_matches_pinned_hex() {
        // Hand-derived per spec § 5.2:
        // prefix (10) + version (1) + items_key_id (16) + note_uuid (16)
        // + u16-BE-len (2) + "text/markdown" (13) = 58 bytes.
        let aad =
            aad_note_content_encrypt(&NOTE_AAD_FIXTURE_ITEMS_KEY_ID, &NOTE_AAD_FIXTURE_NOTE_UUID);
        let expected: [u8; 58] = [
            // "myne.v0.1|"
            0x6D, 0x79, 0x6E, 0x65, 0x2E, 0x76, 0x30, 0x2E, 0x31, 0x7C, // protocol_version
            0x01, // items_key_id
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD,
            0xEE, 0xFF, // note_uuid
            0xFF, 0xEE, 0xDD, 0xCC, 0xBB, 0xAA, 0x99, 0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22,
            0x11, 0x00, // u16-BE length = 13
            0x00, 0x0D, // "text/markdown"
            0x74, 0x65, 0x78, 0x74, 0x2F, 0x6D, 0x61, 0x72, 0x6B, 0x64, 0x6F, 0x77, 0x6E,
        ];
        assert_eq!(aad.as_slice(), &expected[..]);
    }

    #[test]
    fn aad_note_content_encrypt_extends_note_item_key_wrap_with_length_prefixed_content_type() {
        // Structural property: the content-encrypt AAD is the per-note
        // wrap AAD followed by length-prefixed "text/markdown". v0.1
        // hardcodes the content_type literal; a buggy decoder using a
        // different literal would diverge here, not in some downstream
        // parser.
        let wrap_aad =
            aad_note_item_key_wrap(&NOTE_AAD_FIXTURE_ITEMS_KEY_ID, &NOTE_AAD_FIXTURE_NOTE_UUID);
        let content_aad =
            aad_note_content_encrypt(&NOTE_AAD_FIXTURE_ITEMS_KEY_ID, &NOTE_AAD_FIXTURE_NOTE_UUID);
        assert_eq!(&content_aad[..wrap_aad.len()], wrap_aad.as_slice());
        // After the wrap-AAD prefix: u16-BE 13 || "text/markdown"
        assert_eq!(
            &content_aad[wrap_aad.len()..wrap_aad.len() + 2],
            &[0x00, 0x0D]
        );
        assert_eq!(&content_aad[wrap_aad.len() + 2..], b"text/markdown");
    }

    #[test]
    fn aad_layout_protocol_version_byte_is_one() {
        // Byte 10 (after the 10-byte prefix) is the protocol_version
        // byte. v0.1 mandates `0x01` (spec § 9.3).
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        assert_eq!(aad[10], 0x01);
    }

    // ---- CTX seal/open tests ----

    /// Fixed test vector for deterministic seal/open round-trips.
    const TEST_KEY: [u8; AEAD_KEY_LEN] = [
        0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
        0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
        0x88, 0x99,
    ];
    const TEST_NONCE: [u8; AEAD_NONCE_LEN] = [
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F,
        0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
    ];

    #[test]
    fn seal_then_open_round_trips_root_key_sized_plaintext() {
        // Realistic case: 32-byte plaintext (a wrapped `root_key`).
        let plaintext = [0x42u8; 32];
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        let sealed =
            aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &plaintext, &aad).expect("seal succeeds");
        // Output length: 32 (ciphertext) + 32 (CTX tag) = 64. Matches
        // spec § 9.3 offset 89's `enc_root_key_password` field width.
        assert_eq!(sealed.len(), 32 + CTX_COMMITMENT_TAG_LEN);

        let opened = aead_open_ctx(&TEST_KEY, &TEST_NONCE, &sealed, &aad).expect("open succeeds");
        assert_eq!(&plaintext[..], &opened[..]);
    }

    #[test]
    fn seal_then_open_round_trips_empty_plaintext() {
        // Edge case: zero-length plaintext. Output is just the 32-byte CTX tag.
        let aad = b"non-empty aad";
        let sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &[], aad).unwrap();
        assert_eq!(sealed.len(), CTX_COMMITMENT_TAG_LEN);

        let opened = aead_open_ctx(&TEST_KEY, &TEST_NONCE, &sealed, aad).unwrap();
        assert!(opened.is_empty());
    }

    #[test]
    fn seal_then_open_round_trips_empty_aad() {
        // Edge case: zero-length AAD.
        let plaintext = [0x77u8; 32];
        let sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &plaintext, &[]).unwrap();
        let opened = aead_open_ctx(&TEST_KEY, &TEST_NONCE, &sealed, &[]).unwrap();
        assert_eq!(&plaintext[..], &opened[..]);
    }

    #[test]
    fn open_rejects_tampered_ciphertext_byte() {
        let plaintext = [0x42u8; 32];
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        let mut sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &plaintext, &aad).unwrap();
        // Flip a bit in the ciphertext region.
        sealed[5] ^= 0x01;
        assert_eq!(
            aead_open_ctx(&TEST_KEY, &TEST_NONCE, &sealed, &aad).err(),
            Some(ProtocolError::AeadFailure),
        );
    }

    #[test]
    fn open_rejects_tampered_ctx_tag_byte() {
        let plaintext = [0x42u8; 32];
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        let mut sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &plaintext, &aad).unwrap();
        // Flip a bit in the CTX tag region (last 32 bytes).
        let tag_start = sealed.len() - CTX_COMMITMENT_TAG_LEN;
        sealed[tag_start + 7] ^= 0x80;
        assert_eq!(
            aead_open_ctx(&TEST_KEY, &TEST_NONCE, &sealed, &aad).err(),
            Some(ProtocolError::AeadFailure),
        );
    }

    #[test]
    fn open_rejects_tampered_aad() {
        let plaintext = [0x42u8; 32];
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        let sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &plaintext, &aad).unwrap();
        let mut tampered_aad = aad.clone();
        tampered_aad[0] ^= 0x01;
        assert_eq!(
            aead_open_ctx(&TEST_KEY, &TEST_NONCE, &sealed, &tampered_aad).err(),
            Some(ProtocolError::AeadFailure),
        );
    }

    #[test]
    fn open_rejects_wrong_key() {
        let plaintext = [0x42u8; 32];
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        let sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &plaintext, &aad).unwrap();
        let mut wrong_key = TEST_KEY;
        wrong_key[0] ^= 0x01;
        assert_eq!(
            aead_open_ctx(&wrong_key, &TEST_NONCE, &sealed, &aad).err(),
            Some(ProtocolError::AeadFailure),
        );
    }

    #[test]
    fn open_rejects_wrong_nonce() {
        let plaintext = [0x42u8; 32];
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);
        let sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &plaintext, &aad).unwrap();
        let mut wrong_nonce = TEST_NONCE;
        wrong_nonce[0] ^= 0x01;
        assert_eq!(
            aead_open_ctx(&TEST_KEY, &wrong_nonce, &sealed, &aad).err(),
            Some(ProtocolError::AeadFailure),
        );
    }

    #[test]
    fn open_rejects_short_input_below_tag_length() {
        let aad = b"any";
        let too_short = [0u8; CTX_COMMITMENT_TAG_LEN - 1];
        assert_eq!(
            aead_open_ctx(&TEST_KEY, &TEST_NONCE, &too_short, aad).err(),
            Some(ProtocolError::AeadFailure),
        );
    }

    #[test]
    fn ciphertext_matches_rustcrypto_xchacha20poly1305() {
        // Cross-check the hand-rolled stream-cipher path against
        // RustCrypto's high-level AEAD. The ciphertext bytes must be
        // byte-exact equivalent. This validates that:
        // - we derive the Poly1305 one-time key correctly (block 0),
        // - we seek to the right keystream offset for plaintext,
        // - XChaCha20 nonce / key bindings are wired correctly.
        use chacha20poly1305::aead::AeadInPlace;
        use chacha20poly1305::{KeyInit, XChaCha20Poly1305};

        let plaintext = b"Some plaintext to encrypt; must match RustCrypto.";
        let aad = b"some aad bytes";

        let sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, plaintext, aad).unwrap();
        let our_ct = &sealed[..plaintext.len()];

        let cipher = XChaCha20Poly1305::new((&TEST_KEY).into());
        let mut rc_buf = plaintext.to_vec();
        let _rc_tag = cipher
            .encrypt_in_place_detached((&TEST_NONCE).into(), aad, &mut rc_buf)
            .expect("RustCrypto encrypt");

        assert_eq!(our_ct, rc_buf.as_slice());
    }

    #[test]
    fn ctx_commitment_can_be_independently_verified() {
        // Strong cross-check: independently compute T using
        // RustCrypto's high-level AEAD, then independently compute
        // T' = SHA-256(K || N || len(AD)[4 BE] || AD || T) and
        // compare with our seal output.
        use chacha20poly1305::aead::AeadInPlace;
        use chacha20poly1305::{KeyInit, XChaCha20Poly1305};

        let plaintext = [0x42u8; 32];
        let aad = aad_password_wrap(&DEFAULT_V0_1_KDF_PARAMS);

        let sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &plaintext, &aad).unwrap();
        let our_t_prime = &sealed[plaintext.len()..];

        // Independently get T from RustCrypto.
        let cipher = XChaCha20Poly1305::new((&TEST_KEY).into());
        let mut rc_buf = plaintext.to_vec();
        let rc_tag = cipher
            .encrypt_in_place_detached((&TEST_NONCE).into(), &aad, &mut rc_buf)
            .unwrap();

        // Independently compute T'.
        let mut h = Sha256::new();
        h.update(TEST_KEY);
        h.update(TEST_NONCE);
        h.update((aad.len() as u32).to_be_bytes());
        h.update(&aad);
        h.update(rc_tag);
        let independent_t_prime = h.finalize();

        assert_eq!(our_t_prime, independent_t_prime.as_slice());
    }

    #[test]
    fn seal_output_length_equals_plaintext_plus_tag() {
        // Layout invariant: sealed.len() == plaintext.len() + 32.
        for pt_len in [0, 1, 16, 32, 100, 1000] {
            let plaintext = alloc::vec![0x55u8; pt_len];
            let aad = b"x";
            let sealed = aead_seal_ctx(&TEST_KEY, &TEST_NONCE, &plaintext, aad).unwrap();
            assert_eq!(
                sealed.len(),
                pt_len + CTX_COMMITMENT_TAG_LEN,
                "length mismatch for plaintext len {pt_len}"
            );
        }
    }

    // ---- KAT vector regenerator (companion repo) ---------------------

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/ctx-aead/v0.1/cases.json` as a
    /// pretty-printed JSON file at `/tmp/myne_ctx_aead_vectors.json`.
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act.
    /// Run with:
    /// `cargo test -p protocol --lib emit_ctx_aead_vectors_for_paste -- --ignored`
    ///
    /// 14 cases pin (per MYND-68 / D3; +`aad_search_index_blob` MYND-29;
    /// +`aad_workspace_blob` MYND-254; +`aad_vault_indices_blob` MYND-271):
    /// - 9 `aad_canonical_bytes`: one per pub `aad_*` builder
    ///   (`aad_password_wrap`, `aad_recovery_wrap`,
    ///   `aad_vault_items_key_wrap`, `aad_note_item_key_wrap`,
    ///   `aad_note_content_encrypt`, `aad_prefs_blob`,
    ///   `aad_search_index_blob`, `aad_workspace_blob`,
    ///   `aad_vault_indices_blob`). Pins each
    ///   builder's canonical AAD byte assembly independently of any AEAD
    ///   invocation — drift in §5.2 AAD construction surfaces here without
    ///   requiring a downstream AEAD test to fire.
    /// - 2 `encrypt`: short empty-AAD + medium content-AAD plaintext
    ///   cases — exercise `aead_seal_ctx` at the primitive level.
    /// - 1 `decrypt_ok`: round-trip the medium encrypt case.
    /// - 2 `decrypt_aead_fail`: (a) ciphertext-tamper flips one byte
    ///   in the sealed region, (b) AAD-tamper passes a different AAD
    ///   to the verifier. Both collapse to `ProtocolError::AeadFailure`
    ///   per spec §6.4 non-distinguishing rule.
    #[test]
    #[ignore]
    fn emit_ctx_aead_vectors_for_paste() {
        extern crate std;

        // FAST_TEST KDF params — match the cross-category fixtures so
        // a reviewer cross-checks aad_password_wrap output against
        // the embedded KDF block in vault-meta vectors.
        let fast_test_kdf = KdfParams {
            m_kib: 8,
            t: 1,
            p: 1,
            argon2_version: 0x13,
        };

        // Deterministic fixture inputs across builder calls.
        let items_key_id: [u8; 16] = [0xAB; 16];
        let note_uuid: [u8; 16] = [0xCD; 16];
        let account_number_hash: [u8; 16] = [0x12; 16];

        // AEAD primitive inputs.
        let key: [u8; AEAD_KEY_LEN] = [0x5A; AEAD_KEY_LEN];
        let nonce_a: [u8; AEAD_NONCE_LEN] = [0x6B; AEAD_NONCE_LEN];
        let nonce_b: [u8; AEAD_NONCE_LEN] = [0x7C; AEAD_NONCE_LEN];

        // Short plaintext, no AAD (primitive-level coverage).
        let pt_short: alloc::vec::Vec<u8> = b"abc".to_vec();
        let aad_empty: alloc::vec::Vec<u8> = alloc::vec::Vec::new();
        let sealed_short =
            aead_seal_ctx(&key, &nonce_a, &pt_short, &aad_empty).expect("aead_seal_ctx short");

        // Medium plaintext, AAD from aad_note_content_encrypt
        // (a non-trivial 58-byte AAD).
        let pt_medium: alloc::vec::Vec<u8> = (0..256u32).map(|i| (i % 256) as u8).collect();
        let aad_content = aad_note_content_encrypt(&items_key_id, &note_uuid);
        let sealed_medium =
            aead_seal_ctx(&key, &nonce_b, &pt_medium, &aad_content).expect("aead_seal_ctx medium");

        // Round-trip sanity in the generator.
        let recovered = aead_open_ctx(&key, &nonce_b, &sealed_medium, &aad_content)
            .expect("aead_open round-trip");
        assert_eq!(recovered.as_slice(), pt_medium.as_slice());

        // Tamper variant 1: flip last byte of CTX tag region of sealed_medium.
        let mut sealed_tag_tamper = sealed_medium.clone();
        let last_idx = sealed_tag_tamper.len() - 1;
        sealed_tag_tamper[last_idx] ^= 0xFF;
        assert!(
            aead_open_ctx(&key, &nonce_b, &sealed_tag_tamper, &aad_content).is_err(),
            "tag-tamper must reject"
        );

        // Tamper variant 2: same sealed_medium but caller passes different AAD.
        let aad_wrong = aad_prefs_blob(&account_number_hash); // intentionally different
        assert!(
            aead_open_ctx(&key, &nonce_b, &sealed_medium, &aad_wrong).is_err(),
            "AAD-tamper must reject"
        );

        // Compute canonical AAD bytes for all 8 pub builders.
        let aad_pw = aad_password_wrap(&fast_test_kdf);
        let aad_rec = aad_recovery_wrap(&fast_test_kdf);
        let aad_vik = aad_vault_items_key_wrap(&items_key_id);
        let aad_nik = aad_note_item_key_wrap(&items_key_id, &note_uuid);
        // aad_content already computed
        let aad_pb = aad_prefs_blob(&account_number_hash);
        let aad_sib = aad_search_index_blob(&account_number_hash);
        let aad_wsb = aad_workspace_blob(&account_number_hash);
        let aad_glb = aad_graph_layout_blob(&account_number_hash);
        let aad_vib = aad_vault_indices_blob(&account_number_hash);
        let aad_pdb = aad_personal_dictionary_blob(&account_number_hash);
        let aad_aeb = aad_ai_embeddings_blob(&account_number_hash);
        // provider_kind = 0x02 (PIN) exercises the non-trivial trailing byte.
        let aad_qub = aad_quick_unlock_blob(&account_number_hash, 0x02);

        let key_hex = hex_lower(&key);
        let nonce_a_hex = hex_lower(&nonce_a);
        let nonce_b_hex = hex_lower(&nonce_b);

        // ---- Emit JSON ----------------------------------------------

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"ctx-aead\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §5.1 + §5.2 + §6.4\",\n");
        dump.push_str("  \"description\": \"Pins protocol::aead_seal_ctx + protocol::aead_open_ctx byte mapping (XChaCha20-Poly1305 + CTX commitment outer per Chan & Rogaway 2022) AND each of the 13 pub aad_* builder functions' canonical byte assembly. 18 cases: 13 aad_canonical_bytes (one per builder) + 2 encrypt (short empty-AAD + medium content-AAD plaintext) + 1 decrypt_ok (round-trip) + 2 decrypt_aead_fail (tag-tamper + AAD-tamper). Cases generated by `cargo test -p protocol --lib emit_ctx_aead_vectors_for_paste -- --ignored` (in protocol/src/aead.rs).\",\n");
        dump.push_str("  \"cases\": [\n");

        // Helper: emit aad_canonical_bytes case.
        let emit_aad = |dump: &mut alloc::string::String,
                        slug: &str,
                        description: &str,
                        builder_name: &str,
                        params_lines: &str,
                        aad_bytes: &[u8],
                        trailing_comma: bool| {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"ctx-aead/v0.1/{}\",\n",
                slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str("      \"case_kind\": \"aad_canonical_bytes\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_builder_name\": \"{}\",\n",
                builder_name
            ));
            dump.push_str(params_lines);
            dump.push_str(&alloc::format!(
                "      \"expected_aad_bytes_hex\": \"{}\"\n",
                hex_lower(aad_bytes)
            ));
            if trailing_comma {
                dump.push_str("    },\n");
            } else {
                dump.push_str("    }\n");
            }
        };

        // KDF params block lines for the AAD-canonical-bytes cases.
        let kdf_params_lines = alloc::format!(
            "      \"input_kdf_params\": {{\n        \"m_kib\": {},\n        \"t\": {},\n        \"p\": {},\n        \"argon2_version_hex\": \"{:02x}\"\n      }},\n",
            fast_test_kdf.m_kib,
            fast_test_kdf.t,
            fast_test_kdf.p,
            fast_test_kdf.argon2_version
        );
        let items_key_id_lines = alloc::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&items_key_id)
        );
        let note_uuid_lines = alloc::format!(
            "      \"input_note_uuid_hex\": \"{}\",\n",
            hex_lower(&note_uuid)
        );
        let account_hash_lines = alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_number_hash)
        );

        // 1: aad_password_wrap
        emit_aad(
            &mut dump,
            "aad-password-wrap",
            "Canonical bytes from aad_password_wrap with FAST_TEST KdfParams (m_kib=8, t=1, p=1, v=0x13). Pins the §5.2 password-wrap AAD assembly: 'myne.v0.1|' prefix + version byte + role 'pw' + serialized 11-byte KDF params block.",
            "aad_password_wrap",
            &kdf_params_lines,
            &aad_pw,
            true,
        );

        // 2: aad_recovery_wrap
        emit_aad(
            &mut dump,
            "aad-recovery-wrap",
            "Canonical bytes from aad_recovery_wrap. Same FAST_TEST KdfParams; differs from aad_password_wrap only in the role byte ('rk' instead of 'pw' — drift detection across the password/recovery split).",
            "aad_recovery_wrap",
            &kdf_params_lines,
            &aad_rec,
            true,
        );

        // 3: aad_vault_items_key_wrap
        emit_aad(
            &mut dump,
            "aad-vault-items-key-wrap",
            "Canonical bytes from aad_vault_items_key_wrap with items_key_id = 0xAB×16. Pins the singleton-itemsKey wrap AAD ('itemsKey' role with NO per-note UUID — distinguishes this builder from aad_note_item_key_wrap whose name differs by one trailing 's').",
            "aad_vault_items_key_wrap",
            &items_key_id_lines,
            &aad_vik,
            true,
        );

        // 4: aad_note_item_key_wrap
        emit_aad(
            &mut dump,
            "aad-note-item-key-wrap",
            "Canonical bytes from aad_note_item_key_wrap with items_key_id = 0xAB×16 + note_uuid = 0xCD×16. Pins the per-note item_key wrap AAD ('item-key' role WITH note_uuid). Visually adjacent to aad_vault_items_key_wrap; one-character difference in name pins a real type-confusion-class hazard (§5.2 spec note).",
            "aad_note_item_key_wrap",
            &alloc::format!("{}{}", items_key_id_lines, note_uuid_lines),
            &aad_nik,
            true,
        );

        // 5: aad_note_content_encrypt
        emit_aad(
            &mut dump,
            "aad-note-content-encrypt",
            "Canonical bytes from aad_note_content_encrypt. Same items_key_id + note_uuid pair; differs from aad_note_item_key_wrap in the role byte AND adds the hardcoded content_type 'text/markdown' (13 ASCII bytes with 2-byte BE length prefix). 58-byte total AAD per spec §5.2.",
            "aad_note_content_encrypt",
            &alloc::format!("{}{}", items_key_id_lines, note_uuid_lines),
            &aad_content,
            true,
        );

        // 6: aad_prefs_blob
        emit_aad(
            &mut dump,
            "aad-prefs-blob",
            "Canonical bytes from aad_prefs_blob with account_number_hash = 0x12×16. Pins the §9.5.3 39-byte vault.prefs AAD: 'myne.v0.1|' prefix (10) + version byte (1) + length-prefixed UTF-8 role 'prefs-blob' (2+10) + account_number_hash (16).",
            "aad_prefs_blob",
            &account_hash_lines,
            &aad_pb,
            true,
        );

        // 7: aad_search_index_blob
        emit_aad(
            &mut dump,
            "aad-search-index-blob",
            "Canonical bytes from aad_search_index_blob with account_number_hash = 0x12×16 (MYND-29, §9.6). Pins the 46-byte vault.search AAD: 'myne.v0.1|' prefix (10) + version byte (1) + length-prefixed UTF-8 role 'search-index-blob' (2+17) + account_number_hash (16). Same shape as aad_prefs_blob but a distinct 17-byte role string — domain-separates the search index from the prefs blob. NOTE: the AAD role 'search-index-blob' is DISTINCT from the HKDF KEK role 'search-index-key' (hkdf-sha256 vectors); they are different load-bearing constants.",
            "aad_search_index_blob",
            &account_hash_lines,
            &aad_sib,
            true,
        );

        // 8: aad_workspace_blob
        emit_aad(
            &mut dump,
            "aad-workspace-blob",
            "Canonical bytes from aad_workspace_blob with account_number_hash = 0x12×16 (MYND-254, §9.7). Pins the 43-byte vault.workspace AAD: 'myne.v0.1|' prefix (10) + version byte (1) + length-prefixed UTF-8 role 'workspace-blob' (2+14) + account_number_hash (16). Same shape as aad_prefs_blob / aad_search_index_blob but a distinct 14-byte role string — domain-separates the workspace blob from the other vault singletons. NOTE: the AAD role 'workspace-blob' is DISTINCT from the HKDF KEK role 'session-state-key' (hkdf-sha256 vectors); they are different load-bearing constants.",
            "aad_workspace_blob",
            &account_hash_lines,
            &aad_wsb,
            true,
        );

        // 8b: aad_graph_layout_blob
        emit_aad(
            &mut dump,
            "aad-graph-layout-blob",
            "Canonical bytes from aad_graph_layout_blob with account_number_hash = 0x12×16 (§9.19). Pins the 46-byte vault.graph AAD: 'myne.v0.1|' prefix (10) + version byte (1) + length-prefixed UTF-8 role 'graph-layout-blob' (2+17) + account_number_hash (16). Same shape as aad_workspace_blob but a distinct 17-byte role string — domain-separates the knowledge-graph layout cache from the other vault singletons. NOTE: the AAD role 'graph-layout-blob' is DISTINCT from the HKDF KEK role 'graph-layout-key' (hkdf-sha256 vectors); they are different load-bearing constants.",
            "aad_graph_layout_blob",
            &account_hash_lines,
            &aad_glb,
            true,
        );

        // 9: aad_vault_indices_blob
        emit_aad(
            &mut dump,
            "aad-vault-indices-blob",
            "Canonical bytes from aad_vault_indices_blob with account_number_hash = 0x12×16 (MYND-271, §9.8). Pins the 47-byte vault.indices AAD: 'myne.v0.1|' prefix (10) + version byte (1) + length-prefixed UTF-8 role 'vault-indices-blob' (2+18) + account_number_hash (16). Same shape as aad_prefs_blob / aad_search_index_blob / aad_workspace_blob but a distinct 18-byte role string — domain-separates the structured-metadata index from the other vault singletons. LOAD-BEARING: the AAD role 'vault-indices-blob' is DISTINCT from 'search-index-blob' (vault.indices vs vault.search are separate blob families) AND from the HKDF KEK role 'vault-indices-key' (hkdf-sha256 vectors); all are different load-bearing constants.",
            "aad_vault_indices_blob",
            &account_hash_lines,
            &aad_vib,
            true,
        );

        // 10: aad_personal_dictionary_blob
        emit_aad(
            &mut dump,
            "aad-personal-dictionary-blob",
            "Canonical bytes from aad_personal_dictionary_blob with account_number_hash = 0x12×16 (MYND-266, §9.13). Pins the 53-byte vault.dictionary AAD: 'myne.v0.1|' prefix (10) + version byte (1) + length-prefixed UTF-8 role 'personal-dictionary-blob' (2+24) + account_number_hash (16). Same shape as aad_prefs_blob with a distinct 24-byte role string — domain-separates the personal dictionary from the other vault singletons. NOTE: the AAD role 'personal-dictionary-blob' is DISTINCT from the HKDF KEK role 'personal-dictionary-key' (hkdf-sha256 vectors); they are different load-bearing constants.",
            "aad_personal_dictionary_blob",
            &account_hash_lines,
            &aad_pdb,
            true,
        );

        // 11: aad_quick_unlock_blob
        emit_aad(
            &mut dump,
            "aad-quick-unlock-blob",
            "Canonical bytes from aad_quick_unlock_blob with account_number_hash = 0x12×16 and provider_kind = 0x02 (PIN) (MYND-329, §9.14.3). Pins the 47-byte vault.quickunlock AAD: 'myne.v0.1|' prefix (10) + version byte (1) + length-prefixed UTF-8 role 'quick-unlock-blob' (2+17) + account_number_hash (16) + provider_kind (1). UNIQUE among the builders: it appends a trailing provider_kind byte so a biometric-minted credential cannot AEAD-verify as a PIN one. The quick-unlock blob has NO HKDF KEK role (its wrap key is provider-supplied, not root_key-derived — that would be circular, §3.4).",
            "aad_quick_unlock_blob",
            &alloc::format!(
                "{}      \"input_provider_kind\": 2,\n",
                account_hash_lines
            ),
            &aad_qub,
            true,
        );

        // 12: aad_ai_embeddings_blob
        emit_aad(
            &mut dump,
            "aad-ai-embeddings-blob",
            "Canonical bytes from aad_ai_embeddings_blob with account_number_hash = 0x12×16 (MYND-453, §9.17.3). Pins the 47-byte vault.embeddings AAD: 'myne.v0.1|' prefix (10) + version byte (1) + length-prefixed UTF-8 role 'ai-embeddings-blob' (2+18) + account_number_hash (16). Same shape as aad_prefs_blob / aad_search_index_blob / aad_vault_indices_blob but a distinct 18-byte role string — domain-separates the AI embedding index from the other vault singletons. LOAD-BEARING: the AAD role 'ai-embeddings-blob' is DISTINCT from 'search-index-blob' AND 'vault-indices-blob' (vault.embeddings / vault.search / vault.indices are separate blob families, MYR1 != MYS1 != MYI1) AND from the HKDF KEK role 'ai-embeddings-key' (hkdf-sha256 vectors); all are different load-bearing constants. The model-identity tuple that invalidates the cache on a model/dimension/chunker change is carried INSIDE the opaque payload, NOT this AAD.",
            "aad_ai_embeddings_blob",
            &account_hash_lines,
            &aad_aeb,
            true,
        );

        // 13: encrypt-short-empty-aad
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"ctx-aead/v0.1/encrypt-short-empty-aad\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Encrypt 3-byte plaintext 'abc' with empty AAD. Primitive-level coverage of aead_seal_ctx without binding to any AAD builder — proves the CTX commitment outer construction works at the bare-bytes layer. Expected sealed = 3-byte ciphertext + 32-byte CTX tag = 35 bytes.")
        ));
        dump.push_str("      \"case_kind\": \"encrypt\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_key_hex\": \"{}\",\n",
            key_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_nonce_hex\": \"{}\",\n",
            nonce_a_hex
        ));
        dump.push_str("      \"input_aad_hex\": \"\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_plaintext_hex\": \"{}\",\n",
            hex_lower(&pt_short)
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_sealed_hex\": \"{}\"\n",
            hex_lower(&sealed_short)
        ));
        dump.push_str("    },\n");

        // 10: encrypt-medium-content-aad
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"ctx-aead/v0.1/encrypt-medium-content-aad\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Encrypt 256-byte plaintext (byte i = i mod 256) with AAD = aad_note_content_encrypt(items_key_id=0xAB×16, note_uuid=0xCD×16) (58-byte content-encrypt AAD). Realistic AEAD invocation matching the .myn-blob inner-content layer. Expected sealed = 256-byte ciphertext + 32-byte CTX tag = 288 bytes.")
        ));
        dump.push_str("      \"case_kind\": \"encrypt\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_key_hex\": \"{}\",\n",
            key_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_nonce_hex\": \"{}\",\n",
            nonce_b_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_aad_hex\": \"{}\",\n",
            hex_lower(&aad_content)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_plaintext_hex\": \"{}\",\n",
            hex_lower(&pt_medium)
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_sealed_hex\": \"{}\"\n",
            hex_lower(&sealed_medium)
        ));
        dump.push_str("    },\n");

        // 11: decrypt-ok-medium
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"ctx-aead/v0.1/decrypt-ok-medium\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Round-trip the sealed blob from encrypt-medium-content-aad back to the 256-byte plaintext under the same key + nonce + AAD. Proves aead_open_ctx recovers exactly the plaintext bytes that aead_seal_ctx consumed.")
        ));
        dump.push_str("      \"case_kind\": \"decrypt_ok\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_key_hex\": \"{}\",\n",
            key_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_nonce_hex\": \"{}\",\n",
            nonce_b_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_aad_hex\": \"{}\",\n",
            hex_lower(&aad_content)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_sealed_hex\": \"{}\",\n",
            hex_lower(&sealed_medium)
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_plaintext_hex\": \"{}\"\n",
            hex_lower(&pt_medium)
        ));
        dump.push_str("    },\n");

        // 12: decrypt-tag-tamper
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"ctx-aead/v0.1/decrypt-tag-tamper\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Last byte of the 32-byte CTX commitment tag flipped via XOR 0xFF. aead_open_ctx MUST surface Err(ProtocolError::AeadFailure) — the CTX commitment construction (SHA-256 over key||nonce||AAD-len||AAD||Poly1305-tag) catches the modification at the constant-time comparison step.")
        ));
        dump.push_str("      \"case_kind\": \"decrypt_aead_fail\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_key_hex\": \"{}\",\n",
            key_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_nonce_hex\": \"{}\",\n",
            nonce_b_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_aad_hex\": \"{}\",\n",
            hex_lower(&aad_content)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_sealed_hex\": \"{}\",\n",
            hex_lower(&sealed_tag_tamper)
        ));
        dump.push_str("      \"expected_kind\": \"aead_fail\",\n");
        dump.push_str(&alloc::format!(
            "      \"informational_tamper_description\": \"{}\"\n",
            json_escape("last byte of 32-byte CTX commitment tag region flipped via XOR 0xFF")
        ));
        dump.push_str("    },\n");

        // 13: decrypt-aad-tamper
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"ctx-aead/v0.1/decrypt-aad-tamper\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Sealed blob from encrypt-medium-content-aad with caller passing a DIFFERENT AAD (aad_prefs_blob bytes instead of aad_note_content_encrypt) to the verifier. aead_open_ctx MUST surface Err(ProtocolError::AeadFailure) — the CTX commitment includes the AAD bytes, so swapping AAD invalidates the tag. Same non-distinguishing variant as the tag-tamper case per spec §6.4.")
        ));
        dump.push_str("      \"case_kind\": \"decrypt_aead_fail\",\n");
        dump.push_str(&alloc::format!(
            "      \"input_key_hex\": \"{}\",\n",
            key_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_nonce_hex\": \"{}\",\n",
            nonce_b_hex
        ));
        dump.push_str(&alloc::format!(
            "      \"input_aad_hex\": \"{}\",\n",
            hex_lower(&aad_wrong)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_sealed_hex\": \"{}\",\n",
            hex_lower(&sealed_medium)
        ));
        dump.push_str("      \"expected_kind\": \"aead_fail\",\n");
        dump.push_str(&alloc::format!(
            "      \"informational_tamper_description\": \"{}\"\n",
            json_escape("AAD swap: caller passes aad_prefs_blob bytes instead of the aad_note_content_encrypt bytes the encoder used")
        ));
        dump.push_str("    }\n");

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_ctx_aead_vectors.json", dump.as_bytes())
            .expect("write ctx-aead vectors dump");
    }

    /// Vector generator for the `aad-construction` companion category.
    /// `#[ignore]`-gated — emits ready-to-copy JSON to
    /// `/tmp/myne_aad_construction_vectors.json`. For each of the 9 pub
    /// `aad_*` builders it pins the full AAD bytes (as `ctx-aead` does)
    /// **plus** the per-call-site framing decomposition: a segment list
    /// breaking the AAD into `aad_prefix` / `protocol_version` /
    /// `role_length_be16` / `role_label` / bound-parameter fields with
    /// offsets and lengths. A port that produces the right total bytes
    /// but assembles them from the wrong structural pieces (e.g. forgets
    /// the u16 length-prefix, or orders fields wrong) is caught by the
    /// segment check even when the byte total happens to match.
    #[test]
    #[ignore = "vector generator — run explicitly to refresh aad-construction cases.json"]
    fn emit_aad_construction_vectors_for_paste() {
        extern crate std;
        use alloc::string::String;

        let params = DEFAULT_V0_1_KDF_PARAMS;
        // Distinct byte patterns per field — easy visual cross-check.
        let items_key_id: [u8; 16] = [0xB1; 16];
        let note_uuid: [u8; 16] = [0xC2; 16];
        let account_number_hash: [u8; 16] = [0xA3; 16];

        let aad_pw = aad_password_wrap(&params);
        let aad_rec = aad_recovery_wrap(&params);
        let aad_vik = aad_vault_items_key_wrap(&items_key_id);
        let aad_nik = aad_note_item_key_wrap(&items_key_id, &note_uuid);
        let aad_prefs = aad_prefs_blob(&account_number_hash);
        let aad_search = aad_search_index_blob(&account_number_hash);
        let aad_workspace = aad_workspace_blob(&account_number_hash);
        let aad_graph = aad_graph_layout_blob(&account_number_hash);
        let aad_indices = aad_vault_indices_blob(&account_number_hash);
        let aad_embeddings = aad_ai_embeddings_blob(&account_number_hash);
        let aad_dictionary = aad_personal_dictionary_blob(&account_number_hash);
        let aad_themes = aad_custom_themes_blob(&account_number_hash);
        // provider_kind = 0x02 (PIN) exercises the trailing provider_kind byte.
        let aad_quickunlock = aad_quick_unlock_blob(&account_number_hash, 0x02);
        let aad_content = aad_note_content_encrypt(&items_key_id, &note_uuid);
        // aad_attachment_text_blob binds account_number_hash + attachment_id + extractor_version.
        let attachment_id: [u8; 32] = [0xD4; 32];
        let aad_attachment_text =
            aad_attachment_text_blob(&account_number_hash, &attachment_id, 0x01);

        let kdf_params_json = alloc::format!(
            "      \"input_kdf_params\": {{\n        \"m_kib\": {},\n        \"t\": {},\n        \"p\": {},\n        \"argon2_version_hex\": \"{:02x}\"\n      }},\n",
            params.m_kib, params.t, params.p, params.argon2_version
        );
        let items_key_id_json = alloc::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&items_key_id)
        );
        let note_uuid_json = alloc::format!(
            "      \"input_note_uuid_hex\": \"{}\",\n",
            hex_lower(&note_uuid)
        );
        let account_hash_json = alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_number_hash)
        );
        // aad_quick_unlock_blob additionally binds provider_kind (0x02 = PIN).
        let account_hash_and_provider_json =
            alloc::format!("{}      \"input_provider_kind\": 2,\n", account_hash_json);
        // aad_attachment_text_blob additionally binds attachment_id + extractor_version.
        let attachment_text_inputs_json = alloc::format!(
            "{}      \"input_attachment_id_hex\": \"{}\",\n      \"input_extractor_version\": 1,\n",
            account_hash_json,
            hex_lower(&attachment_id)
        );

        let mut dump = String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"aad-construction\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §5.2\",\n");
        dump.push_str("  \"description\": \"Per-call-site AAD framing decomposition for every pub aad_* builder (protocol/src/aead.rs). Pins the full AAD bytes (as ctx-aead does) PLUS the structural segment breakdown — aad_prefix (myne.v0.1|) / protocol_version / u16-be length prefix / role_label / bound parameters — with byte offsets. Complements ctx-aead's aad_canonical_bytes cases (which pin only the total bytes) by making the assembly structure verifiable. 15 cases, one per VAULT-SCOPED builder. The two device-local, vault-agnostic builders (aad_capture_blob / aad_share_import_blob — they bind a per-entry capture_id / share_id instead of account_number_hash, under a keychain wrap_key rather than a root_key-derived KEK) are deliberately NOT enrolled here; their bytes are pinned by the aad_capture_blob_default_matches_pinned_hex / aad_share_import_blob_default_matches_pinned_hex unit tests plus the pending-capture / share-import encrypt cases. Cases generated by `cargo test -p protocol --lib emit_aad_construction_vectors_for_paste -- --ignored` (in protocol/src/aead.rs).\",\n");
        dump.push_str("  \"cases\": [\n");

        let emit_case = |dump: &mut String,
                         builder_name: &str,
                         description: &str,
                         full_aad: &[u8],
                         segments: &[(&str, usize)],
                         inputs_json: &str,
                         trailing_comma: bool| {
            let total: usize = segments.iter().map(|(_, len)| *len).sum();
            assert_eq!(
                total,
                full_aad.len(),
                "segment lengths must sum to AAD length for {}",
                builder_name
            );
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"aad-construction/v0.1/{}\",\n",
                builder_name
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_builder_name\": \"{}\",\n",
                builder_name
            ));
            dump.push_str(inputs_json);
            dump.push_str(&alloc::format!(
                "      \"expected_aad_hex\": \"{}\",\n",
                hex_lower(full_aad)
            ));
            dump.push_str("      \"informational_aad_segments\": [\n");
            let mut offset = 0usize;
            for (i, (label, len)) in segments.iter().enumerate() {
                let seg = &full_aad[offset..offset + len];
                dump.push_str(&alloc::format!(
                    "        {{ \"offset\": {}, \"length\": {}, \"label\": \"{}\", \"bytes_hex\": \"{}\" }}{}\n",
                    offset,
                    len,
                    label,
                    hex_lower(seg),
                    if i + 1 == segments.len() { "" } else { "," }
                ));
                offset += len;
            }
            dump.push_str("      ]\n");
            dump.push_str(if trailing_comma {
                "    },\n"
            } else {
                "    }\n"
            });
        };

        emit_case(
            &mut dump,
            "aad_password_wrap",
            "AAD bound into the AEAD wrap of root_key under the password-derived wrap key (§3.1). Length-prefixed role 'password-wrap' + canonical 11-byte kdf_params block (bound for downgrade defense). account_number_hash is NOT in this AAD — it mixes into the wrap-key salt instead (§3.1).",
            &aad_pw,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 13),
                ("kdf_params_canonical", 11),
            ],
            &kdf_params_json,
            true,
        );
        emit_case(
            &mut dump,
            "aad_recovery_wrap",
            "AAD bound into the AEAD wrap of root_key under the recovery-phrase-derived wrap key (§3.1). Identical shape to aad_password_wrap but role 'recovery-wrap' — the role bytes are the sole domain separator between the two wraps.",
            &aad_rec,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 13),
                ("kdf_params_canonical", 11),
            ],
            &kdf_params_json,
            true,
        );
        emit_case(
            &mut dump,
            "aad_vault_items_key_wrap",
            "AAD bound into the AEAD wrap of the singleton v0.1 itemsKey (§3.3 + §9.3 offset 281). No length-prefixed role — just prefix + version + items_key_id. Distinct from aad_note_item_key_wrap (which adds note_uuid).",
            &aad_vik,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("items_key_id", 16),
            ],
            &items_key_id_json,
            true,
        );
        let nik_inputs = alloc::format!("{}{}", items_key_id_json, note_uuid_json);
        emit_case(
            &mut dump,
            "aad_note_item_key_wrap",
            "AAD bound into the AEAD wrap of a per-note item_key under the singleton itemsKey (§5.2 + §6.2). Binds both items_key_id and note_uuid — the per-note scope. The vault_/note_ prefix discipline retires the items_key/item_key one-letter footgun.",
            &aad_nik,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("items_key_id", 16),
                ("note_uuid", 16),
            ],
            &nik_inputs,
            true,
        );
        emit_case(
            &mut dump,
            "aad_prefs_blob",
            "AAD bound into the AEAD encryption of the vault.prefs blob (§5.2 + §9.5.3). Length-prefixed role 'prefs-blob' + account_number_hash (NOT items_key_id — prefs live outside the items_key lineage for later portability).",
            &aad_prefs,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 10),
                ("account_number_hash", 16),
            ],
            &account_hash_json,
            true,
        );
        emit_case(
            &mut dump,
            "aad_search_index_blob",
            "AAD bound into the AEAD encryption of the vault.search index blob (§9.6, MYND-29). Same shape as aad_prefs_blob with the distinct role 'search-index-blob' — domain-separates the search index from prefs so neither AEAD-verifies under the other's key/AAD.",
            &aad_search,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 17),
                ("account_number_hash", 16),
            ],
            &account_hash_json,
            true,
        );
        emit_case(
            &mut dump,
            "aad_workspace_blob",
            "AAD bound into the AEAD encryption of the vault.workspace blob (§9.7, MYND-254). Same shape as aad_prefs_blob / aad_search_index_blob with the distinct role 'workspace-blob' (14 bytes) — domain-separates the workspace state from the other vault singletons so none AEAD-verifies under another's key/AAD.",
            &aad_workspace,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 14),
                ("account_number_hash", 16),
            ],
            &account_hash_json,
            true,
        );
        emit_case(
            &mut dump,
            "aad_graph_layout_blob",
            "AAD bound into the AEAD encryption of the vault.graph knowledge-graph layout cache (§9.19). Same shape as aad_workspace_blob with the distinct role 'graph-layout-blob' (17 bytes) — domain-separates the layout cache from the other vault singletons so none AEAD-verifies under another's key/AAD.",
            &aad_graph,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 17),
                ("account_number_hash", 16),
            ],
            &account_hash_json,
            true,
        );
        emit_case(
            &mut dump,
            "aad_vault_indices_blob",
            "AAD bound into the AEAD encryption of the vault.indices structured-metadata blob (§9.8, MYND-271). Same shape as aad_prefs_blob / aad_search_index_blob / aad_workspace_blob with the distinct role 'vault-indices-blob' (18 bytes) — domain-separates the structured-metadata index from vault.search (a separate blob family) and the other vault singletons so none AEAD-verifies under another's key/AAD.",
            &aad_indices,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 18),
                ("account_number_hash", 16),
            ],
            &account_hash_json,
            true,
        );
        emit_case(
            &mut dump,
            "aad_ai_embeddings_blob",
            "AAD bound into the AEAD encryption of the vault.embeddings AI-embedding-index blob (§9.17.3, MYND-453). Same shape as aad_prefs_blob / aad_search_index_blob / aad_vault_indices_blob with the distinct role 'ai-embeddings-blob' (18 bytes) — domain-separates the dense AI vectors from vault.search and vault.indices (separate blob families, MYR1 != MYS1 != MYI1) and the other vault singletons so none AEAD-verifies under another's key/AAD. The AAD role is DISTINCT from the HKDF KEK role 'ai-embeddings-key'. The model-identity tuple that invalidates the cache on a model/dimension/chunker change rides INSIDE the opaque payload, NOT this AAD.",
            &aad_embeddings,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 18),
                ("account_number_hash", 16),
            ],
            &account_hash_json,
            true,
        );
        emit_case(
            &mut dump,
            "aad_personal_dictionary_blob",
            "AAD bound into the AEAD encryption of the vault.dictionary blob (§9.13, MYND-266). Same shape as aad_prefs_blob / aad_search_index_blob with the distinct role 'personal-dictionary-blob' (24 bytes) — domain-separates the personal dictionary from the other vault singletons so none AEAD-verifies under another's key/AAD. The AAD role is DISTINCT from the HKDF KEK role 'personal-dictionary-key'.",
            &aad_dictionary,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 24),
                ("account_number_hash", 16),
            ],
            &account_hash_json,
            true,
        );
        emit_case(
            &mut dump,
            "aad_quick_unlock_blob",
            "AAD bound into the AEAD wrap of the vault.quickunlock credential blob (§9.14.3, MYND-329). UNIQUE among the builders: it appends a trailing provider_kind byte (here 0x02 = PIN) AFTER the account_number_hash, so a credential minted for one wrap-key provider cannot AEAD-verify reinterpreted as another. Role 'quick-unlock-blob' (17 bytes). The quick-unlock blob has NO HKDF KEK role (its wrap key is provider-supplied, not root_key-derived).",
            &aad_quickunlock,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 17),
                ("account_number_hash", 16),
                ("provider_kind", 1),
            ],
            &account_hash_and_provider_json,
            true,
        );
        let content_inputs = alloc::format!("{}{}", items_key_id_json, note_uuid_json);
        emit_case(
            &mut dump,
            "aad_note_content_encrypt",
            "AAD bound into the AEAD encryption of a note's plaintext under its per-note item_key (§5.2 + §6.2). Binds items_key_id + note_uuid + a length-prefixed content_type, hardcoded 'text/markdown' in v0.1 (no per-call parameter).",
            &aad_content,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("items_key_id", 16),
                ("note_uuid", 16),
                ("content_type_length_be16", 2),
                ("content_type", 13),
            ],
            &content_inputs,
            true,
        );
        emit_case(
            &mut dump,
            "aad_attachment_text_blob",
            "AAD bound into the AEAD encryption of an MYE1 per-attachment extracted-text blob (§9.15.3, MYND-328). Role 'attachment-text-blob' (20 bytes), then account_number_hash (16) + attachment_id (32) + extractor_version (1 byte, here 0x01). UNIQUE: it binds BOTH a 32-byte attachment_id (so one KEK is safe across every attachment-text blob — a blob sealed for attachment A fails to verify as B) AND a trailing extractor_version byte (also carried in the header, so a tampered header byte cannot be silently accepted). HKDF role 'attachment-text-key' is DISTINCT from this AAD role.",
            &aad_attachment_text,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 20),
                ("account_number_hash", 16),
                ("attachment_id", 32),
                ("extractor_version", 1),
            ],
            &attachment_text_inputs_json,
            true,
        );
        emit_case(
            &mut dump,
            "aad_custom_themes_blob",
            "AAD bound into the AEAD encryption of the MYT1 vault.themes custom-theme store (§9.21.3, MYND-486). Role 'custom-themes-blob' (18 bytes), then account_number_hash (16) — the same shape as aad_personal_dictionary_blob / aad_vault_indices_blob with a distinct role label, which is exactly what keeps the vault-singleton families from cross-verifying. Binds account_number_hash (NOT items_key_id): the KEK derives straight from root_key, so the theme store survives an items-key rotation. The AAD role 'custom-themes-blob' is DISTINCT from the HKDF role 'custom-themes-key' (hkdf-sha256 family) and from the 'themes-sync-id' identifier derivation — three separate load-bearing strings in one feature.",
            &aad_themes,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 18),
                ("account_number_hash", 16),
            ],
            &account_hash_json,
            false,
        );

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_aad_construction_vectors.json", dump.as_bytes())
            .expect("write aad-construction vectors dump");
    }

    /// Generator for the **v0.2** `aad-construction` vectors.
    ///
    /// `cargo test -p protocol --lib emit_aad_construction_v0_2_vectors_for_paste -- --ignored`
    ///
    /// The four v0.2 AAD builders shipped with no cross-implementation vector of
    /// any kind, and they are not ordinary additions: each stamps
    /// [`AAD_PREFIX_V0_2`] (`"myne.v0.2|"`) and [`PROTOCOL_VERSION_V0_2`]
    /// (`0x02`), both of which the repo-root identifier table lists as
    /// **major-version-event constants**. They are also live production code —
    /// `singleton_migrate.rs`, `vault_meta_v0_2.rs`, `blob_envelope.rs`,
    /// `prefs.rs` and `attachments_catalog.rs` all call them on the §10.4.1
    /// whole-vault re-seal path — so an unvectored prefix here is a port that can
    /// migrate a vault into bytes no other implementation will ever open.
    ///
    /// The two `aad_nc05_*` builders are the v0.2 family's other half and are
    /// deliberately absent: `crdt-note-blob/v0.2` already pins both as
    /// `aad_construction` cases, and duplicating them here would create a second
    /// place to update. The v0.1 file's exclusion note has the same shape.
    ///
    /// `kdf_params` is the v0.1 canonical block on purpose. v0.2's own KDF is
    /// **not allocated yet** (repo-root `AGENTS.md`: only the AAD prefix, the
    /// HKDF context prefix, the `0x02` version byte and the `NC05` magic are
    /// pinned so far), so what these two cases pin is the *framing* — where the
    /// param block sits and that it is bound at all — not a v0.2 parameter
    /// choice. When v0.2 picks its KDF, the values change and the offsets do not.
    #[test]
    #[ignore]
    fn emit_aad_construction_v0_2_vectors_for_paste() {
        extern crate std;
        use alloc::string::String;

        let params = DEFAULT_V0_1_KDF_PARAMS;
        // Same byte patterns as the v0.1 generator, so a reviewer diffing the two
        // files sees only the differences that are real: prefix, version, role.
        let items_key_id: [u8; 16] = [0xB1; 16];
        let account_number_hash: [u8; 16] = [0xA3; 16];

        let aad_pw = aad_password_wrap_v0_2(&params);
        let aad_rec = aad_recovery_wrap_v0_2(&params);
        let aad_vik = aad_vault_items_key_wrap_v0_2(&items_key_id);
        let aad_prefs = aad_singleton_blob_v0_2(b"prefs-blob", &account_number_hash);
        let aad_themes = aad_singleton_blob_v0_2(b"custom-themes-blob", &account_number_hash);
        let memory_entry_id: [u8; 16] = [0xC7; 16];
        let aad_mem_blob = aad_agent_memory_blob_v0_2(&account_number_hash, &memory_entry_id);
        let aad_membership = aad_membership_blob(&account_number_hash);

        // The property that makes the v0.2 prefix worth a vector at all: the same
        // role under the two majors produces different AAD, so a v0.1 blob cannot
        // verify as v0.2 or the reverse (§10.5 anti-downgrade).
        assert_ne!(
            aad_singleton_blob(b"prefs-blob", &account_number_hash),
            aad_prefs,
            "v0.1 and v0.2 singleton AAD for the same role must differ — that difference IS the domain separation"
        );
        assert!(
            aad_prefs.starts_with(AAD_PREFIX_V0_2) && aad_prefs[AAD_PREFIX_V0_2.len()] == 0x02,
            "v0.2 AAD must carry the v0.2 prefix and version byte"
        );

        let kdf_params_json = alloc::format!(
            "      \"input_kdf_params\": {{\n        \"m_kib\": {},\n        \"t\": {},\n        \"p\": {},\n        \"argon2_version_hex\": \"{:02x}\"\n      }},\n",
            params.m_kib, params.t, params.p, params.argon2_version
        );
        let items_key_id_json = alloc::format!(
            "      \"input_items_key_id_hex\": \"{}\",\n",
            hex_lower(&items_key_id)
        );
        let account_hash_json = alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_number_hash)
        );
        let entry_id_json = alloc::format!(
            "      \"input_memory_entry_id_hex\": \"{}\",\n",
            hex_lower(&memory_entry_id)
        );
        let mut mem_blob_inputs_json = account_hash_json.clone();
        mem_blob_inputs_json.push_str(&entry_id_json);
        let role_and_hash_json = |role: &str| -> String {
            alloc::format!("      \"input_role_label\": \"{role}\",\n{account_hash_json}")
        };

        let mut dump = String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"aad-construction\",\n");
        dump.push_str("  \"protocol_version\": \"v0.2\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md §10.4.1 + §10.5 + §5.2\",\n");
        dump.push_str("  \"description\": \"Per-call-site AAD framing decomposition for the v0.2 aad_* builders (protocol/src/aead.rs). These are the next-major mirrors of the v0.1 family, stamped with the AAD prefix 'myne.v0.2|' and protocol_version byte 0x02. Both are major-version-event constants: the same role under the two majors yields different AAD, which is precisely the §10.5 anti-downgrade separation that stops a v0.1 blob verifying as v0.2 or the reverse. These builders are the §10.4.1 whole-vault migration's re-seal path, so a port that gets the framing wrong migrates a vault into bytes no other implementation can open. 7 cases: the password/recovery wraps, the itemsKey wrap, the generic KEK-singleton builder shown under two different roles (v0.2 has no per-family singleton builders. The migration rebuilds any family's AAD from its role string, so the role is an INPUT here rather than baked into the function name), the per-entry memory AAD (aad_agent_memory_blob_v0_2, myne-md/myne#697), and the membership-field builder (aad_membership_blob, §9.3.1). The two aad_nc05_* builders are the other half of the v0.2 family and are pinned by crdt-note-blob/v0.2's own aad_construction cases rather than duplicated here. NOTE on kdf_params: v0.2's KDF is not allocated yet, so the password/recovery cases carry the v0.1 canonical block. What they pin is the framing (where the block sits, that it is bound), not a v0.2 parameter choice. Cases generated by `cargo test -p protocol --lib emit_aad_construction_v0_2_vectors_for_paste -- --ignored` (in protocol/src/aead.rs).\",\n");
        dump.push_str("  \"cases\": [\n");

        // `case_slug` and `builder_name` are separate on purpose: the generic
        // singleton builder appears twice under two roles, so the vector_id has
        // to distinguish the cases while `input_builder_name` must stay the real
        // function name the runner dispatches on.
        let emit_case = |dump: &mut String,
                         case_slug: &str,
                         builder_name: &str,
                         description: &str,
                         full_aad: &[u8],
                         segments: &[(&str, usize)],
                         inputs_json: &str,
                         trailing_comma: bool| {
            let total: usize = segments.iter().map(|(_, len)| *len).sum();
            assert_eq!(
                total,
                full_aad.len(),
                "segment lengths must sum to AAD length for {}",
                case_slug
            );
            assert!(
                full_aad.starts_with(AAD_PREFIX_V0_2),
                "{} must carry the v0.2 AAD prefix",
                case_slug
            );
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"aad-construction/v0.2/{}\",\n",
                case_slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(description)
            ));
            dump.push_str(&alloc::format!(
                "      \"input_builder_name\": \"{}\",\n",
                builder_name
            ));
            dump.push_str(inputs_json);
            dump.push_str(&alloc::format!(
                "      \"expected_aad_hex\": \"{}\",\n",
                hex_lower(full_aad)
            ));
            dump.push_str("      \"informational_aad_segments\": [\n");
            let mut offset = 0usize;
            for (i, (label, len)) in segments.iter().enumerate() {
                let seg = &full_aad[offset..offset + len];
                dump.push_str(&alloc::format!(
                    "        {{ \"offset\": {}, \"length\": {}, \"label\": \"{}\", \"bytes_hex\": \"{}\" }}{}\n",
                    offset,
                    len,
                    label,
                    hex_lower(seg),
                    if i + 1 == segments.len() { "" } else { "," }
                ));
                offset += len;
            }
            dump.push_str("      ]\n");
            dump.push_str(if trailing_comma {
                "    },\n"
            } else {
                "    }\n"
            });
        };

        emit_case(
            &mut dump,
            "aad_password_wrap_v0_2",
            "aad_password_wrap_v0_2",
            "AAD bound into the AEAD wrap of root_key under the password-derived wrap key on a v0.2 vault (§10.4.1). Byte-for-byte the aad_password_wrap shape with the prefix and version byte swapped: role 'password-wrap' stays identical, so the ONLY thing separating a v0.1 wrap from a v0.2 one is those 11 leading bytes. That is the whole point — role reuse is safe precisely because the prefix already domain-separates the majors. account_number_hash is NOT in this AAD; it mixes into the wrap-key salt instead (§3.1).",
            &aad_pw,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 13),
                ("kdf_params_canonical", 11),
            ],
            &kdf_params_json,
            true,
        );
        emit_case(
            &mut dump,
            "aad_recovery_wrap_v0_2",
            "aad_recovery_wrap_v0_2",
            "AAD bound into the AEAD wrap of root_key under the recovery-phrase-derived wrap key on a v0.2 vault (§10.4.1). Identical shape to aad_password_wrap_v0_2 but role 'recovery-wrap' — within one major the role bytes are the sole separator between the two wraps, exactly as in v0.1.",
            &aad_rec,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 13),
                ("kdf_params_canonical", 11),
            ],
            &kdf_params_json,
            true,
        );
        emit_case(
            &mut dump,
            "aad_vault_items_key_wrap_v0_2",
            "aad_vault_items_key_wrap_v0_2",
            "AAD bound into the AEAD wrap of the singleton itemsKey on a v0.2 vault (§10.4.1). No length-prefixed role — prefix + version + items_key_id, the aad_vault_items_key_wrap shape. Note there is no v0.2 note-scoped sibling in this file: the per-note wrap for the v0.2 note type is aad_nc05_item_key_wrap, pinned by the crdt-note-blob/v0.2 vectors.",
            &aad_vik,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("items_key_id", 16),
            ],
            &items_key_id_json,
            true,
        );
        emit_case(
            &mut dump,
            "aad_singleton_blob_v0_2-prefs-blob",
            "aad_singleton_blob_v0_2",
            "The generic v0.2 KEK-singleton AAD builder under the 'prefs-blob' role — what the §10.4.1 migration re-seals vault.prefs with. v0.2 has no per-family singleton builders (no aad_prefs_blob_v0_2): the migration walks the families and rebuilds each AAD from its role string, so the role is an INPUT rather than baked into a function name. This case and the next differ ONLY in the role bytes and their length prefix, which is the property a port must reproduce: one generic function, one role per family, no per-family constant to get wrong.",
            &aad_prefs,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 10),
                ("account_number_hash", 16),
            ],
            &role_and_hash_json("prefs-blob"),
            true,
        );
        emit_case(
            &mut dump,
            "aad_singleton_blob_v0_2-custom-themes-blob",
            "aad_singleton_blob_v0_2",
            "The same generic v0.2 builder under the 'custom-themes-blob' role — the family whose v0.2 side vault-themes/v0.2 pins as an MYT5 envelope. Paired with the prefs-blob case so the role's length prefix is exercised at two different lengths (10 vs 18 bytes): a port that hardcoded one role length would pass one case and fail the other.",
            &aad_themes,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 18),
                ("account_number_hash", 16),
            ],
            &role_and_hash_json("custom-themes-blob"),
            true,
        );
        emit_case(
            &mut dump,
            "aad_agent_memory_blob_v0_2",
            "aad_agent_memory_blob_v0_2",
            "The v0.2 per-entry memory AAD (myne-md/myne#697): prefix + 0x02 + length-prefixed role 'agent-memory-blob' + 16-byte entry id + account hash. The entry id sits between the role and the hash, which is what makes a cross-entry substitution fail the AEAD tag. The §10.4.1 migration re-seals every memories/<id> file under exactly these bytes.",
            &aad_mem_blob,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 17),
                ("memory_entry_id", 16),
                ("account_number_hash", 16),
            ],
            &mem_blob_inputs_json,
            true,
        );
        emit_case(
            &mut dump,
            "aad_membership_blob",
            "aad_membership_blob",
            "AAD bound into the AEAD seal of the vault membership field (§9.3.1, the account/vault split). The field is NTV5-only, so this AAD is stamped with the v0.2 prefix + version, mirroring aad_prefs_blob in shape (role 'membership-blob' + account_number_hash) but under the v0.2 domain. The KEK is membership_key (SubkeyRole::MembershipKey), derived under the v0.2 context prefix.",
            &aad_membership,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 15),
                ("account_number_hash", 16),
            ],
            &role_and_hash_json("membership-blob"),
            true,
        );
        // myne-md/myne#768: the person binding shares the membership_key and
        // binds the same account_number_hash, but with its own role string, so a
        // binding field copied from another vault fails AEAD instead of
        // silently re-labelling which person owns this vault.
        let aad_person_binding = aad_person_binding_blob(&account_number_hash);
        emit_case(
            &mut dump,
            "aad_person_binding_blob",
            "aad_person_binding_blob",
            "AAD bound into the AEAD seal of the vault person binding field (§9.3.1 extension, myne-md/myne#768). Mirrors aad_membership_blob in shape (role + account_number_hash) under the v0.2 domain, sealed under the SAME membership_key, so a person-binding field copied from another vault fails AEAD rather than silently re-labelling which person owns this vault.",
            &aad_person_binding,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 19),
                ("account_number_hash", 16),
            ],
            &role_and_hash_json("person-binding-blob"),
            true,
        );
        // myne-md/myne#698 (B2B identity substrate): the roster envelope and
        // the two person-envelope builders. The roster envelope is
        // vault-scoped (role + account_number_hash, the membership shape); the
        // person wrap and keypair envelopes carry no account hash.
        let aad_roster = aad_membership_roster_blob(&account_number_hash);
        emit_case(
            &mut dump,
            "aad_membership_roster_blob",
            "aad_membership_roster_blob",
            "AAD bound into the AEAD seal of the membership field's B2B roster extension (NTV5 reserved byte 0x02, myne-md/myne#698). Mirrors aad_membership_blob with role 'membership-roster-blob' + account_number_hash, sealed under the SAME membership_key, so a roster copied from another vault fails AEAD instead of silently regrouping.",
            &aad_roster,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 22),
                ("account_number_hash", 16),
            ],
            &role_and_hash_json("membership-roster-blob"),
            true,
        );
        // The two person-envelope builders (myne-md/myne#698). `aad_person_wrap`
        // is vault-scoped (role + recipient fingerprint + account_number_hash);
        // `aad_person_keypair` is role-only by construction (the fingerprint is
        // derived from the sealed material itself, so no caller could supply it
        // before opening).
        let aad_person_wrap_case =
            crate::person_key::aad_person_wrap(&[0x5A; 32], &account_number_hash);
        emit_case(
            &mut dump,
            "aad_person_wrap",
            "aad_person_wrap",
            "AAD bound into the AEAD seal of a per-recipient itemsKey wrap (myne-md/myne#698). Role 'person-wrap-items-key' + the 32-byte recipient fingerprint + the 16-byte account_number_hash, the vault binding every vault-scoped AAD follows.",
            &aad_person_wrap_case,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 21),
                ("recipient_fingerprint", 32),
                ("account_number_hash", 16),
            ],
            &alloc::format!(
                "      \"input_role_label\": \"person-wrap-items-key\",\n      \"input_recipient_fingerprint_hex\": \"{}\",\n{}",
                hex_lower(&[0x5A; 32]),
                account_hash_json
            ),
            true,
        );
        let aad_person_keypair_case = crate::person_key::aad_person_keypair();
        emit_case(
            &mut dump,
            "aad_person_keypair",
            "aad_person_keypair",
            "AAD bound into the AEAD seal of a person keypair envelope (myne-md/myne#698). Role 'person-keypair-blob' only: a fingerprint cannot be bound here because it is derived from the sealed material itself.",
            &aad_person_keypair_case,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 19),
            ],
            "      \"input_role_label\": \"person-keypair-blob\",\n",
            true,
        );
        let aad_vault_invite_case = crate::person_invite::aad_vault_invite();
        emit_case(
            &mut dump,
            "aad_vault_invite",
            "aad_vault_invite",
            "AAD bound into the AEAD seal of an invite payload envelope (myne-md/myne#698). Role 'vault-invite-blob' only: the envelope is sync-wire-only and binds nothing else, because the vault binding the member needs arrives on the inner wrapped itemsKey whose own AAD carries account_number_hash.",
            &aad_vault_invite_case,
            &[
                ("aad_prefix", 10),
                ("protocol_version", 1),
                ("role_length_be16", 2),
                ("role_label", 17),
            ],
            "      \"input_role_label\": \"vault-invite-blob\",\n",
            false,
        );
        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write(
            "/tmp/myne_aad_construction_v0_2_vectors.json",
            dump.as_bytes(),
        )
        .expect("write aad-construction v0.2 vectors dump");
    }

    #[test]
    fn group_key_wrap_aad_binds_vault_and_epoch() {
        let account_a = [0x11; 16];
        let account_b = [0x22; 16];

        let current = aad_vault_group_key_wrap_v0_2(&account_a, 7);
        assert_ne!(current, aad_vault_group_key_wrap_v0_2(&account_b, 7));
        assert_ne!(current, aad_vault_group_key_wrap_v0_2(&account_a, 8));
    }

    /// The device-local vault-bound person-identity carrier AAD
    /// (myne-md/myne#792) decomposes as prefix · version · len(role) · role ·
    /// vault_id · person_id, and binds BOTH ids. It is device-local (outside the
    /// vault-scoped `ctx-aead` / `aad-construction` families, like
    /// `aad_capture_blob` / `aad_vault_label_blob`), so it is pinned here.
    #[test]
    fn aad_person_vault_carrier_binds_vault_and_person() {
        let vault_id = [0x11u8; 16];
        let person_id = [0x22u8; 16];
        let aad = aad_person_vault_carrier(&vault_id, &person_id);

        const ROLE: &[u8] = b"person-vault-carrier-blob";
        let mut expected = Vec::new();
        expected.extend_from_slice(AAD_PREFIX_V0_2);
        expected.push(PROTOCOL_VERSION_V0_2);
        expected.extend_from_slice(&(ROLE.len() as u16).to_be_bytes());
        expected.extend_from_slice(ROLE);
        expected.extend_from_slice(&vault_id);
        expected.extend_from_slice(&person_id);
        assert_eq!(aad, expected);

        // Both ids are bound: a change in either changes the AAD.
        assert_ne!(aad, aad_person_vault_carrier(&[0x99u8; 16], &person_id));
        assert_ne!(aad, aad_person_vault_carrier(&vault_id, &[0x99u8; 16]));
    }
}
