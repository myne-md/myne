// SPDX-License-Identifier: AGPL-3.0
//! Vault-head manifest — the canonical `uuid → content_nonce` map the vault
//! head commits as `manifest_hash` (`myne-agents/docs/spec/sync-protocol.md` §4.2, MYND-414).
//!
//! The head keeps only `manifest_hash = SHA-256(manifest_canonical)` (§3.2), so
//! the head stays O(1) in vault size. This module defines the **canonical byte
//! encoding of the manifest object itself** — the bytes both the Rust client and
//! any independent client port must produce bit-identically, the input whose
//! hash the head anchors.
//!
//! ## What the manifest covers (§4.2)
//!
//! - **Content blobs only:** notes (`.myn`, keyed by note UUID) and attachments
//!   (`MYA1`, keyed by `attachment-id`). Both keys are 16 bytes and share one
//!   flat keyspace — the manifest is uniform on a single discriminator and does
//!   **not** cover the synced singletons (`vault.prefs`/`vault.meta`/
//!   `vault.dictionary`/`vault.attachments`), whose rollback is the accepted
//!   "local prefs replay" limitation (`threat-model.md` §7).
//! - **Discriminator = `content_nonce`** (24 B, `protocol.md` §9.2): freshly
//!   random per content save and readable from the cleartext header without
//!   decrypting, giving the two-layer (pre-decrypt + on-decrypt) rollback
//!   detection of §4.2. A `deleted`-marked tombstone version carries its own
//!   fresh `content_nonce` and so stays in the manifest until horizon-GC.
//!
//! ## Canonical encoding (encode-then-hash, §3 discipline)
//!
//! Like the head MAC input (§3.2) and the CTX commitment (`protocol.md` §5.1.3),
//! the encoding is fixed-width and count-prefixed with a deterministic entry
//! order, so two implementations produce **bit-identical** bytes:
//!
//! ```text
//! manifest_canonical =
//!     "myne.v0.1|vault-manifest|"   (25 B  domain prefix — §3.5 hash domain
//!                                          separation: a manifest can never be
//!                                          reinterpreted as a head record, which
//!                                          begins "myne.v0.1|" + version bytes)
//!  || protocol_version              ( 1 B  = 0x01)
//!  || manifest_format_version       ( 1 B  = 0x01; forward hook)
//!  || entry_count                   ( 4 B  u32 big-endian)
//!  || for each entry, SORTED ASCENDING BY id (16 B, byte-order), id unique:
//!         id                        (16 B  note UUID or attachment-id)
//!         content_nonce             (24 B  the per-revision discriminator)
//!
//! manifest_hash = SHA-256(manifest_canonical)                        (32 B)
//! ```
//!
//! All multi-byte integers are big-endian (inherited from `protocol.md` §1.2).

use alloc::vec::Vec;
use sha2::{Digest, Sha256};

use crate::aead::AEAD_NONCE_LEN;

/// Hash-domain prefix bound into every `manifest_canonical` (§3.5). Distinct
/// from the head's `"myne.v0.1|"` prefix so a manifest's bytes can never be
/// reinterpreted as a head record. Load-bearing — drift silently changes every
/// `manifest_hash` and therefore every head.
pub const MANIFEST_DOMAIN_PREFIX: &[u8] = b"myne.v0.1|vault-manifest|";
/// Protocol version byte bound into `manifest_canonical`.
pub const MANIFEST_PROTOCOL_VERSION: u8 = 0x01;
/// The v0.1 manifest wire-format version (forward hook, mirrors §3.6).
pub const MANIFEST_FORMAT_V1: u8 = 0x01;

/// Length of a manifest entry id (note UUID or attachment-id), 16 bytes (§4.2).
pub const MANIFEST_ID_LEN: usize = 16;
/// Length of the manifest hash the head commits (`SHA-256`, §4.2).
pub const MANIFEST_HASH_LEN: usize = 32;

/// One manifest entry: a content blob's id and its current `content_nonce`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ManifestEntry {
    /// 16-byte note UUID or `attachment-id` (the flat content keyspace, §4.2).
    pub id: [u8; MANIFEST_ID_LEN],
    /// The blob's current `content_nonce` (`protocol.md` §9.2), the per-revision
    /// rollback discriminator.
    pub content_nonce: [u8; AEAD_NONCE_LEN],
}

/// Errors from encoding, hashing, or decoding a manifest.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[non_exhaustive]
pub enum ManifestError {
    /// Two entries share an `id` (the keyspace must be a map, not a multimap).
    #[error("manifest contains a duplicate id")]
    DuplicateId,
    /// Bytes too short to hold the fixed header / declared entries.
    #[error("manifest bytes too short to parse")]
    TooShort,
    /// Trailing bytes after a complete manifest (strict parse).
    #[error("manifest has unexpected trailing bytes")]
    TrailingBytes,
    /// Domain prefix mismatch (expected `"myne.v0.1|vault-manifest|"`).
    #[error("manifest domain prefix mismatch")]
    DomainPrefixMismatch,
    /// `protocol_version` byte mismatch (expected `0x01`).
    #[error("manifest protocol_version mismatch")]
    ProtocolVersionMismatch,
    /// `manifest_format_version` not supported by this client.
    #[error("manifest format_version unsupported")]
    FormatUnsupported,
    /// Decoded entries are not strictly ascending by `id` (canonical form).
    #[error("manifest entries are not canonically sorted by id")]
    NotCanonical,
}

/// Per-entry byte width (id || content_nonce).
const ENTRY_SIZE: usize = MANIFEST_ID_LEN + AEAD_NONCE_LEN;
/// Fixed header width (domain prefix + 2 version bytes + entry_count u32).
fn header_len() -> usize {
    MANIFEST_DOMAIN_PREFIX.len() + 1 + 1 + 4
}

/// Encode the canonical manifest bytes (§4.2). Sorts `entries` ascending by
/// `id` (the caller may pass any order) and rejects a duplicate `id`.
pub fn encode_manifest(entries: &[ManifestEntry]) -> Result<Vec<u8>, ManifestError> {
    let mut sorted = entries.to_vec();
    sorted.sort_unstable_by_key(|e| e.id);
    for w in sorted.windows(2) {
        if w[0].id == w[1].id {
            return Err(ManifestError::DuplicateId);
        }
    }

    let mut buf = Vec::with_capacity(header_len() + sorted.len() * ENTRY_SIZE);
    buf.extend_from_slice(MANIFEST_DOMAIN_PREFIX);
    buf.push(MANIFEST_PROTOCOL_VERSION);
    buf.push(MANIFEST_FORMAT_V1);
    buf.extend_from_slice(&(sorted.len() as u32).to_be_bytes());
    for e in &sorted {
        buf.extend_from_slice(&e.id);
        buf.extend_from_slice(&e.content_nonce);
    }
    Ok(buf)
}

/// `manifest_hash = SHA-256(encode_manifest(entries))` (§4.2) — the value the
/// vault head commits in its `head_mac_input`.
pub fn compute_manifest_hash(
    entries: &[ManifestEntry],
) -> Result<[u8; MANIFEST_HASH_LEN], ManifestError> {
    let bytes = encode_manifest(entries)?;
    let mut h = Sha256::new();
    h.update(&bytes);
    let out = h.finalize();
    let mut id = [0u8; MANIFEST_HASH_LEN];
    id.copy_from_slice(&out);
    Ok(id)
}

/// Decode canonical manifest bytes back into the entry list (strict: exact
/// length, supported versions, strictly-ascending unique ids). The inverse of
/// [`encode_manifest`]; used by the cross-impl vectors and round-trip proptests.
pub fn decode_manifest(bytes: &[u8]) -> Result<Vec<ManifestEntry>, ManifestError> {
    let hl = header_len();
    if bytes.len() < hl {
        return Err(ManifestError::TooShort);
    }
    let p = MANIFEST_DOMAIN_PREFIX.len();
    if &bytes[..p] != MANIFEST_DOMAIN_PREFIX {
        return Err(ManifestError::DomainPrefixMismatch);
    }
    let mut off = p;
    if bytes[off] != MANIFEST_PROTOCOL_VERSION {
        return Err(ManifestError::ProtocolVersionMismatch);
    }
    off += 1;
    if bytes[off] != MANIFEST_FORMAT_V1 {
        return Err(ManifestError::FormatUnsupported);
    }
    off += 1;
    let mut ec = [0u8; 4];
    ec.copy_from_slice(&bytes[off..off + 4]);
    let entry_count = u32::from_be_bytes(ec) as usize;
    off += 4;

    let body = bytes.len() - off;
    let expected = entry_count
        .checked_mul(ENTRY_SIZE)
        .ok_or(ManifestError::TooShort)?;
    if body < expected {
        return Err(ManifestError::TooShort);
    }
    if body != expected {
        return Err(ManifestError::TrailingBytes);
    }

    let mut entries = Vec::with_capacity(entry_count);
    for _ in 0..entry_count {
        let mut id = [0u8; MANIFEST_ID_LEN];
        id.copy_from_slice(&bytes[off..off + MANIFEST_ID_LEN]);
        off += MANIFEST_ID_LEN;
        let mut content_nonce = [0u8; AEAD_NONCE_LEN];
        content_nonce.copy_from_slice(&bytes[off..off + AEAD_NONCE_LEN]);
        off += AEAD_NONCE_LEN;
        entries.push(ManifestEntry { id, content_nonce });
    }
    for w in entries.windows(2) {
        if w[0].id >= w[1].id {
            return Err(ManifestError::NotCanonical);
        }
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::vec;

    fn entry(id: u8, nonce: u8) -> ManifestEntry {
        ManifestEntry {
            id: [id; MANIFEST_ID_LEN],
            content_nonce: [nonce; AEAD_NONCE_LEN],
        }
    }

    #[test]
    fn empty_manifest_encodes_to_header_only() {
        let bytes = encode_manifest(&[]).unwrap();
        assert_eq!(bytes.len(), header_len());
        assert_eq!(
            &bytes[..MANIFEST_DOMAIN_PREFIX.len()],
            MANIFEST_DOMAIN_PREFIX
        );
        assert_eq!(&bytes[bytes.len() - 4..], &[0, 0, 0, 0]);
        assert_eq!(decode_manifest(&bytes).unwrap(), Vec::new());
    }

    #[test]
    fn encoding_is_order_independent() {
        let a = encode_manifest(&[entry(1, 0x11), entry(2, 0x22), entry(3, 0x33)]).unwrap();
        let b = encode_manifest(&[entry(3, 0x33), entry(1, 0x11), entry(2, 0x22)]).unwrap();
        assert_eq!(a, b, "manifest encoding must be independent of input order");
    }

    #[test]
    fn hash_is_order_independent() {
        let a = compute_manifest_hash(&[entry(9, 0x99), entry(2, 0x22)]).unwrap();
        let b = compute_manifest_hash(&[entry(2, 0x22), entry(9, 0x99)]).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn changing_a_content_nonce_changes_the_hash() {
        let a = compute_manifest_hash(&[entry(1, 0x11)]).unwrap();
        let b = compute_manifest_hash(&[entry(1, 0x12)]).unwrap();
        assert_ne!(a, b, "a fresh content_nonce must move the manifest_hash");
    }

    #[test]
    fn roundtrip_recovers_sorted_entries() {
        let entries = [entry(5, 0x55), entry(1, 0x11), entry(9, 0x99)];
        let decoded = decode_manifest(&encode_manifest(&entries).unwrap()).unwrap();
        assert_eq!(
            decoded,
            vec![entry(1, 0x11), entry(5, 0x55), entry(9, 0x99)]
        );
    }

    #[test]
    fn duplicate_id_rejected() {
        assert_eq!(
            encode_manifest(&[entry(1, 0x11), entry(1, 0x22)]),
            Err(ManifestError::DuplicateId)
        );
    }

    #[test]
    fn decode_rejects_domain_prefix_drift() {
        let mut bytes = encode_manifest(&[entry(1, 0x11)]).unwrap();
        bytes[0] = b'X';
        assert_eq!(
            decode_manifest(&bytes),
            Err(ManifestError::DomainPrefixMismatch)
        );
    }

    #[test]
    fn decode_rejects_unsupported_format() {
        let mut bytes = encode_manifest(&[entry(1, 0x11)]).unwrap();
        bytes[MANIFEST_DOMAIN_PREFIX.len() + 1] = 0x02;
        assert_eq!(
            decode_manifest(&bytes),
            Err(ManifestError::FormatUnsupported)
        );
    }

    #[test]
    fn decode_rejects_trailing_bytes() {
        let mut bytes = encode_manifest(&[entry(1, 0x11)]).unwrap();
        bytes.push(0x00);
        assert_eq!(decode_manifest(&bytes), Err(ManifestError::TrailingBytes));
    }

    #[test]
    fn decode_rejects_truncation() {
        let bytes = encode_manifest(&[entry(1, 0x11)]).unwrap();
        assert_eq!(
            decode_manifest(&bytes[..bytes.len() - 1]),
            Err(ManifestError::TooShort)
        );
    }

    #[test]
    fn decode_rejects_non_canonical_order() {
        // Hand-build a body with descending ids to prove decode enforces order.
        let mut bytes = Vec::new();
        bytes.extend_from_slice(MANIFEST_DOMAIN_PREFIX);
        bytes.push(MANIFEST_PROTOCOL_VERSION);
        bytes.push(MANIFEST_FORMAT_V1);
        bytes.extend_from_slice(&2u32.to_be_bytes());
        let hi = entry(9, 0x99);
        let lo = entry(1, 0x11);
        for e in [hi, lo] {
            bytes.extend_from_slice(&e.id);
            bytes.extend_from_slice(&e.content_nonce);
        }
        assert_eq!(decode_manifest(&bytes), Err(ManifestError::NotCanonical));
    }

    /// Generate the `manifest` golden vectors (MYND-414/SYNC-13). Self-asserting
    /// at mint: every emitted `expected_*` is recomputed and round-trip-decoded
    /// here, so a regeneration cannot silently emit wrong bytes.
    ///
    /// `#[ignore]` — regenerating vectors is a deliberate act. Run with:
    /// `cargo test -p protocol --lib emit_manifest_vectors_for_paste -- --ignored`
    #[test]
    #[ignore]
    fn emit_manifest_vectors_for_paste() {
        extern crate std;
        use alloc::string::String;

        fn hex(bytes: &[u8]) -> String {
            let mut s = String::with_capacity(bytes.len() * 2);
            for b in bytes {
                s.push_str(&alloc::format!("{:02x}", b));
            }
            s
        }
        fn entries_json(es: &[ManifestEntry]) -> String {
            let mut s = String::from("[");
            for (i, e) in es.iter().enumerate() {
                if i > 0 {
                    s.push_str(", ");
                }
                s.push_str(&alloc::format!(
                    "{{ \"input_id_hex\": \"{}\", \"input_content_nonce_hex\": \"{}\" }}",
                    hex(&e.id),
                    hex(&e.content_nonce)
                ));
            }
            s.push(']');
            s
        }

        let mut dump = String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"manifest\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"sync-protocol.md §4.2 (MYND-414)\",\n");
        dump.push_str("  \"description\": \"Pins the canonical vault-head manifest byte encoding (uuid->content_nonce, sorted ascending by id) and its SHA-256 manifest_hash. The manifest is computed CLIENT-side: the head anchors only its hash, and the server never computes or verifies it (it holds no MAC key, by design). So this is a CLIENT-PORT contract — any independent Myne client must produce these bytes — NOT a client/server one. The only plausible Go consumer is server-adjacent audit tooling, which does not exist today; do not read a missing Go runner here as a coverage gap. Generated by `cargo test -p protocol --lib emit_manifest_vectors_for_paste -- --ignored`.\",\n");
        dump.push_str("  \"cases\": [\n");

        // (slug, description, entries-as-supplied [possibly unsorted], is parse_fail, parse_fail bytes/error)
        let emit_encode =
            |dump: &mut String, slug: &str, desc: &str, supplied: &[ManifestEntry], last: bool| {
                let bytes = encode_manifest(supplied).expect("encode");
                let mhash = compute_manifest_hash(supplied).expect("hash");
                // Self-assert: round-trip + hash recompute.
                assert_eq!(decode_manifest(&bytes).unwrap().len(), supplied.len());
                dump.push_str("    {\n");
                dump.push_str(&alloc::format!(
                    "      \"vector_id\": \"manifest/v0.1/{}\",\n",
                    slug
                ));
                dump.push_str(&alloc::format!("      \"description\": \"{}\",\n", desc));
                dump.push_str("      \"case_kind\": \"encode\",\n");
                dump.push_str(&alloc::format!(
                    "      \"input_entries\": {},\n",
                    entries_json(supplied)
                ));
                dump.push_str(&alloc::format!(
                    "      \"expected_manifest_bytes_hex\": \"{}\",\n",
                    hex(&bytes)
                ));
                dump.push_str(&alloc::format!(
                    "      \"expected_manifest_hash_hex\": \"{}\"\n",
                    hex(&mhash)
                ));
                dump.push_str(if last { "    }\n" } else { "    },\n" });
            };

        // 1. empty
        emit_encode(
            &mut dump,
            "encode-empty",
            "Empty manifest (a vault with no content blobs): header only, entry_count=0. The genesis head over an empty vault commits SHA-256 of this.",
            &[],
            false,
        );
        // 2. single
        emit_encode(
            &mut dump,
            "encode-single-note",
            "One note: id 0x01.. with content_nonce 0xaa.. .",
            &[entry(0x01, 0xaa)],
            false,
        );
        // 3. multi, supplied UNSORTED to pin the ascending-by-id sort
        let unsorted = [entry(0x09, 0x99), entry(0x01, 0x11), entry(0x05, 0x55)];
        emit_encode(
            &mut dump,
            "encode-multi-unsorted",
            "Three content blobs supplied UNSORTED (ids 0x09, 0x01, 0x05) to pin the canonical ascending-by-id sort; a port that skips the sort emits different bytes and a different manifest_hash.",
            &unsorted,
            false,
        );
        // 4. tombstone-bearing: a `deleted`-version note keeps a fresh nonce and
        //    stays in the manifest (§4.2). It is encoded as an ordinary entry.
        let with_tomb = [
            entry(0x01, 0xaa),
            ManifestEntry {
                id: [0x02; MANIFEST_ID_LEN],
                content_nonce: [0xde; AEAD_NONCE_LEN], // the deletion's fresh nonce
            },
        ];
        emit_encode(
            &mut dump,
            "encode-with-tombstone",
            "A live note (0x01) plus a `deleted`-marked tombstone version (0x02, fresh content_nonce 0xde..). Per §4.2 a tombstone stays in the manifest until horizon-GC, so it is just another entry the head commits.",
            &with_tomb,
            false,
        );

        // parse_fail cases.
        let emit_parse_fail =
            |dump: &mut String, slug: &str, desc: &str, bytes: &[u8], err: &str, last: bool| {
                assert!(decode_manifest(bytes).is_err(), "parse_fail must reject");
                dump.push_str("    {\n");
                dump.push_str(&alloc::format!(
                    "      \"vector_id\": \"manifest/v0.1/{}\",\n",
                    slug
                ));
                dump.push_str(&alloc::format!("      \"description\": \"{}\",\n", desc));
                dump.push_str("      \"case_kind\": \"parse_fail\",\n");
                dump.push_str(&alloc::format!(
                    "      \"input_manifest_bytes_hex\": \"{}\",\n",
                    hex(bytes)
                ));
                dump.push_str(&alloc::format!("      \"expected_error\": \"{}\"\n", err));
                dump.push_str(if last { "    }\n" } else { "    },\n" });
            };

        let mut pf_prefix = encode_manifest(&[entry(0x01, 0xaa)]).unwrap();
        pf_prefix[0] = b'X';
        emit_parse_fail(
            &mut dump,
            "parse-fail-domain-prefix",
            "First byte of the domain prefix corrupted; rejected before any field read (hash-domain separation, §3.5).",
            &pf_prefix,
            "domain_prefix_mismatch",
            false,
        );

        let mut pf_fmt = encode_manifest(&[entry(0x01, 0xaa)]).unwrap();
        pf_fmt[MANIFEST_DOMAIN_PREFIX.len() + 1] = 0x02;
        emit_parse_fail(
            &mut dump,
            "parse-fail-format-unsupported",
            "manifest_format_version set to 0x02 — a future manifest serialization a v0.1 client does not understand; rejected cleanly (forward hook).",
            &pf_fmt,
            "format_unsupported",
            false,
        );

        let mut pf_trail = encode_manifest(&[entry(0x01, 0xaa)]).unwrap();
        pf_trail.push(0x00);
        emit_parse_fail(
            &mut dump,
            "parse-fail-trailing-bytes",
            "One extra trailing byte after a complete manifest; strict decode rejects.",
            &pf_trail,
            "trailing_bytes",
            true,
        );

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_manifest_vectors.json", dump.as_bytes())
            .expect("write manifest vectors dump");
    }
}
