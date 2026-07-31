//! The device-local Tor-routing toggle — command surface + startup restore
//! (MYND-650 task 6).
//!
//! Desktop-only, and it has to be: the preference itself is shared-core
//! (`myne_core::plugins::sync::tor_config`), but *acting* on it means starting
//! and stopping an operating-system process, which only this client can do.
//! This module is the join — the one place where "the user flipped a switch"
//! becomes "a Tor client is running and the transport is routed through it".
//!
//! ## The ordering is the security property
//!
//! Three things move together and the order between them is not cosmetic:
//! the file on disk, [`ProxyGate::set_enabled`], and the sidecar process.
//!
//! * **Persist first, always.** A write that fails leaves nothing else touched,
//!   so the machine's behaviour and the machine's record of it never disagree.
//!   In particular a failed *disable* leaves the user protected rather than
//!   silently returning them to the clearnet on the next launch.
//! * **Enabling: gate on, then spawn.** `set_enabled(true)` with no sidecar
//!   makes [`ProxyGate::route`] refuse every connection ([`RouteDenied`]), so
//!   the window between the toggle and a bootstrapped Tor client is one where
//!   sync pauses — never one where it goes out direct.
//! * **Disabling: stop, then gate off.** The reverse, for the reverse reason
//!   (`proxy.rs` states this rule at `set_enabled`): flipping the gate off
//!   first would leave a live sidecar and a `Ready` state briefly reachable
//!   while the mode is already "off", and the moment the mode is off the
//!   transport is allowed to dial directly.
//!
//! A start failure does **not** roll the preference back. The user asked for
//! Tor; the honest outcome is "Tor is on and unavailable" — the gate stays
//! enabled, the transport stays fail-closed, and the command reports the
//! failure so the UI can say so. Turning the preference off on their behalf
//! would be the one behaviour this feature exists to prevent, dressed up as
//! error recovery.
//!
//! ## No new capability
//!
//! Both commands join the existing `sync` plugin rather than opening a plugin
//! of their own, so `capabilities/default.json` is untouched: `sync:default`
//! is already granted to the main window and the two new identifiers land in
//! that bundle. They are reachable pre-unlock for the same reason the endpoint
//! pair is — network posture is configured before a vault is opened, and
//! neither command touches vault bytes.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use myne_core::io_failure_kind::IoFailureKind;
use myne_core::plugins::sync::proxy::{ProxyGate, TorProxyState};
use myne_core::plugins::sync::tor_config::{
    read_tor_routing, routing_enabled_at_startup, tor_config_path_from_host, write_tor_routing,
    TorConfigError, TorRoutingConfig,
};
use myne_core::vault_io::{StdVaultIo, VaultIo};
use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime, State};
use thiserror::Error;

use crate::tor_sidecar::supervisor::StartError;
use crate::tor_sidecar::TorSidecar;

/// What the toggle reports back: the preference as it now stands on disk.
///
/// Deliberately just the preference. The sidecar's *state* (connecting /
/// ready / failed) is task 8's surface and gets its own read path; returning a
/// snapshot of it here would freeze a value that changes seconds later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TorRoutingView {
    /// Whether sync egress is routed through the device-local Tor proxy.
    pub enabled: bool,
}

/// What is actually happening right now, as opposed to what was asked for
/// (MYND-650 task 8).
///
/// Two fields because neither one answers the question alone. `enabled` is the
/// mode the user chose; `state` is the sidecar's phase. Only the pair
/// distinguishes "the user turned Tor off, nothing is running" (fine, direct
/// sync) from "Tor is on and the client is not running" (fail-closed, sync
/// paused) — and those two are `Stopped` on the `state` side either way. The
/// UI's posture derivation is the same one [`ProxyGate::route`] makes, which is
/// why it is derived from the same pair rather than from a third field this
/// command could get wrong on its own.
///
/// Read from the **gate**, not from the preference file: the gate is what the
/// transport obeys, and a startup whose sidecar failed to spawn leaves the
/// two agreeing on `enabled` but only the gate knowing that nothing is routed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct TorStateView {
    /// Tor mode as the routing gate has it.
    pub enabled: bool,
    /// The sidecar's phase.
    pub state: TorProxyState,
}

/// Failure surface for the two write/read-preference commands. No `String`, no
/// path (`src-tauri/CLAUDE.md` DENY list).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error, Serialize)]
#[serde(tag = "kind", content = "detail")]
pub enum TorRoutingError {
    /// The preference file could not be read or written.
    #[error("filesystem error on the tor-routing preference")]
    Io {
        /// Closed-enum mapping of `std::io::Error::kind()`.
        io_error_kind: IoFailureKind,
    },
    /// The preference file is present but unparseable.
    #[error("the tor-routing preference could not be parsed")]
    Parse,
    /// The preference was saved and Tor mode is ON, but the sidecar did not
    /// start. Sync is paused (fail-closed), NOT routed directly — the
    /// preference is deliberately left enabled.
    #[error("the Tor proxy could not be started")]
    SidecarStartFailed {
        /// Why the spawn failed, as a closed enum.
        reason: StartError,
    },
}

impl From<TorConfigError> for TorRoutingError {
    fn from(e: TorConfigError) -> Self {
        match e {
            TorConfigError::Io { io_error_kind } => TorRoutingError::Io { io_error_kind },
            TorConfigError::Parse => TorRoutingError::Parse,
        }
    }
}

/// What the toggle needs from the sidecar, and nothing more.
///
/// A trait so the ordering rules above are testable without spawning a
/// process: the production implementation shells out to
/// [`TorSidecar::start`]/[`TorSidecar::stop`], and the tests hand in a stub
/// that records the call sequence. Ordering bugs here are invisible in a
/// review and expensive in production, so they get an assertion.
///
/// `Send + Sync` because the command that holds one is an `async fn` Tauri
/// hands to a worker thread, and `&dyn Trait` is only `Send` when the trait is
/// `Sync`.
pub trait SidecarControl: Send + Sync {
    /// Start the Tor client (idempotent — a running sidecar is a no-op).
    fn start(&self) -> Result<(), StartError>;
    /// Terminate it (idempotent).
    fn stop(&self);
}

/// The production [`SidecarControl`]: the managed supervisor plus the two
/// paths it needs, resolved once at construction so the trait can stay
/// argument-free.
struct BundledSidecar {
    sidecar: Arc<TorSidecar>,
    /// Where Tauri stages an `externalBin` — the directory of the running
    /// executable.
    exe_dir: PathBuf,
    /// App-data root; the Tor state/cache live in `tor/` beneath it.
    app_data_dir: PathBuf,
}

impl SidecarControl for BundledSidecar {
    fn start(&self) -> Result<(), StartError> {
        self.sidecar.start(&self.exe_dir, &self.app_data_dir)
    }

    fn stop(&self) {
        self.sidecar.stop();
    }
}

/// Resolve the two paths the sidecar needs, mapping each failure onto the
/// [`StartError`] that describes it.
fn bundled_sidecar<R: Runtime>(
    app: &AppHandle<R>,
    sidecar: Arc<TorSidecar>,
) -> Result<BundledSidecar, StartError> {
    let exe_dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .ok_or(StartError::SidecarMissing)?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|_| StartError::StateDirUnwritable)?;
    Ok(BundledSidecar {
        sidecar,
        exe_dir,
        app_data_dir,
    })
}

/// Apply a toggle: persist, then move the gate and the process in the order
/// the module doc argues for.
///
/// Takes its config path, IO, gate and sidecar as parameters — the
/// `*_with_path` layer of the three-layer command shape (`core/CLAUDE.md`), so
/// the whole rule is drivable from a test with no Tauri runtime and no arti.
async fn set_tor_routing_at(
    io: &dyn VaultIo,
    config_path: &Path,
    gate: &ProxyGate,
    sidecar: &dyn SidecarControl,
    enabled: bool,
) -> Result<TorRoutingView, TorRoutingError> {
    write_tor_routing(io, config_path, TorRoutingConfig { enabled }).await?;

    if enabled {
        // Gate first: from here on the transport refuses to connect at all
        // until the sidecar reports `Ready`. There is no interval in which the
        // preference says "Tor" and a socket may go out direct.
        gate.set_enabled(true);
        sidecar
            .start()
            .map_err(|reason| TorRoutingError::SidecarStartFailed { reason })?;
    } else {
        // Stop first: the sidecar's own teardown publishes `Stopped` into the
        // gate while the mode is still on, so no stale `Ready` is ever visible
        // to a transport that has just been allowed to dial directly.
        sidecar.stop();
        gate.set_enabled(false);
    }

    Ok(TorRoutingView { enabled })
}

/// Restore the toggle at app startup: read the preference and, if Tor mode is
/// on, enable the gate and start the sidecar.
///
/// **The gate is enabled before the sidecar is even attempted**, and stays
/// enabled if the spawn fails. A device that shut down with Tor on must not
/// come back up syncing over the clearnet because a binary was missing — it
/// comes back up paused, which is visible and recoverable.
///
/// A preference file that cannot be parsed also lands here as "on"
/// ([`routing_enabled_at_startup`]); the reasoning is in that function's
/// module doc.
async fn restore_tor_routing_at(
    io: &dyn VaultIo,
    config_path: &Path,
    gate: &ProxyGate,
    sidecar: &dyn SidecarControl,
) -> bool {
    let enabled = routing_enabled_at_startup(read_tor_routing(io, config_path).await);
    if !enabled {
        return false;
    }
    gate.set_enabled(true);
    // A failure is already published as `Failed` by the supervisor, which the
    // gate turns into a refusal; there is nothing further to do with it here
    // and no caller that could act on it at startup.
    let _ = sidecar.start();
    true
}

/// Read the device-local Tor-routing preference. No vault access; reachable
/// pre-unlock like the endpoint pair.
#[tauri::command]
pub async fn sync_get_tor_routing<R: Runtime>(
    app: AppHandle<R>,
) -> Result<TorRoutingView, TorRoutingError> {
    let host = myne_core::host::tauri_host::TauriHost::new(app.clone());
    let cfg = myne_core::plugins::sync::tor_config::get_tor_routing(&host, &StdVaultIo).await?;
    Ok(TorRoutingView {
        enabled: cfg.enabled,
    })
}

/// Read the live routing posture: Tor mode plus the sidecar's phase
/// (MYND-650 task 8).
///
/// Infallible and cheap — two `Copy` fields behind an `RwLock` — because the UI
/// polls it while the Network panel is open and while the fail-closed banner is
/// on screen. It touches no file: the preference read is
/// [`sync_get_tor_routing`], and the two answer different questions (what was
/// asked for vs. what is running). A UI that showed the preference as if it
/// were the posture would tell a user they are protected while a dead sidecar
/// has sync paused.
#[tauri::command]
pub fn sync_get_tor_state(gate: State<'_, ProxyGate>) -> TorStateView {
    TorStateView {
        enabled: gate.is_enabled(),
        state: gate.state(),
    }
}

/// Turn device-local Tor routing on or off.
///
/// On success the preference is persisted, the transport's routing gate
/// reflects it, and the sidecar has been started or stopped to match. On a
/// spawn failure the preference is still persisted and still ON — see the
/// module doc.
#[tauri::command]
pub async fn sync_set_tor_routing<R: Runtime>(
    app: AppHandle<R>,
    gate: State<'_, ProxyGate>,
    sidecar: State<'_, Arc<TorSidecar>>,
    enabled: bool,
) -> Result<TorRoutingView, TorRoutingError> {
    let host = myne_core::host::tauri_host::TauriHost::new(app.clone());
    let config_path = tor_config_path_from_host(&host, &StdVaultIo).await?;
    let control = bundled_sidecar(&app, sidecar.inner().clone())
        .map_err(|reason| TorRoutingError::SidecarStartFailed { reason })?;
    set_tor_routing_at(&StdVaultIo, &config_path, gate.inner(), &control, enabled).await
}

/// App-setup entry point: restore the toggle before the sync loop can build a
/// transport. Best-effort and non-fatal — a resolution failure leaves Tor mode
/// off, which is the shipped default and the state of every install that has
/// never touched the toggle.
///
/// Called from `lib.rs` **before** `proxy::install`'s gate is read by anything,
/// and before the sync loop is spawned.
pub fn restore_at_startup<R: Runtime>(
    app: &AppHandle<R>,
    gate: &ProxyGate,
    sidecar: Arc<TorSidecar>,
) {
    let host = myne_core::host::tauri_host::TauriHost::new(app.clone());
    let Ok(control) = bundled_sidecar(app, sidecar) else {
        tracing::warn!(event = "tor_routing_restore_skipped");
        return;
    };
    let restored = tauri::async_runtime::block_on(async {
        let config_path = match tor_config_path_from_host(&host, &StdVaultIo).await {
            Ok(path) => path,
            Err(_) => {
                // Cannot resolve the file at all. Tor mode stays off, which is
                // the same posture as a fresh install — and the same posture
                // every other device-local config takes when its directory is
                // unreachable.
                return false;
            }
        };
        restore_tor_routing_at(&StdVaultIo, &config_path, gate, &control).await
    });
    tracing::info!(event = "tor_routing_restored", enabled = restored);
}

#[cfg(test)]
mod tests {
    use super::*;
    use myne_core::plugins::sync::proxy::{Route, RouteDenied, TorProxyState};
    use myne_core::test_support::{block_on, ScopedTempDir};
    use std::sync::Mutex;

    /// Records what the toggle asked of the sidecar, in order, and lets a test
    /// make the spawn fail.
    #[derive(Default)]
    struct StubSidecar {
        calls: Mutex<Vec<&'static str>>,
        start_error: Option<StartError>,
        /// Set when `start` succeeds, cleared by `stop` — a stand-in for the
        /// supervisor publishing into the gate.
        gate: Option<ProxyGate>,
    }

    impl StubSidecar {
        fn calls(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().clone()
        }
    }

    impl SidecarControl for StubSidecar {
        fn start(&self) -> Result<(), StartError> {
            self.calls.lock().unwrap().push("start");
            if let Some(e) = self.start_error {
                return Err(e);
            }
            if let Some(gate) = &self.gate {
                gate.set_state(TorProxyState::Ready { socks_port: 9150 });
            }
            Ok(())
        }

        fn stop(&self) {
            self.calls.lock().unwrap().push("stop");
            if let Some(gate) = &self.gate {
                gate.set_state(TorProxyState::Stopped);
            }
        }
    }

    fn config_path(dir: &ScopedTempDir) -> PathBuf {
        dir.path().join("tor-routing.json")
    }

    /// Enabling persists, routes through the proxy once the sidecar is up, and
    /// disabling returns the client to direct sync — the acceptance criterion
    /// end to end, minus arti.
    #[test]
    fn enabling_routes_through_the_proxy_and_disabling_returns_to_direct() {
        block_on(async {
            let dir = ScopedTempDir::new("myne-tor-toggle").expect("temp dir");
            let path = config_path(&dir);
            let gate = ProxyGate::new();
            let stub = StubSidecar {
                gate: Some(gate.clone()),
                ..Default::default()
            };

            assert_eq!(gate.route(), Ok(Route::Direct), "off is today's client");

            let view = set_tor_routing_at(&StdVaultIo, &path, &gate, &stub, true)
                .await
                .expect("enable");
            assert!(view.enabled);
            assert_eq!(stub.calls(), vec!["start"]);
            assert_eq!(gate.route(), Ok(Route::Socks5 { socks_port: 9150 }));
            assert!(
                read_tor_routing(&StdVaultIo, &path).await.unwrap().enabled,
                "the preference is on disk, not just in the gate"
            );

            let view = set_tor_routing_at(&StdVaultIo, &path, &gate, &stub, false)
                .await
                .expect("disable");
            assert!(!view.enabled);
            assert_eq!(stub.calls(), vec!["start", "stop"]);
            assert_eq!(gate.route(), Ok(Route::Direct));
            assert!(!read_tor_routing(&StdVaultIo, &path).await.unwrap().enabled);
        });
    }

    /// The window between "the user turned Tor on" and "the sidecar is ready"
    /// must never be a direct connection. Driven with a stub that starts but
    /// publishes nothing, i.e. a Tor client still bootstrapping.
    #[test]
    fn the_gate_is_closed_before_the_sidecar_is_ready() {
        block_on(async {
            let dir = ScopedTempDir::new("myne-tor-toggle").expect("temp dir");
            let path = config_path(&dir);
            let gate = ProxyGate::new();
            // No gate handed to the stub: `start` succeeds and publishes
            // nothing, which is the state of a bootstrapping sidecar.
            let stub = StubSidecar::default();

            set_tor_routing_at(&StdVaultIo, &path, &gate, &stub, true)
                .await
                .expect("enable");

            assert!(gate.is_enabled());
            assert_eq!(
                gate.route(),
                Err(RouteDenied::Stopped),
                "no route until the sidecar reports Ready — never a direct one"
            );
        });
    }

    /// A spawn failure leaves the preference ON and the transport fail-closed,
    /// and reports the reason. Silently reverting to `false` here would put the
    /// user back on the clearnet as a form of error recovery.
    #[test]
    fn a_spawn_failure_leaves_tor_mode_on_and_fail_closed() {
        block_on(async {
            let dir = ScopedTempDir::new("myne-tor-toggle").expect("temp dir");
            let path = config_path(&dir);
            let gate = ProxyGate::new();
            let stub = StubSidecar {
                start_error: Some(StartError::SidecarMissing),
                ..Default::default()
            };

            let err = set_tor_routing_at(&StdVaultIo, &path, &gate, &stub, true)
                .await
                .expect_err("the spawn failed");
            assert_eq!(
                err,
                TorRoutingError::SidecarStartFailed {
                    reason: StartError::SidecarMissing
                }
            );
            assert!(gate.is_enabled(), "the mode the user asked for stands");
            assert!(gate.route().is_err(), "and it fails closed");
            assert!(
                read_tor_routing(&StdVaultIo, &path).await.unwrap().enabled,
                "the preference is persisted, so a restart retries rather than \
                 silently syncing direct"
            );
        });
    }

    /// Disabling stops the sidecar BEFORE the gate opens back up. Asserted on
    /// the recorded order, because both operations succeed either way and only
    /// the interleaving is wrong.
    #[test]
    fn disabling_stops_the_sidecar_before_reopening_the_gate() {
        block_on(async {
            let dir = ScopedTempDir::new("myne-tor-toggle").expect("temp dir");
            let path = config_path(&dir);
            let gate = ProxyGate::new();
            gate.set_enabled(true);
            gate.set_state(TorProxyState::Ready { socks_port: 9150 });

            struct OrderProbe {
                gate: ProxyGate,
                mode_at_stop: Mutex<Option<bool>>,
            }
            impl SidecarControl for OrderProbe {
                fn start(&self) -> Result<(), StartError> {
                    Ok(())
                }
                fn stop(&self) {
                    *self.mode_at_stop.lock().unwrap() = Some(self.gate.is_enabled());
                    self.gate.set_state(TorProxyState::Stopped);
                }
            }
            let probe = OrderProbe {
                gate: gate.clone(),
                mode_at_stop: Mutex::new(None),
            };

            set_tor_routing_at(&StdVaultIo, &path, &gate, &probe, false)
                .await
                .expect("disable");

            assert_eq!(
                *probe.mode_at_stop.lock().unwrap(),
                Some(true),
                "the sidecar must be torn down while Tor mode is still on"
            );
            assert_eq!(gate.route(), Ok(Route::Direct));
        });
    }

    /// A failed write changes nothing else — not the gate, not the process.
    #[test]
    fn a_failed_persist_touches_neither_the_gate_nor_the_sidecar() {
        block_on(async {
            let dir = ScopedTempDir::new("myne-tor-toggle").expect("temp dir");
            // A directory where the file should be: the write fails, the read
            // of it would too.
            let path = dir.path().join("tor-routing.json");
            std::fs::create_dir(&path).expect("occupy the path with a directory");
            let gate = ProxyGate::new();
            let stub = StubSidecar::default();

            let err = set_tor_routing_at(&StdVaultIo, &path, &gate, &stub, true)
                .await
                .expect_err("the write cannot succeed");
            assert!(matches!(err, TorRoutingError::Io { .. }));
            assert!(!gate.is_enabled(), "no mode change without a record of it");
            assert!(stub.calls().is_empty(), "and no process was started");
        });
    }

    /// Restart with the preference on: the gate comes up enabled and the
    /// sidecar is started, before anything can build a transport.
    #[test]
    fn startup_restores_an_enabled_preference() {
        block_on(async {
            let dir = ScopedTempDir::new("myne-tor-toggle").expect("temp dir");
            let path = config_path(&dir);
            write_tor_routing(&StdVaultIo, &path, TorRoutingConfig { enabled: true })
                .await
                .unwrap();

            let gate = ProxyGate::new();
            let stub = StubSidecar {
                gate: Some(gate.clone()),
                ..Default::default()
            };
            assert!(restore_tor_routing_at(&StdVaultIo, &path, &gate, &stub).await);
            assert_eq!(stub.calls(), vec!["start"]);
            assert_eq!(gate.route(), Ok(Route::Socks5 { socks_port: 9150 }));
        });
    }

    /// Restart with no preference file — every install that has never touched
    /// the toggle. Nothing is spawned and the client is unchanged.
    #[test]
    fn startup_with_no_preference_starts_nothing() {
        block_on(async {
            let dir = ScopedTempDir::new("myne-tor-toggle").expect("temp dir");
            let path = config_path(&dir);
            let gate = ProxyGate::new();
            let stub = StubSidecar::default();

            assert!(!restore_tor_routing_at(&StdVaultIo, &path, &gate, &stub).await);
            assert!(stub.calls().is_empty());
            assert!(!gate.is_enabled());
            assert_eq!(gate.route(), Ok(Route::Direct));
        });
    }

    /// A corrupt preference file comes up ON and therefore fail-closed, rather
    /// than quietly reverting a user who had Tor enabled to direct sync.
    #[test]
    fn startup_with_a_corrupt_preference_fails_closed() {
        block_on(async {
            let dir = ScopedTempDir::new("myne-tor-toggle").expect("temp dir");
            let path = config_path(&dir);
            std::fs::write(&path, b"{").expect("write a broken file");
            let gate = ProxyGate::new();
            let stub = StubSidecar {
                start_error: Some(StartError::SidecarMissing),
                ..Default::default()
            };

            assert!(restore_tor_routing_at(&StdVaultIo, &path, &gate, &stub).await);
            assert!(gate.is_enabled());
            assert!(
                gate.route().is_err(),
                "a broken file must never resolve to a direct connection"
            );
        });
    }

    /// The wire shape the TS mirror is written against.
    #[test]
    fn the_error_serializes_with_a_kind_tag() {
        // PascalCase tags with snake_case fields — the convention every other
        // error enum on this boundary uses (`SyncConfigError`), and the one the
        // TS mirrors already match on.
        let json = |e: TorRoutingError| serde_json::to_string(&e).expect("serialize");
        assert_eq!(json(TorRoutingError::Parse), r#"{"kind":"Parse"}"#);
        assert_eq!(
            json(TorRoutingError::Io {
                io_error_kind: IoFailureKind::PermissionDenied
            }),
            r#"{"kind":"Io","detail":{"io_error_kind":"PermissionDenied"}}"#
        );
        assert_eq!(
            json(TorRoutingError::SidecarStartFailed {
                reason: StartError::SidecarMissing
            }),
            r#"{"kind":"SidecarStartFailed","detail":{"reason":"SidecarMissing"}}"#
        );
        assert_eq!(
            serde_json::to_string(&TorRoutingView { enabled: true }).unwrap(),
            r#"{"enabled":true}"#
        );
    }

    /// The posture the UI derives from (task 8). The pair is the payload: the
    /// same `Stopped` phase means "off, syncing directly" or "on, sync paused"
    /// depending on `enabled`, and the UI must not confuse the two.
    #[test]
    fn the_state_view_carries_the_mode_and_the_phase() {
        let json = |v: TorStateView| serde_json::to_string(&v).expect("serialize");
        assert_eq!(
            json(TorStateView {
                enabled: false,
                state: TorProxyState::Stopped,
            }),
            r#"{"enabled":false,"state":{"kind":"stopped"}}"#
        );
        assert_eq!(
            json(TorStateView {
                enabled: true,
                state: TorProxyState::Starting,
            }),
            r#"{"enabled":true,"state":{"kind":"starting"}}"#
        );
        assert_eq!(
            json(TorStateView {
                enabled: true,
                state: TorProxyState::Ready { socks_port: 9150 },
            }),
            r#"{"enabled":true,"state":{"kind":"ready","socksPort":9150}}"#
        );
    }

    /// The view reports what the transport obeys, not what is on disk. A
    /// startup whose sidecar failed leaves the mode on and the phase `Failed`,
    /// and that pair is exactly the fail-closed banner's input.
    #[test]
    fn the_state_view_reads_the_gate_the_transport_obeys() {
        let gate = ProxyGate::new();
        let view = |g: &ProxyGate| TorStateView {
            enabled: g.is_enabled(),
            state: g.state(),
        };

        assert_eq!(
            view(&gate),
            TorStateView {
                enabled: false,
                state: TorProxyState::Stopped
            },
            "a default install is off and running nothing"
        );

        gate.set_enabled(true);
        assert_eq!(
            view(&gate),
            TorStateView {
                enabled: true,
                state: TorProxyState::Stopped
            },
            "the toggle moves before the sidecar does — and the gate refuses \
             here, so the UI must read this as paused, never as protected"
        );
        assert!(gate.route().is_err());

        gate.set_state(TorProxyState::Failed);
        assert_eq!(view(&gate).state, TorProxyState::Failed);
        assert!(gate.route().is_err(), "still fail-closed");

        gate.set_state(TorProxyState::Ready { socks_port: 9150 });
        assert!(view(&gate).enabled && gate.route().is_ok());
    }
}
