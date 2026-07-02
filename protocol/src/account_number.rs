// SPDX-License-Identifier: AGPL-3.0
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
//! Spec `account-number.md` § 4.2 freezes the 32×32 quasigroup table.
//! This implementation uses the equivalent polynomial-multiplication
//! construction (no need to consult the 1024-element table at runtime):
//! the running checksum is XORed with the next symbol, multiplied by α in
//! `GF(2⁵) ≅ GF(2)[x] / (x⁵ + x² + 1)`, and reduced. The irreducible
//! polynomial `x⁵ + x² + 1` corresponds to the bitmask `0b100101 = 37`.
//! The construction is mathematically equivalent to the single fixed
//! quasigroup in § 4.2; the frozen `DAMM32_TABLE` const mirrors it,
//! is golden-locked to `damm32_step` (drift-lock) and proven a valid
//! weak-TA quasigroup (exhaustive property test) by the `damm32_table_*`
//! tests below, and `emit_damm32_table_for_paste` regenerates both the
//! const and the spec § 4.2 markdown block from this construction.
//!
//! Reference port: `srobo/damm32` (MIT, Python),
//! <https://github.com/srobo/damm32>. The five-line core
//! (`_calculate_from_digits`) is the operative artifact; the rest of
//! that crate's API surface is alphabet-handling boilerplate we
//! re-implement here against the Crockford alphabet (`srobo/damm32`
//! itself uses the RFC 4648 alphabet — alphabet choice is independent
//! of the Damm-32 mathematics).

use crate::error::ProtocolError;
use alloc::string::String;
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

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

/// Frozen canonical Damm-32 quasigroup table (`account-number.md` § 4.2).
///
/// This const is the in-crate copy of the **normative literal table** published
/// in `account-number.md` § 4.2 (and pinned as a 1024-byte cross-implementation
/// hex vector in `myne-test-vectors`). It is exposed read-only via
/// [`damm32_table`] for conformance/introspection; production validation runs
/// the equivalent runtime `damm32_step`, which the `damm32_table_*` golden
/// tests lock to this literal. Orientation: `DAMM32_TABLE[interim][digit]` —
/// the outer index is the running interim digit (row), the inner index is the
/// input symbol index (column); both are 0..32 Crockford-base32 positions.
///
/// It is a **weak** totally anti-symmetric quasigroup with zero diagonal: every
/// row and column is a permutation of 0..32, `T[i][i] == 0`, and
/// `T[T[c][x]][y] != T[T[c][y]][x]` for all `x != y`. The table is commutative
/// (`T[a][b] == T[b][a]`), hence it is NOT *fully* totally anti-symmetric — which
/// is correct, because the Damm check equation needs only weak total
/// anti-symmetry (the source of all single-substitution + adjacent-transposition
/// detection); zero diagonal gives the check = interim property. The
/// `damm32_table_*` tests below pin both legs (drift-lock vs `damm32_step` and
/// the exhaustive quasigroup properties).
///
/// Regenerate with
/// `cargo test -p protocol --lib emit_damm32_table_for_paste -- --ignored`
/// (emits both this Rust const and the `account-number.md` § 4 markdown block).
/// A lefthook pre-push step re-runs the generator and fails on drift. **Changing
/// this table is a major-version event** (root `CLAUDE.md` load-bearing registry):
/// it would reject already-distributed account numbers and break cross-impl
/// validity agreement.
// BEGIN GENERATED damm32-table (emit_damm32_table_for_paste) — do not edit by hand
#[rustfmt::skip]
const DAMM32_TABLE: [[u8; 32]; 32] = [
    [ 0,  2,  4,  6,  8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30,  5,  7,  1,  3, 13, 15,  9, 11, 21, 23, 17, 19, 29, 31, 25, 27],
    [ 2,  0,  6,  4, 10,  8, 14, 12, 18, 16, 22, 20, 26, 24, 30, 28,  7,  5,  3,  1, 15, 13, 11,  9, 23, 21, 19, 17, 31, 29, 27, 25],
    [ 4,  6,  0,  2, 12, 14,  8, 10, 20, 22, 16, 18, 28, 30, 24, 26,  1,  3,  5,  7,  9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31],
    [ 6,  4,  2,  0, 14, 12, 10,  8, 22, 20, 18, 16, 30, 28, 26, 24,  3,  1,  7,  5, 11,  9, 15, 13, 19, 17, 23, 21, 27, 25, 31, 29],
    [ 8, 10, 12, 14,  0,  2,  4,  6, 24, 26, 28, 30, 16, 18, 20, 22, 13, 15,  9, 11,  5,  7,  1,  3, 29, 31, 25, 27, 21, 23, 17, 19],
    [10,  8, 14, 12,  2,  0,  6,  4, 26, 24, 30, 28, 18, 16, 22, 20, 15, 13, 11,  9,  7,  5,  3,  1, 31, 29, 27, 25, 23, 21, 19, 17],
    [12, 14,  8, 10,  4,  6,  0,  2, 28, 30, 24, 26, 20, 22, 16, 18,  9, 11, 13, 15,  1,  3,  5,  7, 25, 27, 29, 31, 17, 19, 21, 23],
    [14, 12, 10,  8,  6,  4,  2,  0, 30, 28, 26, 24, 22, 20, 18, 16, 11,  9, 15, 13,  3,  1,  7,  5, 27, 25, 31, 29, 19, 17, 23, 21],
    [16, 18, 20, 22, 24, 26, 28, 30,  0,  2,  4,  6,  8, 10, 12, 14, 21, 23, 17, 19, 29, 31, 25, 27,  5,  7,  1,  3, 13, 15,  9, 11],
    [18, 16, 22, 20, 26, 24, 30, 28,  2,  0,  6,  4, 10,  8, 14, 12, 23, 21, 19, 17, 31, 29, 27, 25,  7,  5,  3,  1, 15, 13, 11,  9],
    [20, 22, 16, 18, 28, 30, 24, 26,  4,  6,  0,  2, 12, 14,  8, 10, 17, 19, 21, 23, 25, 27, 29, 31,  1,  3,  5,  7,  9, 11, 13, 15],
    [22, 20, 18, 16, 30, 28, 26, 24,  6,  4,  2,  0, 14, 12, 10,  8, 19, 17, 23, 21, 27, 25, 31, 29,  3,  1,  7,  5, 11,  9, 15, 13],
    [24, 26, 28, 30, 16, 18, 20, 22,  8, 10, 12, 14,  0,  2,  4,  6, 29, 31, 25, 27, 21, 23, 17, 19, 13, 15,  9, 11,  5,  7,  1,  3],
    [26, 24, 30, 28, 18, 16, 22, 20, 10,  8, 14, 12,  2,  0,  6,  4, 31, 29, 27, 25, 23, 21, 19, 17, 15, 13, 11,  9,  7,  5,  3,  1],
    [28, 30, 24, 26, 20, 22, 16, 18, 12, 14,  8, 10,  4,  6,  0,  2, 25, 27, 29, 31, 17, 19, 21, 23,  9, 11, 13, 15,  1,  3,  5,  7],
    [30, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10,  8,  6,  4,  2,  0, 27, 25, 31, 29, 19, 17, 23, 21, 11,  9, 15, 13,  3,  1,  7,  5],
    [ 5,  7,  1,  3, 13, 15,  9, 11, 21, 23, 17, 19, 29, 31, 25, 27,  0,  2,  4,  6,  8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30],
    [ 7,  5,  3,  1, 15, 13, 11,  9, 23, 21, 19, 17, 31, 29, 27, 25,  2,  0,  6,  4, 10,  8, 14, 12, 18, 16, 22, 20, 26, 24, 30, 28],
    [ 1,  3,  5,  7,  9, 11, 13, 15, 17, 19, 21, 23, 25, 27, 29, 31,  4,  6,  0,  2, 12, 14,  8, 10, 20, 22, 16, 18, 28, 30, 24, 26],
    [ 3,  1,  7,  5, 11,  9, 15, 13, 19, 17, 23, 21, 27, 25, 31, 29,  6,  4,  2,  0, 14, 12, 10,  8, 22, 20, 18, 16, 30, 28, 26, 24],
    [13, 15,  9, 11,  5,  7,  1,  3, 29, 31, 25, 27, 21, 23, 17, 19,  8, 10, 12, 14,  0,  2,  4,  6, 24, 26, 28, 30, 16, 18, 20, 22],
    [15, 13, 11,  9,  7,  5,  3,  1, 31, 29, 27, 25, 23, 21, 19, 17, 10,  8, 14, 12,  2,  0,  6,  4, 26, 24, 30, 28, 18, 16, 22, 20],
    [ 9, 11, 13, 15,  1,  3,  5,  7, 25, 27, 29, 31, 17, 19, 21, 23, 12, 14,  8, 10,  4,  6,  0,  2, 28, 30, 24, 26, 20, 22, 16, 18],
    [11,  9, 15, 13,  3,  1,  7,  5, 27, 25, 31, 29, 19, 17, 23, 21, 14, 12, 10,  8,  6,  4,  2,  0, 30, 28, 26, 24, 22, 20, 18, 16],
    [21, 23, 17, 19, 29, 31, 25, 27,  5,  7,  1,  3, 13, 15,  9, 11, 16, 18, 20, 22, 24, 26, 28, 30,  0,  2,  4,  6,  8, 10, 12, 14],
    [23, 21, 19, 17, 31, 29, 27, 25,  7,  5,  3,  1, 15, 13, 11,  9, 18, 16, 22, 20, 26, 24, 30, 28,  2,  0,  6,  4, 10,  8, 14, 12],
    [17, 19, 21, 23, 25, 27, 29, 31,  1,  3,  5,  7,  9, 11, 13, 15, 20, 22, 16, 18, 28, 30, 24, 26,  4,  6,  0,  2, 12, 14,  8, 10],
    [19, 17, 23, 21, 27, 25, 31, 29,  3,  1,  7,  5, 11,  9, 15, 13, 22, 20, 18, 16, 30, 28, 26, 24,  6,  4,  2,  0, 14, 12, 10,  8],
    [29, 31, 25, 27, 21, 23, 17, 19, 13, 15,  9, 11,  5,  7,  1,  3, 24, 26, 28, 30, 16, 18, 20, 22,  8, 10, 12, 14,  0,  2,  4,  6],
    [31, 29, 27, 25, 23, 21, 19, 17, 15, 13, 11,  9,  7,  5,  3,  1, 26, 24, 30, 28, 18, 16, 22, 20, 10,  8, 14, 12,  2,  0,  6,  4],
    [25, 27, 29, 31, 17, 19, 21, 23,  9, 11, 13, 15,  1,  3,  5,  7, 28, 30, 24, 26, 20, 22, 16, 18, 12, 14,  8, 10,  4,  6,  0,  2],
    [27, 25, 31, 29, 19, 17, 23, 21, 11,  9, 15, 13,  3,  1,  7,  5, 30, 28, 26, 24, 22, 20, 18, 16, 14, 12, 10,  8,  6,  4,  2,  0],
];
// END GENERATED damm32-table

/// Returns a reference to the frozen canonical Damm-32 quasigroup table
/// (`account-number.md` § 4.2), the `DAMM32_TABLE` const.
///
/// Read-only accessor exposed for **cross-implementation conformance**: an
/// independent port can derive its order-32 quasigroup over GF(2⁵) and diff it
/// against this table cell-for-cell (the same check the `myne-test-vectors`
/// `damm32-table` category pins). Indexing is `table[interim][symbol]`
/// (row = running interim digit, column = input symbol's 0..32 Crockford
/// index). Returns a `'static` reference — the table is a compile-time const,
/// so this never copies. Changing this table is a major-version event (root
/// `CLAUDE.md` load-bearing registry).
pub fn damm32_table() -> &'static [[u8; 32]; 32] {
    &DAMM32_TABLE
}

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
/// **NFKD.** Spec § 5 step 1 mandates NFKD normalization on the input
/// before any other processing. Applied via `unicode-normalization`
/// (added as a direct dep alongside `protocol::phrase` recovery-flow
/// normalization — see `decisions.md` 2026-05-02). This canonicalizes
/// compatibility-decomposable input — full-width digits (`０`–`９`),
/// full-width Latin letters (`Ａ`–`Ｚ`), no-break space (U+00A0),
/// ideographic space (U+3000), and ligatures like `ﬁ` — into ASCII
/// equivalents so the downstream alphabet check accepts them. Non-
/// decomposable non-ASCII (e.g. Cyrillic Е U+0415) survives NFKD and
/// is rejected at the ASCII fast-path below.
pub fn parse_account_number(input: &str) -> Result<AccountNumber, ProtocolError> {
    // 1. NFKD normalize (spec § 5 step 1). Compatibility decomposition
    //    folds full-width / ligature / compatibility variants into the
    //    canonical ASCII forms expected by the downstream alphabet
    //    check, before any whitespace stripping or case folding runs.
    let normalized: String = input.nfkd().collect();

    // 2+3. Strip whitespace anywhere (trim is implied by removing all
    // whitespace characters). Avoids relying on `str::trim` semantics.
    let mut compact = String::with_capacity(normalized.len());
    for c in normalized.chars() {
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
#[cfg_attr(coverage_nightly, coverage(off))]
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
    fn damm32_table_matches_runtime_construction() {
        // Golden-lock leg 1 (TEMPORAL independence): the frozen literal
        // `DAMM32_TABLE` must equal the runtime polynomial construction at
        // every one of the 1024 cells. A future edit to `damm32_step` that
        // shifts any entry fails here — the table is a major-version-event
        // artifact (root `CLAUDE.md` load-bearing registry). Orientation:
        // `DAMM32_TABLE[interim][digit] == damm32_step(interim, digit)`.
        //
        // NOTE: at t=0 this is a tautology (the const was minted from
        // `damm32_step`). Its value is purely temporal — catching later
        // drift. The METHODOLOGICAL leg — proving the table is a valid Damm
        // quasigroup regardless of how it was minted — lives in
        // `damm32_table_is_valid_weak_ta_quasigroup`.
        for interim in 0u8..32 {
            for digit in 0u8..32 {
                assert_eq!(
                    DAMM32_TABLE[interim as usize][digit as usize],
                    damm32_step(interim, digit),
                    "table/runtime drift at [interim={interim}][digit={digit}]"
                );
            }
        }
    }

    #[test]
    fn damm32_table_is_valid_weak_ta_quasigroup() {
        // Golden-lock leg 2 (METHODOLOGICAL independence): prove the frozen
        // DAMM32_TABLE is a valid Damm quasigroup regardless of HOW it was
        // minted. Runs on the CONST, not `damm32_step`, so a t=0 generator
        // error (which would have minted into both the const AND the runtime,
        // leaving the drift-lock green) is caught here. At n=32 every check is
        // EXHAUSTIVE over the whole space, not sampled.

        // (a) Latin square — every row AND every column is a permutation of
        //     0..32 (each value appears exactly once). Checking only rows is a
        //     common, insufficient shortcut.
        for (i, row) in DAMM32_TABLE.iter().enumerate() {
            let mut seen_row = [false; 32];
            let mut seen_col = [false; 32];
            for (j, &val) in row.iter().enumerate() {
                let r = val as usize;
                let c = DAMM32_TABLE[j][i] as usize;
                assert!(!seen_row[r], "row {i} repeats value {r}");
                assert!(!seen_col[c], "column {i} repeats value {c}");
                seen_row[r] = true;
                seen_col[c] = true;
            }
        }

        // (b) Zero diagonal — T[i][i] == 0. Gives the Damm "check = interim"
        //     property (validating entropy||check returns interim 0).
        for (i, row) in DAMM32_TABLE.iter().enumerate() {
            assert_eq!(row[i], 0, "non-zero diagonal at {i}");
        }

        // (c) WEAK total anti-symmetry — for all c and all x != y:
        //     T[T[c][x]][y] != T[T[c][y]][x]. This is EXACTLY the property that
        //     makes every adjacent transposition detectable. 32³ triples.
        //
        //     We assert WEAK-TA ONLY. The full-TA second condition
        //     (`x∗y == y∗x  ⇒  x == y`) is DELIBERATELY NOT asserted: this
        //     table is commutative by construction (`2·(x⊕y) == 2·(y⊕x)`), so
        //     full-TA is false for it — and asserting it would FALSELY fail a
        //     correct table. Weak-TA + zero diagonal is the precise and
        //     sufficient requirement for the Damm check equation.
        for c in 0..32 {
            for x in 0..32 {
                for y in 0..32 {
                    if x != y {
                        let lhs = DAMM32_TABLE[DAMM32_TABLE[c][x] as usize][y];
                        let rhs = DAMM32_TABLE[DAMM32_TABLE[c][y] as usize][x];
                        assert_ne!(lhs, rhs, "weak-TA violated at c={c} x={x} y={y}");
                    }
                }
            }
        }

        // (d) Document the commutativity that makes (c) weak-TA and not full-TA.
        //     Asserted positively so a future non-commutative re-mint is a
        //     visible, intentional change rather than a silent one.
        for (a, row) in DAMM32_TABLE.iter().enumerate() {
            for (b, &val) in row.iter().enumerate() {
                assert_eq!(
                    val, DAMM32_TABLE[b][a],
                    "table unexpectedly non-commutative at ({a},{b})"
                );
            }
        }
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

    // ---- NFKD normalization (spec § 5 step 1) ----------------------
    //
    // `unicode-normalization` direct dep adds NFKD canonicalization
    // before the rest of the parse pipeline runs. Compatibility-
    // decomposable input (full-width Latin/digit forms, ligatures,
    // some compatibility characters) folds to ASCII before the
    // alphabet check, so real-world copy-paste paths (screenshot
    // OCR producing `０`, ﬁ-typesetting password-manager output)
    // succeed instead of falsely rejecting on "non-ASCII".

    #[test]
    fn parse_accepts_fullwidth_digit_normalization() {
        // U+FF10..U+FF19 (full-width digits ０..９) NFKD-decompose
        // to ASCII 0..9. Parse must succeed and produce a canonical
        // identical to the ASCII form.
        let acct_ascii = parse_account_number("MY-0123-4567-89AB-CDEF-GHJT").unwrap();
        let acct_full_width =
            parse_account_number("MY-\u{FF10}\u{FF11}\u{FF12}\u{FF13}-4567-89AB-CDEF-GHJT")
                .unwrap();
        assert_eq!(&acct_full_width.canonical, &acct_ascii.canonical);
        assert_eq!(acct_full_width.hash, acct_ascii.hash);
    }

    #[test]
    fn parse_accepts_fullwidth_letter_normalization() {
        // U+FF21..U+FF3A (full-width Latin uppercase Ａ..Ｚ) NFKD-
        // decompose to ASCII A..Z. The Crockford alphabet check at
        // step 7 then accepts them as canonical alphabet bytes.
        let acct_ascii = parse_account_number("MY-0123-4567-89AB-CDEF-GHJT").unwrap();
        // Replace "AB" with full-width "ＡＢ" (U+FF21, U+FF22).
        let acct_full_width =
            parse_account_number("MY-0123-4567-89\u{FF21}\u{FF22}-CDEF-GHJT").unwrap();
        assert_eq!(&acct_full_width.canonical, &acct_ascii.canonical);
    }

    #[test]
    fn parse_accepts_fullwidth_my_prefix() {
        // The case-insensitive `MY-` prefix strip happens after NFKD,
        // so a full-width prefix `ＭＹ-` (U+FF2D, U+FF39, ASCII '-')
        // round-trips through NFKD to ASCII `MY-` and is accepted.
        let acct_ascii = parse_account_number("MY-0123-4567-89AB-CDEF-GHJT").unwrap();
        let acct_full_width =
            parse_account_number("\u{FF2D}\u{FF39}-0123-4567-89AB-CDEF-GHJT").unwrap();
        assert_eq!(&acct_full_width.canonical, &acct_ascii.canonical);
    }

    #[test]
    fn parse_accepts_no_break_space_separator() {
        // U+00A0 (NO-BREAK SPACE) decomposes to ASCII U+0020 under NFKD;
        // the whitespace-strip step then removes it. Word-processor /
        // password-manager copies frequently substitute regular spaces
        // with U+00A0 — this test documents the canonical accept.
        let s = "MY-0123-4567-89AB-CDEF-GHJT".replace('-', "\u{00A0}-\u{00A0}");
        let acct = parse_account_number(&s).unwrap();
        assert_eq!(&acct.canonical, b"0123456789ABCDEFGHJT");
    }

    // ---- KAT vector regenerator (companion repo) ---------------------

    /// Emits the full `cases.json` for
    /// `myne-test-vectors/vectors/account-number/v0.1/cases.json` as a
    /// pretty-printed JSON file at `/tmp/myne_account_number_vectors.json`.
    ///
    /// `#[ignore]` because regenerating vectors is a deliberate act.
    /// Run with:
    /// `cargo test -p protocol --lib emit_account_number_vectors_for_paste -- --ignored`
    ///
    /// 12 cases pin (per MYND-72 / D7):
    /// - 6 `parse_ok`: canonical / display / lowercase / lowercase-display
    ///   / missing-MY-prefix / with-surrounding-whitespace — all normalize
    ///   to the same `AccountNumber { canonical, display, hash }`.
    /// - 6 `parse_fail`: too-short / too-long / contains-`O` (Crockford
    ///   strict reject, no `I/L/O/U` substitution per spec §5 step 7) /
    ///   contains-`I` / Damm-32 single-substitution / Damm-32 adjacent-
    ///   transposition. All collapse to
    ///   `ProtocolError::AccountNumberInvalid`.
    ///
    /// Baseline canonical: `0123456789ABCDEFGHJT` — already used by
    /// existing `parse_accepts_*` unit tests in this module; same
    /// baseline preserves cross-test consistency.
    #[test]
    #[ignore]
    fn emit_account_number_vectors_for_paste() {
        extern crate std;

        fn hex_lower(bytes: &[u8]) -> alloc::string::String {
            let mut s = alloc::string::String::with_capacity(bytes.len() * 2);
            for b in bytes {
                s.push_str(&alloc::format!("{:02x}", b));
            }
            s
        }

        fn json_escape(input: &str) -> alloc::string::String {
            let mut out = alloc::string::String::with_capacity(input.len() + 2);
            for c in input.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if (c as u32) < 0x20 => {
                        out.push_str(&alloc::format!("\\u{:04x}", c as u32));
                    }
                    c => out.push(c),
                }
            }
            out
        }

        let baseline_canonical: &str = "0123456789ABCDEFGHJT";
        let baseline_display: &str = "MY-0123-4567-89AB-CDEF-GHJT";

        let baseline = parse_account_number(baseline_canonical)
            .expect("baseline canonical must parse cleanly");
        assert_eq!(&baseline.canonical, baseline_canonical.as_bytes());
        assert_eq!(&baseline.display, baseline_display);

        let expected_canonical_hex = hex_lower(&baseline.canonical);
        let expected_display_hex = hex_lower(baseline.display.as_bytes());
        let expected_hash_hex = hex_lower(&baseline.hash);

        struct ParseOkCase {
            slug: &'static str,
            description: &'static str,
            input: alloc::string::String,
        }
        struct ParseFailCase {
            slug: &'static str,
            description: &'static str,
            input: alloc::string::String,
            informational_reason: &'static str,
        }

        let parse_ok_cases: [ParseOkCase; 6] = [
            ParseOkCase {
                slug: "canonical-uppercase",
                description: "Pure canonical 20-char Crockford-base32 form (19 entropy + Damm-32 check). The baseline shape every other parse_ok case normalizes to.",
                input: baseline_canonical.into(),
            },
            ParseOkCase {
                slug: "display-with-prefix-and-hyphens",
                description: "Canonical 27-char display form: 'MY-' prefix + four 4-char Crockford groups + '-' separators + final 4-char group containing 3 entropy + 1 Damm-32 check. Liberal-parse strips prefix + hyphens to recover canonical.",
                input: baseline_display.into(),
            },
            ParseOkCase {
                slug: "lowercase-canonical",
                description: "Canonical form with all chars lowercased. Spec §5 normalizes case-insensitively before alphabet validation; output canonical is always uppercase per §3.",
                input: baseline_canonical.to_lowercase(),
            },
            ParseOkCase {
                slug: "lowercase-display",
                description: "Display form with all chars (incl. 'MY-' prefix) lowercased. Same case-insensitive normalization applies; prefix strip happens after lowercase.",
                input: baseline_display.to_lowercase(),
            },
            ParseOkCase {
                slug: "missing-my-prefix",
                description: "Display form without the 'MY-' prefix (only the four 4-char groups + final 4-char group, hyphen-separated). Spec §5 makes the prefix optional in liberal parse.",
                input: "0123-4567-89AB-CDEF-GHJT".into(),
            },
            ParseOkCase {
                slug: "with-surrounding-whitespace",
                description: "Display form with leading + trailing ASCII spaces. Spec §5 strips surrounding + interior whitespace before alphabet validation.",
                input: "  MY-0123-4567-89AB-CDEF-GHJT  ".into(),
            },
        ];

        // Substitution: flip entropy[7] '7' → '8'. Damm-32 catches all
        // single-character substitutions by design.
        let substitution_canonical = "0123456889ABCDEFGHJT";
        // Transposition: swap entropy[2] '2' and entropy[3] '3'.
        // Damm-32 catches all adjacent-pair transpositions by design.
        let transposition_canonical = "0132456789ABCDEFGHJT";

        // Guard: if a mutation accidentally rolls back to a valid Damm-
        // 32 sum, the case would be misleading. Verify it actually
        // rejects before emitting.
        assert!(
            parse_account_number(substitution_canonical).is_err(),
            "substitution canonical must reject; adjust the entropy mutation if not"
        );
        assert!(
            parse_account_number(transposition_canonical).is_err(),
            "transposition canonical must reject; adjust the swap positions if not"
        );

        let parse_fail_cases: [ParseFailCase; 6] = [
            ParseFailCase {
                slug: "wrong-length-too-short",
                description: "18-char input — one char short of canonical 20. Spec §5 step 6 length-check rejects after normalization.",
                input: "0123456789ABCDEFGH".into(),
                informational_reason: "wrong length: 18 chars after normalization (expected 20)",
            },
            ParseFailCase {
                slug: "wrong-length-too-long",
                description: "21-char input — one char over canonical 20. Same length-check rejects.",
                input: "0123456789ABCDEFGHJTX".into(),
                informational_reason: "wrong length: 21 chars after normalization (expected 20)",
            },
            ParseFailCase {
                slug: "non-crockford-char-oh",
                description: "Contains 'O' — Crockford base32 alphabet excludes O (visually conflated with '0'). Spec §5 step 7 rejects STRICTLY — no I/L → 1, O → 0, or U → V lookalike substitution. The Rust parser uses the alphabet exactly as documented.",
                input: "O123456789ABCDEFGHJT".into(),
                informational_reason: "contains non-Crockford character 'O' at index 0 — strict reject per spec §5 step 7",
            },
            ParseFailCase {
                slug: "non-crockford-char-eye",
                description: "Contains 'I' — Crockford base32 alphabet excludes I (visually conflated with '1'). Same strict-reject policy as 'O'.",
                input: "1I23456789ABCDEFGHJT".into(),
                informational_reason: "contains non-Crockford character 'I' at index 1 — strict reject per spec §5 step 7",
            },
            ParseFailCase {
                slug: "damm32-substitution-catch",
                description: "Single entropy character flipped vs the baseline canonical (entropy[7] '7' → '8'); Damm-32 check digit unchanged. Damm-32 by design catches all single-character substitutions; this case proves the implementation honors that property per design-notes.md 2026-04-28 polynomial freeze.",
                input: substitution_canonical.into(),
                informational_reason: "Damm-32 substitution catch: entropy[7] '7' → '8', check digit 'T' unchanged",
            },
            ParseFailCase {
                slug: "damm32-transposition-catch",
                description: "Adjacent entropy characters swapped vs the baseline canonical (entropy[2] '2' ↔ entropy[3] '3'); Damm-32 check digit unchanged. Damm-32 by design catches all adjacent-pair transpositions; this case proves it.",
                input: transposition_canonical.into(),
                informational_reason: "Damm-32 transposition catch: entropy[2,3] '2','3' → '3','2', check digit 'T' unchanged",
            },
        ];

        let mut dump = alloc::string::String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"account-number\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"protocol.md + account-number.md §3 + §5\",\n");
        dump.push_str("  \"description\": \"Pins protocol::parse_account_number byte mapping for cross-implementation conformance: 20-character Crockford-base32 canonical + Damm-32 check digit + display formatter + liberal-parsing normalization (case, hyphens, MY- prefix, whitespace). Damm-32 polynomial form per design-notes.md 2026-04-28 freeze. Twelve cases: 6 parse_ok permutations all normalize to the same AccountNumber, 6 parse_fail covering length / non-Crockford-char / Damm-32 substitution + transposition. Cases generated by `cargo test -p protocol --lib emit_account_number_vectors_for_paste -- --ignored`.\",\n");
        dump.push_str("  \"cases\": [\n");

        let total_cases = parse_ok_cases.len() + parse_fail_cases.len();
        let mut i = 0;
        for case in parse_ok_cases.iter() {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"account-number/v0.1/{}\",\n",
                case.slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(case.description)
            ));
            dump.push_str("      \"case_kind\": \"parse_ok\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_candidate_utf8_hex\": \"{}\",\n",
                hex_lower(case.input.as_bytes())
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_canonical_utf8_hex\": \"{}\",\n",
                expected_canonical_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_display_utf8_hex\": \"{}\",\n",
                expected_display_hex
            ));
            dump.push_str(&alloc::format!(
                "      \"expected_hash_hex\": \"{}\"\n",
                expected_hash_hex
            ));
            i += 1;
            if i < total_cases {
                dump.push_str("    },\n");
            } else {
                dump.push_str("    }\n");
            }
        }
        for case in parse_fail_cases.iter() {
            dump.push_str("    {\n");
            dump.push_str(&alloc::format!(
                "      \"vector_id\": \"account-number/v0.1/{}\",\n",
                case.slug
            ));
            dump.push_str(&alloc::format!(
                "      \"description\": \"{}\",\n",
                json_escape(case.description)
            ));
            dump.push_str("      \"case_kind\": \"parse_fail\",\n");
            dump.push_str(&alloc::format!(
                "      \"input_candidate_utf8_hex\": \"{}\",\n",
                hex_lower(case.input.as_bytes())
            ));
            dump.push_str("      \"expected_kind\": \"parse_fail\",\n");
            dump.push_str(&alloc::format!(
                "      \"informational_failure_reason\": \"{}\"\n",
                json_escape(case.informational_reason)
            ));
            i += 1;
            if i < total_cases {
                dump.push_str("    },\n");
            } else {
                dump.push_str("    }\n");
            }
        }

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_account_number_vectors.json", dump.as_bytes())
            .expect("write account-number vectors dump");
    }

    /// Emits the frozen `DAMM32_TABLE` Rust const block AND the
    /// `account-number.md` § 4 markdown table block — both delimited by
    /// `BEGIN/END GENERATED damm32-table` sentinels — derived from the
    /// runtime [`damm32_step`] construction. One generator authors both
    /// representations so the spec table and the code const cannot diverge;
    /// a lefthook pre-push step re-runs this and `git diff --exit-code`s.
    ///
    /// Writes:
    /// - `/tmp/myne_damm32_table_const.rs` — the Rust const block
    /// - `/tmp/myne_damm32_table_spec.md` — the spec markdown block
    ///
    /// Derives the full 32×32 table from the runtime [`damm32_step`]
    /// construction. Shared by the two `#[ignore]` generators below.
    fn build_damm32_table() -> [[u8; 32]; 32] {
        let mut table = [[0u8; 32]; 32];
        for interim in 0u8..32 {
            for digit in 0u8..32 {
                table[interim as usize][digit as usize] = damm32_step(interim, digit);
            }
        }
        table
    }

    /// `#[ignore]` — regenerating the frozen table is a deliberate act. Run:
    /// `cargo test -p protocol --lib emit_damm32_table_for_paste -- --ignored`
    #[test]
    #[ignore]
    fn emit_damm32_table_for_paste() {
        extern crate std;

        let table = build_damm32_table();

        // --- Rust const block (must match the in-file block byte-for-byte) ---
        let mut rs = alloc::string::String::new();
        rs.push_str(
            "// BEGIN GENERATED damm32-table (emit_damm32_table_for_paste) — do not edit by hand\n",
        );
        rs.push_str("#[rustfmt::skip]\n");
        rs.push_str("const DAMM32_TABLE: [[u8; 32]; 32] = [\n");
        for row in table.iter() {
            rs.push_str("    [");
            for (j, v) in row.iter().enumerate() {
                if j > 0 {
                    rs.push_str(", ");
                }
                rs.push_str(&alloc::format!("{:2}", v));
            }
            rs.push_str("],\n");
        }
        rs.push_str("];\n");
        rs.push_str("// END GENERATED damm32-table\n");

        // --- spec markdown block (paste verbatim into account-number.md §4) ---
        let mut md = alloc::string::String::new();
        md.push_str(
            "<!-- BEGIN GENERATED damm32-table (emit_damm32_table_for_paste) — do not edit by hand -->\n",
        );
        md.push_str("```text\n");
        md.push_str("  i\\j │");
        for j in 0..32 {
            md.push_str(&alloc::format!(" {:2}", j));
        }
        md.push('\n');
        md.push_str("  ────┼");
        for _ in 0..32 {
            md.push_str("───");
        }
        md.push('\n');
        for (i, row) in table.iter().enumerate() {
            md.push_str(&alloc::format!("  {:3} │", i));
            for v in row.iter() {
                md.push_str(&alloc::format!(" {:2}", v));
            }
            md.push('\n');
        }
        md.push_str("```\n");
        md.push_str("<!-- END GENERATED damm32-table -->\n");

        std::fs::write("/tmp/myne_damm32_table_const.rs", rs.as_bytes())
            .expect("write damm32 const block");
        std::fs::write("/tmp/myne_damm32_table_spec.md", md.as_bytes())
            .expect("write damm32 spec block");
        std::println!("{rs}\n{md}");
    }

    /// Emits the `damm32-table` cross-implementation vector set for
    /// `myne-test-vectors/vectors/damm32-table/v0.1/cases.json` as ready-to-copy
    /// JSON at `/tmp/myne_damm32_table_vectors.json`.
    ///
    /// One `table` case pins the full 1024-byte quasigroup table (row-major,
    /// `table[interim][symbol]`) as hex — the only ground truth independent of a
    /// port's own GF(2⁵) implementation. Three `checksum` cases pin the
    /// running-checksum direction/orientation at the index level.
    ///
    /// **Provenance cross-check at mint:** the table is asserted equal to an
    /// independent transcription of the published `srobo/damm32` (MIT) step
    /// before emitting, so the vector's `informational_provenance` claim
    /// ("matches published srobo/damm32 reference (MIT)") is true by
    /// construction. This is provenance/citability — `srobo`'s step is the same
    /// algorithm as `damm32_step`, so it is NOT independent verification of
    /// correctness; that is carried by `damm32_table_is_valid_weak_ta_quasigroup`.
    ///
    /// `#[ignore]`. Run:
    /// `cargo test -p protocol --lib emit_damm32_table_vectors_for_paste -- --ignored`
    #[test]
    #[ignore]
    fn emit_damm32_table_vectors_for_paste() {
        extern crate std;
        use alloc::format;
        use alloc::string::String;

        // Independent transcription of srobo/damm32's `_calculate_from_digits`
        // inner loop (MIT): `checkdigit ^= digit; checkdigit <<= 1;
        // if checkdigit >= BASE_SIZE { checkdigit ^= BIT_MASK }`, BASE_SIZE=32,
        // BIT_MASK=37. Transcribed from the published source, NOT calling
        // `damm32_step` — so equality is a provenance assertion.
        let srobo_step = |running: u8, digit: u8| -> u8 {
            let mut c = running ^ digit;
            c <<= 1;
            if c >= 32 {
                c ^= 37;
            }
            c
        };

        let table = build_damm32_table();

        // Provenance cross-check: every cell must equal the independent srobo
        // transcription before we emit, making the provenance metadata true by
        // construction. The checksum cases below fold over this table, so this
        // cell-level check transitively covers them too.
        for (interim, row) in table.iter().enumerate() {
            for (digit, &v) in row.iter().enumerate() {
                assert_eq!(
                    v,
                    srobo_step(interim as u8, digit as u8),
                    "table cell [{interim}][{digit}] disagrees with srobo/damm32 transcription"
                );
            }
        }

        // Row-major hex of all 1024 cells.
        let mut table_hex = String::with_capacity(2048);
        for row in table.iter() {
            for v in row.iter() {
                table_hex.push_str(&format!("{v:02x}"));
            }
        }

        // Checksum cases: (slug, description, indices, informational note).
        let single_step: alloc::vec::Vec<u8> = alloc::vec![1];
        let baseline: alloc::vec::Vec<u8> = (0u8..19).collect();
        let all_high: alloc::vec::Vec<u8> = alloc::vec![31u8; 19];
        let checksum_cases: [(&str, &str, alloc::vec::Vec<u8>, &str); 3] = [
            (
                "checksum-single-step",
                "Single symbol from interim 0: pins orientation table[0][1] = 2 (row = interim, column = symbol).",
                single_step,
                "interim 0, one symbol index 1 -> check index 2",
            ),
            (
                "checksum-baseline-19",
                "The 19 entropy indices 0..18 (Crockford `0123456789ABCDEFGHJ`); matches the account-number baseline canonical whose check char is `T` (index 26).",
                baseline,
                "indices 0..18 -> check index 26 (Crockford 'T')",
            ),
            (
                "checksum-all-high-19",
                "Nineteen copies of the highest index (31). Stress case far from the baseline.",
                all_high,
                "index 31 x19 -> check index per the frozen table",
            ),
        ];

        let mut dump = String::new();
        dump.push_str("{\n");
        dump.push_str("  \"schema\": \"damm32-table\",\n");
        dump.push_str("  \"protocol_version\": \"v0.1\",\n");
        dump.push_str("  \"spec_section\": \"account-number.md §4\",\n");
        dump.push_str("  \"description\": \"Pins the frozen Damm-32 order-32 quasigroup table (account-number.md §4.2) for cross-implementation byte-identity, plus running-checksum orientation cases. The table is GF(2⁵) ≅ GF(2)[x]/(x⁵+x²+1) with x∗y = α·(x⊕y) (α=2, reduction bitmask 0b100101=37) over Crockford-base32 indices. The literal table is the normative artifact; an independent port derives its table and diffs against expected_table_hex. Generated by `cargo test -p protocol --lib emit_damm32_table_vectors_for_paste -- --ignored`, with a mint-time cross-check against an independent transcription of the published srobo/damm32 (MIT) step.\",\n");
        dump.push_str("  \"cases\": [\n");

        // --- table case ---
        dump.push_str("    {\n");
        dump.push_str("      \"vector_id\": \"damm32-table/v0.1/canonical-table\",\n");
        dump.push_str("      \"description\": \"The full 1024-byte (32x32) frozen Damm-32 quasigroup table, row-major: byte (32*interim + symbol) is table[interim][symbol]. Each value is a Crockford-base32 index 0..31. A port derives its own table over GF(2⁵) and asserts byte-equality.\",\n");
        dump.push_str("      \"case_kind\": \"table\",\n");
        dump.push_str(&format!("      \"expected_table_hex\": \"{table_hex}\",\n"));
        dump.push_str("      \"informational_polynomial\": \"x^5 + x^2 + 1 (0b100101 = 37)\",\n");
        dump.push_str("      \"informational_alphabet\": \"0123456789ABCDEFGHJKMNPQRSTVWXYZ\",\n");
        dump.push_str("      \"informational_provenance\": \"matches published srobo/damm32 reference (MIT)\"\n");
        dump.push_str("    },\n");

        // --- checksum cases ---
        for (i, (slug, desc, indices, note)) in checksum_cases.iter().enumerate() {
            let check = damm32_checksum(indices);

            let indices_json = indices
                .iter()
                .map(|d| format!("{d}"))
                .collect::<alloc::vec::Vec<_>>()
                .join(", ");
            dump.push_str("    {\n");
            dump.push_str(&format!(
                "      \"vector_id\": \"damm32-table/v0.1/{slug}\",\n"
            ));
            dump.push_str(&format!("      \"description\": \"{desc}\",\n"));
            dump.push_str("      \"case_kind\": \"checksum\",\n");
            dump.push_str(&format!(
                "      \"input_entropy_indices\": [{indices_json}],\n"
            ));
            dump.push_str(&format!("      \"expected_check_index\": {check},\n"));
            dump.push_str(&format!("      \"informational_note\": \"{note}\"\n"));
            if i + 1 < checksum_cases.len() {
                dump.push_str("    },\n");
            } else {
                dump.push_str("    }\n");
            }
        }

        dump.push_str("  ]\n");
        dump.push_str("}\n");

        std::fs::write("/tmp/myne_damm32_table_vectors.json", dump.as_bytes())
            .expect("write damm32-table vectors dump");
        std::println!("{dump}");
    }
}
