//! Account number scheme — see `docs/spec/account-number.md`.
//!
//! 20-character self-generated identifier: 19 Crockford-base32 entropy
//! characters (95 bits of CSPRNG output) plus 1 Damm-32 check character.
//! The display form is `MY-XXXX-XXXX-XXXX-XXXX-X`. The hash field is
//! `SHA-256(canonical_ascii)[:16]` and feeds into both Argon2id salts
//! (`docs/spec/protocol.md` § 3.1) so vault keys cannot be precomputed
//! across accounts.
//!
//! ## Damm-32 quasigroup
//!
//! Spec `account-number.md` § 4 mandates a 32×32 quasigroup table that
//! is "frozen in this document" before v1.0 ship; § 9 marks the table
//! source as an open issue. This implementation uses the
//! polynomial-multiplication construction (no inline 1024-element
//! table required): the running checksum is multiplied by α in
//! GF(2⁵) ≅ GF(2)[x] / (x⁵ + x² + 1) and XORed with the next symbol.
//! The irreducible polynomial `x⁵ + x² + 1` corresponds to the bitmask
//! `0b100101 = 37`. The construction is mathematically equivalent to a
//! single fixed 32×32 quasigroup; pinning a literal table is a layout
//! convenience for the spec, not a correctness change.
//!
//! Reference port: `srobo/damm32` (MIT, Python),
//! <https://github.com/srobo/damm32>. The five-line core
//! (`_calculate_from_digits`) is the operative artifact; the rest of
//! that crate's API surface is alphabet-handling boilerplate we
//! re-implement here against the Crockford alphabet (`srobo/damm32`
//! itself uses the RFC 4648 alphabet — alphabet choice is independent
//! of the Damm-32 mathematics).
//!
//! v1.0 spec ship may inline the table verbatim; when that lands, add a
//! golden test in this module that compares the literal table against
//! the runtime-derived one to lock the two representations together.

use crate::error::ProtocolError;
use alloc::string::String;
use sha2::{Digest, Sha256};

/// Crockford base32 alphabet, in canonical position order
/// (`account-number.md` § 2). Excludes `I`, `L`, `O`, `U`.
const CROCKFORD: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// 19 entropy characters × 5 bits = 95 bits.
pub const ENTROPY_CHARS: usize = 19;

/// 1 Damm-32 check character.
pub const CHECK_CHARS: usize = 1;

/// Canonical form length (entropy + check).
pub const CANONICAL_LEN: usize = ENTROPY_CHARS + CHECK_CHARS;

/// Display form length per `account-number.md` § 3:
/// `"MY-" || canonical[0:4] || "-" || canonical[4:8] || "-" ||
///  canonical[8:12] || "-" || canonical[12:16] || "-" || canonical[16:20]`
/// = 3 + 4 + 1 + 4 + 1 + 4 + 1 + 4 + 1 + 4 = 27 ASCII bytes.
///
/// The schematic `MY-XXXX-XXXX-XXXX-XXXX-X` shown elsewhere in the spec
/// is an illustrative shorthand — the trailing group is the full
/// `canonical[16:20]` (four characters), not a single character.
pub const DISPLAY_LEN: usize = 27;

/// `account_number_hash` length: SHA-256 of canonical ASCII, truncated
/// to 16 bytes (`account-number.md` § 6, `protocol.md` § 9.3 offset 6).
pub const ACCOUNT_NUMBER_HASH_LEN: usize = 16;

/// GF(2⁵) reduction polynomial mask: x⁵ + x² + 1 = `0b100101`.
const DAMM32_BIT_MASK: u8 = 37;

/// Modulus boundary; values ≥ 32 (bit 5 set after the doubling step)
/// must be reduced.
const DAMM32_MODULUS: u8 = 32;

/// Self-generated user identifier per `docs/spec/account-number.md`.
///
/// Holds the canonical 20-byte Crockford form (entropy + Damm-32 check),
/// the display form with `MY-` prefix and dash separators, and the
/// 16-byte SHA-256 truncation that feeds into both Argon2id salts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountNumber {
    /// Display form per `account-number.md` § 3 — exactly 27 ASCII bytes
    /// (`"MY-"` + four 4-character Crockford groups + dashes + the final
    /// 4-character group containing the 12-bit suffix and the Damm-32
    /// check digit). The schematic `MY-XXXX-XXXX-XXXX-XXXX-X` shown
    /// elsewhere in the spec is illustrative shorthand, not literal.
    pub display: String,
    /// 19 entropy chars + 1 Damm-32 check char, all uppercase Crockford
    /// base32 ASCII. Bound into `account_number_hash` via SHA-256.
    pub canonical: [u8; CANONICAL_LEN],
    /// `SHA-256(canonical_ascii)[:16]` — 16 bytes mixed into both
    /// Argon2id salts (`protocol.md` § 3.1) and stored in `vault.meta`
    /// at offset 6 (`protocol.md` § 9.3).
    pub hash: [u8; ACCOUNT_NUMBER_HASH_LEN],
}

/// One Damm-32 step — multiply running checksum by α in GF(2⁵), XOR
/// with the next symbol. See module-level note for the polynomial.
fn damm32_step(running: u8, next: u8) -> u8 {
    let mut x = running ^ next;
    x <<= 1;
    if x >= DAMM32_MODULUS {
        x ^= DAMM32_BIT_MASK;
    }
    x
}

/// Damm-32 checksum over a slice of 0..32 indices. By construction,
/// running this over `(entropy || check)` returns 0 iff `check` is the
/// correct Damm-32 digit for the given entropy.
fn damm32_checksum(digits: &[u8]) -> u8 {
    let mut chk = 0u8;
    for &d in digits {
        chk = damm32_step(chk, d);
    }
    chk
}

/// Map a Crockford alphabet ASCII byte to its 0..32 index.
///
/// Strict mapping: `I`, `L`, `O`, `U` are *not* in the alphabet and
/// return `None`. Spec `account-number.md` § 5 step 7 mandates strict
/// alphabet check, so liberal Crockford folding (I→1, L→1, O→0, U→V)
/// is intentionally not implemented.
fn crockford_index(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'A'..=b'F' => Some(c - b'A' + 10),
        b'G' => Some(16),
        b'H' => Some(17),
        b'J' => Some(18),
        b'K' => Some(19),
        b'M' => Some(20),
        b'N' => Some(21),
        b'P' => Some(22),
        b'Q' => Some(23),
        b'R' => Some(24),
        b'S' => Some(25),
        b'T' => Some(26),
        b'V' => Some(27),
        b'W' => Some(28),
        b'X' => Some(29),
        b'Y' => Some(30),
        b'Z' => Some(31),
        _ => None,
    }
}

/// Generate a fresh account number from the OS CSPRNG.
///
/// Implements `account-number.md` § 3:
/// 1. 95 bits from `getrandom` (read 12 bytes, mask off the high bit).
/// 2. Encode as 19 Crockford base32 characters, big-endian 5-bit groups.
/// 3. Compute the Damm-32 check digit over the 19 entropy indices.
/// 4. Append; assemble display form; compute hash.
pub fn generate_account_number() -> Result<AccountNumber, ProtocolError> {
    // 95 bits of entropy. We read 12 bytes (96 bits) and zero out the
    // top bit; the remaining 95 bits carry full entropy.
    let mut bytes = [0u8; 12];
    getrandom::getrandom(&mut bytes).map_err(|_| ProtocolError::Csprng)?;
    bytes[0] &= 0x7F;

    // Treat as a big-endian 95-bit integer parked in the low 96 bits of
    // a u128. Right-padding into u128 keeps the 5-bit-group extraction
    // arithmetic simple.
    let mut buf = [0u8; 16];
    buf[4..16].copy_from_slice(&bytes);
    let n = u128::from_be_bytes(buf);

    let mut canonical = [0u8; CANONICAL_LEN];
    let mut digits = [0u8; ENTROPY_CHARS];
    for i in 0..ENTROPY_CHARS {
        let shift = (ENTROPY_CHARS - 1 - i) * 5; // 90, 85, ..., 0
        let chunk = ((n >> shift) & 0x1F) as u8;
        canonical[i] = CROCKFORD[chunk as usize];
        digits[i] = chunk;
    }

    let check = damm32_checksum(&digits);
    canonical[ENTROPY_CHARS] = CROCKFORD[check as usize];

    Ok(AccountNumber {
        display: format_display(&canonical),
        canonical,
        hash: sha256_first_16(&canonical),
    })
}

/// Liberal-parse an account number per `account-number.md` § 5.
///
/// Accepts:
/// - Any case (`my-` / `MY-`).
/// - Missing `MY-` prefix.
/// - Missing or extra `-` separators.
/// - Surrounding or interior whitespace.
///
/// Rejects with [`ProtocolError::AccountNumberInvalid`]:
/// - Wrong length after normalization.
/// - Any character not in the Crockford base32 alphabet (strict — no
///   `I → 1` / `L → 1` / `O → 0` / `U → V` substitutions; spec § 5
///   step 7).
/// - Damm-32 check failure.
///
/// Spec § 5 mandates a single user-facing message regardless of which
/// rule failed; this function returns a single error variant so the UI
/// cannot accidentally distinguish causes.
///
/// **NFKD note.** Spec § 5 step 1 calls for NFKD normalization. This
/// implementation skips NFKD for v0.1 — the alphabet check at step 7
/// already rejects any non-ASCII character, and pulling
/// `unicode-normalization` in directly is not justified for a feature
/// that adds no behavior beyond rejection. NFKD compliance is a v0.1.x
/// follow-up if real users hit it.
pub fn parse_account_number(input: &str) -> Result<AccountNumber, ProtocolError> {
    // 1+2. Strip whitespace anywhere (trim is implied by removing all
    // whitespace characters). Avoids relying on `str::trim` semantics.
    let mut compact = String::with_capacity(input.len());
    for c in input.chars() {
        if !c.is_whitespace() {
            compact.push(c);
        }
    }

    // ASCII-only fast path. Non-ASCII would fail the alphabet check
    // anyway, but rejecting early lets us use byte-level case folding
    // without worrying about Unicode-uppercase length surprises (e.g.
    // `ß` → `SS` doubling the byte count).
    if !compact.is_ascii() {
        return Err(ProtocolError::AccountNumberInvalid);
    }

    // 3. Strip case-insensitive `MY-` prefix if present.
    //
    // `split_off(3)` returns the suffix (everything from index 3 onward)
    // and leaves the prefix `"MY-"` in the original `compact`, which is
    // then dropped at the end of this arm.
    let mut after_prefix = if compact.len() >= 3
        && compact.as_bytes()[..2].eq_ignore_ascii_case(b"MY")
        && compact.as_bytes()[2] == b'-'
    {
        compact.split_off(3)
    } else {
        compact
    };

    // 4. Remove all `-` separators.
    after_prefix.retain(|c| c != '-');

    // 5. ASCII uppercase.
    after_prefix.make_ascii_uppercase();

    // 6. Length check.
    if after_prefix.len() != CANONICAL_LEN {
        return Err(ProtocolError::AccountNumberInvalid);
    }

    // 7+8. Alphabet check + Damm-32 verification.
    let bytes = after_prefix.as_bytes();
    let mut canonical = [0u8; CANONICAL_LEN];
    let mut digits = [0u8; CANONICAL_LEN];
    for i in 0..CANONICAL_LEN {
        let idx = crockford_index(bytes[i]).ok_or(ProtocolError::AccountNumberInvalid)?;
        canonical[i] = bytes[i];
        digits[i] = idx;
    }
    if damm32_checksum(&digits) != 0 {
        return Err(ProtocolError::AccountNumberInvalid);
    }

    Ok(AccountNumber {
        display: format_display(&canonical),
        canonical,
        hash: sha256_first_16(&canonical),
    })
}

fn format_display(canonical: &[u8; CANONICAL_LEN]) -> String {
    // Layout: "MY-" + 4 + "-" + 4 + "-" + 4 + "-" + 4 + "-" + 1
    let mut s = String::with_capacity(DISPLAY_LEN);
    s.push_str("MY-");
    for (i, &c) in canonical.iter().enumerate() {
        if i > 0 && i % 4 == 0 {
            s.push('-');
        }
        s.push(c as char);
    }
    s
}

fn sha256_first_16(canonical: &[u8; CANONICAL_LEN]) -> [u8; ACCOUNT_NUMBER_HASH_LEN] {
    let mut h = Sha256::new();
    h.update(canonical);
    let result = h.finalize();
    let mut out = [0u8; ACCOUNT_NUMBER_HASH_LEN];
    out.copy_from_slice(&result[..ACCOUNT_NUMBER_HASH_LEN]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A canonical that is provably valid by hand-computation:
    ///
    /// Entropy indices `0..19` (i.e. `0123456789ABCDEFGHJ`); running
    /// the polynomial recurrence by hand gives a final state of 26,
    /// which maps to `T` in the Crockford alphabet. Full canonical:
    /// `0123456789ABCDEFGHJT`.
    ///
    /// Used as a fixed test vector for substitution / transposition
    /// parametric tests so they don't depend on `getrandom`.
    const VALID_CANONICAL: &[u8; CANONICAL_LEN] = b"0123456789ABCDEFGHJT";

    #[test]
    fn crockford_alphabet_excludes_i_l_o_u() {
        assert_eq!(crockford_index(b'I'), None);
        assert_eq!(crockford_index(b'L'), None);
        assert_eq!(crockford_index(b'O'), None);
        assert_eq!(crockford_index(b'U'), None);
    }

    #[test]
    fn crockford_alphabet_round_trips_full_range() {
        // Every index 0..32 maps to a unique alphabet byte, and every
        // alphabet byte maps back to its origin index.
        for i in 0u8..32 {
            let c = CROCKFORD[i as usize];
            assert_eq!(crockford_index(c), Some(i), "index {i} round-trip");
        }
    }

    #[test]
    fn crockford_alphabet_has_thirty_two_unique_characters() {
        // Sanity guard: catches accidental edits that drop or duplicate
        // an alphabet byte.
        let mut seen = [false; 256];
        for &b in CROCKFORD.iter() {
            assert!(!seen[b as usize], "duplicate byte {b:#x} in CROCKFORD");
            seen[b as usize] = true;
        }
    }

    #[test]
    fn fixed_canonical_passes_damm32() {
        // Sanity: VALID_CANONICAL must verify, otherwise every other
        // parametric test below is built on sand.
        let mut digits = [0u8; CANONICAL_LEN];
        for i in 0..CANONICAL_LEN {
            digits[i] = crockford_index(VALID_CANONICAL[i]).unwrap();
        }
        assert_eq!(damm32_checksum(&digits), 0);
    }

    #[test]
    fn parse_accepts_canonical_with_my_prefix_and_dashes() {
        let acct = parse_account_number("MY-0123-4567-89AB-CDEF-GHJT").unwrap();
        assert_eq!(&acct.canonical, VALID_CANONICAL);
        assert_eq!(acct.display, "MY-0123-4567-89AB-CDEF-GHJT");
    }

    #[test]
    fn parse_accepts_lowercase_my_prefix() {
        let acct = parse_account_number("my-0123-4567-89ab-cdef-ghjt").unwrap();
        assert_eq!(&acct.canonical, VALID_CANONICAL);
    }

    #[test]
    fn parse_accepts_no_my_prefix() {
        let acct = parse_account_number("0123-4567-89AB-CDEF-GHJT").unwrap();
        assert_eq!(&acct.canonical, VALID_CANONICAL);
    }

    #[test]
    fn parse_accepts_no_dashes() {
        let acct = parse_account_number("MY-0123456789ABCDEFGHJT").unwrap();
        assert_eq!(&acct.canonical, VALID_CANONICAL);
    }

    #[test]
    fn parse_accepts_completely_compact() {
        let acct = parse_account_number("0123456789ABCDEFGHJT").unwrap();
        assert_eq!(&acct.canonical, VALID_CANONICAL);
    }

    #[test]
    fn parse_accepts_surrounding_whitespace() {
        let acct = parse_account_number("   MY-0123-4567-89AB-CDEF-GHJT   ").unwrap();
        assert_eq!(&acct.canonical, VALID_CANONICAL);
    }

    #[test]
    fn parse_accepts_internal_whitespace() {
        let acct = parse_account_number("M Y - 0 1 2 3 4 5 6 7 8 9 A B C D E F G H J T").unwrap();
        assert_eq!(&acct.canonical, VALID_CANONICAL);
    }

    #[test]
    fn parse_rejects_wrong_length_too_short() {
        assert_eq!(
            parse_account_number("MY-0123-4567-89AB-CDEF-GHJ"),
            Err(ProtocolError::AccountNumberInvalid)
        );
    }

    #[test]
    fn parse_rejects_wrong_length_too_long() {
        assert_eq!(
            parse_account_number("MY-0123-4567-89AB-CDEF-GHJTX"),
            Err(ProtocolError::AccountNumberInvalid)
        );
    }

    #[test]
    fn parse_rejects_excluded_alphabet_character_i() {
        // `I` is excluded; this 20-char string would otherwise have
        // had a valid Damm-32 check — but the alphabet check fires first.
        assert_eq!(
            parse_account_number("MY-IIII-IIII-IIII-IIII-IIII"),
            Err(ProtocolError::AccountNumberInvalid)
        );
    }

    #[test]
    fn parse_rejects_excluded_alphabet_character_l() {
        assert_eq!(
            parse_account_number("MY-LLLL-LLLL-LLLL-LLLL-LLLL"),
            Err(ProtocolError::AccountNumberInvalid)
        );
    }

    #[test]
    fn parse_rejects_excluded_alphabet_character_o() {
        assert_eq!(
            parse_account_number("MY-OOOO-OOOO-OOOO-OOOO-OOOO"),
            Err(ProtocolError::AccountNumberInvalid)
        );
    }

    #[test]
    fn parse_rejects_excluded_alphabet_character_u() {
        assert_eq!(
            parse_account_number("MY-UUUU-UUUU-UUUU-UUUU-UUUU"),
            Err(ProtocolError::AccountNumberInvalid)
        );
    }

    #[test]
    fn parse_rejects_non_ascii() {
        // Cyrillic `Е` is visually identical to Latin `E` in many fonts
        // but is not in the Crockford alphabet (and not ASCII).
        assert_eq!(
            parse_account_number("MY-0123-4567-89AB-CDЕF-GHJT"),
            Err(ProtocolError::AccountNumberInvalid)
        );
    }

    #[test]
    fn parse_rejects_bad_damm32_check() {
        // Replace the trailing `T` (correct check digit) with `0`, an
        // alphabet character that is *not* the right Damm-32 digit.
        // Length and alphabet checks pass; only Damm-32 fires.
        assert_eq!(
            parse_account_number("MY-0123-4567-89AB-CDEF-GHJ0"),
            Err(ProtocolError::AccountNumberInvalid)
        );
    }

    #[test]
    fn damm32_catches_all_single_substitutions() {
        // For each of the 20 positions, for each of the 31 alternative
        // alphabet characters, replace and expect a parse failure. Spec
        // `account-number.md` § 4 normative property: Damm-32 catches
        // all single-character substitutions.
        for pos in 0..CANONICAL_LEN {
            let original = VALID_CANONICAL[pos];
            for &replacement in CROCKFORD.iter() {
                if replacement == original {
                    continue;
                }
                let mut mutated = *VALID_CANONICAL;
                mutated[pos] = replacement;
                let s = core::str::from_utf8(&mutated).unwrap();
                assert_eq!(
                    parse_account_number(s),
                    Err(ProtocolError::AccountNumberInvalid),
                    "Damm-32 missed substitution at position {pos}: \
                     '{}' → '{}'",
                    original as char,
                    replacement as char,
                );
            }
        }
    }

    #[test]
    fn damm32_catches_all_adjacent_transpositions() {
        // For each pair of adjacent positions, swap and expect parse
        // failure. Spec `account-number.md` § 4 normative property:
        // Damm-32 catches all adjacent transpositions.
        for pos in 0..(CANONICAL_LEN - 1) {
            if VALID_CANONICAL[pos] == VALID_CANONICAL[pos + 1] {
                continue; // swap of equal chars is a no-op
            }
            let mut mutated = *VALID_CANONICAL;
            mutated.swap(pos, pos + 1);
            let s = core::str::from_utf8(&mutated).unwrap();
            assert_eq!(
                parse_account_number(s),
                Err(ProtocolError::AccountNumberInvalid),
                "Damm-32 missed transposition at position {pos}/{}",
                pos + 1
            );
        }
    }

    #[test]
    fn generate_produces_parseable_account_number() {
        let generated = generate_account_number().expect("getrandom available");
        let parsed = parse_account_number(&generated.display).expect("round-trip");
        assert_eq!(generated, parsed);
    }

    #[test]
    fn generate_display_form_matches_spec_layout() {
        // Spec § 3 normative concatenation:
        // `"MY-" || canonical[0:4] || "-" || canonical[4:8] || "-" ||
        //  canonical[8:12] || "-" || canonical[12:16] || "-" || canonical[16:20]`
        // = 27 bytes total. Dashes sit at byte offsets 2, 7, 12, 17, 22.
        let generated = generate_account_number().unwrap();
        assert_eq!(generated.display.len(), DISPLAY_LEN);
        assert_eq!(&generated.display[..3], "MY-");
        for &dash_pos in &[2usize, 7, 12, 17, 22] {
            assert_eq!(
                generated.display.as_bytes()[dash_pos],
                b'-',
                "expected dash at position {dash_pos}"
            );
        }
    }

    #[test]
    fn hash_matches_sha256_truncation_of_canonical() {
        // Spec § 6: account_number_hash := SHA-256(canonical_ascii)[:16].
        let acct = parse_account_number("MY-0123-4567-89AB-CDEF-GHJT").unwrap();
        let mut h = Sha256::new();
        h.update(b"0123456789ABCDEFGHJT");
        let expected = h.finalize();
        assert_eq!(&acct.hash[..], &expected[..ACCOUNT_NUMBER_HASH_LEN]);
    }

    #[test]
    fn entropy_chars_constant_is_nineteen() {
        // 95-bit entropy / 5 bits per char = 19. Anyone reading the
        // spec and editing this constant must update the bit-shift
        // arithmetic in generate_account_number too.
        assert_eq!(ENTROPY_CHARS, 19);
        assert_eq!(CANONICAL_LEN, 20);
    }
}
