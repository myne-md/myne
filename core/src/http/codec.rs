//! HTTP/1.1 request framing and response parsing — pure over `BufRead`/`Write`.
//!
//! Moved **whole and verbatim** out of the sync plugin's HTTP codec module
//! (ai-ollama-local task 1): every function, type and test kept its name and
//! its assertions. A renamed or reworded test is not evidence that behaviour
//! survived a move, and the existing battery passing unchanged is the only
//! proof this refactor offers.

use super::{HttpMethod, TransportError, TransportResponse, TransportResponseExt};
use std::io::{BufRead, Read, Write};

/// Cap on the response head (status line + headers). A hostile server must not
/// be able to stream an unbounded header section.
const MAX_HEAD_BYTES: usize = 64 * 1024;

/// Per-line cap inside chunked framing (chunk-size lines, trailers).
const MAX_CHUNK_LINE_BYTES: usize = 1024;

/// Build a minimal HTTP/1.1 request (keep-alive — HTTP/1.1's default; the
/// response reader decides whether the connection survives, via framing +
/// `Connection: close`).
/// Test-only today. `plugins::sync` uses the `_ext` form; this plain one is the
/// shape a non-sync caller wants and is what #189's Ollama request builder will
/// reach for. Justified individually rather than hidden — see the module doc on
/// why this file no longer sits under sync's blanket `allow(dead_code)`.
#[allow(dead_code)]
pub fn build_http_request(
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
pub fn build_http_request_ext(
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
        HttpMethod::Delete => "DELETE",
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
pub enum HttpReadError {
    /// EOF before ANY response byte arrived — the signature of a stale
    /// keep-alive connection the server closed between requests. The server
    /// provably did not send a response, so the caller may retry the request
    /// once on a fresh connection.
    EofBeforeResponse,
    /// The body exceeded [`max_bytes`] (hostile or broken relay).
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
pub struct ResponseHead {
    pub(crate) status: u16,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) chunked: bool,
    pub(crate) content_length: Option<u64>,
    pub(crate) wants_close: bool,
    pub(crate) version_keepalive: bool,
}

/// Read a response head (status line + headers up to the blank line), bounded
/// by [`MAX_HEAD_BYTES`]. EOF before ANY byte → [`HttpReadError::EofBeforeResponse`].
pub fn read_response_head<R: BufRead>(reader: &mut R) -> Result<ResponseHead, HttpReadError> {
    let mut head_budget = MAX_HEAD_BYTES;

    // Peek before reading, and the reason is a real bug rather than caution.
    //
    // A stale keep-alive connection does not always announce itself as a clean
    // EOF. When the peer has already closed and our request lands on the dead
    // socket, the kernel answers with **RST**, and the first read then fails
    // with `ConnectionReset` rather than returning zero bytes. That was mapped to
    // `Failed` — "bytes started flowing, not retry-safe" — so
    // `keepalive_roundtrip` returned `Network` instead of retrying on a fresh
    // connection, and a sync cycle failed for a condition the retry path exists
    // to absorb. It reproduced as an intermittent unit-test failure under load
    // (~1 run in 3 of the full suite) before it was understood as production
    // behaviour.
    //
    // `fill_buf` is the right instrument because it **consumes nothing**: if it
    // reports a teardown, no response byte has been delivered to anyone, which
    // is precisely the property `EofBeforeResponse` asserts and precisely what
    // makes one retry safe.
    //
    // Narrow on purpose — only peer-teardown kinds. A read TIMEOUT is NOT
    // included: the server may have received and processed the request and
    // simply be slow, and retrying a non-idempotent push on that basis would
    // risk applying it twice.
    match reader.fill_buf() {
        Ok([]) => return Err(HttpReadError::EofBeforeResponse),
        Ok(_) => {}
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::BrokenPipe
                    | std::io::ErrorKind::NotConnected
            ) =>
        {
            return Err(HttpReadError::EofBeforeResponse)
        }
        Err(_) => return Err(HttpReadError::Failed),
    }

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
pub fn read_http_response<R: BufRead>(
    reader: &mut R,
    head_request: bool,
    max_bytes: u64,
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
        read_chunked_body(reader, max_bytes)?
    } else if let Some(n) = content_length {
        if n > max_bytes {
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
            .take(max_bytes + 1)
            .read_to_end(&mut buf)
            .map_err(|_| HttpReadError::Failed)?;
        if buf.len() as u64 > max_bytes {
            return Err(HttpReadError::TooLarge);
        }
        buf
    };

    let reusable = version_keepalive && !wants_close && framed;
    // How the response was DELIMITED, which is the fact that separates "the
    // peer is slow" from "we are waiting for an end marker that is not coming"
    // (myne-md/myne#546). A read that hangs looks identical from the outside in
    // both cases, and telling them apart cost a process stack sample. Counts
    // and a compile-time framing name only: no header value and no body byte.
    // `myne_core::*` rather than the `myne::*` product target the desktop crate
    // uses, and the reason is testability: `tracing-test`'s capture filters on
    // the crate name, so a line emitted under `myne::…` from this crate is
    // invisible to every test that would assert on it. `RUST_LOG=myne_core=debug`
    // turns these on.
    tracing::debug!(
        target: "myne_core::http",
        event = "response",
        status,
        framing = if head_request {
            "none"
        } else if chunked {
            "chunked"
        } else if content_length.is_some() {
            "content_length"
        } else {
            "eof"
        },
        body_bytes = body.len(),
        reusable,
    );
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
fn read_chunked_body<R: BufRead>(reader: &mut R, max_bytes: u64) -> Result<Vec<u8>, HttpReadError> {
    let mut body = Vec::new();
    loop {
        let mut line_budget = MAX_CHUNK_LINE_BYTES;
        let size_line =
            read_line_limited(reader, &mut line_budget)?.ok_or(HttpReadError::Failed)?;
        // Strip any chunk extension (everything after the first ';').
        let size_str = size_line.split(';').next().unwrap_or("").trim();
        let size = u64::from_str_radix(size_str, 16).map_err(|_| HttpReadError::Failed)?;
        // myne#295 — clamp the SERVER-SUPPLIED size at the point it is parsed,
        // before it reaches any arithmetic.
        //
        // The cap below was `body.len() as u64 + size > MAX`, and `size` is 16
        // hex digits the peer chooses. `ffffffffffffffff` overflows that add: a
        // debug build aborts on it, and a release build wraps the sum past the
        // cap, wraps `start + size as usize` to 0 so the resize TRUNCATES the
        // buffer, and then panics slicing `body[1..]` of a zero-length Vec.
        // Natively the unwind is contained by `spawn_blocking` and surfaces as an
        // opaque `Internal`/`Network`, and it poisons that cycle's transport
        // mutex on the way out — so sync is durably broken against that server
        // with no diagnosable error. Chunked is the ordinary path behind a
        // reverse proxy, and a hostile relay is explicitly in scope (TB5).
        //
        // Clamping here rather than only making the add checked is the shape the
        // rest of this file uses, and it means no later expression on this path
        // can be handed a value the budget never admitted.
        if size > max_bytes {
            return Err(HttpReadError::TooLarge);
        }
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
        // Belt-and-braces: `size` is already <= the cap, so this cannot overflow
        // — but a checked add states that rather than relying on the reader to
        // re-derive it, and it is what keeps the guard correct if the clamp above
        // is ever loosened.
        if (body.len() as u64)
            .checked_add(size)
            .is_none_or(|total| total > max_bytes)
        {
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
pub fn keepalive_roundtrip<S, F>(
    slot: &mut Option<std::io::BufReader<S>>,
    connect: F,
    req: &[u8],
    head_request: bool,
    max_bytes: u64,
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
            match read_http_response(&mut conn, head_request, max_bytes) {
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
    match read_http_response(&mut conn, head_request, max_bytes) {
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
/// Test-only today; the buffer-oriented face of [`read_http_response`],
/// kept because a caller holding a complete response in memory (a fake
/// backend, a fixture) needs it. See the module doc.
#[allow(dead_code)]
pub fn parse_http_response(raw: &[u8], max_bytes: u64) -> Option<TransportResponse> {
    parse_http_response_ext(raw, false, max_bytes).map(|r| TransportResponse {
        status: r.status,
        body: r.body,
    })
}

/// [`parse_http_response`] surfacing the response headers (lowercased names).
/// Thin wrapper over the incremental reader so there is exactly one framing
/// implementation.
/// Test-only today; the buffer-oriented face of [`read_http_response`],
/// kept because a caller holding a complete response in memory (a fake
/// backend, a fixture) needs it. See the module doc.
#[allow(dead_code)]
pub fn parse_http_response_ext(
    raw: &[u8],
    head_request: bool,
    max_bytes: u64,
) -> Option<TransportResponseExt> {
    let mut cursor = std::io::Cursor::new(raw);
    read_http_response(&mut cursor, head_request, max_bytes)
        .ok()
        .map(|(resp, _reuse)| resp)
}

#[cfg(test)]
mod tests {
    /// The value sync passes. The codec no longer owns a cap — see the
    /// module doc — so the tests supply the one whose limits they assert.
    const MAX_BYTES: u64 = 64 * 1024 * 1024;

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

    /// `build_http_request_ext` interpolates every value it is handed into the
    /// request head and inspects none of them, so a CR/LF inside the bearer
    /// terminates the header line it sits on.
    ///
    /// Asserted in the REFUSAL direction, so the day the writer starts
    /// validating this becomes a live regression test rather than a test that
    /// goes red at the moment the defect is fixed. Ignored because the chokepoint
    /// this branch does not own is upstream of the writer: `ai_provider_key` is
    /// `Shared(ScalarLww)`, so a vault co-member can author the value that
    /// reaches here, and a shape check in `authorize_remote` closes that. Run it
    /// with `cargo test -p myne-core -- --ignored a_crlf_in_the_bearer`.
    /// myne-md/myne#750.
    ///
    /// What this does NOT settle either way: whether any far side accepts the
    /// result. The providers are third-party HTTP/1.1 implementations, so the
    /// effect half is not observable from this repository. What IS observable
    /// is that Myne emits the bytes, which is the half it owns.
    #[test]
    #[ignore = "unfixed: the request writer interpolates the bearer unvalidated; see myne-md/myne#750"]
    fn a_crlf_in_the_bearer_cannot_terminate_the_authorization_line() {
        let req = build_http_request_ext(
            HttpMethod::Post,
            "/api/v1/chat/completions",
            "openrouter.ai",
            &[],
            b"{}",
            Some("sk-real\r\nX-Injected: 1"),
        );
        let s = String::from_utf8(req).unwrap();
        // The assertion prints the request, so it masks the credential rather
        // than writing a bearer into a test log. The shape of the check is what
        // this test exists for, and a leak here would be copied into a
        // production error path.
        let shown = s.replace("sk-real", "<redacted>");
        assert!(
            !s.contains("\r\nX-Injected: 1\r\n"),
            "the injected value became a header of its own: {shown:?}"
        );
        // The doubled form would end the head early, so the builder's own
        // framing lands inside what a parser would read as the body.
        let req = build_http_request_ext(
            HttpMethod::Post,
            "/api/v1/chat/completions",
            "openrouter.ai",
            &[],
            b"{}",
            Some("sk-real\r\n\r\nGET /other HTTP/1.1"),
        );
        let s = String::from_utf8(req).unwrap();
        let length_at = s.find("Content-Length").expect("the builder's own header");
        let first_blank = s.find("\r\n\r\n").expect("a head terminator");
        let shown = s.replace("sk-real", "<redacted>");
        assert!(
            length_at < first_blank,
            "the head ended before the builder's own Content-Length: {shown:?}"
        );
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
        let resp = parse_http_response(raw, MAX_BYTES).unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.body, b"{\"x\":1}");
    }

    #[test]
    fn parse_rejects_garbage() {
        assert!(parse_http_response(b"not http", MAX_BYTES).is_none());
    }

    #[test]
    fn parse_dechunks_transfer_encoding_chunked() {
        // The exact shape a reverse proxy (Caddy) emits for a >2 KiB body: two
        // data chunks + the terminating zero chunk. Pre-fix this surfaced the
        // chunk-size markers inline and corrupted the JSON.
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n\
                    a\r\n{\"metas\":[\r\n4\r\n1,2]\r\n0\r\n\r\n";
        let resp = parse_http_response(raw, MAX_BYTES).unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.body, b"{\"metas\":[1,2]");
    }

    #[test]
    fn parse_honors_content_length_exactly() {
        // Content-Length bounds the body even if extra bytes trail (keep-alive).
        let raw = b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\n\r\n{\"x\":1}trailing-garbage";
        let resp = parse_http_response(raw, MAX_BYTES).unwrap();
        assert_eq!(resp.body, b"{\"x\":1}");
    }

    #[test]
    fn parse_chunked_is_case_insensitive() {
        let raw = b"HTTP/1.1 200 OK\r\nTRANSFER-ENCODING: Chunked\r\n\r\n3\r\nabc\r\n0\r\n\r\n";
        let resp = parse_http_response(raw, MAX_BYTES).unwrap();
        assert_eq!(resp.body, b"abc");
    }

    #[test]
    fn parse_rejects_truncated_chunk() {
        // Size says 9 bytes but only 3 follow → malformed, not a silent partial.
        let raw = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n9\r\nabc";
        assert!(parse_http_response(raw, MAX_BYTES).is_none());
    }

    // --- incremental reader: keep-alive semantics --------------------------

    #[test]
    fn two_back_to_back_responses_on_one_reader() {
        let raw: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc\
                           HTTP/1.1 404 NF\r\nContent-Length: 2\r\n\r\nno";
        let mut cursor = std::io::Cursor::new(raw);
        let (r1, reuse1) = read_http_response(&mut cursor, false, MAX_BYTES).unwrap();
        assert_eq!(
            (r1.status, r1.body.as_slice(), reuse1),
            (200, &b"abc"[..], true)
        );
        let (r2, reuse2) = read_http_response(&mut cursor, false, MAX_BYTES).unwrap();
        assert_eq!(
            (r2.status, r2.body.as_slice(), reuse2),
            (404, &b"no"[..], true)
        );
    }

    #[test]
    fn connection_close_and_eof_framing_kill_reuse() {
        let close: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
        let (_, reuse) =
            read_http_response(&mut std::io::Cursor::new(close), false, MAX_BYTES).unwrap();
        assert!(!reuse, "Connection: close must consume the connection");

        let eof_framed: &[u8] = b"HTTP/1.1 200 OK\r\n\r\nbody-until-eof";
        let (r, reuse) =
            read_http_response(&mut std::io::Cursor::new(eof_framed), false, MAX_BYTES).unwrap();
        assert_eq!(r.body, b"body-until-eof");
        assert!(!reuse, "an EOF-framed body must consume the connection");
    }

    #[test]
    fn http10_kills_reuse() {
        let raw: &[u8] = b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\nok";
        let (_, reuse) =
            read_http_response(&mut std::io::Cursor::new(raw), false, MAX_BYTES).unwrap();
        assert!(!reuse);
    }

    #[test]
    fn eof_before_any_byte_is_the_stale_signature() {
        let mut empty = std::io::Cursor::new(&b""[..]);
        assert_eq!(
            read_http_response(&mut empty, false, MAX_BYTES).unwrap_err(),
            HttpReadError::EofBeforeResponse
        );
        // But EOF mid-head is Failed (bytes flowed → not retry-safe).
        let mut partial = std::io::Cursor::new(&b"HTTP/1.1 200 OK\r\nContent-"[..]);
        assert_eq!(
            read_http_response(&mut partial, false, MAX_BYTES).unwrap_err(),
            HttpReadError::Failed
        );
    }

    /// A reader whose first `fill_buf` reports `kind`, then behaves as EOF.
    /// Models a socket the peer reset: the read fails without ever handing a
    /// byte to the caller.
    struct ResettingReader {
        kind: std::io::ErrorKind,
        fired: bool,
    }
    impl std::io::Read for ResettingReader {
        fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
            Ok(0)
        }
    }
    impl BufRead for ResettingReader {
        fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
            if !self.fired {
                self.fired = true;
                return Err(std::io::Error::new(self.kind, "peer went away"));
            }
            Ok(&[])
        }
        fn consume(&mut self, _amt: usize) {}
    }

    /// A stale keep-alive that RESETS is the same situation as one that closes
    /// cleanly, and must be retryable for the same reason.
    ///
    /// This was a real bug, and it surfaced as an intermittent unit-test failure
    /// (~1 run in 3 of the full suite under parallel load) before it was
    /// understood as production behaviour: a request landing on a socket the peer
    /// had already closed gets RST, the first read failed with `ConnectionReset`,
    /// that was classified `Failed` — "bytes started flowing, not retry-safe" —
    /// and `keepalive_roundtrip` returned `Network` instead of retrying on a
    /// fresh connection. A sync cycle failed for exactly the condition the retry
    /// path exists to absorb.
    #[test]
    fn a_peer_teardown_before_any_byte_is_retry_safe() {
        for kind in [
            std::io::ErrorKind::ConnectionReset,
            std::io::ErrorKind::ConnectionAborted,
            std::io::ErrorKind::BrokenPipe,
            std::io::ErrorKind::NotConnected,
        ] {
            let mut r = ResettingReader { kind, fired: false };
            assert_eq!(
                read_http_response(&mut r, false, MAX_BYTES).unwrap_err(),
                HttpReadError::EofBeforeResponse,
                "{kind:?} before any response byte must be retry-safe"
            );
        }
    }

    /// The narrowness is the point. A read TIMEOUT is NOT a teardown: the server
    /// may have received and processed the request and simply be slow, so
    /// retrying a non-idempotent push on that basis could apply it twice.
    #[test]
    fn a_timeout_is_not_treated_as_a_stale_connection() {
        let mut r = ResettingReader {
            kind: std::io::ErrorKind::WouldBlock,
            fired: false,
        };
        assert_eq!(
            read_http_response(&mut r, false, MAX_BYTES).unwrap_err(),
            HttpReadError::Failed
        );
    }

    #[test]
    fn oversized_content_length_rejected_before_buffering() {
        let raw = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            MAX_BYTES + 1
        );
        assert_eq!(
            read_http_response(&mut std::io::Cursor::new(raw.as_bytes()), false, MAX_BYTES)
                .unwrap_err(),
            HttpReadError::TooLarge
        );
    }

    /// myne#295 — a chunk-size line the peer chooses must be clamped BEFORE it
    /// reaches any arithmetic.
    ///
    /// The wire below is minimal: one non-empty chunk so `body.len() > 0`, then a
    /// size near `u64::MAX`. The old guard added the two, which a debug build
    /// aborts on and a release build wraps — past the cap, then to a zero-length
    /// resize, then a panic slicing `body[1..]`. Natively that unwind surfaced as
    /// an opaque `Internal`/`Network` and poisoned the cycle's transport mutex,
    /// so sync stayed broken against that server with no diagnosable error.
    ///
    /// Chunked is the ordinary path behind a reverse proxy, and a hostile relay
    /// is explicitly in scope (TB5).
    #[test]
    fn a_chunk_size_near_u64_max_is_rejected_not_overflowed() {
        let raw: &[u8] =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nA\r\nffffffffffffffff\r\n";
        assert_eq!(
            read_http_response(&mut std::io::Cursor::new(raw), false, MAX_BYTES).unwrap_err(),
            HttpReadError::TooLarge
        );
    }

    #[test]
    fn a_single_oversized_chunk_is_still_too_large() {
        let raw = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n",
            MAX_BYTES + 1
        );
        assert_eq!(
            read_http_response(&mut std::io::Cursor::new(raw.as_bytes()), false, MAX_BYTES)
                .unwrap_err(),
            HttpReadError::TooLarge
        );
    }

    #[test]
    fn an_ordinary_chunked_body_still_decodes() {
        // The clamp must not narrow the honest path it guards.
        let raw: &[u8] =
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n2\r\n!!\r\n0\r\n\r\n";
        let (r, _) = read_http_response(&mut std::io::Cursor::new(raw), false, MAX_BYTES).unwrap();
        assert_eq!(r.body, b"hello!!");
    }

    #[test]
    fn head_response_skips_body_framing_and_stays_reusable() {
        let raw: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 9999\r\nX-Complete: 1\r\n\r\n";
        let (r, reuse) =
            read_http_response(&mut std::io::Cursor::new(raw), true, MAX_BYTES).unwrap();
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
        let (r, reuse) = read_http_response(&mut reader, false, MAX_BYTES).unwrap();
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
                MAX_BYTES,
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
            MAX_BYTES,
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
            MAX_BYTES,
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
            MAX_BYTES,
        )
        .unwrap_err();
        assert_eq!(err, TransportError::Network);
        assert_eq!(connects.get(), 1, "no retry loop on a fresh connection");
    }
}
