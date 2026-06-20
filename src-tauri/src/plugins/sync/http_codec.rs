//! Minimal HTTP/1.1 codec shared by the sync transports (MYND-424 task 2).
//!
//! Both the production `RustlsTransport` (https) and the dev/harness
//! `HttpTransport` (loopback http) speak the same tiny `Connection: close`
//! HTTP/1.1 — only the byte stream underneath differs (TLS vs plain TCP). The
//! codec is pure (no IO), so it is unit-tested once here and reused by both.

use super::transport::{HttpMethod, TransportResponse};

/// Build a minimal HTTP/1.1 request (`Connection: close`).
pub(crate) fn build_http_request(
    method: HttpMethod,
    path: &str,
    host: &str,
    body: &[u8],
    token: Option<&str>,
) -> Vec<u8> {
    let verb = match method {
        HttpMethod::Get => "GET",
        HttpMethod::Post => "POST",
        HttpMethod::Put => "PUT",
    };
    let mut head = String::new();
    head.push_str(&format!("{verb} {path} HTTP/1.1\r\n"));
    head.push_str(&format!("Host: {host}\r\n"));
    if let Some(t) = token {
        head.push_str(&format!("Authorization: Bearer {t}\r\n"));
    }
    if !body.is_empty() {
        head.push_str("Content-Type: application/json\r\n");
    }
    head.push_str(&format!("Content-Length: {}\r\n", body.len()));
    head.push_str("Connection: close\r\n\r\n");
    let mut out = head.into_bytes();
    out.extend_from_slice(body);
    out
}

/// Parse an HTTP/1.1 response into `(status, body)` (status line, then headers,
/// then body). The body is framed by, in precedence order: `Transfer-Encoding:
/// chunked` (de-chunked here — RFC 7230 §3.3.1 requires every HTTP/1.1 recipient
/// to parse it), else `Content-Length` (exactly N bytes), else read-to-EOF
/// (`Connection: close`, the original assumption). A reverse proxy (e.g. Caddy)
/// in front of the Go server streams responses over ~2 KiB chunked — the dev
/// loopback path talks to the Go server directly with `Content-Length`, so the
/// chunked path is production-only and was the cause of large `/sync/pull` and
/// `/sync/blob` bodies arriving JSON-corrupted (chunk-size markers inline).
pub(crate) fn parse_http_response(raw: &[u8]) -> Option<TransportResponse> {
    let sep = find_subslice(raw, b"\r\n\r\n")?;
    let head = &raw[..sep];
    let raw_body = &raw[sep + 4..];
    let first_line_end = find_subslice(head, b"\r\n").unwrap_or(head.len());
    let status_line = core::str::from_utf8(&head[..first_line_end]).ok()?;
    let mut parts = status_line.split(' ');
    let _http = parts.next()?;
    let status: u16 = parts.next()?.parse().ok()?;

    // Scan the header lines (case-insensitive) for the body framing.
    let header_block = core::str::from_utf8(head).ok()?;
    let mut chunked = false;
    let mut content_length: Option<usize> = None;
    for line in header_block.split("\r\n").skip(1) {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked") {
            chunked = true;
        } else if name == "content-length" {
            content_length = value.parse::<usize>().ok();
        }
    }

    let body = if chunked {
        dechunk(raw_body)?
    } else if let Some(n) = content_length {
        // Exactly N bytes; a short read (incomplete response) is a parse failure.
        if raw_body.len() < n {
            return None;
        }
        raw_body[..n].to_vec()
    } else {
        raw_body.to_vec()
    };
    Some(TransportResponse { status, body })
}

/// Decode an HTTP/1.1 chunked transfer-coded body (RFC 7230 §4.1): a sequence of
/// `<hex-size>[;ext]\r\n<data>\r\n` chunks terminated by a `0\r\n` chunk. Chunk
/// extensions and trailers are ignored. Returns `None` on any malformed framing
/// (a truncated chunk, a non-hex size, a missing CRLF) rather than guessing.
fn dechunk(mut data: &[u8]) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    loop {
        let line_end = find_subslice(data, b"\r\n")?;
        let size_line = core::str::from_utf8(&data[..line_end]).ok()?;
        // Strip any chunk extension (everything after the first ';').
        let size_str = size_line.split(';').next()?.trim();
        let size = usize::from_str_radix(size_str, 16).ok()?;
        data = &data[line_end + 2..];
        if size == 0 {
            break; // last chunk — trailers + final CRLF are ignored
        }
        if data.len() < size {
            return None;
        }
        out.extend_from_slice(&data[..size]);
        data = &data[size..];
        // Each chunk's data is followed by a CRLF.
        if data.len() < 2 || &data[..2] != b"\r\n" {
            return None;
        }
        data = &data[2..];
    }
    Some(out)
}

pub(crate) fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack.windows(needle.len()).position(|w| w == needle)
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
}
