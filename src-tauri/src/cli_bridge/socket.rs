//! The CLI bridge command-socket transport (cli-thin-client task 3).
//!
//! A Unix domain socket on macOS/Linux, owner-only (0600) — the exact
//! posture `clipper::relay`'s socket already uses for the same reason: local
//! only (unreachable over the network), and readable/connectable only by
//! processes running as the SAME OS user (`docs/threat-model.md` §7's
//! accepted residual is scoped to "the same user", not "anyone").
//!
//! **Windows named-pipe bind is a documented seam, not implemented here** —
//! this matches `clipper::relay`'s own existing posture exactly (see that
//! module's doc comment: "the Windows arm is a documented seam ... the
//! dev/CI target is macOS/Linux"). [`windows_pipe_name`] is nonetheless a
//! real, tested, pure function: naming is portable string logic with no
//! `windows-sys` dependency, so it compiles and is verified on every host
//! including this repo's Linux dev/CI target, satisfying task 3's "platform
//! paths correct for macOS/Linux (UDS) and Windows (named pipe)" criterion
//! for the PATH half even though the Windows BIND half is deferred exactly
//! like the clipper's was.
//!
//! Connection handling here is a SKELETON on purpose (task 3's own scope
//! line: "Out of scope: Any command handling — task 4 owns the protocol
//! payloads"): each accepted connection reads exactly one bounded frame via
//! [`super::framing`] and then closes. Task 4 replaces
//! [`skeleton_serve_connection`] with the real command router — the same
//! shape `clipper::host`'s task 3 left for task 5/6 to fill.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::activity::SharedLastAccess;
use super::dispatch::NoteLister;
use super::rate_limit::SharedRateLimiter;

/// The basename of the command socket inside the app-data dir. Short by
/// design (Unix socket paths are capped at ~104-108 bytes by the kernel;
/// see the `ShortDir` test helper below for why this matters for CI too).
pub const SOCKET_BASENAME: &str = "cli.sock";

/// How long the accept loop waits for a connection before re-checking its
/// stop flag (it runs the listener non-blocking rather than trying to
/// interrupt a blocking `accept()` — there is no portable "wake up accept"
/// primitive for a Unix domain socket the way `TcpStream::shutdown` gives one
/// for `poke_listener`'s TCP stream).
///
/// It is a `poll(2)` timeout, NOT a sleep: an idle loop wakes at most once
/// per interval, and an arriving connection is accepted the moment the fd
/// becomes readable. Sleeping the interval instead would add up to
/// [`ACCEPT_POLL`] — 25 ms on average — to EVERY `myne` invocation, which is
/// most of what a one-shot command's latency would be.
const ACCEPT_POLL: Duration = Duration::from_millis(50);

/// Read/write deadline on an accepted connection. Without one, a peer that
/// connects and sends a partial length prefix pins its handler thread
/// forever, and N such peers cost N threads while consuming **zero** rate
/// budget — the limiter sits behind [`super::framing::read_frame`], so the
/// one guard rail this feature ships against a runaway script is bypassed by
/// the cheapest possible client. Generous enough that no honest `myne`
/// invocation can hit it (the CLI writes its whole request before reading),
/// short enough that a stalled connection frees its thread promptly.
#[cfg(not(test))]
const IO_DEADLINE: Duration = Duration::from_secs(10);

/// The same deadline, shortened under `cfg(test)` so the test that proves a
/// stalled connection IS released does not cost ten seconds of suite time.
/// Still two orders of magnitude above anything the round-trip tests in this
/// file take (each writes its whole frame and flushes before the server's
/// first read), so shortening it changes which test is slow, not which
/// behaviour is exercised.
#[cfg(test)]
const IO_DEADLINE: Duration = Duration::from_secs(1);

/// How many connections may be in flight at once. A same-user process can
/// already SIGKILL the app, so this is robustness rather than a new adversary
/// boundary — but an unbounded thread-per-connection accept loop turns a
/// trivial local mistake (a `while true; do myne list & done` typo) into an
/// app-wide thread exhaustion, and the bound costs one atomic per connection.
/// Set well above any real concurrent CLI use: `myne` opens one connection
/// per invocation and closes it.
const MAX_INFLIGHT_CONNECTIONS: usize = 16;

/// Resolve the command-socket path under an already-resolved app-data dir.
pub fn socket_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(SOCKET_BASENAME)
}

/// Resolve the Windows named-pipe rendezvous name. NOT a filesystem path —
/// named pipes live in the OS's global `\\.\pipe\` namespace, so the
/// app-data dir is hashed into the name to keep two installs/profiles
/// (e.g. a second dev profile) from colliding on the same pipe.
///
/// Pure, portable string logic (no `windows-sys` dependency), so it is
/// typed and tested on every host including this repo's Linux dev/CI
/// target, even though the actual Windows named-pipe BIND is a documented
/// seam (see module docs) — `allow(dead_code)` in non-test builds until a
/// Windows bind consumes it.
#[cfg_attr(not(test), allow(dead_code))]
pub fn windows_pipe_name(app_data_dir: &Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    app_data_dir.hash(&mut hasher);
    format!(r"\\.\pipe\myne-cli-{:016x}", hasher.finish())
}

/// A running command-socket listener, own by the lifecycle supervisor.
#[cfg(unix)]
pub struct ListenerHandle {
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
    path: PathBuf,
    /// The last-access marker this door records into (task 12). Held here so
    /// [`teardown`] can clear it without a second call site to forget.
    last_access: SharedLastAccess,
}

/// The owner-only (0600) bind, closing the bind→chmod TOCTOU: bind at a
/// sibling temp path, chmod it, THEN rename into place — so a same-host peer
/// connecting via `path` only ever observes it already at 0600. Shared with
/// `clipper::relay`, the crate's other local ingress, via [`crate::uds`]:
/// this posture is one security property, not two that happen to match.
#[cfg(unix)]
use crate::uds::bind_listener;

/// The deadline of last resort: a thread that shuts the connection down once
/// [`IO_DEADLINE`] has elapsed. `shutdown(Both)` makes every in-flight and
/// subsequent read return EOF and every write fail, which is what releases the
/// handler thread — the same bound `SO_RCVTIMEO` gives, obtained without it.
///
/// Armed ONLY when the socket options were refused, so the ordinary connection
/// still costs exactly one thread. `Drop` disarms it, so a connection that
/// finishes normally does not leave a thread sitting out the full deadline.
#[cfg(unix)]
struct Watchdog {
    disarm: Option<std::sync::mpsc::Sender<()>>,
    join: Option<std::thread::JoinHandle<()>>,
}

#[cfg(unix)]
impl Watchdog {
    /// `Ok(None)` when the socket already carries its own deadline and there
    /// is nothing to arm. `Err` means neither mechanism is available — the
    /// caller must drop the connection rather than serve it unbounded.
    fn arm(
        stream: &std::os::unix::net::UnixStream,
        deadline_set: bool,
    ) -> io::Result<Option<Self>> {
        if deadline_set {
            return Ok(None);
        }
        let fd = stream.try_clone()?;
        let (disarm, rx) = std::sync::mpsc::channel::<()>();
        let join = std::thread::Builder::new()
            .name("myne-cli-door-watchdog".to_string())
            .spawn(move || {
                // Only a genuine timeout fires the shutdown. `Disconnected` is
                // the guard's `Drop` saying the exchange finished — treating
                // the two alike would tear down every healthy connection the
                // instant it completed.
                if let Err(std::sync::mpsc::RecvTimeoutError::Timeout) =
                    rx.recv_timeout(IO_DEADLINE)
                {
                    let _ = fd.shutdown(std::net::Shutdown::Both);
                }
            })?;
        Ok(Some(Self {
            disarm: Some(disarm),
            join: Some(join),
        }))
    }
}

#[cfg(unix)]
impl Drop for Watchdog {
    fn drop(&mut self) {
        // Dropping the sender disconnects the channel, which wakes the thread
        // out of `recv_timeout` immediately; the join is then prompt.
        self.disarm.take();
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

/// The real command-socket connection handler (task 4): read exactly one
/// bounded frame, dispatch it through [`super::dispatch::serve_connection`]
/// against the shared [`NoteLister`] seam, write exactly one reply frame.
/// Replaces task 3's `skeleton_serve_connection`, which only read-and-closed
/// (task 3's own scope line: "task 4 owns dispatch" — the same skeleton
/// shape `clipper::host`'s task 3 left for its own task 4/5 to fill).
///
/// Splits the stream via `try_clone` (mirrors
/// `clipper::relay_app`'s connection thread) rather than passing `&stream`
/// twice as both reader and writer, which the borrow checker rejects.
#[cfg(unix)]
fn serve_connection(
    mut stream: std::os::unix::net::UnixStream,
    lister: &dyn NoteLister,
    limiter: &SharedRateLimiter,
    last_access: &SharedLastAccess,
) {
    // Deadlines first, before a single byte is read: a peer must not be able
    // to hold this thread by simply never finishing its frame. Set on the
    // stream BEFORE `try_clone`, so both halves inherit them (the clone
    // shares the same underlying fd and its `SO_RCVTIMEO`/`SO_SNDTIMEO`).
    //
    // A failure here is NOT fatal to the connection, because on macOS it does
    // not mean what it reads like. `setsockopt(SO_RCVTIMEO)` on an AF_UNIX
    // socket whose peer has already closed returns EINVAL there; a live peer
    // succeeds. So the one shape that reliably tripped this arm was a client
    // that wrote its whole frame and exited before this thread touched the
    // socket — a peer that is already gone and therefore cannot hold anything,
    // since its reads return EOF at once. Returning dropped it unserved and,
    // worse, skipped the last-access record below, which is the door indicator
    // the Settings panel reads. (Linux sets the option happily either way,
    // which is why CI never saw it.)
    //
    // The invariant that a connection is never served without a bound still
    // holds — `_deadline` below enforces it independently, without depending
    // on a reading of WHY the syscall refused.
    let deadline_set = stream.set_read_timeout(Some(IO_DEADLINE)).is_ok()
        && stream.set_write_timeout(Some(IO_DEADLINE)).is_ok();
    if !deadline_set {
        tracing::debug!(
            stage = "cli_bridge_conn_deadline",
            event = "socket_opt_refused"
        );
    }
    let _deadline = match Watchdog::arm(&stream, deadline_set) {
        Ok(guard) => guard,
        Err(e) => {
            // No socket deadline AND no watchdog: this is the unbounded state
            // the deadline exists to prevent, so here the connection really
            // does die rather than be served.
            let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
            tracing::debug!(stage = "cli_bridge_conn_deadline", io_failure_kind = ?kind);
            return;
        }
    };
    let mut read_half = match stream.try_clone() {
        Ok(r) => r,
        Err(e) => {
            let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
            tracing::debug!(stage = "cli_bridge_conn_clone", io_failure_kind = ?kind);
            return;
        }
    };
    super::dispatch::serve_connection(&mut read_half, &mut stream, lister, limiter);
    // Task 12: the Settings last-access line. Recorded AFTER the exchange, and
    // for every outcome — a refused, throttled or malformed request still
    // means something reached the door, which is precisely what the indicator
    // is there to tell the user. Filtering it to successes only would hide the
    // runaway script the rate limit is busy slowing down.
    last_access.record(std::time::Instant::now());
}

/// Block until the listener has a connection waiting or [`ACCEPT_POLL`]
/// elapses, whichever comes first. The stop-flag responsiveness of a poll
/// loop with none of a sleep's added latency; `poll(2)` errors (including
/// `EINTR`) simply return, and the caller re-tries `accept()`.
#[cfg(unix)]
fn wait_for_connection(listener: &std::os::unix::net::UnixListener) {
    use std::os::unix::io::AsRawFd;
    let mut fd = libc::pollfd {
        fd: listener.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: one initialized `pollfd` describing a live listener fd we own
    // for the duration of the call; the timeout is in range by construction.
    unsafe {
        libc::poll(&mut fd, 1, ACCEPT_POLL.as_millis() as libc::c_int);
    }
}

/// RAII counter for in-flight connections: the accept loop reserves a slot
/// before spawning, and the handler thread releases it on ANY exit path —
/// clean return, early return on a framing error, or an unwind. A leaked slot
/// would silently shrink the cap over the app's lifetime until the door
/// stopped answering, so the release must not be a statement anyone can
/// forget to write.
#[cfg(unix)]
struct InFlightSlot(Arc<std::sync::atomic::AtomicUsize>);

#[cfg(unix)]
impl InFlightSlot {
    /// Reserve a slot, or `None` when [`MAX_INFLIGHT_CONNECTIONS`] are
    /// already in flight.
    fn try_acquire(counter: &Arc<std::sync::atomic::AtomicUsize>) -> Option<Self> {
        let mut current = counter.load(Ordering::Relaxed);
        loop {
            if current >= MAX_INFLIGHT_CONNECTIONS {
                return None;
            }
            match counter.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Relaxed,
            ) {
                Ok(_) => return Some(Self(counter.clone())),
                Err(observed) => current = observed,
            }
        }
    }
}

#[cfg(unix)]
impl Drop for InFlightSlot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(unix)]
fn accept_loop(
    listener: std::os::unix::net::UnixListener,
    stop: Arc<AtomicBool>,
    lister: Arc<dyn NoteLister>,
    limiter: Arc<SharedRateLimiter>,
    last_access: SharedLastAccess,
) {
    let in_flight = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    while !stop.load(Ordering::Relaxed) {
        match listener.accept() {
            Ok((stream, _addr)) => {
                let Some(slot) = InFlightSlot::try_acquire(&in_flight) else {
                    // At the cap: drop the stream, which closes the
                    // connection immediately. The peer gets a prompt EOF
                    // rather than a stall — the same "distinct, non-hanging"
                    // property the rate limit's own refusal is held to, minus
                    // a reply frame (there is no thread to write one from,
                    // and inventing a seventh wire kind for "the app is busy"
                    // would be a new contract for a condition no honest
                    // caller reaches).
                    tracing::debug!(stage = "cli_bridge_accept", event = "at_connection_cap");
                    continue;
                };
                let lister = lister.clone();
                let limiter = limiter.clone();
                let last_access = last_access.clone();
                let spawned = std::thread::Builder::new()
                    .name("cli-bridge-conn".into())
                    .spawn(move || {
                        let _slot = slot;
                        serve_connection(stream, lister.as_ref(), limiter.as_ref(), &last_access)
                    });
                // A spawn failure drops `slot` with the closure, so the
                // reservation is released rather than leaked.
                let _ = spawned;
            }
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                wait_for_connection(&listener);
            }
            Err(e) => {
                // A transient `accept()` error must not end the loop (myne#314).
                //
                // `break` here killed the door for the whole session, silently:
                // `accept_loop` returns, the by-value listener drops (fd closed)
                // — but `<app_data_dir>/cli.sock` is NOT unlinked, because only
                // `teardown` does that and it never runs. The supervisor still
                // holds `listener: Some(_)`, so neither its re-bind arm nor its
                // teardown arm can fire, and the status marker stays `O`. Every
                // later `myne` command then got ECONNREFUSED, which
                // `classify_unreachable` read against that stale `O` and
                // reported as a generic IO failure (exit 1) instead of the
                // app-not-running / vault-locked / cli-disabled distinction the
                // marker exists to provide. Settings showed the toggle on, with
                // no fault. Recovery needed a lock/unlock cycle or a restart.
                //
                // Reachable without malice: per-process fd exhaustion
                // (EMFILE/ENFILE — the WebView, open note and attachment files
                // and up to `MAX_INFLIGHT_CONNECTIONS` handler threads share the
                // limit), or on macOS/BSD an ECONNABORTED when a client aborts
                // between connect and accept, e.g. a SIGINT'd `myne list`.
                //
                // The sibling local ingress in this crate already made the
                // opposite choice on the same decision
                // (`clipper::relay_app`'s accept loop logs and continues), which
                // is what marks this as an oversight rather than a policy.
                //
                // `wait_for_connection` doubles as the backoff, so an EMFILE
                // storm cannot hot-spin: it is a `poll(2)` with a 50 ms timeout,
                // and it stays responsive to the stop flag. `break` is now
                // reserved for that flag alone.
                let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
                tracing::debug!(stage = "cli_bridge_accept", io_failure_kind = ?kind);
                wait_for_connection(&listener);
            }
        }
    }
}

/// Bind the command socket under `app_data_dir` and serve connections on a
/// dedicated background thread until [`teardown`] is called. Mirrors
/// `clipper::relay_app::spawn_relay_listener`'s std-thread shape (blocking
/// accept/read IO belongs on its own thread, not a tokio worker). `lister`
/// is the vault-state seam every accepted connection dispatches through
/// (task 4) — an `Arc` so each connection's own thread gets its own clone.
/// `limiter` is the process-wide rate limit (task 10), owned by the
/// supervisor rather than created here: the budget must span sockets, so
/// that closing and reopening the door (a lock/unlock cycle) does not hand
/// out a fresh one.
#[cfg(unix)]
pub fn spawn(
    app_data_dir: &Path,
    lister: Arc<dyn NoteLister>,
    limiter: Arc<SharedRateLimiter>,
    last_access: SharedLastAccess,
) -> io::Result<ListenerHandle> {
    let path = socket_path(app_data_dir);
    let listener = bind_listener(&path)?;
    listener.set_nonblocking(true)?;
    let stop = Arc::new(AtomicBool::new(false));
    let stop_worker = stop.clone();
    let accept_marker = last_access.clone();
    // PROPAGATE a spawn failure (myne#314). `.ok()` discarded it while `spawn`
    // still returned `Ok(ListenerHandle)` — the same end state as the
    // swallowed-accept-error above: a socket file on disk, a status marker
    // reading `O`, and nothing listening. Returning `Err` instead leaves the
    // supervisor's `listener` as `None`, so its re-bind arm retries on the next
    // tick rather than recording a handle for a door nobody serves.
    let join = std::thread::Builder::new()
        .name("cli-bridge-accept".into())
        .spawn(move || accept_loop(listener, stop_worker, lister, limiter, accept_marker));
    let join = match join {
        Ok(j) => Some(j),
        Err(e) => {
            // Do not leave the socket FILE advertising a door nobody serves.
            // `bind_listener` replaces a stale one on the next attempt anyway,
            // but a file that answers ECONNREFUSED is a worse answer than one
            // that is simply absent.
            let _ = std::fs::remove_file(&path);
            return Err(e);
        }
    };
    Ok(ListenerHandle {
        stop,
        join,
        path,
        last_access,
    })
}

/// Tear down a running listener: signal the accept loop to stop, remove the
/// socket FILE immediately (so a connection attempt gets a prompt
/// "no such file"/refused rather than waiting on the poll interval), and
/// join the accept thread off the caller's thread so a supervisor tick can
/// never stall on it (mirrors `poke_listener::teardown`'s
/// `spawn_blocking`-join pattern).
///
/// Also clears the last-access marker (task 12). It lives HERE rather than at
/// the supervisor's close arm so the reset is structurally welded to the door
/// closing: an age that outlived its session would tell the user something
/// used the CLI "3 minutes ago" in a session they can no longer see, and that
/// must not depend on a future caller remembering a second call.
#[cfg(unix)]
pub fn teardown(handle: Option<ListenerHandle>) {
    let Some(mut h) = handle else { return };
    h.last_access.clear();
    h.stop.store(true, Ordering::Relaxed);
    let _ = std::fs::remove_file(&h.path);
    if let Some(join) = h.join.take() {
        tauri::async_runtime::spawn_blocking(move || {
            let _ = join.join();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cli_bridge::dispatch::{ListOutcome, NewOutcome, SearchOutcome, ShowOutcome};
    use crate::plugins::vault_unlock::state::{
        fixture_unlocked_with_keys, test_vault_id, VaultRuntimeState,
    };
    use std::io::Read as _;
    use std::io::Write as _;

    #[test]
    fn socket_path_is_under_app_data_dir() {
        let p = socket_path(Path::new("/some/app/data"));
        assert_eq!(p, Path::new("/some/app/data/cli.sock"));
    }

    #[test]
    fn windows_pipe_name_has_the_pipe_namespace_prefix() {
        let name = windows_pipe_name(Path::new("/some/app/data"));
        assert!(name.starts_with(r"\\.\pipe\myne-cli-"));
    }

    #[test]
    fn windows_pipe_name_differs_for_different_app_data_dirs() {
        // Two installs/profiles must never collide on one pipe name.
        let a = windows_pipe_name(Path::new("/profile/a"));
        let b = windows_pipe_name(Path::new("/profile/b"));
        assert_ne!(a, b);
    }

    #[test]
    fn windows_pipe_name_is_deterministic_for_the_same_dir() {
        let a = windows_pipe_name(Path::new("/profile/a"));
        let b = windows_pipe_name(Path::new("/profile/a"));
        assert_eq!(a, b);
    }

    // ---- short-path temp dir (Unix socket paths are kernel-capped at
    // ~104-108 bytes; `ScopedTempDir`'s UUID-suffixed name is too long once
    // joined with a basename, exactly the problem `clipper::relay`'s
    // `ShortSock` test helper exists to solve) ---------------------------

    struct ShortDir(PathBuf);
    impl ShortDir {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU64, Ordering as O};
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let n = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let name = format!("mc{}_{}", n % 100_000_000, SEQ.fetch_add(1, O::Relaxed));
            let path = std::env::temp_dir().join(&name);
            let path = if path.as_os_str().len() > 40 {
                PathBuf::from(format!("/tmp/{name}"))
            } else {
                path
            };
            std::fs::create_dir_all(&path).expect("create short temp dir");
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for ShortDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // A fixed `NoteLister` double — no `AppHandle` / `tauri::test` harness
    // needed (core/CLAUDE.md's stated reason: the TB9 Cargo.lock
    // discipline). Most transport-level tests below never invoke `list`, so
    // the fixed outcome is never observed; it exists to satisfy `spawn`'s
    // signature.
    struct FixedLister;
    impl NoteLister for FixedLister {
        fn list_notes(&self) -> ListOutcome {
            ListOutcome::Io
        }
        fn show_note(&self, _id: &str) -> ShowOutcome {
            ShowOutcome::Io
        }
        fn search_notes(&self, _query: &str) -> SearchOutcome {
            SearchOutcome::Io
        }
        fn create_note(&self, _body: &str, _folder: Option<&str>) -> NewOutcome {
            NewOutcome::Io
        }
        fn daily(&self) -> crate::cli_bridge::dispatch::DailyOutcome {
            crate::cli_bridge::dispatch::DailyOutcome::Io
        }
        fn daily_append(&self, _line: &str) -> crate::cli_bridge::dispatch::DailyAppendOutcome {
            crate::cli_bridge::dispatch::DailyAppendOutcome::Io
        }
    }
    fn test_lister() -> Arc<dyn NoteLister> {
        Arc::new(FixedLister)
    }

    /// A limiter that never throttles — the transport/lifecycle tests below
    /// are about the socket, not the rate limit (which has its own tests in
    /// `rate_limit.rs` and `dispatch.rs`).
    fn open_limiter() -> Arc<SharedRateLimiter> {
        Arc::new(SharedRateLimiter::new(u32::MAX, Duration::from_secs(60)))
    }

    /// A last-access marker for tests that do not assert on it. Fresh per
    /// call, which is the whole reason the marker is passed in rather than
    /// reached for globally: one test's socket cannot move another's age.
    fn test_marker() -> SharedLastAccess {
        SharedLastAccess::default()
    }

    /// Write one whole frame — length prefix and body — in a SINGLE `write_all`.
    ///
    /// NOT a tidy-up. The two-call form these tests used,
    ///
    ///     client.write_all(&(body.len() as u32).to_le_bytes()).unwrap();
    ///     client.write_all(body).unwrap();
    ///
    /// leaves a real window between the two syscalls, and the server is
    /// entitled to close inside it. `serve_connection` sets `SO_RCVTIMEO` to
    /// [`IO_DEADLINE`] before its first read; `framing::read_up_to` treats the
    /// resulting `WouldBlock` as an error rather than a retry (correctly — that
    /// error IS the deadline firing); `dispatch::serve_connection` returns
    /// without a reply and the stream drops. The client's SECOND write then
    /// fails against a peer that is already gone.
    ///
    /// That is why this read as flake and only under
    /// `cargo test --workspace`: [`IO_DEADLINE`] is **1 s** under `cfg(test)`,
    /// and a client thread descheduled a whole second between two adjacent
    /// statements is ordinary on a machine running the full workspace suite.
    ///
    /// TWO KINDS OF EVIDENCE, and they are not the same strength.
    ///
    /// Injection (strong, deterministic): a 1500 ms sleep between the two
    /// writes fails the test in 1.5 s, at the second write, every time, with no
    /// other change. The window is real.
    ///
    /// A/B (strong, statistical): `CARGO_TARGET_DIR=target/pre-push cargo test
    /// --workspace`, same machine, same session — **2 failures in 3 runs**
    /// before, **0 in 6** after.
    ///
    /// What is NOT established: the errno taxonomy. The failure was seen
    /// wearing `ENOTCONN`, `BrokenPipe` and `UnexpectedEof`, which is consistent
    /// with one cause (the server closing without a reply, racing the client's
    /// second write) — but standalone probes of every close shape in this file's
    /// path (plain close, `shutdown(Both)`, a listener closed with the
    /// connection unaccepted, read-then-deadline-then-close) produced
    /// `BrokenPipe` on macOS and never `ENOTCONN`. So the account above explains
    /// the window and the measurement, and does NOT fully explain which errno
    /// surfaces when. Anyone re-opening this should start there rather than
    /// assume it was settled.
    ///
    /// The constant's own doc comment already states the invariant that makes
    /// 1 s safe — "each writes its whole frame and flushes before the server's
    /// first read". These tests were the ones not honouring it, and it now has
    /// exactly one place to be honoured.
    ///
    /// Production is unaffected and deliberately left alone: `framing::write_frame`
    /// writes in two calls too, but against the real 10 s deadline, and making it
    /// single-write would copy every reply body to buy nothing.
    #[cfg(unix)]
    fn write_whole_frame(client: &mut std::os::unix::net::UnixStream, body: &[u8]) {
        let mut frame = Vec::with_capacity(4 + body.len());
        frame.extend_from_slice(&(body.len() as u32).to_le_bytes());
        frame.extend_from_slice(body);
        client.write_all(&frame).unwrap();
        client.flush().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn bind_listener_sets_owner_only_0600_perms() {
        use std::os::unix::fs::PermissionsExt;
        let dir = ShortDir::new();
        let handle = spawn(dir.path(), test_lister(), open_limiter(), test_marker())
            .expect("bind cli bridge socket");
        let meta = std::fs::metadata(socket_path(dir.path())).expect("socket metadata");
        assert_eq!(
            meta.permissions().mode() & 0o777,
            0o600,
            "the command socket must be owner-only (0600)"
        );
        teardown(Some(handle));
    }

    // ── myne#314: one transient accept error must not kill the door ────────
    //
    // `break` on any non-WouldBlock error ended the loop for the session and
    // said nothing: the socket FILE stayed on disk (only `teardown` unlinks it,
    // and it never ran), so the supervisor kept `listener: Some(_)` and neither
    // its re-bind nor its teardown arm could fire, while the status marker
    // stayed `O`. Every later `myne` command got ECONNREFUSED, which
    // `classify_unreachable` read against that stale `O` as a generic IO
    // failure — exit 1 instead of the app-not-running / vault-locked /
    // cli-disabled distinction the marker exists to provide. Reachable from fd
    // exhaustion, or from a SIGINT'd client on macOS/BSD (ECONNABORTED).
    //
    // Driven at the source, because producing a real transient `accept()` error
    // on demand needs the process fd table at its limit — which a test cannot
    // arrange without destabilising every other test in the binary.
    #[test]
    fn the_accept_loop_retries_a_transient_error_instead_of_breaking() {
        let src = include_str!("socket.rs");
        let start = src.find("fn accept_loop(").expect("accept_loop must exist");
        let end = src[start..]
            .find("\n}\n")
            .map(|i| start + i)
            .expect("accept_loop must end");
        let body = &src[start..end];

        // The stop flag is the only thing that may end the loop.
        for (i, line) in body.lines().enumerate() {
            let code = line.split("//").next().unwrap_or("");
            assert!(
                !code.contains("break"),
                "accept_loop line {} still breaks out of the loop: {line:?}",
                i + 1
            );
        }
        // …and the error arm backs off through the same poll the WouldBlock arm
        // uses, so an EMFILE storm cannot hot-spin.
        assert_eq!(
            body.matches("wait_for_connection(&listener)").count(),
            2,
            "both the would-block and the error arm must wait before retrying"
        );
    }

    #[cfg(unix)]
    #[test]
    fn bind_listener_replaces_a_stale_socket_file() {
        let dir = ShortDir::new();
        std::fs::write(socket_path(dir.path()), b"stale").unwrap();
        let handle = spawn(dir.path(), test_lister(), open_limiter(), test_marker())
            .expect("bind over a stale file");
        assert!(socket_path(dir.path()).exists());
        teardown(Some(handle));
    }

    #[cfg(unix)]
    #[test]
    fn a_connected_client_can_send_a_frame_and_get_a_reply() {
        // Real dispatch (task 4): a malformed body still gets a typed
        // `invalid_request` reply, not a hang or a dropped connection —
        // proving transport + framing + dispatch compose end to end over a
        // real bound Unix socket.
        let dir = ShortDir::new();
        let handle = spawn(dir.path(), test_lister(), open_limiter(), test_marker())
            .expect("bind cli bridge socket");
        let path = socket_path(dir.path());
        let mut client =
            std::os::unix::net::UnixStream::connect(&path).expect("connect to cli bridge socket");
        let body = b"{}";
        write_whole_frame(&mut client, body);

        let mut prefix = [0u8; 4];
        client.read_exact(&mut prefix).expect("read reply prefix");
        let len = u32::from_le_bytes(prefix) as usize;
        let mut reply = vec![0u8; len];
        client.read_exact(&mut reply).expect("read reply body");
        let reply: serde_json::Value = serde_json::from_slice(&reply).expect("reply is JSON");
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "invalid_request");

        teardown(Some(handle));
    }

    #[cfg(unix)]
    #[test]
    fn a_connected_client_gets_the_real_note_list() {
        struct ListingLister;
        impl NoteLister for ListingLister {
            fn list_notes(&self) -> ListOutcome {
                ListOutcome::Ok(vec!["01970e83-4f2f-7000-8000-000000000000".into()])
            }
            fn show_note(&self, _id: &str) -> ShowOutcome {
                ShowOutcome::Io
            }
            fn search_notes(&self, _query: &str) -> SearchOutcome {
                SearchOutcome::Io
            }
            fn create_note(&self, _body: &str, _folder: Option<&str>) -> NewOutcome {
                NewOutcome::Io
            }
            fn daily(&self) -> crate::cli_bridge::dispatch::DailyOutcome {
                crate::cli_bridge::dispatch::DailyOutcome::Io
            }
            fn daily_append(&self, _line: &str) -> crate::cli_bridge::dispatch::DailyAppendOutcome {
                crate::cli_bridge::dispatch::DailyAppendOutcome::Io
            }
        }

        let dir = ShortDir::new();
        let handle = spawn(
            dir.path(),
            Arc::new(ListingLister),
            open_limiter(),
            test_marker(),
        )
        .expect("bind cli bridge socket");
        let path = socket_path(dir.path());
        let mut client =
            std::os::unix::net::UnixStream::connect(&path).expect("connect to cli bridge socket");
        let body = br#"{"cmd":"list"}"#;
        write_whole_frame(&mut client, body);

        let mut prefix = [0u8; 4];
        client.read_exact(&mut prefix).expect("read reply prefix");
        let len = u32::from_le_bytes(prefix) as usize;
        let mut reply = vec![0u8; len];
        client.read_exact(&mut reply).expect("read reply body");
        let reply: serde_json::Value = serde_json::from_slice(&reply).expect("reply is JSON");
        assert_eq!(reply["ok"], true);
        assert_eq!(
            reply["notes"],
            serde_json::json!(["01970e83-4f2f-7000-8000-000000000000"])
        );

        teardown(Some(handle));
    }

    // ---- stalled connections cannot pin the door ------------------------

    #[cfg(unix)]
    #[test]
    fn a_connection_that_never_finishes_its_frame_is_released_by_the_deadline() {
        // The shape this closes: `read_frame` blocks in `read_exact`, and the
        // rate limiter sits AFTER it — so a peer sending a partial length
        // prefix and nothing else held its handler thread indefinitely while
        // spending zero budget. The deadline is what turns that into a
        // bounded cost.
        let dir = ShortDir::new();
        let handle = spawn(dir.path(), test_lister(), open_limiter(), test_marker())
            .expect("bind cli bridge socket");
        let path = socket_path(dir.path());

        let mut client =
            std::os::unix::net::UnixStream::connect(&path).expect("connect to cli bridge socket");
        // One byte of a four-byte length prefix, then silence.
        client.write_all(&[0u8]).unwrap();
        client.flush().unwrap();

        // The server must close on its own, without the client ever sending
        // more. Read with a ceiling well above the deadline so a failure is
        // "still open", not "the test was impatient".
        client
            .set_read_timeout(Some(IO_DEADLINE * 5))
            .expect("set client read timeout");
        let mut buf = [0u8; 1];
        assert_eq!(
            client.read(&mut buf).ok(),
            Some(0),
            "a stalled connection must be closed by the server's deadline"
        );

        teardown(Some(handle));
    }

    #[cfg(unix)]
    #[test]
    fn the_watchdog_bounds_a_stalled_peer_when_the_socket_options_are_refused() {
        // The test above proves the deadline through `SO_RCVTIMEO`. This one
        // proves the OTHER mechanism, because the two do not run on the same
        // machines: macOS refuses those options on an AF_UNIX socket whose
        // peer has already closed, and Linux — where CI runs — never refuses
        // them at all. Arming the fallback explicitly is the only way this arm
        // is exercised anywhere, rather than being platform-conditional code
        // that no suite reaches.
        let dir = ShortDir::new();
        let path = dir.path().join("watchdog.sock");
        let listener =
            std::os::unix::net::UnixListener::bind(&path).expect("bind watchdog probe socket");
        let mut client =
            std::os::unix::net::UnixStream::connect(&path).expect("connect to probe socket");
        let (server, _) = listener.accept().expect("accept probe connection");

        // `deadline_set: false` is the refusal this exists for. The peer then
        // stalls exactly like the test above: it sends nothing and waits.
        let armed = Watchdog::arm(&server, false)
            .expect("arm the watchdog")
            .expect("a refused deadline must produce a watchdog");

        client
            .set_read_timeout(Some(IO_DEADLINE * 5))
            .expect("set client read timeout");
        let mut buf = [0u8; 1];
        assert_eq!(
            client.read(&mut buf).ok(),
            Some(0),
            "the watchdog must shut a stalled connection down on its own"
        );

        drop(armed);
    }

    #[cfg(unix)]
    #[test]
    fn disarming_the_watchdog_does_not_shut_a_finished_connection_down() {
        // The failure this rules out is the mirror of the one above: a guard
        // whose `Drop` woke the thread but let it fall through to `shutdown`
        // would tear down every healthy connection the instant it completed,
        // and `recv_timeout` reports both outcomes as `Err`.
        let dir = ShortDir::new();
        let path = dir.path().join("disarm.sock");
        let listener =
            std::os::unix::net::UnixListener::bind(&path).expect("bind disarm probe socket");
        let mut client =
            std::os::unix::net::UnixStream::connect(&path).expect("connect to probe socket");
        let (mut server, _) = listener.accept().expect("accept probe connection");

        let armed = Watchdog::arm(&server, false).expect("arm").expect("armed");
        drop(armed); // the exchange "finished" well inside the deadline

        server.write_all(b"x").expect("write after disarm");
        server.flush().expect("flush after disarm");
        let mut buf = [0u8; 1];
        client
            .set_read_timeout(Some(IO_DEADLINE))
            .expect("set client read timeout");
        client
            .read_exact(&mut buf)
            .expect("a disarmed watchdog must leave the connection usable");
        assert_eq!(&buf, b"x");
    }

    #[test]
    fn the_in_flight_slot_bounds_concurrent_connections_and_releases_on_drop() {
        // The accept loop spawns a thread per connection; without a bound, N
        // stalled peers cost N threads. `InFlightSlot` is the bound, and its
        // release is `Drop` rather than a statement precisely so no exit path
        // (early return on a framing error, an unwind) can leak a slot and
        // permanently shrink the cap.
        let counter = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let held: Vec<InFlightSlot> = (0..MAX_INFLIGHT_CONNECTIONS)
            .map(|_| InFlightSlot::try_acquire(&counter).expect("under the cap"))
            .collect();
        assert!(
            InFlightSlot::try_acquire(&counter).is_none(),
            "the cap must refuse the next connection rather than spawn for it"
        );
        drop(held);
        assert_eq!(counter.load(Ordering::Relaxed), 0, "every slot released");
        assert!(
            InFlightSlot::try_acquire(&counter).is_some(),
            "a released slot is reusable — the cap is concurrent, not cumulative"
        );
    }

    // ---- lifecycle: socket exists ONLY while desired open --------------

    fn apply(
        handle: &mut Option<ListenerHandle>,
        dir: &Path,
        door: crate::cli_bridge::gate::DoorState,
    ) {
        let want_open = crate::cli_bridge::gate::socket_should_be_open(door);
        match (&handle, want_open) {
            (None, true) => {
                *handle = Some(
                    spawn(dir, test_lister(), open_limiter(), test_marker())
                        .expect("bind cli bridge socket"),
                )
            }
            (Some(_), false) => teardown(handle.take()),
            _ => {}
        }
    }

    #[cfg(unix)]
    #[test]
    fn socket_exists_only_while_desired_open_across_all_four_transitions() {
        use crate::cli_bridge::gate::classify;

        let dir = ShortDir::new();
        let path = socket_path(dir.path());
        let mut handle: Option<ListenerHandle> = None;

        // 1. disabled+locked -> enabled+locked (toggle on while locked): closed.
        apply(&mut handle, dir.path(), classify(false, false));
        assert!(!path.exists(), "must stay closed while disabled+locked");
        apply(&mut handle, dir.path(), classify(true, false));
        assert!(!path.exists(), "must stay closed while enabled+locked");

        // 2. enabled+locked -> enabled+unlocked (unlock while enabled): opens.
        apply(&mut handle, dir.path(), classify(true, true));
        assert!(path.exists(), "must open once enabled AND unlocked");

        // 3. enabled+unlocked -> enabled+locked (lock while enabled): closes.
        apply(&mut handle, dir.path(), classify(true, false));
        assert!(!path.exists(), "must close the instant the vault locks");

        // 4. enabled+locked -> enabled+unlocked -> disabled+unlocked
        //    (toggle off while unlocked): closes.
        apply(&mut handle, dir.path(), classify(true, true));
        assert!(path.exists());
        apply(&mut handle, dir.path(), classify(false, true));
        assert!(!path.exists(), "must close the instant cli_enabled drops");

        teardown(handle.take());
    }

    // ---- rate limit over a real socket (task 10) ------------------------

    #[cfg(unix)]
    #[test]
    fn an_over_budget_client_gets_a_prompt_rate_limited_reply() {
        // The criterion is "distinct, non-hanging": an over-budget client
        // must get an answer over the real transport, not a closed
        // connection and not a stall. Driven end to end through a bound
        // socket, one connection per request (what `myne` actually does).
        let dir = ShortDir::new();
        let limiter = Arc::new(SharedRateLimiter::new(1, Duration::from_secs(60)));
        let handle = spawn(dir.path(), test_lister(), limiter, test_marker())
            .expect("bind cli bridge socket");
        let path = socket_path(dir.path());

        let ask = |path: &Path| -> serde_json::Value {
            let mut client =
                std::os::unix::net::UnixStream::connect(path).expect("connect to cli bridge");
            client
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let body = br#"{"cmd":"list"}"#;
            write_whole_frame(&mut client, body);
            let mut prefix = [0u8; 4];
            client.read_exact(&mut prefix).expect("read reply prefix");
            let len = u32::from_le_bytes(prefix) as usize;
            let mut reply = vec![0u8; len];
            client.read_exact(&mut reply).expect("read reply body");
            serde_json::from_slice(&reply).expect("reply is JSON")
        };

        // The first request spends the whole budget (the fixed lister
        // answers `io`, which is still a served request).
        assert_eq!(ask(&path)["error"]["kind"], "io");
        let second = ask(&path);
        assert_eq!(second["ok"], false);
        assert_eq!(second["error"]["kind"], "rate_limited");

        teardown(Some(handle));
    }

    #[cfg(unix)]
    #[test]
    fn the_budget_survives_the_door_closing_and_reopening() {
        // The limiter is owned by the supervisor, not by a socket, so a
        // lock/unlock cycle (or a toggle off and on) must not hand out a
        // fresh budget — otherwise a script gets a full window per cycle.
        let dir = ShortDir::new();
        let limiter = Arc::new(SharedRateLimiter::new(1, Duration::from_secs(60)));
        let path = socket_path(dir.path());

        let ask = |path: &Path| -> serde_json::Value {
            let mut client =
                std::os::unix::net::UnixStream::connect(path).expect("connect to cli bridge");
            client
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let body = br#"{"cmd":"list"}"#;
            write_whole_frame(&mut client, body);
            let mut prefix = [0u8; 4];
            client.read_exact(&mut prefix).expect("read reply prefix");
            let len = u32::from_le_bytes(prefix) as usize;
            let mut reply = vec![0u8; len];
            client.read_exact(&mut reply).expect("read reply body");
            serde_json::from_slice(&reply).expect("reply is JSON")
        };

        let first = spawn(dir.path(), test_lister(), limiter.clone(), test_marker()).expect("bind");
        assert_eq!(ask(&path)["error"]["kind"], "io");
        teardown(Some(first));

        let second = spawn(dir.path(), test_lister(), limiter, test_marker()).expect("rebind");
        assert_eq!(
            ask(&path)["error"]["kind"],
            "rate_limited",
            "reopening the door must not reset the window"
        );
        teardown(Some(second));
    }

    // ---- auto-lock is never touched by CLI traffic ----------------------

    #[cfg(unix)]
    #[test]
    fn socket_traffic_never_touches_the_auto_lock_activity_clock() {
        // `auto_lock.rs`'s `report_activity` is the ONLY sink that resets the
        // idle clock. This feature must never call it: CLI activity
        // resetting the idle timer would let a background script hold the
        // vault open forever, silently piercing A6 — the exact regression
        // this feature's threat-model §7 entry states does NOT happen. This
        // test drives REAL socket traffic (bind, connect, send, read) over
        // the actual transport this module builds and asserts the vault's
        // idle clock is byte-for-byte unmoved by it.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build");
        rt.block_on(async {
            let state = VaultRuntimeState::default();
            let id = test_vault_id();
            state
                .set_unlocked(id, fixture_unlocked_with_keys(0x11, 0x22, 0x33))
                .await;
            let idle_before = state.idle_millis(1_000_000);

            let dir = ShortDir::new();
            let handle = spawn(dir.path(), test_lister(), open_limiter(), test_marker())
                .expect("bind cli bridge socket");
            let path = socket_path(dir.path());
            {
                let mut client = std::os::unix::net::UnixStream::connect(&path)
                    .expect("connect to cli bridge socket");
                let body = b"{\"probe\":true}";
                write_whole_frame(&mut client, body);
            }
            std::thread::sleep(Duration::from_millis(100));
            teardown(Some(handle));

            let idle_after = state.idle_millis(1_000_000);
            assert_eq!(
                idle_before, idle_after,
                "CLI socket traffic must never reset the auto-lock idle clock"
            );
        });
    }

    #[test]
    fn a_served_request_records_the_last_access_and_teardown_clears_it() {
        // Task 12's last-access indicator, end to end over the real transport.
        //
        // The frame sent is deliberately NOT a valid command (`{"probe":true}`
        // decodes to `invalid_request`): a refused request still means the CLI
        // reached the door, which is exactly what the Settings line reports.
        //
        // The marker is this test's own, so the age asserted is exact rather
        // than "something happened" — no other test can move it.
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build");
        rt.block_on(async {
            let marker = test_marker();
            assert_eq!(
                marker.elapsed_secs(std::time::Instant::now()),
                None,
                "a door that has just opened reports no last access"
            );

            let dir = ShortDir::new();
            let handle = spawn(dir.path(), test_lister(), open_limiter(), marker.clone())
                .expect("bind cli bridge socket");
            let path = socket_path(dir.path());
            {
                let mut client = std::os::unix::net::UnixStream::connect(&path)
                    .expect("connect to cli bridge socket");
                let body = b"{\"probe\":true}";
                write_whole_frame(&mut client, body);
            }
            std::thread::sleep(Duration::from_millis(100));

            assert_eq!(
                marker.elapsed_secs(std::time::Instant::now()),
                Some(0),
                "a served request must record a fresh last-access age"
            );

            teardown(Some(handle));
            assert_eq!(
                marker.elapsed_secs(std::time::Instant::now()),
                None,
                "closing the door must reset the last-access indicator"
            );
        });
    }

    #[test]
    fn tearing_down_nothing_leaves_the_last_access_alone() {
        // `teardown(None)` is the supervisor's no-listener path. It closed no
        // door, so it must not wipe an age a live door recorded — the guard
        // ordering inside `teardown` is what makes that true.
        let marker = test_marker();
        let t0 = std::time::Instant::now();
        marker.record(t0);
        teardown(None);
        assert_eq!(marker.elapsed_secs(t0), Some(0));
    }
}
