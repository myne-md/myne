// SPDX-License-Identifier: AGPL-3.0
//! Streaming HTTPS GET for on-demand AI model downloads (myne-md/myne#805,
//! `decisions/ai/0628`).
//!
//! This is the socket a model fetch leaves the device through. It exists as its
//! own module, in `core::inference` rather than in the desktop plugin, for one
//! mechanical reason and two security ones:
//!
//! **Mechanical.** The TLS stack (`rustls` + `webpki-roots`), the shared HTTP
//! codec ([`crate::http::codec`]) and the Tor routing seam
//! ([`crate::plugins::sync::proxy`]) all live in this crate, not in
//! `src-tauri`. Putting the transport here is what lets the download reuse the
//! exact verification and routing decisions native sync already makes instead of
//! growing a second TLS stack.
//!
//! **Security, one: the destination is a compiled-in constant.** The only
//! arguments are a host string supplied by the caller from a compiled-in table
//! (`downloads.myne.md`, in the desktop digest table). This module never reads a
//! base URL from prefs, from the WebView, or from the origin's own index.
//!
//! **Security, two: verification has no fallback.** The trust anchor is the
//! static `webpki-roots` Mozilla bundle, the same one native sync and the
//! remote-provider arm use (`decisions/sync/0620`), so a download origin is
//! verified by public CA plus hostname and cannot be pinned around. There is no
//! accept-anything verifier here.
//!
//! **Why the body is streamed and not buffered.** A model artefact is
//! hundreds of MB, far past the 64 MiB `MAX_SYNC_RESPONSE_BYTES` the sync
//! transport
//! passes to the codec, and holding it whole in RAM would be its own denial of
//! service. So this module reuses the codec's request framing and response
//! *head* parser and streams the body to a caller-supplied [`Write`] sink in
//! bounded chunks, checking cancellation and a hard byte ceiling as it goes.
//!
//! **No filesystem here, on purpose.** The body goes to a `Write` the caller
//! owns (`check-core-io-seam.mjs` would otherwise fire, and `std::fs` in this
//! crate is a wasm hazard). The desktop command opens the staging file, calls
//! this transport, and removes the staging directory on failure; the model store
//! then verifies the staged file's SHA-256 before registering it.
//!
//! Logging: nothing here logs a host, a path or a byte of the body
//! (`src-tauri/AGENTS.md` DENY list). [`ModelDownloadError`] variants are unit
//! or numeric only.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::sync::Arc;
use std::time::Duration;

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};

use crate::http::codec::{build_http_request_ext, read_response_head, HttpReadError};
use crate::http::HttpMethod;
use crate::inference::cancellable_io::CancelledFn;
use crate::plugins::sync::proxy::{self, ProxyGate, Route};
use crate::plugins::sync::socks5::connect_via_socks5;

/// Per-`read`/`write` deadline. A large artefact arrives as many small reads, so
/// this bounds a stalled peer rather than the whole transfer.
const IO_TIMEOUT: Duration = Duration::from_secs(180);

/// Body read chunk. Bounded memory regardless of artefact size.
const READ_CHUNK: usize = 64 * 1024;

/// Hard ceiling on a single download, independent of the caller's `max_bytes`.
/// The largest offered artefact is ~471 MB; this leaves generous headroom while
/// refusing a hostile origin that would otherwise fill the disk.
pub const MAX_MODEL_DOWNLOAD_BYTES: u64 = 1024 * 1024 * 1024;

/// Failure modes of the streaming download. Unit or numeric variants only: no
/// host, path, OS error string or byte of the body (`src-tauri/AGENTS.md`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, thiserror::Error)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum ModelDownloadError {
    /// The request could not be built (bad host/path).
    #[error("model download request could not be built")]
    BadRequest,
    /// Connection / DNS / socket failure, or a transport refusal.
    #[error("model download network failure")]
    Network,
    /// TLS handshake or certificate verification failed.
    #[error("model download tls failure")]
    Tls,
    /// The origin answered a non-200 status. Carries the code, never a body.
    #[error("model download rejected with status {0}")]
    HttpStatus(u16),
    /// The response body, or frameless stream, exceeded the ceiling.
    #[error("model download exceeded its size ceiling")]
    TooLarge,
    /// The caller's cancellation predicate fired mid-transfer.
    #[error("model download cancelled")]
    Cancelled,
    /// Writing to the caller's sink failed.
    #[error("model download io failure")]
    Io,
}

/// The one place this module names the production trust anchors, so a test can
/// read the same store the constructor loads (the `rustls_transport.rs` lesson:
/// an inlined store is private to the built config and cannot be asserted on).
pub fn bundled_roots() -> RootCertStore {
    RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    }
}

fn client_config(roots: RootCertStore) -> ClientConfig {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .expect("ring provider supports the default protocol versions")
        .with_root_certificates(roots)
        .with_no_client_auth()
}

/// Classify a handshake `io::Error` the same way the sync transport does: a
/// rustls error inside is a TLS fault, anything else is the socket dying.
fn handshake_error(e: std::io::Error) -> ModelDownloadError {
    match e
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<rustls::Error>())
    {
        Some(_) => ModelDownloadError::Tls,
        None => ModelDownloadError::Network,
    }
}

fn map_head_error(e: HttpReadError) -> ModelDownloadError {
    match e {
        HttpReadError::TooLarge => ModelDownloadError::TooLarge,
        HttpReadError::EofBeforeResponse | HttpReadError::Failed => ModelDownloadError::Network,
    }
}

/// **The one place this module opens a socket**, and therefore where the
/// fail-closed invariant lives.
///
/// With Tor mode on and the proxy anything other than `Ready`, this returns
/// without opening a socket. There is no direct-connect fallback: falling back
/// would leak the device's real source IP at the moment the user believed they
/// were protected (same invariant as `rustls_transport::open_socket_via`).
fn open_socket_via(
    proxy: &ProxyGate,
    host: &str,
    port: u16,
) -> Result<TcpStream, ModelDownloadError> {
    match proxy.route() {
        Ok(Route::Direct) => {
            TcpStream::connect((host, port)).map_err(|_| ModelDownloadError::Network)
        }
        Ok(Route::Socks5 { socks_port }) => {
            connect_via_socks5(socks_port, host, port).map_err(|_| ModelDownloadError::Network)
        }
        Err(denied) => {
            tracing::warn!(
                event = "model_download_tor_fail_closed",
                reason = ?denied,
                "Tor routing is on and the proxy is not ready; refusing to fetch a model"
            );
            Err(ModelDownloadError::Network)
        }
    }
}

/// Download `https://host:port/path` into `sink`, streaming the body.
///
/// The size ceiling is `min(max_bytes, MAX_MODEL_DOWNLOAD_BYTES)`. The caller
/// owns cleanup of any bytes already written to `sink` on error.
pub fn download_https<W: Write>(
    host: &str,
    port: u16,
    path: &str,
    sink: &mut W,
    max_bytes: u64,
    cancelled: &CancelledFn,
) -> Result<u64, ModelDownloadError> {
    let gate = proxy::installed_for(host);
    download_https_with_gate_and_roots(
        host,
        port,
        path,
        sink,
        max_bytes,
        cancelled,
        gate,
        bundled_roots(),
    )
}

/// Download `https://host:port/path` into `sink` over an unencrypted socket.
///
/// **Only for the E2E fixture origin** (a local plain-HTTP test server). The
/// function is compiled ONLY under `local-inference-stub`, so no production or
/// audit build carries a certificate-less transport at all: the desktop crate's
/// `local-inference-stub` feature chains to this one, and production fetches
/// over TLS with [`download_https`], whose certificate check is the security
/// property. This exists so the E2E scenario can serve a fixture without
/// minting a CA the production trust store would have to accept.
#[cfg(feature = "local-inference-stub")]
pub fn download_http<W: Write>(
    host: &str,
    port: u16,
    path: &str,
    sink: &mut W,
    max_bytes: u64,
    cancelled: &CancelledFn,
) -> Result<u64, ModelDownloadError> {
    let gate = proxy::installed_for(host);
    let sock = open_socket_via(&gate, host, port)?;
    let _ = sock.set_read_timeout(Some(IO_TIMEOUT));
    let _ = sock.set_write_timeout(Some(IO_TIMEOUT));
    fetch_to_writer(sock, host, path, sink, max_bytes, cancelled)
}

/// [`download_https`] with an explicit routing gate and trust store. Production
/// goes through [`download_https`]; this exists so a test can drive a gate and a
/// CA bundle it owns rather than the process-global ones.
#[allow(clippy::too_many_arguments)]
pub fn download_https_with_gate_and_roots<W: Write>(
    host: &str,
    port: u16,
    path: &str,
    sink: &mut W,
    max_bytes: u64,
    cancelled: &CancelledFn,
    gate: ProxyGate,
    roots: RootCertStore,
) -> Result<u64, ModelDownloadError> {
    let server_name =
        ServerName::try_from(host.to_string()).map_err(|_| ModelDownloadError::BadRequest)?;
    let conn = ClientConnection::new(Arc::new(client_config(roots)), server_name)
        .map_err(|_| ModelDownloadError::Tls)?;
    let sock = open_socket_via(&gate, host, port)?;
    let _ = sock.set_read_timeout(Some(IO_TIMEOUT));
    let _ = sock.set_write_timeout(Some(IO_TIMEOUT));
    let mut stream = StreamOwned::new(conn, sock);
    // Complete the handshake at the one place that opened the socket, before any
    // caller can mislabel a verification refusal as a network fault.
    while stream.conn.is_handshaking() {
        let (rd, wr) = stream
            .conn
            .complete_io(&mut stream.sock)
            .map_err(handshake_error)?;
        if rd == 0 && wr == 0 {
            break; // peer closed mid-handshake
        }
    }
    fetch_to_writer(stream, host, path, sink, max_bytes, cancelled)
}

/// Request framing and streaming body copy, pure over any `Read + Write`
/// transport. Split out from the TLS connect so the framing, the size ceiling,
/// the cancellation check and the chunked/`Content-Length` handling are testable
/// without a socket.
pub fn fetch_to_writer<S: Read + Write, W: Write>(
    stream: S,
    host: &str,
    path: &str,
    sink: &mut W,
    max_bytes: u64,
    cancelled: &CancelledFn,
) -> Result<u64, ModelDownloadError> {
    let ceiling = max_bytes.min(MAX_MODEL_DOWNLOAD_BYTES);
    let req = build_http_request_ext(
        HttpMethod::Get,
        path,
        host,
        &[("Accept", "application/octet-stream")],
        b"",
        None,
    );
    let mut stream = BufReader::new(stream);
    stream
        .get_mut()
        .write_all(&req)
        .and_then(|_| stream.get_mut().flush())
        .map_err(|_| ModelDownloadError::Network)?;

    let head = read_response_head(&mut stream).map_err(map_head_error)?;
    if head.status != 200 {
        return Err(ModelDownloadError::HttpStatus(head.status));
    }

    if head.chunked {
        copy_chunked(&mut stream, sink, ceiling, cancelled)
    } else if let Some(n) = head.content_length {
        if n > ceiling {
            return Err(ModelDownloadError::TooLarge);
        }
        copy_exact(&mut stream, sink, n, cancelled)
    } else {
        copy_until_eof(&mut stream, sink, ceiling, cancelled)
    }
}

/// Copy exactly `n` body bytes, checking cancellation each chunk.
fn copy_exact<R: Read, W: Write>(
    reader: &mut R,
    sink: &mut W,
    n: u64,
    cancelled: &CancelledFn,
) -> Result<u64, ModelDownloadError> {
    let mut remaining = n;
    let mut buf = [0u8; READ_CHUNK];
    while remaining > 0 {
        if cancelled() {
            return Err(ModelDownloadError::Cancelled);
        }
        let want = remaining.min(READ_CHUNK as u64) as usize;
        let read = reader
            .read(&mut buf[..want])
            .map_err(|_| ModelDownloadError::Network)?;
        if read == 0 {
            return Err(ModelDownloadError::Network); // truncated body
        }
        sink.write_all(&buf[..read])
            .map_err(|_| ModelDownloadError::Io)?;
        remaining -= read as u64;
    }
    Ok(n)
}

/// Copy an EOF-framed body (no `Content-Length`, not chunked) under the ceiling.
fn copy_until_eof<R: Read, W: Write>(
    reader: &mut R,
    sink: &mut W,
    ceiling: u64,
    cancelled: &CancelledFn,
) -> Result<u64, ModelDownloadError> {
    let mut total: u64 = 0;
    let mut buf = [0u8; READ_CHUNK];
    loop {
        if cancelled() {
            return Err(ModelDownloadError::Cancelled);
        }
        let read = reader
            .read(&mut buf)
            .map_err(|_| ModelDownloadError::Network)?;
        if read == 0 {
            return Ok(total);
        }
        total = total.saturating_add(read as u64);
        if total > ceiling {
            return Err(ModelDownloadError::TooLarge);
        }
        sink.write_all(&buf[..read])
            .map_err(|_| ModelDownloadError::Io)?;
    }
}

/// Stream a chunked body (RFC 7230 §4.1) under the ceiling, draining trailers so
/// a keep-alive connection would stay usable. Cancellation is checked per chunk.
fn copy_chunked<R: BufRead, W: Write>(
    reader: &mut R,
    sink: &mut W,
    ceiling: u64,
    cancelled: &CancelledFn,
) -> Result<u64, ModelDownloadError> {
    let mut total: u64 = 0;
    let mut buf = [0u8; READ_CHUNK];
    loop {
        if cancelled() {
            return Err(ModelDownloadError::Cancelled);
        }
        let size_line = read_line(reader)?;
        let size_str = size_line.split(';').next().unwrap_or("").trim();
        let size = u64::from_str_radix(size_str, 16).map_err(|_| ModelDownloadError::Network)?;
        if size == 0 {
            // Trailer section: drain to the terminating empty line.
            loop {
                if read_line(reader)?.is_empty() {
                    return Ok(total);
                }
            }
        }
        if total.saturating_add(size) > ceiling {
            return Err(ModelDownloadError::TooLarge);
        }
        let mut remaining = size;
        while remaining > 0 {
            if cancelled() {
                return Err(ModelDownloadError::Cancelled);
            }
            let want = remaining.min(READ_CHUNK as u64) as usize;
            let read = reader
                .read(&mut buf[..want])
                .map_err(|_| ModelDownloadError::Network)?;
            if read == 0 {
                return Err(ModelDownloadError::Network);
            }
            sink.write_all(&buf[..read])
                .map_err(|_| ModelDownloadError::Io)?;
            remaining -= read as u64;
        }
        // Each chunk's data is followed by CRLF.
        let mut crlf = [0u8; 2];
        reader
            .read_exact(&mut crlf)
            .map_err(|_| ModelDownloadError::Network)?;
        if &crlf != b"\r\n" {
            return Err(ModelDownloadError::Network);
        }
        total += size;
    }
}

/// Cap on a single framing line (chunk-size or trailer). A hostile or broken
/// origin that opens a chunked body and never sends a newline would otherwise
/// let `read_until` grow the buffer without bound until the IO timeout or OOM;
/// the body ceiling is not consulted on this path. Chunk-size lines and trailer
/// fields are short by definition, so 1024 bytes is generous.
const MAX_LINE_BYTES: usize = 1024;

/// Read one CRLF/LF-terminated line, bounded. A clean EOF mid-framing is an
/// error here, because every caller is between framing elements where a line is
/// mandatory.
fn read_line<R: BufRead>(reader: &mut R) -> Result<String, ModelDownloadError> {
    let mut line = Vec::new();
    let n = reader
        .by_ref()
        .take(MAX_LINE_BYTES as u64 + 1)
        .read_until(b'\n', &mut line)
        .map_err(|_| ModelDownloadError::Network)?;
    if n == 0 || !line.ends_with(b"\n") || line.len() > MAX_LINE_BYTES {
        return Err(ModelDownloadError::Network);
    }
    while matches!(line.last(), Some(b'\n') | Some(b'\r')) {
        line.pop();
    }
    String::from_utf8(line).map_err(|_| ModelDownloadError::Network)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn never() -> CancelledFn {
        Arc::new(|| false)
    }

    /// A `Read + Write` duplex over an in-memory response, so the framing and
    /// body copy are exercised without a socket. Writes are discarded.
    struct Duplex {
        input: Cursor<Vec<u8>>,
    }
    impl Read for Duplex {
        fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
            self.input.read(buf)
        }
    }
    impl Write for Duplex {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn duplex(raw: Vec<u8>) -> Duplex {
        Duplex {
            input: Cursor::new(raw),
        }
    }

    #[test]
    fn content_length_body_lands_in_the_sink() {
        let body = b"model-bytes-here";
        let mut raw =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
        raw.extend_from_slice(body);
        let mut out: Vec<u8> = Vec::new();
        let written =
            fetch_to_writer(duplex(raw), "h", "/p", &mut out, u64::MAX, &never()).expect("fetch");
        assert_eq!(written, body.len() as u64);
        assert_eq!(out, body);
    }

    #[test]
    fn chunked_body_decodes_to_the_sink() {
        let raw: &[u8] = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        let mut out: Vec<u8> = Vec::new();
        let written = fetch_to_writer(
            duplex(raw.to_vec()),
            "h",
            "/p",
            &mut out,
            u64::MAX,
            &never(),
        )
        .expect("fetch");
        assert_eq!(written, 11);
        assert_eq!(out, b"hello world");
    }

    #[test]
    fn non_200_status_is_named_and_writes_nothing() {
        let raw: &[u8] = b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
        let mut out: Vec<u8> = Vec::new();
        assert_eq!(
            fetch_to_writer(
                duplex(raw.to_vec()),
                "h",
                "/p",
                &mut out,
                u64::MAX,
                &never()
            ),
            Err(ModelDownloadError::HttpStatus(404))
        );
        assert!(out.is_empty(), "a non-200 writes no body bytes");
    }

    #[test]
    fn a_truncated_body_is_a_network_error() {
        // Content-Length says 10, only 3 bytes follow.
        let raw: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc";
        let mut out: Vec<u8> = Vec::new();
        assert_eq!(
            fetch_to_writer(
                duplex(raw.to_vec()),
                "h",
                "/p",
                &mut out,
                u64::MAX,
                &never()
            ),
            Err(ModelDownloadError::Network)
        );
    }

    #[test]
    fn a_body_past_the_ceiling_is_too_large() {
        let raw: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n";
        let mut out: Vec<u8> = Vec::new();
        assert_eq!(
            fetch_to_writer(duplex(raw.to_vec()), "h", "/p", &mut out, 10, &never()),
            Err(ModelDownloadError::TooLarge)
        );
        assert!(out.is_empty());
    }

    #[test]
    fn cancellation_stops_the_transfer() {
        let body = vec![0u8; 4096];
        let mut raw =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
        raw.extend_from_slice(&body);
        let mut out: Vec<u8> = Vec::new();
        // Cancel immediately: the first copy loop iteration must observe it.
        let cancelled: CancelledFn = Arc::new(|| true);
        assert_eq!(
            fetch_to_writer(duplex(raw), "h", "/p", &mut out, u64::MAX, &cancelled),
            Err(ModelDownloadError::Cancelled)
        );
    }

    /// The production constructor loads a real public CA bundle; an empty or
    /// filtered store would silently change which origins can be reached.
    #[test]
    fn the_production_trust_anchor_is_the_bundled_public_roots() {
        let roots = bundled_roots();
        assert_eq!(roots.roots.len(), webpki_roots::TLS_SERVER_ROOTS.len());
        assert!(roots.roots.len() > 100);
    }

    /// **Fail-closed**, mirroring the sync transport's test: with Tor mode on and
    /// the proxy not ready, the download refuses WITHOUT opening a socket. The
    /// probe is a real listener counting accepts; the control arm proves the
    /// probe can see a connection, so the zero is meaningful.
    #[test]
    fn tor_on_with_no_ready_proxy_fails_closed_and_dials_nothing() {
        use crate::plugins::sync::proxy::TorProxyState;
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind probe");
        let port = listener.local_addr().expect("addr").port();
        let accepts = Arc::new(AtomicUsize::new(0));
        let counter = accepts.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                if stream.is_err() {
                    return;
                }
                counter.fetch_add(1, Ordering::SeqCst);
            }
        });

        // Tor mode on, sidecar not ready. Note the host is loopback only so the
        // probe is reachable; the gate is injected, and the loopback exemption
        // lives in `installed_for`, not here, so the injected gate is obeyed.
        let gate = ProxyGate::new();
        gate.set_enabled(true);
        gate.set_state(TorProxyState::Starting);
        let mut out: Vec<u8> = Vec::new();
        assert_eq!(
            download_https_with_gate_and_roots(
                "localhost",
                port,
                "/models/x",
                &mut out,
                u64::MAX,
                &never(),
                gate,
                bundled_roots(),
            ),
            Err(ModelDownloadError::Network)
        );
        std::thread::sleep(Duration::from_millis(150));
        assert_eq!(
            accepts.load(Ordering::SeqCst),
            0,
            "fail-closed means ZERO direct connections to the origin"
        );

        // Control: with a direct gate the probe DOES see a connection attempt
        // (the TLS handshake then fails, but the socket was opened).
        let mut out2: Vec<u8> = Vec::new();
        let _ = download_https_with_gate_and_roots(
            "localhost",
            port,
            "/models/x",
            &mut out2,
            u64::MAX,
            &never(),
            ProxyGate::new(),
            bundled_roots(),
        );
        std::thread::sleep(Duration::from_millis(150));
        assert!(
            accepts.load(Ordering::SeqCst) >= 1,
            "the probe must be able to observe a direct connection, or the zero proves nothing"
        );
    }

    /// The positive half of the Tor acceptance: with the proxy Ready, opening
    /// the download socket goes through it, and the target reaches the proxy as
    /// a **hostname** (remote DNS), never a locally resolved address. This
    /// exercises the same `open_socket_via` the real fetch uses.
    #[test]
    fn a_tor_ready_gate_routes_the_download_socket_through_the_proxy() {
        use crate::plugins::sync::proxy::TorProxyState;
        use crate::plugins::sync::socks5::fake::{Behavior, FakeSocks5, SeenTarget};
        use std::net::TcpListener;

        // A target the fake proxy splices to. It never speaks TLS; this test is
        // about which socket path was taken, not what came back over it.
        let target = TcpListener::bind("127.0.0.1:0").expect("bind target");
        let target_port = target.local_addr().expect("addr").port();
        let proxy = FakeSocks5::spawn(1, Behavior::Splice(target_port));

        let gate = ProxyGate::new();
        gate.set_enabled(true);
        gate.set_state(TorProxyState::Ready {
            socks_port: proxy.port,
        });
        let stream = open_socket_via(&gate, "downloads.myne.md", 443)
            .expect("a ready proxy yields a tunnelled socket");
        drop(stream);

        assert_eq!(
            proxy.seen(),
            vec![SeenTarget {
                atyp: 0x03,
                host: "downloads.myne.md".to_string(),
                port: 443,
            }],
            "the fetch must travel as a hostname CONNECT through the sidecar"
        );
    }
}
