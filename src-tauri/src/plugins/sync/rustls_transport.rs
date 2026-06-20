//! The raw-rustls sync transport (MYND-424 task 2, SYNC-3).
//!
//! One TLS path shared by SCRAM auth (MYND-425) and sync push/pull: a rustls
//! `ClientConfig` with **certificate pinning** (A4) and access to the
//! **keying-material exporter** (the SCRAM channel binding). It speaks a minimal
//! HTTP/1.1 (`Connection: close`) over the TLS stream — deliberately NOT
//! `reqwest` (a second TLS stack) and NOT `tauri-plugin-http` (no exporter), per
//! the PRD.
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

use super::http_codec::{build_http_request, parse_http_response};
use super::transport::{HttpMethod, SyncTransport, TransportError, TransportResponse};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{verify_tls12_signature, verify_tls13_signature, WebPkiSupportedAlgorithms};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme, StreamOwned};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::Arc;

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

/// The raw-rustls transport: a pinned `ClientConfig` + the target host/port.
/// One instance is the single TLS layer auth + sync share (SYNC-3).
pub struct RustlsTransport {
    host: String,
    port: u16,
    config: Arc<ClientConfig>,
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
        }
    }

    /// Open a pinned TLS connection to the configured host.
    fn connect(&self) -> Result<StreamOwned<ClientConnection, TcpStream>, TransportError> {
        let server_name =
            ServerName::try_from(self.host.clone()).map_err(|_| TransportError::BadRequest)?;
        let conn = ClientConnection::new(self.config.clone(), server_name)
            .map_err(|_| TransportError::Tls)?;
        let sock = TcpStream::connect((self.host.as_str(), self.port))
            .map_err(|_| TransportError::Network)?;
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
        let mut stream = self.connect()?;
        let req = build_http_request(method, path, &self.host, body, token);
        stream
            .write_all(&req)
            .map_err(|_| TransportError::Network)?;
        stream.flush().map_err(|_| TransportError::Network)?;
        let mut raw = Vec::new();
        // `Connection: close` → read to EOF.
        stream
            .read_to_end(&mut raw)
            .map_err(|_| TransportError::Network)?;
        parse_http_response(&raw).ok_or(TransportError::Network)
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
}
