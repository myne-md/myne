// SPDX-License-Identifier: AGPL-3.0
//! The CLI bridge command-socket transport (cli-thin-client task 3).
//!
//! A Unix domain socket on macOS/Linux, owner-only (0600) — the exact
//! posture `clipper::relay`'s socket already uses for the same reason: local
//! only (unreachable over the network), and readable/connectable only by
//! processes running as the SAME OS user (`agent-tooling/docs/threat-model.md` §7's
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
///
/// **It is passed to THREE mechanisms and they bound different things**, which
/// this doc used to conflate into one.
///
/// As `SO_RCVTIMEO`/`SO_SNDTIMEO` it is a PER-SYSCALL bound: it resets whenever
/// a read returns data, so it bounds a SILENT peer and not a dribbling one.
///
/// As `framing::Budget` it is a ceiling on ONE frame read, checked between
/// syscalls, which is what bounds the dribbling peer. It stops at the read, so
/// `dispatch` keeps no wall-clock cap: that call decrypts every candidate note,
/// and a bound spanning it would kill a healthy `myne list` on a large vault.
///
/// As [`Watchdog`]'s deadline it is the connection total, but it is armed only
/// when the socket options were REFUSED, so on the ordinary path it bounds
/// nothing. That type's doc records what happened when it was briefly armed on
/// every connection.
#[cfg(not(test))]
pub(super) const IO_DEADLINE: Duration = Duration::from_secs(10);

/// The same deadline under `cfg(test)`, and it is LONG rather than short.
///
/// **The number was never the problem; one number serving two opposite needs
/// was.** Two tests in this file exist to WATCH the deadline fire and must wait
/// it out, so a large value makes the suite slow. Every other test in this file
/// makes a round trip that must never reach it, so a small value makes them
/// flaky. Both read the same constant, so every attempt to fix one broke the
/// other, and the history is the evidence: 1 s flaked, `write_whole_frame`
/// closed one half of the window, 5 s closed enough of the rest to look fixed,
/// and `a_connected_client_can_send_a_frame_and_get_a_reply` still failed 2 of 2
/// full-suite runs on 2026-08-31 while passing 1 of 1 alone. The doc that stood
/// here said so itself: "this raises the bar the load has to clear, it does not
/// remove the bar."
///
/// So the deadline is now a PARAMETER carried from `spawn` to the connection
/// thread, and the two needs get different values. Round-trip tests inherit
/// this constant, six times production's 10 s, because nothing about a loaded
/// machine's scheduling is bounded and the only honest bound is one no
/// scheduling delay plausibly reaches. The two deadline tests pass
/// [`STALL_TEST_DEADLINE`] explicitly and finish in a third of a second, so the
/// suite got FASTER rather than paying for the headroom.
///
/// This removes the bar rather than raising it. The round-trip tests no longer
/// race a timer at all: 60 s is not a value a descheduled thread reaches, and if
/// one ever did, the failure would be a real stall worth reading rather than
/// noise. The deadline tests no longer race anything either, because a timer
/// firing is not scheduling-dependent and their client-side ceiling is set
/// generously so a failure means "still open" rather than "the test was
/// impatient".
#[cfg(test)]
const IO_DEADLINE: Duration = Duration::from_secs(60);

/// The deadline the two tests that PROVE a stalled connection is released arm
/// for themselves. Short on purpose: they wait it out by construction, and a
/// timer firing does not depend on the scheduler, so shrinking it costs no
/// reliability. See [`IO_DEADLINE`] under `cfg(test)` for why these two do not
/// share a value with every other test in this file.
#[cfg(test)]
const STALL_TEST_DEADLINE: Duration = Duration::from_millis(300);

/// How long a deadline test's CLIENT waits to observe the close it expects.
///
/// A liveness ceiling, not a bound under test: it keeps a genuinely stuck test
/// from hanging the suite, and nothing asserts on how much of it was used. It
/// is absolute rather than a multiple of [`STALL_TEST_DEADLINE`] because the two
/// answer different questions — 300 ms is how long the SERVER may hold a stalled
/// peer, and this is how long a loaded machine may take to schedule the client
/// thread that reads the resulting EOF. Scaling the second off the first is what
/// turns "the door closed on time" into "the test was impatient".
#[cfg(test)]
const CLIENT_OBSERVATION_CEILING: Duration = Duration::from_secs(30);

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
/// **The hash is FNV-1a written out here, not `DefaultHasher`, and that is a
/// wire contract rather than a preference.** `DefaultHasher` is documented as
/// unstable across Rust releases, so a version-skewed pair (a newer desktop, an
/// older sidecar) could derive two different names for one directory and every
/// command would report "the app is not running" against a running app.
/// `cli/src/windows_pipe.rs` carries the same function; `scripts/check-cli-sidecar.mjs`
/// holds the two copies together, and the pinned vector in the tests below is
/// what fails when they drift.
///
/// Pure, portable string logic (no `windows-sys` dependency), so it is typed
/// and tested on every host including this repo's Linux dev/CI target.
// Named only by the Windows arm and by the tests that pin its derivation, so the
// host build without tests has no reader for it.
#[cfg(any(windows, test))]
pub const PIPE_PREFIX: &str = "myne-cli-";

#[cfg(any(windows, test))]
pub fn windows_pipe_name(app_data_dir: &Path) -> String {
    format!(
        r"\\.\pipe\{}{:016x}",
        PIPE_PREFIX,
        fnv1a64(app_data_dir.to_string_lossy().as_bytes())
    )
}

/// FNV-1a, 64-bit. Frozen arithmetic: see [`windows_pipe_name`].
#[cfg(any(windows, test))]
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

#[cfg(windows)]
pub use super::pipe::{spawn, teardown, ListenerHandle};

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

/// The deadline of last resort: a thread that shuts the connection down once the
/// deadline the caller supplied has elapsed. `shutdown(Both)` makes every in-flight and
/// subsequent read return EOF and every write fail, which is what releases the
/// handler thread. Production passes [`IO_DEADLINE`]; the deadline tests pass
/// [`STALL_TEST_DEADLINE`]. `Drop` disarms it, so a connection that finishes
/// normally does not leave a thread sitting out the full deadline.
///
/// **Armed ONLY when the socket options were refused**, so the ordinary
/// connection still costs exactly one thread. `Drop` disarms it, so a connection
/// that finishes normally does not leave a thread sitting out the full deadline.
///
/// **It was briefly armed on every connection and that was wrong, in a way worth
/// recording.** The reasoning was that `SO_RCVTIMEO` is a PER-SYSCALL bound that
/// resets whenever a read returns data, so it bounds a silent peer and not a
/// dribbling one, and that a total bound was therefore missing. The premise is
/// correct. The conclusion was not: this watchdog's deadline runs from ACCEPT and
/// spans the whole exchange, including `dispatch`, which decrypts every candidate
/// note. A healthy `myne list` on a large vault crosses 10 s, and the watchdog
/// would then `shutdown(Both)` it mid-flight, so the CLI reported a generic IO
/// failure that reads like the app not running. It bought a compute cap and did
/// not even buy the property claimed for it, because `shutdown(Both)` does not
/// interrupt a thread inside `block_on`. It also made an `arm` failure fatal on a
/// path that never ran on Linux, and per-connection cost went from two
/// descriptors and one thread to three and two, against a cap of 16, on a loop
/// whose own comment names fd exhaustion as reachable without malice.
///
/// The dribbling peer is bounded where it actually is: `framing::Budget`, a
/// ceiling on ONE frame read, checked between syscalls, and stopping at the read.
#[cfg(unix)]
struct Watchdog {
    disarm: Option<std::sync::mpsc::Sender<()>>,
    join: Option<std::thread::JoinHandle<()>>,
}

#[cfg(unix)]
impl Watchdog {
    /// `Ok(None)` when the socket already carries its own deadline and there
    /// is nothing to arm. `Err` means neither mechanism is available and the
    /// caller must drop the connection rather than serve it unbounded.
    fn arm(
        stream: &std::os::unix::net::UnixStream,
        deadline_set: bool,
        deadline: Duration,
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
                if let Err(std::sync::mpsc::RecvTimeoutError::Timeout) = rx.recv_timeout(deadline) {
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
    // How long this connection may hold its thread. Carried from `spawn`
    // rather than read from `IO_DEADLINE` so the two tests that exist to watch
    // it fire can arm a short one without shortening it for every round-trip
    // test in the file. Production passes `IO_DEADLINE`.
    deadline: Duration,
) {
    // BLOCKING first, before the deadlines, because on this platform family the
    // accepted stream did not arrive blocking and a deadline on a non-blocking
    // fd is dead code.
    //
    // `spawn_with_deadline` sets `set_nonblocking(true)` on the LISTENER so the
    // accept loop can poll its stop flag. On Linux that flag is a property of
    // the listener alone and `accept()` returns a blocking stream. On macOS and
    // the BSDs it is INHERITED: the accepted stream is non-blocking too. Nothing
    // in the type system, in clippy or in this suite said so, and the two costs
    // were paid separately for months.
    //
    // In production, every `read` on such a stream returns `WouldBlock`
    // immediately rather than waiting; `framing::read_up_to` treats that as an
    // error (correctly, since with a real deadline that error IS the deadline
    // firing), so `serve_connection` returned without a reply and dropped the
    // stream. A `myne` invocation whose first bytes had not already landed in
    // the socket buffer when this thread reached its first read was refused,
    // with no diagnostic naming the reason.
    //
    // In the suite it was read as flake. `a_connected_client_can_send_a_frame_and_get_a_reply`
    // failed 2 of 2 full-workspace runs on 2026-08-31 and passed 1 of 1 alone,
    // and the file's own history records the constant being raised twice to
    // chase it (1 s, then 5 s) on the theory that a client thread was losing
    // whole seconds between `connect` and its first write. It was not: the
    // window was 2.75 microseconds wide, measured on this machine with a
    // standalone probe, because the read never waited at all.
    //
    // And the deadline test could not fail: with the read returning instantly,
    // `a_connection_that_never_finishes_its_frame_is_released_by_the_deadline`
    // passed in 0.00 s whatever the deadline was, including when the deadline
    // was deliberately replaced with a 60 s one to prove the plumbing live.
    //
    // A failure here is fatal to the connection, unlike the deadline refusal
    // below: the timeouts have a documented macOS refusal that means the peer is
    // already gone, and the watchdog covers it. This has no such reading. A
    // stream that cannot be made blocking would spin `read_up_to` into an error
    // on every call, so serving it means refusing it slowly.
    if stream.set_nonblocking(false).is_err() {
        tracing::debug!(
            stage = "cli_bridge_conn_deadline",
            event = "set_blocking_refused"
        );
        last_access.record(std::time::Instant::now());
        return;
    }

    // Deadlines next, before a single byte is read: a peer must not be able
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
    let deadline_set = stream.set_read_timeout(Some(deadline)).is_ok()
        && stream.set_write_timeout(Some(deadline)).is_ok();
    if !deadline_set {
        tracing::debug!(
            stage = "cli_bridge_conn_deadline",
            event = "socket_opt_refused"
        );
    }
    let _deadline = match Watchdog::arm(&stream, deadline_set, deadline) {
        Ok(guard) => guard,
        Err(e) => {
            // No socket deadline AND no watchdog: this is the unbounded state
            // the deadline exists to prevent, so here the connection really
            // does die rather than be served.
            let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
            tracing::debug!(stage = "cli_bridge_conn_deadline", io_failure_kind = ?kind);
            // The door indicator still records that something ARRIVED. An early
            // return that skips it is the defect the comment above the timeouts
            // describes, so every early return in this function carries it.
            last_access.record(std::time::Instant::now());
            return;
        }
    };
    let mut read_half = match stream.try_clone() {
        Ok(r) => r,
        Err(e) => {
            let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
            tracing::debug!(stage = "cli_bridge_conn_clone", io_failure_kind = ?kind);
            last_access.record(std::time::Instant::now());
            return;
        }
    };
    super::dispatch::serve_connection(
        &mut read_half,
        &mut stream,
        lister,
        limiter,
        // The ceiling on reading the REQUEST. Same number as the socket timeout,
        // different property: that bounds one syscall, this bounds the whole
        // frame, which is what a dribbling peer stalls on. It stops at the read,
        // so dispatch keeps no wall-clock cap.
        Some(super::framing::Budget::new(deadline)),
    );
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
    deadline: Duration,
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
                        serve_connection(
                            stream,
                            lister.as_ref(),
                            limiter.as_ref(),
                            &last_access,
                            deadline,
                        )
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
    spawn_with_deadline(app_data_dir, lister, limiter, last_access, IO_DEADLINE)
}

/// [`spawn`] with the per-connection deadline stated rather than inherited.
///
/// Production has exactly one deadline and calls [`spawn`]. This exists for the
/// tests that watch the deadline FIRE: they need a short one, and every other
/// test in this file needs a long one, which is the split [`IO_DEADLINE`]'s
/// `cfg(test)` doc records. Not `#[cfg(test)]` itself, so the production path
/// and the tested path are the same code rather than two arms that can drift.
///
/// **One** test spawns through here
/// (`a_connection_that_never_finishes_its_frame_is_released_by_the_deadline`).
/// The other deadline test builds a raw `UnixListener` and calls
/// [`Watchdog::arm`] directly, because it is proving the watchdog rather than
/// the socket option. Both pass [`STALL_TEST_DEADLINE`]; they reach it by
/// different routes.
#[cfg(unix)]
fn spawn_with_deadline(
    app_data_dir: &Path,
    lister: Arc<dyn NoteLister>,
    limiter: Arc<SharedRateLimiter>,
    last_access: SharedLastAccess,
    deadline: Duration,
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
        .spawn(move || {
            accept_loop(
                listener,
                stop_worker,
                lister,
                limiter,
                accept_marker,
                deadline,
            )
        });
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
    fn windows_pipe_name_matches_the_pinned_vector() {
        // Pinned arithmetic, not a round trip through the same function: this
        // is the half that notices `cli/src/windows_pipe.rs` drifting away from
        // this copy, which no compiler compares.
        assert_eq!(
            windows_pipe_name(Path::new("/some/app/data")),
            format!(r"\\.\pipe\myne-cli-{:016x}", 0x4863_0ff4_3b5c_b6b3u64)
        );
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
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
    // needed (core/AGENTS.md's stated reason: the TB9 Cargo.lock
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
        fn period(&self, _period: &str) -> crate::cli_bridge::dispatch::DailyOutcome {
            crate::cli_bridge::dispatch::DailyOutcome::Io
        }
        fn period_append(
            &self,
            _period: &str,
            _line: &str,
        ) -> crate::cli_bridge::dispatch::DailyAppendOutcome {
            crate::cli_bridge::dispatch::DailyAppendOutcome::Io
        }
        fn open_plain_file(&self, _path: &str) -> crate::cli_bridge::dispatch::OpenFileOutcome {
            crate::cli_bridge::dispatch::OpenFileOutcome::Io
        }
        fn mcp_call(
            &self,
            _request: crate::cli_bridge::dispatch::McpCallRequest,
        ) -> crate::cli_bridge::dispatch::McpCallOutcome {
            crate::cli_bridge::dispatch::McpCallOutcome::Io
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

    /// Write one whole frame, length prefix and body, in a SINGLE `write_all`.
    ///
    /// NOT a tidy-up, and the reason it was added is NOT the reason it is kept.
    /// The history is here rather than deleted because the correction is the
    /// useful part: this helper was written to close a window that turned out
    /// not to be the cause.
    ///
    /// **What it still does, and this survives.** The two-call form these tests
    /// used,
    ///
    ///     client.write_all(&(body.len() as u32).to_le_bytes()).unwrap();
    ///     client.write_all(body).unwrap();
    ///
    /// leaves a real window between the two syscalls, and a server that closes
    /// inside it fails the client's SECOND write. Injecting a 1500 ms sleep
    /// between the two writes fails the test at that second write, every time.
    /// The window is real, and a test that writes one frame in one call cannot
    /// lose it. Keep the helper.
    ///
    /// **What it did NOT fix, superseded by the O_NONBLOCK finding.** This block
    /// used to attribute the round-trip flake to that window plus a short
    /// `cfg(test)` deadline, and read "`IO_DEADLINE` is **1 s** under
    /// `cfg(test)`, and a client thread descheduled a whole second between two
    /// adjacent statements is ordinary on a machine running the full workspace
    /// suite". The constant has since been 1 s, then 5 s, and is 60 s now, and
    /// the account was wrong on the mechanism rather than on the number: the
    /// accepted stream INHERITED the listener's `O_NONBLOCK` on macOS, so the
    /// server's first read never waited at all. `serve_connection`'s comment on
    /// `set_nonblocking(false)` carries the measurement: the window was 2.75
    /// microseconds wide, not one second. No deadline value could have closed
    /// it, which is why raising the constant twice looked like progress and was
    /// not.
    ///
    /// **The A/B that was read as confirmation.** `CARGO_TARGET_DIR=target/pre-push
    /// cargo test --workspace`, same machine, same session: 2 failures in 3 runs
    /// before this helper, 0 in 6 after. The measurement is real and was taken
    /// honestly. What it could not distinguish is a window narrowed from two
    /// syscalls to one against a race whose odds simply fell, and the flake
    /// returned later at 2 failures in 2 runs, which is what reopened this.
    /// A statistical A/B over a race is evidence about frequency, never about
    /// mechanism.
    ///
    /// **Still not established: the errno taxonomy.** The failure was seen
    /// wearing `ENOTCONN`, `BrokenPipe` and `UnexpectedEof`. Standalone probes
    /// of every close shape in this file's path (plain close, `shutdown(Both)`,
    /// a listener closed with the connection unaccepted,
    /// read-then-deadline-then-close) produced `BrokenPipe` on macOS and never
    /// `ENOTCONN`. Anyone re-opening this should start there.
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

    // ── myne-md/myne#555, `cli.socket_transport` ───────────────────────────
    //
    // > bind at a deliberately over-cap path (both the Linux ~108 and macOS
    // > ~104 caps are exceeded by the same construction) and assert the failure
    // > is reported rather than the door appearing enabled while bound to
    // > nothing. Designing the case out of the run is the bug.
    //
    // `ShortDir` above exists precisely to keep every other test in this module
    // UNDER the kernel's `sun_path` cap, and its comment says so. That is the
    // right call for tests about what happens when a bind succeeds — and it
    // means the over-cap path is the one condition this file has arranged never
    // to encounter. It is not exotic: an app-data dir under a long profile
    // name, a deeply nested `$XDG_DATA_HOME`, or a macOS container path is
    // enough, and `SOCKET_BASENAME` is short "by design" exactly because the
    // margin is thin.
    //
    // What must NOT happen is the shape myne#314 already fixed one instance of:
    // an `Err` swallowed while `spawn` still reports success, leaving a status
    // marker that says the door is open and nothing behind it. Every `myne`
    // command then fails with a generic IO error instead of the
    // app-not-running / vault-locked / cli-disabled answer the marker exists to
    // give.
    //
    // Two things are asserted, and the second is the one a swallowed error
    // passes: `spawn` REPORTS the failure, and it leaves no socket file
    // advertising a door nobody serves.
    #[cfg(unix)]
    #[test]
    fn spawn_reports_a_path_over_the_kernel_sun_path_cap() {
        // One construction that exceeds BOTH caps: Linux's ~108 and macOS's
        // ~104. Built from nested components rather than one long name so it
        // also clears any per-component `NAME_MAX`, and rooted at `/tmp` so the
        // absolute length is under our control rather than the runner's.
        let mut dir = std::path::PathBuf::from("/tmp");
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        dir.push(format!("myne-cap-{stamp}"));
        for i in 0..6 {
            dir.push(format!("segment-that-is-deliberately-long-{i}"));
        }
        std::fs::create_dir_all(&dir).expect("create over-cap dir");

        let socket = socket_path(&dir);
        assert!(
            socket.as_os_str().len() > 108,
            "the probe path is {} bytes, which is under the Linux cap — this test \
             would then be asserting nothing. Lengthen the construction.",
            socket.as_os_str().len()
        );

        let result = spawn(&dir, test_lister(), open_limiter(), test_marker());

        assert!(
            result.is_err(),
            "spawn reported SUCCESS for a socket path of {} bytes, which no kernel \
             can bind. A handle recorded here means the status marker says the CLI \
             door is open while nothing is listening, and every `myne` command \
             fails with a generic IO error instead of a diagnosis.",
            socket.as_os_str().len()
        );
        assert!(
            !socket.exists(),
            "a socket FILE was left at an unbindable path. A file that answers \
             ECONNREFUSED is a worse answer than one that is simply absent — \
             `spawn`'s own thread-failure arm says so and removes it."
        );

        std::fs::remove_dir_all(std::path::PathBuf::from("/tmp").join(format!("myne-cap-{stamp}")))
            .ok();
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
        // See the ceiling's own doc: the server deadline is 60 s under
        // `cfg(test)`, so a round trip needs a bound of its own to fail fast.
        client
            .set_read_timeout(Some(CLIENT_OBSERVATION_CEILING))
            .expect("set client read timeout");
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
            fn period(&self, _period: &str) -> crate::cli_bridge::dispatch::DailyOutcome {
                crate::cli_bridge::dispatch::DailyOutcome::Io
            }
            fn period_append(
                &self,
                _period: &str,
                _line: &str,
            ) -> crate::cli_bridge::dispatch::DailyAppendOutcome {
                crate::cli_bridge::dispatch::DailyAppendOutcome::Io
            }
            fn open_plain_file(&self, _path: &str) -> crate::cli_bridge::dispatch::OpenFileOutcome {
                crate::cli_bridge::dispatch::OpenFileOutcome::Io
            }
            fn mcp_call(
                &self,
                _request: crate::cli_bridge::dispatch::McpCallRequest,
            ) -> crate::cli_bridge::dispatch::McpCallOutcome {
                crate::cli_bridge::dispatch::McpCallOutcome::Io
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
        // See the ceiling's own doc: the server deadline is 60 s under
        // `cfg(test)`, so a round trip needs a bound of its own to fail fast.
        client
            .set_read_timeout(Some(CLIENT_OBSERVATION_CEILING))
            .expect("set client read timeout");
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

    #[cfg(unix)]
    #[test]
    fn a_client_whose_frame_lands_after_the_first_read_is_still_served() {
        // The durable record for the bug the test above only ever reported as
        // flake: on macOS and the BSDs the accepted stream INHERITS the
        // listener's `O_NONBLOCK`, so `serve_connection`'s first read returned
        // `WouldBlock` in microseconds instead of waiting, and a `myne`
        // invocation whose bytes had not already landed was refused with no
        // diagnostic. `serve_connection` clears the flag now.
        //
        // The pause is what makes this fail without that line and pass with it.
        // The test above cannot: its client writes immediately, so the bytes are
        // usually already in the socket buffer and the race is only lost under
        // load. Here the server is GUARANTEED to reach its first read with
        // nothing to read, which turns a 2-in-3 flake into a deterministic
        // assertion.
        //
        // **What this asserts depends on the platform.** Linux `accept()` does not
        // inherit file status flags (Rust std uses `accept4` with `SOCK_CLOEXEC`
        // only), so the accepted stream is blocking there whether or not
        // `set_nonblocking(false)` runs. On Linux this pins the
        // blocking-first-read CONTRACT; on macOS and the BSDs it is the
        // regression guard for the inherited flag.
        //
        // `the_fix_holds_on_a_stream_that_arrives_non_blocking` below is the
        // half that fails on EVERY platform, by setting the flag itself instead
        // of waiting for a kernel to inherit it. Read the two together: this one
        // proves the real accept path is served, that one proves the line doing
        // it is load-bearing.
        //
        // 250 ms is far inside the connection deadline (`IO_DEADLINE`, 60 s
        // under cfg(test)), so a failure here is the flag and never the timeout.
        let dir = ShortDir::new();
        let handle = spawn(dir.path(), test_lister(), open_limiter(), test_marker())
            .expect("bind cli bridge socket");
        let path = socket_path(dir.path());
        let mut client =
            std::os::unix::net::UnixStream::connect(&path).expect("connect to cli bridge socket");
        // A liveness ceiling of the client's own. Without one the only bound is
        // the SERVER's deadline, 60 s under `cfg(test)`, so a genuine regression
        // reads as a hang rather than as a timeout.
        client
            .set_read_timeout(Some(CLIENT_OBSERVATION_CEILING))
            .expect("set client read timeout");

        std::thread::sleep(Duration::from_millis(250));
        write_whole_frame(&mut client, b"{}");

        let mut prefix = [0u8; 4];
        client
            .read_exact(&mut prefix)
            .expect("a frame that arrives after the server's first read must still be served");
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
    fn the_fix_holds_on_a_stream_that_arrives_non_blocking() {
        // The regression guard that fails on every platform, including the only
        // one CI runs.
        //
        // The test above goes through the real accept path, where whether the
        // stream arrives non-blocking is the KERNEL's choice: macOS and the BSDs
        // inherit the listener's flag, Linux does not. So on Linux it cannot
        // fail, and Linux is where every gate executes. An earlier version of
        // this branch answered that with a manual roster item whose stated
        // reason was that reproducing it needs a BSD-family kernel. It does not.
        //
        // `serve_connection` is private and this module already calls private
        // items, so the flag can simply be SET here. That reproduces the exact
        // condition the fix clears, on any Unix, and `set_nonblocking(false)` is
        // then the only thing standing between it and a connection served.
        let dir = ShortDir::new();
        let path = dir.path().join("nb.sock");
        let listener = std::os::unix::net::UnixListener::bind(&path).expect("bind probe socket");
        let mut client =
            std::os::unix::net::UnixStream::connect(&path).expect("connect to probe socket");
        let (server, _) = listener.accept().expect("accept probe connection");
        // The condition under test, arranged rather than waited for.
        server
            .set_nonblocking(true)
            .expect("make the accepted stream non-blocking");

        let marker = test_marker();
        let handle = std::thread::spawn({
            let marker = marker.clone();
            move || {
                serve_connection(
                    server,
                    test_lister().as_ref(),
                    open_limiter().as_ref(),
                    &marker,
                    IO_DEADLINE,
                )
            }
        });

        // The pause is what makes the flag decide the outcome: the server thread
        // reaches its first read with nothing to read, which on a non-blocking
        // stream returns `WouldBlock` in microseconds instead of waiting.
        std::thread::sleep(Duration::from_millis(250));
        client
            .set_read_timeout(Some(CLIENT_OBSERVATION_CEILING))
            .expect("set client read timeout");
        write_whole_frame(&mut client, b"{}");

        let mut prefix = [0u8; 4];
        client
            .read_exact(&mut prefix)
            .expect("a stream that arrived non-blocking must still be served");
        let len = u32::from_le_bytes(prefix) as usize;
        let mut reply = vec![0u8; len];
        client.read_exact(&mut reply).expect("read reply body");
        let reply: serde_json::Value = serde_json::from_slice(&reply).expect("reply is JSON");
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["error"]["kind"], "invalid_request");

        handle.join().expect("server thread");
        // Every exit path records the door indicator, including the early ones.
        assert!(
            marker.elapsed_secs(std::time::Instant::now()).is_some(),
            "the door indicator must record the arrival"
        );
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
        // This test WAITS OUT the deadline, so it arms a short one for its own
        // listener rather than reading the file-wide `IO_DEADLINE` that every
        // round-trip test needs to be long. See that constant's `cfg(test)` doc.
        let handle = spawn_with_deadline(
            dir.path(),
            test_lister(),
            open_limiter(),
            test_marker(),
            STALL_TEST_DEADLINE,
        )
        .expect("bind cli bridge socket");
        let path = socket_path(dir.path());

        let mut client =
            std::os::unix::net::UnixStream::connect(&path).expect("connect to cli bridge socket");
        // One byte of a four-byte length prefix, then silence.
        client.write_all(&[0u8]).unwrap();
        client.flush().unwrap();

        // The server must close on its own, without the client ever sending
        // more. The ceiling is an ABSOLUTE 30 s rather than a multiple of the
        // deadline: it exists only to keep a hung test from hanging the suite,
        // and scaling it with a 300 ms deadline would make a loaded machine
        // report "still open" for a door that closed on time.
        client
            .set_read_timeout(Some(CLIENT_OBSERVATION_CEILING))
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

        // The peer stalls exactly like the test above: it sends nothing and
        // waits. This is the watchdog on its own, against a socket carrying no
        // `SO_RCVTIMEO` of its own, which is the arm no other test reaches.
        // `deadline_set: false` is the refusal this exists for.
        let armed = Watchdog::arm(&server, false, STALL_TEST_DEADLINE)
            .expect("arm the watchdog")
            .expect("a refused deadline must produce a watchdog");

        client
            .set_read_timeout(Some(CLIENT_OBSERVATION_CEILING))
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

        // `IO_DEADLINE`, not `STALL_TEST_DEADLINE`: this is the one watchdog
        // test whose deadline must NOT fire, so it takes the long one the
        // round-trip tests take. A short one here would make the assertion race
        // the very timer it is proving was disarmed.
        let armed = Watchdog::arm(&server, false, IO_DEADLINE)
            .expect("arm")
            .expect("armed");
        drop(armed); // the exchange "finished" well inside the deadline

        server.write_all(b"x").expect("write after disarm");
        server.flush().expect("flush after disarm");
        let mut buf = [0u8; 1];
        client
            .set_read_timeout(Some(CLIENT_OBSERVATION_CEILING))
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
