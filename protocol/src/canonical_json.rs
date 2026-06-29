// SPDX-License-Identifier: AGPL-3.0

//! Shared canonical-JSON emit primitives (`docs/spec/protocol.md` § 9.5.2).
//!
//! The string escaper + decimal-integer encoders are **load-bearing for
//! cross-implementation byte-stability** — every canonical-JSON blob (the
//! `vault.prefs` codec in [`crate::prefs`] and the `SavedView` codec in
//! [`crate::saved_view`]) must escape strings and emit integers identically.
//! Single-homing them here keeps that contract auditable in one place rather
//! than risking silent divergence across two hand-rolled encoders.

use alloc::vec::Vec;

/// Append `s` as a JSON string literal (with surrounding quotes), escaping `"`,
/// `\`, and C0 control chars per RFC 8259. `/` is left unescaped (canonical).
/// Non-control characters pass through as UTF-8.
pub(crate) fn push_json_string(out: &mut Vec<u8>, s: &str) {
    out.push(b'"');
    for ch in s.chars() {
        match ch {
            '"' => out.extend_from_slice(b"\\\""),
            '\\' => out.extend_from_slice(b"\\\\"),
            '\u{08}' => out.extend_from_slice(b"\\b"),
            '\u{0c}' => out.extend_from_slice(b"\\f"),
            '\n' => out.extend_from_slice(b"\\n"),
            '\r' => out.extend_from_slice(b"\\r"),
            '\t' => out.extend_from_slice(b"\\t"),
            c if (c as u32) < 0x20 => {
                let code = c as u32;
                out.extend_from_slice(b"\\u00");
                out.push(hex_nibble((code >> 4) as u8));
                out.push(hex_nibble((code & 0xF) as u8));
            }
            c => {
                let mut buf = [0u8; 4];
                out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
            }
        }
    }
    out.push(b'"');
}

fn hex_nibble(n: u8) -> u8 {
    match n {
        0..=9 => b'0' + n,
        _ => b'a' + (n - 10),
    }
}

/// Append `n` as a canonical decimal integer — the `u64` form for epoch-seconds
/// fields (`last_backup_at`). `u64::MAX` is 20 digits. `n == 0` emits `"0"`.
pub(crate) fn push_json_uint64(out: &mut Vec<u8>, n: u64) {
    let mut buf = [0u8; 20];
    let mut i = buf.len();
    let mut v = n;
    loop {
        i -= 1;
        buf[i] = b'0' + (v % 10) as u8;
        v /= 10;
        if v == 0 {
            break;
        }
    }
    out.extend_from_slice(&buf[i..]);
}

/// Append `n` as a canonical decimal integer (no leading zeros, no trailing
/// `.0` — spec § 9.5.2). Delegates to [`push_json_uint64`] so the hand-rolled
/// digit loop stays single-homed (one audit surface for the canonical-decimal
/// contract).
pub(crate) fn push_json_uint(out: &mut Vec<u8>, n: u32) {
    push_json_uint64(out, u64::from(n));
}

#[cfg(test)]
#[cfg_attr(coverage_nightly, coverage(off))]
mod tests {
    use super::*;
    use alloc::string::String;
    use alloc::vec::Vec;

    fn string_of(s: &str) -> String {
        let mut out = Vec::new();
        push_json_string(&mut out, s);
        // The escaper only ever emits valid UTF-8.
        String::from_utf8(out).expect("escaper emits UTF-8")
    }

    #[test]
    fn plain_ascii_is_quoted_verbatim() {
        assert_eq!(string_of("hello"), "\"hello\"");
        assert_eq!(string_of(""), "\"\"");
    }

    #[test]
    fn quote_and_backslash_are_escaped() {
        assert_eq!(string_of("a\"b"), "\"a\\\"b\"");
        assert_eq!(string_of("a\\b"), "\"a\\\\b\"");
    }

    #[test]
    fn named_c0_escapes_match_rfc8259() {
        // backspace, form-feed, newline, carriage return, tab each get the
        // short two-char escape rather than the \u00XX long form.
        assert_eq!(string_of("\u{08}"), "\"\\b\"");
        assert_eq!(string_of("\u{0c}"), "\"\\f\"");
        assert_eq!(string_of("\n"), "\"\\n\"");
        assert_eq!(string_of("\r"), "\"\\r\"");
        assert_eq!(string_of("\t"), "\"\\t\"");
    }

    #[test]
    fn other_control_chars_use_lowercase_u00xx() {
        // NUL →  exercises the low-nibble 0..=9 branch of hex_nibble;
        // U+001F →  exercises the a..f branch (0xF nibble).
        assert_eq!(string_of("\u{00}"), "\"\\u0000\"");
        assert_eq!(string_of("\u{1f}"), "\"\\u001f\"");
        assert_eq!(string_of("\u{01}"), "\"\\u0001\"");
    }

    #[test]
    fn forward_slash_is_left_unescaped() {
        // Canonical form does NOT escape `/` (spec § 9.5.2).
        assert_eq!(string_of("a/b"), "\"a/b\"");
    }

    #[test]
    fn multibyte_utf8_passes_through() {
        // Non-control codepoints (incl. >1 byte) are copied verbatim.
        assert_eq!(string_of("é→𐍈"), "\"é→𐍈\"");
    }

    fn uint64_of(n: u64) -> String {
        let mut out = Vec::new();
        push_json_uint64(&mut out, n);
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn uint64_zero_and_boundaries() {
        assert_eq!(uint64_of(0), "0");
        assert_eq!(uint64_of(7), "7");
        assert_eq!(uint64_of(10), "10");
        assert_eq!(uint64_of(1_700_000_000), "1700000000");
        // u64::MAX is exactly 20 digits — fills the fixed buffer.
        assert_eq!(uint64_of(u64::MAX), "18446744073709551615");
    }

    #[test]
    fn uint32_delegates_to_uint64() {
        let mut a = Vec::new();
        push_json_uint(&mut a, u32::MAX);
        assert_eq!(String::from_utf8(a).unwrap(), "4294967295");
    }
}
