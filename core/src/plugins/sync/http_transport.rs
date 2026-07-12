//! Plain-HTTP sync transport for loopback endpoints (MYND-424 task 2 gap-fix).
//!
//! `RustlsTransport` is https-only, but the endpoint-config policy also permits
//! **loopback `http`** (`127.0.0.1` / `localhost` / `[::1]`) for the dev server +
//! the MYND-428 E2E harness (no self-signed-cert dance). This is the plain-TCP
//! transport for exactly those endpoints — same minimal HTTP/1.1 codec
//! (`http_codec`), no TLS. It refuses any non-loopback host (a non-loopback
//! plaintext sync would be an A4 downgrade), so production https always routes to
//! the pinned rustls layer.

use super::http_codec::{build_http_request_ext, parse_http_response_ext, MAX_SYNC_RESPONSE_BYTES};
use super::transport::{
    HttpMethod, SyncTransport, TransportError, TransportResponse, TransportResponseExt,
};
use std::io::{Read, Write};
use std::net::TcpStream;

/// Plain-HTTP transport, loopback-only.
pub struct HttpTransport {
    host: String,
    port: u16,
}

impl HttpTransport {
    /// Construct for `host:port`. The factory guarantees `host` is loopback.
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
        }
    }
}

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
        let mut stream = TcpStream::connect((self.host.as_str(), self.port))
            .map_err(|_| TransportError::Network)?;
        let req = build_http_request_ext(method, path, &self.host, extra_headers, body, token);
        stream
            .write_all(&req)
            .map_err(|_| TransportError::Network)?;
        stream.flush().map_err(|_| TransportError::Network)?;
        let mut raw = Vec::new();
        // Bound the socket read: a hostile relay can otherwise stream an unbounded
        // body and OOM the client. Read one byte past the cap so an over-limit body
        // is detectable rather than silently truncated.
        (&mut stream)
            .take(MAX_SYNC_RESPONSE_BYTES + 1)
            .read_to_end(&mut raw)
            .map_err(|_| TransportError::Network)?;
        if raw.len() as u64 > MAX_SYNC_RESPONSE_BYTES {
            return Err(TransportError::Network);
        }
        parse_http_response_ext(&raw, method == HttpMethod::Head).ok_or(TransportError::Network)
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

/// Build the right transport for an endpoint URL: pinned rustls for `https`,
/// plain http for a **loopback** `http` endpoint. `pins` are the cert pins for
/// the rustls path (ignored for loopback http). Errors on a non-loopback http
/// endpoint (no plaintext sync off loopback — A4) or an unparseable URL.
pub fn build_transport(
    endpoint_url: &str,
    pins: Vec<[u8; 32]>,
) -> Result<Box<dyn SyncTransport>, TransportError> {
    let (scheme, host, port) = parse_endpoint(endpoint_url).ok_or(TransportError::BadRequest)?;
    match scheme.as_str() {
        "https" => Ok(Box::new(super::rustls_transport::RustlsTransport::new(
            host, port, pins,
        ))),
        "http" if is_loopback(&host) => Ok(Box::new(HttpTransport::new(host, port))),
        _ => Err(TransportError::BadRequest), // non-loopback http = A4 downgrade
    }
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
