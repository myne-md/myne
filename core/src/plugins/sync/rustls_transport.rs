//! The raw-rustls sync transport (MYND-424 task 2, SYNC-3).
//!
//! One TLS path shared by SCRAM auth (MYND-425) and sync push/pull: a rustls
//! `ClientConfig` with **certificate pinning** (A4) and access to the
//! **keying-material exporter** (the SCRAM channel binding). It speaks a minimal
//! keep-alive HTTP/1.1 over the TLS stream (strict `Content-Length`/chunked
//! framing, one cached session per transport) — deliberately NOT `reqwest` (a
//! second TLS stack) and NOT `tauri-plugin-http` (no exporter), per the PRD.
//!
//! ## R3 status (READ THIS)
//!
//! The `rustls` dependency is **owner-approved**. The security-critical surface —
//! the [`PinnedVerifier`] (pin matching replaces CA-chain validation) and the
//! tls-exporter wiring — is still **R3-pending**: it needs a primitive-level
//! security review AND a live interop test against the Go server before it is
//! trusted in production. Until then:
//! - signature verification is **delegated to the `ring` provider** (NOT
//!   hand-rolled) — only chain validation is pin-substituted, the standard
//!   reviewable pinning pattern;
//! - the pure logic (HTTP request build, response parse, pin matching) is
//!   unit-tested here; the live TLS handshake is exercised by the MYND-428
//!   harness, not in this crate;
//! - [`super::transport::FakeTransport`] stays the default for unit tests.
//! - Fallback if `-PLUS` channel binding slips: cert-pinning only (the exporter
//!   call is then simply unused).

use super::http_codec::{
    build_http_request_ext, keepalive_roundtrip, read_http_response, read_response_head,
};
use super::http_transport::SOCKET_TIMEOUT;
use super::proxy::{self, ProxyGate, Route};
use super::socks5::connect_via_socks5;
use super::transport::{
    HttpMethod, SseOpenError, SseStream, SyncTransport, TransportError, TransportResponse,
    TransportResponseExt,
};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme, StreamOwned};
use sha2::{Digest, Sha256};
use std::io::{BufReader, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};

/// A pinned-certificate verifier: the leaf cert's SHA-256 (over its DER) MUST be
/// in the pin set, replacing CA-chain validation (the pin IS the trust, A4).
/// Handshake-signature verification is delegated to the crypto provider's
/// algorithms — this verifier only substitutes the chain-trust decision.
#[derive(Debug)]
struct PinnedVerifier {
    /// SHA-256 hashes of the accepted leaf certificate DER bytes.
    pins: Vec<[u8; 32]>,
    /// The provider's supported signature-verification algorithms (ring).
    algs: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let got = Sha256::digest(end_entity.as_ref());
        if self.pins.iter().any(|p| p.as_slice() == got.as_slice()) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "server certificate pin mismatch (A4)".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.algs)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.algs)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.supported_schemes()
    }
}

/// Compute the pin (SHA-256 of a certificate's DER bytes) for a known cert.
pub fn cert_pin(cert_der: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    out.copy_from_slice(&Sha256::digest(cert_der));
    out
}

/// A **trust-on-first-use** verifier: it accepts ANY server certificate and
/// **records** the leaf DER, so a one-shot bootstrap handshake can read back the
/// cert to pin. Used ONLY by [`tofu_fetch_pin`]; the production transport always
/// pins (`PinnedVerifier`). The self-host model TOFU-pins the operator's cert +
/// shows a fingerprint for out-of-band eye-compare (`self-host-policy.md` §6).
#[derive(Debug)]
struct TofuVerifier {
    captured: std::sync::Arc<std::sync::Mutex<Option<Vec<u8>>>>,
    algs: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for TofuVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        // TOFU: capture the leaf and accept — the caller pins it, never us.
        if let Ok(mut slot) = self.captured.lock() {
            *slot = Some(end_entity.as_ref().to_vec());
        }
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.algs)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.algs)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algs.supported_schemes()
    }
}

/// TOFU-fetch the server's leaf-cert pin (SHA-256 of its DER): open ONE TLS
/// handshake to `host:port` accepting any cert, capture the leaf, return its pin.
/// The caller persists the pin (sync-config) + surfaces the fingerprint for the
/// user to eye-compare across devices (defeats a per-device MitM). Blocking —
/// call from `spawn_blocking`.
///
/// **Still direct, deliberately, and owed to MYND-650 task 5.** This is a
/// one-shot enrollment handshake that builds its own socket rather than going
/// through [`RustlsTransport::open_socket`], so Tor mode does not route it yet.
/// Routing it is not a mechanical change: an accept-any-certificate first
/// handshake through a hostile exit node is exactly the MitM a Tor exit can
/// mount, so task 5 pairs the tunnel with a mandatory out-of-band fingerprint
/// compare before the captured pin is accepted. The no-bypass guard
/// (`super::no_bypass`) records this site by name so it cannot be forgotten.
pub fn tofu_fetch_pin(host: &str, port: u16) -> Result<[u8; 32], TransportError> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let captured = std::sync::Arc::new(std::sync::Mutex::new(None));
    let verifier = Arc::new(TofuVerifier {
        captured: captured.clone(),
        algs: provider.signature_verification_algorithms,
    });
    let config = ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|_| TransportError::Tls)?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    let server_name =
        ServerName::try_from(host.to_string()).map_err(|_| TransportError::BadRequest)?;
    let mut conn =
        ClientConnection::new(Arc::new(config), server_name).map_err(|_| TransportError::Tls)?;
    let mut sock = TcpStream::connect((host, port)).map_err(|_| TransportError::Network)?;
    // Drive the handshake to completion so `verify_server_cert` fires + captures.
    while conn.is_handshaking() {
        let (rd, wr) = conn
            .complete_io(&mut sock)
            .map_err(|_| TransportError::Tls)?;
        if rd == 0 && wr == 0 {
            break; // no progress (peer closed mid-handshake)
        }
    }
    let der = captured
        .lock()
        .ok()
        .and_then(|mut s| s.take())
        .ok_or(TransportError::Tls)?;
    Ok(cert_pin(&der))
}

/// The raw-rustls transport: a pinned `ClientConfig` + the target host/port.
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
    /// Build the transport for `host:port`, trusting only certs whose DER hashes
    /// to one of `pins`. Installs the `ring` provider explicitly (the crate sets
    /// no process-default provider).
    ///
    /// The routing gate comes from [`proxy::installed_for`] — the host's, unless
    /// `host` is loopback. Every sync connection is built through here (the
    /// engine, enrollment, the device roster and every SSE reconnect all go
    /// through `build_transport`, which calls this), and none of them caches a
    /// transport across the toggle, so turning Tor mode on re-routes the next
    /// connection without re-enrollment.
    pub fn new(host: impl Into<String>, port: u16, pins: Vec<[u8; 32]>) -> Self {
        let host = host.into();
        let proxy = proxy::installed_for(&host);
        Self::with_proxy_gate(host, port, pins, proxy)
    }

    /// The same transport with an explicit routing gate. Production builds go
    /// through [`Self::new`]; this exists so a test can drive a gate it owns
    /// rather than the process-global one.
    pub fn with_proxy_gate(
        host: impl Into<String>,
        port: u16,
        pins: Vec<[u8; 32]>,
        proxy: ProxyGate,
    ) -> Self {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let verifier = Arc::new(PinnedVerifier {
            pins,
            algs: provider.signature_verification_algorithms,
        });
        let config = ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("ring provider supports the default protocol versions")
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_no_client_auth();
        Self {
            host: host.into(),
            port,
            config: Arc::new(config),
            conn: Mutex::new(None),
            proxy,
        }
    }

    /// **The one place this transport opens a socket** — and therefore the one
    /// place the fail-closed invariant has to hold.
    ///
    /// `request` / `request_ext` / `request_bound_to_exporter` / `open_sse` all
    /// reach the network through [`Self::connect`], which reaches it through
    /// here, so routing this function routes request/response, the SCRAM
    /// exporter handshake, the SSE poke stream and every SSE reconnect at once.
    ///
    /// With Tor mode on and the proxy anything other than `Ready`, this returns
    /// an error **without opening a socket**. There is no direct-connect
    /// fallback: falling back would leak the user's real source IP at exactly
    /// the moment they believed they were protected (PRD story 4).
    fn open_socket(&self) -> Result<TcpStream, TransportError> {
        match self.proxy.route() {
            Ok(Route::Direct) => TcpStream::connect((self.host.as_str(), self.port))
                .map_err(|_| TransportError::Network),
            // The hostname goes to the proxy as a NAME (socks5's domain-name
            // `CONNECT`), so it is resolved inside the circuit and never by this
            // device's resolver.
            Ok(Route::Socks5 { socks_port }) => {
                connect_via_socks5(socks_port, &self.host, self.port).map_err(TransportError::from)
            }
            Err(denied) => {
                // The bare denial reason only — never the host, the port or the
                // proxy port (`src-tauri/CLAUDE.md` secret-handling discipline;
                // the sync hostname is the thing Tor mode exists to keep off
                // this device's disk and resolver).
                tracing::warn!(
                    event = "sync_tor_fail_closed",
                    reason = ?denied,
                    "Tor routing is on and the proxy is not ready; refusing to connect"
                );
                Err(TransportError::Network)
            }
        }
    }

    /// Open a pinned TLS connection to the configured host. Read/write deadlines
    /// on the socket keep a hung server from wedging a cycle and give keep-alive
    /// reuse a death detector.
    fn connect(&self) -> Result<StreamOwned<ClientConnection, TcpStream>, TransportError> {
        let server_name =
            ServerName::try_from(self.host.clone()).map_err(|_| TransportError::BadRequest)?;
        let conn = ClientConnection::new(self.config.clone(), server_name)
            .map_err(|_| TransportError::Tls)?;
        // Whether this is a direct socket or a SOCKS5 tunnel, what rustls gets
        // handed is a `TcpStream` carrying application bytes — which is why the
        // TLS session, and with it the A4 pin, stays end-to-end to the sync
        // server rather than terminating at the exit node.
        let sock = self.open_socket()?;
        let _ = sock.set_read_timeout(Some(SOCKET_TIMEOUT));
        let _ = sock.set_write_timeout(Some(SOCKET_TIMEOUT));
        Ok(StreamOwned::new(conn, sock))
    }

    /// Export keying material from a fresh pinned connection (the tls-exporter
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
        // A dedicated pinned connection (like open_sse), so the tls-exporter is
        // computed over the EXACT connection this request is sent on — independent
        // of the shared keep-alive slot. Same PinnedVerifier config → identical A4
        // pin. Drive the handshake to completion first so the exporter secret exists.
        let mut stream = self.connect()?;
        while stream.conn.is_handshaking() {
            stream
                .conn
                .complete_io(&mut stream.sock)
                .map_err(|_| TransportError::Tls)?;
        }
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
        let (resp, _reuse) = read_http_response(&mut reader, method == HttpMethod::Head)
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
        // A dedicated pinned TLS connection (never the keep-alive request slot
        // — the stream occupies it indefinitely). Same PinnedVerifier config,
        // so the A4 pin semantics are byte-identical to request cycles.
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
mod tests {
    use super::*;

    #[test]
    fn cert_pin_is_sha256_of_der() {
        let der = b"a fake cert der blob";
        let pin = cert_pin(der);
        let mut expect = [0u8; 32];
        expect.copy_from_slice(&Sha256::digest(der));
        assert_eq!(pin, expect);
    }

    #[test]
    fn config_builds_with_pins() {
        // Construction must not panic (ring provider + pinned verifier wire up).
        let t = RustlsTransport::new("sync.myne.md", 443, vec![[0x11u8; 32]]);
        assert_eq!(t.host, "sync.myne.md");
        assert_eq!(t.port, 443);
    }

    #[test]
    fn verify_server_cert_accepts_pinned_and_rejects_unpinned() {
        // The A4 trust anchor: the leaf DER's SHA-256 MUST be in the pin set,
        // which replaces CA-chain validation. `verify_server_cert` hashes the
        // DER bytes and does not parse X.509 structure, so arbitrary bytes act
        // as a deterministic "leaf cert" — no real certificate fixture (and no
        // extra dev-dependency) is needed to pin both decision branches.
        let der = b"deterministic leaf cert der for the A4 pin test";
        let end_entity = CertificateDer::from(der.to_vec());
        let name = ServerName::try_from("sync.myne.md").unwrap();
        let now = UnixTime::since_unix_epoch(std::time::Duration::from_secs(1_700_000_000));

        // Accept path: the pin set contains this cert's hash.
        let accepting = PinnedVerifier {
            pins: vec![cert_pin(der)],
            algs: rustls::crypto::ring::default_provider().signature_verification_algorithms,
        };
        assert!(
            accepting
                .verify_server_cert(&end_entity, &[], &name, &[], now)
                .is_ok(),
            "a cert whose DER hash is pinned must be accepted"
        );

        // Reject path: the pin set does NOT contain this cert's hash (the exact
        // A4 boundary — an attacker-substituted leaf cert).
        let rejecting = PinnedVerifier {
            pins: vec![[0u8; 32], cert_pin(b"a different cert")],
            algs: rustls::crypto::ring::default_provider().signature_verification_algorithms,
        };
        match rejecting.verify_server_cert(&end_entity, &[], &name, &[], now) {
            Err(rustls::Error::General(msg)) => assert!(msg.contains("pin mismatch")),
            other => panic!("unpinned cert must be rejected (A4), got {other:?}"),
        }
    }

    // --- real TLS round-trip: TOFU-fetch the pin, then prove pinning ----------

    const TEST_CERT_DER: &[u8] = include_bytes!("test_fixtures/localhost.cert.der");
    const TEST_KEY_DER: &[u8] = include_bytes!("test_fixtures/localhost.key.der");

    /// Spawn a minimal rustls TLS server (self-signed `localhost` cert) that
    /// accepts + handshakes `n` connections on an ephemeral port. Returns the
    /// bound port.
    fn spawn_tls_server(n: usize) -> u16 {
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
                // after verifying (the pin-reject case) just closes early.
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

    /// Complete ONLY a pinned TLS handshake (no app data) against `host:port`,
    /// returning `Ok(())` iff the pin verified.
    fn pinned_handshake(host: &str, port: u16, pin: [u8; 32]) -> Result<(), ()> {
        let sock = TcpStream::connect((host, port)).map_err(|_| ())?;
        pinned_handshake_on(sock, host, pin)
    }

    /// The same pinned handshake, on a socket the caller already opened — a
    /// direct one above, a SOCKS5 tunnel below. Splitting it here is what lets
    /// the tunnel test assert "rustls, unchanged" literally: both paths run
    /// this exact function with this exact `ClientConfig`.
    fn pinned_handshake_on(mut sock: TcpStream, host: &str, pin: [u8; 32]) -> Result<(), ()> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let verifier = Arc::new(PinnedVerifier {
            pins: vec![pin],
            algs: provider.signature_verification_algorithms,
        });
        let config = ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .unwrap()
            .dangerous()
            .with_custom_certificate_verifier(verifier)
            .with_no_client_auth();
        let name = ServerName::try_from(host.to_string()).map_err(|_| ())?;
        let mut conn = ClientConnection::new(Arc::new(config), name).map_err(|_| ())?;
        while conn.is_handshaking() {
            match conn.complete_io(&mut sock) {
                Ok((0, 0)) => break,
                Ok(_) => {}
                Err(_) => return Err(()),
            }
        }
        if conn.is_handshaking() {
            Err(())
        } else {
            Ok(())
        }
    }

    #[test]
    fn tofu_fetch_pins_real_cert_then_pinning_accepts_it_and_rejects_others() {
        // Three handshakes: the TOFU fetch + the accept-pin proof + the
        // reject-pin proof.
        let port = spawn_tls_server(3);
        std::thread::sleep(std::time::Duration::from_millis(100)); // let it bind

        // 1. TOFU-fetch the server's pin; it must equal the cert's SHA-256.
        let pin = tofu_fetch_pin("localhost", port).expect("TOFU fetch");
        assert_eq!(
            pin,
            cert_pin(TEST_CERT_DER),
            "TOFU captured the real leaf cert"
        );

        // 2. A pinned handshake with that exact pin succeeds (A4 accept path).
        assert!(
            pinned_handshake("localhost", port, pin).is_ok(),
            "the correct pin verifies the real cert"
        );

        // 3. A pinned handshake with a wrong pin fails (A4 reject path).
        assert!(
            pinned_handshake("localhost", port, [0u8; 32]).is_err(),
            "a wrong pin rejects the cert"
        );
    }

    /// Tor routing (MYND-650 task 3): pinned TLS runs **unchanged** over a
    /// SOCKS5 tunnel. The tunnel is a byte pipe, so the TLS session — and with
    /// it the A4 pin — stays end-to-end between this device and the sync
    /// server; a Tor exit node sees ciphertext to a hostname and nothing else.
    ///
    /// The reject arm is the half that matters: if the tunnel somehow
    /// terminated TLS (a MitM proxy), the pin would not match and the
    /// handshake would fail exactly as it does on the direct path.
    #[test]
    fn pinned_tls_completes_over_a_socks5_tunnel_and_still_rejects_a_wrong_pin() {
        let tls_port = spawn_tls_server(2);
        std::thread::sleep(std::time::Duration::from_millis(100)); // let it bind
        let proxy = FakeSocks5::spawn(2, Behavior::Splice(tls_port));

        // The client asks the proxy for `localhost:443` — a name and the real
        // service port. Where that lands is the proxy's business, which is the
        // whole shape of routing through Tor.
        let tunnel = connect_via_socks5(proxy.port, "localhost", 443).expect("tunnel");
        assert!(
            pinned_handshake_on(tunnel, "localhost", cert_pin(TEST_CERT_DER)).is_ok(),
            "the correct pin verifies the real cert through the tunnel"
        );

        let tunnel = connect_via_socks5(proxy.port, "localhost", 443).expect("tunnel");
        assert!(
            pinned_handshake_on(tunnel, "localhost", [0u8; 32]).is_err(),
            "a wrong pin must still reject — the tunnel does not weaken A4"
        );

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
            "both connects travelled as a hostname CONNECT, not a resolved address"
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

    /// A pinned TLS server that also answers HTTP: handshakes `n` connections
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

    /// Criterion 1, request/response half: with Tor mode on, a real pinned
    /// request rides the SOCKS5 tunnel end to end — and the proxy was handed
    /// the **hostname**, so the name resolved inside the circuit.
    #[test]
    fn a_request_routes_through_the_proxy_in_tor_mode() {
        let server = spawn_https_server(1, HTTP_OK);
        std::thread::sleep(std::time::Duration::from_millis(100));
        let proxy = FakeSocks5::spawn(1, Behavior::Splice(server));

        let t = RustlsTransport::with_proxy_gate(
            "localhost",
            443,
            vec![cert_pin(TEST_CERT_DER)],
            tor_ready(proxy.port),
        );
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
            let t = RustlsTransport::with_proxy_gate(
                "localhost",
                443,
                vec![cert_pin(TEST_CERT_DER)],
                gate.clone(),
            );
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
            let t = RustlsTransport::with_proxy_gate(
                "localhost",
                real_port,
                vec![cert_pin(TEST_CERT_DER)],
                tor_not_ready(state),
            );
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
        let direct = RustlsTransport::with_proxy_gate(
            "localhost",
            real_port,
            vec![cert_pin(TEST_CERT_DER)],
            ProxyGate::new(),
        );
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
        let t = RustlsTransport::with_proxy_gate(
            "localhost",
            443,
            vec![cert_pin(TEST_CERT_DER)],
            gate.clone(),
        );
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
        let local = RustlsTransport::new("127.0.0.1", 8443, vec![[0x11; 32]]);
        assert_eq!(local.proxy.route(), Ok(Route::Direct));

        // A remote host → the installed gate. Nothing installs one in this
        // crate's tests, so it reads back the default, which is also direct —
        // the assertion that matters is that it is the *installed* gate, which
        // `proxy::installed_for`'s own tests pin.
        let remote = RustlsTransport::new("sync.myne.md", 443, vec![[0x11; 32]]);
        assert!(!remote.proxy.is_enabled());
    }
}
