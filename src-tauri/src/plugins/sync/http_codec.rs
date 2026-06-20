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

/// Parse an HTTP/1.1 response into `(status, body)`: status line + header block
/// + body (everything after the blank line; `Connection: close` ⇒ read-to-EOF).
pub(crate) fn parse_http_response(raw: &[u8]) -> Option<TransportResponse> {
    let sep = find_subslice(raw, b"\r\n\r\n")?;
    let head = &raw[..sep];
    let body = raw[sep + 4..].to_vec();
    let first_line_end = find_subslice(head, b"\r\n").unwrap_or(head.len());
    let status_line = core::str::from_utf8(&head[..first_line_end]).ok()?;
    let mut parts = status_line.split(' ');
    let _http = parts.next()?;
    let status: u16 = parts.next()?.parse().ok()?;
    Some(TransportResponse { status, body })
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
}
