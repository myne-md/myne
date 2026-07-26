//! `sync` Tauri plugin (MYND-424, the Phase 2 client sync engine namespace).
//!
//! This is the shared plugin namespace that MYND-424 (engine) + MYND-425
//! (device-mgmt) + MYND-426 (deletion/cache) + MYND-427 (fork-conflict) all add
//! commands to — one plugin, one capability entry, deny-by-default (SYNC-15).
//!
//! ## Task-3 surface (this landing)
//!
//! - [`config`] — the device-local **endpoint-config** surface (SYNC-14): the
//!   real self-host operator setting (TB5), reused by the MYND-428 E2E harness.
//!   Exposed as `sync_get_endpoint` / `sync_set_endpoint`.
//! - [`transport`] — the blind-relay [`transport::SyncTransport`] seam (SYNC-3).
//!   The real rustls + cert-pin + tls-exporter impl is task 2 (R3-gated, blocked
//!   on the `rustls` dependency decision); the engine builds against the trait,
//!   and [`transport::FakeTransport`] backs unit tests + the harness until then.
//!
//! ## Capability ACL (deny-by-default, SYNC-15)
//!
//! `sync:default` bundles ONLY `allow-sync-get-endpoint` +
//! `allow-sync-set-endpoint`, main-window-only. No data-plane command exists
//! yet; the push/pull/sync-now/status commands (later tasks) are added to the
//! same plugin and gated on an authenticated session.

// The transport trait + types are consumed by the pull/push paths (tasks 5/6);
// `FakeTransport` is exercised by this module's unit tests now. Until the engine
// lands, the production-side trait surface is otherwise unreferenced — same
// "consumed later" justification the `themes` module uses.
#![allow(dead_code)]

pub mod commands;
pub mod config;
pub mod conflict;
pub mod devices;
pub mod engine;
pub mod enroll;
pub mod fork_audit;
pub mod http_codec;
pub mod http_transport;
pub mod integrity;
pub mod loop_control;
pub mod orchestrator;
pub mod poke_listener;
pub mod prefs_classification;
pub mod prefs_merge;
pub mod qr_join;
pub mod reconcile;
pub mod reconcile_policy;
pub mod rustls_transport;
#[cfg(test)]
mod sim;
pub mod state;
pub mod token_store;
pub mod transport;

/// Byte slice → lowercase hex, in a single allocation (no per-byte `format!`).
/// The canonical hex encoder for the sync module — the per-file `hex` /
/// `hex_encode` / `hex_lower` helpers alias this so the logic lives in one place.
pub(crate) fn to_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from_digit((b >> 4) as u32, 16).expect("high nibble < 16"));
        s.push(char::from_digit((b & 0x0f) as u32, 16).expect("low nibble < 16"));
    }
    s
}
// NOTE: `init()` + `generate_handler!` + the `sync:default` capability live in
// each CLIENT's thin shim (desktop `src-tauri/src/plugins/sync/mod.rs`, mobile
// `myne-mobile/src-tauri/src/plugins/sync/mod.rs`), not here — the same
// per-client-wiring split the `notes`/`prefs` cores use. The command bodies +
// engine + transport all live in this shared core (decisions.md 2026-07-07,
// supersedes the 2026-06-30 "sync stays per-client" scope).
