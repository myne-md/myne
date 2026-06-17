// SPDX-License-Identifier: AGPL-3.0-or-later
//! Fuzz target: `parse_vault_meta` (`MYV1` vault.meta, spec §9.3).
//!
//! `data` is the untrusted `vault.meta` file. Single-arg parser (no keys) —
//! it validates magic/version/reserved/length and decomposes fixed-offset
//! fields before any key derivation. Invariant: never panic/abort; always
//! `Ok | Err`.
#![no_main]

use libfuzzer_sys::fuzz_target;

fuzz_target!(|data: &[u8]| {
    let _ = protocol::parse_vault_meta(data);
});
