//! BIP-39 24-word recovery phrase — see `docs/spec/protocol.md` § 7.
//!
//! 256 bits of CSPRNG entropy + an 8-bit BIP-39 checksum encode to 24
//! English BIP-39 words. Myne uses BIP-39 only as an *encoding* — the
//! standard PBKDF2-HMAC-SHA512-2048 seed derivation is **not** invoked
//! (spec § 7.1). The phrase string is fed directly to Argon2id during
//! recovery wrap-key derivation (§ 3.1).
//!
//! ## Library choice
//!
//! This module uses `bip39` (rust-bitcoin), version `^2`. Considered
//! alternative was `tiny-bip39` (Parity-fork). Rationale for `bip39`:
//!
//! - **Maintenance + ecosystem**: rust-bitcoin's `bip39` is the canonical
//!   crate that downstream Bitcoin / Lightning / wallet software depends
//!   on; releases are frequent, audit attention is implicit.
//! - **`no_std + alloc` first-class**: the crate compiles cleanly with
//!   `default-features = false, features = ["alloc"]`. `tiny-bip39` is
//!   `std`-only.
//! - **API**: `Mnemonic::from_entropy`, `Mnemonic::words`,
//!   `Mnemonic::to_entropy_array`, and `Mnemonic::parse_in_normalized`
//!   give us byte-level entropy round-tripping plus user-input parsing
//!   without writing our own wordlist lookup.
//!
//! Audit anchor: `bip39` is widely deployed in Bitcoin / Lightning /
//! wallet software; the BIP-39 algorithm itself is a 2013 spec with
//! 12+ years of production use across the ecosystem.
//!
//! ## What this module does *not* do
//!
//! - It does not parse user-typed phrases. That requires NFKD
//!   normalization + whitespace coalescing per `protocol.md` § 7.4 and
//!   lives in the recovery-flow code path (Task 9). `join_normalized`
//!   here returns the spec § 7.4 form for a phrase Myne *generated*
//!   (which is already ASCII lowercase via the BIP-39 wordlist), not
//!   for arbitrary user input.
//! - It does not invoke BIP-39 PBKDF2. Argon2id wrap-key derivation
//!   (Task 9) consumes the phrase text directly per spec § 7.1.

use crate::error::ProtocolError;
use alloc::string::{String, ToString};
use bip39::Mnemonic;
use zeroize::Zeroizing;

/// Number of BIP-39 words in a Myne recovery phrase (256-bit entropy).
pub const RECOVERY_PHRASE_WORD_COUNT: usize = 24;

/// Number of CSPRNG entropy bytes consumed per phrase.
pub const RECOVERY_PHRASE_ENTROPY_BYTES: usize = 32;

/// 24-word BIP-39 English recovery phrase (`docs/spec/protocol.md` § 7).
///
/// Wraps `Zeroizing<[String; 24]>` so the inner word buffers are
/// best-effort wiped on drop (the `zeroize` `alloc` feature provides
/// `String: Zeroize`, which overwrites the heap bytes and resets the
/// length, though the original allocation slot may still be reachable
/// via the allocator's free-list).
///
/// `Debug` is intentionally redacted — accidentally logging a
/// `RecoveryPhrase` must never spill the words into stdout, journals,
/// or crash reports.
pub struct RecoveryPhrase(Zeroizing<[String; RECOVERY_PHRASE_WORD_COUNT]>);

impl core::fmt::Debug for RecoveryPhrase {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str("RecoveryPhrase([REDACTED 24 BIP-39 words])")
    }
}

impl PartialEq for RecoveryPhrase {
    fn eq(&self, other: &Self) -> bool {
        let a: &[String; RECOVERY_PHRASE_WORD_COUNT] = &self.0;
        let b: &[String; RECOVERY_PHRASE_WORD_COUNT] = &other.0;
        a == b
    }
}

impl Eq for RecoveryPhrase {}

impl RecoveryPhrase {
    /// Borrow the underlying 24-word array. The reference itself is
    /// `&[String; 24]`; callers must not clone the words into a
    /// non-zeroizing buffer.
    pub fn words(&self) -> &[String; RECOVERY_PHRASE_WORD_COUNT] {
        &self.0
    }

    /// Return the spec § 7.4 `phrase_normalized` form for this
    /// phrase: 24 words joined by single ASCII spaces, ASCII
    /// lowercase, no surrounding whitespace.
    ///
    /// Because the words come from the BIP-39 English wordlist (which
    /// is already ASCII lowercase), no NFKD pass is needed here —
    /// NFKD only matters when normalizing **user-typed** input during
    /// recovery, which is a separate code path (Task 9, recovery
    /// flow).
    pub fn join_normalized(&self) -> Zeroizing<String> {
        // 24 words × ~7 chars + 23 spaces ≈ 200 bytes; pre-allocate.
        let mut out = String::with_capacity(RECOVERY_PHRASE_WORD_COUNT * 9);
        for (i, word) in self.0.iter().enumerate() {
            if i > 0 {
                out.push(' ');
            }
            out.push_str(word);
        }
        Zeroizing::new(out)
    }
}

/// Generate a fresh 24-word recovery phrase from the OS CSPRNG.
///
/// Implements `protocol.md` § 7.2:
/// 1. 32 bytes from `getrandom` (256 bits of entropy).
/// 2. BIP-39 encode (entropy + 8-bit checksum → 24 words).
/// 3. Wrap into [`RecoveryPhrase`] for zeroize-on-drop semantics.
///
/// Returns `ProtocolError::Csprng` if the OS CSPRNG fails. A failure
/// from `Mnemonic::from_entropy` after a successful CSPRNG read is a
/// crate bug (32 bytes is a valid BIP-39 entropy length); we treat it
/// as `Csprng` to avoid leaking implementation detail.
pub fn generate_recovery_phrase() -> Result<RecoveryPhrase, ProtocolError> {
    let mut entropy = Zeroizing::new([0u8; RECOVERY_PHRASE_ENTROPY_BYTES]);
    getrandom::getrandom(entropy.as_mut_slice()).map_err(|_| ProtocolError::Csprng)?;

    let mnemonic = Mnemonic::from_entropy(entropy.as_slice()).map_err(|_| ProtocolError::Csprng)?;

    Ok(RecoveryPhrase(Zeroizing::new(collect_words(&mnemonic)?)))
}

/// Build a [`RecoveryPhrase`] from a fixed entropy buffer. Test-only
/// helper exposed `pub(crate)` so other modules' test suites can
/// construct deterministic phrases without round-tripping through
/// `getrandom`. Absent from production builds.
#[cfg(test)]
pub(crate) fn recovery_phrase_from_fixed_entropy_for_test(
    entropy: &[u8; RECOVERY_PHRASE_ENTROPY_BYTES],
) -> RecoveryPhrase {
    let mnemonic = Mnemonic::from_entropy(entropy).expect("32 bytes is valid entropy");
    RecoveryPhrase(Zeroizing::new(
        collect_words(&mnemonic).expect("24 words from 32 bytes"),
    ))
}

/// Collect the mnemonic's 24 words into a fixed-size array of owned
/// `String`s (so they are heap-allocated and individually zeroizable).
///
/// `bip39::Mnemonic::words` yields `&'static str` slices into the
/// BIP-39 wordlist; we copy because the wordlist itself sits in
/// read-only memory and cannot be wiped — but the user's *copy* of
/// each chosen word should be wipeable when the phrase drops.
fn collect_words(
    mnemonic: &Mnemonic,
) -> Result<[String; RECOVERY_PHRASE_WORD_COUNT], ProtocolError> {
    let mut words: [String; RECOVERY_PHRASE_WORD_COUNT] = core::array::from_fn(|_| String::new());
    let mut iter = mnemonic.words();
    for slot in words.iter_mut() {
        let word = iter.next().ok_or(ProtocolError::Csprng)?;
        *slot = word.to_string();
    }
    if iter.next().is_some() {
        // `Mnemonic` produced more than 24 words for 32-byte entropy —
        // a `bip39` invariant violation, treat defensively.
        return Err(ProtocolError::Csprng);
    }
    Ok(words)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bip39::{Language, Mnemonic};

    /// Fixed 32-byte entropy used by round-trip tests so they don't
    /// depend on `getrandom`. Hex literal of `[0u8; 32]` would be too
    /// degenerate; use a known but non-trivial pattern.
    const FIXED_ENTROPY: [u8; RECOVERY_PHRASE_ENTROPY_BYTES] = [
        0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB, 0xCC, 0xDD, 0xEE,
        0xFF, 0x10, 0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87, 0x98, 0xA9, 0xBA, 0xCB, 0xDC, 0xED,
        0xFE, 0x0F,
    ];

    /// Helper: build a `RecoveryPhrase` from a fixed entropy without
    /// touching `getrandom`, for deterministic test cases.
    fn phrase_from_fixed_entropy() -> RecoveryPhrase {
        let mnemonic = Mnemonic::from_entropy(&FIXED_ENTROPY).expect("32 bytes is valid entropy");
        RecoveryPhrase(Zeroizing::new(
            collect_words(&mnemonic).expect("24 words from 32 bytes"),
        ))
    }

    #[test]
    fn generated_phrase_has_exactly_24_words() {
        let phrase = generate_recovery_phrase().expect("getrandom available");
        assert_eq!(phrase.words().len(), RECOVERY_PHRASE_WORD_COUNT);
    }

    #[test]
    fn generated_words_all_in_canonical_english_wordlist() {
        // bip39's `parse_in` validates against the English wordlist; if
        // any generated word is not in the canonical list, parse fails.
        let phrase = generate_recovery_phrase().expect("getrandom available");
        let joined = phrase.join_normalized();
        Mnemonic::parse_in(Language::English, joined.as_str())
            .expect("generated phrase must parse against canonical English wordlist");
    }

    #[test]
    fn entropy_round_trip_fixed_input() {
        // 32-byte entropy → 24-word phrase → parse back → 32-byte
        // entropy. Verifies our wrapper does not corrupt BIP-39's
        // bijection between entropy and word indices.
        //
        // `bip39::Mnemonic::to_entropy_array` returns a `([u8; 33], usize)`
        // pair — buffer is sized for the longest BIP-39 entropy, with
        // the actual length carried separately. For a 24-word mnemonic
        // we expect `len == 32`; slice the buffer accordingly.
        let phrase = phrase_from_fixed_entropy();
        let joined = phrase.join_normalized();
        let recovered =
            Mnemonic::parse_in(Language::English, joined.as_str()).expect("phrase round-trips");
        let (buf, len) = recovered.to_entropy_array();
        assert_eq!(len, RECOVERY_PHRASE_ENTROPY_BYTES);
        let recovered_entropy: [u8; RECOVERY_PHRASE_ENTROPY_BYTES] = buf
            [..RECOVERY_PHRASE_ENTROPY_BYTES]
            .try_into()
            .expect("len == 32");
        assert_eq!(recovered_entropy, FIXED_ENTROPY);
    }

    #[test]
    fn join_normalized_is_single_space_joined() {
        let phrase = phrase_from_fixed_entropy();
        let joined = phrase.join_normalized();
        let parts: alloc::vec::Vec<&str> = joined.split(' ').collect();
        assert_eq!(parts.len(), RECOVERY_PHRASE_WORD_COUNT);
        // No empty parts ⇒ no double-spaces.
        for p in &parts {
            assert!(!p.is_empty(), "double-space detected in join_normalized");
        }
        // No leading or trailing whitespace.
        assert!(!joined.starts_with(' '));
        assert!(!joined.ends_with(' '));
    }

    #[test]
    fn join_normalized_is_ascii_lowercase() {
        // BIP-39 English wordlist is ASCII lowercase, so the joined
        // form matches its own ASCII-lowercase. Spec § 7.4 mandates
        // lowercase normalization for *user input*; for generated
        // phrases the property holds by construction.
        let phrase = phrase_from_fixed_entropy();
        let joined = phrase.join_normalized();
        assert!(joined.is_ascii());
        // make_ascii_lowercase on a copy must not change anything.
        let mut copy = joined.clone();
        copy.make_ascii_lowercase();
        assert_eq!(joined.as_str(), copy.as_str());
    }

    #[test]
    fn debug_redacts_phrase_contents() {
        // Catastrophic regression guard: `format!("{:?}", phrase)` must
        // never include any BIP-39 word, even partially.
        let phrase = phrase_from_fixed_entropy();
        let debug = alloc::format!("{:?}", phrase);
        assert!(debug.contains("REDACTED"), "Debug output: {debug:?}");
        // Spot-check: the first BIP-39 word from FIXED_ENTROPY is not
        // in the debug output (we avoid hardcoding it but iterate).
        for word in phrase.words().iter() {
            assert!(!debug.contains(word.as_str()), "Debug leaked word `{word}`");
        }
    }

    #[test]
    fn partial_eq_compares_word_arrays() {
        let a = phrase_from_fixed_entropy();
        let b = phrase_from_fixed_entropy();
        assert_eq!(a, b);
    }

    #[test]
    fn different_entropy_produces_different_phrase() {
        // Sanity: changing one byte of entropy changes the word list.
        let mnemonic_a = Mnemonic::from_entropy(&FIXED_ENTROPY).unwrap();
        let mut alt = FIXED_ENTROPY;
        alt[0] ^= 0x01;
        let mnemonic_b = Mnemonic::from_entropy(&alt).unwrap();
        let phrase_a = RecoveryPhrase(Zeroizing::new(collect_words(&mnemonic_a).unwrap()));
        let phrase_b = RecoveryPhrase(Zeroizing::new(collect_words(&mnemonic_b).unwrap()));
        assert_ne!(phrase_a, phrase_b);
    }

    #[test]
    fn entropy_bytes_constant_is_thirty_two() {
        // 256 bits → 32 bytes. Anyone editing this constant must also
        // recheck BIP-39 word count (24 ↔ 32 bytes).
        assert_eq!(RECOVERY_PHRASE_ENTROPY_BYTES, 32);
        assert_eq!(RECOVERY_PHRASE_WORD_COUNT, 24);
    }
}
