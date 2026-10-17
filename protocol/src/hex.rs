// SPDX-License-Identifier: AGPL-3.0
//! The one lowercase-hex contract (myne-md/myne audit T6.10(c)).
//!
//! Hex rendering and its predicate were re-derived by hand in a dozen blob
//! families and a handful of client modules, and the copies had drifted on two
//! questions nobody had answered once:
//!
//!   * **the empty string**: some copies answered `true` (the vacuous reading —
//!     `.all()` over zero bytes is `true`), one answered `false` (a defensive
//!     `!s.is_empty()`). The divergence was masked because every caller checked
//!     the length first, so it was a difference waiting for a caller that does
//!     not.
//!   * **uppercase `A`–`F`**: the blob families reject it (a vault id travels
//!     as one spelling, lowercase, between two devices), while two queue-id
//!     families accept it on purpose (`protocol.md` §9.20.4 — a share/capture id
//!     is matched case-insensitively). So there is no single predicate; there is
//!     a strict one and, named apart from it, a lenient one.
//!
//! This module is the one place both questions are answered. It is deliberately
//! the lowest crate (`protocol` is a dependency of every other), so every client
//! and companion reaches the same implementation.
//!
//! **Semantics, pinned here and by the tests below:**
//!
//!   * [`is_lower_hex`] — accepts `0`–`9` and `a`–`f` only; an **empty** string
//!     is `true` (vacuous). A caller that requires non-empty must check the
//!     length itself, which every caller today does; making the length part of
//!     this predicate would give the two spellings two places to disagree.
//!   * [`is_ascii_hex_ci`] — accepts `A`–`F` as well; empty is `true`. This is
//!     the deliberately lenient spelling, and its name says so.
//!   * [`encode_lower`] — always emits lowercase `0`–`9`/`a`–`f`.

use alloc::string::String;

/// Render `bytes` as a lowercase hex string (two chars per byte, no separator).
///
/// The one encoder. A copy that used `alloc::format!("{:02x}")` per byte and one
/// that walked a `b"0123456789abcdef"` table produce identical output; keeping
/// both was a second place to be wrong for no gain.
pub fn encode_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0x0f) as usize] as char);
    }
    s
}

/// Strict: `0`–`9` and `a`–`f` only, uppercase rejected. An empty string is
/// `true` (see the module docs); callers needing non-empty check the length.
pub fn is_lower_hex(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Lenient: `0`–`9`, `a`–`f` and `A`–`F`. The deliberately case-insensitive
/// spelling (`protocol.md` §9.20.4's queue ids). An empty string is `true`.
pub fn is_ascii_hex_ci(s: &str) -> bool {
    s.bytes().all(|b| b.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_lower_is_lowercase_two_chars_per_byte() {
        assert_eq!(encode_lower(&[0x00, 0x0f, 0xa5, 0xff]), "000fa5ff");
        assert_eq!(encode_lower(&[]), "");
    }

    #[test]
    fn is_lower_hex_accepts_only_digits_and_lowercase_a_to_f() {
        assert!(is_lower_hex("00ff"));
        assert!(is_lower_hex("deadbeef"));
        // Uppercase is the strict predicate's refusal — the whole reason the
        // lenient one is a separate, named function.
        assert!(!is_lower_hex("DEADBEEF"));
        assert!(!is_lower_hex("0g"));
        assert!(!is_lower_hex("0x00"));
        assert!(!is_lower_hex(" "));
    }

    #[test]
    fn is_lower_hex_of_the_empty_string_is_true_but_vacuous() {
        // Pinned so the contract is a decision rather than an accident: the
        // empty string is `true`, and a caller that needs non-empty says so.
        assert!(is_lower_hex(""));
        assert!(is_ascii_hex_ci(""));
    }

    #[test]
    fn is_ascii_hex_ci_accepts_both_cases() {
        assert!(is_ascii_hex_ci("DEADbeef"));
        assert!(is_ascii_hex_ci("0123456789abcdefABCDEF"));
        assert!(!is_ascii_hex_ci("0g"));
        assert!(!is_ascii_hex_ci("0x00"));
    }
}
