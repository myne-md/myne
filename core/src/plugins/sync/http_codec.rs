//! Minimal HTTP/1.1 codec shared by the sync transports (MYND-424 task 2).
//!
//! Both the production `RustlsTransport` (https) and the dev/harness
//! `HttpTransport` (loopback http) speak the same tiny **keep-alive** HTTP/1.1 —
//! only the byte stream underneath differs (TLS vs plain TCP). Responses are
//! read with strict framing (`Content-Length` / chunked), never read-to-EOF,
//! so one connection carries a whole sync cycle (1 handshake instead of N+2 —
//! the pre-keep-alive `Connection: close` codec cost a fresh TCP+TLS handshake
//! per request). The codec is pure over `BufRead` (no sockets), so it is
//! unit-tested once here and reused by both transports.

use super::transport::{HttpMethod, TransportError, TransportResponse, TransportResponseExt};
use std::io::{BufRead, Read, Write};

/// Hard cap on a sync response body read from the socket. TB5 treats the
/// self-hosted/hosted relay as untrusted (a compromised server is in scope), so
/// an unbounded body read lets it stream a giant body and OOM-crash the client.
/// 64 MiB comfortably exceeds any legitimate `/sync/pull` or `/sync/blob`
/// response while turning a hostile oversized body into a clean `TransportError`.
/// Enforced INCREMENTALLY — an over-cap `Content-Length` is rejected before a
/// single body byte is buffered.
pub(crate) const MAX_SYNC_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;

/// Cap on the response head (status line + headers). A hostile server must not
/// be able to stream an unbounded header section.
const MAX_HEAD_BYTES: usize = 64 * 1024;

/// Per-line cap inside chunked framing (chunk-size lines, trailers).
const MAX_CHUNK_LINE_BYTES: usize = 1024;

/// Build a minimal HTTP/1.1 request (keep-alive — HTTP/1.1's default; the
/// response reader decides whether the connection survives, via framing +
/// `Connection: close`).
pub(crate) fn build_http_request(
    method: HttpMethod,
    path: &str,
    host: &str,
    body: &[u8],
    token: Option<&str>,
) -> Vec<u8> {
    build_http_request_ext(method, path, host, &[], body, token)
}

/// [`build_http_request`] with caller-supplied extra headers (the attachment
/// byte-transport sends `Range` / `Content-Type: application/octet-stream`).
/// A caller-supplied `Content-Type` suppresses the JSON default.
pub(crate) fn build_http_request_ext(
    method: HttpMethod,
    path: &str,
    host: &str,
    extra_headers: &[(&str, &str)],
    body: &[u8],
    token: Option<&str>,
) -> Vec<u8> {
    let verb = match method {
        HttpMethod::Get => "GET",
        HttpMethod::Post => "POST",
        HttpMethod::Put => "PUT",
        HttpMethod::Head => "HEAD",
    };
    let mut head = String::new();
    head.push_str(&format!("{verb} {path} HTTP/1.1\r\n"));
    head.push_str(&format!("Host: {host}\r\n"));
    if let Some(t) = token {
        head.push_str(&format!("Authorization: Bearer {t}\r\n"));
    }
    let caller_content_type = extra_headers
        .iter()
        .any(|(n, _)| n.eq_ignore_ascii_case("content-type"));
    for (name, value) in extra_headers {
        head.push_str(&format!("{name}: {value}\r\n"));
    }
    if !body.is_empty() && !caller_content_type {
        head.push_str("Content-Type: application/json\r\n");
    }
    head.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
    let mut out = head.into_bytes();
    out.extend_from_slice(body);
    out
}

/// Why an incremental response read failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HttpReadError {
    /// EOF before ANY response byte arrived — the signature of a stale
    /// keep-alive connection the server closed between requests. The server
    /// provably did not send a response, so the caller may retry the request
    /// once on a fresh connection.
    EofBeforeResponse,
    /// The body exceeded [`MAX_SYNC_RESPONSE_BYTES`] (hostile or broken relay).
    TooLarge,
    /// Any other failure once bytes started flowing: malformed framing,
    /// truncation, IO/timeout. NOT retry-safe — the server may have processed
    /// the request.
    Failed,
}

/// Read one line (CRLF- or LF-terminated) with a byte budget. `Ok(None)` is a
/// clean EOF at a line boundary; a line that hits EOF or the budget without a
/// terminator is malformed.
fn read_line_limited<R: BufRead>(
    reader: &mut R,
    budget: &mut usize,
) -> Result<Option<String>, HttpReadError> {
    let mut line = Vec::new();
    let n = reader
        .by_ref()
        .take(*budget as u64 + 1)
        .read_until(b'\n', &mut line)
        .map_err(|_| HttpReadError::Failed)?;
    if n == 0 {
        return Ok(None);
    }
    if !line.ends_with(b"\n") {
        return Err(HttpReadError::Failed); // budget exhausted or EOF mid-line
    }
    *budget = budget.saturating_sub(n);
    while matches!(line.last(), Some(b'\n') | Some(b'\r')) {
        line.pop();
    }
    String::from_utf8(line)
        .map(Some)
        .map_err(|_| HttpReadError::Failed)
}

/// A parsed response head (status line + headers), shared by the framed
/// response reader and the SSE stream opener (which reads ONLY the head and
/// hands the still-open stream to the poke listener).
pub(crate) struct ResponseHead {
    pub(crate) status: u16,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) chunked: bool,
    pub(crate) content_length: Option<u64>,
    pub(crate) wants_close: bool,
    pub(crate) version_keepalive: bool,
}

/// Read a response head (status line + headers up to the blank line), bounded
/// by [`MAX_HEAD_BYTES`]. EOF before ANY byte → [`HttpReadError::EofBeforeResponse`].
pub(crate) fn read_response_head<R: BufRead>(
    reader: &mut R,
) -> Result<ResponseHead, HttpReadError> {
    let mut head_budget = MAX_HEAD_BYTES;

    // Status line. EOF *here* — before any byte — is the stale-connection case.
    let status_line = match read_line_limited(reader, &mut head_budget)? {
        Some(l) => l,
        None => return Err(HttpReadError::EofBeforeResponse),
    };
    let mut parts = status_line.split(' ');
    let version = parts.next().ok_or(HttpReadError::Failed)?;
    let status: u16 = parts
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or(HttpReadError::Failed)?;
    let version_keepalive = version == "HTTP/1.1";

    // Header lines up to the empty separator line.
    let mut chunked = false;
    let mut content_length: Option<u64> = None;
    let mut wants_close = false;
    let mut headers: Vec<(String, String)> = Vec::new();
    loop {
        let line = read_line_limited(reader, &mut head_budget)?.ok_or(HttpReadError::Failed)?;
        if line.is_empty() {
            break;
        }
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked") {
            chunked = true;
        } else if name == "content-length" {
            content_length = value.parse::<u64>().ok();
        } else if name == "connection" && value.to_ascii_lowercase().contains("close") {
            wants_close = true;
        }
        headers.push((name, value.to_string()));
    }
    Ok(ResponseHead {
        status,
        headers,
        chunked,
        content_length,
        wants_close,
        version_keepalive,
    })
}

/// Read exactly ONE framed HTTP/1.1 response off a (possibly persistent)
/// connection. Returns the response plus whether the connection is reusable
/// for another request: HTTP/1.1, no `Connection: close`, and a body framed by
/// `Content-Length` or chunked encoding (an EOF-framed body consumes the
/// connection by definition). Leftover buffered bytes stay in `reader` for the
/// next response — the sync protocol is strict request/response lockstep, no
/// pipelining.
///
/// `head_request` marks a HEAD response: its `Content-Length` describes the
/// body a GET *would* return (RFC 9110 §9.3.2) and no body follows, so body
/// framing is skipped entirely.
pub(crate) fn read_http_response<R: BufRead>(
    reader: &mut R,
    head_request: bool,
) -> Result<(TransportResponseExt, bool), HttpReadError> {
    let ResponseHead {
        status,
        headers,
        chunked,
        content_length,
        wants_close,
        version_keepalive,
    } = read_response_head(reader)?;

    let mut framed = true;
    let body = if head_request {
        Vec::new()
    } else if chunked {
        read_chunked_body(reader)?
    } else if let Some(n) = content_length {
        if n > MAX_SYNC_RESPONSE_BYTES {
            return Err(HttpReadError::TooLarge);
        }
        let mut buf = vec![0u8; n as usize];
        reader
            .read_exact(&mut buf)
            .map_err(|_| HttpReadError::Failed)?;
        buf
    } else {
        // No framing → read-to-EOF (bounded); the connection is consumed.
        framed = false;
        let mut buf = Vec::new();
        reader
            .by_ref()
            .take(MAX_SYNC_RESPONSE_BYTES + 1)
            .read_to_end(&mut buf)
            .map_err(|_| HttpReadError::Failed)?;
        if buf.len() as u64 > MAX_SYNC_RESPONSE_BYTES {
            return Err(HttpReadError::TooLarge);
        }
        buf
    };

    let reusable = version_keepalive && !wants_close && framed;
    Ok((
        TransportResponseExt {
            status,
            body,
            headers,
        },
        reusable,
    ))
}

/// Incrementally decode an HTTP/1.1 chunked body (RFC 7230 §4.1), enforcing the
/// total-size cap per chunk. Trailers are read and discarded UP TO the
/// terminating empty line — they must be drained fully, or the leftover bytes
/// would poison the next keep-alive response on the same connection.
fn read_chunked_body<R: BufRead>(reader: &mut R) -> Result<Vec<u8>, HttpReadError> {
    let mut body = Vec::new();
    loop {
        let mut line_budget = MAX_CHUNK_LINE_BYTES;
        let size_line =
            read_line_limited(reader, &mut line_budget)?.ok_or(HttpReadError::Failed)?;
        // Strip any chunk extension (everything after the first ';').
        let size_str = size_line.split(';').next().unwrap_or("").trim();
        let size = u64::from_str_radix(size_str, 16).map_err(|_| HttpReadError::Failed)?;
        if size == 0 {
            // Trailer section: lines until the final empty line.
            loop {
                let mut tb = MAX_CHUNK_LINE_BYTES;
                match read_line_limited(reader, &mut tb)? {
                    Some(l) if l.is_empty() => return Ok(body),
                    Some(_) => continue,
                    None => return Err(HttpReadError::Failed),
                }
            }
        }
        if body.len() as u64 + size > MAX_SYNC_RESPONSE_BYTES {
            return Err(HttpReadError::TooLarge);
        }
        let start = body.len();
        body.resize(start + size as usize, 0);
        reader
            .read_exact(&mut body[start..])
            .map_err(|_| HttpReadError::Failed)?;
        // Each chunk's data is followed by a CRLF.
        let mut crlf = [0u8; 2];
        reader
            .read_exact(&mut crlf)
            .map_err(|_| HttpReadError::Failed)?;
        if &crlf != b"\r\n" {
            return Err(HttpReadError::Failed);
        }
    }
}

/// One request/response over a persistent connection, with the standard safe
/// stale-keep-alive retry. `slot` caches the live connection between calls
/// (both transports hold it in a `Mutex<Option<..>>`); `connect` opens a fresh
/// stream.
///
/// Retry rule (load-bearing): a request is transparently retried on a fresh
/// connection ONLY when it went out on a REUSED connection and failed with a
/// write error or [`HttpReadError::EofBeforeResponse`] — both prove the server
/// never produced a response for it. Once response bytes start flowing (or on
/// any fresh-connection failure) the error surfaces, so `/sync/push` is never
/// silently double-applied (and even a pathological duplicate is CAS-guarded →
/// 409 → the engine's bounded reconcile path).
pub(crate) fn keepalive_roundtrip<S, F>(
    slot: &mut Option<std::io::BufReader<S>>,
    connect: F,
    req: &[u8],
    head_request: bool,
) -> Result<TransportResponseExt, TransportError>
where
    S: Read + Write,
    F: FnOnce() -> Result<S, TransportError>,
{
    if let Some(mut conn) = slot.take() {
        let wrote = conn
            .get_mut()
            .write_all(req)
            .and_then(|_| conn.get_mut().flush());
        if wrote.is_ok() {
            match read_http_response(&mut conn, head_request) {
                Ok((resp, reuse)) => {
                    if reuse {
                        *slot = Some(conn);
                    }
                    return Ok(resp);
                }
                // Stale keep-alive (closed between requests) → retry below.
                Err(HttpReadError::EofBeforeResponse) => {}
                // Bytes flowed (or over-cap): not retry-safe.
                Err(_) => return Err(TransportError::Network),
            }
        }
        // Write failure on a reused connection is the other stale signature —
        // fall through to one fresh attempt.
    }

    let mut conn = std::io::BufReader::new(connect()?);
    conn.get_mut()
        .write_all(req)
        .and_then(|_| conn.get_mut().flush())
        .map_err(|_| TransportError::Network)?;
    match read_http_response(&mut conn, head_request) {
        Ok((resp, reuse)) => {
            if reuse {
                *slot = Some(conn);
            }
            Ok(resp)
        }
        Err(_) => Err(TransportError::Network),
    }
}

/// Parse a complete in-memory HTTP/1.1 response into `(status, body)` — the
/// buffer-oriented compatibility face of [`read_http_response`].
pub(crate) fn parse_http_response(raw: &[u8]) -> Option<TransportResponse> {
    parse_http_response_ext(raw, false).map(|r| TransportResponse {
        status: r.status,
        body: r.body,
    })
}

/// [`parse_http_response`] surfacing the response headers (lowercased names).
/// Thin wrapper over the incremental reader so there is exactly one framing
/// implementation.
pub(crate) fn parse_http_response_ext(
    raw: &[u8],
    head_request: bool,
) -> Option<TransportResponseExt> {
    let mut cursor = std::io::Cursor::new(raw);
    read_http_response(&mut cursor, head_request)
        .ok()
        .map(|(resp, _reuse)| resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_get_has_no_body_no_content_type() {
        let req = build_http_request(
            HttpMethod::Get,
            "/sync/pull?cursor=0",
            "h",
            b"",
            Some("tok"),
        );
        let s = String::from_utf8(req).unwrap();
        assert!(s.starts_with("GET /sync/pull?cursor=0 HTTP/1.1\r\n"));
        assert!(s.contains("Authorization: Bearer tok\r\n"));
        assert!(s.contains("Content-Length: 0\r\n"));
        assert!(!s.contains("Content-Type"));
    }

    #[test]
    fn build_post_carries_body() {
        let req = build_http_request(HttpMethod::Post, "/sync/push", "h", b"{}", None);
        let s = String::from_utf8(req).unwrap();
        assert!(s.contains("Content-Type: application/json\r\n"));
        assert!(s.contains("Content-Length: 2\r\n"));
        assert!(s.ends_with("{}"));
    }

    #[test]
    fn build_request_is_keepalive() {
        // HTTP/1.1 keep-alive is the default; the request must NOT opt out.
        let req = build_http_request(HttpMethod::Get, "/x", "h", b"", None);
        let s = String::from_utf8(req).unwrap();
        assert!(!s.to_ascii_lowercase().contains("connection:"));
    }

    #[test]
    fn parse_extracts_status_and_body() {
        let raw = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"x\":1}";
        let resp = parse_http_response(raw).unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.body, b"{\"x\":1}");
    }

    #[test]
    fn parse_rejects_garbage() {
        assert!(parse_http_response(b"not http").is_none());
    }

    #[test]
    fn parse_dechunks_transfer_encoding_chunked() {
        // The exact shape a reverse proxy (Caddy) emits for a >2 KiB body: two
        // data chunks + the terminating zero chunk. Pre-fix this surfaced the
        // chunk-size markers inline and corrupted the JSON.
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n\
                    a\r\n{\"metas\":[\r\n4\r\n1,2]\r\n0\r\n\r\n";
        let resp = parse_http_response(raw).unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.body, b"{\"metas\":[1,2]");
    }

    #[test]
    fn parse_honors_content_length_exactly() {
        // Content-Length bounds the body even if extra bytes trail (keep-alive).
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\n{\"x\":1}trailing-garbage";
        let resp = parse_http_response(raw).unwrap();
        assert_eq!(resp.body, b"{\"x\":1}");
    }

    #[test]
    fn parse_chunked_is_case_insensitive() {
        let raw = b"HTTP/1.1 200 OK\r\nTRANSFER-ENCODING: Chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n";
        let resp = parse_http_response(raw).unwrap();
        assert_eq!(resp.body, b"abc");
    }

    #[test]
    fn parse_rejects_truncated_chunk() {
        // Size says 9 bytes but only 3 follow → malformed, not a silent partial.
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n9\r\nabc";
        assert!(parse_http_response(raw).is_none());
    }

    // --- incremental reader: keep-alive semantics --------------------------

    #[test]
    fn two_back_to_back_responses_on_one_reader() {
        let raw: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc\
                           HTTP/1.1 404 NF\r\nContent-Length: 2\r\n\r\nno";
        let mut cursor = std::io::Cursor::new(raw);
        let (r1, reuse1) = read_http_response(&mut cursor, false).unwrap();
        assert_eq!(
            (r1.status, r1.body.as_slice(), reuse1),
            (200, &b"abc"[..], true)
        );
        let (r2, reuse2) = read_http_response(&mut cursor, false).unwrap();
        assert_eq!(
            (r2.status, r2.body.as_slice(), reuse2),
            (404, &b"no"[..], true)
        );
    }

    #[test]
    fn connection_close_and_eof_framing_kill_reuse() {
        let close: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let (_, reuse) = read_http_response(&mut std::io::Cursor::new(close), false).unwrap();
        assert!(!reuse, "Connection: close must consume the connection");

        let eof_framed: &[u8] = b"HTTP/1.1 200 OK\r\n\r\nbody-until-eof";
        let (r, reuse) = read_http_response(&mut std::io::Cursor::new(eof_framed), false).unwrap();
        assert_eq!(r.body, b"body-until-eof");
        assert!(!reuse, "an EOF-framed body must consume the connection");
    }

    #[test]
    fn http10_kills_reuse() {
        let raw: &[u8] = b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok";
        let (_, reuse) = read_http_response(&mut std::io::Cursor::new(raw), false).unwrap();
        assert!(!reuse);
    }

    #[test]
    fn eof_before_any_byte_is_the_stale_signature() {
        let mut empty = std::io::Cursor::new(&b""[..]);
        assert_eq!(
            read_http_response(&mut empty, false).unwrap_err(),
            HttpReadError::EofBeforeResponse
        );
        // But EOF mid-head is Failed (bytes flowed → not retry-safe).
        let mut partial = std::io::Cursor::new(&b"HTTP/1.1 200 OK\r\nContent-"[..]);
        assert_eq!(
            read_http_response(&mut partial, false).unwrap_err(),
            HttpReadError::Failed
        );
    }

    #[test]
    fn oversized_content_length_rejected_before_buffering() {
        let raw = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            MAX_SYNC_RESPONSE_BYTES + 1
        );
        assert_eq!(
            read_http_response(&mut std::io::Cursor::new(raw.as_bytes()), false).unwrap_err(),
            HttpReadError::TooLarge
        );
    }

    #[test]
    fn head_response_skips_body_framing_and_stays_reusable() {
        let raw: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 9999\r\nX-Complete: 1\r\n\r\n";
        let (r, reuse) = read_http_response(&mut std::io::Cursor::new(raw), true).unwrap();
        assert!(r.body.is_empty());
        assert_eq!(r.header("x-complete"), Some("1"));
        assert!(reuse);
    }

    #[test]
    fn chunked_survives_tiny_buffer_reads() {
        // Force the incremental path across many small BufRead fills — chunk
        // frames split at every possible boundary.
        let raw: &[u8] = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n\
                           4\r\nwiki\r\n5\r\npedia\r\n0\r\n\r\n";
        let drip = std::io::BufReader::with_capacity(2, std::io::Cursor::new(raw));
        let mut reader = drip;
        let (r, reuse) = read_http_response(&mut reader, false).unwrap();
        assert_eq!(r.body, b"wikipedia");
        assert!(reuse, "a chunk-framed body is connection-preserving");
    }

    // --- keepalive_roundtrip ------------------------------------------------

    /// A scripted Read+Write duplex: reads come from `input`, writes accumulate.
    struct Duplex {
        input: std::io::Cursor<Vec<u8>>,
        written: Vec<u8>,
    }
    impl Duplex {
        fn new(input: &[u8]) -> Self {
            Self {
                input: std::io::Cursor::new(input.to_vec()),
                written: Vec::new(),
            }
        }
    }
    impl Read for Duplex {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.input.read(buf)
        }
    }
    impl Write for Duplex {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.written.extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    const OK_RESP: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";

    #[test]
    fn roundtrip_reuses_cached_connection() {
        // One duplex carrying TWO responses: both roundtrips ride it; connect
        // must never fire.
        let mut two = Vec::from(OK_RESP);
        two.extend_from_slice(OK_RESP);
        let mut slot = Some(std::io::BufReader::new(Duplex::new(&two)));
        for _ in 0..2 {
            let resp = keepalive_roundtrip(
                &mut slot,
                || -> Result<Duplex, TransportError> {
                    panic!("connect must not be called while the cached conn lives")
                },
                b"GET / HTTP/1.1\r\n\r\n",
                false,
            )
            .unwrap();
            assert_eq!(resp.status, 200);
            assert!(slot.is_some(), "framed keep-alive response keeps the slot");
        }
    }

    #[test]
    fn roundtrip_retries_once_on_stale_connection() {
        // The cached conn yields EOF before any byte (server closed it idle);
        // the retry connects fresh and succeeds.
        let mut slot = Some(std::io::BufReader::new(Duplex::new(b"")));
        let connects = std::cell::Cell::new(0);
        let resp = keepalive_roundtrip(
            &mut slot,
            || {
                connects.set(connects.get() + 1);
                Ok(Duplex::new(OK_RESP))
            },
            b"GET / HTTP/1.1\r\n\r\n",
            false,
        )
        .unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(connects.get(), 1, "exactly one fresh connect");
    }

    #[test]
    fn roundtrip_never_retries_after_response_bytes_flowed() {
        // Truncated response on the cached conn (bytes flowed, then died):
        // must surface an error WITHOUT touching connect.
        let truncated = b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nab";
        let mut slot = Some(std::io::BufReader::new(Duplex::new(truncated)));
        let err = keepalive_roundtrip(
            &mut slot,
            || -> Result<Duplex, TransportError> {
                panic!("a mid-response failure must never be retried")
            },
            b"GET / HTTP/1.1\r\n\r\n",
            false,
        )
        .unwrap_err();
        assert_eq!(err, TransportError::Network);
    }

    #[test]
    fn roundtrip_fresh_connection_failure_is_not_retried() {
        let mut slot: Option<std::io::BufReader<Duplex>> = None;
        let connects = std::cell::Cell::new(0);
        let err = keepalive_roundtrip(
            &mut slot,
            || {
                connects.set(connects.get() + 1);
                Ok(Duplex::new(b"")) // fresh conn immediately EOFs
            },
            b"GET / HTTP/1.1\r\n\r\n",
            false,
        )
        .unwrap_err();
        assert_eq!(err, TransportError::Network);
        assert_eq!(connects.get(), 1, "no retry loop on a fresh connection");
    }
}
