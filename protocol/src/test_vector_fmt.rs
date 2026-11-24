// SPDX-License-Identifier: AGPL-3.0-only
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

/// A deterministic `CryptoRng` for the `_raw` surfaces that demand caller
/// randomness: identical inputs every run, so a fixture is reproducible and a
/// vector is stable.
///
/// **Test-only by construction and never a production source.** It is seeded
/// from a counter and a SHA-256, not from entropy, so passing it to anything on
/// a real path would violate the `_raw` contract the crate documents (all
/// callers supply CSPRNG-grade bytes). It lives here rather than in one test
/// module because more than one does: `person_invite` and `vault_meta_ntv7`
/// both seal through the person-key envelope.
pub(crate) struct SeededRng(u64);

impl SeededRng {
    pub(crate) fn new(seed: u64) -> Self {
        Self(seed)
    }
}

impl rand_core::TryRng for SeededRng {
    type Error = core::convert::Infallible;

    // All three arms route through the filler, so the generator is ONE stream.
    // The first version returned a constant 0 from these two while advancing the
    // counter in `try_fill_bytes`, which meant a caller that asked for a `u64`
    // silently got degenerate all-zero material and a caller that asked for more
    // than 32 bytes panicked on the slice (myne-md/myne#911 review). Neither is
    // reachable today; both would be frozen as "the format's behaviour" by the
    // first vector that used them.
    fn try_next_u32(&mut self) -> Result<u32, Self::Error> {
        let mut buf = [0u8; 4];
        self.try_fill_bytes(&mut buf)?;
        Ok(u32::from_le_bytes(buf))
    }

    fn try_next_u64(&mut self) -> Result<u64, Self::Error> {
        let mut buf = [0u8; 8];
        self.try_fill_bytes(&mut buf)?;
        Ok(u64::from_le_bytes(buf))
    }

    fn try_fill_bytes(&mut self, dst: &mut [u8]) -> Result<(), Self::Error> {
        use sha2::Digest as _;
        // A counter per 32-byte BLOCK, so any length works: a 64-byte fill (the
        // shape the person plane's seed uses, `d || z`) is two blocks rather than
        // a panic.
        for (i, chunk) in dst.chunks_mut(32).enumerate() {
            let ctr = self.0.wrapping_add(i as u64 + 1);
            let digest = sha2::Sha256::digest(ctr.to_le_bytes());
            chunk.copy_from_slice(&digest[..chunk.len()]);
        }
        self.0 = self.0.wrapping_add(dst.len().div_ceil(32) as u64);
        Ok(())
    }
}

impl rand_core::TryCryptoRng for SeededRng {}
