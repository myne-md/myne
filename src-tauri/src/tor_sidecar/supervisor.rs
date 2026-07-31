//! The arti sidecar's process supervisor: spawn, gate on bootstrap, watch,
//! terminate.
//!
//! One [`TorSidecar`] lives for the process lifetime as Tauri managed state.
//! It owns at most one `myne-tor` child and publishes what it observes into the
//! shared [`ProxyGate`] the sync transport reads (tasks 3/4).
//!
//! ## Shape
//!
//! [`TorSidecar::start`] returns as soon as the child exists — a 30-second
//! bootstrap awaited on the IPC thread would freeze the window — and hands off
//! to two background threads per run:
//!
//! * the **reader** drains the child's stderr, classifies each line
//!   ([`super::arti_cli::is_bootstrap_line`]) and, on the bootstrap marker, probes
//!   the SOCKS listener before publishing `Ready`. EOF on that pipe means the
//!   process is gone, so the same thread reaps the child and reports
//!   `ChildExited` — no separate reaper, no polling.
//! * the **deadline** thread turns "bootstrap never finished" into a `Failed`
//!   the UI can render, instead of a `Starting` that hangs forever.
//!
//! Every observation goes through [`transition`], so the rules about which
//! exits are failures live in one table with its own tests.
//!
//! ## Not an orphan
//!
//! Three layers, because a Tor client left running after the app quits is both
//! a resource leak and a privacy signal (circuits outliving the session):
//! [`TorSidecar::stop`] on the toggle, `stop` from the app's exit handler, and
//! `Drop`. On Linux a fourth — `PR_SET_PDEATHSIG` — covers the one case none of
//! those can: the app itself being `SIGKILL`ed.
//!
//! ## Logging
//!
//! Only bare phase names are ever logged. arti's own stderr is classified and
//! dropped, never mirrored: it names the hosts being connected to, which is
//! precisely what Tor mode exists to keep out of observable places
//! (`src-tauri/CLAUDE.md` secret-handling discipline).

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::time::{Duration, Instant};

use myne_core::plugins::sync::proxy::{ProxyGate, TorProxyState};
use myne_core::plugins::sync::socks5;

use super::arti_cli::{arti_argv, arti_config_toml, is_bootstrap_line};
use super::lifecycle::{transition, Event, Phase};

/// How long a bootstrap may take before the sidecar is declared failed. arti's
/// own range is 5–30s on a warm cache; 120s leaves room for a first launch on a
/// slow link without leaving the user staring at "connecting" indefinitely.
const BOOTSTRAP_DEADLINE: Duration = Duration::from_secs(120);

/// How often the deadline thread wakes to notice its run was superseded, so a
/// stopped or already-bootstrapped run does not leave a thread sleeping out the
/// remaining minutes of [`BOOTSTRAP_DEADLINE`].
const DEADLINE_TICK: Duration = Duration::from_millis(250);

/// Timeout for the loopback SOCKS5 method-negotiation probe. Loopback: a
/// listener that cannot answer three bytes in a second is not answering.
const PROBE_TIMEOUT: Duration = Duration::from_secs(1);

/// How long to wait for a killed child to actually die. Bounded because this
/// runs on the app-exit path, where a wedged `wait()` would hold the process
/// open with its window already gone.
const REAP_TIMEOUT: Duration = Duration::from_secs(5);

/// Why the sidecar could not be started.
///
/// No `String` and no path: this reaches the UI (task 8), where a filesystem
/// path would be a disclosure (`src-tauri/CLAUDE.md` DENY list). `Serialize` is
/// what lets the task-6 toggle command report *why* a spawn failed without
/// re-describing these four cases in a second enum; every variant is a unit, so
/// the wire form is the bare variant name and there is no payload that could
/// carry a path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum StartError {
    /// No `myne-tor` beside the running executable — a dev build that never
    /// ran `pnpm sidecar`, or a broken bundle.
    SidecarMissing,
    /// The Tor state/cache directory or the generated config could not be
    /// written.
    StateDirUnwritable,
    /// No loopback port could be reserved.
    NoPort,
    /// `spawn` itself failed (no exec permission, wrong architecture, …).
    SpawnFailed,
}

/// The supervisor. Held in an `Arc` (Tauri managed state); all handles share
/// one child.
pub struct TorSidecar {
    gate: ProxyGate,
    inner: Mutex<Inner>,
    /// Bumped on every start and stop. Each background thread carries the
    /// generation it was spawned with and drops any observation from an older
    /// run, so a slow bootstrap from a previous attempt can never publish
    /// `Ready` over a newer one.
    generation: AtomicU64,
}

struct Inner {
    phase: Phase,
    child: Option<Child>,
    socks_port: Option<u16>,
}

impl TorSidecar {
    /// A stopped supervisor sharing `gate` with the sync transport.
    pub fn new(gate: ProxyGate) -> Self {
        Self {
            gate,
            inner: Mutex::new(Inner {
                phase: Phase::Stopped,
                child: None,
                socks_port: None,
            }),
            generation: AtomicU64::new(0),
        }
    }

    /// The gate the transport reads. Test-only: production hands the gate to
    /// `proxy::install` and to `app.manage` from `lib.rs`, which owns the one it
    /// constructed — nothing has to ask the supervisor for it back.
    #[cfg(test)]
    pub fn gate(&self) -> ProxyGate {
        self.gate.clone()
    }

    /// Current phase — what the UI renders (task 8).
    pub fn phase(&self) -> Phase {
        self.lock().phase
    }

    /// Start the sidecar, or do nothing if it is already starting or ready.
    ///
    /// `exe_dir` is the directory the running executable sits in, which is
    /// where Tauri places an `externalBin`. `app_data_dir` is the app-data
    /// root; the Tor state lives in a `tor/` subdirectory of it — vault-
    /// agnostic on purpose, since network posture is a property of the device
    /// rather than of a vault.
    ///
    /// The caller learns about readiness through the gate, never by blocking
    /// here.
    pub fn start(self: &Arc<Self>, exe_dir: &Path, app_data_dir: &Path) -> Result<(), StartError> {
        let Some(port) = pick_loopback_port() else {
            self.fail();
            return Err(StartError::NoPort);
        };
        self.start_on_port(exe_dir, app_data_dir, port)
    }

    /// [`Self::start`] with the loopback port chosen by the caller. Split out
    /// so tests can own the SOCKS listener the probe talks to.
    fn start_on_port(
        self: &Arc<Self>,
        exe_dir: &Path,
        app_data_dir: &Path,
        port: u16,
    ) -> Result<(), StartError> {
        let mut inner = self.lock();
        if matches!(inner.phase, Phase::Starting | Phase::Ready) {
            return Ok(());
        }

        let exe = sidecar_path(exe_dir);
        if !exe.is_file() {
            self.apply(&mut inner, Event::SpawnFailed);
            return Err(StartError::SidecarMissing);
        }

        let config_file = match prepare_tor_dir(&app_data_dir.join("tor")) {
            Ok(path) => path,
            Err(()) => {
                self.apply(&mut inner, Event::SpawnFailed);
                return Err(StartError::StateDirUnwritable);
            }
        };

        // Claim the run before the child exists, so a stop() racing the spawn
        // supersedes it rather than losing to it.
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        inner.socks_port = Some(port);
        self.apply(&mut inner, Event::StartRequested);

        let mut child = match spawn_sidecar(&exe, &config_file, port) {
            Ok(child) => child,
            Err(()) => {
                inner.socks_port = None;
                self.apply(&mut inner, Event::SpawnFailed);
                return Err(StartError::SpawnFailed);
            }
        };

        let stderr = child.stderr.take();
        inner.child = Some(child);
        self.apply(&mut inner, Event::Spawned);
        drop(inner);

        if let Some(stderr) = stderr {
            self.spawn_reader(generation, port, stderr);
        }
        self.spawn_deadline(generation);
        Ok(())
    }

    /// Terminate the sidecar and return the transport to `Stopped`. Idempotent
    /// — the toggle, the app-exit handler and `Drop` all call it.
    pub fn stop(&self) {
        // Bump first: any thread still in flight belongs to the old run and
        // must not publish over this stop.
        self.generation.fetch_add(1, Ordering::SeqCst);
        let mut inner = self.lock();
        self.apply(&mut inner, Event::StopRequested);
        inner.socks_port = None;
        if let Some(mut child) = inner.child.take() {
            kill_and_reap(&mut child);
        }
    }

    /// Publish a `Failed` phase for a start that never reached a child.
    fn fail(&self) {
        let mut inner = self.lock();
        self.apply(&mut inner, Event::SpawnFailed);
    }

    /// Observe an event from a background thread, ignoring it if it belongs to
    /// a superseded run.
    fn observe(&self, generation: u64, event: Event) {
        let mut inner = self.lock();
        if self.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        self.apply(&mut inner, event);
    }

    /// Apply an event to the phase and republish the gate — the single place
    /// the supervisor's state and the transport's view of it can change, so
    /// they cannot disagree.
    fn apply(&self, inner: &mut Inner, event: Event) {
        let next = transition(inner.phase, event);
        if next == inner.phase {
            return;
        }
        inner.phase = next;
        let state = match next {
            Phase::Starting => TorProxyState::Starting,
            Phase::Ready => match inner.socks_port {
                Some(socks_port) => TorProxyState::Ready { socks_port },
                // Unreachable in practice (the port is set before the child
                // spawns); failing closed beats publishing a route to port 0.
                None => TorProxyState::Failed,
            },
            Phase::Failed => TorProxyState::Failed,
            Phase::Stopped => TorProxyState::Stopped,
        };
        self.gate.set_state(state);
        tracing::info!(event = "tor_sidecar_phase", phase = ?next);
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Drain arti's stderr: classify, gate on the bootstrap marker, and treat
    /// EOF as "the process is gone".
    fn spawn_reader(
        self: &Arc<Self>,
        generation: u64,
        port: u16,
        stderr: impl Read + Send + 'static,
    ) {
        // `Weak`, not `Arc`: an owning handle here would keep the supervisor —
        // and therefore its child — alive for as long as the thread runs, and
        // this thread runs until the child exits. `Drop` would then never fire,
        // which is exactly the app-quit teardown it is supposed to be.
        let this = Arc::downgrade(self);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if !is_bootstrap_line(&line) {
                    continue;
                }
                let Some(this) = this.upgrade() else { return };
                // arti says the circuit machinery is up; the probe says the
                // listener we are about to hand the transport actually answers
                // SOCKS5. Both, because either alone has been the wrong
                // answer — the log line is emitted before any client has ever
                // connected, and a bound-but-wedged listener would pass a bare
                // TCP connect.
                let event = if socks5_greeting_ok(port) {
                    Event::BootstrapConfirmed
                } else {
                    Event::BootstrapTimedOut
                };
                this.observe(generation, event);
            }
            // EOF on stderr: the child closed its pipes, i.e. it exited.
            if let Some(this) = this.upgrade() {
                this.reap_current(generation);
            }
        });
    }

    /// Fail the run if bootstrap has not completed inside the deadline.
    fn spawn_deadline(self: &Arc<Self>, generation: u64) {
        // `Weak` for the same reason as the reader — and here it also stops a
        // quit during bootstrap from holding the supervisor alive for the full
        // two minutes of the deadline.
        let this: Weak<Self> = Arc::downgrade(self);
        std::thread::spawn(move || {
            // Sliced rather than one 120 s sleep: a toggle-off, a bootstrap
            // completing, or a sidecar dying all supersede this run within
            // milliseconds, and a thread that keeps sleeping for two minutes
            // afterwards is a thread per toggle. Bounded and harmless either
            // way — the generation check below makes a late wake a no-op — but
            // a user flipping the switch a few times should not accumulate
            // them.
            let deadline = Instant::now() + BOOTSTRAP_DEADLINE;
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                std::thread::sleep(remaining.min(DEADLINE_TICK));
                match this.upgrade() {
                    // Superseded (stopped, restarted) or already resolved:
                    // there is nothing left for this run's deadline to say.
                    Some(s)
                        if s.generation.load(Ordering::SeqCst) != generation
                            || s.phase() != Phase::Starting =>
                    {
                        return
                    }
                    Some(_) => {}
                    None => return,
                }
            }
            let Some(this) = this.upgrade() else { return };
            if this.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            if this.phase() != Phase::Starting {
                return;
            }
            this.observe(generation, Event::BootstrapTimedOut);
            // A sidecar that never bootstrapped is not going to; leave no
            // process behind waiting on it.
            this.kill_current(generation);
        });
    }

    /// Reap the child of `generation` and report its exit.
    fn reap_current(&self, generation: u64) {
        {
            let mut inner = self.lock();
            if self.generation.load(Ordering::SeqCst) != generation {
                return;
            }
            if let Some(mut child) = inner.child.take() {
                reap(&mut child);
            }
        }
        self.observe(generation, Event::ChildExited);
    }

    /// Kill the child of `generation`, leaving the phase alone (the caller has
    /// already published one).
    fn kill_current(&self, generation: u64) {
        let mut inner = self.lock();
        if self.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Some(mut child) = inner.child.take() {
            kill_and_reap(&mut child);
        }
    }
}

impl Drop for TorSidecar {
    fn drop(&mut self) {
        // Not routed through `stop()`: `&mut self` means no other handle
        // exists and the phase no longer matters. Killing is the whole job.
        if let Some(mut child) = self.lock().child.take() {
            kill_and_reap(&mut child);
        }
    }
}

/// `myne-tor` beside the running executable — exactly where Tauri places an
/// `externalBin`, and the same resolution `cli_bridge::path_shim` uses for the
/// `myne` CLI sidecar.
pub fn sidecar_path(exe_dir: &Path) -> PathBuf {
    exe_dir.join(if cfg!(windows) {
        "myne-tor.exe"
    } else {
        "myne-tor"
    })
}

/// Create `<tor_dir>/{state,cache}`, write the config, return the config path.
///
/// The directories are owner-only on Unix: arti's own `fs-mistrust` refuses to
/// use a state directory others can write, and it is right to.
fn prepare_tor_dir(tor_dir: &Path) -> Result<PathBuf, ()> {
    let state = tor_dir.join("state");
    let cache = tor_dir.join("cache");
    for dir in [tor_dir, &state, &cache] {
        std::fs::create_dir_all(dir).map_err(|_| ())?;
        restrict_to_owner(dir);
    }
    let config_file = tor_dir.join("arti.toml");
    std::fs::File::create(&config_file)
        .and_then(|mut f| f.write_all(arti_config_toml(&state, &cache).as_bytes()))
        .map_err(|_| ())?;
    Ok(config_file)
}

#[cfg(unix)]
fn restrict_to_owner(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
}

#[cfg(not(unix))]
fn restrict_to_owner(_dir: &Path) {
    // Windows inherits the app-data ACL, which is already user-scoped.
}

/// Reserve a free loopback port by binding and immediately releasing it.
///
/// Inherently racy — another process can take the port between the release and
/// arti's bind — but arti reads `-p 0` as "no listener", so a real port has to
/// be named up front. A lost race surfaces as a sidecar that exits with a bind
/// error, which the reader thread turns into `Failed`: visible and retryable,
/// never a silent direct connection.
fn pick_loopback_port() -> Option<u16> {
    let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).ok()?;
    let port = listener.local_addr().ok()?.port();
    drop(listener);
    (port != 0).then_some(port)
}

/// Launch `myne-tor proxy …` with its stdio closed except stderr.
///
/// stdin is null (the sidecar has no console) and stdout is null — arti logs to
/// stderr, and anything appearing on stdout would be noise we would then have
/// to drain to stop a full pipe blocking the child.
fn spawn_sidecar(exe: &Path, config_file: &Path, port: u16) -> Result<Child, ()> {
    let mut cmd = Command::new(exe);
    cmd.args(arti_argv(config_file, port))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    tie_child_to_parent(&mut cmd);
    cmd.spawn().map_err(|_| ())
}

/// Linux: ask the kernel to `SIGTERM` the sidecar if this process dies.
///
/// The three explicit teardown paths all require Myne to still be running.
/// This is the one that survives a `SIGKILL` or a crash, and an orphaned Tor
/// client holding circuits open after the app is gone is both a leak and a
/// signal.
#[cfg(target_os = "linux")]
fn tie_child_to_parent(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    // SAFETY: `pre_exec` runs between fork and exec, where only
    // async-signal-safe calls are permitted. `prctl` is one: no allocation, no
    // lock, one syscall.
    unsafe {
        cmd.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
}

#[cfg(not(target_os = "linux"))]
fn tie_child_to_parent(_cmd: &mut Command) {
    // No portable equivalent; macOS and Windows rely on the three explicit
    // teardown paths.
}

fn kill_and_reap(child: &mut Child) {
    let _ = child.kill();
    reap(child);
}

/// Wait for a child to die, bounded by [`REAP_TIMEOUT`].
fn reap(child: &mut Child) {
    let deadline = Instant::now() + REAP_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) if Instant::now() >= deadline => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
}

/// Does the loopback port answer a SOCKS5 method negotiation?
///
/// The greeting and its two-byte reply, and nothing more: no `CONNECT`, so no
/// circuit is built and no hostname is disclosed just to answer "is the listener
/// alive". Both halves come from the shared sync core rather than being spelled
/// out again here — a probe with its own opinion of a healthy listener could
/// pass a proxy the transport then refuses, or vice versa. This function owns
/// only the probe's *policy*: which port, and how long to wait.
fn socks5_greeting_ok(port: u16) -> bool {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let Ok(mut sock) = TcpStream::connect_timeout(&addr, PROBE_TIMEOUT) else {
        return false;
    };
    let _ = sock.set_read_timeout(Some(PROBE_TIMEOUT));
    let _ = sock.set_write_timeout(Some(PROBE_TIMEOUT));
    sock.write_all(&socks5::METHOD_NEGOTIATION_GREETING).is_ok()
        && socks5::read_method_selection(&mut sock).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use myne_core::plugins::sync::proxy::{Route, RouteDenied};
    use myne_core::test_support::ScopedTempDir;

    fn sidecar() -> Arc<TorSidecar> {
        let gate = ProxyGate::new();
        // Tor mode on, so `route()` exercises the fail-closed arms rather than
        // short-circuiting to Direct.
        gate.set_enabled(true);
        Arc::new(TorSidecar::new(gate))
    }

    fn tempdir() -> ScopedTempDir {
        ScopedTempDir::new("tor-sidecar").expect("temp dir")
    }

    #[test]
    fn a_fresh_supervisor_is_stopped_and_the_gate_fails_closed() {
        let s = sidecar();
        assert_eq!(s.phase(), Phase::Stopped);
        assert_eq!(s.gate().route(), Err(RouteDenied::Stopped));
    }

    #[test]
    fn a_missing_sidecar_binary_fails_and_never_routes_directly() {
        let dir = tempdir();
        let s = sidecar();
        assert_eq!(
            s.start(dir.path(), dir.path()),
            Err(StartError::SidecarMissing)
        );
        assert_eq!(s.phase(), Phase::Failed);
        assert_eq!(s.gate().route(), Err(RouteDenied::Failed));
    }

    #[test]
    fn the_state_dir_layout_and_config_are_created_under_tor() {
        let dir = tempdir();
        let tor = dir.path().join("tor");
        let config = prepare_tor_dir(&tor).expect("prepare");
        assert!(tor.join("state").is_dir());
        assert!(tor.join("cache").is_dir());
        assert_eq!(config, tor.join("arti.toml"));
        let text = std::fs::read_to_string(&config).expect("read config");
        assert!(text.contains(&format!("state_dir = \"{}\"", tor.join("state").display())));
    }

    #[cfg(unix)]
    #[test]
    fn the_tor_state_dir_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir();
        let tor = dir.path().join("tor");
        prepare_tor_dir(&tor).expect("prepare");
        for d in [&tor, &tor.join("state"), &tor.join("cache")] {
            let mode = std::fs::metadata(d).expect("stat").permissions().mode();
            assert_eq!(mode & 0o077, 0, "{} is not owner-only", d.display());
        }
    }

    #[test]
    fn a_picked_port_is_nonzero_and_released() {
        let port = pick_loopback_port().expect("a free loopback port");
        assert_ne!(port, 0, "-p 0 would disable arti's listener");
        TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).expect("port released");
    }

    #[test]
    fn the_probe_rejects_a_dead_port_and_a_listener_that_does_not_speak_socks5() {
        assert!(!socks5_greeting_ok(
            pick_loopback_port().expect("free port")
        ));

        let port = fake_listener(|mut sock| {
            let _ = sock.write_all(b"HTTP/1.1 400 Bad Request\r\n");
        });
        assert!(!socks5_greeting_ok(port));
    }

    #[test]
    fn the_probe_accepts_a_listener_that_answers_the_socks5_greeting() {
        let port = fake_listener(socks5_greeting_reply);
        assert!(socks5_greeting_ok(port));
    }

    /// The end-to-end lifecycle against a **stub proxy**: a script that
    /// announces bootstrap exactly the way arti does and then stays up. It
    /// drives the real spawn, the real stderr reader, the real probe and the
    /// real kill — everything but arti itself. The SOCKS listener is owned by
    /// the test, which is why `start_on_port` exists.
    #[cfg(unix)]
    #[test]
    fn start_to_ready_to_stop_against_a_stub_proxy() {
        let dir = tempdir();
        let exe_dir = stub_bin_dir(&dir, STUB_BOOTSTRAP_THEN_IDLE);
        let port = fake_listener(socks5_greeting_reply);

        let s = sidecar();
        s.start_on_port(&exe_dir, dir.path(), port).expect("start");
        assert_eq!(s.phase(), Phase::Starting);
        // Sync is paused, NOT routed directly, for the whole bootstrap.
        assert_eq!(s.gate().route(), Err(RouteDenied::Starting));

        await_phase(&s, Phase::Ready).expect("stub proxy should reach Ready");
        assert_eq!(s.gate().route(), Ok(Route::Socks5 { socks_port: port }));

        let pid = stub_pid(dir.path());
        s.stop();
        assert_eq!(s.phase(), Phase::Stopped);
        assert_eq!(s.gate().route(), Err(RouteDenied::Stopped));
        assert!(!pid_alive(pid), "the stub proxy outlived stop()");
    }

    /// A sidecar that dies on its own is a failure the transport must see —
    /// this is the "Tor unavailable, sync paused" path.
    #[cfg(unix)]
    #[test]
    fn a_sidecar_that_exits_on_its_own_lands_in_failed() {
        let dir = tempdir();
        let exe_dir = stub_bin_dir(&dir, "echo 'ERROR arti: address in use' >&2\nexit 1\n");

        let s = sidecar();
        s.start(&exe_dir, dir.path()).expect("spawn succeeds");
        await_phase(&s, Phase::Failed).expect("an exiting sidecar must fail");
        assert_eq!(s.gate().route(), Err(RouteDenied::Failed));
    }

    /// App quit without an explicit `stop()` — the managed state is dropped
    /// and the child must go with it.
    #[cfg(unix)]
    #[test]
    fn dropping_the_supervisor_kills_the_child() {
        let dir = tempdir();
        let exe_dir = stub_bin_dir(&dir, STUB_BOOTSTRAP_THEN_IDLE);
        let port = fake_listener(socks5_greeting_reply);

        let s = sidecar();
        s.start_on_port(&exe_dir, dir.path(), port).expect("start");
        await_phase(&s, Phase::Ready).expect("ready");
        let pid = stub_pid(dir.path());

        drop(s);
        assert!(!pid_alive(pid), "the stub proxy outlived Drop");
    }

    /// Starting an already-running sidecar must not spawn a second Tor client.
    #[cfg(unix)]
    #[test]
    fn starting_twice_is_a_no_op() {
        let dir = tempdir();
        let exe_dir = stub_bin_dir(&dir, STUB_BOOTSTRAP_THEN_IDLE);
        let port = fake_listener(socks5_greeting_reply);

        let s = sidecar();
        s.start_on_port(&exe_dir, dir.path(), port).expect("start");
        await_phase(&s, Phase::Ready).expect("ready");
        let first = stub_pid(dir.path());

        s.start_on_port(&exe_dir, dir.path(), port).expect("no-op");
        assert_eq!(s.phase(), Phase::Ready);
        assert_eq!(stub_pid(dir.path()), first, "a second child was spawned");
        s.stop();
    }

    // ---- helpers ----

    fn await_phase(s: &Arc<TorSidecar>, want: Phase) -> Option<()> {
        for _ in 0..400 {
            if s.phase() == want {
                return Some(());
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        None
    }

    fn socks5_greeting_reply(mut sock: TcpStream) {
        let mut greeting = [0u8; 3];
        let _ = sock.read_exact(&mut greeting);
        let _ = sock.write_all(&[0x05, 0x00]);
    }

    /// A loopback listener served by `handle`. It lives for the rest of the
    /// test process — the point is a port that keeps answering, and a test
    /// binary's lifetime is short.
    fn fake_listener(handle: fn(TcpStream)) -> u16 {
        let listener = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();
        std::thread::spawn(move || {
            while let Ok((sock, _)) = listener.accept() {
                handle(sock);
            }
        });
        port
    }

    /// Write a stub `myne-tor` into a fresh `bin/` under `dir` and return that
    /// directory.
    #[cfg(unix)]
    fn stub_bin_dir(dir: &ScopedTempDir, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let exe_dir = dir.path().join("bin");
        std::fs::create_dir_all(&exe_dir).expect("mkdir");
        let path = sidecar_path(&exe_dir);
        std::fs::write(&path, format!("#!/bin/sh\n{body}")).expect("write stub");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
        exe_dir
    }

    /// Records its pid beside the config it was handed (`$3` is the `-c`
    /// argument), announces bootstrap the way arti 2.5.0 does, then `exec`s a
    /// sleep so the process the supervisor kills IS the pid it recorded.
    #[cfg(unix)]
    const STUB_BOOTSTRAP_THEN_IDLE: &str = r#"
echo $$ > "$(dirname "$3")/stub.pid"
echo "INFO arti::subcommands::proxy: Sufficiently bootstrapped; proxy now functional." >&2
exec sleep 3600
"#;

    #[cfg(unix)]
    fn stub_pid(app_data_dir: &Path) -> i32 {
        std::fs::read_to_string(app_data_dir.join("tor").join("stub.pid"))
            .expect("stub wrote its pid")
            .trim()
            .parse()
            .expect("a pid")
    }

    /// `kill(pid, 0)` — liveness without signalling. Retried briefly: `kill()`
    /// returns before the kernel has reaped the process on some schedulers.
    #[cfg(unix)]
    fn pid_alive(pid: i32) -> bool {
        for _ in 0..100 {
            // SAFETY: signal 0 performs the permission/existence check only.
            if unsafe { libc::kill(pid, 0) } != 0 {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        true
    }
}
