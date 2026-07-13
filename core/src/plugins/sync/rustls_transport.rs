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
}

impl RustlsTransport {
    /// Build the transport for `host:port`, trusting only certs whose DER hashes
    /// to one of `pins`. Installs the `ring` provider explicitly (the crate sets
    /// no process-default provider).
    pub fn new(host: impl Into<String>, port: u16, pins: Vec<[u8; 32]>) -> Self {
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
        let sock = TcpStream::connect((self.host.as_str(), self.port))
            .map_err(|_| TransportError::Network)?;
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
        let mut sock = TcpStream::connect((host, port)).map_err(|_| ())?;
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
}
