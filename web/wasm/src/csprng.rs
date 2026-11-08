// SPDX-License-Identifier: AGPL-3.0
//! The wasm CSPRNG: `getrandom`'s `custom` backend, bound to
//! `crypto.getRandomValues` (phase3-web-client task 81).
//!
//! # What this file is load-bearing for
//!
//! `protocol/AGENTS.md`: *"Nonce reuse is catastrophic — `getrandom` is the only
//! acceptable source for nonces in v0.1. There is no counter-mode fallback."*
//! Every write path in the product draws from here: the per-note
//! `content_nonce` (`blob.rs`), an attachment's key plus its two nonces
//! (`attachment_blob.rs`), the catalog nonce (`attachments_catalog.rs`), account
//! numbers (`account_number.rs`), and `vault_change_password`'s `fresh_salt` +
//! `fresh_nonce`. A weak stream here is not a degraded feature; it is a broken
//! AEAD.
//!
//! # Why `custom` and not getrandom's `js` feature
//!
//! Task 9 chose `custom` so that **`protocol/` never gains a wasm-bindgen
//! dependency** — the primitive crate keeps exactly one auditable entropy
//! decision instead of a codegen layer. `scripts/wasm-csprng-check.sh` asserts
//! that: wasm-bindgen absent from `protocol`'s wasm graph, and the
//! `__getrandom_custom` symbol present-but-**UNDEFINED** in the getrandom rlib.
//! Undefined is the property that matters — it means the final link must resolve
//! it *here* or fail. There is no default, no fallback, and no silent zero
//! stream.
//!
//! # Why the fill is unconditional and not cached
//!
//! No handle is cached, no `OnceCell` guards the lookup, and nothing is drawn at
//! init to "warm" anything. Each call reaches the live global. Caching would buy
//! a negligible lookup and cost the one property worth having: if `crypto` is
//! ever unreachable, **every** draw fails, rather than the first one succeeding
//! and a later one silently reusing state.
//!
//! # Failure is closed
//!
//! `getRandomValues` throws on a hostile or broken host (no secure context, a
//! request over the 65 536-byte per-call quota). Anything thrown becomes
//! `getrandom::Error::UNSUPPORTED`, which surfaces in `protocol` as
//! `ProtocolError::Csprng` and aborts the operation. Nothing falls back.

use js_sys::Uint8Array;
use wasm_bindgen::prelude::*;

// `crypto.getRandomValues` is reached through a hand-declared import rather than
// `web-sys`. Two reasons: `web_sys::Crypto` would admit a whole third crate for
// one method, and — more usefully — this makes the exact JS expression being
// called visible in the file that depends on it, which is what a reviewer of a
// nonce source needs to see.
//
// `globalThis` rather than `window` or `self`: this code runs in a **dedicated
// Worker**, where `window` does not exist. `globalThis` is the one spelling
// correct in both, so the same module works if it is ever instantiated on the
// main thread (a test harness, task 105's browser runner).
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = ["globalThis", "crypto"], js_name = getRandomValues, catch)]
    fn crypto_get_random_values(buf: &Uint8Array) -> Result<Uint8Array, JsValue>;
}

/// The per-call byte ceiling the Web Crypto specification puts on
/// `getRandomValues`. A request above it throws `QuotaExceededError`.
///
/// Chunking rather than erroring: a caller asking for more is not doing anything
/// wrong, and 65 536 bytes is far above anything in this product (the largest
/// single draw is a 32-byte key). The loop exists so that a future caller cannot
/// discover this limit as a runtime failure on one browser.
const MAX_BYTES_PER_CALL: usize = 65_536;

/// The registered `getrandom` backend.
///
/// # Why the round-trip through a JS-side buffer
///
/// `getRandomValues` fills its argument **in place**, so the natural shape would
/// be to hand it a view over wasm linear memory. That is deliberately not done:
/// a view is invalidated if wasm memory grows, and the fill happens across the
/// JS boundary where an allocation on the other side is possible. Allocating the
/// `Uint8Array` on the JS heap and copying back is a few hundred nanoseconds per
/// draw and cannot alias a stale buffer.
///
/// # Clearing the JS-side buffer
///
/// The copy back leaves a twin of the draw on the JS object heap, which the GC
/// frees without wiping. Most draws on the dispatched web surface are public by
/// construction (nonces, `change_password`'s fresh salt), but `note_create` /
/// `note_update` draw a per-note `item_key` and `attachment_import` draws a
/// per-attachment `attachment_key` — key material whose wasm-side copy is
/// `Zeroizing`. So the buffer is overwritten before it is dropped.
///
/// **What this is not.** It is defence-in-depth hygiene against process-memory /
/// forensic capture — the residual `agent-tooling/docs/threat-model.md` §7 already defers — and
/// not a spec requirement; no normative text asks for it. It does **not** restore
/// parity with the wasm-side `Zeroizing` discipline: a GC that already moved the
/// typed array's backing store leaves a copy `fill` cannot reach. It is also not
/// the last word on web memory hygiene — `web/src/worker/worker.ts`'s
/// `JSON.stringify(args)` leaves an unzeroable JS-string copy of the master
/// password on every unlock, which nothing here touches. And it is not an
/// A15/TB11 mitigation: a substituted bundle already owns the realm and the typed
/// master password, and a freed `ArrayBuffer` backing store is unreachable from
/// page JS regardless.
fn fill_from_web_crypto(dest: &mut [u8]) -> Result<(), getrandom::Error> {
    for chunk in dest.chunks_mut(MAX_BYTES_PER_CALL) {
        // `new_with_length` takes u32; the chunk is bounded by
        // MAX_BYTES_PER_CALL, so the cast cannot truncate.
        let buf = Uint8Array::new_with_length(chunk.len() as u32);
        crypto_get_random_values(&buf).map_err(|_| getrandom::Error::UNSUPPORTED)?;
        // `copy_to` panics on a length mismatch, which cannot happen here —
        // `buf` was created at `chunk.len()` and `getRandomValues` fills in
        // place without resizing.
        buf.copy_to(chunk);
        // AFTER the copy, never before — this is the wipe, not the fill.
        buf.fill(0, 0, buf.length());
    }
    Ok(())
}

getrandom::register_custom_getrandom!(fill_from_web_crypto);
