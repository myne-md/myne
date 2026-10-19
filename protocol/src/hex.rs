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

/// Decode exactly `N` bytes of hex, **strictly** (lowercase only).
///
/// # Why the decoders are here and not beside their callers
///
/// The two predicates above were unified and the DECODERS were not, so four
/// hand-written `fn hex_decode_16`-shaped helpers grew across `core/` and two of
/// them disagreed about the case of the same 32-character id space. Measured
/// (Aşama 3, R1.2): `sync::devices::hex16` accepted `A`–`F` while
/// `sync::orchestrator::from_hex16` rejected it, so one id was recognised on one
/// path and read as absent on the other. Nothing panicked and nothing errored:
/// the caller got `None`, which reads as "no such thing" rather than as "your
/// spelling is wrong".
///
/// The pair is named, so a call site that picks one says so. `_lower` is the
/// strict spelling and is what own-writer data wants — an id this client minted
/// travels lowercase, and a second accepted spelling is a second identity for one
/// blob. `_ci` is for a value that arrived from elsewhere and whose case is not
/// this client's to fix.
pub fn decode_lower<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 || !is_lower_hex(s) {
        return None;
    }
    decode_pairs(s)
}

/// Decode exactly `N` bytes of hex, **leniently** (`A`–`F` accepted).
///
/// The lenient half of [`decode_lower`], and its name says which policy a caller
/// chose. See that function for why both exist.
pub fn decode_ci<const N: usize>(s: &str) -> Option<[u8; N]> {
    if s.len() != N * 2 || !is_ascii_hex_ci(s) {
        return None;
    }
    decode_pairs(s)
}

/// Decode a variable-length lowercase-hex string (strict, even length).
///
/// The `Vec` sibling of [`decode_lower`], for a value whose width is not a
/// compile-time constant: vector fixtures, and any call site that decodes a whole
/// record rather than one id. Same policy as its fixed-width twin, so a caller
/// does not grow a fourth hand-written nibble walk.
pub fn decode_lower_vec(s: &str) -> Option<alloc::vec::Vec<u8>> {
    if !s.len().is_multiple_of(2) || !is_lower_hex(s) {
        return None;
    }
    let mut out = alloc::vec::Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    for pair in bytes.chunks_exact(2) {
        let hi = (pair[0] as char).to_digit(16)?;
        let lo = (pair[1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
    }
    Some(out)
}

/// The shared body, reached only after a predicate and a byte-length gate have
/// passed.
///
/// **The length gate is also the panic guard, and it is why this is not folded
/// into the two callers:** a name whose bytes are hex but whose UTF-8 is not
/// ASCII (a multibyte character cannot be, so this is defensive) would land an
/// index mid-character. `is_lower_hex`/`is_ascii_hex_ci` reject any byte above
/// `0x7f` before a slice is taken.
fn decode_pairs<const N: usize>(s: &str) -> Option<[u8; N]> {
    let mut out = [0u8; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
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

#[cfg(test)]
mod decode_tests {
    use super::*;
    use alloc::format;

    /// The two policies, side by side, on the same input. This is the assertion
    /// Aşama 3's R1.2 exists for: an id one decoder accepts and the other refuses
    /// is a silent `None` on one path, not an error.
    #[test]
    fn the_two_decoders_disagree_about_case_on_purpose() {
        let upper = "AABBCCDDEEFF00112233445566778899";
        let lower = "aabbccddeeff00112233445566778899";
        let expected: [u8; 16] = [
            0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77,
            0x88, 0x99,
        ];
        assert_eq!(decode_ci::<16>(upper), Some(expected));
        assert_eq!(decode_ci::<16>(lower), Some(expected));
        assert_eq!(decode_lower::<16>(lower), Some(expected));
        assert_eq!(
            decode_lower::<16>(upper),
            None,
            "the strict spelling is the point of having two"
        );
    }

    #[test]
    fn a_wrong_length_is_none_for_both() {
        assert_eq!(decode_lower::<16>("aabb"), None);
        assert_eq!(decode_ci::<16>("aabb"), None);
        // Empty passes both PREDICATES (vacuously) and fails both length gates.
        assert_eq!(decode_lower::<16>(""), None);
        assert_eq!(decode_ci::<16>(""), None);
    }

    #[test]
    fn a_non_hex_byte_is_none_and_never_panics() {
        // The panic guard: a multibyte name must fail the predicate before any
        // slice is taken. `é` is two bytes, both above 0x7f.
        let multibyte = format!("{}é", "a".repeat(30));
        assert_eq!(decode_lower::<16>(&multibyte), None);
        assert_eq!(decode_ci::<16>(&multibyte), None);
    }
}
