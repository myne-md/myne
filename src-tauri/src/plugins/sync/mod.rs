//! `sync` plugin — desktop shim over the shared [`myne_core::plugins::sync`] core.
//!
//! The Phase-2 client sync engine (MYND-424–427) — commands, engine,
//! orchestrator, transport, conflict/reconcile, device enrollment — was
//! extracted into the shared `myne-core` crate so the mobile client can reuse
//! the identical compiled code (decisions.md 2026-07-07, supersedes the
//! 2026-06-30 "sync stays per-client" scope). This desktop crate keeps only the
//! per-client wiring: [`init()`] + `generate_handler!` + the `sync:default`
//! capability entry (`src-tauri/capabilities/`). Same split the `notes`/`prefs`
//! shims use.
//!
//! ## Capability ACL (deny-by-default, SYNC-15)
//!
//! `sync:default` bundles the endpoint-config pair (main-window-only); the
//! push/pull/status/device commands are gated on an authenticated session.

// Re-export the whole core sync surface so existing paths
// (`crate::plugins::sync::loop_control::SyncLocalChange`,
// `crate::plugins::sync::commands`, …) keep resolving unchanged in
// `hooks.rs`/`lib.rs` and the generated command handlers.
pub use myne_core::plugins::sync::*;

/// Desktop-only QR device-join generation (MYND-466) — mobile scans, never
/// generates, so the `qrcode` dep + this command live here, not in the core.
pub mod qr;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the desktop `sync` plugin — registers the client command surface
/// over the shared-core command bodies.
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
            commands::sync_pending_conflicts,
            commands::sync_take_conflict,
            commands::sync_resolve_conflict,
            commands::sync_mark_tombstone,
            commands::sync_enroll,
            commands::sync_join_account,
            commands::sync_reset_local,
            commands::sync_head_fingerprint,
            commands::sync_list_quarantine,
            commands::sync_read_quarantine,
            commands::sync_restore_quarantine,
            commands::sync_delete_quarantine,
            qr::sync_device_join_qr,
        ])
        .build()
}
