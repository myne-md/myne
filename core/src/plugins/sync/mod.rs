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

// ── the Tauri-shaped third of the sync plugin (phase3-web-client task 79) ────
//
// Three of this plugin's 22 modules are typed on the host: `commands` (the
// `#[tauri::command]` layer plus the `AppHandle`-driven cycle runner),
// `loop_control` and `poke_listener` (which drive it). Everything else — the
// engine, reconcile, merge, the version-vector logic, `transport`'s trait, the
// wire codec, `token_store`, `state` — is target-independent and stays
// compiled, which is the point: the browser client reuses the *engine* and
// brings its own transport (`fetch` + `EventSource`, task 84), rather than
// porting an `AppHandle`-shaped command layer that has no browser meaning.
//
// This is where task 79 stops for `sync`. Giving these three host arms is a
// larger piece of work than the other 17 plugins combined — 10 of the crate's
// 11 emit sites, the only `app_config_dir` consumer, and six
// `Manager::try_state` singletons whose `None` case is a silent no-op — and it
// belongs with task 84, which is what will define what the browser side of each
// actually does.
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
pub mod commands;
pub mod config;
// "Does this device hold the whole vault?" (phase3-web-client task 89) — the
// gate on whole-corpus destructive sweeps, whose signal is the vault head's own
// `manifest_hash` rather than any approximation of it.
pub mod conflict;
pub mod corpus;
pub mod devices;
// One orchestrated sync cycle + its side effects, lifted out of the host-gated
// `commands` module by task 84. See the module doc for what was host-shaped and
// how each piece became a seam call — in particular why driving the cycle needed
// a NEW seam function (`task::run_blocking_future`) rather than either of the
// two that already existed.
pub mod cycle;
pub mod engine;
pub mod enroll;
pub mod fork_audit;
pub mod http_codec;
pub mod http_transport;
pub mod integrity;
// Ungated as of phase3-web-client task 84 — but only half of it compiles for a
// browser. `loop_control`'s decision state machine (`SyncScheduler`, the retry
// ladder, the constants) is pure and target-independent; its runtime glue
// (`spawn_sync_loop`, the three `Manager::try_state` signal cells) is gated
// per-item inside the file. The reason for the asymmetry is written there: the
// cadence, focus rate-limiting, push coalescing and extend-only backoff are the
// privacy-load-bearing answers, and a second client re-deriving them is how two
// clients end up disclosing at two different granularities.
pub mod loop_control;
// The no-bypass ratchet (MYND-650 task 4): a source-level guard asserting that
// every outbound socket in this directory is either routed through the proxy
// gate or written down with the reason it cannot leak a source IP. Test-only —
// it ships nothing, it just refuses to let a second socket appear unnoticed.
#[cfg(all(test, not(target_arch = "wasm32")))]
mod no_bypass;
pub mod orchestrator;
#[cfg(all(feature = "tauri-ipc", not(target_arch = "wasm32")))]
pub mod poke_listener;
// How far through materialising a vault this device is (phase3-web-client task
// 39). Three atomics rather than an event per note or a host threaded through
// `run_sync_cycle`: the readout has to be observable DURING the loop, and the
// loop deliberately has no host.
// The out-of-band fingerprint compare that has to accompany a TOFU pin captured
// over Tor (MYND-650 task 5). Host-only for the same reason `rustls_transport`
// is — it drives that module's handshake — and the single enforcement point
// both enrollment paths acquire a pin through.
#[cfg(not(target_arch = "wasm32"))]
pub mod pin_confirm;
pub mod prefs_classification;
pub mod prefs_merge;
pub mod progress;
// Where the transport is allowed to send bytes when device-local Tor routing is
// on (MYND-650). Shared rather than desktop-only even though only the desktop
// host can spawn the arti sidecar: the *decision* — and specifically the
// fail-closed refusal to ever connect directly while Tor mode is on — belongs
// next to the transport that has to honour it, not next to the process
// supervisor that feeds it.
pub mod proxy;
pub mod qr_join;
pub mod reconcile;
pub mod reconcile_policy;
// Raw-TLS transport, host-only. `rustls 0.23` with the `ring` provider has no
// wasm32 backend, and a browser has no raw TCP socket to put TLS on regardless
// — its transport is `fetch` + `EventSource` (phase3-web-client task 84). The
// `SyncTransport` trait in `transport` is already the seam, so gating stops at
// this one implementation: the trait, the engine and every caller stay
// target-independent.
#[cfg(not(target_arch = "wasm32"))]
pub mod rustls_transport;
#[cfg(test)]
mod sim;
// The SOCKS5 client half of Tor routing (MYND-650 task 3) — host-only for the
// same reason `rustls_transport` is: it is raw TCP, which a browser tab does
// not have. A web client that wants Tor uses Tor Browser (task 12), not an
// in-page tunnel.
#[cfg(not(target_arch = "wasm32"))]
pub mod socks5;
pub mod state;
// The status indicator's types + derivation, lifted out of the host-gated
// `commands` module by task 84 so the browser reports the same states from the
// same code. Only the `Manager`-shaped live-status CELL stayed behind.
pub mod status;
pub mod token_store;
pub mod transport;
// Per-NOTE "not yet on the server" (phase3-web-client task 23). A sibling of
// `status` rather than a field on it: `status` is a property of the device and
// this is a property of each note, and the two diverge in exactly the case that
// matters — an `Idle` device holding edits the server has never seen.
pub mod unsynced;

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
