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
use std::sync::Mutex;

/// HTTP method for a transport request (the server protocol uses only these).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpMethod {
    /// Pull / read-side requests.
    Get,
    /// Push / write-side requests.
    Post,
    /// Idempotent upload (the `vault.meta` enrollment-bootstrap seed + the
    /// `/attachments/{id}` resumable chunk upload, MYND-468).
    Put,
    /// Header-only probe (the `/attachments/{id}` resume/dedup probe —
    /// `X-Uploaded-Length` / `X-Complete`; `server-protocol.md` §3.2).
    Head,
}

/// A transport response: the HTTP status and the opaque body bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportResponse {
    /// HTTP status code (the engine maps 401/409/410/413/429/507 per §6).
    pub status: u16,
    /// Opaque response body (ciphertext / sync-meta / head record bytes).
    pub body: Vec<u8>,
}

/// A transport response that also surfaces the response headers — needed only
/// by the `/attachments/{id}` byte-transport (`X-Uploaded-Length`,
/// `X-Complete`, `Content-Range`; MYND-468). Header names are lowercased,
/// values trimmed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportResponseExt {
    /// HTTP status code.
    pub status: u16,
    /// Opaque response body.
    pub body: Vec<u8>,
    /// Response headers, `(lowercased-name, trimmed-value)`.
    pub headers: Vec<(String, String)>,
}

impl TransportResponseExt {
    /// First header value with the given (lowercase) name.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    }
}

/// Transport-level failures (below the HTTP-status layer — these mean the
/// request never produced a response).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    /// No sync endpoint configured (SYNC-14) — caller must set one first.
    NotConfigured,
    /// Connection / DNS / socket failure.
    Network,
    /// TLS handshake or certificate-pin failure (A4).
    Tls,
    /// The request could not be built (bad path, etc.).
    BadRequest,
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
}

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
        self.responses
            .lock()
            .unwrap()
            .get(&Self::key(method, path))
            .cloned()
            .ok_or(TransportError::Network)
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
