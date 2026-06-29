// SPDX-License-Identifier: AGPL-3.0
//! Fuzz target: `decode_prefs_blob` (`MYP1` vault.prefs, spec §9.5).
//!
//! Untrusted blob + fixed dummy key/hash. Pre-decrypt 34-byte header parse is
//! the surface. Invariant: never panic/abort; always `Ok | Err`.
#![no_main]

use libfuzzer_sys::fuzz_target;

const KEY: [u8; 32] = [0x42; 32];
const ACCT_HASH: [u8; 16] = [0x07; 16];

fuzz_target!(|data: &[u8]| {
    let _ = protocol::decode_prefs_blob(&KEY, &ACCT_HASH, data);
});
