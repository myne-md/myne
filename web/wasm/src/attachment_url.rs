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

use std::cell::RefCell;
use std::collections::HashMap;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

thread_local! {
    /// `attachment_id_hex → blob: URL`, for the unlocked session only.
    ///
    /// `thread_local!` rather than a `static` because this Worker is
    /// single-threaded and the values are `JsValue`-derived `String`s minted
    /// against this global scope — there is no second thread that could hold a
    /// meaningful entry.
    static MINTED: RefCell<HashMap<String, String>> = RefCell::new(HashMap::new());
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
pub fn cached(id: &str) -> Option<String> {
    MINTED.with(|m| m.borrow().get(id).cloned())
}

/// Mint a `blob:` URL for `bytes` served as `content_type`, cache it under `id`,
/// and return it. A second call for the same id returns the cached URL and mints
/// nothing — one `Blob` per attachment per session, not one per render.
pub fn mint(id: &str, content_type: &str, bytes: &[u8]) -> String {
    if let Some(url) = cached(id) {
        return url;
    }
    let url = js_mint(bytes, content_type);
    MINTED.with(|m| m.borrow_mut().insert(id.to_string(), url.clone()));
    url
}

/// Revoke and forget every URL this session minted.
///
/// Called from the lock path. Revoking releases the `Blob`, which is the only
/// way the decrypted bytes behind it become collectable — an object URL is a GC
/// root, so "the page dropped its reference" frees nothing.
///
/// Idempotent, and deliberately infallible: this runs during teardown, where a
/// failure has nowhere useful to go and must not stop the rest of the wipe.
pub fn revoke_all() {
    MINTED.with(|m| {
        for (_, url) in m.borrow_mut().drain() {
            js_revoke(&url);
        }
    });
}

/// How many URLs are live. Diagnostics + tests only.
pub fn live_count() -> usize {
    MINTED.with(|m| m.borrow().len())
}
