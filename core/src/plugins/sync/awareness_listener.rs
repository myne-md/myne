// SPDX-License-Identifier: AGPL-3.0
//! The `/sync/awareness` SSE listener (epic live-collab, sub-feature 4).
//!
//! A **sibling** of the poke supervisor (`poke_listener.rs`, `SYNC-32`): both
//! share the reconnect/park/route-identity machinery out of
//! [`super::stream_supervisor`], but each runs its own lifecycle. This one keeps
//! ONE long-lived `GET /sync/awareness` stream open per unlocked, foregrounded
//! enrolled vault, gated on exactly the poke's predicate (unlocked AND not
//! suspended, `SYNC-30`).
//!
//! It transports **opaque** awareness frames (a cursor/selection/presence update
//! or an opaque Automerge change delta) that the relay cannot read; this module
//! never parses a frame, it moves envelope payloads between the wire and an
//! in-RAM sink ([`AwarenessSignal`]), and the editor/presence layer interprets
//! them. The frame crypto (sealing, room-id derivation) lives in
//! `collab-awareness-crypto`; the relay is `collab-relay-server`.
//!
//! One stream per **device**, subscribed to the rooms of its open notes (the
//! GET's `?rooms=`, `SYNC-9`). A session that has just opened (or attached) emits
//! a JOIN presence frame so peers re-announce their presence (`SYNC-29`): that is
//! the one-shot `join_pending` flag inside `live::awareness::seal_local_presence`,
//! which is where the keypair and epoch live, so this key-less signal layer never
//! seals a frame itself. The
//! up-path drains the outbox through the shared ~100 ms coalescer
//! ([`super::awareness_coalesce`]) and `POST`s one batch per window.

use std::io::BufRead;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::awareness_coalesce::{encode_batch, Coalescer};
use super::loop_control::FailureClass;
use super::stream_supervisor::{
    decide, fingerprint_of, gather_snapshot, sleep_interruptible, teardown, Backoff, ChunkedFrames,
    ConnSnapshot, Decision, StreamIdentity, WorkerHandle, SNAPSHOT_REFRESH_TICKS, SSE_READ_TIMEOUT,
    SUPERVISOR_TICK_MS,
};
use super::transport::{HttpMethod, SseOpenError, SseStream, SyncTransport};

/// The awareness route.
pub const AWARENESS_PATH: &str = "/sync/awareness";

/// Bound on each in-RAM queue (frames are self-contained snapshots; a newer one
/// supersedes an older, so drop-oldest is not data loss).
const QUEUE_CAP: usize = 256;

/// Backoff after a 429 on the up-path POST, the `RateLimited` cadence
/// (`SYNC-22`), not the plain transport ladder.
const POST_RATE_LIMIT_RETRY_MS: u64 = 60_000;

fn now_unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Map a POST response status to a [`FailureClass`] (a 429 is the server's own
/// throttle, `SYNC-22`).
fn classify_post_status(status: u16) -> FailureClass {
    match status {
        429 => FailureClass::RateLimited,
        401 => FailureClass::Unauthenticated,
        _ => FailureClass::Other,
    }
}

/// POST one coalesced batch. The body is opaque to the transport.
fn post_batch(
    transport: &dyn SyncTransport,
    token_hex: &str,
    body: &[u8],
) -> Result<u16, super::transport::TransportError> {
    transport
        .request(HttpMethod::Post, AWARENESS_PATH, body, Some(token_hex))
        .map(|r| r.status)
}

#[derive(Default)]
struct AwarenessInner {
    /// Received RAW sealed frames (the SSE reader decodes the server's
    /// `{"room_id_hex","frame_b64"}` envelope before queueing, so a frame's first 16
    /// bytes are the room id the router matches on).
    inbox: Vec<Vec<u8>>,
    /// Outgoing `(room_id, opaque frame)` pairs awaiting the coalesced POST.
    outbox: Vec<([u8; 16], Vec<u8>)>,
    /// The device's subscribed room set (its open notes), one stream per device.
    rooms: Vec<[u8; 16]>,
    /// The local participant label this device advertises in its presence frames
    /// (`collab-presence-ui`): the synced device name, set by the client once.
    /// `None` lets a peer fall back to the actor id.
    local_label: Option<String>,
    /// Bumped on every (re)connect (observability / test).
    generation: u64,
    /// Inbound frames this device's SSE reader has taken off the wire
    /// (`collab-verification` task 3 diagnostics): the count that separates "the
    /// server never sent it" from "it arrived and was dropped".
    received: u64,
    /// Of those, how many routed as a presence (opened + room-matched). The rest
    /// were a wrong room, a stale/tampered frame, or a self-echo.
    presence_routed: u64,
    /// Inbound frames whose room matched no open note.
    rx_no_room: u64,
    /// Inbound frames dropped as this device's own echo (the relay fans a frame out
    /// to its publisher too). Separated from `rx_no_room` so "the peer leg delivered
    /// nothing" is distinguishable from "it delivered and was dropped".
    rx_self_echo: u64,
    /// Inbound frames carrying a change for a note with no open session.
    rx_no_session: u64,
    /// Inbound frames that arrived while NO note had an open session at all.
    rx_no_open_note: u64,
    /// Which shared tier the awareness keypair derives through right now: `true` for
    /// the `NTV6` group arm, `false` for the owner root arm. A boolean, never key or
    /// room material.
    keypair_group: bool,
    /// The room of the LAST frame this device queued outbound (RAM only; the room id is
    /// already carried in `outbox`). Compared against an inbound frame's header room to
    /// tell "our own frame came back and the route derivation no longer agrees with the
    /// send derivation" apart from "the relay delivered someone else's frame".
    last_out_room: Option<[u8; 16]>,
    /// Inbound frames whose header room equals THIS device's last outgoing room but
    /// which matched no open session's derived room: the send path and the route path
    /// derived different rooms on the SAME device.
    rx_out_room_missed: u64,
    /// Inbound frames that failed to open (wrong key/vault/epoch AAD, or tamper).
    rx_open_failed: u64,
    /// Up-path observability (`collab-verification` task 3): the coalesced
    /// `POST /sync/awareness` batches this device has emitted, the frames they
    /// carried, the encoded length of the last one, and the millisecond window
    /// they span. Read by `sync_awareness_stats` so the leak budget's emitted-rate
    /// and envelope-size assertions have a surface. Counters only; no payload.
    batches_posted: u64,
    frames_posted: u64,
    last_batch_len: usize,
    first_batch_ms: Option<u64>,
    last_batch_ms: Option<u64>,
}

/// Up-path observability for the awareness leak budget (`collab-verification`
/// task 3). Counts and lengths only: never frame bytes, a room id or a note id.
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AwarenessStats {
    pub batches_posted: u64,
    pub frames_posted: u64,
    pub last_batch_len: usize,
    /// The (re)connect generation: one stream per device, so a value above 1 means
    /// the stream reconnected (a note opened or closed, a token change).
    pub generation: u64,
    /// How many rooms are subscribed right now (the open notes).
    pub rooms: u64,
    /// Inbound frames taken off the wire (a diagnostic, not a leak assertion).
    pub received: u64,
    /// Of those, how many routed as a presence (a diagnostic).
    pub presence_routed: u64,
    /// Of those, how many were dropped because no open note's room matched.
    pub rx_no_room: u64,
    /// Of those, how many were this device's own echoed frame.
    pub rx_self_echo: u64,
    /// Of those, how many carried a change for a note with no open session.
    pub rx_no_session: u64,
    /// Of those, how many arrived while NO note had an open session at all.
    pub rx_no_open_note: u64,
    /// The shared tier the keypair currently derives through (`true` = `NTV6` group).
    pub keypair_group: bool,
    /// Inbound frames that carried THIS device's own last outgoing room yet matched no
    /// open session's derived room.
    pub rx_out_room_missed: u64,
    /// Of those, how many failed to open (wrong key/vault/epoch AAD, or tamper).
    pub rx_open_failed: u64,
    /// Wall-clock window, ms: `frames_posted` over it is the emitted frame rate.
    pub window_ms: u64,
}

/// The app-managed awareness state: a RAM-only sink the worker writes received
/// frames into and the up-path drains outbound frames from. Holds no key: the
/// frames are opaque to this layer.
#[derive(Clone, Default)]
pub struct AwarenessSignal(Arc<Mutex<AwarenessInner>>);

fn push_bounded<T>(v: &mut Vec<T>, item: T, cap: usize) {
    if v.len() >= cap {
        v.remove(0); // drop the oldest
    }
    v.push(item);
}

impl AwarenessSignal {
    pub fn new() -> Self {
        Self::default()
    }

    /// Replace the subscribed room set (the open notes). The worker reads it on
    /// its next (re)connect; a change tears the stream down and re-opens it,
    /// because the room set is part of the connection's query.
    pub fn set_rooms(&self, rooms: Vec<[u8; 16]>) {
        if let Ok(mut g) = self.0.lock() {
            g.rooms = rooms;
        }
    }

    /// Set the local participant label advertised in this device's presence frames
    /// (`collab-presence-ui`). The client sets it once from the synced device name.
    pub fn set_local_label(&self, label: Option<String>) {
        if let Ok(mut g) = self.0.lock() {
            g.local_label = label;
        }
    }

    /// The local participant label, if the client has set one.
    #[must_use]
    pub fn local_label(&self) -> Option<String> {
        self.0.lock().ok().and_then(|g| g.local_label.clone())
    }

    /// Record one emitted batch for the leak-budget readout
    /// (`collab-verification` task 3). Counters only: frame count, encoded byte
    /// length, and the wall clock. No frame bytes, no room id, no note id.
    fn record_batch(&self, frames: usize, bytes: usize, now_ms: u64) {
        if let Ok(mut g) = self.0.lock() {
            g.batches_posted += 1;
            g.frames_posted += frames as u64;
            g.last_batch_len = bytes;
            if g.first_batch_ms.is_none() {
                g.first_batch_ms = Some(now_ms);
            }
            g.last_batch_ms = Some(now_ms);
        }
    }

    /// The up-path counters the leak budget reads.
    #[must_use]
    pub fn stats(&self) -> AwarenessStats {
        match self.0.lock() {
            Ok(g) => AwarenessStats {
                batches_posted: g.batches_posted,
                frames_posted: g.frames_posted,
                last_batch_len: g.last_batch_len,
                generation: g.generation,
                rooms: g.rooms.len() as u64,
                received: g.received,
                presence_routed: g.presence_routed,
                rx_no_room: g.rx_no_room,
                rx_self_echo: g.rx_self_echo,
                rx_no_session: g.rx_no_session,
                rx_no_open_note: g.rx_no_open_note,
                keypair_group: g.keypair_group,
                rx_out_room_missed: g.rx_out_room_missed,
                rx_open_failed: g.rx_open_failed,
                window_ms: match (g.first_batch_ms, g.last_batch_ms) {
                    (Some(a), Some(b)) => b.saturating_sub(a),
                    _ => 0,
                },
            },
            Err(_) => AwarenessStats::default(),
        }
    }

    /// Queue an outgoing `(room, opaque frame)` for the coalesced POST.
    pub fn push_outgoing(&self, room: [u8; 16], frame: Vec<u8>) {
        if let Ok(mut g) = self.0.lock() {
            push_bounded(&mut g.outbox, (room, frame), QUEUE_CAP);
            g.last_out_room = Some(room);
        }
    }

    /// The room of this device's last queued outbound frame, if any.
    fn last_out_room(&self) -> Option<[u8; 16]> {
        self.0.lock().ok().and_then(|g| g.last_out_room)
    }

    /// Count inbound frames that carried this device's OWN last outgoing room yet
    /// matched no open session's derived room (`collab-verification` diagnostics).
    fn add_out_room_missed(&self, n: u64) {
        if let Ok(mut g) = self.0.lock() {
            g.rx_out_room_missed += n;
        }
    }

    /// Drain and return the received envelope payloads (opaque).
    pub fn take_incoming(&self) -> Vec<Vec<u8>> {
        match self.0.lock() {
            Ok(mut g) => core::mem::take(&mut g.inbox),
            Err(_) => Vec::new(),
        }
    }

    /// Drain and return the queued outgoing frames.
    pub fn take_outgoing(&self) -> Vec<([u8; 16], Vec<u8>)> {
        match self.0.lock() {
            Ok(mut g) => core::mem::take(&mut g.outbox),
            Err(_) => Vec::new(),
        }
    }

    /// The current subscribed room set (for tests/observability).
    pub fn rooms(&self) -> Vec<[u8; 16]> {
        self.0.lock().map(|g| g.rooms.clone()).unwrap_or_default()
    }

    /// The (re)connect generation (for tests/observability).
    pub fn generation(&self) -> u64 {
        self.0.lock().map(|g| g.generation).unwrap_or(0)
    }

    fn rooms_query(&self) -> String {
        let Ok(g) = self.0.lock() else {
            return String::new();
        };
        let mut s = String::new();
        for (i, r) in g.rooms.iter().enumerate() {
            if i > 0 {
                s.push(',');
            }
            for b in r {
                s.push(char::from_digit((b >> 4) as u32, 16).unwrap());
                s.push(char::from_digit((b & 0x0f) as u32, 16).unwrap());
            }
        }
        s
    }

    /// On a successful (re)connect, bump the generation. The presence JOIN
    /// re-announce (`SYNC-29`) is emitted per OPEN session by
    /// `seal_local_presence` (its one-shot `join_pending` flag), which is where the
    /// keypair and epoch are in hand: this signal layer holds no key, so it cannot
    /// seal a join frame itself.
    fn on_connect(&self) {
        if let Ok(mut g) = self.0.lock() {
            g.generation = g.generation.wrapping_add(1);
        }
    }

    fn push_incoming(&self, payload: Vec<u8>) {
        if let Ok(mut g) = self.0.lock() {
            g.received += 1;
            push_bounded(&mut g.inbox, payload, QUEUE_CAP);
        }
    }

    /// Record the shared tier the keypair derives through (`collab-verification`
    /// diagnostics: a room two devices derive differently is traceable to the tier).
    fn set_tier(&self, group: bool) {
        if let Ok(mut g) = self.0.lock() {
            g.keypair_group = group;
        }
    }

    /// Count inbound frames that routed as a presence (`collab-verification` task 3
    /// diagnostics).
    fn add_presence_routed(&self, n: u64) {
        if let Ok(mut g) = self.0.lock() {
            g.presence_routed += n;
        }
    }

    /// Count inbound frames dropped at routing, per reason (`collab-verification`
    /// task 3 diagnostics): a room mismatch, this device's own echo, or a change for
    /// a note with no open session, versus an open failure.
    fn add_rx_counts(
        &self,
        no_room: u64,
        no_open_note: u64,
        self_echo: u64,
        no_session: u64,
        open_failed: u64,
    ) {
        if let Ok(mut g) = self.0.lock() {
            g.rx_no_room += no_room;
            g.rx_no_open_note += no_open_note;
            g.rx_self_echo += self_echo;
            g.rx_no_session += no_session;
            g.rx_open_failed += open_failed;
        }
    }
}

fn spawn_worker(
    snap: ConnSnapshot,
    identity: StreamIdentity,
    signal: AwarenessSignal,
) -> WorkerHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let sock: Arc<Mutex<Option<std::net::TcpStream>>> = Arc::new(Mutex::new(None));
    let unauth = Arc::new(AtomicBool::new(false));
    let (stop2, sock2, unauth2) = (stop.clone(), sock.clone(), unauth.clone());
    let join = std::thread::Builder::new()
        .name("myne-awareness".into())
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

/// The awareness routing inputs cached at the snapshot cadence: the vault's
/// `account_number_hash` (frame AAD) and the group-key epoch (`None` for an owner
/// vault). Best-effort, a missing vault/state/`vault.meta` is `None` and routing is
/// simply skipped that cycle.
async fn gather_awareness_ctx<R: Runtime>(app: &AppHandle<R>) -> Option<([u8; 16], Option<u64>)> {
    use crate::vault_io::VaultIo as _;
    let state = app.try_state::<crate::plugins::vault_unlock::state::VaultRuntimeState>()?;
    let root = crate::paths::active_vault_root_io(app, state.active_vault_id().await).ok()?;
    let meta = crate::vault_io::StdVaultIo
        .read(&root.join("vault.meta"))
        .await
        .ok()?;
    let account = protocol::parse_vault_meta_any(&meta)
        .ok()?
        .account_number_hash;
    // The group-key epoch binds the awareness frame AAD (`SYNC-21`, `collab-b2b-sessions`
    // task 4): an `NTV6` B2B vault carries it, so a frame sealed under a RETIRED epoch
    // fails to open (`open_awareness_frame` takes it as AAD). A single-user (or pre-B2B)
    // vault has none, and the epoch stays `None`.
    let epoch = protocol::parse_vault_meta_ntv6(&meta)
        .ok()
        .map(|m| m.group_key_epoch);
    Some((account, epoch))
}

/// The awareness keypair from the unlocked slot (`collab-editor-bridge` task 7):
/// owner from `root_key`, member from the shared `group_key`. `None` when locked or
/// not in an aware state.
async fn awareness_keys_from_slot<R: Runtime>(
    app: &AppHandle<R>,
) -> Option<crate::plugins::live::awareness::AwarenessKeypair> {
    use crate::plugins::live::awareness::AwarenessKeypair;
    use crate::plugins::vault_unlock::state::{SharedSingletonKey, Slot};
    let state = app.try_state::<crate::plugins::vault_unlock::state::VaultRuntimeState>()?;
    let slot = state.slot_read_active().await;
    match &*slot {
        Slot::Unlocked(uv) => match uv.shared_singleton_key() {
            SharedSingletonKey::OwnerRoot(root) => Some(AwarenessKeypair::Owner(root)),
            SharedSingletonKey::Group(group) => {
                Some(AwarenessKeypair::Group(protocol::GroupKey::new(*group)))
            }
        },
        _ => None,
    }
}

/// Read-only awareness transport counters for the leak budget
/// (`collab-verification` task 3). Counts and lengths only: never a frame byte, a
/// room id or a note id.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
#[tauri::command]
pub fn sync_awareness_stats(signal: tauri::State<'_, AwarenessSignal>) -> AwarenessStats {
    signal.stats()
}

/// Spawn the awareness supervisor, beside `spawn_sync_loop` / `spawn_poke_supervisor`
/// in both hosts. Owns the worker lifecycle; holds no vault secrets.
pub fn spawn_awareness_supervisor<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut worker: Option<WorkerHandle> = None;
        let mut parked: Option<u64> = None;
        let mut snapshot: Option<ConnSnapshot> = None;
        // Awareness routing inputs (`collab-editor-bridge` task 7), cached at the
        // snapshot cadence: the frame AAD's `account_number_hash` and the group-key
        // epoch (`None` for an owner vault).
        let mut awareness_ctx: Option<([u8; 16], Option<u64>)> = None;
        let mut refresh_in = 0u32;
        let mut uplink: Coalescer<([u8; 16], Vec<u8>)> = Coalescer::default();
        let mut post_park_until: u64 = 0;
        // The last-seen stream generation, for the `SYNC-29` reconnect re-announce.
        let mut last_generation: u64 = 0;
        let mut ticker = tokio::time::interval(Duration::from_millis(SUPERVISOR_TICK_MS));
        loop {
            ticker.tick().await;

            let signal = app
                .try_state::<AwarenessSignal>()
                .map(|s| s.inner().clone());

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
                awareness_ctx = if unlocked {
                    gather_awareness_ctx(&app).await
                } else {
                    None
                };
                refresh_in = SNAPSHOT_REFRESH_TICKS;
            }
            refresh_in -= 1;

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

            // The OPEN notes' awareness rooms, computed BEFORE the connection
            // decision (`collab-client-transport`). The room set is part of the
            // stream's QUERY, so opening or closing a note must give the stream a
            // NEW identity and force a reconnect. Without this the socket keeps the
            // server-side subscription it opened with (usually EMPTY, since no note
            // is open yet), and a newly opened note never receives a peer's frame.
            let awareness_keys = if unlocked {
                awareness_keys_from_slot(&app).await
            } else {
                None
            };
            let rooms: Vec<[u8; 16]> = match (
                awareness_keys.as_ref(),
                app.try_state::<crate::plugins::live::LiveSessionRegistry>(),
            ) {
                (Some(k), Some(reg)) => {
                    crate::plugins::live::awareness::subscribed_rooms(reg.inner(), k)
                }
                _ => Vec::new(),
            };
            let rooms_fp = super::stream_supervisor::rooms_fingerprint(&rooms);
            if let Some(sig) = &signal {
                sig.set_rooms(rooms);
                sig.set_tier(awareness_keys.as_ref().is_some_and(|k| k.is_group()));
            }

            let wanted = if unlocked && !suspended && parked.is_none() {
                snapshot
                    .as_ref()
                    .and_then(|s| super::stream_supervisor::stream_identity_rooms(s, rooms_fp))
            } else {
                None
            };
            match decide(worker.as_ref().map(|w| w.identity), wanted) {
                Decision::Spawn => {
                    let snap = snapshot
                        .clone()
                        .expect("a wanted identity implies a snapshot");
                    let identity = wanted.expect("Spawn implies a wanted identity");
                    let Some(sig) = signal.clone() else {
                        continue;
                    };
                    worker = Some(spawn_worker(snap, identity, sig));
                }
                Decision::Teardown => {
                    teardown(worker.take());
                    // The live stream left (401 / route change / suspended). Tell the
                    // presence store to start its grace window rather than clear at
                    // once, so a reconnect does not flicker the cursors away
                    // (`collab-presence-ui` task 3).
                    let _ = app.emit("sync://awareness-dropped", ());
                }
                Decision::Idle => {}
            }

            // `SYNC-29`: an awareness-stream (re)connect re-announces this device.
            // `AwarenessSignal::on_connect` bumps the generation on every (re)connect,
            // so a change here means the transport just came back: every open session
            // must owe a JOIN again, or peers never re-learn a device that had already
            // announced itself before the drop. Key-less here (the join is sealed by
            // `seal_local_presence`, which holds the keypair).
            if let Some(sig) = &signal {
                let generation = sig.generation();
                if generation != last_generation {
                    last_generation = generation;
                    if let Some(reg) = app.try_state::<crate::plugins::live::LiveSessionRegistry>()
                    {
                        reg.mark_all_join_pending();
                    }
                }
            }

            // Route inbound awareness frames and keep the subscribed room set in step
            // with the OPEN sessions (`collab-editor-bridge` task 7). The keypair is
            // rebuilt each tick (HKDF only, no Argon2id); a carried content change is
            // applied to its session and the pane is told to drain + dispatch it as one
            // ChangeSet (`sync://remote-merged`).
            if let (Some(sig), Some(reg), Some((acct, epoch)), Some(keys)) = (
                signal.as_ref(),
                app.try_state::<crate::plugins::live::LiveSessionRegistry>(),
                awareness_ctx.as_ref(),
                awareness_keys.as_ref(),
            ) {
                {
                    let incoming = sig.take_incoming();
                    let last_out_room = sig.last_out_room();
                    let drain = crate::plugins::live::awareness::drain_and_route(
                        reg.inner(),
                        keys,
                        acct,
                        *epoch,
                        &incoming,
                        last_out_room.as_ref(),
                    );
                    sig.add_rx_counts(
                        drain.no_room,
                        drain.no_open_note,
                        drain.self_echo,
                        drain.no_session,
                        drain.open_failed,
                    );
                    sig.add_out_room_missed(drain.out_room_missed);
                    for note_id in drain.changed {
                        let _ = app.emit("sync://remote-merged", note_id);
                    }
                    // Presence frames reach the awareness store (`collab-presence-ui`).
                    {
                        let mut routed = 0u64;
                        for presence in drain.presence {
                            routed += 1;
                            let _ = app.emit("sync://awareness", presence);
                        }
                        sig.add_presence_routed(routed);
                    }
                    // Send half: seal every pending LOCAL change and queue it on the
                    // transport's outbox (SYNC-5 coalescing + POST are the up-path's).
                    for (room, frame) in crate::plugins::live::awareness::seal_local_changes(
                        reg.inner(),
                        keys,
                        acct,
                        *epoch,
                    ) {
                        sig.push_outgoing(room, frame);
                    }
                    // Presence half: seal this device's pending caret/selection (and a
                    // one-shot join per freshly opened session) so peers render its
                    // cursor (`collab-presence-ui`).
                    let label = sig.local_label();
                    for (room, frame) in crate::plugins::live::awareness::seal_local_presence(
                        reg.inner(),
                        keys,
                        acct,
                        *epoch,
                        label.as_deref(),
                    ) {
                        sig.push_outgoing(room, frame);
                    }
                }
            }

            // Up-path: drain the outbox, coalesce on the ~100 ms window, and POST
            // one batch per window (SYNC-5). A 429 parks the lane on the RateLimited
            // cadence, not the transport ladder.
            if let Some(sig) = &signal {
                let now = now_unix_millis();
                for pair in sig.take_outgoing() {
                    uplink.push(pair, now);
                }
                if now >= post_park_until && uplink.is_due(now) {
                    let batch = uplink.take_batch();
                    if !batch.is_empty() {
                        if let Some(snap) = snapshot.clone() {
                            let body = encode_batch(&batch);
                            let body_len = body.len();
                            let frames = batch.len();
                            let status = tauri::async_runtime::spawn_blocking(move || {
                                let Ok(t) = super::http_transport::build_transport(&snap.url)
                                else {
                                    return None;
                                };
                                post_batch(&*t, &snap.token_hex, &body).ok()
                            })
                            .await
                            .ok()
                            .flatten();
                            if let Some(s) = status {
                                // Leak-budget readout (`collab-verification` task 3):
                                // count a batch that reached the server, with its
                                // frame count and encoded length.
                                if s == 200 {
                                    sig.record_batch(frames, body_len, now);
                                }
                                if classify_post_status(s) == FailureClass::RateLimited {
                                    post_park_until = now_unix_millis() + POST_RATE_LIMIT_RETRY_MS;
                                }
                            }
                        }
                    }
                }
            }
        }
    });
}

enum StreamExit {
    Unauthorized,
    GotData,
    Failed,
    Stopped,
}

fn worker_main(
    snap: ConnSnapshot,
    stop: Arc<AtomicBool>,
    sock_slot: Arc<Mutex<Option<std::net::TcpStream>>>,
    unauth: Arc<AtomicBool>,
    signal: AwarenessSignal,
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
    signal: &AwarenessSignal,
) -> StreamExit {
    let Ok(transport) = super::http_transport::build_transport(&snap.url) else {
        return StreamExit::Failed;
    };
    let path = if signal.rooms_query().is_empty() {
        AWARENESS_PATH.to_string()
    } else {
        format!("{AWARENESS_PATH}?rooms={}", signal.rooms_query())
    };
    let SseStream {
        reader,
        chunked,
        socket,
    } = match transport.open_sse(&path, &snap.token_hex, SSE_READ_TIMEOUT) {
        Ok(s) => s,
        Err(SseOpenError::Unauthorized) => return StreamExit::Unauthorized,
        Err(_) => return StreamExit::Failed,
    };
    if let Ok(mut slot) = sock_slot.lock() {
        *slot = Some(socket);
    }
    if stop.load(Ordering::Relaxed) {
        if let Ok(mut slot) = sock_slot.lock() {
            if let Some(s) = slot.take() {
                let _ = s.shutdown(std::net::Shutdown::Both);
            }
        }
        return StreamExit::Stopped;
    }

    // A (re)connect bumps the generation, which the supervisor tick reads to mark
    // every open session as owing a JOIN (`SYNC-29`): the join itself is sealed by
    // `seal_local_presence`, which holds the keypair, not here.
    signal.on_connect();

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

/// Decode one SSE `data:` payload into the RAW sealed awareness frame.
///
/// The server envelopes a frame as `{"room_id_hex":"<32 hex>","frame_b64":"<base64>"}`
/// (`server-protocol.md` §3.5); the router needs the FRAME, whose first 16 bytes are
/// the room id it matches a subscription against. Extracted by hand rather than with a
/// JSON parser: the envelope is produced by our own server from opaque bytes, its shape
/// is pinned by the coalescer's encoder, and a parser dependency buys nothing here. A
/// payload that is not that shape yields `None` and is dropped.
fn decode_inbound_envelope(payload: &[u8]) -> Option<Vec<u8>> {
    use base64::engine::general_purpose::STANDARD as B64;
    use base64::Engine as _;
    const KEY: &[u8] = b"\"frame_b64\":\"";
    let start = payload.windows(KEY.len()).position(|w| w == KEY)? + KEY.len();
    let rest = &payload[start..];
    let end = rest.iter().position(|b| *b == b'"')?;
    B64.decode(&rest[..end]).ok()
}

/// Read SSE lines until EOF/timeout/stop, delivering each `data:` payload's FRAME to
/// the sink. A `:`-comment is the server heartbeat (liveness only).
pub(crate) fn drain_stream(
    reader: Box<dyn BufRead + Send>,
    chunked: bool,
    stop: &AtomicBool,
    signal: &AwarenessSignal,
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
            Ok(0) => return got_data,
            Ok(_) => {
                got_data = true;
                if let Some(payload) = line.strip_prefix(b"data:") {
                    // SSE allows at most one optional space after the colon.
                    let payload = payload.strip_prefix(b" ").unwrap_or(payload);
                    let payload = payload.strip_suffix(b"\n").unwrap_or(payload);
                    let payload = payload.strip_suffix(b"\r").unwrap_or(payload);
                    // The `data:` payload is the server's envelope,
                    // `{"room_id_hex":"<32 hex>","frame_b64":"<base64>"}`. The router
                    // matches a frame's first 16 bytes as its CLEARTEXT ROOM ID, so the
                    // FRAME has to be queued, not the envelope: queueing the envelope
                    // made every inbound frame compare its `{"room_id_hex":"` prefix as a
                    // room id and fail the room match (`rxNoRoom`), which is how the whole
                    // peer leg read as "the relay delivers but the client drops
                    // everything". A payload that is not that shape is dropped, never
                    // queued as if it were a frame.
                    if let Some(frame) = decode_inbound_envelope(payload) {
                        signal.push_incoming(frame);
                    }
                }
                // ':'-comment heartbeats and blank dispatch lines: liveness only.
            }
            Err(_) => return got_data,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::awareness_coalesce::{encode_batch, Coalescer, AWARENESS_COALESCE_MS};
    use super::super::transport::FakeTransport;
    use super::*;

    #[test]
    fn signal_queues_are_bounded_and_drain() {
        let s = AwarenessSignal::new();
        for i in 0..(QUEUE_CAP + 10) {
            s.push_outgoing([i as u8; 16], vec![i as u8]);
        }
        let out = s.take_outgoing();
        assert_eq!(out.len(), QUEUE_CAP, "outbox is bounded");
        assert_eq!(out[0].1, vec![10], "drop-oldest keeps the newest");
        assert!(s.take_outgoing().is_empty(), "drain clears");
    }

    #[test]
    fn set_rooms_renders_a_query_and_is_reported() {
        let s = AwarenessSignal::new();
        let room = [0xABu8; 16];
        s.set_rooms(vec![room]);
        assert_eq!(s.rooms(), vec![room]);
        assert_eq!(s.rooms_query(), "abababababababababababababababab");
    }

    #[test]
    fn on_connect_bumps_the_generation() {
        let s = AwarenessSignal::new();
        s.set_rooms(vec![[0x01u8; 16], [0x02u8; 16]]);
        assert_eq!(s.generation(), 0);
        s.on_connect();
        assert_eq!(s.generation(), 1, "a connect bumps the generation");
        assert!(
            s.take_outgoing().is_empty(),
            "on_connect seals no frame: the per-session join is emitted by seal_local_presence"
        );
        s.on_connect();
        assert_eq!(s.generation(), 2, "each (re)connect bumps again");
    }

    #[test]
    fn drain_delivers_the_decoded_frame_and_drops_a_malformed_envelope() {
        use base64::engine::general_purpose::STANDARD as B64;
        use base64::Engine as _;
        // The sealed frame the server relays: the room id (16 bytes) then the seal.
        let frame: Vec<u8> = [0xABu8; 16]
            .iter()
            .copied()
            .chain([0x01u8, 0x02, 0x03].iter().copied())
            .collect();
        let wire = format!(
            "data: {{\"room_id_hex\":\"{room}\",\"frame_b64\":\"{b64}\"}}\n\n:hb\n\n\
             data: {{\"nope\":1}}\n\n",
            room = "ab".repeat(16),
            b64 = B64.encode(&frame),
        );
        let wire: &'static [u8] = Box::leak(wire.into_bytes().into_boxed_slice());
        let reader: Box<dyn BufRead + Send> = Box::new(std::io::BufReader::new(wire));
        let stop = AtomicBool::new(false);
        let signal = AwarenessSignal::new();
        let got = drain_stream(reader, false, &stop, &signal);
        assert!(got);
        let inbox = signal.take_incoming();
        assert_eq!(
            inbox.len(),
            1,
            "the well-formed envelope only; the malformed one is dropped, the heartbeat skipped"
        );
        assert_eq!(
            inbox[0], frame,
            "the RAW frame is queued, not the JSON envelope: the router reads its first 16 bytes as the room id"
        );
    }

    #[test]
    fn post_batch_records_a_post_and_classifies_a_429() {
        let t = FakeTransport::new();
        t.on(HttpMethod::Post, AWARENESS_PATH, 200, b"{}".to_vec());
        let body = encode_batch(&[([0xABu8; 16], vec![0xDE, 0xAD])]);
        let status = post_batch(&t, "deadbeef", &body).expect("post");
        assert_eq!(status, 200);
        let seen = t.requests();
        assert_eq!(seen.len(), 1, "one POST recorded");
        assert_eq!(seen[0].1, AWARENESS_PATH);
        assert_eq!(seen[0].2, body, "the opaque body went verbatim");
        assert_eq!(classify_post_status(429), FailureClass::RateLimited);
        assert_eq!(classify_post_status(200), FailureClass::Other);
    }

    #[test]
    fn the_uplink_coalescer_batches_a_burst_into_one_window() {
        let mut c: Coalescer<([u8; 16], Vec<u8>)> = Coalescer::default();
        c.push(([1u8; 16], vec![1]), 0);
        c.push(([2u8; 16], vec![2]), 50);
        assert!(!c.is_due(50));
        assert!(c.is_due(AWARENESS_COALESCE_MS));
        assert_eq!(c.take_batch().len(), 2, "one batch carries the burst");
    }
}
