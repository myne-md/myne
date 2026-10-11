// SPDX-License-Identifier: AGPL-3.0
//! Shared machinery for the sync tree's two long-lived SSE supervisors: the
//! contentless `/sync/poke` listener (`poke_listener.rs`) and the live-awareness
//! `/sync/awareness` listener (`awareness_listener.rs`). Both follow the SAME
//! shape, a supervisor task deciding each tick whether a stream should exist, a
//! dedicated `std::thread` worker doing blocking reads, a jittered reconnect
//! backoff, a `401`-park on the failing `(endpoint, token)` identity, and a route
//! term re-read every tick so a Tor toggle tears a healthy stream down (MYND-650).
//!
//! Single-homed here so the two supervisors cannot drift: the poke was correct
//! first, and a copy of its reconnect/park/route-identity rules in a second file
//! is a second place the route-toggle hole could reopen.

use std::io::{BufRead, Read};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager, Runtime};

use super::proxy::{self, Route};
use super::token_store::TokenStore as _;

/// SSE dead-connection read-timeout: two missed 30 s server heartbeats plus
/// margin (the server's heartbeat cadence; change them together).
pub(crate) const SSE_READ_TIMEOUT: Duration = Duration::from_secs(65);
/// Reconnect backoff bounds (jittered exponential).
pub(crate) const BACKOFF_START_MS: u64 = 1_000;
pub(crate) const BACKOFF_CAP_MS: u64 = 60_000;
/// Supervisor decision cadence.
pub(crate) const SUPERVISOR_TICK_MS: u64 = 1_000;
/// Endpoint/token snapshot refresh cadence, in supervisor ticks (two small file
/// reads, cheap, but not per-tick cheap).
pub(crate) const SNAPSHOT_REFRESH_TICKS: u32 = 5;

/// The connection identity a worker is bound to. A change in any field is a
/// different stream (teardown + reconnect under the new identity).
#[derive(Clone)]
pub(crate) struct ConnSnapshot {
    pub(crate) url: String,
    pub(crate) token_hex: String,
}

pub(crate) fn fingerprint_of(s: &ConnSnapshot) -> u64 {
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
pub(crate) struct StreamIdentity {
    pub(crate) fingerprint: u64,
    pub(crate) route: Route,
    /// A fingerprint of the stream's ROOM SET (`0` for a stream with no room
    /// subscription, e.g. the poke). The room set is part of the connection's
    /// QUERY, so it is part of the identity: the awareness stream must reconnect
    /// when a note is opened or closed, or the server keeps fanning out to the
    /// room set that existed when the socket was opened and a newly opened note
    /// never receives a frame. Without this the awareness down-stream silently
    /// delivers nothing after the first note is opened.
    pub(crate) rooms: u64,
}

/// Fingerprint a room set for [`StreamIdentity::rooms`]. Order-insensitive is not
/// needed (the room list is built in the registry's order), but a stable hash is.
pub(crate) fn rooms_fingerprint(rooms: &[[u8; 16]]) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    rooms.len().hash(&mut h);
    for r in rooms {
        r.hash(&mut h);
    }
    h.finish()
}

/// The identity a stream for `snap` would have right now, or `None` when no
/// stream may exist, an endpoint that does not parse, or a routing gate that
/// refuses (Tor mode on, tunnel not usable), the fail-closed answer the sync
/// cycle also gets.
pub(crate) fn stream_identity(snap: &ConnSnapshot) -> Option<StreamIdentity> {
    stream_identity_rooms(snap, 0)
}

/// The identity for a stream subscribing to the rooms fingerprinted by `rooms`.
pub(crate) fn stream_identity_rooms(snap: &ConnSnapshot, rooms: u64) -> Option<StreamIdentity> {
    let (_, host, _) = super::http_transport::parse_endpoint(&snap.url)?;
    stream_identity_over_rooms(snap, &proxy::installed_for(&host), rooms)
}

/// The identity, given the gate, the same gate `build_transport` would consult.
/// Split out so a test can drive a **real** [`proxy::ProxyGate`] through the
/// lifecycle a toggle produces rather than hand-built literals.
pub(crate) fn stream_identity_over(
    snap: &ConnSnapshot,
    gate: &proxy::ProxyGate,
) -> Option<StreamIdentity> {
    stream_identity_over_rooms(snap, gate, 0)
}

/// The identity for a stream that subscribes to `rooms` (the awareness stream).
pub(crate) fn stream_identity_over_rooms(
    snap: &ConnSnapshot,
    gate: &proxy::ProxyGate,
    rooms: u64,
) -> Option<StreamIdentity> {
    Some(StreamIdentity {
        fingerprint: fingerprint_of(snap),
        route: gate.route().ok()?,
        rooms,
    })
}

/// What the supervisor does with the worker it has, given the identity it wants.
/// Pure, so the "toggled Tor under a live stream" rule is one function with a
/// test rather than a `match` in a spawned task.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Decision {
    /// Leave things as they are.
    Idle,
    /// No worker and one is wanted.
    Spawn,
    /// The worker must go, either nothing is wanted, or the identity moved and
    /// the next tick reconnects under the new one.
    Teardown,
}

pub(crate) fn decide(current: Option<StreamIdentity>, wanted: Option<StreamIdentity>) -> Decision {
    match (current, wanted) {
        (None, Some(_)) => Decision::Spawn,
        (Some(_), None) => Decision::Teardown,
        (Some(have), Some(want)) if have != want => Decision::Teardown,
        _ => Decision::Idle,
    }
}

/// Gather the live `(endpoint, token)` snapshot, or `None` when any part is
/// missing (unconfigured / locked / not enrolled). Reads the same sources as
/// `run_active_cycle`, but NEVER claims a pending token (the cycle's job; the
/// listeners only ever use an already-stored token).
pub(crate) async fn gather_snapshot<R: Runtime>(app: &AppHandle<R>) -> Option<ConnSnapshot> {
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

pub(crate) struct WorkerHandle {
    pub(crate) stop: Arc<AtomicBool>,
    pub(crate) sock: Arc<Mutex<Option<std::net::TcpStream>>>,
    pub(crate) unauth: Arc<AtomicBool>,
    pub(crate) join: Option<std::thread::JoinHandle<()>>,
    pub(crate) identity: StreamIdentity,
}

/// Signal the worker to stop and unblock its read; join it off-thread so a worker
/// mid-`connect()` can never stall the supervisor tick.
pub(crate) fn teardown(w: Option<WorkerHandle>) {
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

/// De-frame `Transfer-Encoding: chunked` bytes into the raw SSE byte stream
/// (production sits behind a reverse proxy that streams SSE chunked). Chunk
/// extensions are ignored; the zero chunk ends the stream. The CRLF trailing each
/// chunk's data surfaces as an empty size-line and is skipped.
pub(crate) struct ChunkedFrames {
    pub(crate) inner: Box<dyn BufRead + Send>,
    pub(crate) left: u64,
    pub(crate) done: bool,
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
/// xorshift* seeded from wall-clock nanos, decorrelation only, NEVER key
/// material.
pub(crate) struct Backoff {
    next_ms: u64,
    seed: u64,
}

impl Backoff {
    pub(crate) fn new() -> Self {
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

    pub(crate) fn reset(&mut self) {
        self.next_ms = BACKOFF_START_MS;
    }

    pub(crate) fn next_jittered(&mut self) -> u64 {
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

pub(crate) fn sleep_interruptible(total: Duration, stop: &AtomicBool) {
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

    #[test]
    fn backoff_doubles_to_cap_with_bounded_jitter() {
        let mut b = Backoff::new();
        let mut prev = 0u64;
        for i in 0..12 {
            let d = b.next_jittered();
            assert!(d >= 750, "jitter floor: {d}");
            assert!(d <= 75_000, "jitter ceiling: {d}");
            if i < 6 {
                prev = d;
            }
        }
        assert!(prev <= BACKOFF_CAP_MS);
    }

    /// `collab-client-transport`: a change in the stream's ROOM SET is a change in
    /// its identity, so the supervisor tears the SSE down and reconnects with the
    /// new `?rooms=` query. Without this the socket kept the EMPTY subscription it
    /// opened with and a newly opened note never received a peer's frame.
    #[test]
    fn a_room_set_change_is_a_new_stream_identity() {
        let snap = ConnSnapshot {
            url: "http://127.0.0.1:1".to_string(),
            token_hex: "aa".to_string(),
        };
        let a = [0x11u8; 16];
        let b = [0x22u8; 16];
        let fp_empty = rooms_fingerprint(&[]);
        let fp_a = rooms_fingerprint(&[a]);
        let fp_ab = rooms_fingerprint(&[a, b]);
        assert_ne!(fp_empty, fp_a);
        assert_ne!(fp_a, fp_ab);

        let id_empty = stream_identity_rooms(&snap, fp_empty).expect("identity");
        let id_a = stream_identity_rooms(&snap, fp_a).expect("identity");
        assert_ne!(id_empty, id_a, "a different room set is a different stream");
        assert_eq!(
            decide(Some(id_empty), Some(id_a)),
            Decision::Teardown,
            "the room change must tear the stream down so the next tick reconnects"
        );
        assert_eq!(decide(Some(id_a), Some(id_a)), Decision::Idle);
    }
}
