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
}

/// A transport response: the HTTP status and the opaque body bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransportResponse {
    /// HTTP status code (the engine maps 401/409/410/413/429/507 per §6).
    pub status: u16,
    /// Opaque response body (ciphertext / sync-meta / head record bytes).
    pub body: Vec<u8>,
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
}

/// A request the [`FakeTransport`] observed: `(method, path, body, token)`.
pub type SeenRequest = (HttpMethod, String, Vec<u8>, Option<String>);

/// In-memory transport for unit tests and the harness's pre-wired responses.
/// Maps `"<METHOD> <path>"` to a canned [`TransportResponse`]; records the
/// requests it saw so tests can assert on them. Not used in production.
#[derive(Default)]
pub struct FakeTransport {
    responses: Mutex<HashMap<String, TransportResponse>>,
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
        };
        alloc_format(m, path)
    }

    /// Pre-load a canned response for `method path`.
    pub fn on(&self, method: HttpMethod, path: &str, status: u16, body: Vec<u8>) {
        self.responses
            .lock()
            .unwrap()
            .insert(Self::key(method, path), TransportResponse { status, body });
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
        if !self.configured {
            return Err(TransportError::NotConfigured);
        }
        self.seen.lock().unwrap().push((
            method,
            path.to_string(),
            body.to_vec(),
            token.map(|t| t.to_string()),
        ));
        self.responses
            .lock()
            .unwrap()
            .get(&Self::key(method, path))
            .cloned()
            .ok_or(TransportError::Network)
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
