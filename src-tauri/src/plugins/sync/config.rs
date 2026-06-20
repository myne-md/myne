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

/// True for a loopback host where plain `http` is permitted.
fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

/// Validate an endpoint URL per the A4/TB5 policy. `https` is always allowed;
/// `http` is allowed only for a loopback host (local E2E / dev server).
pub fn validate_endpoint_url(url: &str) -> Result<(), SyncConfigError> {
    let (scheme, host) = parse_scheme_host(url).ok_or(SyncConfigError::InvalidUrl)?;
    match scheme {
        "https" => Ok(()),
        "http" if is_loopback_host(host) => Ok(()),
        "http" => Err(SyncConfigError::InsecureScheme),
        _ => Err(SyncConfigError::InvalidUrl),
    }
}

/// Read the device-local config from `path`. An absent file is NOT an error —
/// it means "sync unconfigured" and returns the default. A present-but-corrupt
/// file is a `Parse` error (the operator must fix or clear it).
pub fn read_config(path: &Path) -> Result<SyncEndpointConfig, SyncConfigError> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| SyncConfigError::Parse),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(SyncEndpointConfig::default()),
        Err(e) => Err(e.into()),
    }
}

/// Persist the config to `path` (atomic replace). The caller validates the URL
/// via [`validate_endpoint_url`] before constructing the config.
pub fn write_config(path: &Path, cfg: &SyncEndpointConfig) -> Result<(), SyncConfigError> {
    let bytes = serde_json::to_vec_pretty(cfg).map_err(|_| SyncConfigError::Parse)?;
    crate::atomic_write::atomic_write(path, &bytes, true)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        let dir = std::env::temp_dir().join(format!("myne-sync-cfg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sync-config.json");

        // Absent → default.
        assert_eq!(read_config(&path).unwrap(), SyncEndpointConfig::default());

        let cfg = SyncEndpointConfig {
            endpoint_url: Some("https://sync.myne.md".into()),
        };
        write_config(&path, &cfg).unwrap();
        assert_eq!(read_config(&path).unwrap(), cfg);

        // Corrupt → Parse error.
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(read_config(&path), Err(SyncConfigError::Parse));

        std::fs::remove_dir_all(&dir).ok();
    }
}
