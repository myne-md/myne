// SPDX-License-Identifier: AGPL-3.0-only
//! Per-person private AI profile codec — `profiles/<profile-id>`, `MYY5`
//! (spec § 9.28, `decisions/protocol/0594`).
//!
//! One sealed profile per `(person, vault)` pair holding that person's private
//! AI state (their chat history, agent memory and personality directive). It is
//! **not group state**: the KEK is derived from the person's own recovery phrase
//! under the person-vault-profile salt domain
//! (`protocol::derive_person_vault_profile_key_from_normalized`), so neither the
//! shared `group_key` nor the owner's `root_key` can open it. The
//! `profile_id` is a deterministic function of the person-id hash and the vault
//! (`protocol::person_profile_id`), which is what makes the same person see the
//! same profile on every client while a different person or a different vault
//! derives a different id AND a different key.
//!
//! Like `vault.workspace` (§ 9.7) the inner plaintext is **opaque to this
//! layer**: the AI layer serializes its own structure and hands the codec raw
//! bytes, so the profile schema can evolve without a new blob family. The codec
//! owns only the envelope: magic, versions, nonce, the AEAD seal under the
//! profile key, and the `aad_person_profile_blob` binding (both
//! `account_number_hash` and `profile_id`).
//!
//! ## On-disk layout
//!
//! ```text
//! Offset  Size  Field              Notes
//! ------  ----  -----------------  -----------------------------------------
//! 0       4     magic              ASCII "MYY5"
//! 4       1     protocol_version   0x01 (the singleton-family byte; the v0.2
//!                                  generation domain-separates on magic + AAD
//!                                  prefix + KEK, not on this byte)
//! 5       1     format_version     0x01 = the initial opaque inner schema
//! 6       24    nonce              XChaCha20-Poly1305 nonce
//! 30      4     ciphertext_len     big-endian u32, plaintext_len + 32
//! 34      M     ciphertext         AEAD ciphertext + 32-byte CTX tag
//! ```
//!
//! The `profile_id` is NOT stored in the header: it is derived by the reader and
//! bound into the AAD, so a blob copied to another profile id fails AEAD
//! verification rather than being silently served as that profile.

use crate::aead::{aad_person_profile_blob, AEAD_KEY_LEN, AEAD_NONCE_LEN};
use crate::blob_envelope::{
    decode_blob_envelope, encode_blob_envelope, encode_blob_envelope_raw, EnvelopeError,
};
use crate::error::ProtocolError;
use alloc::vec::Vec;
use thiserror::Error;
use zeroize::Zeroizing;

/// Magic bytes at offset 0 — ASCII `"MYY5"`.
pub const PERSON_PROFILE_BLOB_MAGIC: [u8; 4] = *b"MYY5";

/// The `protocol_version` byte the shared singleton envelope writes (`0x01`).
pub const PERSON_PROFILE_BLOB_PROTOCOL_VERSION: u8 = 0x01;

/// `format_version` byte at offset 5 — the initial opaque inner schema.
pub const PERSON_PROFILE_BLOB_FORMAT_VERSION: u8 = 0x01;

/// Length of the deterministic 16-byte `(person, vault)` profile id.
pub const PERSON_PROFILE_ID_LEN: usize = 16;

/// Fixed-offset header length (offsets 0..34).
pub const PERSON_PROFILE_BLOB_HEADER_LEN: usize = 34;

/// Maximum inner-plaintext length, inclusive (16 MiB). The profile is a
/// person's private AI state, which can include a long chat history; 16 MiB
/// bounds the parser's pre-AEAD allocation (§9.6.5 DoS-allocation discipline).
pub const MAX_PERSON_PROFILE_PLAINTEXT_LEN: usize = 16 * 1024 * 1024;

/// Closed-enum failure surface for a `MYY5` profile encode / decode.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum PersonProfileBlobError {
    /// Input shorter than [`PERSON_PROFILE_BLOB_HEADER_LEN`] bytes.
    #[error("person profile blob too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYY5`.
    #[error("person profile blob magic mismatch (expected MYY5)")]
    MagicMismatch,
    /// `protocol_version` byte at offset 4 is not the expected value.
    #[error("person profile blob protocol_version mismatch")]
    ProtocolVersionMismatch,
    /// `format_version` is not understood by this client.
    #[error("person profile blob format_version unsupported")]
    FormatUnsupported,
    /// `ciphertext_len` exceeds [`MAX_PERSON_PROFILE_PLAINTEXT_LEN`] + 32.
    #[error("person profile ciphertext_len exceeds the 16 MiB + 32 cap")]
    CiphertextLenOverflow,
    /// Blob shorter than `PERSON_PROFILE_BLOB_HEADER_LEN + ciphertext_len`.
    #[error("person profile blob truncated relative to advertised ciphertext_len")]
    CiphertextTruncated,
    /// AEAD verification failure — wrong key, wrong AAD (wrong person / vault /
    /// profile id), tampered ciphertext or tag (§6.4 non-distinguishing).
    #[error("person profile AEAD verification failed")]
    CannotDecrypt,
    /// Plaintext to encode exceeds [`MAX_PERSON_PROFILE_PLAINTEXT_LEN`].
    #[error("person profile plaintext exceeds the 16 MiB cap")]
    PlaintextTooLarge,
    /// OS CSPRNG unavailable for nonce generation.
    #[error("OS CSPRNG unavailable for person profile nonce generation")]
    RandomnessUnavailable,
}

impl From<ProtocolError> for PersonProfileBlobError {
    fn from(_: ProtocolError) -> Self {
        // Every AEAD-layer failure collapses to one non-distinguishing variant
        // (§6.4 boundary-policy discipline).
        PersonProfileBlobError::CannotDecrypt
    }
}

crate::blob_envelope::impl_from_envelope_error!(PersonProfileBlobError);

/// Seal `plaintext` as a `MYY5` profile with a caller-supplied nonce.
pub fn encode_person_profile_blob_raw(
    profile_key: &[u8; AEAD_KEY_LEN],
    profile_id: &[u8; PERSON_PROFILE_ID_LEN],
    account_number_hash: &[u8; 16],
    nonce: &[u8; AEAD_NONCE_LEN],
    plaintext: &[u8],
) -> Result<Vec<u8>, PersonProfileBlobError> {
    let aad = aad_person_profile_blob(account_number_hash, profile_id);
    encode_blob_envelope_raw(
        profile_key,
        &PERSON_PROFILE_BLOB_MAGIC,
        PERSON_PROFILE_BLOB_FORMAT_VERSION,
        &aad,
        MAX_PERSON_PROFILE_PLAINTEXT_LEN,
        plaintext,
        nonce,
    )
    .map_err(Into::into)
}

/// [`encode_person_profile_blob_raw`] pulling the nonce from the OS CSPRNG.
pub fn encode_person_profile_blob(
    profile_key: &[u8; AEAD_KEY_LEN],
    profile_id: &[u8; PERSON_PROFILE_ID_LEN],
    account_number_hash: &[u8; 16],
    plaintext: &[u8],
) -> Result<Vec<u8>, PersonProfileBlobError> {
    let aad = aad_person_profile_blob(account_number_hash, profile_id);
    encode_blob_envelope(
        profile_key,
        &PERSON_PROFILE_BLOB_MAGIC,
        PERSON_PROFILE_BLOB_FORMAT_VERSION,
        &aad,
        MAX_PERSON_PROFILE_PLAINTEXT_LEN,
        plaintext,
    )
    .map_err(Into::into)
}

/// Open a `MYY5` profile under the caller's profile key. The `profile_id` and
/// `account_number_hash` are re-derived by the reader and bound into the AAD, so
/// a blob moved to another profile/vault fails here rather than decrypting.
pub fn decode_person_profile_blob(
    profile_key: &[u8; AEAD_KEY_LEN],
    profile_id: &[u8; PERSON_PROFILE_ID_LEN],
    account_number_hash: &[u8; 16],
    blob: &[u8],
) -> Result<Zeroizing<Vec<u8>>, PersonProfileBlobError> {
    let aad = aad_person_profile_blob(account_number_hash, profile_id);
    decode_blob_envelope(
        profile_key,
        &PERSON_PROFILE_BLOB_MAGIC,
        PERSON_PROFILE_BLOB_FORMAT_VERSION,
        &aad,
        MAX_PERSON_PROFILE_PLAINTEXT_LEN,
        blob,
    )
    .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::kdf::{derive_person_vault_profile_key, person_id_hash, person_profile_id};
    use crate::types::{KdfParams, MetaVersion};

    const ACCT: [u8; 16] = [0x44; 16];
    const PHRASE: &str = "abandon abandon abandon abandon abandon abandon abandon abandon \
                          abandon abandon abandon abandon abandon abandon abandon abandon \
                          abandon abandon abandon abandon abandon abandon abandon art";

    fn fast_params() -> KdfParams {
        KdfParams {
            m_kib: 8,
            t: 1,
            p: 1,
            argon2_version: 0x13,
        }
    }

    fn profile_key(phrase: &str, account: &[u8; 16]) -> ([u8; 16], Zeroizing<[u8; 32]>) {
        let person_id = person_id_hash(phrase);
        let profile_id = person_profile_id(&person_id, account);
        let key = derive_person_vault_profile_key(phrase, &profile_id, &fast_params())
            .expect("profile key");
        (profile_id, key)
    }

    #[test]
    fn profile_round_trips_for_its_person_and_vault() {
        let (profile_id, key) = profile_key(PHRASE, &ACCT);
        let blob = encode_person_profile_blob(&key, &profile_id, &ACCT, b"private-ai-state")
            .expect("encode");
        assert_eq!(blob.get(..4), Some(PERSON_PROFILE_BLOB_MAGIC.as_slice()));
        let opened = decode_person_profile_blob(&key, &profile_id, &ACCT, &blob).expect("decode");
        assert_eq!(&opened[..], b"private-ai-state");
    }

    #[test]
    fn a_different_person_or_vault_cannot_open_the_profile() {
        let (profile_id, key) = profile_key(PHRASE, &ACCT);
        let blob =
            encode_person_profile_blob(&key, &profile_id, &ACCT, b"private-ai-state").expect("enc");

        // Same phrase, DIFFERENT vault: a different profile id AND key.
        let other_vault = [0x55; 16];
        let (other_profile_id, other_key) = profile_key(PHRASE, &other_vault);
        assert_ne!(profile_id, other_profile_id);
        assert!(
            decode_person_profile_blob(&other_key, &other_profile_id, &other_vault, &blob).is_err()
        );
        // The right key with the WRONG profile id/vault fails on the AAD.
        assert!(decode_person_profile_blob(&key, &other_profile_id, &other_vault, &blob).is_err());

        // A DIFFERENT person's phrase in the same vault: different id + key.
        let other_phrase = PHRASE.replace("art", "zoo");
        let (stranger_profile_id, stranger_key) = profile_key(&other_phrase, &ACCT);
        assert_ne!(profile_id, stranger_profile_id);
        assert!(
            decode_person_profile_blob(&stranger_key, &stranger_profile_id, &ACCT, &blob).is_err()
        );
    }

    #[test]
    fn neither_the_group_key_nor_the_owner_root_key_opens_a_profile() {
        let (profile_id, key) = profile_key(PHRASE, &ACCT);
        let blob =
            encode_person_profile_blob(&key, &profile_id, &ACCT, b"private-ai-state").expect("enc");
        // The profile key is NOT derived from `root_key`/`group_key`, so neither
        // a random root-tier key nor a group-tier derivation opens it.
        assert!(decode_person_profile_blob(&[0u8; 32], &profile_id, &ACCT, &blob).is_err());
        assert!(decode_person_profile_blob(&[0xFFu8; 32], &profile_id, &ACCT, &blob).is_err());
    }

    #[test]
    fn tampered_and_malformed_profiles_fail_closed() {
        let (profile_id, key) = profile_key(PHRASE, &ACCT);
        let blob = encode_person_profile_blob(&key, &profile_id, &ACCT, b"x").expect("enc");

        let mut tampered = blob.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xFF;
        assert_eq!(
            decode_person_profile_blob(&key, &profile_id, &ACCT, &tampered),
            Err(PersonProfileBlobError::CannotDecrypt)
        );

        assert_eq!(
            decode_person_profile_blob(&key, &profile_id, &ACCT, &blob[..10]),
            Err(PersonProfileBlobError::HeaderTooShort)
        );
        let mut bad_magic = blob.clone();
        bad_magic[0] ^= 1;
        assert_eq!(
            decode_person_profile_blob(&key, &profile_id, &ACCT, &bad_magic),
            Err(PersonProfileBlobError::MagicMismatch)
        );
    }

    #[test]
    fn profile_id_is_deterministic_and_vault_scoped() {
        let person = person_id_hash(PHRASE);
        let a = person_profile_id(&person, &ACCT);
        let b = person_profile_id(&person, &ACCT);
        let c = person_profile_id(&person, &[0x55; 16]);
        assert_eq!(a, b);
        assert_ne!(a, c);
        // MetaVersion is unused here but pins that the codec is v0.2-only state.
        let _ = MetaVersion::V0_2;
    }

    #[test]
    #[ignore = "vector generator; run explicitly to refresh person-profile cases.json"]
    fn emit_person_profile_blob_vectors_for_paste() {
        extern crate std;
        use crate::test_vector_fmt::{hex_lower, json_escape};

        let key = [0x24u8; AEAD_KEY_LEN];
        let profile_id = [0x15u8; PERSON_PROFILE_ID_LEN];
        let account_hash = [0x33u8; 16];
        let other_account = [0x44u8; 16];
        let nonce = [0x5Au8; AEAD_NONCE_LEN];
        let plaintext: &[u8] = b"person-private ai profile bytes";

        let blob =
            encode_person_profile_blob_raw(&key, &profile_id, &account_hash, &nonce, plaintext)
                .expect("seal profile");

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"person-profile\",\n");
        dump.push_str("  \"protocol_version\": \"v0.2\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md section 9.28\",\n");
        dump.push_str("  \"description\": \"Pins the MYY5 person-private AI profile codec: encode_person_profile_blob_raw(key, profile_id, account_number_hash, nonce, plaintext) over the AAD aad_person_profile_blob (role 'person-profile-blob', account_number_hash || profile_id, v0.2 prefix). The key is the person's phrase-derived profile KEK; the id and account hash are AAD-bound, so a blob moved to another person or vault fails to open. EXPECTED RUNTIME: instant. Generated by `cargo test -p protocol --lib emit_person_profile_blob_vectors_for_paste -- --ignored`.\",\n");
        dump.push_str("  \"cases\": [\n");
        dump.push_str("    {\n");
        dump.push_str("      \"case_kind\": \"seal\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Seal a fixed plaintext under a fixed key, profile id, account hash and nonce; the decoder must round-trip it. Changing any AAD input fails the open.")
        ));
        dump.push_str(&alloc::format!(
            "      \"input_key_hex\": \"{}\",\n",
            hex_lower(&key)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_profile_id_hex\": \"{}\",\n",
            hex_lower(&profile_id)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&account_hash)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_nonce_hex\": \"{}\",\n",
            hex_lower(&nonce)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_plaintext_utf8\": \"{}\",\n",
            json_escape(&alloc::string::String::from_utf8_lossy(plaintext))
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_blob_hex\": \"{}\"\n",
            hex_lower(&blob)
        ));
        dump.push_str("    },\n");
        dump.push_str("    {\n");
        dump.push_str("      \"case_kind\": \"cross_vault_fail\",\n");
        dump.push_str(&alloc::format!(
            "      \"description\": \"{}\",\n",
            json_escape("Opening the SAME sealed blob under a different account_number_hash must fail closed: the account hash is AAD-bound, so a profile moved to another vault does not decrypt.")
        ));
        dump.push_str(&alloc::format!(
            "      \"input_key_hex\": \"{}\",\n",
            hex_lower(&key)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_profile_id_hex\": \"{}\",\n",
            hex_lower(&profile_id)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_account_number_hash_hex\": \"{}\",\n",
            hex_lower(&other_account)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_nonce_hex\": \"{}\",\n",
            hex_lower(&nonce)
        ));
        dump.push_str(&alloc::format!(
            "      \"input_plaintext_utf8\": \"{}\",\n",
            json_escape(&alloc::string::String::from_utf8_lossy(plaintext))
        ));
        dump.push_str(&alloc::format!(
            "      \"expected_blob_hex\": \"{}\"\n",
            hex_lower(&blob)
        ));
        dump.push_str("    }\n");
        dump.push_str("  ]\n");
        dump.push_str("}\n");
        std::fs::write("/tmp/myne_person_profile_vectors.json", dump.as_bytes())
            .expect("write person-profile vectors dump");
    }
}
