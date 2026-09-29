//! The `/sync/poke` SSE listener (MYND-423 client half).
//!
//! Keeps ONE long-lived SSE stream open per unlocked, enrolled vault so a push
//! on another device turns into a pull here within seconds instead of the next
//! 30 s poll boundary. Per the amended `sync-protocol.md` §8.3 the stream is
//! **baseline behaviour, not an opt-in layer**: the fixed-interval polling
//! already disclosed presence at poll granularity while unlocked, so the
//! continuous connection's marginal A13 delta no longer carries a user-facing
//! toggle. What remains load-bearing is the signal's shape — the poke is
//! LITERALLY zero-payload (no note-id, version, count, or cursor), and this
//! listener extracts exactly one bit from it ("something changed, pull").
//!
//! ## Shape
//!
//! - **Supervisor** — a tokio task (spawned from both hosts' setup, like
//!   `spawn_sync_loop`) that decides each tick whether a stream SHOULD exist
//!   (`unlocked && !suspended && endpoint && token && !parked-on-401 && the
//!   routing gate answers a route`) and starts/stops the worker to match.
//! - **Worker** — a dedicated `std::thread` ("myne-sse"): blocking reads with a
//!   65 s socket read-timeout (two missed 30 s server heartbeats + margin) are
//!   the dead-connection detector; reconnects ride a jittered 1 s → 60 s
//!   exponential backoff, reset whenever the stream actually delivered bytes.
//!   NOT `spawn_blocking` — parking a tokio blocking-pool slot for a
//!   connection's whole lifetime (hours) would misuse the pool every command
//!   shares. Teardown is `stop`-flag + `TcpStream::shutdown` on a cloned
//!   handle, so a lock/suspend kills the blocking read within milliseconds.
//! - **Delivery** — the worker bumps the app-managed [`SsePokeSignal`] counter;
//!   `spawn_sync_loop` reads it each tick and asks the scheduler for one
//!   immediate pull. Every successful (re)connect ALSO bumps once — the
//!   catch-up pull that closes the "poke sent while we were disconnected" gap.
//! - **401 → park** — a rejected token must not reconnect-spin. The worker
//!   parks the supervisor on the failing `(endpoint, token)` identity; a
//!   re-enroll / endpoint change (different fingerprint) un-parks it.
//!
//! ## The route is part of the connection's identity (MYND-650)
//!
//! This is the one long-lived socket in the sync tree, and a long-lived socket
//! has a second axis the `no_bypass` ratchet cannot see: a connect that was
//! correctly gated **when it happened** keeps carrying bytes after the gate
//! moves. `build_transport` consults [`super::proxy`] before every connect, so
//! a *new* stream is always routed correctly — but a stream opened before the
//! user turned Tor on would otherwise stay open, direct to the sync server,
//! for the life of the app: `SSE_READ_TIMEOUT` sits deliberately above the
//! server's heartbeat cadence, so a healthy connection never times out.
//!
//! So the route the gate answers for this endpoint is part of
//! [`StreamIdentity`] alongside `(endpoint, token)`, and it is re-read
//! **every** supervisor tick rather than on the 5-tick file-snapshot cadence
//! (it is an in-memory cell, not a file). A gate that moves — the toggle, a
//! bootstrap completing, a sidecar dying, the startup restore — is a different
//! identity, so the live stream is torn down and the next tick reconnects
//! through `build_transport`, which reads the gate. And a gate that *refuses*
//! (Tor mode on, tunnel not usable) yields no identity at all, so no stream
//! exists while the transport is fail-closed — the same answer the sync cycle
//! gets, rather than a second opinion about it.

use std::io::{BufRead, Read};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};

use super::proxy::{self, Route};
use super::token_store::TokenStore as _;
use super::transport::{SseOpenError, SseStream};

/// SSE dead-connection read-timeout: two missed 30 s server heartbeats plus
/// margin (the server's `DefaultHeartbeatInterval`; change them together).
const SSE_READ_TIMEOUT: Duration = Duration::from_secs(65);
/// Reconnect backoff bounds (jittered exponential).
const BACKOFF_START_MS: u64 = 1_000;
const BACKOFF_CAP_MS: u64 = 60_000;
/// Supervisor decision cadence.
const SUPERVISOR_TICK_MS: u64 = 1_000;
/// Endpoint/token snapshot refresh cadence, in supervisor ticks (two small
/// file reads — cheap, but not per-tick cheap).
const SNAPSHOT_REFRESH_TICKS: u32 = 5;

/// App-managed poke counter: the worker thread bumps it, the sync loop reads it
/// each tick (`SyncLocalChange` pattern; the `Arc` inner lets the worker hold a
/// clone of the managed instance's counter).
#[derive(Clone, Default)]
pub struct SsePokeSignal(Arc<AtomicU64>);

impl SsePokeSignal {
    /// A poke arrived (or a stream (re)connected — the catch-up bump).
    pub fn bump(&self) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
    pub(crate) fn get(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }
}

/// The connection identity a worker is bound to. A change in any field is a
/// different stream (teardown + reconnect under the new identity).
#[derive(Clone)]
struct ConnSnapshot {
    url: String,
    token_hex: String,
}

fn fingerprint_of(s: &ConnSnapshot) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.url.hash(&mut h);
    s.token_hex.hash(&mut h);
    h.finish()
}

/// Everything a live stream is bound to: the `(endpoint, token)` fingerprint
/// **and** the route it was opened over. A change in either is a different
/// stream.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
struct StreamIdentity {
    fingerprint: u64,
    route: Route,
}

/// The identity a stream for `snap` would have right now, or `None` when no
/// stream may exist — an endpoint that does not parse, or a routing gate that
/// refuses (Tor mode on, tunnel not usable), which is the fail-closed answer
/// the sync cycle also gets.
fn stream_identity(snap: &ConnSnapshot) -> Option<StreamIdentity> {
    let (_, host, _) = super::http_transport::parse_endpoint(&snap.url)?;
    stream_identity_over(snap, &proxy::installed_for(&host))
}

/// The identity, given the gate — the same gate `build_transport` would consult
/// for this endpoint.
///
/// Split out so a test can drive a **real** [`proxy::ProxyGate`] through the
/// lifecycle a toggle actually produces, rather than asserting against
/// hand-built [`StreamIdentity`] literals. The process-wide installed gate is a
/// `OnceLock`, so a test that installed one would leak its state into every
/// other test in this binary; a gate passed by reference cannot.
fn stream_identity_over(snap: &ConnSnapshot, gate: &proxy::ProxyGate) -> Option<StreamIdentity> {
    Some(StreamIdentity {
        fingerprint: fingerprint_of(snap),
        route: gate.route().ok()?,
    })
}

/// What the supervisor does with the worker it has, given the identity it
/// wants. Pure, so the rule that closes the "toggled Tor under a live stream"
/// hole is one function with a test rather than a `match` in a spawned task.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Decision {
    /// Leave things as they are.
    Idle,
    /// No worker and one is wanted.
    Spawn,
    /// The worker must go — either nothing is wanted, or the identity moved
    /// and the next tick reconnects under the new one.
    Teardown,
}

fn decide(current: Option<StreamIdentity>, wanted: Option<StreamIdentity>) -> Decision {
    match (current, wanted) {
        (None, Some(_)) => Decision::Spawn,
        (Some(_), None) => Decision::Teardown,
        (Some(have), Some(want)) if have != want => Decision::Teardown,
        _ => Decision::Idle,
    }
}

/// Gather the live `(endpoint, token)` snapshot, or `None` when any part
/// is missing (unconfigured / locked / not enrolled). Reads the same sources as
/// `run_active_cycle` — but NEVER claims a pending token (that is the cycle's
/// job; the listener only ever uses an already-stored token).
async fn gather_snapshot<R: Runtime>(app: &AppHandle<R>) -> Option<ConnSnapshot> {
    let cfg_path = super::commands::config_path(app).await.ok()?;
    let cfg = super::config::read_config(&crate::vault_io::StdVaultIo, &cfg_path)
        .await
        .ok()?;
    let url = cfg.endpoint_url.clone()?;
    let state = app.try_state::<crate::plugins::vault_unlock::state::VaultRuntimeState>()?;
    let dir = crate::paths::active_vault_root_io(app, state.active_vault_id().await).ok()?;
    let token = super::token_store::default_store()
        .read(&crate::vault_io::StdVaultIo, &dir)
        .await
        .ok()
        .flatten()?;
    let mut token_hex = String::with_capacity(token.len() * 2);
    for b in &token {
        token_hex.push_str(&format!("{b:02x}"));
    }
    Some(ConnSnapshot { url, token_hex })
}

struct WorkerHandle {
    stop: Arc<AtomicBool>,
    sock: Arc<Mutex<Option<std::net::TcpStream>>>,
    unauth: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
    identity: StreamIdentity,
}

/// Signal the worker to stop and unblock its read; join it off-thread so a
/// worker mid-`connect()` can never stall the supervisor tick.
fn teardown(w: Option<WorkerHandle>) {
    let Some(mut w) = w else { return };
    w.stop.store(true, Ordering::Relaxed);
    if let Ok(mut slot) = w.sock.lock() {
        if let Some(s) = slot.take() {
            let _ = s.shutdown(std::net::Shutdown::Both);
        }
    }
    if let Some(join) = w.join.take() {
        tauri::async_runtime::spawn_blocking(move || {
            let _ = join.join();
        });
    }
}

fn spawn_worker(
    snap: ConnSnapshot,
    identity: StreamIdentity,
    signal: SsePokeSignal,
) -> WorkerHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let sock: Arc<Mutex<Option<std::net::TcpStream>>> = Arc::new(Mutex::new(None));
    let unauth = Arc::new(AtomicBool::new(false));
    let (stop2, sock2, unauth2) = (stop.clone(), sock.clone(), unauth.clone());
    let join = std::thread::Builder::new()
        .name("myne-sse".into())
        .spawn(move || worker_main(snap, stop2, sock2, unauth2, signal))
        .ok();
    WorkerHandle {
        stop,
        sock,
        unauth,
        join,
        identity,
    }
}

/// Spawn the poke supervisor (wired in both hosts' setup, right after
/// `spawn_sync_loop`). Owns the worker lifecycle; holds no vault secrets — the
/// snapshot is `(url, token)`, all device-local transport material.
pub fn spawn_poke_supervisor<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut worker: Option<WorkerHandle> = None;
        let mut parked: Option<u64> = None;
        let mut snapshot: Option<ConnSnapshot> = None;
        let mut refresh_in = 0u32;
        let mut ticker = tokio::time::interval(Duration::from_millis(SUPERVISOR_TICK_MS));
        loop {
            ticker.tick().await;

            let unlocked =
                match app.try_state::<crate::plugins::vault_unlock::state::VaultRuntimeState>() {
                    Some(s) => s.active_vault_id().await.is_some(),
                    None => false,
                };
            let suspended = app
                .try_state::<super::loop_control::SyncLifecycleSignal>()
                .map(|s| s.is_suspended())
                .unwrap_or(false);

            if refresh_in == 0 {
                snapshot = if unlocked {
                    gather_snapshot(&app).await
                } else {
                    None
                };
                refresh_in = SNAPSHOT_REFRESH_TICKS;
            }
            refresh_in -= 1;

            // A worker that exited on 401 parks this (endpoint, token) identity
            // — no reconnect spinning on a revoked token. A different identity
            // (re-enroll, endpoint change) un-parks. Keyed on the snapshot
            // fingerprint alone: a revoked token is revoked over every route.
            if let Some(w) = &worker {
                if w.unauth.load(Ordering::Relaxed) {
                    parked = Some(w.identity.fingerprint);
                    teardown(worker.take());
                }
            }
            let fp = snapshot.as_ref().map(fingerprint_of);
            if parked.is_some() && parked != fp {
                parked = None;
            }

            // The route term is re-read here, on EVERY tick — it is an
            // in-memory cell, and it is what a Tor toggle moves under a stream
            // that is otherwise healthy enough never to time out.
            let wanted = if unlocked && !suspended && parked.is_none() {
                snapshot.as_ref().and_then(stream_identity)
            } else {
                None
            };
            match decide(worker.as_ref().map(|w| w.identity), wanted) {
                Decision::Spawn => {
                    let snap = snapshot
                        .clone()
                        .expect("a wanted identity implies a snapshot");
                    let identity = wanted.expect("Spawn implies a wanted identity");
                    let Some(signal) = app.try_state::<SsePokeSignal>() else {
                        continue; // host manages no signal — nothing to drive
                    };
                    worker = Some(spawn_worker(snap, identity, signal.inner().clone()));
                }
                Decision::Teardown => teardown(worker.take()),
                Decision::Idle => {}
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Worker: connect → drain events → reconnect with backoff.
// ---------------------------------------------------------------------------

enum StreamExit {
    /// 401 — park, do not reconnect.
    Unauthorized,
    /// The stream delivered bytes before dying — reset the backoff.
    GotData,
    /// Connect/open failed or the stream died silently — back off.
    Failed,
    /// The stop flag ended the stream — exit the worker.
    Stopped,
}

fn worker_main(
    snap: ConnSnapshot,
    stop: Arc<AtomicBool>,
    sock_slot: Arc<Mutex<Option<std::net::TcpStream>>>,
    unauth: Arc<AtomicBool>,
    signal: SsePokeSignal,
) {
    let mut backoff = Backoff::new();
    while !stop.load(Ordering::Relaxed) {
        match connect_and_stream(&snap, &stop, &sock_slot, &signal) {
            StreamExit::Unauthorized => {
                unauth.store(true, Ordering::Relaxed);
                return;
            }
            StreamExit::Stopped => return,
            StreamExit::GotData => backoff.reset(),
            StreamExit::Failed => {}
        }
        sleep_interruptible(Duration::from_millis(backoff.next_jittered()), &stop);
    }
}

fn connect_and_stream(
    snap: &ConnSnapshot,
    stop: &AtomicBool,
    sock_slot: &Mutex<Option<std::net::TcpStream>>,
    signal: &SsePokeSignal,
) -> StreamExit {
    // Fresh transport per connection, byte-identical TLS semantics to the sync
    // cycles (`build_transport` is the single factory).
    let Ok(transport) = super::http_transport::build_transport(&snap.url) else {
        return StreamExit::Failed;
    };
    let SseStream {
        reader,
        chunked,
        socket,
    } = match transport.open_sse("/sync/poke", &snap.token_hex, SSE_READ_TIMEOUT) {
        Ok(s) => s,
        Err(SseOpenError::Unauthorized) => return StreamExit::Unauthorized,
        Err(_) => return StreamExit::Failed,
    };
    if let Ok(mut slot) = sock_slot.lock() {
        *slot = Some(socket);
    }
    // Close the teardown race: if stop flipped while we were connecting, the
    // supervisor's shutdown may have missed the socket we just stored.
    if stop.load(Ordering::Relaxed) {
        if let Ok(mut slot) = sock_slot.lock() {
            if let Some(s) = slot.take() {
                let _ = s.shutdown(std::net::Shutdown::Both);
            }
        }
        return StreamExit::Stopped;
    }

    // Catch-up pull: pokes sent while we were disconnected are unobservable —
    // one bump now closes that gap (and covers the first connect after unlock,
    // coalescing with the unlock-edge arm in the scheduler).
    signal.bump();

    let got_data = drain_stream(reader, chunked, stop, signal);

    if let Ok(mut slot) = sock_slot.lock() {
        slot.take();
    }
    if stop.load(Ordering::Relaxed) {
        return StreamExit::Stopped;
    }
    if got_data {
        StreamExit::GotData
    } else {
        StreamExit::Failed
    }
}

/// Read SSE lines until EOF/timeout/stop. Only two shapes matter: a line
/// starting with `data` is a poke (bump), a line starting with `:` is the
/// server heartbeat (liveness only). Returns whether ANY bytes arrived (the
/// backoff-reset signal). No full SSE parser — the wire carries exactly
/// `data:\n\n` events and `:hb\n\n` comments, both zero-information beyond
/// their arrival.
pub(crate) fn drain_stream(
    reader: Box<dyn BufRead + Send>,
    chunked: bool,
    stop: &AtomicBool,
    signal: &SsePokeSignal,
) -> bool {
    let mut reader: Box<dyn BufRead + Send> = if chunked {
        Box::new(std::io::BufReader::new(ChunkedFrames {
            inner: reader,
            left: 0,
            done: false,
        }))
    } else {
        reader
    };
    let mut got_data = false;
    let mut line = Vec::new();
    loop {
        if stop.load(Ordering::Relaxed) {
            return got_data;
        }
        line.clear();
        match reader.read_until(b'\n', &mut line) {
            Ok(0) => return got_data, // clean EOF — server closed
            Ok(_) => {
                got_data = true;
                if line.starts_with(b"data") {
                    signal.bump();
                }
                // ':'-comment heartbeats and blank dispatch lines: liveness only.
            }
            // Read-timeout (dead connection), shutdown, or socket error.
            Err(_) => return got_data,
        }
    }
}

/// De-frame `Transfer-Encoding: chunked` bytes into the raw SSE byte stream
/// (production sits behind a reverse proxy that streams SSE chunked). Chunk
/// extensions are ignored; the zero chunk ends the stream. The CRLF trailing
/// each chunk's data surfaces as an empty size-line and is skipped.
struct ChunkedFrames {
    inner: Box<dyn BufRead + Send>,
    left: u64,
    done: bool,
}

impl Read for ChunkedFrames {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        fn inval() -> std::io::Error {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "sse chunk framing")
        }
        loop {
            if self.done || buf.is_empty() {
                return Ok(0);
            }
            if self.left == 0 {
                let mut line = Vec::new();
                let n = self.inner.read_until(b'\n', &mut line)?;
                if n == 0 {
                    self.done = true;
                    return Ok(0);
                }
                let s = std::str::from_utf8(&line).map_err(|_| inval())?.trim();
                if s.is_empty() {
                    continue; // the CRLF trailing the previous chunk's data
                }
                let size = u64::from_str_radix(s.split(';').next().unwrap_or(""), 16)
                    .map_err(|_| inval())?;
                if size == 0 {
                    self.done = true;
                    return Ok(0);
                }
                self.left = size;
            }
            let want = buf.len().min(self.left as usize);
            let n = self.inner.read(&mut buf[..want])?;
            self.left -= n as u64;
            return Ok(n);
        }
    }
}

/// Jittered exponential reconnect backoff: base doubles 1 s → 60 s cap, each
/// delay lands in `[base·0.75, base·1.25]`. The jitter source is a cheap
/// xorshift* seeded from wall-clock nanos — decorrelation only, NEVER key
/// material.
struct Backoff {
    next_ms: u64,
    seed: u64,
}

impl Backoff {
    fn new() -> Self {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos() as u64)
            .unwrap_or(0)
            | 1; // xorshift must not start at 0
        Self {
            next_ms: BACKOFF_START_MS,
            seed,
        }
    }

    fn reset(&mut self) {
        self.next_ms = BACKOFF_START_MS;
    }

    fn next_jittered(&mut self) -> u64 {
        let base = self.next_ms;
        self.next_ms = (self.next_ms * 2).min(BACKOFF_CAP_MS);
        self.seed ^= self.seed << 13;
        self.seed ^= self.seed >> 7;
        self.seed ^= self.seed << 17;
        let span = base / 2; // total jitter window = ±25% of base
        let jitter = if span == 0 { 0 } else { self.seed % (span + 1) };
        base - base / 4 + jitter
    }
}

fn sleep_interruptible(total: Duration, stop: &AtomicBool) {
    let slice = Duration::from_millis(250);
    let mut remaining = total;
    while !stop.load(Ordering::Relaxed) && remaining > Duration::ZERO {
        let d = remaining.min(slice);
        std::thread::sleep(d);
        remaining = remaining.saturating_sub(d);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn backoff_doubles_to_cap_with_bounded_jitter() {
        let mut b = Backoff::new();
        let mut base = BACKOFF_START_MS;
        for _ in 0..10 {
            let d = b.next_jittered();
            assert!(
                d >= base - base / 4 && d <= base + base / 4,
                "delay {d} outside ±25% of base {base}"
            );
            base = (base * 2).min(BACKOFF_CAP_MS);
        }
        assert_eq!(base, BACKOFF_CAP_MS, "base saturated at the cap");
        b.reset();
        let d = b.next_jittered();
        assert!(
            d <= BACKOFF_START_MS + BACKOFF_START_MS / 4,
            "reset re-arms the start value"
        );
    }

    // --- the worker's connection identity (MYND-650) -----------------------

    fn snap(url: &str) -> ConnSnapshot {
        ConnSnapshot {
            url: url.to_string(),
            token_hex: "deadbeef".into(),
        }
    }

    /// The identity carries the route, so a gate that moves under a live
    /// stream is a *different* stream. This is the whole fix: `SSE_READ_TIMEOUT`
    /// sits above the server heartbeat, so a healthy direct connection would
    /// otherwise outlive the toggle that was supposed to tunnel it.
    #[test]
    fn a_moved_route_is_a_different_stream_identity() {
        let s = snap("https://sync.myne.md");
        let direct = StreamIdentity {
            fingerprint: fingerprint_of(&s),
            route: Route::Direct,
        };
        let tunneled = StreamIdentity {
            route: Route::Socks5 { socks_port: 9150 },
            ..direct
        };
        assert_ne!(direct, tunneled, "the route is part of the identity");
        assert_eq!(
            decide(Some(direct), Some(tunneled)),
            Decision::Teardown,
            "a live direct stream must be dropped the moment the gate says Socks5"
        );
        assert_eq!(
            decide(Some(tunneled), Some(tunneled)),
            Decision::Idle,
            "an unchanged identity keeps its stream"
        );
    }

    /// A refusing gate yields no identity at all — with Tor mode on and the
    /// tunnel unusable there is no stream, which is the same fail-closed answer
    /// `ProxyGate::route` gives the sync cycle.
    #[test]
    fn a_refusing_gate_yields_no_stream() {
        let live = StreamIdentity {
            fingerprint: 1,
            route: Route::Direct,
        };
        assert_eq!(decide(Some(live), None), Decision::Teardown);
        assert_eq!(decide(None, None), Decision::Idle);
        assert_eq!(decide(None, Some(live)), Decision::Spawn);
    }

    /// No gate is installed in this crate's test binary, so the read-back is the
    /// default (Tor mode off) and every endpoint routes `Direct` — which is what
    /// keeps the listener's behaviour unchanged for every install that never
    /// touches the toggle. An endpoint that does not parse yields nothing rather
    /// than a worker that would reconnect-spin on `build_transport`.
    #[test]
    fn identity_is_direct_by_default_and_absent_for_an_unparseable_endpoint() {
        let s = snap("https://sync.myne.md");
        assert_eq!(
            stream_identity(&s),
            Some(StreamIdentity {
                fingerprint: fingerprint_of(&s),
                route: Route::Direct,
            })
        );
        assert_eq!(stream_identity(&snap("not a url")), None);
    }

    /// The gate is the thing that moves, so drive a **real** one through the
    /// lifecycle a toggle actually produces — off → on before the sidecar is up
    /// → bootstrapping → ready → died → off — and assert the supervisor's
    /// decision at every step. The tests above it reason about identities the
    /// test built by hand; this one reasons about the object the transport
    /// obeys, which is where the Critical lived.
    #[test]
    fn a_real_gate_walked_through_the_toggle_lifecycle_drives_the_decisions() {
        use super::proxy::{ProxyGate, TorProxyState};

        let s = snap("https://sync.myne.md");
        let gate = ProxyGate::new();

        // Tor mode off — today's client, and a healthy direct stream.
        let direct = stream_identity_over(&s, &gate).expect("a direct stream exists");
        assert_eq!(direct.route, Route::Direct);

        // The user flips the toggle. `sync_set_tor_routing` closes the gate
        // BEFORE spawning arti, so from this instant the gate refuses — and the
        // live direct stream, which would otherwise never time out, must go.
        gate.set_enabled(true);
        assert_eq!(
            stream_identity_over(&s, &gate),
            None,
            "a gate that refuses yields no stream at all"
        );
        assert_eq!(
            decide(Some(direct), stream_identity_over(&s, &gate)),
            Decision::Teardown,
            "the direct stream opened before the toggle must be dropped"
        );

        gate.set_state(TorProxyState::Starting);
        assert_eq!(
            stream_identity_over(&s, &gate),
            None,
            "sync is paused while the tunnel bootstraps, and so is the stream"
        );

        // Bootstrap completes: a stream may exist again, and it is a DIFFERENT
        // one — which is what makes the supervisor reconnect through
        // `build_transport` instead of reusing the direct socket.
        gate.set_state(TorProxyState::Ready { socks_port: 9150 });
        let tunneled = stream_identity_over(&s, &gate).expect("a tunneled stream exists");
        assert_eq!(tunneled.route, Route::Socks5 { socks_port: 9150 });
        assert_ne!(tunneled, direct);
        assert_eq!(decide(None, Some(tunneled)), Decision::Spawn);
        assert_eq!(decide(Some(tunneled), Some(tunneled)), Decision::Idle);

        // The sidecar dies under a live tunneled stream: fail-closed again.
        gate.set_state(TorProxyState::Failed);
        assert_eq!(
            decide(Some(tunneled), stream_identity_over(&s, &gate)),
            Decision::Teardown,
            "a dead Tor client must not leave a stream behind"
        );

        // Toggled back off: direct again, and the identity is the original —
        // the route term adds an axis, it does not rewrite the old one.
        gate.set_enabled(false);
        assert_eq!(stream_identity_over(&s, &gate), Some(direct));
    }

    /// A `Decision::Teardown` is only worth anything if it actually kills the
    /// stream. So this drives the whole back half against a **live** SSE
    /// connection: a real loopback server, a real `open_sse`, a real
    /// `drain_stream` blocked on read with the production
    /// [`SSE_READ_TIMEOUT`] — the timeout that sits deliberately above the
    /// server's heartbeat cadence, which is exactly why a healthy direct stream
    /// would otherwise outlive the toggle meant to tunnel it — and then the
    /// real [`teardown`] the supervisor calls.
    ///
    /// `shutdown_unblocks_a_blocking_drain` below asserts that *a* shutdown
    /// unblocks the drain; this asserts that `teardown` is what performs one, so
    /// there is no gap between the decision and the dead socket.
    ///
    /// `join: None` rather than the worker's handle: the off-thread join is a
    /// scheduling detail (it keeps a worker mid-`connect()` from stalling the
    /// supervisor tick), and joining the drain here observes the same exit
    /// directly rather than through `tauri::async_runtime`.
    #[test]
    fn teardown_kills_a_live_sse_stream_under_the_production_read_timeout() {
        use super::super::transport::SyncTransport;

        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = listener.local_addr().expect("local addr").port();
        std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().expect("accept");
            let mut buf = [0u8; 2048];
            let _ = sock.read(&mut buf);
            let _ = sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n");
            // Then healthy and silent, holding the connection open — the state a
            // real poke stream spends nearly all of its life in.
            std::thread::sleep(Duration::from_secs(5));
        });

        let stream = super::super::http_transport::HttpTransport::new("127.0.0.1", port)
            .open_sse("/sync/poke", "tok", SSE_READ_TIMEOUT)
            .expect("open_sse");
        let sock = Arc::new(Mutex::new(Some(
            stream.socket.try_clone().expect("clone socket"),
        )));
        let stop = Arc::new(AtomicBool::new(false));

        let stop_in_worker = stop.clone();
        let drain = std::thread::spawn(move || {
            let signal = SsePokeSignal::default();
            drain_stream(stream.reader, stream.chunked, &stop_in_worker, &signal)
        });
        // Let the drain reach its blocking read before the gate moves under it.
        std::thread::sleep(Duration::from_millis(150));

        let started = std::time::Instant::now();
        teardown(Some(WorkerHandle {
            stop: stop.clone(),
            sock,
            unauth: Arc::new(AtomicBool::new(false)),
            join: None,
            identity: StreamIdentity {
                fingerprint: 0,
                route: Route::Direct,
            },
        }));
        drain.join().expect("drain thread");

        assert!(
            started.elapsed() < Duration::from_secs(3),
            "teardown must end the stream in milliseconds. It returned only after \
             {:?}, which means the socket outlived the decision — and a stream \
             opened before the routing gate moved is precisely the one that must \
             not.",
            started.elapsed()
        );
        assert!(
            stop.load(Ordering::Relaxed),
            "the worker is told to stop as well as having its socket pulled — the \
             flag is what keeps it from reconnecting on its way out"
        );
    }

    /// Endpoint/token rotation still tears the stream down — the pre-existing
    /// behaviour the route term is layered on top of, not a replacement for.
    #[test]
    fn a_rotated_endpoint_or_token_is_still_a_different_stream() {
        let a = stream_identity(&snap("https://sync.myne.md")).expect("identity");
        let b = stream_identity(&snap("https://other.example")).expect("identity");
        assert_ne!(a, b);
        assert_eq!(decide(Some(a), Some(b)), Decision::Teardown);
    }

    #[test]
    fn chunked_frames_deframe_and_skip_trailing_crlf() {
        // Two chunks carrying an SSE poke + heartbeat, then the zero chunk.
        let wire = b"7\r\ndata:\n\n\r\n4\r\n:hb\n\r\n0\r\n\r\n";
        let mut r = ChunkedFrames {
            inner: Box::new(std::io::Cursor::new(&wire[..])),
            left: 0,
            done: false,
        };
        let mut out = Vec::new();
        r.read_to_end(&mut out).unwrap();
        assert_eq!(out, b"data:\n\n:hb\n");
    }

    #[test]
    fn drain_counts_pokes_and_ignores_heartbeats() {
        let signal = SsePokeSignal::default();
        let stop = AtomicBool::new(false);
        let stream: &[u8] = b":hb\n\ndata:\n\n:hb\n\ndata:\n\n";
        let got = drain_stream(
            Box::new(std::io::Cursor::new(stream)),
            false,
            &stop,
            &signal,
        );
        assert!(got, "bytes flowed");
        assert_eq!(signal.get(), 2, "exactly the two data events bumped");
    }

    #[test]
    fn drain_over_chunked_wire() {
        let signal = SsePokeSignal::default();
        let stop = AtomicBool::new(false);
        let wire = b"4\r\n:hb\n\r\n7\r\ndata:\n\n\r\n0\r\n\r\n";
        let got = drain_stream(
            Box::new(std::io::Cursor::new(&wire[..])),
            true,
            &stop,
            &signal,
        );
        assert!(got);
        assert_eq!(signal.get(), 1);
    }

    // --- loopback: open_sse over the plain-HTTP transport -------------------

    #[test]
    fn open_sse_streams_events_over_loopback() {
        use super::super::transport::SyncTransport;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let n = sock.read(&mut buf).unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
            sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
                .unwrap();
            sock.write_all(b":hb\n\ndata:\n\ndata:\n\n").unwrap();
            // close → clean EOF ends the drain
            req
        });

        let t = super::super::http_transport::HttpTransport::new("127.0.0.1", port);
        let stream = t
            .open_sse("/sync/poke", "tok", Duration::from_secs(2))
            .expect("open_sse");
        assert!(!stream.chunked);
        let signal = SsePokeSignal::default();
        let stop = AtomicBool::new(false);
        let got = drain_stream(stream.reader, stream.chunked, &stop, &signal);
        assert!(got);
        assert_eq!(signal.get(), 2, "both pokes delivered");
        let req = handle.join().unwrap();
        assert!(req.contains("GET /sync/poke HTTP/1.1"));
        assert!(req.contains("Authorization: Bearer tok"));
        assert!(req.contains("Accept: text/event-stream"));
    }

    #[test]
    fn open_sse_maps_401_to_unauthorized() {
        use super::super::transport::SyncTransport;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let _ = sock.read(&mut buf);
            let _ = sock.write_all(b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
        });
        let t = super::super::http_transport::HttpTransport::new("127.0.0.1", port);
        match t.open_sse("/sync/poke", "tok", Duration::from_secs(2)) {
            Err(SseOpenError::Unauthorized) => {}
            Err(e) => panic!("expected Unauthorized, got {e:?}"),
            Ok(_) => panic!("expected Unauthorized, got a live stream"),
        }
    }

    #[test]
    fn shutdown_unblocks_a_blocking_drain() {
        use super::super::transport::SyncTransport;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            let mut buf = [0u8; 2048];
            let _ = sock.read(&mut buf);
            let _ = sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n");
            // ... then go silent, keeping the connection open.
            std::thread::sleep(Duration::from_secs(5));
        });
        let t = super::super::http_transport::HttpTransport::new("127.0.0.1", port);
        let stream = t
            .open_sse("/sync/poke", "tok", Duration::from_secs(30))
            .expect("open_sse");
        let socket = stream.socket.try_clone().unwrap();
        let signal = SsePokeSignal::default();
        let stop = AtomicBool::new(false);
        // Shut the socket down shortly after the drain blocks on read.
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            let _ = socket.shutdown(std::net::Shutdown::Both);
        });
        let started = std::time::Instant::now();
        let _ = drain_stream(stream.reader, stream.chunked, &stop, &signal);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "shutdown must unblock the read (teardown latency is ms, not the read timeout)"
        );
    }
}
