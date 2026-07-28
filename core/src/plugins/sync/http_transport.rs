//! Plain-HTTP sync transport for loopback endpoints (MYND-424 task 2 gap-fix).
//!
//! `RustlsTransport` is https-only, but the endpoint-config policy also permits
//! **loopback `http`** (`127.0.0.1` / `localhost` / `[::1]`) for the dev server +
//! the MYND-428 E2E harness (no self-signed-cert dance). This is the plain-TCP
//! transport for exactly those endpoints — same minimal keep-alive HTTP/1.1
//! codec (`http_codec`), no TLS. It refuses any non-loopback host (a
//! non-loopback plaintext sync would be an A4 downgrade), so production https
//! always routes to the pinned rustls layer.
//!
//! # What compiles for `wasm32`, and what does not (task 84)
//!
//! [`HttpTransport`] itself is **excluded** from the browser build rather than
//! stubbed. It is a raw `TcpStream` with a keep-alive slot; on
//! `wasm32-unknown-unknown` `std::net` compiles and then fails at runtime, which
//! is the same silent-panic class as the clocks — a transport that constructs
//! successfully and dies on first use is strictly worse than one that cannot be
//! constructed.
//!
//! What stays compiled is the DISPATCH: [`parse_endpoint`], [`is_loopback`] and
//! [`build_transport`]. That is deliberate and is the reason this file is not
//! simply `#[cfg(not(wasm32))]` wholesale — the endpoint policy (https anywhere,
//! http on loopback only, non-loopback plaintext refused as an A4 downgrade) is
//! a security rule, and both clients must be answering the same one. Only the
//! transports it selects differ.

#[cfg(not(target_arch = "wasm32"))]
use super::http_codec::{build_http_request_ext, keepalive_roundtrip, read_response_head};
#[cfg(not(target_arch = "wasm32"))]
use super::transport::{
    HttpMethod, SseOpenError, SseStream, TransportResponse, TransportResponseExt,
};
use super::transport::{SyncTransport, TransportError};
#[cfg(not(target_arch = "wasm32"))]
use std::io::BufReader;
#[cfg(not(target_arch = "wasm32"))]
use std::net::TcpStream;
#[cfg(not(target_arch = "wasm32"))]
use std::sync::Mutex;
#[cfg(not(target_arch = "wasm32"))]
use std::time::Duration;

#[cfg(not(target_arch = "wasm32"))]
/// Socket read/write deadline: a hung or half-dead server must fail the request
/// instead of wedging a sync cycle forever; keep-alive reuse also needs death
/// detection. Comfortably exceeds any legitimate response (incl. a 64 MiB blob).
pub(crate) const SOCKET_TIMEOUT: Duration = Duration::from_secs(60);

#[cfg(not(target_arch = "wasm32"))]
/// Plain-HTTP transport, loopback-only. Holds one keep-alive connection —
/// within a sync cycle every request rides the same TCP session (the codec's
/// framed reader decides reusability per response).
pub struct HttpTransport {
    host: String,
    port: u16,
    conn: Mutex<Option<BufReader<TcpStream>>>,
}

#[cfg(not(target_arch = "wasm32"))]
impl HttpTransport {
    /// Construct for `host:port`. The factory guarantees `host` is loopback.
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
            conn: Mutex::new(None),
        }
    }

    fn connect(&self) -> Result<TcpStream, TransportError> {
        let sock = TcpStream::connect((self.host.as_str(), self.port))
            .map_err(|_| TransportError::Network)?;
        let _ = sock.set_read_timeout(Some(SOCKET_TIMEOUT));
        let _ = sock.set_write_timeout(Some(SOCKET_TIMEOUT));
        Ok(sock)
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl SyncTransport for HttpTransport {
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
        let req = build_http_request_ext(method, path, &self.host, extra_headers, body, token);
        let mut slot = self.conn.lock().map_err(|_| TransportError::Network)?;
        keepalive_roundtrip(
            &mut slot,
            || self.connect(),
            &req,
            method == HttpMethod::Head,
        )
    }

    fn open_sse(
        &self,
        path: &str,
        token: &str,
        read_timeout: std::time::Duration,
    ) -> Result<SseStream, SseOpenError> {
        // A dedicated connection (never the keep-alive request slot — the
        // stream occupies it indefinitely).
        let sock = TcpStream::connect((self.host.as_str(), self.port))
            .map_err(|_| SseOpenError::Transport(TransportError::Network))?;
        sock.set_read_timeout(Some(read_timeout))
            .map_err(|_| SseOpenError::Transport(TransportError::Network))?;
        let _ = sock.set_write_timeout(Some(SOCKET_TIMEOUT));
        let shutdown_handle = sock
            .try_clone()
            .map_err(|_| SseOpenError::Transport(TransportError::Network))?;
        let mut reader = BufReader::new(sock);
        let req = build_http_request_ext(
            HttpMethod::Get,
            path,
            &self.host,
            &[("Accept", "text/event-stream")],
            b"",
            Some(token),
        );
        {
            use std::io::Write;
            let w = reader.get_mut();
            w.write_all(&req)
                .and_then(|_| w.flush())
                .map_err(|_| SseOpenError::Transport(TransportError::Network))?;
        }
        let head = read_response_head(&mut reader)
            .map_err(|_| SseOpenError::Transport(TransportError::Network))?;
        match head.status {
            200 => Ok(SseStream {
                reader: Box::new(reader),
                chunked: head.chunked,
                socket: shutdown_handle,
            }),
            401 => Err(SseOpenError::Unauthorized),
            _ => Err(SseOpenError::Transport(TransportError::Network)),
        }
    }
}

/// Parse `scheme://host[:port]` → `(scheme, host, port)`. https defaults to 443;
/// http requires an explicit port (the loopback dev/harness convention).
pub fn parse_endpoint(url: &str) -> Option<(String, String, u16)> {
    let (scheme, rest) = url.split_once("://")?;
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let (host, port) = if let Some(stripped) = authority.strip_prefix('[') {
        // IPv6 "[::1]:port".
        let close = stripped.find(']')?;
        let host = &stripped[..close];
        let after = &stripped[close + 1..];
        let port = after.strip_prefix(':').and_then(|p| p.parse().ok());
        (host.to_string(), port)
    } else if let Some((h, p)) = authority.rsplit_once(':') {
        (h.to_string(), p.parse().ok())
    } else {
        (authority.to_string(), None)
    };
    let port = match scheme {
        "https" => port.unwrap_or(443),
        "http" => port?, // http must be explicit
        _ => return None,
    };
    Some((scheme.to_string(), host, port))
}

fn is_loopback(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

// ── the browser's transport, installed rather than built (task 35) ───────────
//
// On wasm32 there is no rustls arm and no TCP socket, so the `https` case cannot
// be constructed here — but it must still be *reachable* from the same
// `build_transport` every sync call site already uses, or the web client would
// need its own copy of that dispatch.
//
// So the entry crate installs a factory at startup and this module calls it. The
// direction matters: core does not learn what a browser is, it learns that
// something else may answer for `https`. The factory is a plain `fn` pointer —
// no captured state, nothing to keep alive, and the `OnceLock` makes a second
// installation a no-op rather than a race.

/// Which of the two endpoint shapes the browser is being asked to speak.
///
/// A closed enum rather than a `&str` scheme, and it carries its precondition in
/// its own name: [`BrowserScheme::LoopbackHttp`] is constructible only inside
/// [`build_transport`]'s `is_loopback`-guarded arm, so "a browser transport
/// cannot be built for plaintext off loopback" stays a property of the type
/// rather than a rule someone has to remember. A `scheme: &str` parameter would
/// have made the A4 guard a convention.
#[cfg(target_arch = "wasm32")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BrowserScheme {
    /// Ordinary `https` — the production shape, any host.
    Https,
    /// Plain `http` to a loopback host: the dev server and the web E2E harness,
    /// the same endpoints the desktop's [`HttpTransport`] serves. Permitted
    /// because the policy already permits them and because `127.0.0.1` /
    /// `localhost` are "potentially trustworthy" origins, so a browser will
    /// reach them from a secure page instead of blocking them as mixed content.
    LoopbackHttp,
}

#[cfg(target_arch = "wasm32")]
pub type BrowserTransportFactory =
    fn(scheme: BrowserScheme, host: &str, port: u16) -> Box<dyn SyncTransport>;

#[cfg(target_arch = "wasm32")]
static BROWSER_TRANSPORT: std::sync::OnceLock<BrowserTransportFactory> = std::sync::OnceLock::new();

/// Install the browser's `https` transport. Called once, from the Worker entry
/// point, before any sync command runs.
#[cfg(target_arch = "wasm32")]
pub fn set_browser_transport(factory: BrowserTransportFactory) {
    let _ = BROWSER_TRANSPORT.set(factory);
}

/// Build the right transport for an endpoint URL: pinned rustls for `https`,
/// plain http for a **loopback** `http` endpoint. `pins` are the cert pins for
/// the rustls path (ignored for loopback http). Errors on a non-loopback http
/// endpoint (no plaintext sync off loopback — A4) or an unparseable URL.
pub fn build_transport(
    endpoint_url: &str,
    // Consumed only by the rustls arm below, which does not exist on wasm.
    #[cfg_attr(target_arch = "wasm32", allow(unused_variables))] pins: Vec<[u8; 32]>,
) -> Result<Box<dyn SyncTransport>, TransportError> {
    let (scheme, host, port) = parse_endpoint(endpoint_url).ok_or(TransportError::BadRequest)?;
    match scheme.as_str() {
        // wasm32 has no rustls arm (see `mod.rs`); the browser transport is
        // installed by the Worker host, not built here.
        #[cfg(not(target_arch = "wasm32"))]
        "https" => Ok(Box::new(super::rustls_transport::RustlsTransport::new(
            host, port, pins,
        ))),
        // The browser answers for `https` through the factory it installed. TLS,
        // certificate verification and the trust store are the browser's, which
        // is also why `pins` is unused here: a page cannot pin a certificate,
        // and `decisions.md` 2026-07-26 records that as permanent rather than
        // deferred (A4 is ⚠️ Best-effort on web by decision, not by omission).
        #[cfg(target_arch = "wasm32")]
        "https" => browser_transport(BrowserScheme::Https, &host, port),
        #[cfg(not(target_arch = "wasm32"))]
        "http" if is_loopback(&host) => Ok(Box::new(HttpTransport::new(host, port))),
        // Same endpoints, different transport. The browser cannot open the raw
        // socket `HttpTransport` is, but it can fetch a loopback origin — so the
        // loopback-dev/harness case is served by the browser transport rather
        // than refused, which is what keeps the web E2E lane able to talk to the
        // same local `myne-server` the desktop lane does. The A4 rule is
        // untouched: `is_loopback` gates this arm exactly as it gates the native
        // one, and it is the guard, not the transport, that enforces it.
        #[cfg(target_arch = "wasm32")]
        "http" if is_loopback(&host) => browser_transport(BrowserScheme::LoopbackHttp, &host, port),
        _ => Err(TransportError::BadRequest), // non-loopback http = A4 downgrade
    }
}

/// Resolve the installed browser factory, or report a startup failure.
#[cfg(target_arch = "wasm32")]
fn browser_transport(
    scheme: BrowserScheme,
    host: &str,
    port: u16,
) -> Result<Box<dyn SyncTransport>, TransportError> {
    match BROWSER_TRANSPORT.get() {
        Some(factory) => Ok(factory(scheme, host, port)),
        // Not a network failure — a startup one. The Worker entry point is
        // supposed to install this before any sync command can run, so reaching
        // here means the boot order changed.
        None => Err(TransportError::BadRequest),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn parse_https_defaults_443() {
        let (s, h, p) = parse_endpoint("https://sync.myne.md/base").unwrap();
        assert_eq!((s.as_str(), h.as_str(), p), ("https", "sync.myne.md", 443));
    }

    #[test]
    fn parse_https_explicit_port() {
        let (_, h, p) = parse_endpoint("https://sync.myne.md:8443").unwrap();
        assert_eq!((h.as_str(), p), ("sync.myne.md", 8443));
    }

    #[test]
    fn parse_http_requires_explicit_port() {
        assert_eq!(parse_endpoint("http://127.0.0.1:51820").unwrap().2, 51820);
        assert!(parse_endpoint("http://127.0.0.1").is_none()); // no port → reject
    }

    #[test]
    fn factory_rejects_nonloopback_http() {
        assert_eq!(
            build_transport("http://sync.myne.md:80", vec![]).err(),
            Some(TransportError::BadRequest)
        );
    }

    #[test]
    fn factory_builds_loopback_http_and_https() {
        assert!(build_transport("http://127.0.0.1:9000", vec![]).is_ok());
        assert!(build_transport("https://sync.myne.md", vec![[0x11; 32]]).is_ok());
        assert!(build_transport("ftp://x", vec![]).is_err());
    }

    #[test]
    fn http_transport_round_trips_against_a_local_server() {
        // A one-shot TCP server that returns a canned HTTP response.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            // Drain the request (read until the header terminator).
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf);
            let body = b"{\"ok\":true}";
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            sock.write_all(resp.as_bytes()).unwrap();
            sock.write_all(body).unwrap();
            // request bytes for assertion
            String::from_utf8_lossy(&buf).into_owned()
        });

        let t = HttpTransport::new("127.0.0.1", port);
        let resp = t
            .request(HttpMethod::Post, "/auth/scram/init", b"{}", Some("tok"))
            .unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.body, b"{\"ok\":true}");
        let seen = handle.join().unwrap();
        assert!(seen.contains("POST /auth/scram/init HTTP/1.1"));
        assert!(seen.contains("Authorization: Bearer tok"));
    }

    /// Read one full HTTP request off the socket (headers + Content-Length body).
    fn read_request(sock: &mut std::net::TcpStream) -> Option<String> {
        let mut raw = Vec::new();
        let mut buf = [0u8; 1024];
        loop {
            if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&raw[..pos]).into_owned();
                let cl = head
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|v| v.trim().parse::<usize>().ok())
                    })
                    .flatten()
                    .unwrap_or(0);
                while raw.len() < pos + 4 + cl {
                    let n = sock.read(&mut buf).ok()?;
                    if n == 0 {
                        return None;
                    }
                    raw.extend_from_slice(&buf[..n]);
                }
                return Some(String::from_utf8_lossy(&raw).into_owned());
            }
            let n = sock.read(&mut buf).ok()?;
            if n == 0 {
                return None;
            }
            raw.extend_from_slice(&buf[..n]);
        }
    }

    fn write_keepalive_response(sock: &mut std::net::TcpStream) {
        let body = b"{\"ok\":true}";
        let resp = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len());
        sock.write_all(resp.as_bytes()).unwrap();
        sock.write_all(body).unwrap();
    }

    #[test]
    fn two_requests_reuse_one_connection() {
        // Keep-alive proof: the server accepts ONCE and serves both requests on
        // the same socket (the pre-keep-alive codec opened one connection per
        // request).
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut served = 0;
            while served < 2 {
                if read_request(&mut sock).is_none() {
                    panic!("second request must arrive on the SAME connection");
                }
                write_keepalive_response(&mut sock);
                served += 1;
            }
            served
        });

        let t = HttpTransport::new("127.0.0.1", port);
        for _ in 0..2 {
            let resp = t
                .request(HttpMethod::Get, "/sync/pull?cursor=0", b"", Some("tok"))
                .unwrap();
            assert_eq!(resp.status, 200);
        }
        assert_eq!(handle.join().unwrap(), 2);
    }

    #[test]
    fn stale_keepalive_connection_reconnects_transparently() {
        // The server closes the idle connection after the first response; the
        // second request must transparently retry on a fresh connection
        // (EofBeforeResponse → one retry), yielding TWO accepts total.
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = thread::spawn(move || {
            let mut accepts = 0;
            for _ in 0..2 {
                let (mut sock, _) = listener.accept().unwrap();
                accepts += 1;
                if read_request(&mut sock).is_some() {
                    write_keepalive_response(&mut sock);
                }
                // Half-close (FIN), not a bare `drop`, and this is a fix for a
                // real flake rather than tidiness. Dropping a socket whose peer
                // may still have unread bytes in flight can make the kernel send
                // RST instead of FIN — which discards the response the client has
                // not finished reading, so the FIRST exchange fails and the test
                // reports a stale-connection bug that is not there. Under
                // parallel `cargo test --workspace` load that window is wide
                // enough to hit.
                //
                // `shutdown(Write)` delivers the pending response and THEN closes,
                // which is exactly the condition under test: a server that
                // finished one exchange and went away. The client's next write
                // still lands on a dead socket — the stale signature the retry
                // path exists for — so nothing about the property is weakened.
                let _ = sock.shutdown(std::net::Shutdown::Write);
                drop(sock);
            }
            accepts
        });

        let t = HttpTransport::new("127.0.0.1", port);
        for _ in 0..2 {
            let resp = t
                .request(HttpMethod::Get, "/sync/pull?cursor=0", b"", Some("tok"))
                .unwrap();
            assert_eq!(resp.status, 200);
        }
        assert_eq!(handle.join().unwrap(), 2);
    }
}
