// SPDX-License-Identifier: AGPL-3.0
//! Fuzz target: `decode_attachment_blob` (`MYA1` per-attachment, spec §9.9).
//!
//! `data` is the untrusted attachment blob; attachment_id, content_type,
//! items_key, items_key_id are fixed dummies (zero-knowledge: attacker owns
//! bytes, not keys). `content_type` is AAD-bound, so the surface under test is
//! the pre-decrypt header parse + length sizing. Invariant: never panic/abort;
//! always `Ok | Err`.
#![no_main]

use libfuzzer_sys::fuzz_target;

const ATTACHMENT_ID: [u8; 32] = [0x33; 32];
const CONTENT_TYPE: &[u8] = b"application/octet-stream";
const ITEMS_KEY: [u8; 32] = [0x42; 32];
const ITEMS_KEY_ID: [u8; 16] = [0x22; 16];

fuzz_target!(|data: &[u8]| {
    let _ = protocol::decode_attachment_blob(
        data,
        &ATTACHMENT_ID,
        CONTENT_TYPE,
        &ITEMS_KEY,
        &ITEMS_KEY_ID,
    );
});
