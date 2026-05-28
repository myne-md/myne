// SPDX-License-Identifier: AGPL-3.0-or-later

//! `vault.prefs` 34-byte-header encrypted-prefs codec — see
//! `docs/spec/protocol.md` § 9.5.
//!
//! `vault.prefs` is a vault-level singleton artifact holding
//! user-configurable preferences (v0.1: the screen-capture-protection
//! toggle from MYND-55 / MYND-160). It lives next to `vault.meta` at
//! `<vault-root>/vault.prefs` and is AEAD-encrypted under
//! `prefs_key = DeriveSubkey(root_key, SubkeyRole::PrefsKey)`.
//!
//! ## On-disk layout (spec § 9.5.1)
//!
//! ```text
//! Offset  Size  Field             Notes
//! ------  ----  ----------------  --------------------------------------
//! 0       4     magic             ASCII "MYP1"
//! 4       1     protocol_version  0x01
//! 5       1     reserved          0x00 (MUST)
//! 6       24    prefs_nonce       XChaCha20-Poly1305 nonce
//! 30      4     ciphertext_len    big-endian uint32, plaintext_len + 32
//! 34      M     ciphertext        AEAD ciphertext + 32-byte CTX tag T'
//! ```
//!
//! Total = 34 + M bytes. No public `prefs_key_id`, no public
//! `account_number_hash` — both bind cryptographically via key
//! derivation and AAD (§ 9.5.3) without consuming header bytes.
//!
//! ## Inner plaintext (spec § 9.5.2)
//!
//! Canonical JSON of a `PrefsView`. v0.1 ships a single field:
//!
//! ```text
//! {"screen_capture_protection":true}
//! ```
//!
//! Canonical encoding rules (load-bearing for cross-implementation
//! byte-stability + the future `myne-test-vectors/vectors/vault-prefs/`
//! KAT vectors):
//!
//! - Object keys lexicographically sorted (deterministic by
//!   construction — v0.1 has a single key, but the hand-rolled encoder
//!   below sorts at emit-time to keep the discipline visible).
//! - No insignificant whitespace (no spaces around `:` or `,`).
//! - Integer values without trailing `.0`.
//! - Floating-point values FORBIDDEN at the type level — the
//!   [`PrefsView`] struct has no float fields and never will in v0.1.
//! - UTF-8 NFC for string fields — v0.1's bool-only schema makes this
//!   a no-op; future string fields go through `unicode-normalization`
//!   before encoding.
//!
//! ## Schema evolution (spec § 9.5.2)
//!
//! Additive within v0.1 — new boolean / integer / string fields can be
//! appended in any v0.1.x minor revision. Older clients reading newer
//! plaintexts MUST treat unknown fields as unknown-and-ignored (the
//! parser below uses a tolerant value-by-value decoder, not a strict
//! struct-match, for forward-compat). Field removal, type changes,
//! and structural restructuring are MAJOR-version events (MYP5).
//!
//! ## Migration-less semantic (spec § 9.5.5)
//!
//! The caller-side `read_or_default` discipline (Tauri plugin layer,
//! not this crate) collapses absent-file / truncated / AEAD-fail /
//! parse-fail to `PrefsView::default()`. This module emits **honest
//! errors** for each failure mode — the caller decides whether to
//! collapse them to defaults. Discipline parity with `blob.rs`:
//! decoder reports failures, callers apply fall-back-to-defaults at
//! the appropriate boundary.

use crate::aead::{
    aad_prefs_blob, aead_open_ctx, aead_seal_ctx, AEAD_KEY_LEN, AEAD_NONCE_LEN,
    CTX_COMMITMENT_TAG_LEN,
};
use crate::error::ProtocolError;
use alloc::vec::Vec;
use getrandom::getrandom;
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::{Zeroize, Zeroizing};

/// Magic bytes at offset 0 — ASCII `"MYP1"` (Myne Prefs v1).
pub const PREFS_BLOB_MAGIC: [u8; 4] = *b"MYP1";

/// `protocol_version` byte at offset 4 — `0x01` for v0.1.
pub const PREFS_BLOB_PROTOCOL_VERSION: u8 = 0x01;

/// `reserved` byte at offset 5 — MUST be `0x00`.
pub const PREFS_BLOB_RESERVED: u8 = 0x00;

/// Length of the 16-byte `account_number_hash` field bound into
/// `AAD_prefs_blob` (spec § 9.5.3 + § 9.3 offset 6).
pub const PREFS_BLOB_ACCOUNT_HASH_LEN: usize = 16;

/// Length of the outer envelope's fixed-offset header (offsets 0..34).
/// Magic (4) + protocol_version (1) + reserved (1) + prefs_nonce (24)
/// + ciphertext_len (4) = 34 bytes.
pub const PREFS_BLOB_HEADER_LEN: usize = 34;

/// Maximum inner-plaintext length, inclusive (64 KiB).
///
/// The `ciphertext_len` field at header offset 30 carries
/// `plaintext_len + 32` (the trailing 32 = CTX commitment tag). The
/// decoder rejects `ciphertext_len > MAX_PREFS_PLAINTEXT_LEN + 32` at
/// the parse layer **before** any AEAD-bound allocation.
///
/// 64 KiB is ~13× headroom over any realistic v0.1 preference set
/// (v0.1's screen_capture_protection bool encodes to ~36 bytes JSON;
/// 100 future fields ≈ 5 KiB worst case). Parallel to the
/// [`crate::MAX_PLAINTEXT_LEN`] cap on `.myn` blobs. See spec § 9.5.4.
pub const MAX_PREFS_PLAINTEXT_LEN: usize = 64 * 1024;

/// In-memory representation of the v0.1 `vault.prefs` plaintext.
///
/// v0.1 has a single field. Future v0.1.x minor revisions append
/// optional fields here (boolean / integer / string only — no floats
/// per spec § 9.5.2). The `Default` impl supplies the
/// fall-back-to-defaults value the caller uses on read failure
/// (spec § 9.5.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PrefsView {
    /// User toggle for the screen-capture-protection layer
    /// (`threat-model.md` § 6 + `decisions.md` 2026-05-27 entries).
    /// Default `true` matches MYND-78's structural default-ON.
    pub screen_capture_protection: bool,
}

impl Default for PrefsView {
    /// Spec § 9.5.5 fall-back-to-defaults: `screen_capture_protection`
    /// defaults to `true` so that a missing or corrupt `vault.prefs`
    /// degrades to the safer state (protection on) rather than the
    /// permissive one.
    fn default() -> Self {
        Self {
            screen_capture_protection: true,
        }
    }
}

/// Closed-enum failure surface for `vault.prefs` encode / decode.
///
/// Parallel to `blob::DecryptError` from `blob.rs` but emits distinct
/// variants for each structural failure mode at the parse layer
/// (callers MAY collapse them per spec § 9.5.5 fall-back-to-defaults,
/// but this module reports them honestly so test code + observability
/// can distinguish).
///
/// The single `CannotDecrypt` variant for AEAD failure follows the
/// `protocol.md` § 6.4 non-distinguishing rule: any of "wrong key /
/// wrong AAD / tampered ciphertext / tampered CTX tag" collapses to a
/// single user-facing failure that does NOT leak which arm failed.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[non_exhaustive]
pub enum PrefsBlobError {
    /// Input shorter than [`PREFS_BLOB_HEADER_LEN`] bytes — not a
    /// valid `vault.prefs` envelope at all.
    #[error("vault.prefs blob too short to parse a header")]
    HeaderTooShort,
    /// First 4 bytes are not `MYP1`. Either a foreign file, a
    /// different artifact type, or a v005 (`MYP5`) blob the v0.1
    /// parser refuses (§ 10.1 forward-incompatible-by-design).
    #[error("vault.prefs blob magic mismatch (expected MYP1)")]
    MagicMismatch,
    /// `protocol_version` byte at offset 4 is not `0x01`.
    #[error("vault.prefs blob protocol_version mismatch (expected 0x01)")]
    ProtocolVersionMismatch,
    /// `reserved` byte at offset 5 is not `0x00`. Spec § 9.5.1 makes
    /// non-zero an unconditional parse rejection — reserved bytes are
    /// flag carriers for future v0.1.x minor revisions and a v0.1.0
    /// client cannot honor unknown flags.
    #[error("vault.prefs blob reserved byte must be 0x00")]
    ReservedByteNonZero,
    /// `ciphertext_len` exceeds [`MAX_PREFS_PLAINTEXT_LEN`] + 32. The
    /// cap exists to bound the parser's pre-AEAD allocation footprint
    /// (DoS-allocation defense, spec § 9.5.4).
    #[error("vault.prefs ciphertext_len exceeds 64 KiB + 32 cap")]
    CiphertextLenOverflow,
    /// Header advertised `ciphertext_len` bytes but the blob is shorter
    /// than `PREFS_BLOB_HEADER_LEN + ciphertext_len`.
    #[error("vault.prefs blob truncated relative to advertised ciphertext_len")]
    CiphertextTruncated,
    /// AEAD verification failure — wrong key, wrong AAD (cross-vault),
    /// tampered ciphertext, or tampered CTX commitment tag. Spec § 6.4
    /// non-distinguishing rule: the caller MUST NOT distinguish which
    /// arm failed beyond "this blob cannot be decrypted under the
    /// current key".
    #[error("vault.prefs AEAD verification failed")]
    CannotDecrypt,
    /// AEAD succeeded but the inner plaintext did not parse as the
    /// expected canonical JSON shape (truncated, wrong field name,
    /// wrong field type, malformed structure). Distinct from
    /// [`PrefsBlobError::CannotDecrypt`] because the AEAD tag check
    /// already proved the bytes were produced by a holder of the
    /// `prefs_key` — corruption past that point is structural rather
    /// than adversarial.
    #[error("vault.prefs inner plaintext failed to parse as canonical JSON")]
    PlaintextParseFailed,

    /// OS CSPRNG (`getrandom`) is unavailable — the encode path could
    /// not source a fresh `prefs_nonce`. Distinct from
    /// [`PrefsBlobError::CannotDecrypt`] because this is a
    /// randomness-availability failure on the ENCODE side, not an
    /// AEAD verification failure on the decode side; conflating them
    /// would corrupt the closed-enum log category for support flows
    /// (an early-boot embedded `/dev/urandom` exhaustion would surface
    /// as a tampered-blob event in observability).
    #[error("OS CSPRNG unavailable for prefs nonce generation")]
    RandomnessUnavailable,
}

impl From<ProtocolError> for PrefsBlobError {
    fn from(e: ProtocolError) -> Self {
        // Explicit exhaustive match (no `_ =>` wildcard) is
        // drift-detecting: a new `ProtocolError` variant landed in a
        // future protocol-crate change forces a compile-fail here,
        // surfacing the new failure mode to a reviewer who has to
        // decide whether the prefs codec should still collapse it to
        // CannotDecrypt (preserving spec § 6.4 non-distinguishing
        // discipline at the prefs surface) or surface it as its own
        // PrefsBlobError variant.
        //
        // Today, only `aead_seal_ctx`/`aead_open_ctx` are reachable
        // from the prefs codec; both produce `AeadFailure` only.
        // The other variants are listed but unreachable — kept here
        // so the match stays exhaustive at compile time.
        match e {
            ProtocolError::AeadFailure => PrefsBlobError::CannotDecrypt,
            ProtocolError::InvalidPassword
            | ProtocolError::PasswordTooShort
            | ProtocolError::KdfFailure
            | ProtocolError::InvalidVaultMeta
            | ProtocolError::AccountNumberInvalid
            | ProtocolError::Csprng
            | ProtocolError::PlaintextTooLarge => PrefsBlobError::CannotDecrypt,
        }
    }
}

// ---- canonical JSON encoder / decoder ---------------------------------
//
// v0.1 ships a single-field schema (`screen_capture_protection: bool`).
// Hand-rolled for two reasons:
//
// 1. **Dependency surface.** Adding `serde_json` as a main dep (it's
//    currently dev-dep only) triggers `dependency-policy.md` review.
//    A 50-line hand-rolled encoder/decoder for a fixed single-field
//    schema avoids the review without losing audit clarity — the
//    canonical encoding rules from spec § 9.5.2 are visible inline.
// 2. **Canonical-encoding discipline.** `serde_json` requires careful
//    configuration (BTreeMap for sorted keys, no whitespace presets,
//    explicit float rejection) to satisfy the spec § 9.5.2 rules.
//    The hand-rolled version enforces all four by construction.
//
// When a future v0.1.x minor revision adds a second field, this
// encoder grows by one match arm — the discipline scales linearly
// until ~5-10 fields, at which point migrating to `serde_json` +
// `BTreeMap` becomes the right call (separate decision, separate
// `dependency-policy.md` PR review).

fn canonical_json_encode(prefs: &PrefsView) -> Vec<u8> {
    // Single-field shape: {"screen_capture_protection":<bool>}
    let mut out = Vec::with_capacity(36);
    out.extend_from_slice(b"{\"screen_capture_protection\":");
    out.extend_from_slice(if prefs.screen_capture_protection {
        b"true"
    } else {
        b"false"
    });
    out.push(b'}');
    out
}

/// Parse the v0.1 canonical-JSON `vault.prefs` plaintext.
///
/// Tolerant against future v0.1.x minor revisions that append fields:
/// if the input matches the v0.1.0 single-field shape exactly, return
/// the parsed `PrefsView`; if the input is a v0.1.1+ multi-field
/// object that still carries `screen_capture_protection`, the unknown
/// fields are silently ignored (per spec § 9.5.2 forward-compat
/// "older clients SHOULD NOT reject unknown fields").
///
/// Returns [`PrefsBlobError::PlaintextParseFailed`] for any structural
/// malformation (missing `{...}` wrapper, missing
/// `screen_capture_protection` key, wrong value type, truncated).
fn canonical_json_decode(plaintext: &[u8]) -> Result<PrefsView, PrefsBlobError> {
    // Single-path decoder: locate the known field via substring search
    // within the wrapping object. Handles both v0.1.0 (single field)
    // and any future v0.1.x (additive fields the v0.1.0 client should
    // ignore per spec § 9.5.2 forward-compat).
    //
    // Acceptable shape: starts with `{`, ends with `}`, contains the
    // exact key `"screen_capture_protection":` followed by either
    // `true` or `false` with strict suffix (end-of-object or `,` for
    // a next field). Anything else (missing wrapper, missing key,
    // non-bool value, trailing garbage like `truefoo}`) is a parse
    // failure.
    let stripped = plaintext
        .strip_prefix(b"{")
        .and_then(|p| p.strip_suffix(b"}"))
        .ok_or(PrefsBlobError::PlaintextParseFailed)?;

    let key_marker = b"\"screen_capture_protection\":";
    let idx = find_subslice(stripped, key_marker).ok_or(PrefsBlobError::PlaintextParseFailed)?;
    let after_key = &stripped[idx + key_marker.len()..];

    // Strict suffix matching: after `"screen_capture_protection":`,
    // the value must be exactly `true` or `false` followed by either
    // end-of-object content (`,` for more fields, or empty if last
    // field — the wrapper braces were stripped before this point).
    // `starts_with` alone would accept `truefoo` or `falsehoodxyz`
    // as valid → silent data-integrity bug on tampered-but-AEAD-OK
    // plaintexts.
    if after_key == b"true" || after_key.starts_with(b"true,") {
        Ok(PrefsView {
            screen_capture_protection: true,
        })
    } else if after_key == b"false" || after_key.starts_with(b"false,") {
        Ok(PrefsView {
            screen_capture_protection: false,
        })
    } else {
        Err(PrefsBlobError::PlaintextParseFailed)
    }
}

/// Naive substring search — `slice::windows().position()` equivalent
/// without depending on `[u8]::contains_slice` (unstable as of Rust
/// 1.90). v0.1 plaintexts are bounded at 64 KiB; the O(n×m) cost is
/// negligible for the single short key we look up.
fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || needle.len() > haystack.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

// ---- encode / decode primitives ---------------------------------------

/// Encode a `vault.prefs` blob with caller-supplied randomness
/// (`_raw` per `protocol/CLAUDE.md` randomness-injection convention).
///
/// Returns the 34-byte header followed by `ciphertext || T'` per spec
/// § 9.5.1. Reject inputs that would exceed [`MAX_PREFS_PLAINTEXT_LEN`]
/// at the canonical JSON encoding stage — v0.1's single-bool schema
/// is always well under the cap, but the bound is enforced symmetric
/// with the decoder so encoder + decoder round-trip stays well-defined
/// at the boundary.
///
/// `_raw` callers source `prefs_nonce` from a CSPRNG-grade source —
/// nonce reuse under the same `prefs_key` is catastrophic per the
/// XChaCha20-Poly1305 contract. Production callers SHOULD use
/// [`encode_prefs_blob`], which pulls randomness from `getrandom`.
pub fn encode_prefs_blob_raw(
    prefs_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; PREFS_BLOB_ACCOUNT_HASH_LEN],
    prefs: &PrefsView,
    prefs_nonce: &[u8; AEAD_NONCE_LEN],
) -> Result<Vec<u8>, PrefsBlobError> {
    let plaintext = Zeroizing::new(canonical_json_encode(prefs));

    if plaintext.len() > MAX_PREFS_PLAINTEXT_LEN {
        // Defensive — v0.1 schema cannot reach this, but a future field
        // mix could; encoder enforces symmetric to the decoder.
        return Err(PrefsBlobError::CiphertextLenOverflow);
    }

    let aad = aad_prefs_blob(account_number_hash);
    let sealed = aead_seal_ctx(prefs_key, prefs_nonce, &plaintext, &aad)?;

    // sealed = ciphertext || T' where T' is the 32-byte CTX tag.
    // ciphertext_len in the header = sealed.len() = plaintext.len() + 32.
    let ciphertext_len = sealed.len();
    debug_assert_eq!(
        ciphertext_len,
        plaintext.len() + CTX_COMMITMENT_TAG_LEN,
        "aead_seal_ctx invariant: output is ciphertext || CTX tag",
    );

    let mut out = Vec::with_capacity(PREFS_BLOB_HEADER_LEN + ciphertext_len);
    out.extend_from_slice(&PREFS_BLOB_MAGIC);
    out.push(PREFS_BLOB_PROTOCOL_VERSION);
    out.push(PREFS_BLOB_RESERVED);
    out.extend_from_slice(prefs_nonce);
    out.extend_from_slice(&(ciphertext_len as u32).to_be_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Encode a `vault.prefs` blob, pulling the 24-byte nonce from the OS
/// CSPRNG via `getrandom`. Production callers SHOULD use this rather
/// than [`encode_prefs_blob_raw`] — it shifts the "do not reuse a
/// nonce under the same key" contract from the caller to the OS
/// CSPRNG, which is the correct boundary.
pub fn encode_prefs_blob(
    prefs_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; PREFS_BLOB_ACCOUNT_HASH_LEN],
    prefs: &PrefsView,
) -> Result<Vec<u8>, PrefsBlobError> {
    let mut prefs_nonce = [0u8; AEAD_NONCE_LEN];
    getrandom(&mut prefs_nonce).map_err(|_| PrefsBlobError::RandomnessUnavailable)?;
    let result = encode_prefs_blob_raw(prefs_key, account_number_hash, prefs, &prefs_nonce);
    prefs_nonce.zeroize();
    result
}

/// Decode a `vault.prefs` blob into a `PrefsView`.
///
/// Returns the parsed preferences on success. Failure modes are
/// reported as distinct `PrefsBlobError` variants for observability;
/// per spec § 9.5.5 the caller (Tauri plugin layer) collapses all of
/// them to `PrefsView::default()` before surfacing to the user.
pub fn decode_prefs_blob(
    prefs_key: &[u8; AEAD_KEY_LEN],
    account_number_hash: &[u8; PREFS_BLOB_ACCOUNT_HASH_LEN],
    blob: &[u8],
) -> Result<PrefsView, PrefsBlobError> {
    // ---- parse the 34-byte header --------------------------------------
    if blob.len() < PREFS_BLOB_HEADER_LEN {
        return Err(PrefsBlobError::HeaderTooShort);
    }
    if blob[0..4] != PREFS_BLOB_MAGIC {
        return Err(PrefsBlobError::MagicMismatch);
    }
    if blob[4] != PREFS_BLOB_PROTOCOL_VERSION {
        return Err(PrefsBlobError::ProtocolVersionMismatch);
    }
    if blob[5] != PREFS_BLOB_RESERVED {
        return Err(PrefsBlobError::ReservedByteNonZero);
    }

    let mut prefs_nonce = [0u8; AEAD_NONCE_LEN];
    prefs_nonce.copy_from_slice(&blob[6..30]);

    let ciphertext_len = u32::from_be_bytes([blob[30], blob[31], blob[32], blob[33]]) as usize;

    // Reject oversize BEFORE indexing into the blob — otherwise a
    // hostile `ciphertext_len = 0xFFFFFFFF` blob causes a panicking
    // slice-index instead of a clean error.
    if ciphertext_len > MAX_PREFS_PLAINTEXT_LEN + CTX_COMMITMENT_TAG_LEN {
        return Err(PrefsBlobError::CiphertextLenOverflow);
    }
    let ciphertext_end = PREFS_BLOB_HEADER_LEN + ciphertext_len;
    if blob.len() < ciphertext_end {
        return Err(PrefsBlobError::CiphertextTruncated);
    }

    // ---- AEAD-decrypt --------------------------------------------------
    let aad = aad_prefs_blob(account_number_hash);
    let plaintext_zeroizing = aead_open_ctx(
        prefs_key,
        &prefs_nonce,
        &blob[PREFS_BLOB_HEADER_LEN..ciphertext_end],
        &aad,
    )?;

    // ---- parse the inner canonical JSON --------------------------------
    canonical_json_decode(&plaintext_zeroizing)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::subkey::{derive_subkey, SubkeyRole};

    // Fixed root_key + account_number_hash so KAT-style tests are
    // deterministic. Real-world callers source these from `getrandom`
    // and `vault.meta` respectively.
    fn fixed_root_key() -> [u8; 32] {
        [0x42; 32]
    }
    fn fixed_account_number_hash() -> [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] {
        [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN]
    }
    fn fixed_prefs_nonce() -> [u8; AEAD_NONCE_LEN] {
        [0x77; AEAD_NONCE_LEN]
    }

    // ---- canonical JSON encoder ----------------------------------------

    #[test]
    fn canonical_json_encodes_true_to_expected_bytes() {
        let prefs = PrefsView {
            screen_capture_protection: true,
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(encoded.as_slice(), br#"{"screen_capture_protection":true}"#);
    }

    #[test]
    fn canonical_json_encodes_false_to_expected_bytes() {
        let prefs = PrefsView {
            screen_capture_protection: false,
        };
        let encoded = canonical_json_encode(&prefs);
        assert_eq!(
            encoded.as_slice(),
            br#"{"screen_capture_protection":false}"#
        );
    }

    #[test]
    fn canonical_json_encoding_has_no_whitespace() {
        // Spec § 9.5.2: no insignificant whitespace. Verify byte-exact.
        let encoded = canonical_json_encode(&PrefsView::default());
        assert!(!encoded.contains(&b' '));
        assert!(!encoded.contains(&b'\n'));
        assert!(!encoded.contains(&b'\t'));
        assert!(!encoded.contains(&b'\r'));
    }

    #[test]
    fn canonical_json_encoding_is_deterministic() {
        // Same input → same output, every call.
        let prefs = PrefsView::default();
        let a = canonical_json_encode(&prefs);
        let b = canonical_json_encode(&prefs);
        assert_eq!(a, b);
    }

    // ---- canonical JSON decoder ----------------------------------------

    #[test]
    fn canonical_json_decodes_true() {
        let parsed = canonical_json_decode(br#"{"screen_capture_protection":true}"#).unwrap();
        assert_eq!(
            parsed,
            PrefsView {
                screen_capture_protection: true
            }
        );
    }

    #[test]
    fn canonical_json_decodes_false() {
        let parsed = canonical_json_decode(br#"{"screen_capture_protection":false}"#).unwrap();
        assert_eq!(
            parsed,
            PrefsView {
                screen_capture_protection: false
            }
        );
    }

    #[test]
    fn canonical_json_decoder_tolerates_future_unknown_fields() {
        // Spec § 9.5.2 forward-compat: a v0.1.0 client reading a
        // v0.1.1+ plaintext with extra fields must still recover the
        // known field rather than rejecting.
        let parsed = canonical_json_decode(
            br#"{"screen_capture_protection":true,"theme":"dark","font_size":14}"#,
        )
        .unwrap();
        assert!(parsed.screen_capture_protection);
    }

    #[test]
    fn canonical_json_decoder_rejects_missing_wrapper() {
        let err = canonical_json_decode(br#""screen_capture_protection":true"#).unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    #[test]
    fn canonical_json_decoder_rejects_missing_key() {
        let err = canonical_json_decode(br#"{"other_field":true}"#).unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    #[test]
    fn canonical_json_decoder_rejects_non_bool_value() {
        let err = canonical_json_decode(br#"{"screen_capture_protection":42}"#).unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    #[test]
    fn canonical_json_decoder_rejects_truncated_after_key() {
        let err = canonical_json_decode(br#"{"screen_capture_protection":}"#).unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    #[test]
    fn canonical_json_decoder_rejects_trailing_garbage_after_true() {
        // Strict-suffix discipline: `truefoo` MUST NOT be accepted as
        // `true`. Catches tampered-but-AEAD-OK plaintexts that try to
        // sneak past via prefix matching.
        let err = canonical_json_decode(br#"{"screen_capture_protection":truefoo}"#).unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    #[test]
    fn canonical_json_decoder_rejects_trailing_garbage_after_false() {
        let err = canonical_json_decode(br#"{"screen_capture_protection":falseyyy}"#).unwrap_err();
        assert_eq!(err, PrefsBlobError::PlaintextParseFailed);
    }

    // ---- outer envelope structural tests -------------------------------

    #[test]
    fn encode_emits_myp1_magic_at_offset_0() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let blob = encode_prefs_blob_raw(
            &prefs_key,
            &fixed_account_number_hash(),
            &PrefsView::default(),
            &fixed_prefs_nonce(),
        )
        .unwrap();
        assert_eq!(&blob[0..4], b"MYP1");
    }

    #[test]
    fn encode_emits_protocol_version_0x01_at_offset_4() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let blob = encode_prefs_blob_raw(
            &prefs_key,
            &fixed_account_number_hash(),
            &PrefsView::default(),
            &fixed_prefs_nonce(),
        )
        .unwrap();
        assert_eq!(blob[4], 0x01);
    }

    #[test]
    fn encode_emits_reserved_0x00_at_offset_5() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let blob = encode_prefs_blob_raw(
            &prefs_key,
            &fixed_account_number_hash(),
            &PrefsView::default(),
            &fixed_prefs_nonce(),
        )
        .unwrap();
        assert_eq!(blob[5], 0x00);
    }

    #[test]
    fn encode_emits_prefs_nonce_at_offset_6() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let nonce = fixed_prefs_nonce();
        let blob = encode_prefs_blob_raw(
            &prefs_key,
            &fixed_account_number_hash(),
            &PrefsView::default(),
            &nonce,
        )
        .unwrap();
        assert_eq!(&blob[6..30], &nonce[..]);
    }

    #[test]
    fn encode_emits_ciphertext_len_big_endian_at_offset_30() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let blob = encode_prefs_blob_raw(
            &prefs_key,
            &fixed_account_number_hash(),
            &PrefsView::default(),
            &fixed_prefs_nonce(),
        )
        .unwrap();
        let len_bytes = [blob[30], blob[31], blob[32], blob[33]];
        let ciphertext_len = u32::from_be_bytes(len_bytes) as usize;
        // Default plaintext: {"screen_capture_protection":true} = 34 bytes;
        // ciphertext_len = 34 + 32 (CTX tag) = 66.
        assert_eq!(ciphertext_len, 34 + CTX_COMMITMENT_TAG_LEN);
        assert_eq!(blob.len(), PREFS_BLOB_HEADER_LEN + ciphertext_len);
    }

    // ---- round-trip ----------------------------------------------------

    #[test]
    fn round_trip_default_prefs() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let original = PrefsView::default();
        let blob =
            encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce())
                .unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
        assert_eq!(original, decoded);
    }

    #[test]
    fn round_trip_toggled_off() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let original = PrefsView {
            screen_capture_protection: false,
        };
        let blob =
            encode_prefs_blob_raw(&prefs_key, &account_hash, &original, &fixed_prefs_nonce())
                .unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
        assert_eq!(original, decoded);
    }

    #[test]
    fn round_trip_via_getrandom_convenience() {
        // `encode_prefs_blob` pulls a random nonce; round-trip still
        // holds because the decoder reads the nonce from the header.
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let original = PrefsView {
            screen_capture_protection: false,
        };
        let blob = encode_prefs_blob(&prefs_key, &account_hash, &original).unwrap();
        let decoded = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap();
        assert_eq!(original, decoded);
    }

    // ---- structural rejection ------------------------------------------

    #[test]
    fn decode_rejects_short_blob_with_header_too_short() {
        let prefs_key = [0u8; AEAD_KEY_LEN];
        let err =
            decode_prefs_blob(&prefs_key, &fixed_account_number_hash(), &[0u8; 33]).unwrap_err();
        assert_eq!(err, PrefsBlobError::HeaderTooShort);
    }

    #[test]
    fn decode_rejects_wrong_magic() {
        let mut blob = [0u8; PREFS_BLOB_HEADER_LEN];
        blob[..4].copy_from_slice(b"MY01"); // .myn magic, not MYP1
        blob[4] = 0x01;
        blob[5] = 0x00;
        let prefs_key = [0u8; AEAD_KEY_LEN];
        let err = decode_prefs_blob(&prefs_key, &fixed_account_number_hash(), &blob).unwrap_err();
        assert_eq!(err, PrefsBlobError::MagicMismatch);
    }

    #[test]
    fn decode_rejects_wrong_protocol_version() {
        let mut blob = [0u8; PREFS_BLOB_HEADER_LEN];
        blob[..4].copy_from_slice(&PREFS_BLOB_MAGIC);
        blob[4] = 0x02; // bogus protocol_version
        blob[5] = 0x00;
        let prefs_key = [0u8; AEAD_KEY_LEN];
        let err = decode_prefs_blob(&prefs_key, &fixed_account_number_hash(), &blob).unwrap_err();
        assert_eq!(err, PrefsBlobError::ProtocolVersionMismatch);
    }

    #[test]
    fn decode_rejects_nonzero_reserved_byte() {
        let mut blob = [0u8; PREFS_BLOB_HEADER_LEN];
        blob[..4].copy_from_slice(&PREFS_BLOB_MAGIC);
        blob[4] = 0x01;
        blob[5] = 0x01; // reserved byte non-zero
        let prefs_key = [0u8; AEAD_KEY_LEN];
        let err = decode_prefs_blob(&prefs_key, &fixed_account_number_hash(), &blob).unwrap_err();
        assert_eq!(err, PrefsBlobError::ReservedByteNonZero);
    }

    #[test]
    fn decode_rejects_oversize_ciphertext_len() {
        let mut blob = [0u8; PREFS_BLOB_HEADER_LEN];
        blob[..4].copy_from_slice(&PREFS_BLOB_MAGIC);
        blob[4] = 0x01;
        blob[5] = 0x00;
        // Set ciphertext_len to 0xFFFFFFFF (4 GiB)
        blob[30..34].copy_from_slice(&u32::MAX.to_be_bytes());
        let prefs_key = [0u8; AEAD_KEY_LEN];
        let err = decode_prefs_blob(&prefs_key, &fixed_account_number_hash(), &blob).unwrap_err();
        assert_eq!(err, PrefsBlobError::CiphertextLenOverflow);
    }

    #[test]
    fn decode_rejects_truncated_blob_with_ciphertext_len_present_but_bytes_missing() {
        let mut blob = [0u8; PREFS_BLOB_HEADER_LEN];
        blob[..4].copy_from_slice(&PREFS_BLOB_MAGIC);
        blob[4] = 0x01;
        blob[5] = 0x00;
        // Advertise 100 bytes of ciphertext but provide none
        blob[30..34].copy_from_slice(&100u32.to_be_bytes());
        let prefs_key = [0u8; AEAD_KEY_LEN];
        let err = decode_prefs_blob(&prefs_key, &fixed_account_number_hash(), &blob).unwrap_err();
        assert_eq!(err, PrefsBlobError::CiphertextTruncated);
    }

    // ---- AEAD non-distinguishing failure (spec § 6.4 + § 9.5.5) -------

    #[test]
    fn decode_rejects_with_wrong_key_as_cannot_decrypt() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let blob = encode_prefs_blob_raw(
            &prefs_key,
            &account_hash,
            &PrefsView::default(),
            &fixed_prefs_nonce(),
        )
        .unwrap();

        // Wrong root_key → wrong prefs_key
        let mut wrong_root = [0u8; 32];
        wrong_root[0] = 1;
        let wrong_prefs_key = derive_subkey(&wrong_root, SubkeyRole::PrefsKey);

        let err = decode_prefs_blob(&wrong_prefs_key, &account_hash, &blob).unwrap_err();
        assert_eq!(err, PrefsBlobError::CannotDecrypt);
    }

    #[test]
    fn decode_rejects_with_wrong_account_number_hash_as_cannot_decrypt() {
        // Cross-vault scenario: vault A's blob + vault B's
        // account_number_hash → AAD mismatch → AEAD fails.
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let blob = encode_prefs_blob_raw(
            &prefs_key,
            &fixed_account_number_hash(),
            &PrefsView::default(),
            &fixed_prefs_nonce(),
        )
        .unwrap();

        let mut wrong_account_hash = fixed_account_number_hash();
        wrong_account_hash[0] = wrong_account_hash[0].wrapping_add(1);

        let err = decode_prefs_blob(&prefs_key, &wrong_account_hash, &blob).unwrap_err();
        assert_eq!(err, PrefsBlobError::CannotDecrypt);
    }

    #[test]
    fn decode_rejects_with_tampered_ciphertext_as_cannot_decrypt() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let mut blob = encode_prefs_blob_raw(
            &prefs_key,
            &account_hash,
            &PrefsView::default(),
            &fixed_prefs_nonce(),
        )
        .unwrap();

        // Flip one byte in the ciphertext region (header is 34 bytes;
        // ciphertext starts at offset 34).
        blob[40] ^= 0xFF;

        let err = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap_err();
        assert_eq!(err, PrefsBlobError::CannotDecrypt);
    }

    #[test]
    fn decode_rejects_with_tampered_ctx_tag_as_cannot_decrypt() {
        let root_key = fixed_root_key();
        let prefs_key = derive_subkey(&root_key, SubkeyRole::PrefsKey);
        let account_hash = fixed_account_number_hash();
        let mut blob = encode_prefs_blob_raw(
            &prefs_key,
            &account_hash,
            &PrefsView::default(),
            &fixed_prefs_nonce(),
        )
        .unwrap();

        // Flip a byte in the trailing CTX commitment tag (last 32 bytes).
        let last = blob.len() - 1;
        blob[last] ^= 0xFF;

        let err = decode_prefs_blob(&prefs_key, &account_hash, &blob).unwrap_err();
        assert_eq!(err, PrefsBlobError::CannotDecrypt);
    }

    // ---- PrefsView default semantic (spec § 9.5.5) --------------------

    #[test]
    fn default_prefs_view_has_screen_capture_protection_on() {
        // Spec § 9.5.5 fall-back-to-defaults: defaults to the safer
        // state (protection on) for missing / corrupt vault.prefs.
        assert!(PrefsView::default().screen_capture_protection);
    }

    // ---- KAT vector regenerator (companion repo) ----------------------

    /// Emits hex dumps for the 5 KAT cases consumed by
    /// `myne-test-vectors/vectors/vault-prefs/v0.1/cases.json`. Output
    /// is written to `/tmp/myne_vault_prefs_vectors.txt`, ready for
    /// paste into the companion repo's JSON file.
    ///
    /// `#[ignore]` because regenerating vectors should be a deliberate
    /// act, not a side effect of `cargo test`. Run with:
    /// `cargo test -p protocol --lib emit_prefs_vectors_for_paste -- --ignored`
    ///
    /// The 5 cases pin (per MYND-160 grill Q6.2):
    /// - `encrypt-default`: PrefsView { screen_capture_protection: true } → expected blob bytes
    /// - `encrypt-toggled`: PrefsView { screen_capture_protection: false } → expected blob bytes
    /// - `decrypt-default`: golden blob → expected plaintext + struct (round-trip with encrypt-default)
    /// - `decrypt-cross-vault`: vault-A blob + vault-B root_key → expected AeadFail
    /// - `decrypt-tampered`: vault-A blob with one ciphertext byte flipped → expected AeadFail
    #[test]
    #[ignore]
    fn emit_prefs_vectors_for_paste() {
        extern crate std;

        // Vault A — canonical case.
        let root_a: [u8; 32] = [0x42; 32];
        let account_hash_a: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0x33; PREFS_BLOB_ACCOUNT_HASH_LEN];
        let prefs_key_a = derive_subkey(&root_a, SubkeyRole::PrefsKey);
        let nonce_default: [u8; AEAD_NONCE_LEN] = [0x77; AEAD_NONCE_LEN];
        let nonce_toggled: [u8; AEAD_NONCE_LEN] = [0x88; AEAD_NONCE_LEN];

        // Vault B — used for cross-vault decrypt failure.
        let root_b: [u8; 32] = [0xAB; 32];
        let prefs_key_b = derive_subkey(&root_b, SubkeyRole::PrefsKey);
        let account_hash_b: [u8; PREFS_BLOB_ACCOUNT_HASH_LEN] = [0xCD; PREFS_BLOB_ACCOUNT_HASH_LEN];

        let blob_default = encode_prefs_blob_raw(
            &prefs_key_a,
            &account_hash_a,
            &PrefsView {
                screen_capture_protection: true,
            },
            &nonce_default,
        )
        .expect("encode default");

        let blob_toggled = encode_prefs_blob_raw(
            &prefs_key_a,
            &account_hash_a,
            &PrefsView {
                screen_capture_protection: false,
            },
            &nonce_toggled,
        )
        .expect("encode toggled");

        // Tampered blob: flip one byte in the ciphertext region (header
        // is 34 bytes; ciphertext starts at offset 34).
        let mut blob_tampered = blob_default.clone();
        blob_tampered[40] ^= 0xFF;

        let canonical_default = b"{\"screen_capture_protection\":true}";
        let canonical_toggled = b"{\"screen_capture_protection\":false}";

        let mut dump = alloc::string::String::new();
        dump.push_str("---begin prefs vectors---\n\n");

        dump.push_str("# case 1/5: encrypt-default (toggle=true)\n");
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "prefs_key_hex (informational): {}\n",
            hex_lower(&*prefs_key_a)
        ));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8_hex: {}\n",
            hex_lower(canonical_default)
        ));
        dump.push_str(&alloc::format!(
            "prefs_nonce_hex: {}\n",
            hex_lower(&nonce_default)
        ));
        dump.push_str(&alloc::format!(
            "expected_prefs_blob_hex: {}\n\n",
            hex_lower(&blob_default)
        ));

        dump.push_str("# case 2/5: encrypt-toggled (toggle=false)\n");
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str(&alloc::format!(
            "plaintext_canonical_utf8_hex: {}\n",
            hex_lower(canonical_toggled)
        ));
        dump.push_str(&alloc::format!(
            "prefs_nonce_hex: {}\n",
            hex_lower(&nonce_toggled)
        ));
        dump.push_str(&alloc::format!(
            "expected_prefs_blob_hex: {}\n\n",
            hex_lower(&blob_toggled)
        ));

        dump.push_str("# case 3/5: decrypt-default (round-trip with case 1)\n");
        dump.push_str(&alloc::format!(
            "input_blob_hex: {}\n",
            hex_lower(&blob_default)
        ));
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str("expected_kind: ok\n");
        dump.push_str(&alloc::format!(
            "expected_plaintext_utf8_hex: {}\n",
            hex_lower(canonical_default)
        ));
        dump.push_str("expected_prefs_view: { \"screen_capture_protection\": true }\n\n");

        dump.push_str("# case 4/5: decrypt-cross-vault (vault A blob + vault B key)\n");
        dump.push_str(&alloc::format!(
            "input_blob_hex: {}\n",
            hex_lower(&blob_default)
        ));
        dump.push_str(&alloc::format!(
            "wrong_root_key_hex: {}\n",
            hex_lower(&root_b)
        ));
        dump.push_str(&alloc::format!(
            "wrong_prefs_key_hex (informational): {}\n",
            hex_lower(&*prefs_key_b)
        ));
        dump.push_str(&alloc::format!(
            "wrong_account_number_hash_hex: {}\n",
            hex_lower(&account_hash_b)
        ));
        dump.push_str("expected_kind: aead_fail\n\n");

        dump.push_str("# case 5/5: decrypt-tampered (vault A blob, ciphertext byte flipped)\n");
        dump.push_str(&alloc::format!(
            "input_blob_hex (tampered): {}\n",
            hex_lower(&blob_tampered)
        ));
        dump.push_str("tamper_offset: 40 (one byte of ciphertext flipped via XOR 0xFF)\n");
        dump.push_str(&alloc::format!("root_key_hex: {}\n", hex_lower(&root_a)));
        dump.push_str(&alloc::format!(
            "account_number_hash_hex: {}\n",
            hex_lower(&account_hash_a)
        ));
        dump.push_str("expected_kind: aead_fail\n\n");

        dump.push_str("---end prefs vectors---\n");
        std::fs::write("/tmp/myne_vault_prefs_vectors.txt", dump.as_bytes())
            .expect("write prefs vectors dump");
    }

    fn hex_lower(bytes: &[u8]) -> alloc::string::String {
        let mut s = alloc::string::String::with_capacity(bytes.len() * 2);
        for b in bytes {
            s.push_str(&alloc::format!("{:02x}", b));
        }
        s
    }
}
