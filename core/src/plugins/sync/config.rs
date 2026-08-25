//! Device-local sync endpoint configuration (SYNC-14, MYND-424 task 3).
//!
//! The endpoint config is the **real product surface** for pointing a client
//! at a sync server — a self-host operator setting (TB5), NOT a test hook. It
//! is device-local plaintext app-config (the `themes`/`registry.json`
//! precedent): it holds no note plaintext or key material, only the server URL,
//! and must be readable *before* unlock/enrollment (you configure the server,
//! then enroll). The MYND-428 E2E harness reuses this exact surface to point
//! its two clients at the ephemeral server (no separate test path).
//!
//! ## URL policy (A4 / TB5)
//!
//! Production endpoints MUST be `https://` — the transport pins the cert (A4)
//! and the SCRAM channel binding rides TLS (SYNC-3). The single exception is a
//! **loopback** host (`127.0.0.1` / `localhost` / `[::1]`), where plain `http`
//! is allowed so the local E2E harness (and a developer's local server) work
//! without a self-signed-cert dance. Any non-loopback `http`, or any other
//! scheme, is rejected.

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use serde::{Deserialize, Serialize};
use std::path::Path;
use thiserror::Error;

/// The device-local sync configuration persisted at
/// `<app_config_dir>/sync-config.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncEndpointConfig {
    /// The sync server base URL, or `None` when sync is unconfigured.
    /// Validated by [`validate_endpoint_url`] before it is ever stored.
    #[serde(default)]
    pub endpoint_url: Option<String>,
    /// The TOFU-pinned server leaf-cert pin (SHA-256 of its DER, lowercase hex)
    /// for an `https` endpoint — captured at `sync_set_endpoint` time and the A4
    /// trust anchor every later connection verifies against. `None` for a
    /// loopback `http` endpoint (no TLS) or before the endpoint is pinned.
    #[serde(default)]
    pub cert_pin_hex: Option<String>,
}

/// Where a cert pin came from — the load-bearing SYNC-43 distinction so the UI
/// (and mobile) never silently normalizes a first-connect TOFU pin as if it were
/// the pre-vetted hosted pin. Hosted = Myne controls the cert → a build-time
/// static pin (verified); self-host = TOFU-pin-at-first-connect + out-of-band
/// eye-compare (proposed-trust, R3-pending — never presented as "verified" crypto).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PinSource {
    /// A build-time static pin for the Myne-operated hosted endpoint.
    Static,
    /// A TOFU pin captured at first connect (self-host / operator-owned cert).
    Tofu,
    /// **This client cannot pin, and the platform's trust store is doing the
    /// verifying** (phase3-web-client tasks 84/85).
    ///
    /// The browser's case, and it is a third ANSWER rather than the absence of
    /// one. `None` already means "there is no TLS here" (a loopback `http`
    /// endpoint) or "nothing was pinned", and reporting either for a browser on
    /// `https` would be actively wrong in the direction that misleads: the UI
    /// reads a missing fingerprint as "connected to a local server". A page
    /// cannot see a leaf certificate — `decisions.md` 2026-07-26 records that as
    /// permanent, and the threat model qualifies A4 per client — so the honest
    /// statement is "verified, by someone else", not "unverified".
    ///
    /// Derived at read like the other two; nothing new is persisted.
    PlatformTrustStore,
}

/// The build-time static pin for the Myne-operated hosted endpoint (SYNC-43).
///
/// **Deferred to hosted launch** — the hosted cert/domain do not exist yet, so
/// this returns `None` and every current endpoint pins via TOFU. When the hosted
/// service ships, match `url` against the hosted base URL and return its pinned
/// leaf-cert SHA-256; that value + this switch land together with a decisions.md
/// entry. DO NOT fill a constant here before then.
pub fn hosted_static_pin(_url: &str) -> Option<[u8; 32]> {
    None
}

/// The pin SOURCE for an endpoint (SYNC-43): `Static` if the hosted static pin
/// applies, else `Tofu` if a TOFU pin was captured, else `None` (loopback `http`
/// or unpinned). Surfaced to the UI so a hosted endpoint is never shown as a bare
/// first-connect TOFU pin — which is exactly the "silently normalize
/// TOFU-for-hosted" regression SYNC-43 guards against.
///
/// The pinning client's answer. A client that cannot pin calls
/// [`pin_source_for_client`] with `can_pin: false`.
pub fn pin_source_for(url: &str, cfg: &SyncEndpointConfig) -> Option<PinSource> {
    pin_source_for_client(url, cfg, true)
}

/// [`pin_source_for`] with the client's pinning ability made an INPUT rather
/// than a compile target (phase3-web-client task 84).
///
/// `can_pin` is false in a browser. It is a parameter and not a `cfg!` for two
/// reasons: the answer is a property of the client, not of the instruction set —
/// a future embedding could be the same shape — and a `cfg!` would make the
/// browser's branch unreachable from `cargo test --workspace`, which is where
/// every other answer in this file is covered.
///
/// Order matters and is deliberate: a hosted static pin still wins if one
/// exists (nothing about a browser makes a build-time pin less true), and a
/// recorded TOFU pin still wins over the platform answer, so a config written by
/// a desktop that DID pin keeps reporting `Tofu` when the browser reads it.
/// Only when neither exists does the client's own ability decide.
pub fn pin_source_for_client(
    url: &str,
    cfg: &SyncEndpointConfig,
    can_pin: bool,
) -> Option<PinSource> {
    if hosted_static_pin(url).is_some() {
        Some(PinSource::Static)
    } else if cfg.cert_pin_hex.is_some() {
        Some(PinSource::Tofu)
    } else if !can_pin && url.starts_with("https://") {
        // Only for TLS. A loopback `http` endpoint has no certificate for
        // anyone to verify, so the honest answer there stays `None`.
        Some(PinSource::PlatformTrustStore)
    } else {
        None
    }
}

/// Failure surface for reading/writing/validating the endpoint config.
#[derive(Debug, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum SyncConfigError {
    /// The URL is malformed (empty, no scheme, no host).
    #[error("endpoint url is malformed")]
    InvalidUrl,
    /// The URL uses an insecure scheme for a non-loopback host (only `https`
    /// is allowed off loopback; A4/TB5).
    #[error("endpoint url scheme is insecure for a non-loopback host")]
    InsecureScheme,
    /// Filesystem error reading or writing the config file.
    #[error("filesystem error on sync-config.json")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },
    /// The on-disk config file failed to parse as JSON.
    #[error("sync-config.json parse failed")]
    Parse,
    /// Tor routing is on and no expected certificate fingerprint was supplied
    /// (MYND-650 task 5). The UI must ask for the fingerprint the user obtained
    /// out-of-band from their server and retry. **Nothing was written** — the
    /// endpoint is not configured and no pin was stored.
    #[error("a certificate fingerprint must be confirmed out-of-band over Tor")]
    PinConfirmationRequired,
    /// The certificate the server served is not the one the user confirmed
    /// (MYND-650 task 5) — a typo, or somebody between this device and the
    /// server. **Nothing was written**, and the captured fingerprint is
    /// deliberately not reported: handing it back would let a user paste the
    /// attacker's value and retry (`pin_confirm`'s module doc).
    #[error("the server certificate does not match the confirmed fingerprint")]
    FingerprintMismatch,
    /// The server could not be reached, or the TLS handshake failed. Its own
    /// variant because it used to be reported as [`SyncConfigError::InvalidUrl`],
    /// which sent a user whose server was merely down to go and check a URL
    /// that was correct.
    #[error("the sync server could not be reached")]
    Unreachable,
    /// This device already trusts a certificate for this endpoint and the
    /// server presented a different one, with no out-of-band confirmation
    /// supplied. **Nothing was written**, and the captured fingerprint is not
    /// reported, for `FingerprintMismatch`'s reason: handing it back would let
    /// the user paste it straight into the confirmation field and re-trust
    /// whatever they were just served.
    ///
    /// This is the ordinary certificate-renewal case as well as the attack one,
    /// and the client cannot tell them apart — which is exactly why it asks
    /// rather than deciding. Before this variant existed, re-entering the URL
    /// silently replaced the pin with whatever the connection produced.
    #[error("the server presented a different certificate than the pinned one")]
    CertificateChanged,
}

/// The storage seam's closed error, straight through (phase3-web-client task 86).
///
/// Both config IO paths go through [`crate::vault_io::VaultIo`] now, which
/// already reduces `std::io::Error` at its own boundary — an identity wrap, not
/// a second reduction. The `From<std::io::Error>` impl below stays for the
/// host-only path resolution that still yields a real `io::Error`.
impl From<IoFailureKind> for SyncConfigError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        SyncConfigError::Io { io_error_kind }
    }
}

/// The fingerprint gate's refusals, projected onto this command's enum
/// (MYND-650 task 5).
///
/// A `From` impl rather than a `match` at the call site, and the twin of
/// [`super::devices::SyncDeviceError`]'s: the two enrollment doors must answer
/// the same refusal the same way, and an impl per target enum is what makes a
/// new `PinConfirmError` variant a compile error in one place each instead of a
/// silently-unhandled arm at N call sites.
///
/// Host-only, because `pin_confirm` is: the gate exists for the one handshake
/// that accepts any certificate, and a browser tab does not make that handshake.
#[cfg(not(target_arch = "wasm32"))]
impl From<super::pin_confirm::PinConfirmError> for SyncConfigError {
    fn from(e: super::pin_confirm::PinConfirmError) -> Self {
        use super::pin_confirm::PinConfirmError as P;
        match e {
            P::ConfirmationRequired => SyncConfigError::PinConfirmationRequired,
            P::FingerprintMismatch => SyncConfigError::FingerprintMismatch,
            // Its own variant since myne#581. Reporting a handshake failure as
            // `InvalidUrl` told a user whose server was down, or whose
            // certificate had just been replaced, to go and check a URL that
            // was right — and it is the same conflation, one layer up, that
            // made a pin mismatch read as a generic network failure.
            P::Transport => SyncConfigError::Unreachable,
        }
    }
}

impl From<std::io::Error> for SyncConfigError {
    fn from(e: std::io::Error) -> Self {
        SyncConfigError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

/// Split a URL into `(scheme, host)` without pulling in a URL-parsing
/// dependency. Returns `None` if the shape is not `scheme://host[...]`.
fn parse_scheme_host(url: &str) -> Option<(&str, &str)> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty() || rest.is_empty() {
        return None;
    }
    // Host ends at the first '/', '?', '#', or ':' (port).
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..host_end];
    // Strip userinfo (not allowed, but be defensive) and port.
    if authority.contains('@') {
        return None;
    }
    let host = if let Some(stripped) = authority.strip_prefix('[') {
        // IPv6 literal: "[::1]:port" → "::1".
        let close = stripped.find(']')?;
        &stripped[..close]
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    if host.is_empty() {
        return None;
    }
    Some((scheme, host))
}

/// `<app_config_dir>/sync-config.json`.
///
/// **Moved here from the host-gated `commands.rs`** (phase3-web-client task 84)
/// and given the IO seam, so the browser can resolve the same path through the
/// same code. It was the last thing standing between the endpoint commands and a
/// web dispatch, and it stood there because of one `std::fs::create_dir_all`.
///
/// This is the **only** consumer of `HostCtx::app_config_dir` in the crate, and
/// the reason that method exists at all: the config directory is device-scoped
/// and vault-independent, so it is not derivable from the vault root the rest of
/// the seam resolves (`core-hostctx-design.md`).
pub async fn config_path_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<std::path::PathBuf, SyncConfigError> {
    let dir = host.app_config_dir().map_err(|_| SyncConfigError::Io {
        io_error_kind: IoFailureKind::Other,
    })?;
    io.create_dir_all(&dir).await?;
    Ok(config_file_in(&dir))
}

/// The same path, **without** creating the directory — for callers that only
/// read (MYND-650: the Tor posture command).
///
/// [`config_path_from_host`] creates `app_config_dir` because every one of its
/// callers is about to write there. A read-only caller must not: a posture
/// query that creates a directory as a side effect is a surprise, it makes the
/// permission description that says so false, and it buys nothing —
/// [`read_config`] already answers "unconfigured" for an absent file, and an
/// absent directory is just a stronger form of absent.
///
/// One helper names the file for both, so the reader cannot drift from the
/// writer.
pub fn config_path_for_read(
    host: &dyn crate::host::HostCtx,
) -> Result<std::path::PathBuf, SyncConfigError> {
    let dir = host.app_config_dir().map_err(|_| SyncConfigError::Io {
        io_error_kind: IoFailureKind::Other,
    })?;
    Ok(config_file_in(&dir))
}

fn config_file_in(dir: &std::path::Path) -> std::path::PathBuf {
    dir.join("sync-config.json")
}

/// The endpoint config plus the DERIVED pin source (SYNC-43) — not persisted;
/// computed at read so the UI distinguishes a hosted static pin from a self-host
/// TOFU pin (and, on a client that cannot pin at all, the platform trust store)
/// without changing the on-disk config schema.
#[derive(Debug, Clone, Serialize)]
pub struct SyncEndpointView {
    /// The sync server base URL, or `None` when unconfigured.
    pub endpoint_url: Option<String>,
    /// The pinned leaf-cert fingerprint (lowercase SHA-256 hex), or `None`.
    pub cert_pin_hex: Option<String>,
    /// Where the pin came from, or who did the verifying instead.
    pub pin_source: Option<PinSource>,
}

/// Read the device-local endpoint config into its UI view.
///
/// `can_pin` is the calling client's ability, threaded rather than derived —
/// see [`pin_source_for_client`].
pub async fn get_endpoint_view(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    can_pin: bool,
) -> Result<SyncEndpointView, SyncConfigError> {
    let path = config_path_from_host(host, io).await?;
    let cfg = read_config(io, &path).await?;
    let pin_source = cfg
        .endpoint_url
        .as_deref()
        .and_then(|u| pin_source_for_client(u, &cfg, can_pin));
    Ok(SyncEndpointView {
        endpoint_url: cfg.endpoint_url,
        cert_pin_hex: cfg.cert_pin_hex,
        pin_source,
    })
}

/// The endpoint-set result: the pinned fingerprint + its source (SYNC-43), so
/// the UI can render a self-host first-connect TOFU pin ("compare across
/// devices") distinctly from a pre-vetted hosted static pin — and, on a client
/// that cannot pin, from the platform's own verification. Never silently
/// normalizing one as another is the whole point.
#[derive(Debug, Clone, Serialize)]
pub struct EndpointPinInfo {
    /// The pinned leaf-cert fingerprint (lowercase SHA-256 hex) for eye-compare,
    /// or `None` for a loopback `http` endpoint, a cleared config, or a client
    /// that cannot see a certificate.
    pub fingerprint: Option<String>,
    /// Where the pin came from, or who did the verifying instead.
    pub pin_source: Option<PinSource>,
}

/// Set (or clear, with `None`) the sync endpoint: validate against the A4/TB5
/// policy, persist, and report the pin situation.
///
/// **`cert_pin_hex` is an INPUT, not something this computes** (phase3-web-client
/// task 84), and that is where the platform split lives. Acquiring a TOFU pin
/// means completing a TLS handshake yourself and reading the leaf certificate —
/// desktop does that over `rustls_transport`, which has no `wasm32` build and no
/// browser equivalent, because a page never sees the certificate at all. So the
/// caller acquires the pin (or does not) and this owns everything that follows:
/// the URL policy, the write, and the derived source. Splitting it here rather
/// than at the whole command keeps one implementation of the part that is a
/// *rule* and lets the part that is a *capability* differ.
///
/// A cleared endpoint drops the pin with it — a pin without an endpoint is a
/// fact about a server nobody is talking to.
pub async fn set_endpoint(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    endpoint_url: Option<String>,
    cert_pin_hex: Option<String>,
    can_pin: bool,
) -> Result<EndpointPinInfo, SyncConfigError> {
    let path = config_path_from_host(host, io).await?;
    let Some(url) = endpoint_url else {
        write_config(io, &path, &SyncEndpointConfig::default()).await?;
        return Ok(EndpointPinInfo {
            fingerprint: None,
            pin_source: None,
        });
    };
    validate_endpoint_url(&url)?;
    let cfg = SyncEndpointConfig {
        endpoint_url: Some(url.clone()),
        cert_pin_hex: cert_pin_hex.clone(),
    };
    write_config(io, &path, &cfg).await?;
    Ok(EndpointPinInfo {
        fingerprint: cert_pin_hex,
        pin_source: pin_source_for_client(&url, &cfg, can_pin),
    })
}

/// Parse a 64-char lowercase-hex cert pin into raw SHA-256 bytes.
fn parse_pin_hex(s: &str) -> Option<[u8; 32]> {
    if s.len() != 64 || !s.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

/// The cert pins to verify an `https` connection against: the **static-hosted-pin
/// slot ∪ the TOFU pin** (SYNC-43). The static slot is deferred (`None`) until
/// hosted launch, so today this is just the captured TOFU pin; when hosted ships,
/// a hosted endpoint additionally verifies against its pre-vetted static pin.
/// Empty for a loopback `http` endpoint or an unpinned config.
pub fn config_pins(cfg: &SyncEndpointConfig) -> Vec<[u8; 32]> {
    let mut pins = Vec::new();
    if let Some(url) = cfg.endpoint_url.as_deref() {
        if let Some(sp) = hosted_static_pin(url) {
            pins.push(sp);
        }
    }
    if let Some(tofu) = cfg.cert_pin_hex.as_deref().and_then(parse_pin_hex) {
        pins.push(tofu);
    }
    pins
}

/// Validate an endpoint URL per the A4/TB5 policy. `https` is always allowed;
/// `http` is allowed only for a loopback host (local E2E / dev server).
///
/// "Loopback" is [`super::http_transport::is_loopback`] — the one predicate,
/// shared with the transport's own scheme dispatch and with the Tor-routing
/// exemption ([`super::proxy::host_is_tor_exempt`]). Three copies of a
/// three-name `matches!` is three chances for the rules to disagree about which
/// hosts may be reached in the clear.
pub fn validate_endpoint_url(url: &str) -> Result<(), SyncConfigError> {
    let (scheme, host) = parse_scheme_host(url).ok_or(SyncConfigError::InvalidUrl)?;
    match scheme {
        "https" => Ok(()),
        "http" if super::http_transport::is_loopback(host) => Ok(()),
        "http" => Err(SyncConfigError::InsecureScheme),
        _ => Err(SyncConfigError::InvalidUrl),
    }
}

/// Read the device-local config from `path`. An absent file is NOT an error —
/// it means "sync unconfigured" and returns the default. A present-but-corrupt
/// file is a `Parse` error (the operator must fix or clear it).
///
/// **Absent and unreadable stay different answers** (task 86), the same
/// discipline `state::read_sync_state` documents: absent is "sync unconfigured",
/// present-but-unparseable is an operator-visible fault. Defaulting on the
/// second and then writing would silently erase a configured endpoint — this
/// file has a write path a few lines below, so the distinction is load-bearing
/// rather than decorative.
pub async fn read_config(
    io: &dyn crate::vault_io::VaultIo,
    path: &Path,
) -> Result<SyncEndpointConfig, SyncConfigError> {
    // `open_newest` for the same reason `state::read_sync_state` uses it: on the
    // web store this is two alternating copies, and the verifier for a plaintext
    // JSON sidecar is `serde_json` — not the generation frame, which a torn
    // write leaves perfectly valid around half a document.
    match crate::singleton::open_newest(io, path, |bytes| {
        serde_json::from_slice::<SyncEndpointConfig>(bytes)
    })
    .await
    {
        Ok(cfg) => Ok(cfg),
        Err(crate::singleton::OpenOutcome::Absent) => Ok(SyncEndpointConfig::default()),
        Err(crate::singleton::OpenOutcome::Undecodable(_)) => Err(SyncConfigError::Parse),
        Err(crate::singleton::OpenOutcome::Io(kind)) => Err(kind.into()),
    }
}

/// Persist the config to `path` (atomic replace). The caller validates the URL
/// via [`validate_endpoint_url`] before constructing the config.
pub async fn write_config(
    io: &dyn crate::vault_io::VaultIo,
    path: &Path,
    cfg: &SyncEndpointConfig,
) -> Result<(), SyncConfigError> {
    let bytes = serde_json::to_vec_pretty(cfg).map_err(|_| SyncConfigError::Parse)?;
    io.write(path, &bytes, crate::vault_io::WriteOpts::default())
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_source_is_tofu_when_pinned_none_when_not() {
        let url = "https://s.example";
        // No pin → no source.
        let cfg = SyncEndpointConfig {
            endpoint_url: Some(url.into()),
            cert_pin_hex: None,
        };
        assert_eq!(pin_source_for(url, &cfg), None);
        // A captured TOFU pin → Tofu (the hosted static slot is deferred → None,
        // so a self-host endpoint is a TOFU pin, never silently "static").
        let cfg = SyncEndpointConfig {
            endpoint_url: Some(url.into()),
            cert_pin_hex: Some("ab".repeat(32)),
        };
        assert_eq!(pin_source_for(url, &cfg), Some(PinSource::Tofu));
        // SYNC-43-pending: no hosted static pin exists yet.
        assert_eq!(hosted_static_pin(url), None);
    }

    /// A client that cannot pin reports the platform trust store on TLS — and
    /// still reports nothing on loopback `http`.
    ///
    /// The distinction is the whole point. `None` means "there is no TLS here";
    /// a browser on `https` is verified, just not by us, and collapsing the two
    /// makes the UI tell the user they connected to a local server when they
    /// connected to a real one.
    #[test]
    fn a_client_that_cannot_pin_reports_the_platform_trust_store_on_tls_only() {
        let tls = "https://s.example";
        let cfg = SyncEndpointConfig {
            endpoint_url: Some(tls.into()),
            cert_pin_hex: None,
        };
        assert_eq!(
            pin_source_for_client(tls, &cfg, false),
            Some(PinSource::PlatformTrustStore)
        );
        assert_eq!(pin_source_for_client(tls, &cfg, true), None);

        let loopback = "http://127.0.0.1:8453";
        let cfg = SyncEndpointConfig {
            endpoint_url: Some(loopback.into()),
            cert_pin_hex: None,
        };
        assert_eq!(pin_source_for_client(loopback, &cfg, false), None);
    }

    /// A recorded pin still wins for a client that cannot make one.
    ///
    /// The config is device-local today, but the field is the same shape a
    /// desktop writes, and reading someone else's recorded TOFU pin as "the
    /// browser's trust store" would erase a fact rather than report one.
    #[test]
    fn a_recorded_pin_outranks_the_platform_answer() {
        let url = "https://s.example";
        let cfg = SyncEndpointConfig {
            endpoint_url: Some(url.into()),
            cert_pin_hex: Some("ab".repeat(32)),
        };
        assert_eq!(
            pin_source_for_client(url, &cfg, false),
            Some(PinSource::Tofu)
        );
    }

    #[test]
    fn https_any_host_ok() {
        assert!(validate_endpoint_url("https://sync.myne.md").is_ok());
        assert!(validate_endpoint_url("https://sync.example.org:8443/base").is_ok());
    }

    #[test]
    fn http_loopback_ok() {
        assert!(validate_endpoint_url("http://127.0.0.1:51820").is_ok());
        assert!(validate_endpoint_url("http://localhost:1420").is_ok());
        assert!(validate_endpoint_url("http://[::1]:9000/path").is_ok());
    }

    #[test]
    fn http_nonloopback_rejected() {
        assert_eq!(
            validate_endpoint_url("http://sync.myne.md"),
            Err(SyncConfigError::InsecureScheme)
        );
    }

    #[test]
    fn malformed_rejected() {
        for bad in [
            "",
            "sync.myne.md",
            "https://",
            "://host",
            "ftp://host",
            "https://@/x",
        ] {
            assert!(
                matches!(
                    validate_endpoint_url(bad),
                    Err(SyncConfigError::InvalidUrl) | Err(SyncConfigError::InsecureScheme)
                ),
                "expected reject for {bad:?}"
            );
        }
    }

    #[test]
    fn ws_scheme_rejected_as_invalid() {
        assert_eq!(
            validate_endpoint_url("wss://sync.myne.md"),
            Err(SyncConfigError::InvalidUrl)
        );
    }

    #[test]
    fn read_write_roundtrip() {
        // Driven on a runtime against the real `StdVaultIo` since task 86 moved
        // both IO paths onto the storage seam — a stub would only have proved
        // the signatures compile.
        crate::test_support::block_on(async {
            let io = crate::vault_io::StdVaultIo;
            let dir = std::env::temp_dir().join(format!("myne-sync-cfg-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let path = dir.join("sync-config.json");

            // Absent → default. The legitimate "sync unconfigured" answer.
            assert_eq!(
                read_config(&io, &path).await.unwrap(),
                SyncEndpointConfig::default()
            );

            let cfg = SyncEndpointConfig {
                endpoint_url: Some("https://sync.myne.md".into()),
                cert_pin_hex: Some("ab".repeat(32)),
            };
            write_config(&io, &path, &cfg).await.unwrap();
            assert_eq!(read_config(&io, &path).await.unwrap(), cfg);

            // Present-but-corrupt → `Parse`, NOT the default. This file has a
            // write path, so collapsing the two would let a transient fault
            // erase a configured endpoint (the `state.rs` discipline).
            std::fs::write(&path, b"{not json").unwrap();
            assert_eq!(read_config(&io, &path).await, Err(SyncConfigError::Parse));

            // A truncated file is the shape a torn write actually leaves.
            std::fs::write(&path, br#"{"endpoint_url":"https://s"#).unwrap();
            assert_eq!(read_config(&io, &path).await, Err(SyncConfigError::Parse));

            std::fs::remove_dir_all(&dir).ok();
        });
    }
}
