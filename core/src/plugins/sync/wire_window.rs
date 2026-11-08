// SPDX-License-Identifier: AGPL-3.0
//! The cross-repo sync window, checked without a server checkout.
//!
//! `scripts/check-stream-timeout-drift.mjs` compares these four numbers by
//! scraping Go and Rust sources in two repositories, so it reports
//! "NOTHING COMPARED" wherever the companion is absent - which is every push in a
//! fresh worktree. This module pins the server's numbers in
//! `wire-window.json` instead, so `cargo test` answers the ordinary question on
//! every run and the scrape stays as the release-time live cross-check.
//!
//! The pinned file records the server commit it came from. Its staleness is
//! therefore visible rather than silent: a server change that is not re-emitted
//! moves the two apart, and the next re-emit is what closes the gap.

use super::orchestrator::{FETCH_WINDOW_MAX_BLOBS, FETCH_WINDOW_MAX_BYTES};
use super::stream_supervisor::SSE_READ_TIMEOUT;

#[derive(Debug, serde::Deserialize)]
struct WireWindow {
    emitted_from: String,
    sse_heartbeat_s: u64,
    awareness_heartbeat_s: u64,
    max_blob_fetch_ids: usize,
    max_blob_fetch_bytes: usize,
}

fn window() -> WireWindow {
    serde_json::from_str(include_str!("wire-window.json"))
        .expect("wire-window.json must parse; it is generated, so a parse failure means a bad emit")
}

#[test]
fn the_client_window_matches_the_published_server_window() {
    let w = window();
    assert_eq!(
        FETCH_WINDOW_MAX_BLOBS, w.max_blob_fetch_ids,
        "the client asks for a different blob count than {} allows",
        w.emitted_from
    );
    assert_eq!(
        FETCH_WINDOW_MAX_BYTES, w.max_blob_fetch_bytes,
        "the client asks for a different byte window than {} allows",
        w.emitted_from
    );
}

/// A read timeout at or below the server's heartbeat turns every idle stream into
/// a dead connection, and the supervisor then reconnects in a loop. The margin is
/// the whole reason the client value is not the server value.
#[test]
fn the_client_read_timeout_outlives_both_server_heartbeats() {
    let w = window();
    let timeout = SSE_READ_TIMEOUT.as_secs();
    for (what, beat) in [
        ("SSE", w.sse_heartbeat_s),
        ("awareness", w.awareness_heartbeat_s),
    ] {
        assert!(
            timeout > beat,
            "SSE_READ_TIMEOUT is {timeout}s but the {what} heartbeat is {beat}s: an idle \
             stream would time out before its first keepalive"
        );
    }
}
