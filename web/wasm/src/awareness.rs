// SPDX-License-Identifier: AGPL-3.0-only
//! The web Worker's live-awareness state (epic live-collab, sub-feature 4).
//!
//! The browser counterpart of `myne-core`'s `awareness_listener`, minus the
//! supervisor: where the native client runs a dedicated thread that owns the
//! socket, the browser's down-path is the Worker's `fetch` stream
//! (`web/src/worker/sync-loop.ts`), which delivers each `data:` payload here
//! through [`deliver`] and knows nothing else about it.
//!
//! # What lives here, and what deliberately does not
//!
//! This module holds the two ends the editor bridge will use and nothing between
//! them:
//!
//! * an **inbox** ([`take_incoming`]) of received opaque frames, and
//! * an **outbox** bound to the SAME ~100 ms coalescer the native supervisor
//!   uses ([`myne_core::plugins::sync::awareness_coalesce`], `SYNC-5`), flushed
//!   as one `POST /sync/awareness` per window by [`flush`].
//!
//! The frames are **opaque**. This module never parses a frame, never derives a
//! room id and never seals anything: the room-id derivation and the frame AEAD
//! belong to `collab-awareness-crypto`, and this layer only moves bytes between
//! the wire and RAM. That is why the inbox and outbox hold `Vec<u8>` and a
//! `[u8; 16]` room tag, not a typed frame.
//!
//! # Why the coalescer is shared rather than re-derived in JS
//!
//! The ~100 ms floor is a privacy-load-bearing answer (`SYNC-5`): it bounds the
//! server-visible timing signal and keeps awareness under the relay's sub-bucket
//! refill. A browser that coalesced on its own clock would disclose at a
//! different granularity than the desktop, which is exactly the split the shared
//! machine exists to prevent (`core/AGENTS.md`, the `SyncScheduler` precedent).
//! So the outbox is a [`Coalescer`], the same type the native up-path drains.
//!
//! The module is host-compiled, like `sync_origin` and `capability`, so
//! `cargo test -p myne-web-wasm` covers the coalescing and the POST classification
//! on a machine with no browser.

use std::cell::RefCell;

use myne_core::host::HostCtx;
use myne_core::plugins::sync::awareness_coalesce::{encode_batch, Coalescer};
use myne_core::plugins::sync::http_transport::build_transport;
use myne_core::plugins::sync::transport::{HttpMethod, SyncTransport};

/// The awareness route (`server-protocol.md` §3, `SYNC-0`).
pub const AWARENESS_PATH: &str = "/sync/awareness";

/// Backoff after a 429 on the up-path POST: the `RateLimited` cadence (`SYNC-22`,
/// the awareness sub-bucket), not the plain transport ladder.
pub const POST_RATE_LIMIT_RETRY_MS: u64 = 60_000;

/// Bound on the received-frame inbox (self-contained snapshots; a newer one
/// supersedes an older, so drop-oldest is not data loss).
const INBOX_CAP: usize = 256;

/// The host seam this module reads its window clock from. `NoopHost` on the host
/// build, which is correct: there is no browser to coalesce for, and a frozen
/// clock simply never opens a window.
#[cfg(target_arch = "wasm32")]
fn host() -> &'static dyn HostCtx {
    &crate::host::WebHost
}
#[cfg(not(target_arch = "wasm32"))]
fn host() -> &'static dyn HostCtx {
    &myne_core::host::NoopHost
}

/// The outgoing coalescing buffer plus the `401`/`429` park deadline. A plain
/// struct (not a thread-local) so the host tests drive it directly.
#[derive(Debug, Default)]
pub struct AwarenessOutbox {
    coalescer: Coalescer<([u8; 16], Vec<u8>)>,
    park_until: u64,
}

impl AwarenessOutbox {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue `(room, opaque frame)` for the next window.
    pub fn push(&mut self, room: [u8; 16], frame: Vec<u8>, now_ms: u64) {
        self.coalescer.push((room, frame), now_ms);
    }

    /// The batch body to POST, or `None` when no window is due, the queue is
    /// empty, or the lane is parked. Draining happens only when a body is
    /// actually produced, so a parked lane does not lose its queued frames.
    pub fn take_due_body(&mut self, now_ms: u64) -> Option<Vec<u8>> {
        if now_ms < self.park_until || !self.coalescer.is_due(now_ms) {
            return None;
        }
        let batch = self.coalescer.take_batch();
        if batch.is_empty() {
            return None;
        }
        Some(encode_batch(&batch))
    }

    /// Park the lane until `until_ms` (a 429 sets this to `now + 60 s`).
    pub fn park_until(&mut self, until_ms: u64) {
        self.park_until = until_ms;
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.coalescer.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.coalescer.is_empty()
    }
}

thread_local! {
    /// The Worker's single outbox. `RefCell` and not a lock: a dedicated Worker
    /// is single-threaded, and every borrow is taken and dropped without
    /// crossing an await (the module owns no `.await` while borrowed).
    static OUTBOX: RefCell<AwarenessOutbox> = RefCell::new(AwarenessOutbox::new());
    /// Received opaque frame payloads awaiting the editor bridge.
    static INBOX: RefCell<Vec<Vec<u8>>> = const { RefCell::new(Vec::new()) };
}

/// Queue an outbound `(room, opaque frame)` pair. Called by the live bridge (the
/// transport's write-side seam, user story 8); the frame is opaque here.
pub fn push_outgoing(room: [u8; 16], frame: Vec<u8>) {
    let now = host().monotonic_millis();
    OUTBOX.with(|o| o.borrow_mut().push(room, frame, now));
}

/// Store one received opaque frame (the `data:` payload the Worker read off the
/// stream). Bounded drop-oldest.
pub fn deliver(payload: Vec<u8>) {
    INBOX.with(|i| {
        let mut i = i.borrow_mut();
        if i.len() >= INBOX_CAP {
            i.remove(0);
        }
        i.push(payload);
    });
}

/// Drain and return the received frames, oldest first. The editor bridge's
/// read-side seam (user story 8).
#[must_use]
pub fn take_incoming() -> Vec<Vec<u8>> {
    INBOX.with(|i| {
        let mut i = i.borrow_mut();
        core::mem::take(&mut *i)
    })
}

/// Map a POST status to the rate-limit class (`SYNC-22`). Only 429 parks.
#[must_use]
pub fn is_rate_limited(status: u16) -> bool {
    status == 429
}

/// POST one opaque batch through the browser transport. The body is opaque; the
/// transport never parses it.
pub fn post_batch(transport: &dyn SyncTransport, token_hex: &str, body: &[u8]) -> Option<u16> {
    transport
        .request(HttpMethod::Post, AWARENESS_PATH, body, Some(token_hex))
        .map(|r| r.status)
        .ok()
}

/// The endpoint and token the up-POST needs, from the same wasm export the down
/// stream uses (`sync_loop::poke_target`). Parsed here so the flush and the
/// reader agree on one shape.
async fn target() -> Option<(String, String)> {
    let raw = crate::sync_loop::poke_target().await?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let endpoint = v.get("endpoint")?.as_str()?.to_string();
    let token = v.get("token")?.as_str()?.to_string();
    Some((endpoint, token))
}

/// Drain the outbox through the shared ~100 ms coalescer and POST one batch if a
/// window is due. A 429 parks the lane on the rate-limit cadence (`SYNC-22`).
///
/// Called from `sync_loop::tick` on every Worker tick, gated on the vault being
/// unlocked, the up-path is part of the same gate the down-stream reader runs
/// under (`SYNC-30`). A no-op when nothing is queued, which is the ordinary
/// state until the editor bridge produces frames.
pub async fn flush(now_ms: u64) {
    let body = OUTBOX.with(|o| o.borrow_mut().take_due_body(now_ms));
    let Some(body) = body else {
        return;
    };
    let Some((endpoint, token)) = target().await else {
        return;
    };
    let Ok(transport) = build_transport(&endpoint) else {
        return;
    };
    if post_batch(&*transport, &token, &body) == Some(429) {
        // Re-read the clock: the POST took real time.
        let until = host()
            .monotonic_millis()
            .saturating_add(POST_RATE_LIMIT_RETRY_MS);
        OUTBOX.with(|o| o.borrow_mut().park_until(until));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use myne_core::plugins::sync::awareness_coalesce::AWARENESS_COALESCE_MS;
    use myne_core::plugins::sync::transport::FakeTransport;

    #[test]
    fn a_burst_collapses_to_one_post_body_per_window() {
        let mut out = AwarenessOutbox::new();
        out.push([1u8; 16], vec![0xDE, 0xAD], 0);
        out.push([2u8; 16], vec![0xBE, 0xEF], 50);
        assert!(out.take_due_body(50).is_none(), "window not yet elapsed");
        let body = out.take_due_body(AWARENESS_COALESCE_MS).expect("due");
        let s = String::from_utf8(body).expect("utf8");
        // Two frames, room hex and base64 verbatim, in one body.
        assert!(s.starts_with("{\"frames\":[{\"room_id_hex\":\"01010101010101010101010101010101\",\"frame_b64\":\"3q0=\""), "got {s}");
        assert!(
            s.contains("\"02020202020202020202020202020202\""),
            "got {s}"
        );
        assert!(out.take_due_body(1_000).is_none(), "queue drained");
    }

    #[test]
    fn a_parked_lane_keeps_its_frames_and_does_not_post() {
        let mut out = AwarenessOutbox::new();
        out.push([3u8; 16], vec![1], 0);
        out.park_until(5_000);
        assert!(out.take_due_body(100).is_none(), "parked");
        assert_eq!(out.len(), 1, "the frame survives the park");
        // Still parked past the window.
        assert!(out.take_due_body(4_999).is_none());
        // Un-parked and due: it posts.
        assert!(out.take_due_body(5_000).is_some());
    }

    #[test]
    fn an_empty_window_produces_no_body() {
        let mut out = AwarenessOutbox::new();
        assert!(out.take_due_body(u64::MAX).is_none(), "nothing queued");
        assert!(out.is_empty());
    }

    #[test]
    fn deliver_bounds_the_inbox_drop_oldest() {
        for i in 0..(INBOX_CAP + 5) {
            deliver(vec![i as u8]);
        }
        let got = take_incoming();
        assert_eq!(got.len(), INBOX_CAP, "bounded");
        assert_eq!(got[0], vec![5], "drop-oldest keeps the newest");
        assert!(take_incoming().is_empty(), "drain clears");
    }

    #[test]
    fn post_batch_sends_the_opaque_body_and_classifies_429() {
        let t = FakeTransport::new();
        t.on(HttpMethod::Post, AWARENESS_PATH, 200, b"{}".to_vec());
        let mut out = AwarenessOutbox::new();
        out.push([0xABu8; 16], vec![0xDE, 0xAD], 0);
        let body = out.take_due_body(AWARENESS_COALESCE_MS).expect("due");

        let status = post_batch(&t, "deadbeef", &body).expect("post");
        assert_eq!(status, 200);
        let seen = t.requests();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].1, AWARENESS_PATH);
        assert_eq!(seen[0].2, body, "the opaque body went verbatim");
        assert!(is_rate_limited(429));
        assert!(!is_rate_limited(200));
    }
}
