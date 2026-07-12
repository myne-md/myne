//! Plain-HTTP sync transport for loopback endpoints (MYND-424 task 2 gap-fix).
//!
//! `RustlsTransport` is https-only, but the endpoint-config policy also permits
//! **loopback `http`** (`127.0.0.1` / `localhost` / `[::1]`) for the dev server +
//! the MYND-428 E2E harness (no self-signed-cert dance). This is the plain-TCP
//! transport for exactly those endpoints — same minimal keep-alive HTTP/1.1
//! codec (`http_codec`), no TLS. It refuses any non-loopback host (a
//! non-loopback plaintext sync would be an A4 downgrade), so production https
//! always routes to the pinned rustls layer.

use super::http_codec::{build_http_request_ext, keepalive_roundtrip, read_response_head};
use super::transport::{
    HttpMethod, SseOpenError, SseStream, SyncTransport, TransportError, TransportResponse,
    TransportResponseExt,
};
use std::io::BufReader;
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;

/// Socket read/write deadline: a hung or half-dead server must fail the request
/// instead of wedging a sync cycle forever; keep-alive reuse also needs death
/// detection. Comfortably exceeds any legitimate response (incl. a 64 MiB blob).
pub(crate) const SOCKET_TIMEOUT: Duration = Duration::from_secs(60);

/// Plain-HTTP transport, loopback-only. Holds one keep-alive connection —
/// within a sync cycle every request rides the same TCP session (the codec's
/// framed reader decides reusability per response).
pub struct HttpTransport {
    host: String,
    port: u16,
    conn: Mutex<Option<BufReader<TcpStream>>>,
}

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
                drop(sock); // close after one exchange → the cached conn goes stale
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
