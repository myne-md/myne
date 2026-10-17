// SPDX-License-Identifier: AGPL-3.0
//! Test-only formatting helpers shared by the `#[ignore]`-gated
//! `emit_*_vectors_for_paste` / `emit_*_parse_fail_vectors` vector generators
//! across the crate's modules.
//!
//! These exist purely so the byte-level test-vector emitters can render bytes
//! as lowercase hex and JSON-escape strings without each generator re-defining
//! the same two helpers. The module is compiled only under `#[cfg(test)]`
//! (via its gated `mod` decl in `lib.rs`), so it never enters product builds.
//!
//! The crate is `#![no_std]` + `alloc`, hence the explicit `alloc::` paths.

/// Render `bytes` as a lowercase hex string (two chars per byte, no separator).
///
/// Delegates to the crate's one encoder ([`crate::hex::encode_lower`]) rather
/// than carrying a second `alloc::format!("{:02x}")` implementation: two copies
/// of a rendering helper are two places to be wrong for no gain.
pub(crate) fn hex_lower(bytes: &[u8]) -> alloc::string::String {
    crate::hex::encode_lower(bytes)
}

/// JSON-escape `input` per RFC 8259 (quote, backslash, the named control
/// escapes, and `\u00xx` for the remaining C0 controls).
pub(crate) fn json_escape(input: &str) -> alloc::string::String {
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
