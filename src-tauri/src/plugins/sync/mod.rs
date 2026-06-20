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
pub mod reconcile;
pub mod reconcile_policy;
pub mod rustls_transport;
pub mod state;
pub mod taxonomy;
pub mod token_store;
pub mod transport;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `sync` plugin. Task-3 registers only the endpoint-config
/// command pair; later tasks extend the handler list.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("sync")
        .invoke_handler(tauri::generate_handler![
            commands::sync_get_endpoint,
            commands::sync_set_endpoint,
            commands::sync_status,
            commands::sync_now,
            commands::sync_list_devices,
            commands::sync_approve_device,
            commands::sync_remove_device,
            commands::sync_enroll,
            commands::sync_join_account,
        ])
        .build()
}
