// SPDX-License-Identifier: AGPL-3.0
//! The browser's [`SyncTransport`] (phase3-web-client task 35).
//!
//! # The problem, and the measurement that settled it
//!
//! `SyncTransport::request` is **blocking** — its own doc says "wrap in
//! `spawn_blocking` from async code" — and a browser cannot block on `fetch`. So
//! porting SCRAM to the web was a choice between two very different costs:
//! make the whole trait async (a refactor across the sync engine, the shape of
//! the `VaultIo` work), or find a blocking HTTP call a Worker is allowed to
//! make.
//!
//! There is one: **synchronous `XMLHttpRequest` is legal in a dedicated
//! Worker.** The spec forbids setting `responseType` on a synchronous request in
//! a *document* environment, and whether a worker is exempt is the entire
//! question — so it was measured in Chromium rather than assumed:
//!
//! | probe | result |
//! |---|---|
//! | sync XHR (text) | 200 |
//! | sync XHR + `responseType = "arraybuffer"` | 200, bytes intact (`4D 59 30 31`) |
//! | sync POST with a body and a request header | 200, echoed |
//!
//! Binary bodies survive, which is what a sync engine that moves ciphertext
//! needs. The engine therefore ports unchanged.
//!
//! # "The browser fetch stack"
//!
//! The task's title means the browser's HTTP stack, not the `fetch()` API. Sync
//! XHR rides the identical stack: same connection pool, same CORS enforcement,
//! same TLS and trust store. Nothing here re-implements HTTP — that is the whole
//! point of using the browser's client instead of a socket.
//!
//! # What this deliberately does NOT do
//!
//! No certificate pinning and no channel binding — and task 84 asks for both to
//! be **structural** rather than defaulted, which they are:
//!
//! * **Pins cannot reach this type.** The factory core installs is
//!   `fn(host: &str, port: u16) -> Box<dyn SyncTransport>`; there is no
//!   parameter to pass a pin through and no field to store one in. A future
//!   change that wanted to silently accept pins would have to widen the factory
//!   signature, which is a visible edit in `myne-core`.
//! * **The exporter is empty because nothing overrides it.**
//!   `SyncTransport::request_bound_to_exporter` defaults to calling
//!   `build_body(&[])` — an empty exporter — and only `rustls_transport`
//!   overrides it. That file does not compile for `wasm32` at all, so on this
//!   target there is no code path that could produce a non-empty binding.
//!   Inherited rather than re-implemented, so the property holds by construction
//!   instead of by a copied `Ok(Vec::new())` somebody could later "fix".
//!
//! Both are decisions, not gaps: a page cannot pin a certificate or read TLS
//! exporter material, `decisions.md` 2026-07-26 records that as permanent, and
//! the threat model qualifies A4 per client. Task 36 is the server half — it
//! accepts unbound sessions without letting a bound client be downgraded.

use myne_core::plugins::sync::transport::{
    HttpMethod, SyncTransport, TransportError, TransportResponse, TransportResponseExt,
};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;

// The bridge `web/src/worker/sync-transport.ts` installs before the wasm module
// is instantiated. Synchronous by design — the whole point is that the call
// blocks the Worker thread, which is exactly what the trait's contract wants and
// exactly what a Worker is allowed to do.
#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = ["globalThis", "__myneSyncHttp"], js_name = request, catch)]
    fn sync_http_request(
        method: &str,
        url: &str,
        headers_json: &str,
        body: &[u8],
    ) -> Result<JsValue, JsValue>;
}

/// [`SyncTransport`] over the browser's HTTP stack.
///
/// Holds the origin rather than a connection: the browser owns pooling and
/// keep-alive, so unlike the native transports there is nothing here to cache or
/// to detect the death of.
#[derive(Debug, Clone)]
pub struct BrowserTransport {
    origin: String,
}

impl BrowserTransport {
    pub fn new(scheme: crate::sync_origin::Scheme, host: &str, port: u16) -> Self {
        Self {
            // Built by [`crate::sync_origin`], which is host-compiled so the
            // default-port rule is covered by `cargo test --workspace` rather
            // than only by a browser run.
            origin: crate::sync_origin::origin_for(scheme, host, port),
        }
    }

    fn call(
        &self,
        method: HttpMethod,
        path: &str,
        extra_headers: &[(&str, &str)],
        body: &[u8],
        token: Option<&str>,
    ) -> Result<TransportResponseExt, TransportError> {
        let verb = match method {
            HttpMethod::Get => "GET",
            HttpMethod::Post => "POST",
            HttpMethod::Put => "PUT",
            HttpMethod::Head => "HEAD",
        };

        // Headers as JSON rather than as a flattened list: the boundary already
        // carries JSON everywhere else (`Cargo.toml` records why nothing else
        // was admitted), and a name/value list packed into one string would need
        // an escaping rule this file would then own.
        let mut headers: Vec<(String, String)> = extra_headers
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        if let Some(t) = token {
            headers.push(("authorization".to_string(), format!("Bearer {t}")));
        }
        // `BadRequest` rather than a network error: a header list that will not
        // serialize is a bug in the caller, not a failure of the connection, and
        // the engine must not retry it.
        let headers_json =
            serde_json::to_string(&headers).map_err(|_| TransportError::BadRequest)?;

        let url = format!("{}{}", self.origin, path);
        let value = sync_http_request(verb, &url, &headers_json, body)
            // Every failure here is the browser refusing or the network dying:
            // a CORS rejection, a DNS failure, a TLS failure. They are
            // deliberately NOT distinguished — the engine's retry behaviour is
            // the same for all of them, and a page cannot tell them apart
            // reliably anyway (CORS failures are opaque by design).
            .map_err(|_| TransportError::Network)?;

        let status = js_sys::Reflect::get(&value, &JsValue::from_str("status"))
            .ok()
            .and_then(|v| v.as_f64())
            // A reply with no numeric status is the bridge misbehaving, not the
            // server — the JS side always sets it. Reported as `Network` so the
            // engine treats it as a failed attempt rather than a permanent
            // rejection of a well-formed request.
            .ok_or(TransportError::Network)? as u16;
        let body_bytes = js_sys::Reflect::get(&value, &JsValue::from_str("body"))
            .ok()
            .map(|v| js_sys::Uint8Array::new(&v).to_vec())
            .unwrap_or_default();
        let headers_out = js_sys::Reflect::get(&value, &JsValue::from_str("headers"))
            .ok()
            .and_then(|v| v.as_string())
            .and_then(|s| serde_json::from_str::<Vec<(String, String)>>(&s).ok())
            .unwrap_or_default();

        Ok(TransportResponseExt {
            status,
            body: body_bytes,
            headers: headers_out,
        })
    }
}

impl SyncTransport for BrowserTransport {
    fn request(
        &self,
        method: HttpMethod,
        path: &str,
        body: &[u8],
        token: Option<&str>,
    ) -> Result<TransportResponse, TransportError> {
        let r = self.call(method, path, &[], body, token)?;
        Ok(TransportResponse {
            status: r.status,
            body: r.body,
        })
    }

    fn request_ext(
        &self,
        method: HttpMethod,
        path: &str,
        extra_headers: &[(&str, &str)],
        body: &[u8],
        token: Option<&str>,
    ) -> Result<TransportResponseExt, TransportError> {
        self.call(method, path, extra_headers, body, token)
    }

    // `request_bound_to_exporter` is deliberately NOT overridden — see the
    // header. The trait's default binds to an empty exporter, which is the
    // correct and only possible answer here, and inheriting it is what makes
    // that structural rather than a line of code with a comment on it.

    // `open_sse` is left at the trait default (`Unsupported`) — permanently, not
    // pending. `SseStream` is a blocking socket reader plus a socket handle for
    // shutting it down from another thread, and a page has neither; the
    // browser's own primitive, `EventSource`, is push-based, so the only way to
    // fit it behind this signature would be an unbounded `SharedArrayBuffer`
    // ring fed by a second Worker — machinery whose entire purpose would be
    // making a callback look like a socket.
    //
    // The browser's poke channel is therefore not a transport method at all: JS
    // owns the `EventSource` and calls `SyncScheduler::on_poke`, the same entry
    // `poke_listener` reaches through its signal cell on desktop, so both
    // clients keep one scheduler and one set of poke semantics. Task 38 wires
    // it. `Unsupported` is also the RIGHT failure: it is the one variant a
    // caller can answer by falling back to polling, which is what the scheduler
    // already does.
    //
    // Pinned by `transport::default_binding_tests::
    // a_transport_that_overrides_nothing_reports_sse_unsupported` — asserting
    // the inherited default, because `wasm32` has no test runner here and the
    // default covers every implementation that inherits it.
}

/// Install this transport as the answer for `https`, and the browser's sleeper
/// (tasks 35 + 84).
///
/// Called once from the entry point, before any sync command can run. The
/// factory shape is core's: it learns that *something* answers for `https`, not
/// what a browser is.
///
/// The sleeper and the blocking waiter are installed **here rather than in their
/// own exports** on purpose.
/// They are needed by the same code path — the sync engine's retry backoff waits
/// between attempts made through this transport — and two separate installations
/// is one that can be forgotten. Core panics on an unset sleeper rather than
/// returning immediately, because a no-op sleep turns exponential backoff into a
/// hot retry loop against a server that is already rate-limiting.
pub fn install() {
    use myne_core::plugins::sync::http_transport::BrowserScheme;
    myne_core::plugins::sync::http_transport::set_browser_transport(|scheme, host, port| {
        // Core's scheme enum → this crate's. Two enums rather than one because
        // `sync_origin` is host-compiled (its tests run in `cargo test
        // --workspace`) while core's lives behind a `wasm32` cfg; the mapping is
        // total, so adding a variant on either side is a compile error here.
        let scheme = match scheme {
            BrowserScheme::Https => crate::sync_origin::Scheme::Https,
            BrowserScheme::LoopbackHttp => crate::sync_origin::Scheme::LoopbackHttp,
        };
        Box::new(BrowserTransport::new(scheme, host, port))
    });
    myne_core::task::set_sleeper(|duration| Box::pin(sleep_via_timeout(duration)));
    myne_core::task::set_blocking_waiter(block_via_atomics_wait);
}

/// Block this Worker for `duration` — `Atomics.wait` on a throwaway
/// `SharedArrayBuffer`.
///
/// # Why blocking is right here and yielding is right for [`sleep_via_timeout`]
///
/// This is the sync engine's retry backoff, which runs INSIDE a sync cycle. The
/// cycle is synchronous by design — the transport blocks, so the engine does —
/// and the Worker is already unavailable for the duration of the request that
/// just failed. Yielding here would buy no responsiveness and would require
/// making the engine's backoff helpers async, which is the decision the
/// synchronous transport deliberately closed.
///
/// # The dependency, which is already paid
///
/// `SharedArrayBuffer` requires **cross-origin isolation**, and this client
/// already requires it: `web/csp.ts` sends COOP `same-origin` + COEP, and
/// `docs/self-host-web.md` lists dropping either as a misconfiguration. So this
/// adds no deployment constraint — but it does mean a page served WITHOUT those
/// headers cannot back off, which is why the absence is a hard failure below
/// rather than a silent fallback to not waiting: a backoff that does not wait is
/// a hot retry loop against a server that is already rate-limiting.
fn block_via_atomics_wait(duration: std::time::Duration) {
    let millis = duration.as_millis().min(i32::MAX as u128) as f64;
    let global = js_sys::global();

    // `SharedArrayBuffer` and `Atomics` are looked up dynamically for the same
    // reason `setTimeout` is: no `web-sys`, and the exact JS expression stays
    // visible in the file a reviewer reads.
    let sab_ctor = js_sys::Reflect::get(&global, &JsValue::from_str("SharedArrayBuffer"))
        .ok()
        .and_then(|v| v.dyn_into::<js_sys::Function>().ok())
        .expect(
            "SharedArrayBuffer is unavailable — the page is not cross-origin isolated. \
             COOP `same-origin` + COEP are required (web/csp.ts, docs/self-host-web.md).",
        );
    let buffer =
        js_sys::Reflect::construct(&sab_ctor, &js_sys::Array::of1(&JsValue::from_f64(4.0)))
            .expect("SharedArrayBuffer(4)");
    let view = js_sys::Int32Array::new(&buffer);

    let atomics = js_sys::Reflect::get(&global, &JsValue::from_str("Atomics"))
        .expect("Atomics is a language built-in");
    let wait = js_sys::Reflect::get(&atomics, &JsValue::from_str("wait"))
        .ok()
        .and_then(|v| v.dyn_into::<js_sys::Function>().ok())
        .expect("Atomics.wait");

    // Index 0 holds 0, and we wait for it to stop being 0 — which never happens,
    // so the wait always ends by timeout. That is the point: this is a sleep
    // expressed as a wait nobody will wake.
    let args = js_sys::Array::of4(
        &view,
        &JsValue::from_f64(0.0),
        &JsValue::from_f64(0.0),
        &JsValue::from_f64(millis),
    );
    let _ = js_sys::Reflect::apply(&wait, &atomics, &args);
}

/// `setTimeout` as a future.
///
/// Not `Atomics.wait` and not a spin: this must yield the Worker's event loop.
/// The whole reason the transport may block is that a *request* is a bounded
/// operation the engine is waiting on anyway — a backoff is not, and holding the
/// thread for 2 seconds of retry delay would stop the Worker answering commands
/// for 2 seconds.
async fn sleep_via_timeout(duration: std::time::Duration) {
    let millis = duration.as_millis().min(i32::MAX as u128) as i32;
    let promise = js_sys::Promise::new(&mut |resolve, _reject| {
        let global = js_sys::global();
        // `setTimeout` on the worker global. Looked up dynamically rather than
        // imported, so this file needs no `web-sys` — the same reasoning that
        // kept `web-sys` out of the CSPRNG bridge.
        if let Ok(set_timeout) = js_sys::Reflect::get(&global, &JsValue::from_str("setTimeout")) {
            if let Ok(f) = set_timeout.dyn_into::<js_sys::Function>() {
                let _ = f.call2(&global, &resolve, &JsValue::from_f64(millis as f64));
            }
        }
    });
    let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
}
