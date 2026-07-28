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
//!   (`unlocked && !suspended && endpoint && token && !parked-on-401`) and
//!   starts/stops the worker to match.
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

use std::io::{BufRead, Read};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};

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
    pins: Vec<[u8; 32]>,
    token_hex: String,
}

fn fingerprint_of(s: &ConnSnapshot) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.url.hash(&mut h);
    s.token_hex.hash(&mut h);
    for p in &s.pins {
        p.hash(&mut h);
    }
    h.finish()
}

/// Gather the live `(endpoint, pins, token)` snapshot, or `None` when any part
/// is missing (unconfigured / locked / not enrolled). Reads the same sources as
/// `run_active_cycle` — but NEVER claims a pending token (that is the cycle's
/// job; the listener only ever uses an already-stored token).
async fn gather_snapshot<R: Runtime>(app: &AppHandle<R>) -> Option<ConnSnapshot> {
    let cfg_path = super::commands::config_path(app).await.ok()?;
    let cfg = super::config::read_config(&crate::vault_io::StdVaultIo, &cfg_path)
        .await
        .ok()?;
    let url = cfg.endpoint_url.clone()?;
    let pins = super::commands::config_pins(&cfg);
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
    Some(ConnSnapshot {
        url,
        pins,
        token_hex,
    })
}

struct WorkerHandle {
    stop: Arc<AtomicBool>,
    sock: Arc<Mutex<Option<std::net::TcpStream>>>,
    unauth: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
    fingerprint: u64,
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

fn spawn_worker(snap: ConnSnapshot, signal: SsePokeSignal) -> WorkerHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let sock: Arc<Mutex<Option<std::net::TcpStream>>> = Arc::new(Mutex::new(None));
    let unauth = Arc::new(AtomicBool::new(false));
    let fingerprint = fingerprint_of(&snap);
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
        fingerprint,
    }
}

/// Spawn the poke supervisor (wired in both hosts' setup, right after
/// `spawn_sync_loop`). Owns the worker lifecycle; holds no vault secrets — the
/// snapshot is `(url, pins, token)`, all device-local transport material.
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
            // (re-enroll, endpoint change) un-parks.
            if let Some(w) = &worker {
                if w.unauth.load(Ordering::Relaxed) {
                    parked = Some(w.fingerprint);
                    teardown(worker.take());
                }
            }
            let fp = snapshot.as_ref().map(fingerprint_of);
            if parked.is_some() && parked != fp {
                parked = None;
            }

            let desired = unlocked && !suspended && snapshot.is_some() && parked.is_none();
            match (&worker, desired) {
                (None, true) => {
                    let snap = snapshot.clone().expect("desired implies snapshot");
                    let Some(signal) = app.try_state::<SsePokeSignal>() else {
                        continue; // host manages no signal — nothing to drive
                    };
                    worker = Some(spawn_worker(snap, signal.inner().clone()));
                }
                (Some(w), true) if fp != Some(w.fingerprint) => {
                    // Endpoint/token rotated under a live stream → reconnect
                    // under the new identity on the next tick.
                    teardown(worker.take());
                }
                (Some(_), false) => teardown(worker.take()),
                _ => {}
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
    // Fresh transport per connection — byte-identical endpoint/pin semantics to
    // the sync cycles (`build_transport` is the single factory).
    let Ok(transport) = super::http_transport::build_transport(&snap.url, snap.pins.clone()) else {
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
