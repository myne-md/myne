//! App-process wiring for the host↔app relay (TB10, task 6).
//!
//! [`relay`](super::relay) owns the transport + the keyed re-validation; this
//! module is the thin glue that backs the relay's two seams with the running
//! app's REAL state:
//!
//! - [`AppVaultStatus`] implements [`VaultStatusSource`] over the live
//!   `VaultRuntimeState` `Slot` — `is-unlocked-status` is answered from the
//!   actual lock state, NOT a static stub.
//! - [`ClipDispatch`] implements [`super::ingest::ClipAssembler`] by
//!   **forwarding the validated envelope to the WebView**. A clip is a
//!   programmatic single-note import, so assembly (provenance + images +
//!   wikilink resolution + importer-parity degrade, then seal via the normal
//!   `note_create`) runs WebView-side; this seam emits the
//!   `clipper://dispatch` event and blocks the relay thread for a tiny outcome
//!   delivered back through the [`clip_dispatch_complete`] command. NO new
//!   `clip_ingest` command.
//!
//! ## Why forwarding to the WebView is sound (not a new trust boundary)
//!
//! The four security gates (re-decode, token re-check, caps, rate-limit) plus
//! the locked short-circuit run in Rust in [`super::ingest::ingest_relayed_frame`]
//! BEFORE this seam is reached — authorization stays in Rust. The WebView is
//! already trusted with plaintext and already holds `note_create` /
//! `attachment_import`, so handing it a *validated* envelope adds no new reach.
//! The internal Rust↔WebView IPC is not a fresh ingress (TB6 already governs
//! WebView→Rust). And whenever the vault is unlocked — the clip precondition,
//! enforced by the locked short-circuit above — the WebView is guaranteed alive
//! (Myne has no headless/tray mode). The reply that crosses back is a single
//! `accepted | locked | error` string: no note id, no media counts, no
//! decrypted-state leak.
//!
//! [`spawn_relay_listener`] binds the owner-only (0600) Unix-domain-socket
//! listener under the app-data dir and serves connections on a dedicated
//! background thread for the app's lifetime. The host-mode process connects to
//! the SAME socket and forwards frames; every forwarded frame is re-validated
//! app-side as untrusted input (see [`super::ingest`]).
//!
//! ## Why a background std thread + a std mpsc round-trip
//!
//! The relay listener is blocking IO (`accept` / `read_frame`), so it runs on a
//! dedicated std thread (not a tokio worker) — the same shape as the app's
//! other long-lived timers. The slot-status read is async (it touches
//! `VaultRuntimeState`'s `tokio::sync::RwLock`), so [`AppVaultStatus`] bridges
//! to the Tauri async runtime via `tauri::async_runtime::block_on`. The clip
//! dispatch is NOT async: it emits a Tauri event and blocks the relay thread on
//! a `std::sync::mpsc` receiver with a 30 s timeout — no new async, no new
//! dependency. Because the call site is a std thread, neither blocking stalls a
//! tokio worker.
//!
//! ## No network fetch (SYNC-12)
//!
//! Nothing here fetches a URL. The dispatch path is event-emit → WebView; the
//! status path is a `Slot` read. There is no HTTP client, no socket dial beyond
//! the LOCAL Unix socket, no URL dereference anywhere on the ingest path.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::Duration;

#[cfg(desktop)]
use serde::Serialize;
#[cfg(desktop)]
use tauri::{AppHandle, Emitter, Manager, Runtime};

use super::envelope::{
    vault_status_from_slot_kind, HandoffEnvelope, VaultStatus, VaultStatusSource,
};
use super::ingest::{
    AssembleOutcome, BeginPairOutcome, ClipAssembler, PairDispatchOutcome, PairingDispatcher,
};

/// The Tauri event the relay emits to hand a validated clip envelope to the
/// WebView for assembly. **Contract — the TS half listens for this exact name.**
#[cfg(desktop)]
pub const CLIP_DISPATCH_EVENT: &str = "clipper://dispatch";

/// The Tauri event the relay emits to ask the WebView to show the pairing
/// Accept/Reject dialog for a relayed `Pair` bootstrap request.
/// **Contract — the TS pairing dialog listens for this exact name.** The
/// payload ([`PairingDispatchPayload`]) carries the relay's `request_id`, the
/// requesting `extension_id`, and the numeric `challenge` display string. The
/// dialog reports the user's decision back through the `pairing_dispatch_complete`
/// command keyed by the same `request_id`.
#[cfg(desktop)]
pub const PAIRING_DISPATCH_EVENT: &str = "pairing://dispatch";

/// The 30 s round-trip budget for the WebView to assemble + seal a clip and
/// report its outcome. On expiry the relay replies with a graceful
/// `clip_dispatch_timeout` error rather than hanging the connection.
// 30 s: the common clip is sub-second (the WebView assembles + seals immediately),
// but a clip that DOES carry `[[wikilinks]]` resolves against the decrypted note
// set, which on a large vault can take several seconds — a generous budget keeps
// such a clip from spuriously timing out. (The whole-vault load is skipped
// entirely for the common no-wikilink clip; see `resolveClipWikilinks`.)
const DISPATCH_TIMEOUT: Duration = Duration::from_secs(30);

/// Max concurrent clipper connection threads (M3). Each accepted connection is
/// served on its own thread that can block up to [`DISPATCH_TIMEOUT`]; without a
/// bound, a same-UID peer (the A14 / TB10 local attacker that can open the 0600
/// socket) could spawn thousands of connections to exhaust threads + memory.
/// Beyond this cap a new connection is DROPPED (closed immediately) rather than
/// queued — the legitimate clipper opens one short-lived connection per user
/// gesture, far under this ceiling.
const MAX_CONCURRENT_CONNECTIONS: usize = 16;

/// Idle read timeout on an accepted connection (M3). A peer that connects then
/// sends nothing — or stalls between frames — would otherwise pin its thread
/// until it disconnects. The legitimate flow sends a frame immediately and the
/// connection is short-lived, so this generous bound only reaps a stalled or
/// hostile peer. Distinct from [`DISPATCH_TIMEOUT`], which bounds the WebView
/// assembly wait (an in-process channel recv), not a socket read.
const CONNECTION_READ_IDLE: Duration = Duration::from_secs(60);

/// Decrements the active-connection counter when a connection thread ends —
/// including on an early return or a panic (Drop runs regardless), so a slot is
/// never leaked. Pairs with the `fetch_add` admission check at accept (M3).
struct ActiveConnGuard(std::sync::Arc<std::sync::atomic::AtomicUsize>);

impl Drop for ActiveConnGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
    }
}

/// The tiny outcome the WebView reports back for a dispatched clip.
///
/// `Locked` is included for completeness — the primary locked short-circuit is
/// the Rust [`VaultStatusSource`] check BEFORE dispatch, so a `Locked` arriving
/// here (a vault locked between the gate and the WebView's reply) is mapped to
/// an honest error, never a fake success.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The WebView assembled + sealed the clip note.
    Accepted,
    /// The vault was locked when the WebView tried to seal (a post-gate race);
    /// the relay maps this to an error here (the primary `locked` reply is the
    /// earlier Rust check).
    Locked,
    /// The WebView could not assemble the clip (importer error, seal failure).
    Error,
}

impl Outcome {
    /// Parse the wire `outcome` string from [`clip_dispatch_complete`]. Any
    /// unrecognized value is treated as [`Outcome::Error`] (fail-closed — an
    /// unknown outcome never becomes a fake `accepted`).
    fn from_wire(s: &str) -> Self {
        match s {
            "accepted" => Outcome::Accepted,
            "locked" => Outcome::Locked,
            _ => Outcome::Error,
        }
    }
}

/// The Tauri-managed registry of in-flight clip dispatches.
///
/// Each `assemble` mints a fresh `requestId`, inserts a one-shot
/// `std::sync::mpsc::Sender` under it, emits the dispatch event, and blocks on
/// the receiver. The [`clip_dispatch_complete`] command looks the id up,
/// removes the sender, and delivers the [`Outcome`]. The map only ever holds
/// the senders of dispatches a relay thread is actively blocked on; every path
/// (delivery, timeout, disconnect) removes the entry, so it cannot grow
/// unbounded.
#[derive(Default)]
pub struct ClipDispatchRegistry {
    next: AtomicU64,
    pending: Mutex<HashMap<String, Sender<Outcome>>>,
}

impl ClipDispatchRegistry {
    /// Mint a fresh, monotonically-increasing request id.
    fn mint_request_id(&self) -> String {
        let n = self.next.fetch_add(1, Ordering::Relaxed);
        format!("clip-{n}")
    }

    /// Register a one-shot sender under `request_id`.
    fn register(&self, request_id: String, tx: Sender<Outcome>) {
        self.pending
            .lock()
            .expect("clip dispatch registry mutex poisoned")
            .insert(request_id, tx);
    }

    /// Remove and return the sender registered under `request_id` (if any).
    fn take(&self, request_id: &str) -> Option<Sender<Outcome>> {
        self.pending
            .lock()
            .expect("clip dispatch registry mutex poisoned")
            .remove(request_id)
    }
}

/// The tiny outcome the WebView pairing dialog reports back for a dispatched
/// `Pair` request — the pairing analogue of [`Outcome`].
///
/// `Accepted` carries the WebView-minted scoped token (the ONLY thing that
/// crosses back on success). An `"accepted"` wire outcome with NO / EMPTY token
/// is mapped to [`PairResult::Error`] (fail-closed — a missing token is never
/// turned into a fake pairing).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PairResult {
    /// The user ACCEPTED and the WebView minted this scoped token (bound to the
    /// exact extension id). The relay maps it to [`PairDispatchOutcome::Paired`].
    Accepted(String),
    /// The user REJECTED. The relay maps it to [`PairDispatchOutcome::Rejected`].
    Rejected,
    /// The dialog failed / an unknown outcome / an `"accepted"` with no token.
    /// The relay maps it to a closed [`PairDispatchOutcome::Error`].
    Error,
}

impl PairResult {
    /// Parse the wire `outcome` + optional `token` from
    /// [`pairing_dispatch_complete`]. `"accepted"` REQUIRES a non-empty token —
    /// an `"accepted"` with no / empty token is [`PairResult::Error`]
    /// (fail-closed: never mint a fake pairing). `"rejected"` →
    /// [`PairResult::Rejected`]; anything else → [`PairResult::Error`].
    fn from_wire(outcome: &str, token: Option<String>) -> Self {
        match outcome {
            "accepted" => match token {
                Some(t) if !t.is_empty() => PairResult::Accepted(t),
                // An accept with no usable token is fail-closed — never a fake
                // pairing.
                _ => PairResult::Error,
            },
            "rejected" => PairResult::Rejected,
            _ => PairResult::Error,
        }
    }
}

/// The Tauri-managed registry of in-flight pairing dispatches — the pairing
/// analogue of [`ClipDispatchRegistry`].
///
/// Phase 1 (`begin_pair`) mints a fresh `requestId`, inserts a one-shot
/// `std::sync::mpsc::Sender` under it, emits the dispatch event, and stashes the
/// receiver (keyed by `extension_id`); phase 2 (`await_pair`) takes the receiver
/// back out and blocks on it. The [`pairing_dispatch_complete`] command looks the
/// id up, removes the sender, and delivers the [`PairResult`]. Every path
/// (delivery, timeout, disconnect) removes the entry, so the map cannot grow
/// unbounded.
#[derive(Default)]
pub struct PairingDispatchRegistry {
    next: AtomicU64,
    pending: Mutex<HashMap<String, Sender<PairResult>>>,
    /// The two-phase handshake spans TWO native-messaging connections (phase 1
    /// `PairBegin`, phase 2 `PairAwait`) served on SEPARATE relay threads. Phase
    /// 1 mints the channel and stashes its RECEIVER here, keyed by the (single)
    /// pending session's `extension_id`; phase 2 takes it back out to block on the
    /// WebView's Accept/Reject. The extension sends the two phases sequentially
    /// (await only after begin's challenge reply), so the stash is set before it
    /// is taken; a superseding begin overwrites (returns the stale entry so its
    /// sender is cleaned). The value pairs the `request_id` with the receiver so
    /// phase 2 can remove the sender from `pending` on a timeout — preserving the
    /// "every path removes the entry, no unbounded growth" invariant.
    outcome_rx: Mutex<HashMap<String, (String, Receiver<PairResult>)>>,
}

impl PairingDispatchRegistry {
    /// Mint a fresh, monotonically-increasing pairing request id.
    fn mint_request_id(&self) -> String {
        let n = self.next.fetch_add(1, Ordering::Relaxed);
        format!("pair-{n}")
    }

    /// Register a one-shot sender under `request_id`.
    fn register(&self, request_id: String, tx: Sender<PairResult>) {
        self.pending
            .lock()
            .expect("pairing dispatch registry mutex poisoned")
            .insert(request_id, tx);
    }

    /// Remove and return the sender registered under `request_id` (if any).
    fn take(&self, request_id: &str) -> Option<Sender<PairResult>> {
        self.pending
            .lock()
            .expect("pairing dispatch registry mutex poisoned")
            .remove(request_id)
    }

    /// Stash phase 1's `(request_id, outcome receiver)` keyed by `extension_id`,
    /// for phase 2 to retrieve. Returns the DISPLACED prior entry (if a
    /// superseding begin replaced one) so the caller can clean its now-orphaned
    /// sender out of `pending`.
    fn stash_outcome(
        &self,
        extension_id: String,
        request_id: String,
        rx: Receiver<PairResult>,
    ) -> Option<(String, Receiver<PairResult>)> {
        self.outcome_rx
            .lock()
            .expect("pairing dispatch registry mutex poisoned")
            .insert(extension_id, (request_id, rx))
    }

    /// Remove and return the `(request_id, outcome receiver)` stashed for
    /// `extension_id` (if any).
    fn take_outcome(&self, extension_id: &str) -> Option<(String, Receiver<PairResult>)> {
        self.outcome_rx
            .lock()
            .expect("pairing dispatch registry mutex poisoned")
            .remove(extension_id)
    }
}

/// [`VaultStatusSource`] backed by the running app's real `Slot`.
///
/// Answers `is-unlocked-status` from the live `VaultRuntimeState` slot via the
/// canonical [`vault_status_from_slot_kind`] projection (only `Slot::Unlocked`
/// → `Unlocked`; `Empty`/`Recovering` → `Locked`, fail-secure).
#[cfg(desktop)]
pub struct AppVaultStatus<R: Runtime> {
    app: AppHandle<R>,
}

#[cfg(desktop)]
impl<R: Runtime> AppVaultStatus<R> {
    /// Bind the status source to the running app.
    pub fn new(app: AppHandle<R>) -> Self {
        AppVaultStatus { app }
    }
}

#[cfg(desktop)]
impl<R: Runtime> VaultStatusSource for AppVaultStatus<R> {
    fn vault_status(&self) -> VaultStatus {
        let Some(state) = self
            .app
            .try_state::<crate::plugins::vault_unlock::state::VaultRuntimeState>()
        else {
            // No vault-runtime state managed yet → fail-secure Locked.
            return VaultStatus::Locked;
        };
        let kind = tauri::async_runtime::block_on(state.slot_kind_active());
        vault_status_from_slot_kind(kind)
    }
}

/// The serde payload of the [`CLIP_DISPATCH_EVENT`] — the validated envelope
/// projected to exactly the fields the WebView importer needs.
///
/// **Contract — these field names are load-bearing; the TS half deserializes
/// them verbatim.** `source_url` / `clip_date` are `""` when absent (never
/// `null`); `image_bytes` carries the raw per-image bytes only (NO per-image
/// filename — the WebView synthesizes display names).
#[cfg(desktop)]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClipDispatchPayload {
    /// The relay's correlation id for this dispatch (round-trips through
    /// `clip_dispatch_complete`).
    request_id: String,
    /// The clip's markdown body (provenance frontmatter is reproduced TS-side).
    markdown_body: String,
    /// How the clip was captured (kebab-case enum string; `""` if absent).
    capture_kind: String,
    /// The source page URL (`""` when the extension supplied none).
    source_url: String,
    /// The capture timestamp string (`""` when the extension supplied none).
    clip_date: String,
    /// In-page-captured image bytes (one inner `Vec<u8>` per image; the WebView
    /// names them).
    image_bytes: Vec<Vec<u8>>,
}

#[cfg(desktop)]
impl ClipDispatchPayload {
    /// Project a validated envelope onto the wire payload. `source_url` /
    /// `clip_date` collapse `None` → `""`; `capture_kind` serializes to its
    /// kebab-case string or `""` when absent.
    fn from_envelope(request_id: String, env: &HandoffEnvelope) -> Self {
        let capture_kind = env
            .capture_kind
            .map(|k| match k {
                super::envelope::CaptureKind::FullArticle => "full-article",
                super::envelope::CaptureKind::Selection => "selection",
                super::envelope::CaptureKind::Bookmark => "bookmark",
            })
            .unwrap_or("")
            .to_string();
        ClipDispatchPayload {
            request_id,
            markdown_body: env.markdown_body.clone(),
            capture_kind,
            source_url: env.source_url.clone().unwrap_or_default(),
            clip_date: env.clip_date.clone().unwrap_or_default(),
            image_bytes: env.image_bytes.clone(),
        }
    }
}

/// [`ClipAssembler`] that forwards the validated envelope to the WebView.
///
/// `assemble` mints a fresh `requestId`, registers a one-shot channel under it,
/// emits [`CLIP_DISPATCH_EVENT`] with the contract payload, then **blocks the
/// relay thread** on the receiver with a [`DISPATCH_TIMEOUT`]. The WebView runs
/// the importer pipeline (`assembleClip` → `note_create`) and reports the
/// outcome back through [`clip_dispatch_complete`], which delivers it on the
/// channel. On timeout / disconnect the seam returns a graceful
/// `clip_dispatch_timeout` error and removes the stale entry — the relay never
/// hangs.
#[cfg(desktop)]
pub struct ClipDispatch<R: Runtime> {
    app: AppHandle<R>,
}

#[cfg(desktop)]
impl<R: Runtime> ClipDispatch<R> {
    /// Bind the dispatch seam to the running app.
    pub fn new(app: AppHandle<R>) -> Self {
        ClipDispatch { app }
    }
}

#[cfg(desktop)]
impl<R: Runtime> ClipAssembler for ClipDispatch<R> {
    fn assemble(&self, env: &HandoffEnvelope) -> AssembleOutcome {
        let Some(registry) = self.app.try_state::<ClipDispatchRegistry>() else {
            // The registry is managed at setup; its absence is a wiring bug,
            // never normal flow. Fail closed with a closed label.
            return AssembleOutcome::Error("clip_dispatch_unavailable");
        };

        let request_id = registry.mint_request_id();
        let (tx, rx) = channel::<Outcome>();
        registry.register(request_id.clone(), tx);

        let payload = ClipDispatchPayload::from_envelope(request_id.clone(), env);
        if let Err(_e) = self.app.emit(CLIP_DISPATCH_EVENT, payload) {
            // The emit failed (no WebView listener yet) — clean up and report
            // a closed label, never hang. The vault-unlocked precondition means
            // the WebView is alive, so this is a defensive path.
            let _ = registry.take(&request_id);
            tracing::debug!(stage = "clip_dispatch", outcome = "emit_failed");
            return AssembleOutcome::Error("clip_dispatch_emit_failed");
        }

        // Block the relay thread for the WebView's outcome (30 s budget). On
        // ANY non-delivery path (timeout, sender dropped) clean up the stale
        // entry so the registry never leaks, and reply with a graceful error.
        let outcome = match rx.recv_timeout(DISPATCH_TIMEOUT) {
            Ok(outcome) => {
                // Delivery already removed the sender in `clip_dispatch_complete`.
                outcome
            }
            Err(_) => {
                // Timeout or disconnect: remove the (possibly still-present)
                // stale entry ourselves.
                let _ = registry.take(&request_id);
                tracing::debug!(stage = "clip_dispatch", outcome = "timeout");
                return AssembleOutcome::Error("clip_dispatch_timeout");
            }
        };

        match outcome {
            Outcome::Accepted => AssembleOutcome::Accepted,
            // A vault locked between the Rust gate and the WebView's seal: an
            // honest error here (the primary locked reply is the earlier check).
            Outcome::Locked => AssembleOutcome::Error("vault_not_unlocked"),
            Outcome::Error => AssembleOutcome::Error("clip_assembly_failed"),
        }
    }
}

/// The WebView→Rust command that delivers a dispatched clip's outcome back to
/// the blocked relay thread (TB6-governed; registered on the `clipper-pairing`
/// plugin's narrow ACL bundle).
///
/// **Contract — the TS half invokes `clip_dispatch_complete` with these exact
/// args.** `outcome ∈ {"accepted","locked","error"}`. Looks up + removes the
/// reply channel under `request_id` and delivers the parsed [`Outcome`]. The
/// WebView keeps the note id + media counts LOCAL (for its toast); they never
/// cross back — the reply stays a tiny decrypted-state-free confirm.
///
/// Returns `Ok(())` even when there is no pending dispatch for `request_id`
/// (the relay already timed out and removed it, or the id is stale): the
/// WebView's completion is best-effort and must not surface a confusing error.
/// `request_id` is an opaque relay correlation id, not a vault-stable tag, so
/// it is safe to bind; only bounded outcome labels are logged.
#[cfg(desktop)]
#[tauri::command]
pub async fn clip_dispatch_complete<R: Runtime>(
    app: AppHandle<R>,
    request_id: String,
    outcome: String,
) -> Result<(), ()> {
    let Some(registry) = app.try_state::<ClipDispatchRegistry>() else {
        tracing::debug!(stage = "clip_dispatch_complete", outcome = "no_registry");
        return Ok(());
    };
    let parsed = Outcome::from_wire(&outcome);
    if let Some(tx) = registry.take(&request_id) {
        // The relay thread may have already timed out and dropped the receiver;
        // a send error is benign (the entry is gone, nothing to deliver to).
        let _ = tx.send(parsed);
        tracing::debug!(stage = "clip_dispatch_complete", outcome = "delivered");
    } else {
        tracing::debug!(stage = "clip_dispatch_complete", outcome = "no_pending");
    }
    Ok(())
}

/// The serde payload of the [`PAIRING_DISPATCH_EVENT`] — what the WebView
/// pairing dialog needs to render.
///
/// **Contract — these field names are load-bearing; the TS dialog deserializes
/// them verbatim.** Unlike the clip payload, NONE of these are secrets in the
/// DENY sense — the `challenge` + `extension_id` are shown to the user BY
/// DESIGN. They are still never written to a `tracing` log (the relay logs only
/// bounded outcome labels + the opaque `request_id`-keyed stage).
#[cfg(desktop)]
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PairingDispatchPayload {
    /// The relay's correlation id for this dispatch (round-trips through
    /// `pairing_dispatch_complete`).
    request_id: String,
    /// The EXACT extension id requesting the pairing (shown in the dialog so
    /// the user knows which extension is asking).
    extension_id: String,
    /// The zero-padded numeric challenge display string the user compares
    /// against the extension before accepting.
    challenge: String,
}

/// [`PairingDispatcher`] that forwards a relayed two-phase pairing handshake to
/// the WebView pairing dialog — the pairing analogue of [`ClipDispatch`].
///
/// `begin_pair` (phase 1, `PairBegin`) foregrounds Myne, short-circuits a locked
/// vault to [`BeginPairOutcome::Locked`], else mints a fresh `requestId`,
/// registers a one-shot channel under it, opens a [`PairingState`] session bound
/// to that id (via [`PairingState::begin_pairing_with_request`] — its FIRST
/// production caller), emits [`PAIRING_DISPATCH_EVENT`], stashes the receiver, and
/// returns the numeric challenge to relay to the extension. `await_pair` (phase 2,
/// `PairAwait`) takes the stashed receiver and **blocks the relay thread** on it
/// with [`DISPATCH_TIMEOUT`]. The WebView shows the Accept/Reject dialog and
/// reports the outcome back through [`pairing_dispatch_complete`]. On timeout /
/// disconnect the seam returns a graceful `pairing_timeout` error — the relay
/// never hangs. Only bounded labels are logged (never the token, the extension
/// id, or the challenge).
///
/// [`PairingState`]: crate::plugins::clipper_pairing::state::PairingState
#[cfg(desktop)]
pub struct PairingDispatch<R: Runtime> {
    app: AppHandle<R>,
}

#[cfg(desktop)]
impl<R: Runtime> PairingDispatch<R> {
    /// Bind the pairing-dispatch seam to the running app.
    pub fn new(app: AppHandle<R>) -> Self {
        PairingDispatch { app }
    }
}

#[cfg(desktop)]
impl<R: Runtime> PairingDispatcher for PairingDispatch<R> {
    fn begin_pair(&self, extension_id: &str) -> BeginPairOutcome {
        use crate::plugins::clipper_pairing::state::PairingState;

        let Some(state) = self.app.try_state::<PairingState>() else {
            // The pairing state is managed at setup; its absence is a wiring
            // bug, never normal flow. Fail closed with a closed label.
            return BeginPairOutcome::Error("pairing_dispatch_unavailable");
        };
        let Some(registry) = self.app.try_state::<PairingDispatchRegistry>() else {
            return BeginPairOutcome::Error("pairing_dispatch_unavailable");
        };

        // Bring Myne to the FRONT regardless of lock state — the pair request
        // came from the browser (foreground), and the user must act HERE (either
        // unlock, or approve the dialog). Best-effort; the Tauri window calls
        // are safe to issue from the relay thread.
        self.bring_to_front();

        // A locked vault cannot approve the dialog (the WebView is on the Unlock
        // screen, no pairing dialog mounts). Reply `locked` immediately so the
        // extension prompts to unlock — no dangling pending session, no 30 s
        // timeout. The window is already foregrounded above so the user can act.
        if AppVaultStatus::new(self.app.clone()).vault_status() == VaultStatus::Locked {
            tracing::debug!(stage = "pair_dispatch", outcome = "locked");
            return BeginPairOutcome::Locked;
        }

        let request_id = registry.mint_request_id();
        let (tx, rx) = channel::<PairResult>();
        registry.register(request_id.clone(), tx);

        // Open the pending session bound to this request id so the dialog reads
        // the same id back out of `pairing_pending`. A CSPRNG failure here is a
        // closed label; clean up the channel so the registry never leaks.
        let challenge = match state
            .begin_pairing_with_request(extension_id.to_string(), Some(request_id.clone()))
        {
            Ok(c) => c,
            Err(_e) => {
                let _ = registry.take(&request_id);
                tracing::debug!(stage = "pair_dispatch", outcome = "challenge_unavailable");
                return BeginPairOutcome::Error("pairing_challenge_unavailable");
            }
        };

        let payload = PairingDispatchPayload {
            request_id: request_id.clone(),
            extension_id: extension_id.to_string(),
            challenge: challenge.display(),
        };
        if let Err(_e) = self.app.emit(PAIRING_DISPATCH_EVENT, payload) {
            // The emit failed (no WebView listener yet) — clean up and report a
            // closed label, never hang.
            let _ = registry.take(&request_id);
            tracing::debug!(stage = "pair_dispatch", outcome = "emit_failed");
            return BeginPairOutcome::Error("pairing_dispatch_emit_failed");
        }

        // Stash the (request_id, receiver) for phase 2 (`await_pair`) — which
        // arrives on a SEPARATE connection/thread — to block on. Keyed by
        // `extension_id` (the single pending session). The sender stays registered
        // under `request_id` for `pairing_dispatch_complete` to deliver the
        // WebView's decision. A superseding begin displaces a prior session — clean
        // its now-orphaned sender so `pending` cannot grow unbounded.
        if let Some((stale_request_id, _stale_rx)) =
            registry.stash_outcome(extension_id.to_string(), request_id.clone(), rx)
        {
            let _ = registry.take(&stale_request_id);
        }

        tracing::debug!(stage = "pair_dispatch", outcome = "challenge");
        BeginPairOutcome::Challenge(challenge.display())
    }

    fn await_pair(&self, extension_id: &str) -> PairDispatchOutcome {
        let Some(registry) = self.app.try_state::<PairingDispatchRegistry>() else {
            return PairDispatchOutcome::Error("pairing_dispatch_unavailable");
        };
        // Retrieve the (request_id, receiver) phase 1 stashed for this extension.
        // Its absence means phase 2 arrived without (or long after) a phase-1
        // begin — a closed label, never a hang.
        let Some((request_id, rx)) = registry.take_outcome(extension_id) else {
            tracing::debug!(stage = "pair_dispatch", outcome = "no_pending");
            return PairDispatchOutcome::Error("pairing_no_pending");
        };

        // Block the relay thread for the WebView's Accept/Reject (the dispatch
        // budget). On delivery `pairing_dispatch_complete` already removed the
        // sender; on timeout / dropped sender we remove it HERE so the `pending`
        // map cannot grow unbounded (the documented invariant).
        let result = match rx.recv_timeout(DISPATCH_TIMEOUT) {
            Ok(result) => result,
            Err(_) => {
                let _ = registry.take(&request_id);
                // Also clear the pending SESSION so a late Accept (clicked AFTER this
                // 30 s timeout) can't mint an undeliverable orphan token that lingers
                // in the registry showing a phantom "connected" extension while clips
                // still fail: pairing_accept then returns NoPendingPairing. A sub-ms
                // race at the exact boundary remains; the common late-click case closes.
                if let Some(state) = self
                    .app
                    .try_state::<crate::plugins::clipper_pairing::state::PairingState>()
                {
                    state.reject_pending();
                }
                tracing::debug!(stage = "pair_dispatch", outcome = "timeout");
                return PairDispatchOutcome::Error("pairing_timeout");
            }
        };

        match result {
            PairResult::Accepted(token) => PairDispatchOutcome::Paired(token),
            PairResult::Rejected => PairDispatchOutcome::Rejected,
            PairResult::Error => PairDispatchOutcome::Error("pairing_failed"),
        }
    }
}

#[cfg(desktop)]
impl<R: Runtime> PairingDispatch<R> {
    /// Bring the main window to the foreground (unminimize + show + focus),
    /// re-asserting screen-capture protection across the trip.
    /// Best-effort; the Tauri window calls are safe from the relay thread.
    ///
    /// myne-md/myne#483: the sequence lives in `screen_capture` rather than
    /// here because this was one of three copies of it, and the copy that had
    /// to re-apply protection after the `show()` was missing from all three.
    fn bring_to_front(&self) {
        crate::screen_capture::show_protected(&self.app, "clipper_raise");
    }
}

/// The WebView→Rust command that delivers a dispatched pairing request's outcome
/// back to the blocked relay thread (TB6-governed; registered on the
/// `clipper-pairing` plugin's narrow ACL bundle).
///
/// **Contract — the TS pairing dialog invokes `pairing_dispatch_complete` with
/// these exact args.** `outcome ∈ {"accepted","rejected"}`; on `"accepted"` the
/// dialog passes the WebView-minted scoped `token`. Looks up + removes the reply
/// channel under `request_id` and delivers the parsed [`PairResult`].
///
/// Returns `Ok(())` even when there is no pending dispatch for `request_id` (the
/// relay already timed out and removed it, or the id is stale): the WebView's
/// completion is best-effort and must not surface a confusing error.
/// `request_id` is an opaque relay correlation id, safe to bind; the `token` is
/// NEVER logged (only bounded outcome labels are traced).
#[cfg(desktop)]
#[tauri::command]
pub async fn pairing_dispatch_complete<R: Runtime>(
    app: AppHandle<R>,
    request_id: String,
    outcome: String,
    token: Option<String>,
) -> Result<(), ()> {
    let Some(registry) = app.try_state::<PairingDispatchRegistry>() else {
        tracing::debug!(stage = "pairing_dispatch_complete", outcome = "no_registry");
        return Ok(());
    };
    let parsed = PairResult::from_wire(&outcome, token);
    if let Some(tx) = registry.take(&request_id) {
        // The relay thread may have already timed out and dropped the receiver;
        // a send error is benign (the entry is gone, nothing to deliver to).
        let _ = tx.send(parsed);
        tracing::debug!(stage = "pairing_dispatch_complete", outcome = "delivered");
    } else {
        tracing::debug!(stage = "pairing_dispatch_complete", outcome = "no_pending");
    }
    Ok(())
}

/// Spawn the app-side relay listener on a dedicated background thread.
///
/// Binds the owner-only (0600) Unix-domain-socket listener under the app-data
/// dir and serves each incoming connection through the keyed re-validation path
/// ([`super::relay::serve_connection`]) backed by the app's REAL registry,
/// vault status, and the WebView-forwarding [`ClipDispatch`]. Runs for the
/// app's lifetime.
///
/// Best-effort: if the app-data dir cannot be resolved or the socket cannot be
/// bound, the relay is simply not available (a clip then fails honestly with
/// "open Myne to clip" — task 8 — rather than the app refusing to start). The
/// failure is logged with a closed label, never a path.
///
/// The authoritative [`TokenRegistry`] lives in the WebView-owned
/// [`crate::plugins::clipper_pairing::state::PairingState`]; the listener reads
/// a fresh snapshot per connection so a token minted / revoked in the dialog
/// takes effect on the next clip (revocation is desktop-authoritative — task 7
/// persists the registry; here it is the live in-memory one).
///
/// [`TokenRegistry`]: super::token::TokenRegistry
#[cfg(all(desktop, unix))]
pub fn spawn_relay_listener<R: Runtime>(app: AppHandle<R>) {
    let app_data_dir = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => {
            tracing::error!(
                stage = "clip_relay_listen",
                error = "app_data_dir_unresolved",
                "clipper relay not started: could not resolve app_data_dir"
            );
            return;
        }
    };
    // Ensure the app-data dir exists (the socket lives directly in it).
    let _ = std::fs::create_dir_all(&app_data_dir);
    let socket = super::relay::socket_path(&app_data_dir);

    std::thread::Builder::new()
        .name("clipper-relay".into())
        .spawn(move || {
            let listener = match super::relay::bind_listener(&socket) {
                Ok(l) => l,
                Err(e) => {
                    let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
                    tracing::error!(
                        stage = "clip_relay_bind",
                        io_failure_kind = ?kind,
                        "clipper relay listener could not bind; relay unavailable"
                    );
                    return;
                }
            };
            tracing::debug!(stage = "clip_relay_listen", event = "listening");

            // ONE process-global rate limiter, shared by every connection
            // thread (H2). The fixed-window flood budget must span ALL
            // connections: native messaging reconnects a fresh host process
            // (hence a fresh socket connection) per dispatch, so a
            // per-connection limiter handed each reconnect a brand-new full
            // budget — defeating the A14 flood bound the limiter exists to
            // enforce. `SharedRateLimiter::check` locks only for the brief
            // decision (never across the blocking dispatch), so a shared budget
            // does not serialize concurrent connections.
            let rate_limiter =
                std::sync::Arc::new(super::rate_limit::SharedRateLimiter::default());

            // Active-connection counter for admission control (M3): bound the
            // number of concurrent connection threads so a hostile same-UID peer
            // cannot exhaust threads/memory by opening connections en masse.
            let active = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));

            // Serve each connection on its OWN thread. A `serve_connection`
            // BLOCKS — up to the dispatch timeout while the WebView assembles a
            // clip, and until the extension disconnects between frames — so a
            // single-threaded listener let ONE slow/stuck connection freeze the
            // WHOLE relay: subsequent status reads, clips, and PAIRING requests
            // were never accepted, and queued connections timed out browser-side,
            // their reply writes failing with `io`. Per-connection threads make
            // every connection independent. The dispatch registries
            // (`ClipDispatchRegistry`/`PairingDispatchRegistry`) and the
            // `PairingState` are all mutex-guarded, and each `note_create` mints
            // its own id + atomic-writes, so concurrent service is sound.
            for incoming in listener.incoming() {
                let stream = match incoming {
                    Ok(s) => s,
                    Err(e) => {
                        let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
                        tracing::debug!(stage = "clip_relay_accept", io_failure_kind = ?kind);
                        continue;
                    }
                };
                // Admission control (M3): claim a slot, or drop the connection if
                // we are at the concurrency ceiling. `fetch_add` returns the prior
                // count; if that already met the cap we are over capacity, so give
                // the slot back and close the stream (the peer can retry).
                if active.fetch_add(1, std::sync::atomic::Ordering::AcqRel)
                    >= MAX_CONCURRENT_CONNECTIONS
                {
                    active.fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
                    tracing::debug!(stage = "clip_relay_accept", event = "over_capacity");
                    drop(stream); // close immediately — no thread spawned
                    continue;
                }
                let app = app.clone();
                let rate_limiter = std::sync::Arc::clone(&rate_limiter);
                let active = std::sync::Arc::clone(&active);
                let _ = std::thread::Builder::new()
                    .name("clipper-conn".into())
                    .spawn(move || {
                        // Release the admission slot when this thread ends (any path).
                        let _conn_guard = ActiveConnGuard(active);
                        let mut stream = stream;
                        // Idle read timeout (M3): a peer that sends nothing must not
                        // pin this thread. Set before the try_clone so the read half
                        // shares it (SO_RCVTIMEO is per-socket).
                        let _ = stream.set_read_timeout(Some(CONNECTION_READ_IDLE));
                        // A fresh registry snapshot per connection so a just-minted
                        // / just-revoked token is honoured immediately.
                        let registry = match app
                            .try_state::<crate::plugins::clipper_pairing::state::PairingState>()
                        {
                            Some(s) => s.registry_snapshot(),
                            None => super::token::TokenRegistry::new(), // empty ⇒ silent
                        };
                        // Cheap per-connection app-handle wrappers (just hold the handle).
                        let status = AppVaultStatus::new(app.clone());
                        let assembler = ClipDispatch::new(app.clone());
                        let pairing = PairingDispatch::new(app.clone());

                        let mut read_half = match stream.try_clone() {
                            Ok(r) => r,
                            Err(e) => {
                                let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
                                tracing::debug!(stage = "clip_relay_clone", io_failure_kind = ?kind);
                                return;
                            }
                        };
                        if let Err(e) = super::relay::serve_connection(
                            &mut read_half,
                            &mut stream,
                            &registry,
                            &status,
                            &rate_limiter,
                            &assembler,
                            &pairing,
                        ) {
                            let kind = crate::io_failure_kind::from_io_error_kind(e.kind());
                            tracing::debug!(stage = "clip_relay_serve", io_failure_kind = ?kind);
                        }
                    });
            }
        })
        .ok();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;

    #[test]
    fn outcome_parses_the_three_wire_strings() {
        assert_eq!(Outcome::from_wire("accepted"), Outcome::Accepted);
        assert_eq!(Outcome::from_wire("locked"), Outcome::Locked);
        assert_eq!(Outcome::from_wire("error"), Outcome::Error);
    }

    #[test]
    fn outcome_fails_closed_on_an_unknown_string() {
        // Any unrecognized outcome is Error — never a fake `accepted`.
        assert_eq!(Outcome::from_wire("yes-please-write-it"), Outcome::Error);
        assert_eq!(Outcome::from_wire(""), Outcome::Error);
        assert_eq!(Outcome::from_wire("ACCEPTED"), Outcome::Error);
    }

    #[test]
    fn registry_mints_distinct_monotonic_request_ids() {
        let reg = ClipDispatchRegistry::default();
        let a = reg.mint_request_id();
        let b = reg.mint_request_id();
        assert_ne!(a, b, "two mints → two distinct ids");
        assert_eq!(a, "clip-0");
        assert_eq!(b, "clip-1");
    }

    #[test]
    fn registry_register_then_take_round_trips_the_sender() {
        let reg = ClipDispatchRegistry::default();
        let (tx, rx) = channel::<Outcome>();
        reg.register("clip-7".into(), tx);
        // The first take returns the sender; delivering on it reaches the rx.
        let taken = reg.take("clip-7").expect("the registered sender");
        taken.send(Outcome::Accepted).unwrap();
        assert_eq!(rx.recv().unwrap(), Outcome::Accepted);
        // A second take of the same id is gone (delivery removes it).
        assert!(reg.take("clip-7").is_none(), "take removes the entry");
    }

    #[test]
    fn registry_take_of_an_unknown_id_is_none() {
        let reg = ClipDispatchRegistry::default();
        assert!(reg.take("never-registered").is_none());
    }

    #[test]
    fn payload_collapses_absent_provenance_to_empty_strings() {
        use crate::clipper::envelope::{CaptureKind, HandoffEnvelope, HandoffKind};
        let env = HandoffEnvelope {
            version: 1,
            kind: HandoffKind::CreateClip,
            extension_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            token: "deadbeef".into(),
            markdown_body: "# Body".into(),
            capture_kind: Some(CaptureKind::FullArticle),
            destination_folder: None,
            tags: Vec::new(),
            source_url: None,
            clip_date: None,
            image_bytes: vec![vec![0xDE, 0xAD]],
        };
        let payload = ClipDispatchPayload::from_envelope("clip-3".into(), &env);
        assert_eq!(payload.request_id, "clip-3");
        assert_eq!(payload.markdown_body, "# Body");
        assert_eq!(payload.capture_kind, "full-article");
        // Absent provenance collapses to "" (never null) per the contract.
        assert_eq!(payload.source_url, "");
        assert_eq!(payload.clip_date, "");
        // Image bytes ride through verbatim.
        assert_eq!(payload.image_bytes, vec![vec![0xDE, 0xAD]]);
    }

    #[test]
    fn payload_serializes_to_the_contract_field_names() {
        use crate::clipper::envelope::{CaptureKind, HandoffEnvelope, HandoffKind};
        let env = HandoffEnvelope {
            version: 1,
            kind: HandoffKind::CreateClip,
            extension_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            token: "deadbeef".into(),
            markdown_body: "body".into(),
            capture_kind: Some(CaptureKind::Selection),
            destination_folder: None,
            tags: Vec::new(),
            source_url: Some("https://example.com/a".into()),
            clip_date: Some("2026-06-20T12:00:00Z".into()),
            image_bytes: Vec::new(),
        };
        let payload = ClipDispatchPayload::from_envelope("clip-9".into(), &env);
        let json = serde_json::to_value(&payload).unwrap();
        // The TS half deserializes these EXACT camelCase keys.
        assert_eq!(json["requestId"], "clip-9");
        assert_eq!(json["markdownBody"], "body");
        assert_eq!(json["captureKind"], "selection");
        assert_eq!(json["sourceUrl"], "https://example.com/a");
        assert_eq!(json["clipDate"], "2026-06-20T12:00:00Z");
        assert!(json["imageBytes"].is_array());
        // No per-image filename crosses — only the bytes (NO `filename` key).
        assert!(json.get("imageFilenames").is_none());
    }

    // ---- pairing dispatch: PairResult wire parsing ----------------------

    #[test]
    fn pair_result_parses_accepted_with_a_token() {
        assert_eq!(
            PairResult::from_wire("accepted", Some("scopedtoken123".to_string())),
            PairResult::Accepted("scopedtoken123".to_string())
        );
    }

    #[test]
    fn pair_result_accepted_without_a_token_fails_closed_to_error() {
        // Fail-closed: an accept that carries no usable token is NEVER a fake
        // pairing — it maps to Error, not Accepted.
        assert_eq!(PairResult::from_wire("accepted", None), PairResult::Error);
        assert_eq!(
            PairResult::from_wire("accepted", Some(String::new())),
            PairResult::Error
        );
    }

    #[test]
    fn pair_result_parses_rejected() {
        assert_eq!(
            PairResult::from_wire("rejected", None),
            PairResult::Rejected
        );
        // A token alongside a rejection is ignored — still Rejected.
        assert_eq!(
            PairResult::from_wire("rejected", Some("ignored".to_string())),
            PairResult::Rejected
        );
    }

    #[test]
    fn pair_result_fails_closed_on_an_unknown_outcome() {
        // Any unrecognized outcome is Error — never a fake `accepted`, even when
        // a token rides along.
        assert_eq!(
            PairResult::from_wire("yes-please", Some("token".to_string())),
            PairResult::Error
        );
        assert_eq!(PairResult::from_wire("", None), PairResult::Error);
        assert_eq!(PairResult::from_wire("ACCEPTED", None), PairResult::Error);
    }

    // ---- pairing dispatch registry (mint / register / take) -------------

    #[test]
    fn pairing_registry_mints_distinct_monotonic_request_ids() {
        let reg = PairingDispatchRegistry::default();
        let a = reg.mint_request_id();
        let b = reg.mint_request_id();
        assert_ne!(a, b, "two mints → two distinct ids");
        assert_eq!(a, "pair-0");
        assert_eq!(b, "pair-1");
    }

    #[test]
    fn pairing_registry_register_then_take_round_trips_the_sender() {
        let reg = PairingDispatchRegistry::default();
        let (tx, rx) = channel::<PairResult>();
        reg.register("pair-7".into(), tx);
        let taken = reg.take("pair-7").expect("the registered sender");
        taken.send(PairResult::Accepted("t".into())).unwrap();
        assert_eq!(rx.recv().unwrap(), PairResult::Accepted("t".into()));
        // A second take of the same id is gone (delivery removes it).
        assert!(reg.take("pair-7").is_none(), "take removes the entry");
    }

    #[test]
    fn pairing_registry_take_of_an_unknown_id_is_none() {
        let reg = PairingDispatchRegistry::default();
        assert!(reg.take("never-registered").is_none());
    }
}
