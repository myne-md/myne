// SPDX-License-Identifier: AGPL-3.0
//! Fuzz target: `decode_note` (`MY01` per-note blob, spec §9.2).
//!
//! `data` is the untrusted on-disk `.myn` blob — exactly what an attacker
//! with disk/backup access controls. The keys are FIXED dummies: in the
//! zero-knowledge model the attacker does not know them, so the security-
//! relevant surface is the PRE-decrypt parsing (magic, length fields,
//! allocation sizing) that runs before the AEAD tag can ever verify.
//!
//! Invariant: no input may panic or abort (incl. OOM via a hostile length
//! field) — the decoder must always return `Ok | Err`.
#![no_main]

use libfuzzer_sys::fuzz_target;

const NOTE_UUID: [u8; 16] = [0x11; 16];
const ITEMS_KEY: [u8; 32] = [0x42; 32];
const ITEMS_KEY_ID: [u8; 16] = [0x22; 16];

fuzz_target!(|data: &[u8]| {
    let _ = protocol::decode_note(data, &NOTE_UUID, &ITEMS_KEY, &ITEMS_KEY_ID);
});
