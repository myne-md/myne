//! The device-local `tor_routing_enabled` preference (MYND-650 task 6).
//!
//! One boolean, persisted at `<app_config_dir>/tor-routing.json`. It is the
//! only thing in the feature that can ever set [`super::proxy::ProxyGate`]'s
//! `enabled` flag; with it off — the default, and the state of every existing
//! install — every Tor branch added by tasks 2–5 is unreachable and the client
//! is byte-for-byte the direct-sync client it is today.
//!
//! ## Why it is device-local, and why it is its own file
//!
//! **Device-local**, because network posture is a property of the machine, not
//! of the account: the same vault is legitimately synced from a laptop on a
//! hostile network and a desktop at home. Putting it in the synced
//! `vault.prefs` (`MYP1`) blob would mean turning Tor on at an internet café
//! silently turns it on for every other device — and, worse, that a device
//! which never opted in starts refusing to sync (fail-closed) because of a
//! setting made somewhere else. So it is not a `PrefsView` field at all, rather
//! than a `PrefsView` field excluded from sync.
//!
//! **Its own file**, rather than a field on [`super::config::SyncEndpointConfig`]
//! (the other device-local JSON in this directory), because that struct's write
//! path constructs a fresh value and writes it — `set_endpoint` does exactly
//! that, and clearing an endpoint writes `Default::default()`. A field with a
//! different lifetime living in that struct is one forgotten read-modify-write
//! away from silently resetting to `false`, and `false` here means the next
//! sync goes out over the clearnet carrying the user's source IP. The failure
//! is invisible, it points the wrong way, and separate files make it
//! impossible rather than merely unlikely.
//!
//! ## Absent, corrupt, and which way each fails
//!
//! Absent ⇒ **off**. That is the overwhelmingly common case (nobody has ever
//! touched the toggle) and it is the shipped default.
//!
//! Present-but-unparseable ⇒ [`TorConfigError::Parse`], and at startup
//! [`routing_enabled_at_startup`] resolves that to **on** — the opposite of the
//! absent case, deliberately. A present file means somebody wrote it, which
//! means the toggle was used; defaulting a corrupt one to `false` would drop a
//! user's Tor routing on the quiet and sync direct. Resolving it to `true`
//! instead leaves the gate enabled with no sidecar running, which
//! [`super::proxy::ProxyGate::route`] answers by refusing to connect at all.
//! Sync pauses visibly (task 8's banner) and the remedy is one toggle, which
//! rewrites the file. Loud and safe beats quiet and exposed.

use crate::io_failure_kind::{from_io_error_kind, IoFailureKind};
use serde::{Deserialize, Serialize};
use std::path::Path;
use thiserror::Error;

/// The file name under `<app_config_dir>`. Sibling of `sync-config.json`.
const FILE_NAME: &str = "tor-routing.json";

/// The device-local Tor-routing preference as persisted.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TorRoutingConfig {
    /// Whether sync egress is routed through the device-local Tor proxy.
    /// `false` — the default — is today's direct-sync client.
    #[serde(default)]
    pub enabled: bool,
}

/// Failure surface for reading/writing the preference.
///
/// Two variants and no `String`: this reaches the UI, and a path in an error
/// message is a disclosure (`src-tauri/CLAUDE.md` DENY list).
#[derive(Debug, Clone, Copy, Error, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail")]
pub enum TorConfigError {
    /// Filesystem error reading or writing `tor-routing.json`.
    #[error("filesystem error on tor-routing.json")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },
    /// The on-disk file failed to parse as JSON.
    #[error("tor-routing.json parse failed")]
    Parse,
}

impl From<IoFailureKind> for TorConfigError {
    fn from(io_error_kind: IoFailureKind) -> Self {
        TorConfigError::Io { io_error_kind }
    }
}

impl From<std::io::Error> for TorConfigError {
    fn from(e: std::io::Error) -> Self {
        TorConfigError::Io {
            io_error_kind: from_io_error_kind(e.kind()),
        }
    }
}

/// `<app_config_dir>/tor-routing.json`, creating the directory if needed —
/// the same resolution [`super::config::config_path_from_host`] does for its
/// own sibling file, through the same seam.
pub async fn tor_config_path_from_host(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<std::path::PathBuf, TorConfigError> {
    let dir = host.app_config_dir().map_err(|_| TorConfigError::Io {
        io_error_kind: IoFailureKind::Other,
    })?;
    io.create_dir_all(&dir).await?;
    Ok(dir.join(FILE_NAME))
}

/// Read the preference from `path`. Absent ⇒ the default (off); present but
/// unparseable ⇒ [`TorConfigError::Parse`] (see the module doc for why those
/// two answers are deliberately different).
pub async fn read_tor_routing(
    io: &dyn crate::vault_io::VaultIo,
    path: &Path,
) -> Result<TorRoutingConfig, TorConfigError> {
    match crate::singleton::open_newest(io, path, |bytes| {
        serde_json::from_slice::<TorRoutingConfig>(bytes)
    })
    .await
    {
        Ok(cfg) => Ok(cfg),
        Err(crate::singleton::OpenOutcome::Absent) => Ok(TorRoutingConfig::default()),
        Err(crate::singleton::OpenOutcome::Undecodable(_)) => Err(TorConfigError::Parse),
        Err(crate::singleton::OpenOutcome::Io(kind)) => Err(kind.into()),
    }
}

/// Persist the preference to `path` (atomic replace, like its sibling config).
pub async fn write_tor_routing(
    io: &dyn crate::vault_io::VaultIo,
    path: &Path,
    cfg: TorRoutingConfig,
) -> Result<(), TorConfigError> {
    let bytes = serde_json::to_vec_pretty(&cfg).map_err(|_| TorConfigError::Parse)?;
    io.write(path, &bytes, crate::vault_io::WriteOpts::default())
        .await?;
    Ok(())
}

/// Read the preference through the host seam.
pub async fn get_tor_routing(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
) -> Result<TorRoutingConfig, TorConfigError> {
    let path = tor_config_path_from_host(host, io).await?;
    read_tor_routing(io, &path).await
}

/// Write the preference through the host seam.
///
/// Deliberately does **not** touch the gate or the sidecar: the caller owns the
/// ordering between persistence and the process, and that ordering is
/// security-relevant (`src-tauri/src/plugins/sync/tor.rs`).
pub async fn set_tor_routing(
    host: &dyn crate::host::HostCtx,
    io: &dyn crate::vault_io::VaultIo,
    enabled: bool,
) -> Result<(), TorConfigError> {
    let path = tor_config_path_from_host(host, io).await?;
    write_tor_routing(io, &path, TorRoutingConfig { enabled }).await
}

/// What Tor mode should be at startup, given whatever [`read_tor_routing`]
/// answered.
///
/// The one place the "a broken file fails ON" rule is written down, so it is a
/// function with a test rather than a `match` arm somewhere in app setup. See
/// the module doc for the argument.
pub fn routing_enabled_at_startup(read: Result<TorRoutingConfig, TorConfigError>) -> bool {
    match read {
        Ok(cfg) => cfg.enabled,
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("myne-tor-cfg-{}-{name}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(FILE_NAME)
    }

    /// Absent is "off", a write round-trips, and a corrupt file is a `Parse`
    /// error rather than a silent default — the distinction the module doc
    /// argues is load-bearing.
    #[test]
    fn absent_is_off_and_a_write_round_trips() {
        crate::test_support::block_on(async {
            let io = crate::vault_io::StdVaultIo;
            let path = scratch("roundtrip");
            std::fs::remove_file(&path).ok();

            assert_eq!(
                read_tor_routing(&io, &path).await.unwrap(),
                TorRoutingConfig { enabled: false },
                "no file means the user never opted in"
            );

            write_tor_routing(&io, &path, TorRoutingConfig { enabled: true })
                .await
                .unwrap();
            assert_eq!(
                read_tor_routing(&io, &path).await.unwrap(),
                TorRoutingConfig { enabled: true }
            );

            write_tor_routing(&io, &path, TorRoutingConfig { enabled: false })
                .await
                .unwrap();
            assert_eq!(
                read_tor_routing(&io, &path).await.unwrap(),
                TorRoutingConfig { enabled: false }
            );

            std::fs::write(&path, b"{not json").unwrap();
            assert_eq!(
                read_tor_routing(&io, &path).await,
                Err(TorConfigError::Parse)
            );

            std::fs::remove_file(&path).ok();
        });
    }

    /// The preference survives a restart, which for a plain file means: what a
    /// second reader sees is what the first writer wrote, with nothing of the
    /// process carried across.
    #[test]
    fn the_preference_survives_a_restart() {
        crate::test_support::block_on(async {
            let io = crate::vault_io::StdVaultIo;
            let path = scratch("restart");
            std::fs::remove_file(&path).ok();

            write_tor_routing(&io, &path, TorRoutingConfig { enabled: true })
                .await
                .unwrap();

            // A "restart" is a fresh reader over the same bytes.
            let reread = read_tor_routing(&crate::vault_io::StdVaultIo, &path)
                .await
                .unwrap();
            assert!(reread.enabled);

            std::fs::remove_file(&path).ok();
        });
    }

    /// An unknown field must not make an existing file unreadable — a forward
    /// field added by a later version reads back as the boolean it still
    /// carries, not as `Parse` (which at startup would fail the client closed
    /// for no reason).
    #[test]
    fn an_unknown_field_is_tolerated() {
        crate::test_support::block_on(async {
            let io = crate::vault_io::StdVaultIo;
            let path = scratch("forward");
            std::fs::write(&path, br#"{"enabled":true,"bridges":"obfs4"}"#).unwrap();
            assert!(read_tor_routing(&io, &path).await.unwrap().enabled);
            std::fs::remove_file(&path).ok();
        });
    }

    /// The startup reduction: absent/off is off, on is on, and a broken file is
    /// ON — which the gate then answers by refusing to connect at all, rather
    /// than by quietly syncing over the clearnet.
    #[test]
    fn a_broken_preference_file_starts_tor_mode_on() {
        assert!(!routing_enabled_at_startup(Ok(TorRoutingConfig {
            enabled: false
        })));
        assert!(routing_enabled_at_startup(Ok(TorRoutingConfig {
            enabled: true
        })));
        assert!(routing_enabled_at_startup(Err(TorConfigError::Parse)));
        assert!(routing_enabled_at_startup(Err(TorConfigError::Io {
            io_error_kind: IoFailureKind::PermissionDenied
        })));
    }

    /// With the preference off, the gate a transport reads routes directly —
    /// the property that makes every install that never touches this toggle
    /// unchanged.
    #[test]
    fn the_default_preference_leaves_the_gate_routing_directly() {
        let gate = super::super::proxy::ProxyGate::new();
        gate.set_enabled(TorRoutingConfig::default().enabled);
        assert_eq!(
            gate.route(),
            Ok(super::super::proxy::Route::Direct),
            "the shipped default must be today's direct-sync client"
        );
    }
}
