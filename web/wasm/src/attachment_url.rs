// SPDX-License-Identifier: AGPL-3.0
//! Object URLs for decrypted attachments (phase3-web-client task 44).
//!
//! # Why the bytes stop here
//!
//! The desktop serves an attachment through a custom `attachment://` protocol:
//! the Rust handler decrypts in memory and streams an allowlisted, re-sniffed
//! type. A browser has no custom protocol, so the bytes have to become something
//! an `<img src>` accepts — and the only such thing that does not weaken the CSP
//! is a **`blob:` URL**.
//!
//! The important part is *where* it is minted. It is minted **in the Worker**,
//! and the URL string — not the bytes — is what crosses back. That is forced
//! rather than preferred: [`crate::outcome::Outcome`] is a JSON string, and a
//! 64 MiB attachment base64s to roughly 85 MiB of string to build, copy and
//! parse, per render. `URL.createObjectURL` is available in a dedicated worker,
//! so the `Blob` is created next to the plaintext that produced it and only a
//! ~50-byte handle is serialized.
//!
//! # Why `blob:` and not `data:`
//!
//! Task 44's criterion is that the CSP admit these "without admitting remote or
//! `data:` content", and the two are not interchangeable. A `data:` URL carries
//! its payload inline, so `img-src data:` admits **any** bytes any script can
//! construct — including from an injected string. A `blob:` URL is an opaque
//! same-origin handle to an object this origin already holds; it cannot be
//! forged from a string, and it dies when revoked. So `img-src 'self' blob:` is
//! a narrower policy than `img-src 'self' data:`, not a looser one.
//!
//! # Lifetime is the session, and revocation is not optional
//!
//! An object URL keeps its `Blob` alive until `revokeObjectURL` is called — the
//! GC cannot collect it, because the URL is a root. So an unrevoked URL is
//! **decrypted plaintext pinned in memory for the life of the page**, which is
//! exactly what locking the vault is supposed to end. [`revoke_all`] runs on
//! lock, beside the slot zeroize.
//!
//! The cache is keyed by attachment id and is what makes the URL stable across
//! re-renders: minting a fresh URL per render would leak one `Blob` per render
//! of the same image.
//!
//! # The budget (myne#388)
//!
//! Session lifetime is the right *policy* and was, on its own, an unbounded one:
//! three thumbnail surfaces each derived their warm set from a catalog query, so
//! opening the attachment library decrypted every attachment in the vault and
//! pinned each as a GC root for the rest of the unlocked session — painted or
//! not. Resident decrypted plaintext scaled with vault size rather than with
//! what was on screen, against the weaker of the two auto-lock windows.
//!
//! So the map is bounded by [`MAX_PINNED_BYTES`] and evicts least-recently-used,
//! with [`cached`] as the recency signal (the router consults it before every
//! decrypt, which makes it exactly "this attachment is still being rendered").
//!
//! Eviction is **two-sided**: the page holds its own copy of the URL strings, so
//! the ids come back on the mint response and the page drops them
//! (`web/src/platform/attachment-cache.ts`). A string left behind there is a
//! dead handle, and painting one shows a broken image — which reads to a user as
//! corruption rather than as "not ready".
//!
//! **This is the only place the footprint is actually bounded.** The caller-side
//! window in `src/components/attachments/useWarmAttachmentRefs.ts` is what keeps
//! eviction rare; it is not what makes it safe. A bound held only by callers is
//! precisely the shape that failed here three times over.

use std::cell::{Cell, RefCell};
use std::collections::HashMap;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

/// One live object URL and what it costs.
struct Pinned {
    url: String,
    /// Plaintext bytes the `Blob` behind `url` holds alive.
    bytes: usize,
    /// Monotonic tick of the mint or the last [`cached`] hit. LRU order.
    used: u64,
}

/// The ceiling on decrypted attachment plaintext this session may keep pinned.
///
/// Argued against the per-attachment import cap rather than picked round: the
/// budget MUST be at least `MAX_ATTACHMENT_LEN`, or a single legal attachment
/// could never fit — the eviction loop would drain the whole map and still be
/// over budget on every mint, revoking the tile the user is looking at. Four
/// times it leaves room for a screenful of ordinary images without evicting
/// anything, so eviction only ever reaches what scrolled away.
pub const MAX_PINNED_BYTES: usize = 4 * protocol::MAX_ATTACHMENT_LEN;

thread_local! {
    /// `attachment_id_hex → the live URL and its accounting`, for the unlocked
    /// session only.
    ///
    /// `thread_local!` rather than a `static` because this Worker is
    /// single-threaded and the values are `JsValue`-derived `String`s minted
    /// against this global scope — there is no second thread that could hold a
    /// meaningful entry.
    static MINTED: RefCell<HashMap<String, Pinned>> = RefCell::new(HashMap::new());

    /// Sum of every entry's `bytes`. Carried rather than derived: summing the
    /// map on every mint is O(n) for a number each insertion already knows.
    static LIVE_BYTES: Cell<usize> = const { Cell::new(0) };

    /// Monotonic tick source for `Pinned::used`. Never compared across
    /// sessions, so it is not reset by `revoke_all`.
    static CLOCK: Cell<u64> = const { Cell::new(0) };
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
extern "C" {
    /// `URL.createObjectURL(new Blob([bytes], { type }))`, installed by the
    /// Worker host.
    ///
    /// A JS bridge rather than `web_sys::Url::create_object_url_with_blob`
    /// because the `Blob` constructor needs a `BlobPropertyBag` and a JS array
    /// of views; going through one small host function keeps that DOM-shaped
    /// assembly on the JS side, the same division every other seam in this crate
    /// uses (`myne-core` gains no JS glue, and this crate gains no DOM plumbing
    /// it would then have to keep in step with `web_sys` versions).
    #[wasm_bindgen(js_namespace = ["globalThis", "__myneAttachmentUrl"], js_name = mint)]
    fn js_mint(bytes: &[u8], content_type: &str) -> String;

    /// `URL.revokeObjectURL(url)`.
    #[wasm_bindgen(js_namespace = ["globalThis", "__myneAttachmentUrl"], js_name = revoke)]
    fn js_revoke(url: &str);
}

// ── the host arm ─────────────────────────────────────────────────────────────
//
// This module is compiled natively too, and that is a routing decision rather
// than a convenience: `dispatch.rs` keeps its match ARMS un-gated even when only
// their implementations are target-specific, because the router-agreement test
// runs on the host and "a wasm-only arm is a routing decision no gate in
// `pre-push` can see". Gating the arm would have made a host run fall through to
// `NotPorted`, which is the answer for a command that is not implemented — not
// for one being compiled for a target it does not run on.
//
// Neither function below is reachable on a host build, and the reason is
// structural rather than hopeful: the router reaches `mint` only after
// `attachment_serve_from_host` succeeds, and that resolves its vault directory
// through `NoopHost`, which refuses. So the command produces a real `Io` failure
// long before either of these — asserted by
// `attachment_object_url_is_an_io_failure_on_a_host_build`.
#[cfg(not(target_arch = "wasm32"))]
fn js_mint(_bytes: &[u8], _content_type: &str) -> String {
    unreachable!("object URLs require a browser; the serve path fails first on a host build")
}

#[cfg(not(target_arch = "wasm32"))]
fn js_revoke(_url: &str) {
    // A no-op rather than `unreachable!`: `revoke_all` runs on EVERY lock,
    // including a host-run one, and it iterates an empty map there. Panicking
    // would turn "nothing to revoke" into a crash on the lock path.
}

/// The cached URL for `id`, or `None` if this session has not minted one.
///
/// Also the LRU **touch point**, which is why this stayed a function rather than
/// becoming a map read at the call site: `dispatch.rs` consults it before every
/// decrypt, so a hit here is the signal "this attachment is still being
/// rendered". Without promotion on the cache-hit path the eviction order
/// degrades to insertion order and throws away the tile on screen.
pub fn cached(id: &str) -> Option<String> {
    MINTED.with(|m| {
        let mut map = m.borrow_mut();
        let entry = map.get_mut(id)?;
        entry.used = tick();
        Some(entry.url.clone())
    })
}

/// Next monotonic tick.
fn tick() -> u64 {
    CLOCK.with(|c| {
        let next = c.get().wrapping_add(1);
        c.set(next);
        next
    })
}

/// What one mint produced, and what it cost to make room.
#[derive(serde::Serialize)]
pub struct Minted {
    pub url: String,
    /// Ids whose URL was revoked to stay inside the budget. The page holds its
    /// own copy of these strings and must drop them — see
    /// `web/src/platform/attachment-cache.ts`.
    pub evicted: Vec<String>,
}

/// Record a freshly-minted URL, evicting least-recently-used entries until the
/// result fits the budget. Revocation happens here, so an evicted `Blob` is
/// released at the same instant its id leaves the map.
///
/// Never evicts the entry being inserted — it is not in the map yet — and always
/// terminates: the loop stops when the map is empty, and
/// `MAX_PINNED_BYTES >= MAX_ATTACHMENT_LEN` guarantees one attachment fits once
/// it is.
///
/// The least-recently-used entry is found by linear scan. `n` is bounded by the
/// budget, and a heap keyed on a field that mutates on every read would be more
/// machinery than the thing it orders.
fn remember(id: &str, url: String, bytes: usize) -> Vec<String> {
    let mut evicted = Vec::new();
    MINTED.with(|m| {
        let mut map = m.borrow_mut();
        let mut live = LIVE_BYTES.with(|b| b.get());
        while live + bytes > MAX_PINNED_BYTES && !map.is_empty() {
            let Some(victim) = map
                .iter()
                .min_by_key(|(_, p)| p.used)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some(p) = map.remove(&victim) {
                js_revoke(&p.url);
                live = live.saturating_sub(p.bytes);
                evicted.push(victim);
            }
        }
        map.insert(
            id.to_string(),
            Pinned {
                url,
                bytes,
                used: tick(),
            },
        );
        LIVE_BYTES.with(|b| b.set(live.saturating_add(bytes)));
    });
    evicted
}

/// Mint a `blob:` URL for `bytes` served as `content_type`, cache it under `id`,
/// and return it. A second call for the same id returns the cached URL and mints
/// nothing — one `Blob` per attachment per session, not one per render.
pub fn mint(id: &str, content_type: &str, bytes: &[u8]) -> Minted {
    if let Some(url) = cached(id) {
        return Minted {
            url,
            evicted: Vec::new(),
        };
    }
    let url = js_mint(bytes, content_type);
    let evicted = remember(id, url.clone(), bytes.len());
    Minted { url, evicted }
}

/// Revoke and forget every URL this session minted.
///
/// Called from the lock path. Revoking releases the `Blob`, which is the only
/// way the decrypted bytes behind it become collectable — an object URL is a GC
/// root, so "the page dropped its reference" frees nothing.
///
/// Idempotent, and deliberately infallible: this runs during teardown, where a
/// failure has nowhere useful to go and must not stop the rest of the wipe.
///
/// Resets the byte accounting in the same pass. A stale non-zero counter would
/// make the next session evict against bytes nobody holds, shrinking the usable
/// budget after every lock/unlock cycle until nothing could be pinned at all.
pub fn revoke_all() {
    MINTED.with(|m| {
        for (_, p) in m.borrow_mut().drain() {
            js_revoke(&p.url);
        }
    });
    LIVE_BYTES.with(|b| b.set(0));
}

/// How many URLs are live. Diagnostics + tests only.
pub fn live_count() -> usize {
    MINTED.with(|m| m.borrow().len())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Sizes are passed as a `usize` and never allocated, so a test at the
    /// budget costs nothing. `revoke_all()` first because the state is
    /// `thread_local!` and the harness reuses threads.
    fn fresh() {
        revoke_all();
    }

    #[test]
    fn the_budget_evicts_least_recently_used_until_it_fits() {
        fresh();
        let half = MAX_PINNED_BYTES / 2;
        assert!(remember("a", "blob:a".into(), half).is_empty());
        assert!(remember("b", "blob:b".into(), half).is_empty());
        // Touch `a`, so `b` is the least recently used.
        assert_eq!(cached("a").as_deref(), Some("blob:a"));

        let evicted = remember("c", "blob:c".into(), half);
        assert_eq!(evicted, vec!["b".to_string()], "the LRU entry goes");
        assert_eq!(live_count(), 2);
        assert!(cached("b").is_none(), "and it really left the map");
        assert!(cached("a").is_some(), "the one being looked at survives");
    }

    #[test]
    fn a_single_attachment_at_the_import_cap_always_fits() {
        // The relation that makes the eviction loop terminating, checked at
        // COMPILE time rather than only argued in a comment: below it, one legal
        // attachment could never fit and every mint would drain the map and
        // still be over. (A runtime `assert!` here is a constant expression and
        // clippy rightly refuses it.)
        const _: () = assert!(MAX_PINNED_BYTES >= protocol::MAX_ATTACHMENT_LEN);
        fresh();
        remember("big", "blob:big".into(), protocol::MAX_ATTACHMENT_LEN);
        assert_eq!(live_count(), 1);
        assert_eq!(cached("big").as_deref(), Some("blob:big"));
    }

    #[test]
    fn a_repeat_mint_evicts_nothing() {
        // The cache property, through the new return type: one `Blob` per
        // attachment per session, not one per render.
        fresh();
        remember("a", "blob:a".into(), 16);
        let again = mint("a", "image/png", b"ignored - the cache answers first");
        assert_eq!(again.url, "blob:a");
        assert!(again.evicted.is_empty());
        assert_eq!(live_count(), 1);
    }

    #[test]
    fn revoke_all_resets_the_byte_accounting() {
        // A stale counter would shrink the usable budget after every
        // lock/unlock cycle until nothing could be pinned at all.
        fresh();
        remember("big", "blob:big".into(), MAX_PINNED_BYTES);
        revoke_all();
        assert_eq!(live_count(), 0);
        let evicted = remember("next", "blob:next".into(), MAX_PINNED_BYTES);
        assert!(
            evicted.is_empty(),
            "a full-budget entry must fit again after a lock"
        );
        assert_eq!(live_count(), 1);
    }
}
