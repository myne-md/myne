//! The sync **proxy gate** — where the transport is allowed to send bytes
//! (desktop Tor routing, MYND-650 task 2).
//!
//! The desktop host owns an arti sidecar process (`src-tauri/src/tor_sidecar`).
//! This module is the shared side of that seam: one small, `Clone`-able cell
//! the host **writes** (as the sidecar starts, bootstraps, dies, is stopped)
//! and the transport **reads** before every connect. Nothing here spawns,
//! connects or knows what arti is; the whole point is that the routing decision
//! is a pure function of two facts — is Tor mode on, and is the proxy ready —
//! so the fail-closed invariant is one `match` a reviewer can check.
//!
//! ## Fail-closed is the reason this type exists
//!
//! [`ProxyGate::route`] answers with a [`Route`] or refuses. It NEVER answers
//! [`Route::Direct`] while Tor mode is on: a proxy that is still bootstrapping,
//! has died, or was never started yields [`RouteDenied`], and the caller is
//! expected to fail the sync cycle rather than open a socket. A silent
//! direct-connection fallback would leak the user's real source IP at exactly
//! the moment they believed they were protected — the one failure this feature
//! exists to prevent (PRD story 4).
//!
//! Task 3 turned [`Route::Socks5`] into an actual SOCKS5 `CONNECT`; task 4
//! makes the rustls transport — and with it the SSE poke stream, which shares
//! its connect path — consult this gate before every socket.
//!
//! ## How the transport finds the gate
//!
//! The host owns the gate; the transport is built deep inside the sync engine
//! by [`super::http_transport::build_transport`], through two dozen call sites
//! that have no business knowing what Tor is. So the host **installs** its gate
//! once at startup ([`install`]) and the transport reads it back
//! ([`installed_for`]) — the same shape `http_transport` already uses to let
//! the Worker install the browser's transport, and for the same reason.
//!
//! A client that installs nothing (mobile, the browser, headless tests, the
//! fixture seeders) reads back a default gate, which routes `Direct` — the
//! behaviour those clients have today.
//!
//! Logging: this module emits nothing. It holds a loopback port number and a
//! boolean, but the *state transitions* are the host's to log (and the host
//! logs them as bare state names — see `tor_sidecar`'s module docs).

use std::sync::{Arc, OnceLock, RwLock};

/// The sidecar's lifecycle state, as the host observes it.
///
/// These are the four states the UI has to render (task 8) and the only four
/// the transport has to reason about. `Ready` is the sole state that carries a
/// port, because it is the sole state in which a port means anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TorProxyState {
    /// Spawned, not yet bootstrapped. Sync is paused (NOT routed directly).
    Starting,
    /// Bootstrapped and listening on `127.0.0.1:<socks_port>`.
    #[serde(rename_all = "camelCase")]
    Ready {
        /// The loopback port arti's SOCKS5 listener is bound to.
        socks_port: u16,
    },
    /// Spawn failed, bootstrap timed out, or the process died. Sync stays
    /// paused; the user sees the fail-closed banner.
    Failed,
    /// Not running — either never started, or deliberately terminated.
    Stopped,
}

/// Where a connection may go.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Route {
    /// Tor mode is off: connect to the sync host directly, as always.
    Direct,
    /// Tor mode is on and the proxy is ready: connect to the loopback SOCKS5
    /// port and issue a `CONNECT` with the **hostname** (task 3), so the name
    /// is resolved over Tor rather than by the local resolver.
    Socks5 {
        /// Loopback port of the sidecar's SOCKS5 listener.
        socks_port: u16,
    },
}

/// Why a connection was refused. Every variant means "Tor mode is on and the
/// tunnel is not usable" — i.e. the caller must not connect at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteDenied {
    /// The Tor client is still bootstrapping (5–30s on a cold start).
    Starting,
    /// The Tor client failed to start, timed out, or died.
    Failed,
    /// Tor mode is on but no sidecar is running.
    Stopped,
}

/// Shared handle on the routing decision. Cheap to clone; every clone sees the
/// same cell.
#[derive(Debug, Clone, Default)]
pub struct ProxyGate {
    inner: Arc<RwLock<Inner>>,
}

#[derive(Debug)]
struct Inner {
    /// The device-local `tor_routing_enabled` pref (task 6). `false` is the
    /// default, and the default is what makes this whole module inert until
    /// the user opts in.
    enabled: bool,
    state: TorProxyState,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            enabled: false,
            state: TorProxyState::Stopped,
        }
    }
}

impl ProxyGate {
    /// A gate with Tor mode off and no sidecar — today's direct-sync client.
    pub fn new() -> Self {
        Self::default()
    }

    /// Turn Tor mode on/off. Called by the toggle (task 6) BEFORE the sidecar
    /// starts and AFTER it stops, so there is never a window in which the mode
    /// is on and the state is stale-`Ready`.
    pub fn set_enabled(&self, enabled: bool) {
        self.write(|i| i.enabled = enabled);
    }

    /// Publish the sidecar's state. Called by the host supervisor.
    pub fn set_state(&self, state: TorProxyState) {
        self.write(|i| i.state = state);
    }

    /// Is Tor mode on?
    pub fn is_enabled(&self) -> bool {
        self.read(|i| i.enabled)
    }

    /// The sidecar's current state (what the UI renders).
    pub fn state(&self) -> TorProxyState {
        self.read(|i| i.state)
    }

    /// **The fail-closed decision.** `Ok(Direct)` only when Tor mode is off;
    /// with Tor mode on, only a `Ready` proxy yields a route and everything
    /// else refuses.
    pub fn route(&self) -> Result<Route, RouteDenied> {
        let (enabled, state) = self.read(|i| (i.enabled, i.state));
        if !enabled {
            return Ok(Route::Direct);
        }
        match state {
            TorProxyState::Ready { socks_port } => Ok(Route::Socks5 { socks_port }),
            TorProxyState::Starting => Err(RouteDenied::Starting),
            TorProxyState::Failed => Err(RouteDenied::Failed),
            TorProxyState::Stopped => Err(RouteDenied::Stopped),
        }
    }

    fn read<T>(&self, f: impl FnOnce(&Inner) -> T) -> T {
        // A poisoned lock here would mean a panic while holding two `Copy`
        // fields — recovering the value is strictly safer than propagating the
        // panic into the transport, which would surface as a sync crash.
        match self.inner.read() {
            Ok(g) => f(&g),
            Err(p) => f(&p.into_inner()),
        }
    }

    fn write(&self, f: impl FnOnce(&mut Inner)) {
        match self.inner.write() {
            Ok(mut g) => f(&mut g),
            Err(p) => f(&mut p.into_inner()),
        }
    }
}

// ── the installed gate ──────────────────────────────────────────────────────

/// The host's gate, published for the transport to read. `OnceLock` rather than
/// a mutable slot because there is exactly one sidecar supervisor per process
/// and the gate it publishes into is itself mutable — swapping the *cell* would
/// only ever mean a second supervisor, which is a bug, not a feature.
static INSTALLED: OnceLock<ProxyGate> = OnceLock::new();

/// Publish the host's gate. Called once, from app setup, before any sync
/// command can run. A second call is ignored (returns `false`) rather than
/// racing.
///
/// **The return value is the bug canary and must not be dropped.** A second
/// setup in one process leaves gate **A** installed — the one every transport
/// reads, routing `Direct` — while the caller goes on to manage and toggle
/// gate **B**. The UI would then report B's posture while the sockets obey A:
/// silent, and in the fail-*open* direction.
#[must_use = "a false return means a SECOND gate was installed and the transport \
              is still reading the first one — fail-open, and silent unless the \
              caller says so"]
pub fn install(gate: ProxyGate) -> bool {
    INSTALLED.set(gate).is_ok()
}

/// The installed gate, or a default (Tor mode off) one for a client that
/// installs none.
pub fn installed() -> ProxyGate {
    INSTALLED.get().cloned().unwrap_or_default()
}

/// Is `host` exempt from Tor routing?
///
/// **Loopback only, and it is not a bypass**: `127.0.0.1` / `localhost` /
/// `[::1]` name a service on this device, so a connection to one never leaves
/// the machine and exposes no source IP to anybody. There is nothing for a
/// circuit to hide, and arti would refuse to build one to a loopback address
/// anyway — routing the dev server and the E2E harness through Tor would turn
/// "Tor mode is on" into "sync is broken" for no privacy gained.
///
/// The predicate is deliberately the SAME one the A4 endpoint policy uses to
/// decide where plaintext `http` is permitted ([`super::http_transport`]'s
/// `is_loopback`): a literal string match against three names, never a resolved
/// address. One notion of "loopback", checked in one place, for both rules.
pub fn host_is_tor_exempt(host: &str) -> bool {
    super::http_transport::is_loopback(host)
}

/// Is the configured `endpoint_url` exempt from Tor routing?
///
/// The endpoint-shaped wrapper around [`host_is_tor_exempt`], for the surfaces
/// that hold a URL rather than a host — the posture command in particular. An
/// unparseable URL is **not** exempt: a string this client cannot resolve to a
/// host is not a string it may claim names this device.
///
/// This is what stops the posture from reporting "sync is going through Tor"
/// about an endpoint no byte of which is tunneled. Literal loopback traffic
/// never leaves the machine, so that mismatch is a misreport rather than a
/// leak — but the realistic shape is a forward to a *remote* server, where it
/// is a misreport about traffic that does leave.
pub fn endpoint_is_tor_exempt(endpoint_url: &str) -> bool {
    super::http_transport::parse_endpoint(endpoint_url)
        .is_some_and(|(_, host, _)| host_is_tor_exempt(&host))
}

/// The gate a transport for `host` must obey: the installed one, or — for a
/// loopback host — a fresh default gate that always routes `Direct`.
///
/// Returning a *gate* rather than a boolean is what keeps the transport free of
/// an exemption branch of its own: it consults whatever gate it was handed,
/// unconditionally, and the policy lives here.
pub fn installed_for(host: &str) -> ProxyGate {
    if host_is_tor_exempt(host) {
        ProxyGate::new()
    } else {
        installed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_gate_routes_directly_tor_mode_off() {
        let gate = ProxyGate::new();
        assert!(!gate.is_enabled());
        assert_eq!(gate.state(), TorProxyState::Stopped);
        assert_eq!(gate.route(), Ok(Route::Direct));
    }

    #[test]
    fn tor_mode_on_with_ready_proxy_routes_through_the_loopback_socks_port() {
        let gate = ProxyGate::new();
        gate.set_enabled(true);
        gate.set_state(TorProxyState::Ready { socks_port: 9150 });
        assert_eq!(gate.route(), Ok(Route::Socks5 { socks_port: 9150 }));
    }

    /// The invariant the whole feature rests on: with Tor mode on, no
    /// non-`Ready` state may ever produce a direct connection.
    #[test]
    fn tor_mode_on_never_falls_back_to_direct() {
        let gate = ProxyGate::new();
        gate.set_enabled(true);
        for (state, denied) in [
            (TorProxyState::Starting, RouteDenied::Starting),
            (TorProxyState::Failed, RouteDenied::Failed),
            (TorProxyState::Stopped, RouteDenied::Stopped),
        ] {
            gate.set_state(state);
            assert_eq!(gate.route(), Err(denied), "{state:?} must fail closed");
        }
    }

    /// Turning the toggle off is what returns the client to direct sync — and
    /// it does so even if the last observed sidecar state is a stale `Ready`,
    /// because `enabled` is checked first.
    #[test]
    fn disabling_tor_mode_returns_to_direct_even_with_a_stale_ready_state() {
        let gate = ProxyGate::new();
        gate.set_enabled(true);
        gate.set_state(TorProxyState::Ready { socks_port: 9150 });
        gate.set_enabled(false);
        assert_eq!(gate.route(), Ok(Route::Direct));
    }

    #[test]
    fn clones_share_one_cell() {
        let host_side = ProxyGate::new();
        let transport_side = host_side.clone();
        host_side.set_enabled(true);
        host_side.set_state(TorProxyState::Ready { socks_port: 1080 });
        assert_eq!(
            transport_side.route(),
            Ok(Route::Socks5 { socks_port: 1080 })
        );
    }

    /// Loopback is the whole exemption list, and it is exact-match: a hostname
    /// that merely *contains* a loopback name is a real remote host.
    #[test]
    fn only_the_three_loopback_names_are_exempt_from_tor_routing() {
        for exempt in ["127.0.0.1", "localhost", "::1"] {
            assert!(host_is_tor_exempt(exempt), "{exempt} names this device");
        }
        for routed in [
            "sync.myne.md",
            "localhost.evil.example",
            "127.0.0.1.evil.example",
            "127.0.0.2",
            "example.com",
            "",
        ] {
            assert!(
                !host_is_tor_exempt(routed),
                "{routed:?} is a remote host and must be routed"
            );
        }
    }

    /// The endpoint-shaped wrapper agrees with the host-shaped predicate, and
    /// an endpoint this client cannot parse is never claimed to be local.
    #[test]
    fn only_a_loopback_endpoint_is_exempt_and_an_unparseable_one_is_not() {
        for exempt in [
            "http://127.0.0.1:8443",
            "https://localhost:8443",
            "http://[::1]:8443/",
            "https://localhost",
        ] {
            assert!(endpoint_is_tor_exempt(exempt), "{exempt} names this device");
        }
        for routed in [
            "https://sync.myne.md",
            "https://localhost.evil.example",
            "https://127.0.0.2:8443",
            // Not a URL this client can resolve to a host — so not one it may
            // claim is local.
            "localhost:8443",
            "",
        ] {
            assert!(!endpoint_is_tor_exempt(routed), "{routed:?} must be routed");
        }
    }

    /// A loopback transport gets a gate that routes `Direct` no matter what the
    /// installed one says — checked here without touching the process-global,
    /// because the exemption is a property of the host string alone.
    #[test]
    fn a_loopback_host_gets_a_direct_only_gate() {
        assert_eq!(installed_for("127.0.0.1").route(), Ok(Route::Direct));
        assert_eq!(installed_for("localhost").route(), Ok(Route::Direct));
    }

    /// With nothing installed — mobile, the browser, the fixture seeders, every
    /// test in this crate — the gate is the direct-sync client of today.
    #[test]
    fn an_uninstalled_gate_routes_directly() {
        assert_eq!(ProxyGate::default().route(), Ok(Route::Direct));
        assert!(
            !installed_for("sync.myne.md").is_enabled(),
            "no test in this crate installs a gate, so the read-back is the default"
        );
    }

    /// The UI reads these tags (task 8); the port is the only payload.
    #[test]
    fn state_serializes_with_a_kind_tag_for_the_ui() {
        let json = |s| serde_json::to_string(&s).expect("serialize");
        assert_eq!(json(TorProxyState::Starting), r#"{"kind":"starting"}"#);
        assert_eq!(json(TorProxyState::Failed), r#"{"kind":"failed"}"#);
        assert_eq!(json(TorProxyState::Stopped), r#"{"kind":"stopped"}"#);
        assert_eq!(
            json(TorProxyState::Ready { socks_port: 9150 }),
            r#"{"kind":"ready","socksPort":9150}"#
        );
    }
}
