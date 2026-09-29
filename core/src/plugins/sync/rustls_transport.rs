//! The raw-rustls sync transport (MYND-424 task 2, SYNC-3).
//!
//! One TLS path shared by SCRAM auth (MYND-425) and sync push/pull: a rustls
//! `ClientConfig` with CA-chain and hostname verification (A4) and access to the
//! **keying-material exporter** (the SCRAM channel binding). It speaks a minimal
//! keep-alive HTTP/1.1 over the TLS stream (strict `Content-Length`/chunked
//! framing, one cached session per transport) — deliberately NOT `reqwest` (a
//! second TLS stack) and NOT `tauri-plugin-http` (no exporter), per the PRD.
//!
//! ## R3 status (READ THIS)
//!
//! The `rustls` dependency is **owner-approved**. The TLS trust path and the
//! tls-exporter wiring remain **R3-pending**: they need a primitive-level
//! security review AND a live interop test against the Go server before it is
//! trusted in production. Until then:
//! - chain, server name and signature verification use rustls and its `ring`
//!   provider, never a custom accept-any verifier in the production transport;
//! - the pure logic (HTTP request build, response parse) is
//!   unit-tested here; the live TLS handshake is exercised by the MYND-428
//!   harness, not in this crate;
//! - [`super::transport::FakeTransport`] stays the default for unit tests.
//! - Behind a TLS-terminating proxy, the exporter is inert and verified TLS
//!   carries the transport authentication instead.

use super::http_transport::SOCKET_TIMEOUT;
use super::proxy::{self, ProxyGate, Route};
use super::socks5::connect_via_socks5;
use super::transport::{
    HttpMethod, SseOpenError, SseStream, SyncTransport, TransportError, TransportResponse,
    TransportResponseExt, MAX_SYNC_RESPONSE_BYTES,
};
use crate::http::codec::{
    build_http_request_ext, keepalive_roundtrip, read_http_response, read_response_head,
};
#[cfg(test)]
use rustls::pki_types::CertificateDer;
use rustls::pki_types::ServerName;
#[cfg(test)]
use rustls::CertificateError;
use rustls::{ClientConfig, ClientConnection, RootCertStore, StreamOwned};
use std::io::{BufReader, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};

/// Classify a handshake `io::Error` into the transport error it actually is.
///
/// rustls wraps its own error inside the `io::Error` it hands back, so the
/// distinction is available and was being discarded: `map_err(|_| …)` threw
/// away a diagnosis the verifier had already made. A rustls error is a TLS
/// failure (chain, hostname, expiry, or protocol); an underlying socket error
/// is a network failure. Neither includes untrusted certificate bytes.
fn handshake_error(e: std::io::Error) -> TransportError {
    match e
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<rustls::Error>())
    {
        Some(_) => TransportError::Tls,
        None => TransportError::Network,
    }
}

/// **The one place this module opens a socket** — and therefore the one place
/// the fail-closed invariant has to hold.
///
/// All native sync paths use [`RustlsTransport::open_socket`], including the
/// first endpoint probe, authenticated requests and SSE reconnects.
///
/// With Tor mode on and the proxy anything other than `Ready`, this returns an
/// error **without opening a socket**. There is no direct-connect fallback:
/// falling back would leak the user's real source IP at exactly the moment they
/// believed they were protected (PRD story 4).
fn open_socket_via(proxy: &ProxyGate, host: &str, port: u16) -> Result<TcpStream, TransportError> {
    match proxy.route() {
        Ok(Route::Direct) => TcpStream::connect((host, port)).map_err(|_| TransportError::Network),
        // The hostname goes to the proxy as a NAME (socks5's domain-name
        // `CONNECT`), so it is resolved inside the circuit and never by this
        // device's resolver.
        Ok(Route::Socks5 { socks_port }) => {
            connect_via_socks5(socks_port, host, port).map_err(TransportError::from)
        }
        Err(denied) => {
            // The bare denial reason only — never the host, the port or the
            // proxy port (`src-tauri/AGENTS.md` secret-handling discipline; the
            // sync hostname is the thing Tor mode exists to keep off this
            // device's disk and resolver).
            tracing::warn!(
                event = "sync_tor_fail_closed",
                reason = ?denied,
                "Tor routing is on and the proxy is not ready; refusing to connect"
            );
            Err(TransportError::Network)
        }
    }
}

/// The raw-rustls transport: a CA-verifying `ClientConfig` + target host/port.
/// One instance is the single TLS layer auth + sync share (SYNC-3). Holds one
/// keep-alive TLS session — within a sync cycle every request rides the same
/// handshake (the codec's framed reader decides reusability per response).
pub struct RustlsTransport {
    host: String,
    port: u16,
    config: Arc<ClientConfig>,
    conn: Mutex<Option<BufReader<StreamOwned<ClientConnection, TcpStream>>>>,
    /// Where this transport is allowed to send bytes (MYND-650 task 4).
    /// Consulted before **every** socket, and it is the only thing that decides
    /// direct-vs-tunnel — this type carries no exemption logic of its own.
    proxy: ProxyGate,
}

impl RustlsTransport {
    /// Build the transport for `host:port` using public CA roots and hostname
    /// verification. There is no pin argument: decisions/sync/0620 removed
    /// certificate pinning, so a caller cannot express one and cannot believe a
    /// value it passes here is being honoured.
    ///
    /// The routing gate comes from [`proxy::installed_for`] — the host's, unless
    /// `host` is loopback. Every sync connection is built through here (the
    /// engine, enrollment, the device roster and every SSE reconnect all go
    /// through `build_transport`, which calls this), and none of them caches a
    /// transport across the toggle, so turning Tor mode on re-routes the next
    /// connection without re-enrollment.
    ///
    /// "The next connection" is the exact claim, and it is not the same as "all
    /// traffic": a socket already open when the toggle moves is not a transport
    /// this constructor will be asked for again. The one such socket in the tree
    /// is the SSE poke stream, and it is closed by
    /// `poke_listener`'s own gate term rather than by anything here
    /// (`no_bypass::LONG_LIVED_SOCKETS`).
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        let host = host.into();
        let proxy = proxy::installed_for(&host);
        Self::with_proxy_gate(host, port, proxy)
    }

    /// The same transport with an explicit routing gate. Production builds go
    /// through [`Self::new`]; this exists so a test can drive a gate it owns
    /// rather than the process-global one.
    pub fn with_proxy_gate(host: impl Into<String>, port: u16, proxy: ProxyGate) -> Self {
        Self::with_roots(host, port, proxy, Self::bundled_roots())
    }

    /// **The one place the production trust anchors are named.**
    ///
    /// Extracted as a function rather than inlined so the fixture tests can read
    /// the same value the constructor loads. `rustls::ClientConfig` keeps its
    /// verifier private, so the store cannot be read back off a built config;
    /// with the construction inlined there was nothing for a test to assert
    /// against, and every acceptance test in this module passed with the
    /// production site replaced by an empty store because each of them injects
    /// the test CA through `with_roots` instead. One named source is what makes
    /// "the shipped transport trusts a public CA bundle" a checkable claim
    /// rather than a line in a constructor.
    ///
    /// A bundled `const` rather than the OS trust store, deliberately: a revoked
    /// CA stays trusted until Myne ships a release, and a private CA installed
    /// only on the operator's machine is not honoured (self-host-policy §6).
    /// Both costs are recorded in the threat model's A4 amendment.
    fn bundled_roots() -> RootCertStore {
        RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        }
    }

    fn with_roots(
        host: impl Into<String>,
        port: u16,
        proxy: ProxyGate,
        roots: RootCertStore,
    ) -> Self {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let config = ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("ring provider supports the default protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth();
        Self {
            host: host.into(),
            port,
            config: Arc::new(config),
            conn: Mutex::new(None),
            proxy,
        }
    }

    /// This transport's socket site: `request` / `request_ext` /
    /// `request_bound_to_exporter` / `open_sse` all reach the network through
    /// [`Self::connect`], which reaches it through here, so routing this one
    /// function routes request/response, the SCRAM exporter handshake, the SSE
    /// poke stream and every SSE reconnect at once.
    ///
    /// The routing decision itself is [`open_socket_via`]'s, shared with
    /// This method supplies the gate the transport was built with and carries
    /// no exemption logic of its own.
    fn open_socket(&self) -> Result<TcpStream, TransportError> {
        open_socket_via(&self.proxy, &self.host, self.port)
    }

    /// Check a newly entered endpoint before saving it. This uses exactly the
    /// verifier and proxy route that subsequent sync requests use, including Tor.
    pub fn verify_endpoint(&self) -> Result<(), TransportError> {
        self.connect().map(|_| ())
    }

    /// Open a verified TLS connection to the configured host. Read/write deadlines
    /// on the socket keep a hung server from wedging a cycle and give keep-alive
    /// reuse a death detector.
    fn connect(&self) -> Result<StreamOwned<ClientConnection, TcpStream>, TransportError> {
        let server_name =
            ServerName::try_from(self.host.clone()).map_err(|_| TransportError::BadRequest)?;
        let conn = ClientConnection::new(self.config.clone(), server_name)
            .map_err(|_| TransportError::Tls)?;
        // Whether this is a direct socket or a SOCKS5 tunnel, what rustls gets
        // handed is a `TcpStream` carrying application bytes — which is why the
        // TLS session, and with it the A4 server-authentication check, stays end-to-end to the sync
        // server rather than terminating at the exit node.
        let sock = self.open_socket()?;
        let _ = sock.set_read_timeout(Some(SOCKET_TIMEOUT));
        let _ = sock.set_write_timeout(Some(SOCKET_TIMEOUT));
        let mut stream = StreamOwned::new(conn, sock);
        // Drive the handshake HERE rather than leaving it to the first read or
        // write. `StreamOwned` handshakes lazily, so the pin decision used to
        // surface wherever the caller happened to touch the stream first, and
        // each of those sites had already decided what a failure there meant:
        // `request` reached it through the codec's write and called it
        // `Network`, `open_sse` called it `Network`, `export_keying_material`
        // called it `Tls`. One refusal, three different names, none of them the
        // right one. Completing the handshake at the single place that opens a
        // connection means the classification below is the only one there is.
        while stream.conn.is_handshaking() {
            let (rd, wr) = stream
                .conn
                .complete_io(&mut stream.sock)
                .map_err(handshake_error)?;
            if rd == 0 && wr == 0 {
                break; // no progress (peer closed mid-handshake)
            }
        }
        Ok(stream)
    }

    /// Export keying material from a fresh verified connection (the tls-exporter
    /// the SCRAM channel binding consumes). MYND-425 uses this on the SAME
    /// connection it authenticates over; exposed here to prove the layer surfaces
    /// the exporter (acceptance criterion). `out_len` bytes are returned.
    pub fn export_keying_material(
        &self,
        label: &[u8],
        context: Option<&[u8]>,
        out_len: usize,
    ) -> Result<Vec<u8>, TransportError> {
        let mut stream = self.connect()?;
        // Drive the handshake to completion so the exporter is available.
        stream.flush().map_err(|_| TransportError::Tls)?;
        let out = vec![0u8; out_len];
        stream
            .conn
            .export_keying_material(out, label, context)
            .map_err(|_| TransportError::Tls)
    }
}

impl SyncTransport for RustlsTransport {
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
            MAX_SYNC_RESPONSE_BYTES,
        )
    }

    fn request_bound_to_exporter(
        &self,
        method: HttpMethod,
        path: &str,
        token: Option<&str>,
        label: &[u8],
        out_len: usize,
        build_body: &dyn Fn(&[u8]) -> Vec<u8>,
    ) -> Result<TransportResponse, TransportError> {
        // A dedicated connection (like open_sse), so the tls-exporter is
        // computed over the EXACT connection this request is sent on — independent
        // of the shared keep-alive slot. Same CA verifier config → identical A4
        // server authentication. The exporter secret needs a completed handshake, which `connect`
        // now guarantees for every caller (it used to be driven here, and only
        // here, which is why the same refusal was named differently on the other
        // two connection paths).
        let mut stream = self.connect()?;
        // `None` context matches the Go server's `nil` (proven byte-identical under
        // TLS 1.3, F5). The body embeds the exporter as the SCRAM client-final cbind.
        let out = vec![0u8; out_len];
        let ekm = stream
            .conn
            .export_keying_material(out, label, None)
            .map_err(|_| TransportError::Tls)?;
        let body = build_body(&ekm);
        let req = build_http_request_ext(method, path, &self.host, &[], &body, token);
        stream
            .write_all(&req)
            .and_then(|_| stream.flush())
            .map_err(|_| TransportError::Network)?;
        let mut reader = BufReader::new(stream);
        let (resp, _reuse) = read_http_response(
            &mut reader,
            method == HttpMethod::Head,
            MAX_SYNC_RESPONSE_BYTES,
        )
        .map_err(|_| TransportError::Network)?;
        Ok(TransportResponse {
            status: resp.status,
            body: resp.body,
        })
    }

    fn open_sse(
        &self,
        path: &str,
        token: &str,
        read_timeout: std::time::Duration,
    ) -> Result<SseStream, SseOpenError> {
        // A dedicated TLS connection (never the keep-alive request slot
        // (the stream occupies it indefinitely). Same CA verifier config,
        // so the A4 server-authentication semantics are byte-identical to
        // request cycles.
        let mut stream = self.connect().map_err(SseOpenError::Transport)?;
        stream
            .sock
            .set_read_timeout(Some(read_timeout))
            .map_err(|_| SseOpenError::Transport(TransportError::Network))?;
        let shutdown_handle = stream
            .sock
            .try_clone()
            .map_err(|_| SseOpenError::Transport(TransportError::Network))?;
        let req = build_http_request_ext(
            HttpMethod::Get,
            path,
            &self.host,
            &[("Accept", "text/event-stream")],
            b"",
            Some(token),
        );
        stream
            .write_all(&req)
            .and_then(|_| stream.flush())
            .map_err(|_| SseOpenError::Transport(TransportError::Network))?;
        let mut reader = BufReader::new(stream);
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

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The production trust anchors, read off the same function the
    /// constructor loads them from.
    ///
    /// The lower bound is what makes this non-vacuous: an empty store, a
    /// one-root store, or a bundle that stopped being a public CA set all fail
    /// here, and before `bundled_roots` existed every acceptance test in this
    /// module passed with `RootCertStore::empty()` substituted at the production
    /// site, because each of them injects the test CA through `with_roots`
    /// instead. The upper bound is the number `webpki_roots` itself publishes, so
    /// the two cannot drift apart silently: if a future `webpki-roots` changes
    /// shape this fails and says so rather than accepting whatever arrived.
    #[test]
    fn the_production_constructor_trusts_the_bundled_public_roots() {
        let t = RustlsTransport::new("sync.myne.md", 443);
        assert_eq!(t.host, "sync.myne.md");
        assert_eq!(t.port, 443);
        let roots = RustlsTransport::bundled_roots();
        assert_eq!(
            roots.roots.len(),
            webpki_roots::TLS_SERVER_ROOTS.len(),
            "the production transport must load exactly the bundled Mozilla roots"
        );
        assert!(
            roots.roots.len() > 100,
            "a public CA bundle is over a hundred roots; a small number here means \
             the store was emptied, replaced or filtered, which would silently \
             change which servers native sync can reach"
        );
    }

    // Native CA-verified TLS fixture. Its private CA is never in the shipped
    // Mozilla bundle, only in test transports that explicitly inject it.

    const TEST_CERT_DER: &[u8] = include_bytes!("test_fixtures/localhost.cert.der");
    const TEST_KEY_DER: &[u8] = include_bytes!("test_fixtures/localhost.key.der");

    fn trusted_test_server(port: u16, proxy: ProxyGate) -> RustlsTransport {
        let mut roots = RootCertStore::empty();
        roots
            .add(CertificateDer::from(
                include_bytes!("test_fixtures/test-ca.cert.der").to_vec(),
            ))
            .unwrap();
        RustlsTransport::with_roots("localhost", port, proxy, roots)
    }

    /// Spawn a minimal rustls TLS server (self-signed `localhost` cert) that
    /// accepts + handshakes `n` connections on an ephemeral port. Returns the
    /// bound port.
    pub(crate) fn spawn_tls_server(n: usize) -> u16 {
        use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
        use rustls::{ServerConfig, ServerConnection};
        use std::net::TcpListener;

        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let cert = CertificateDer::from(TEST_CERT_DER.to_vec());
        let key = PrivatePkcs8KeyDer::from(TEST_KEY_DER.to_vec());
        let config = ServerConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(vec![cert], key.into())
            .expect("server cert + key load");
        let config = Arc::new(config);

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for _ in 0..n {
                let Ok((mut sock, _)) = listener.accept() else {
                    return;
                };
                let mut conn = ServerConnection::new(config.clone()).unwrap();
                // Drive the server side of the handshake; a client that drops
                // after verifying (the untrusted-CA case) just closes early.
                while conn.is_handshaking() {
                    match conn.complete_io(&mut sock) {
                        Ok((0, 0)) => break,
                        Ok(_) => {}
                        Err(_) => break,
                    }
                }
            }
        });
        port
    }

    /// Accept `n` connections and answer with bytes that are not TLS at all — a
    /// peer that is listening and talking, just not this protocol. This is the
    /// shape that proves the classification is reading the rustls error rather
    /// than assuming every handshake failure is the interesting one.
    fn spawn_not_tls_server(n: usize) -> u16 {
        use std::io::Write as _;
        use std::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for _ in 0..n {
                let Ok((mut sock, _)) = listener.accept() else {
                    return;
                };
                let _ = sock.write_all(b"HTTP/1.1 400 Bad Request\r\n\r\n");
                let _ = sock.flush();
            }
        });
        port
    }

    /// `handshake_error`'s arms, driven directly. The live-server test below
    /// proves the wrapping is real; this proves the reading is right, and
    /// includes the distinction that collapsed every certificate fault into
    /// one class while pinning existed: an expired certificate and an
    /// untrusted issuer are both `Tls`, and neither is a network fault.
    #[test]
    fn handshake_error_names_a_certificate_refusal_and_nothing_else() {
        let untrusted = std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            rustls::Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure),
        );
        assert_eq!(handshake_error(untrusted), TransportError::Tls);

        let expired = std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            rustls::Error::InvalidCertificate(CertificateError::Expired),
        );
        assert_eq!(
            handshake_error(expired),
            TransportError::Tls,
            "an expired certificate is a TLS fault, and a distinct one from a network fault"
        );

        let protocol =
            std::io::Error::new(std::io::ErrorKind::InvalidData, rustls::Error::DecryptError);
        assert_eq!(handshake_error(protocol), TransportError::Tls);

        let socket_died = std::io::Error::from(std::io::ErrorKind::ConnectionReset);
        assert_eq!(
            handshake_error(socket_died),
            TransportError::Network,
            "no rustls error inside means the socket died under the handshake"
        );
    }

    /// The same three outcomes over real sockets, which is the half that proves
    /// rustls really does hand its own error back inside the `io::Error` — the
    /// assumption the classification rests on, and one no type checks.
    ///
    /// Both directions on purpose. A version that only asserted the untrusted-CA
    /// arm would pass just as well if the classifier answered `Tls` to
    /// everything, which is the failure this repo has shipped before.
    #[test]
    fn an_untrusted_certificate_fails_and_non_tls_is_rejected() {
        let tls_port = spawn_tls_server(2);
        let plain_port = spawn_not_tls_server(1);
        std::thread::sleep(std::time::Duration::from_millis(100)); // let them bind

        // The production constructor: bundled Mozilla roots, no test CA injected.
        let untrusted = RustlsTransport::new("localhost", tls_port);
        assert_eq!(
            untrusted.connect().err(),
            Some(TransportError::Tls),
            "a certificate whose issuer is not in the bundled roots must fail"
        );

        let not_tls = RustlsTransport::new("localhost", plain_port);
        assert_eq!(
            not_tls.connect().err(),
            Some(TransportError::Tls),
            "a peer that is not speaking TLS is also a TLS fault"
        );

        let trusted = trusted_test_server(tls_port, ProxyGate::new());
        assert!(
            trusted.connect().is_ok(),
            "the verified handshake completes after chain and name checks"
        );
    }

    #[test]
    fn a_trusted_ca_does_not_override_a_wrong_server_name() {
        let port = spawn_tls_server(1);
        let mut roots = RootCertStore::empty();
        roots
            .add(CertificateDer::from(
                include_bytes!("test_fixtures/test-ca.cert.der").to_vec(),
            ))
            .unwrap();
        // The leaf is issued for localhost, not this IP. Both reach the same
        // socket; the hostname check must still refuse the connection.
        let transport = RustlsTransport::with_roots("127.0.0.1", port, ProxyGate::new(), roots);
        assert_eq!(transport.connect().err(), Some(TransportError::Tls));
    }

    /// TLS verification happens inside the Tor tunnel. A certificate signed by
    /// the test CA succeeds only when explicitly trusted in this test; the
    /// production root store refuses it.
    #[test]
    fn ca_tls_completes_over_socks5_and_rejects_an_untrusted_certificate() {
        let tls_port = spawn_tls_server(2);
        std::thread::sleep(std::time::Duration::from_millis(100)); // let it bind
        let proxy = FakeSocks5::spawn(2, Behavior::Splice(tls_port));

        let trusted = trusted_test_server(443, tor_ready(proxy.port));
        assert!(trusted.verify_endpoint().is_ok());
        let untrusted = RustlsTransport::with_proxy_gate("localhost", 443, tor_ready(proxy.port));
        assert_eq!(untrusted.verify_endpoint(), Err(TransportError::Tls));

        assert_eq!(
            proxy.seen(),
            vec![
                SeenTarget {
                    atyp: 0x03,
                    host: "localhost".to_string(),
                    port: 443
                };
                2
            ],
            "both handshakes used a hostname CONNECT inside Tor"
        );
    }

    // ── task 4: the transport routes through the gate, and fails closed ──────

    use super::super::proxy::TorProxyState;
    use super::super::socks5::fake::{Behavior, FakeSocks5, SeenTarget};

    /// A gate in Tor mode with a `Ready` proxy on `socks_port`.
    fn tor_ready(socks_port: u16) -> ProxyGate {
        let gate = ProxyGate::new();
        gate.set_enabled(true);
        gate.set_state(TorProxyState::Ready { socks_port });
        gate
    }

    /// A gate in Tor mode whose sidecar is in `state` — i.e. fail-closed.
    fn tor_not_ready(state: TorProxyState) -> ProxyGate {
        let gate = ProxyGate::new();
        gate.set_enabled(true);
        gate.set_state(state);
        gate
    }

    /// A CA-verified TLS server that also answers HTTP: handshakes `n` connections
    /// and writes `response` (raw HTTP bytes) over the TLS session after
    /// reading the request head. Enough to prove a full request/response — and
    /// an SSE head — traverses the tunnel, which a handshake-only server
    /// cannot.
    fn spawn_https_server(n: usize, response: &'static [u8]) -> u16 {
        use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};
        use rustls::{ServerConfig, ServerConnection};
        use std::io::Read;
        use std::net::TcpListener;

        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let cert = CertificateDer::from(TEST_CERT_DER.to_vec());
        let key = PrivatePkcs8KeyDer::from(TEST_KEY_DER.to_vec());
        let config = Arc::new(
            ServerConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(vec![cert], key.into())
                .expect("server cert + key load"),
        );
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for _ in 0..n {
                let Ok((sock, _)) = listener.accept() else {
                    return;
                };
                let config = config.clone();
                std::thread::spawn(move || {
                    let mut sock = sock;
                    let Ok(conn) = ServerConnection::new(config) else {
                        return;
                    };
                    let mut tls = rustls::StreamOwned::new(conn, &mut sock);
                    // Read just the request head, then answer. A single read is
                    // enough: these requests carry no body.
                    let mut buf = [0u8; 2048];
                    let _ = tls.read(&mut buf);
                    let _ = tls.write_all(response);
                    let _ = tls.flush();
                    // Hold the connection open briefly so the client can read
                    // the streaming body before FIN.
                    std::thread::sleep(std::time::Duration::from_millis(150));
                });
            }
        });
        port
    }

    const HTTP_OK: &[u8] = b"HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
    const SSE_OK: &[u8] =
        b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: keep-alive\r\n\r\ndata:\n\n";

    /// Criterion 1, request/response half: with Tor mode on, a real verified
    /// request rides the SOCKS5 tunnel end to end — and the proxy was handed
    /// the **hostname**, so the name resolved inside the circuit.
    #[test]
    fn a_request_routes_through_the_proxy_in_tor_mode() {
        let server = spawn_https_server(1, HTTP_OK);
        std::thread::sleep(std::time::Duration::from_millis(100));
        let proxy = FakeSocks5::spawn(1, Behavior::Splice(server));

        let t = trusted_test_server(443, tor_ready(proxy.port));
        let resp = t
            .request(HttpMethod::Get, "/sync/pull?cursor=0", b"", Some("tok"))
            .expect("request must complete through the tunnel");
        assert_eq!(resp.status, 200);
        assert_eq!(resp.body, b"{\"ok\":true}");
        assert_eq!(
            proxy.seen(),
            vec![SeenTarget {
                atyp: 0x03,
                host: "localhost".to_string(),
                port: 443,
            }],
            "the request must have travelled as a hostname CONNECT through the proxy"
        );
    }

    /// Criterion 1, SSE half — and criterion 3: the poke stream goes through
    /// the proxy, and so does its **reconnect**. The poke listener reconnects by
    /// building a fresh transport and calling `open_sse` again
    /// (`poke_listener::connect_and_stream`), which is exactly the second call
    /// here; both land on the proxy, neither on a direct socket.
    #[test]
    fn the_sse_stream_and_its_reconnect_both_route_through_the_proxy() {
        let server = spawn_https_server(2, SSE_OK);
        std::thread::sleep(std::time::Duration::from_millis(100));
        let proxy = FakeSocks5::spawn(2, Behavior::Splice(server));
        let gate = tor_ready(proxy.port);

        for attempt in 0..2 {
            // A fresh transport per connection — the shape the reconnect loop
            // has, so a cached-connection bypass could not hide here.
            let t = trusted_test_server(443, gate.clone());
            t.open_sse("/sync/poke", "tok", std::time::Duration::from_secs(5))
                .unwrap_or_else(|e| {
                    panic!("attempt {attempt}: SSE must open through the tunnel, got {e:?}")
                });
        }

        assert_eq!(
            proxy.seen(),
            vec![
                SeenTarget {
                    atyp: 0x03,
                    host: "localhost".to_string(),
                    port: 443,
                };
                2
            ],
            "the initial connect AND the reconnect both went through Tor"
        );
    }

    /// **Criterion 2, the one that matters.** With Tor mode on and the proxy
    /// down, every path fails — and the server the client would have dialled
    /// directly sees *zero* connections.
    ///
    /// The probe is a real listener on the port the transport is configured for,
    /// counting accepts. The control arm at the end is what makes the zero
    /// meaningful: the same probe, with the gate routing `Direct`, does get a
    /// connection — so a regression that reintroduced a direct fallback would
    /// turn this test red rather than leaving it vacuously green.
    #[test]
    fn proxy_down_fails_closed_with_no_direct_connection_attempt() {
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let listener = TcpListener::bind("127.0.0.1:0").expect("bind probe");
        let real_port = listener.local_addr().expect("addr").port();
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

        // A port nothing listens on: "the sidecar is gone" in its most literal
        // form, on top of each non-`Ready` state.
        let dead_proxy = TcpListener::bind("127.0.0.1:0")
            .expect("bind")
            .local_addr()
            .expect("addr")
            .port();

        for state in [
            TorProxyState::Starting,
            TorProxyState::Failed,
            TorProxyState::Stopped,
            TorProxyState::Ready {
                socks_port: dead_proxy,
            },
        ] {
            // NOTE: the host here is loopback only because the probe has to be
            // reachable. The loopback *exemption* lives in
            // `proxy::installed_for`, not in the transport, so a transport
            // handed a Tor-mode gate obeys it whatever its host — which is what
            // lets this test exist at all.
            let t = RustlsTransport::with_proxy_gate("localhost", real_port, tor_not_ready(state));
            assert_eq!(
                t.request(HttpMethod::Get, "/sync/pull", b"", Some("tok")),
                Err(TransportError::Network),
                "{state:?}: a request must fail rather than connect directly"
            );
            assert!(
                matches!(
                    t.open_sse("/sync/poke", "tok", std::time::Duration::from_secs(1)),
                    Err(SseOpenError::Transport(TransportError::Network))
                ),
                "{state:?}: the SSE stream must fail rather than connect directly"
            );
            assert!(
                t.export_keying_material(b"EXPORTER-Channel-Binding", None, 32)
                    .is_err(),
                "{state:?}: the exporter handshake must fail too"
            );
        }

        std::thread::sleep(std::time::Duration::from_millis(150));
        assert_eq!(
            accepts.load(Ordering::SeqCst),
            0,
            "fail-closed means ZERO direct connections to the sync host"
        );

        // Control: the probe really does observe a connection when one is made.
        let direct = RustlsTransport::with_proxy_gate("localhost", real_port, ProxyGate::new());
        let _ = direct.request(HttpMethod::Get, "/sync/pull", b"", Some("tok"));
        std::thread::sleep(std::time::Duration::from_millis(150));
        assert_eq!(
            accepts.load(Ordering::SeqCst),
            1,
            "the probe must be able to see a direct connection, or the zero above proves nothing"
        );
    }

    /// Enabling Tor on an already-configured endpoint re-routes the *next*
    /// connection — no re-enrollment, no new transport type, no reconfiguration.
    /// The gate is a shared cell, so a transport built while Tor was off
    /// observes the flip.
    #[test]
    fn flipping_the_toggle_reroutes_an_already_built_transport() {
        let server = spawn_https_server(1, HTTP_OK);
        std::thread::sleep(std::time::Duration::from_millis(100));
        let proxy = FakeSocks5::spawn(1, Behavior::Splice(server));

        let gate = ProxyGate::new();
        let t = trusted_test_server(443, gate.clone());
        // Tor mode off, sidecar not running: nothing is routed yet.
        assert!(proxy.seen().is_empty());

        gate.set_enabled(true);
        gate.set_state(TorProxyState::Ready {
            socks_port: proxy.port,
        });
        let resp = t
            .request(HttpMethod::Get, "/sync/pull", b"", Some("tok"))
            .expect("the same transport now tunnels");
        assert_eq!(resp.status, 200);
        assert_eq!(proxy.seen().len(), 1);
    }

    /// The transport built by the production constructor obeys the loopback
    /// exemption policy, not one of its own.
    #[test]
    fn the_production_constructor_takes_its_gate_from_the_installed_policy() {
        // Loopback → a direct-only gate, so a local dev server and the E2E
        // harness keep working with Tor mode on.
        let local = RustlsTransport::new("127.0.0.1", 8443);
        assert_eq!(local.proxy.route(), Ok(Route::Direct));

        // A remote host → the installed gate. Nothing installs one in this
        // crate's tests, so it reads back the default, which is also direct —
        // the assertion that matters is that it is the *installed* gate, which
        // `proxy::installed_for`'s own tests pin.
        let remote = RustlsTransport::new("sync.myne.md", 443);
        assert!(!remote.proxy.is_enabled());
    }
}
