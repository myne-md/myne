// SPDX-License-Identifier: AGPL-3.0-or-later

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
