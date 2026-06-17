// SPDX-License-Identifier: AGPL-3.0-or-later
//! Fuzz target: `decode_attachments_catalog` (`MYC1` vault.attachments, spec §9.10).
//!
//! Untrusted blob + fixed dummy key/hash. Pre-decrypt 34-byte header parse is
//! the surface; post-decrypt it tolerates unknown fields (§9.10.2), which a
//! valid seed would exercise. Invariant: never panic/abort; always `Ok | Err`.
#![no_main]

use libfuzzer_sys::fuzz_target;

const KEY: [u8; 32] = [0x42; 32];
const ACCT_HASH: [u8; 16] = [0x07; 16];

fuzz_target!(|data: &[u8]| {
    let _ = protocol::decode_attachments_catalog(&KEY, &ACCT_HASH, data);
});
