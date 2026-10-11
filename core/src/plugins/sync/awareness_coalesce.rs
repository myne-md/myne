// SPDX-License-Identifier: AGPL-3.0
//! The live-awareness up-path coalescing state machine (epic live-collab;
//! `SYNC-5`). Shared and UNGATED: the native awareness supervisor and the web
//! Worker both bind to this one answer, so the ~100 ms floor cannot drift between
//! clients. Pure (no clock, no transport) so it is unit-testable per client.
//!
//! A burst of outgoing frames collapses to ONE `POST /sync/awareness` per window;
//! within a window a newer cursor/selection snapshot supersedes an older queued
//! one (drop-oldest when the bounded queue is full), which is not data loss
//! because snapshots are self-contained and a dropped content frame is caught up
//! by the durable blob plane.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;

/// The ~100 ms coalescing window (the ratified awareness floor, `SYNC-5`).
pub const AWARENESS_COALESCE_MS: u64 = 100;

/// Bound on the outgoing queue; a full queue drops its oldest entry.
pub const AWARENESS_OUTBOX_CAP: usize = 256;

/// A coalescing buffer for outgoing items. `push` at `now_ms` opens a window; a
/// flush is due once `window_ms` has elapsed since the window opened;
/// `take_batch` drains the queue and closes the window.
#[derive(Debug)]
pub struct Coalescer<T> {
    window_ms: u64,
    cap: usize,
    queue: Vec<T>,
    window_start: Option<u64>,
}

impl<T> Coalescer<T> {
    #[must_use]
    pub fn new(window_ms: u64, cap: usize) -> Self {
        Self {
            window_ms,
            cap,
            queue: Vec::new(),
            window_start: None,
        }
    }

    /// Enqueue `item`, opening a window if none is open, dropping the OLDEST entry
    /// first when the queue is full.
    pub fn push(&mut self, item: T, now_ms: u64) {
        if self.window_start.is_none() {
            self.window_start = Some(now_ms);
        }
        if self.queue.len() >= self.cap {
            self.queue.remove(0);
        }
        self.queue.push(item);
    }

    /// Whether the open window has elapsed as of `now_ms`.
    #[must_use]
    pub fn is_due(&self, now_ms: u64) -> bool {
        match self.window_start {
            Some(start) => now_ms.saturating_sub(start) >= self.window_ms,
            None => false,
        }
    }

    /// Drain the queue and close the window.
    pub fn take_batch(&mut self) -> Vec<T> {
        self.window_start = None;
        core::mem::take(&mut self.queue)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.queue.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.queue.is_empty()
    }
}

impl<T> Default for Coalescer<T> {
    fn default() -> Self {
        Self::new(AWARENESS_COALESCE_MS, AWARENESS_OUTBOX_CAP)
    }
}

/// Build the `POST /sync/awareness` body for a batch of `(room_id, frame)` pairs:
/// `{"frames":[{"room_id_hex":"…","frame_b64":"…"}, …]}`. The frame bytes are
/// base64'd **verbatim**; the transport never parses them. An empty batch is
/// `{"frames":[]}` (the caller does not POST it).
#[must_use]
pub fn encode_batch(batch: &[([u8; 16], Vec<u8>)]) -> Vec<u8> {
    let mut out = String::from("{\"frames\":[");
    for (i, (room, frame)) in batch.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"room_id_hex\":\"");
        for b in room {
            out.push_str(&format!("{b:02x}"));
        }
        out.push_str("\",\"frame_b64\":\"");
        out.push_str(&B64.encode(frame));
        out.push_str("\"}");
    }
    out.push_str("]}");
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_burst_collapses_to_one_batch_per_window() {
        let mut c: Coalescer<u8> = Coalescer::new(100, 8);
        // A burst inside one window.
        c.push(1, 0);
        c.push(2, 10);
        c.push(3, 90);
        assert!(!c.is_due(90), "window not elapsed");
        assert!(c.is_due(100), "window elapsed at the floor");
        let batch = c.take_batch();
        assert_eq!(batch, vec![1, 2, 3], "one batch carries the whole burst");
        assert!(!c.is_due(1000), "no window is open after a flush");
        assert!(c.take_batch().is_empty());
    }

    #[test]
    fn a_full_queue_drops_the_oldest_so_the_newest_snapshot_wins() {
        let mut c: Coalescer<u8> = Coalescer::new(100, 2);
        c.push(1, 0);
        c.push(2, 1);
        c.push(3, 2); // full -> drops 1
        assert_eq!(c.len(), 2);
        assert_eq!(c.take_batch(), vec![2, 3], "the newest two survive");
    }

    #[test]
    fn is_due_needs_an_open_window() {
        let c: Coalescer<u8> = Coalescer::new(100, 4);
        assert!(!c.is_due(u64::MAX), "no window is open before any push");
    }

    #[test]
    fn encode_batch_renders_room_hex_and_base64_frame() {
        let room = [0xABu8; 16];
        let body = encode_batch(&[(room, vec![0xDE, 0xAD])]);
        let s = String::from_utf8(body).expect("utf8");
        assert!(s.starts_with("{\"frames\":[{\"room_id_hex\":\"abababababababababababababababab\",\"frame_b64\":\"3q0=\"}]}"), "got {s}");
        assert_eq!(encode_batch(&[]), b"{\"frames\":[]}");
    }
}
