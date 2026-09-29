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
//! Production endpoints MUST be `https://`: the transport verifies the
//! certificate chain and hostname against public CA roots (A4) and the SCRAM
//! channel binding rides TLS (SYNC-3). The single exception is a
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
    /// Legacy persisted field. Read for backward compatibility, ignored for
    /// TLS verification, and written as `None` on the next endpoint change.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cert_pin_hex: Option<String>,
}

/// Historical IPC name; on HTTPS every client now reports verified CA trust.
/// Native uses bundled Mozilla roots, web uses its browser trust store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PinSource {
    /// A TLS endpoint. `None` means loopback HTTP or no endpoint.
    PlatformTrustStore,
}

/// The TLS trust status of a configured endpoint.
///
/// A function of the URL and nothing else. It used to take the stored config and
/// a "can this client pin" flag; both were removed with pinning (0620), and a
/// signature carrying them invited the reading that either one could still
/// change the answer.
pub fn pin_source_for(url: &str) -> Option<PinSource> {
    if url.starts_with("https://") {
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
    /// The server could not be reached, or the TLS handshake failed. Its own
    /// variant because it used to be reported as [`SyncConfigError::InvalidUrl`],
    /// which sent a user whose server was merely down to go and check a URL
    /// that was correct.
    #[error("the sync server could not be reached")]
    Unreachable,
    /// TLS validation or negotiation failed; a pin cannot override this.
    #[error("the sync server TLS handshake failed")]
    TlsFailure,
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

/// The endpoint config plus the derived TLS trust status (not persisted).
#[derive(Debug, Clone, Serialize)]
pub struct SyncEndpointView {
    /// The sync server base URL, or `None` when unconfigured.
    pub endpoint_url: Option<String>,
    /// Retired IPC field. Always `None`, including for legacy configs with a pin.
    pub cert_pin_hex: Option<String>,
    /// TLS verified by native rustls or the browser, or no TLS on loopback HTTP.
    pub pin_source: Option<PinSource>,
}

/// Read the device-local endpoint config into its UI view.
pub async fn get_endpoint_view(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<SyncEndpointView, SyncConfigError> {
    let path = config_path_from_host(host, io).await?;
    let cfg = read_config(io, &path).await?;
    let pin_source = cfg.endpoint_url.as_deref().and_then(pin_source_for);
    Ok(SyncEndpointView {
        endpoint_url: cfg.endpoint_url,
        cert_pin_hex: None,
        pin_source,
    })
}

/// Endpoint-set result. Field names stay wire-compatible for older clients;
/// no certificate fingerprint is exposed or trusted.
#[derive(Debug, Clone, Serialize)]
pub struct EndpointPinInfo {
    /// Retired field. Always `None`.
    pub fingerprint: Option<String>,
    /// HTTPS trust status or `None` for loopback HTTP.
    pub pin_source: Option<PinSource>,
}

/// Validate and persist an endpoint, clearing any legacy pin. Native callers
/// probe TLS before calling this shared storage routine; the browser delegates
/// TLS validation to fetch. The `cert_pin_hex` argument is the retired IPC wire
/// field, kept so the three clients' command signatures do not have to move; it
/// is ignored here and cannot bypass certificate verification.
pub async fn set_endpoint(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    endpoint_url: Option<String>,
    _cert_pin_hex: Option<String>,
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
        cert_pin_hex: None,
    };
    write_config(io, &path, &cfg).await?;
    Ok(EndpointPinInfo {
        fingerprint: None,
        pin_source: pin_source_for(&url),
    })
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

    /// A `https` endpoint reports the platform trust store whatever the stored
    /// config holds. The function no longer takes the config at all, so this is
    /// the same answer twice, which is the point: a legacy pin changes nothing.
    #[test]
    fn tls_reports_platform_trust_and_loopback_http_reports_nothing() {
        assert_eq!(
            pin_source_for("https://s.example"),
            Some(PinSource::PlatformTrustStore)
        );
        assert_eq!(pin_source_for("http://127.0.0.1:8453"), None);
    }

    /// An upgrading user must not lose their endpoint. A config written by a
    /// build that still persisted `cert_pin_hex` has to parse, and the stored
    /// value has to stay inert rather than become a trust anchor.
    #[test]
    fn a_legacy_config_still_parses_and_its_pin_stays_inert() {
        let legacy = br#"{"endpoint_url":"https://s.example","cert_pin_hex":"abababababababababababababababababababababababababababababababab"}"#;
        let cfg: SyncEndpointConfig = serde_json::from_slice(legacy).expect("legacy config parses");
        assert_eq!(cfg.cert_pin_hex.as_deref(), Some(&"ab".repeat(32)[..]));
        assert_eq!(
            pin_source_for(cfg.endpoint_url.as_deref().unwrap()),
            Some(PinSource::PlatformTrustStore)
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

            let updated = SyncEndpointConfig {
                cert_pin_hex: None,
                ..cfg
            };
            write_config(&io, &path, &updated).await.unwrap();
            assert_eq!(read_config(&io, &path).await.unwrap(), updated);
            assert!(!std::fs::read_to_string(&path)
                .unwrap()
                .contains("cert_pin_hex"));

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
