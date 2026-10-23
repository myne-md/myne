// SPDX-License-Identifier: AGPL-3.0
//! The sync transport seam (SYNC-3, MYND-424 task 3; real impl is task 2).
//!
//! A blind relay (TB5) speaks a deliberately tiny contract: send opaque bytes
//! to a path under a bearer token, get a status + opaque bytes back. The engine
//! (tasks 5/6) builds request bodies and parses responses *above* this seam;
//! the transport knows nothing of heads, manifests, or cursors. That keeps the
//! one place that touches TLS small and reviewable.
//!
//! The **real** implementation — raw rustls with cert-pinning (A4) + the
//! tls-exporter for SCRAM channel binding (SYNC-3) — is task 2, which is R3-gated
//! and blocked on the `rustls` dependency decision (a security decision the user
//! owns). Until it lands, the engine builds and unit-tests against
//! [`FakeTransport`]; the MYND-428 harness drives the loopback HTTP server
//! through the same trait. Calls are **blocking**; the engine's tokio loop wraps
//! them in `spawn_blocking` (avoids an `async-trait` dependency for the seam).

use std::collections::HashMap;
// The HTTP wire vocabulary lives in `core::http` since ai-ollama-local task 1.
// Re-exported here so sync's ~290 references are untouched by the move.
pub use crate::http::{HttpMethod, TransportError, TransportResponse, TransportResponseExt};

use std::sync::Mutex;

impl TransportResponseExt {
    /// First header value with the given (lowercase) name.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

/// A transport that names the vault on every sync request
/// (myne-md/myne#911 task 8).
///
/// A person-born (`NTV7`) vault has no vault SCRAM account: its namespace is
/// `vault.meta`'s random binding and the credential is the person token, so the
/// namespace has to travel WITH the request rather than inside the bearer. The
/// server's rule (task 7) is an optional `?account=<account_number_hash>` on the
/// sync routes, refused with `403` when the caller is not bound to that vault.
///
/// # Why a transport wrapper rather than a parameter on every engine call
///
/// The engine's four request builders (`pull_page`, `download_blob`,
/// `download_blobs`, `push`) are called from ~15 places in the orchestrator,
/// every one of which already threads a token and would have to thread a second
/// string through the same depth. The namespace is a property of the CONVERSATION
/// (this transport, this vault), not of any individual call, so it belongs here:
/// wrap once where the vault is known and the whole cycle inherits it.
///
/// # What it touches, and what it deliberately does not
///
/// The vault-scoped paths are rewritten: everything under `/sync/`, the three
/// `/attachments/` routes, and `/vault.meta` (publishing is exactly
/// `PUT /vault.meta?account=<binding>`). `/auth/*` is NOT: a SCRAM handshake is
/// about the account the credential names.
///
/// The attachment routes belong here and used to be left out, on the claim that
/// "the byte transport carries its selector itself". It does not: the upload and
/// download paths are built from the id alone, so a person session's attachment
/// bytes were stored in the PERSON's namespace and no other device could ever
/// fetch them (myne-md/myne#911 review). The server now authorizes the same
/// parameter against the membership table on those routes.
pub struct NamespacedTransport<'a> {
    inner: &'a dyn SyncTransport,
    namespace: &'a str,
}

impl<'a> NamespacedTransport<'a> {
    /// Wrap `inner` so its sync requests name `namespace`.
    pub fn new(inner: &'a dyn SyncTransport, namespace: &'a str) -> Self {
        Self { inner, namespace }
    }

    /// The rewrite itself, and the reason it is a function: one place decides
    /// which paths are vault-scoped.
    fn scoped(path: &str, namespace: &str) -> String {
        if !(path.starts_with("/sync/")
            || path.starts_with("/attachments/")
            || path == "/vault.meta")
        {
            return path.to_string();
        }
        let sep = if path.contains('?') { '&' } else { '?' };
        format!("{path}{sep}account={namespace}")
    }
}

impl SyncTransport for NamespacedTransport<'_> {
    fn request(
        &self,
        method: HttpMethod,
        path: &str,
        body: &[u8],
        token: Option<&str>,
    ) -> Result<TransportResponse, TransportError> {
        self.inner
            .request(method, &Self::scoped(path, self.namespace), body, token)
    }

    fn request_ext(
        &self,
        method: HttpMethod,
        path: &str,
        extra_headers: &[(&str, &str)],
        body: &[u8],
        token: Option<&str>,
    ) -> Result<TransportResponseExt, TransportError> {
        self.inner.request_ext(
            method,
            &Self::scoped(path, self.namespace),
            extra_headers,
            body,
            token,
        )
    }

    fn open_sse(
        &self,
        path: &str,
        token: &str,
        read_timeout: std::time::Duration,
    ) -> Result<SseStream, SseOpenError> {
        // The poke channel is per namespace as well: the server keys it on the
        // account the request resolves to.
        self.inner
            .open_sse(&Self::scoped(path, self.namespace), token, read_timeout)
    }
}

/// The blind-relay transport contract. One method: issue a request with an
/// optional per-device bearer token, get a status + opaque body.
pub trait SyncTransport: Send + Sync {
    /// Issue a request to `path` (e.g. `/v1/pull`) with `body` and an optional
    /// per-device token. Blocking; wrap in `spawn_blocking` from async code.
    fn request(
        &self,
        method: HttpMethod,
        path: &str,
        body: &[u8],
        token: Option<&str>,
    ) -> Result<TransportResponse, TransportError>;

    /// Header-aware variant for the `/attachments/{id}` byte-transport
    /// (MYND-468): sends `extra_headers` on the request (e.g. `Range`) and
    /// surfaces the response headers (`X-Uploaded-Length`, `X-Complete`,
    /// `Content-Range`). The default implementation delegates to [`Self::request`]
    /// — correct only for callers that need no headers, so the real transports
    /// override it; the default exists to keep the seam additive.
    fn request_ext(
        &self,
        method: HttpMethod,
        path: &str,
        extra_headers: &[(&str, &str)],
        body: &[u8],
        token: Option<&str>,
    ) -> Result<TransportResponseExt, TransportError> {
        let _ = extra_headers;
        let r = self.request(method, path, body, token)?;
        Ok(TransportResponseExt {
            status: r.status,
            body: r.body,
            headers: Vec::new(),
        })
    }

    /// Open a long-lived streaming GET (the `/sync/poke` SSE channel). Returns
    /// after the response head is read and the status checked (200 → the live
    /// stream, 401 → [`SseOpenError::Unauthorized`]). `read_timeout` is the
    /// dead-connection detector — set above the server's heartbeat cadence.
    /// Default: unsupported (the [`FakeTransport`] / any test double).
    ///
    /// **The browser inherits this default permanently** (phase3-web-client task
    /// 84), and that is a decision rather than an unfinished port. [`SseStream`]
    /// is a *blocking byte reader over a socket* plus a socket handle to shut it
    /// down from another thread; a page has neither, and the browser's own
    /// primitive for this — `EventSource` — is push-based, so wrapping it behind
    /// a blocking signature would mean buffering an unbounded stream across a
    /// `SharedArrayBuffer` and a second Worker to feed it. That machinery would
    /// exist only to make a callback look like a socket.
    ///
    /// So the browser's poke channel is not a transport method at all: JS holds
    /// the `EventSource` and calls
    /// [`super::loop_control::SyncScheduler::on_poke`] — the same entry point
    /// `poke_listener` reaches on desktop through its signal cell, which is why
    /// the two clients still share one scheduler and one set of poke semantics
    /// (`sync-protocol.md` §8.3). Wiring and reconnect are task 38's.
    fn open_sse(
        &self,
        path: &str,
        token: &str,
        read_timeout: std::time::Duration,
    ) -> Result<SseStream, SseOpenError> {
        let _ = (path, token, read_timeout);
        Err(SseOpenError::Unsupported)
    }

    /// Send a request whose body is bound to the RFC 9266 `tls-exporter` of the
    /// connection it is sent on — the SCRAM client-final channel binding (F5).
    /// Opens a connection, computes the exporter, hands it to `build_body` (which
    /// embeds it in client-final), then sends that body on the SAME connection, so
    /// the server — computing the exporter over the connection the final arrives on
    /// — sees the identical value. The closure shape is required because the body
    /// depends on the exporter, which depends on the connection. Default: an EMPTY
    /// exporter — correct for the [`FakeTransport`]/any non-TLS double AND for a
    /// proxy-terminated deployment, where the server likewise binds to empty. Only
    /// the real TLS transport overrides this to compute a live exporter.
    fn request_bound_to_exporter(
        &self,
        method: HttpMethod,
        path: &str,
        token: Option<&str>,
        label: &[u8],
        out_len: usize,
        build_body: &dyn Fn(&[u8]) -> Vec<u8>,
    ) -> Result<TransportResponse, TransportError> {
        let _ = (label, out_len);
        let body = build_body(&[]);
        self.request(method, path, &body, token)
    }
}

/// A live SSE stream (the `/sync/poke` change-notification channel): a
/// buffered reader over the (TLS-decrypted) response bytes positioned right
/// after the response head, whether the body is chunk-framed (a reverse proxy
/// streams SSE chunked), and a `try_clone` of the raw TCP socket so the owner
/// can `shutdown()` it from another thread to unblock a blocking read.
pub struct SseStream {
    /// Byte stream positioned at the first body byte.
    pub reader: Box<dyn std::io::BufRead + Send>,
    /// `Transfer-Encoding: chunked` — the bytes need de-framing (production
    /// sits behind a reverse proxy that streams SSE chunked).
    pub chunked: bool,
    /// Shutdown handle (a `try_clone` of the underlying socket).
    pub socket: std::net::TcpStream,
}

/// Why an SSE stream could not be opened.
#[derive(Debug)]
pub enum SseOpenError {
    /// The server rejected the token (401) — the caller must park, not spin.
    Unauthorized,
    /// Transport-level failure (connect / TLS / head read) — reconnect with
    /// backoff.
    Transport(TransportError),
    /// This transport cannot stream (the [`FakeTransport`] default).
    Unsupported,
}

/// A request the [`FakeTransport`] observed:
/// `(method, path, body, token, extra_headers)`.
pub type SeenRequest = (
    HttpMethod,
    String,
    Vec<u8>,
    Option<String>,
    Vec<(String, String)>,
);

/// In-memory transport for unit tests and the harness's pre-wired responses.
/// Maps `"<METHOD> <path>"` to a canned [`TransportResponseExt`]; records the
/// requests it saw so tests can assert on them. Not used in production.
#[derive(Default)]
pub struct FakeTransport {
    responses: Mutex<HashMap<String, TransportResponseExt>>,
    seen: Mutex<Vec<SeenRequest>>,
    configured: bool,
}

impl FakeTransport {
    /// A configured fake (requests are answered from the canned map).
    pub fn new() -> Self {
        Self {
            responses: Mutex::new(HashMap::new()),
            seen: Mutex::new(Vec::new()),
            configured: true,
        }
    }

    /// An unconfigured fake — every request fails `NotConfigured` (models a
    /// client with no endpoint set, SYNC-14).
    pub fn unconfigured() -> Self {
        Self {
            configured: false,
            ..Default::default()
        }
    }

    fn key(method: HttpMethod, path: &str) -> String {
        let m = match method {
            HttpMethod::Get => "GET",
            HttpMethod::Post => "POST",
            HttpMethod::Put => "PUT",
            HttpMethod::Head => "HEAD",
            HttpMethod::Delete => "DELETE",
        };
        alloc_format(m, path)
    }

    /// Pre-load a canned response for `method path`.
    pub fn on(&self, method: HttpMethod, path: &str, status: u16, body: Vec<u8>) {
        self.on_ext(method, path, status, body, Vec::new());
    }

    /// Pre-load a canned response with response headers for `method path`
    /// (the attachment byte-transport probes read `X-Uploaded-Length` etc.).
    /// Header names are stored lowercased, mirroring the real codec.
    pub fn on_ext(
        &self,
        method: HttpMethod,
        path: &str,
        status: u16,
        body: Vec<u8>,
        headers: Vec<(String, String)>,
    ) {
        let headers = headers
            .into_iter()
            .map(|(n, v)| (n.to_ascii_lowercase(), v))
            .collect();
        self.responses.lock().unwrap().insert(
            Self::key(method, path),
            TransportResponseExt {
                status,
                body,
                headers,
            },
        );
    }

    /// The requests this fake has received, in order.
    pub fn requests(&self) -> Vec<SeenRequest> {
        self.seen.lock().unwrap().clone()
    }

    /// Answer `POST /sync/blobs` with `404`, modelling a server that predates the
    /// batch route (myne-md/myne#240) — the fallback-to-single-blob path.
    pub fn without_blob_batch(&self) {
        self.on(HttpMethod::Post, BLOB_BATCH_PATH, 404, b"{}".to_vec());
    }

    /// Synthesize a `POST /sync/blobs` response from the per-blob `GET
    /// /sync/blob?id=<hex>` entries a test already canned.
    ///
    /// Without this, every test that cans single-blob GETs would break the moment
    /// the pull loop started batching — the map is keyed on the exact
    /// `"<METHOD> <path>"`, so the batch request would miss and come back
    /// `TransportError::Network`, which is not the 404 that triggers the fallback.
    /// Synthesizing keeps each canned status meaning exactly what it meant on the
    /// single route (`404` → `not_found`, `410` → `blob_reclaimed`, anything else
    /// → `internal`), and **a missing entry fails the WHOLE batch with
    /// `Network`** — precisely what the single route would have returned for that
    /// id, so no test silently changes shape.
    ///
    /// An explicit `on(Post, "/sync/blobs", …)` still wins: that is how the
    /// adversarial batch shapes (an id in both arrays, an id in neither, an entry
    /// with empty bytes) get tested at all, since no single-blob canning can
    /// express them.
    fn synthesize_blob_batch(&self, body: &[u8]) -> Result<TransportResponseExt, TransportError> {
        #[derive(serde::Deserialize)]
        struct Req {
            #[serde(default)]
            blob_ids_hex: Vec<String>,
        }
        let req: Req = serde_json::from_slice(body).map_err(|_| TransportError::BadRequest)?;
        let responses = self.responses.lock().unwrap();
        let mut blobs = Vec::new();
        let mut omitted = Vec::new();
        for id_hex in &req.blob_ids_hex {
            let key = Self::key(HttpMethod::Get, &format!("/sync/blob?id={id_hex}"));
            let Some(canned) = responses.get(&key) else {
                return Err(TransportError::Network);
            };
            match canned.status {
                200 => {
                    // Re-use the single-blob body's own `ciphertext_b64` verbatim,
                    // so a test that canned junk or an empty string still delivers
                    // exactly that through the batch shape.
                    let v: serde_json::Value = serde_json::from_slice(&canned.body)
                        .map_err(|_| TransportError::BadRequest)?;
                    let ct = v
                        .get("ciphertext_b64")
                        .and_then(|c| c.as_str())
                        .unwrap_or_default()
                        .to_string();
                    blobs.push(serde_json::json!({
                        "blob_id_hex": id_hex,
                        "ciphertext_b64": ct,
                    }));
                }
                404 => omitted
                    .push(serde_json::json!({ "blob_id_hex": id_hex, "error_code": "not_found" })),
                410 => omitted.push(
                    serde_json::json!({ "blob_id_hex": id_hex, "error_code": "blob_reclaimed" }),
                ),
                other => {
                    // A canned 429 must stay a 429 for the WHOLE batch: it is the
                    // one status the caller retries rather than skips, and turning
                    // it into a per-id omission would silently drop the record.
                    if other == 429 {
                        return Ok(TransportResponseExt {
                            status: 429,
                            body: b"{}".to_vec(),
                            headers: Vec::new(),
                        });
                    }
                    omitted.push(
                        serde_json::json!({ "blob_id_hex": id_hex, "error_code": "internal" }),
                    );
                }
            }
        }
        Ok(TransportResponseExt {
            status: 200,
            body: serde_json::to_vec(&serde_json::json!({ "blobs": blobs, "omitted": omitted }))
                .unwrap_or_default(),
            headers: Vec::new(),
        })
    }
}

/// The batch-fetch route (myne-md/myne#240). Named once so the fake, the engine
/// and the test decorators cannot disagree about it — and, critically, so a
/// path-PREFIX match against the single-blob route is never mistaken for a match
/// against this one.
pub const BLOB_BATCH_PATH: &str = "/sync/blobs";

fn alloc_format(method: &str, path: &str) -> String {
    let mut s = String::with_capacity(method.len() + 1 + path.len());
    s.push_str(method);
    s.push(' ');
    s.push_str(path);
    s
}

impl SyncTransport for FakeTransport {
    fn request(
        &self,
        method: HttpMethod,
        path: &str,
        body: &[u8],
        token: Option<&str>,
    ) -> Result<TransportResponse, TransportError> {
        self.request_ext(method, path, &[], body, token)
            .map(|r| TransportResponse {
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
        if !self.configured {
            return Err(TransportError::NotConfigured);
        }
        self.seen.lock().unwrap().push((
            method,
            path.to_string(),
            body.to_vec(),
            token.map(|t| t.to_string()),
            extra_headers
                .iter()
                .map(|(n, v)| (n.to_string(), v.to_string()))
                .collect(),
        ));
        if let Some(canned) = self
            .responses
            .lock()
            .unwrap()
            .get(&Self::key(method, path))
            .cloned()
        {
            return Ok(canned);
        }
        // Only the batch route falls back to synthesis, and only when nothing was
        // canned for it explicitly.
        if method == HttpMethod::Post && path == BLOB_BATCH_PATH {
            return self.synthesize_blob_batch(body);
        }
        Err(TransportError::Network)
    }
}

/// Test-only fault-injection decorator: wraps any [`SyncTransport`] and fails
/// the next `n` matching requests (path-prefix match; empty prefix = every
/// request), then heals and forwards transparently — fail-next-N, fail-by-path
/// and N-fail-then-recover in one struct. Faults apply to `request` AND
/// `request_ext` (both explicitly overridden — the trait's `request_ext`
/// default would tunnel through the decorator's `request` and drop headers on
/// the healed path); `open_sse` / exporter-bound requests forward untouched.
#[cfg(test)]
#[derive(Clone, Copy)]
pub(crate) enum FaultMode {
    /// Fail below HTTP (`TransportError::Network`) — the offline/socket shape.
    Network,
    /// Serve a synthetic empty-body HTTP status (e.g. 429/500 bursts).
    Http(u16),
}

#[cfg(test)]
pub(crate) struct FaultInjectingTransport {
    inner: Box<dyn SyncTransport>,
    path_prefix: String,
    fail_remaining: std::sync::atomic::AtomicU32,
    mode: FaultMode,
}

#[cfg(test)]
impl FaultInjectingTransport {
    /// Fail the next `n` requests regardless of path.
    #[allow(dead_code)]
    pub(crate) fn fail_next(inner: Box<dyn SyncTransport>, n: u32, mode: FaultMode) -> Self {
        Self::fail_path(inner, "", n, mode)
    }

    /// Fail the next `n` requests whose path starts with `prefix`.
    pub(crate) fn fail_path(
        inner: Box<dyn SyncTransport>,
        prefix: &str,
        n: u32,
        mode: FaultMode,
    ) -> Self {
        FaultInjectingTransport {
            inner,
            path_prefix: prefix.to_string(),
            fail_remaining: std::sync::atomic::AtomicU32::new(n),
            mode,
        }
    }

    /// Consume one fault charge iff the path matches and charges remain.
    fn take_fault(&self, path: &str) -> Option<FaultMode> {
        use std::sync::atomic::Ordering;
        if !path.starts_with(&self.path_prefix) {
            return None;
        }
        // fetch_update: decrement only while > 0 (no underflow race).
        self.fail_remaining
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |v| v.checked_sub(1))
            .ok()
            .map(|_| self.mode)
    }
}

#[cfg(test)]
impl SyncTransport for FaultInjectingTransport {
    fn request(
        &self,
        method: HttpMethod,
        path: &str,
        body: &[u8],
        token: Option<&str>,
    ) -> Result<TransportResponse, TransportError> {
        match self.take_fault(path) {
            Some(FaultMode::Network) => Err(TransportError::Network),
            Some(FaultMode::Http(status)) => Ok(TransportResponse {
                status,
                body: Vec::new(),
            }),
            None => self.inner.request(method, path, body, token),
        }
    }

    fn request_ext(
        &self,
        method: HttpMethod,
        path: &str,
        extra_headers: &[(&str, &str)],
        body: &[u8],
        token: Option<&str>,
    ) -> Result<TransportResponseExt, TransportError> {
        match self.take_fault(path) {
            Some(FaultMode::Network) => Err(TransportError::Network),
            Some(FaultMode::Http(status)) => Ok(TransportResponseExt {
                status,
                body: Vec::new(),
                headers: Vec::new(),
            }),
            None => self
                .inner
                .request_ext(method, path, extra_headers, body, token),
        }
    }

    fn open_sse(
        &self,
        path: &str,
        token: &str,
        read_timeout: std::time::Duration,
    ) -> Result<SseStream, SseOpenError> {
        self.inner.open_sse(path, token, read_timeout)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fake_returns_canned_and_records_requests() {
        let t = FakeTransport::new();
        t.on(HttpMethod::Post, "/v1/pull", 200, b"sync-meta".to_vec());

        let resp = t
            .request(HttpMethod::Post, "/v1/pull", b"cursor:0", Some("tok"))
            .unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.body, b"sync-meta");

        let seen = t.requests();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].1, "/v1/pull");
        assert_eq!(seen[0].3.as_deref(), Some("tok"));
    }

    #[test]
    fn unknown_route_is_network_error() {
        let t = FakeTransport::new();
        assert_eq!(
            t.request(HttpMethod::Get, "/v1/nope", b"", None),
            Err(TransportError::Network)
        );
    }

    #[test]
    fn unconfigured_fails_fast() {
        let t = FakeTransport::unconfigured();
        assert_eq!(
            t.request(HttpMethod::Get, "/v1/pull", b"", None),
            Err(TransportError::NotConfigured)
        );
    }
}

#[cfg(test)]
mod default_binding_tests {
    use super::*;

    /// A transport that overrides nothing — the shape every non-TLS
    /// implementation has, including the browser's (`web/wasm/src/sync_transport.rs`).
    struct Bare(std::sync::Mutex<Vec<u8>>);

    impl SyncTransport for Bare {
        fn request(
            &self,
            _method: HttpMethod,
            _path: &str,
            body: &[u8],
            _token: Option<&str>,
        ) -> Result<TransportResponse, TransportError> {
            *self.0.lock().expect("probe mutex") = body.to_vec();
            Ok(TransportResponse {
                status: 200,
                body: Vec::new(),
            })
        }
    }

    /// The default channel binding is EMPTY, and a transport that overrides
    /// nothing gets it.
    ///
    /// This is the client half of the rule task 36 states server-side, and the
    /// property phase3-web-client task 84 asks to hold **structurally**: a
    /// browser cannot read TLS exporter material, so the only correct binding
    /// there is the empty one. It is correct because the sole override lives in
    /// `rustls_transport`, which does not compile for `wasm32` — not because
    /// somebody wrote `Ok(Vec::new())` in the browser arm, which a later change
    /// could "fix" into something wrong.
    #[test]
    fn a_transport_that_overrides_nothing_binds_to_an_empty_exporter() {
        let t = Bare(std::sync::Mutex::new(Vec::new()));
        let seen: std::sync::Mutex<Option<Vec<u8>>> = std::sync::Mutex::new(None);
        let build = |exporter: &[u8]| -> Vec<u8> {
            *seen.lock().expect("probe mutex") = Some(exporter.to_vec());
            b"client-final".to_vec()
        };

        t.request_bound_to_exporter(
            HttpMethod::Post,
            "/auth/scram/final",
            None,
            b"label",
            32,
            &build,
        )
        .expect("bare transport answers");

        assert_eq!(
            seen.lock().expect("probe mutex").as_deref(),
            Some(&[][..]),
            "the default must hand the body builder an EMPTY exporter"
        );
        assert_eq!(
            &*t.0.lock().expect("probe mutex"),
            b"client-final",
            "and must still send the body the builder produced"
        );
    }

    /// A transport that overrides nothing **cannot stream**, and says so.
    ///
    /// The browser's is exactly that transport. Task 84's acceptance criterion
    /// names `open_sse`, and this is the answer: it is permanently absent there,
    /// because [`SseStream`] is a blocking socket reader and a page has no
    /// socket. The property that matters is that the absence is LOUD — a
    /// `SyncTransport` that could not stream but returned an empty stream, or
    /// reported [`SseOpenError::Transport`], would make the poke listener
    /// reconnect forever against a transport that will never support it.
    /// [`SseOpenError::Unsupported`] is the one variant a caller can react to by
    /// falling back to polling, which is precisely what the scheduler does (the
    /// module doc's "polling is the fallback cadence").
    ///
    /// Pinned here rather than in the browser crate for the same reason the
    /// binding test is: `wasm32` has no test runner in this repo, and asserting
    /// the DEFAULT covers every implementation that inherits it — including one
    /// that does not exist yet.
    #[test]
    fn a_transport_that_overrides_nothing_reports_sse_unsupported() {
        let t = Bare(std::sync::Mutex::new(Vec::new()));
        match t.open_sse("/sync/poke", "tok", std::time::Duration::from_secs(30)) {
            Err(SseOpenError::Unsupported) => {}
            Err(other) => panic!(
                "the default must be Unsupported — a caller distinguishes it from \
                 a retryable failure; got {other:?}"
            ),
            Ok(_) => {
                panic!("a transport with no streaming implementation must not return a stream")
            }
        }
    }
}

/// Ceiling on a sync response body. **Paired with
/// `orchestrator::FETCH_WINDOW_MAX_BYTES` — raise one, re-read the other.**
///
/// It stays here rather than moving into `core::http` because it is a *sync*
/// bound, not an HTTP one: the shared codec takes its cap from the caller
/// precisely so an AI response is never silently held to a number chosen for
/// batch blob fetches (ai-ollama-local task 1).
pub(crate) const MAX_SYNC_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;

#[cfg(test)]
mod namespaced_tests {
    use super::*;

    /// What the wrapper must touch, and what it must not (myne-md/myne#911
    /// task 8). The sync routes and `/vault.meta` are vault-scoped; the SCRAM
    /// handshake and the attachment byte-transport are not, and adding a
    /// selector to either would authenticate or address the wrong thing.
    #[test]
    fn only_vault_scoped_paths_learn_the_namespace() {
        let ns = "0102030405060708090a0b0c0d0e0f10";
        assert_eq!(
            NamespacedTransport::scoped("/sync/push", ns),
            format!("/sync/push?account={ns}")
        );
        // An existing query keeps its own separator, or the cursor would be lost.
        assert_eq!(
            NamespacedTransport::scoped("/sync/pull?cursor=7", ns),
            format!("/sync/pull?cursor=7&account={ns}")
        );
        assert_eq!(
            NamespacedTransport::scoped("/vault.meta", ns),
            format!("/vault.meta?account={ns}")
        );
        // The attachment routes are vault-scoped too: their bytes belong to the
        // vault namespace, not to the person's own one (myne-md/myne#911 review).
        for scoped in ["/attachments/ab", "/attachments/ab?offset=0&total=8"] {
            assert_eq!(
                NamespacedTransport::scoped(scoped, ns),
                if scoped.contains('?') {
                    format!("{scoped}&account={ns}")
                } else {
                    format!("{scoped}?account={ns}")
                }
            );
        }
        for untouched in ["/auth/scram/init", "/auth/scram/final"] {
            assert_eq!(NamespacedTransport::scoped(untouched, ns), untouched);
        }
    }

    /// The wrapper really rewrites the request it forwards, end to end through
    /// the seam rather than only in the helper: a fake transport records what it
    /// was asked for.
    #[test]
    fn the_wrapped_transport_forwards_the_scoped_path() {
        let fake = FakeTransport::new();
        let ns = "aabbccddeeff00112233445566778899";
        // The fake answers per exact path, which is what makes this an assertion
        // about the path: a canned response on the SCOPED path can only be found
        // if the wrapper rewrote it.
        fake.on(
            HttpMethod::Post,
            &format!("/sync/push?account={ns}"),
            200,
            b"{}".to_vec(),
        );
        let wrapped = NamespacedTransport::new(&fake, ns);
        wrapped
            .request(HttpMethod::Post, "/sync/push", b"{}", Some("tok"))
            .expect("fake answers");
        let seen = fake.requests();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].1, format!("/sync/push?account={ns}"));
        // The bearer is untouched: the namespace names the vault, the token names
        // the credential, and they are two different facts.
        assert_eq!(seen[0].3.as_deref(), Some("tok"));
    }
}
