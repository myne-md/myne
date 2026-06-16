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
use unicode_normalization::UnicodeNormalization;
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

/// Normalize user-typed recovery phrase per `protocol.md` § 7.4.
///
/// Pipeline (single pass over the NFKD char stream):
/// 1. **NFKD** compatibility decomposition — folds full-width digits
///    (`０`–`９`), full-width Latin letters (`Ａ`–`Ｚ`), no-break space
///    (U+00A0), ideographic space (U+3000), ligatures like `ﬁ`, etc.
/// 2. **ASCII lowercase** — BIP-39 English wordlist is lowercase, so
///    user-typed uppercase or mixed-case input must lowercase to
///    match. ASCII-only is sufficient (the wordlist contains no
///    Unicode-uppercase-sensitive characters).
/// 3. **Trim** leading and trailing Unicode whitespace.
/// 4. **Whitespace coalesce** — runs of one or more Unicode whitespace
///    characters between tokens become a single ASCII space U+0020.
///
/// Returns the canonical bytes wrapped in [`Zeroizing<String>`] so the
/// bytes wipe on drop. The output is the `phrase_normalized` form fed
/// directly into Argon2id during recovery (`protocol.md` § 3.1).
///
/// Does **not** validate against the BIP-39 wordlist — invalid input
/// produces a normalized string that fails AEAD-tag verification at the
/// `recovery_wrap` unwrap stage; the caller surfaces a single non-
/// distinguishing error per `recovery-flow.md` § 3.4 ("Phrase or vault
/// is invalid — please retry."). This is the single-pass cousin of
/// [`RecoveryPhrase::join_normalized`], which canonicalizes a phrase
/// Myne *generated* (already ASCII lowercase, no NFKD pass needed).
pub fn normalize_user_phrase(input: &str) -> Zeroizing<String> {
    // Pre-allocate against input byte length. NFKD can expand chars
    // (e.g. ﬁ → "fi" doubles), but the realistic 24-word phrase case
    // does not stress this; a small reallocation under expansion is
    // acceptable cost for the common-path zero-realloc path.
    let mut out = String::with_capacity(input.len());
    let mut prev_was_whitespace = false;
    let mut have_emitted_token = false;

    for c in input.nfkd() {
        let c = c.to_ascii_lowercase();
        if c.is_whitespace() {
            prev_was_whitespace = true;
        } else {
            if prev_was_whitespace && have_emitted_token {
                out.push(' ');
            }
            out.push(c);
            have_emitted_token = true;
            prev_was_whitespace = false;
        }
    }

    Zeroizing::new(out)
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
#[cfg_attr(coverage_nightly, coverage(off))]
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

    // ---- normalize_user_phrase (spec § 7.4) ----------------------------
    //
    // NFKD + ASCII lowercase + trim + whitespace-coalesce. Used by the
    // recovery flow's `vault_recover_with_phrase` Tauri command before
    // Argon2id consumes the bytes. The function does NOT validate against
    // the BIP-39 wordlist — that is intentional per `recovery-flow.md`
    // §3.2 (no per-cell wordlist-membership feedback).

    #[test]
    fn normalize_identity_on_canonical_phrase() {
        // A 24-word ASCII single-space-joined phrase from the BIP-39
        // wordlist must pass through unchanged.
        let canonical = "abandon abandon abandon abandon abandon abandon \
                         abandon abandon abandon abandon abandon abandon \
                         abandon abandon abandon abandon abandon abandon \
                         abandon abandon abandon abandon abandon art";
        let normalized = normalize_user_phrase(canonical);
        assert_eq!(normalized.as_str(), canonical);
    }

    #[test]
    fn normalize_folds_fullwidth_digits() {
        // U+FF10..U+FF19 (full-width digits ０..９) NFKD-decompose to
        // ASCII 0..9.
        let normalized = normalize_user_phrase("abc \u{FF10}\u{FF11}\u{FF12} def");
        assert_eq!(normalized.as_str(), "abc 012 def");
    }

    #[test]
    fn normalize_folds_no_break_space_to_ascii_space() {
        // U+00A0 (NO-BREAK SPACE) NFKD-decomposes to ASCII U+0020.
        // Common in word-processor / password-manager copies.
        let normalized = normalize_user_phrase("abc\u{00A0}def");
        assert_eq!(normalized.as_str(), "abc def");
    }

    #[test]
    fn normalize_folds_ligature_fi_to_two_chars() {
        // U+FB01 (ﬁ ligature) NFKD-decomposes to "fi" (two ASCII chars).
        // Output length differs from input byte length — implementation
        // must allocate against the post-NFKD char stream, not bytes.
        let normalized = normalize_user_phrase("of\u{FB01}cer");
        assert_eq!(normalized.as_str(), "officer");
    }

    #[test]
    fn normalize_lowercases_uppercase_ascii() {
        // BIP-39 English wordlist is lowercase; uppercase input must
        // lowercase. ASCII-only lowercase is sufficient (the wordlist
        // contains no Unicode-uppercase-sensitive characters).
        let normalized = normalize_user_phrase("ABC DEF");
        assert_eq!(normalized.as_str(), "abc def");
    }

    #[test]
    fn normalize_collapses_multiple_whitespace_runs() {
        // Runs of one or more whitespace characters between tokens
        // collapse to a single ASCII space U+0020.
        let normalized = normalize_user_phrase("abc    def\t\tghi");
        assert_eq!(normalized.as_str(), "abc def ghi");
    }

    #[test]
    fn normalize_trims_leading_and_trailing_whitespace() {
        let normalized = normalize_user_phrase("   abc def   ");
        assert_eq!(normalized.as_str(), "abc def");
    }

    #[test]
    fn normalize_combines_all_steps_in_realistic_paste() {
        // Realistic password-manager paste: leading/trailing space,
        // full-width letter mixed with ASCII, U+00A0 between words,
        // mixed case, multiple ASCII spaces.
        // Pipeline: NFKD folds Ａ → A and U+00A0 → space; lowercase
        // folds A → a; trim removes leading/trailing; coalesce collapses
        // multi-space.
        let raw = "  ABC\u{FF21}\u{00A0}\u{00A0}defＢ  ";
        let normalized = normalize_user_phrase(raw);
        assert_eq!(normalized.as_str(), "abca defb");
    }

    #[test]
    fn normalize_empty_input_yields_empty_output() {
        let normalized = normalize_user_phrase("");
        assert_eq!(normalized.as_str(), "");
    }

    #[test]
    fn normalize_whitespace_only_input_yields_empty_output() {
        // Pure whitespace input has no tokens to emit; output is empty.
        let normalized = normalize_user_phrase("   \t\n\u{00A0}  ");
        assert_eq!(normalized.as_str(), "");
    }

    #[test]
    fn normalize_returns_zeroizing_string() {
        // Compile-time shape check: the output must be `Zeroizing<String>`
        // so the bytes wipe on drop. This test would fail to type-check
        // if the signature drifted to a bare `String`.
        let _zero: Zeroizing<String> = normalize_user_phrase("test");
    }
}
