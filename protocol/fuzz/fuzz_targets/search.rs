// SPDX-License-Identifier: AGPL-3.0-only
//! Fuzz target: `decode_search_index_blob` (`MYS1` vault.search, spec §9.6).
//!
//! `data` is the untrusted blob; key + account-number-hash are fixed dummies
//! (zero-knowledge: the attacker controls bytes, not keys). Surface under
//! test is the pre-decrypt 34-byte header parse. Invariant: never
//! panic/abort; always `Ok | Err`.
#![no_main]

use libfuzzer_sys::fuzz_target;

const KEY: [u8; 32] = [0x42; 32];
const ACCT_HASH: [u8; 16] = [0x07; 16];

fuzz_target!(|data: &[u8]| {
    let _ = protocol::decode_search_index_blob(&KEY, &ACCT_HASH, data);
});
