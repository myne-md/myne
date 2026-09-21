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

/// The beta-terms acceptance gate (myne-ops#15). The record and the comparison
/// live in the shared core; this is the command surface over them, joined to
/// this plugin so no new capability is needed.
pub mod legal;

/// Desktop-only device-local Tor routing toggle (MYND-650 task 6). The
/// preference lives in the shared core; acting on it means spawning an OS
/// process, which is why the command surface is here.
pub mod tor;

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
            commands::sync_unsynced_edits,
            commands::sync_materialisation_progress,
            commands::sync_now,
            commands::sync_person_unlock,
            commands::sync_person_lock,
            commands::sync_start_b2b_migration,
            commands::sync_invite_member,
            commands::sync_list_roster,
            commands::sync_remove_member,
            commands::sync_list_devices,
            commands::sync_account_status,
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
            commands::sync_verify_hold_begin,
            commands::sync_verify_hold_end,
            commands::sync_list_quarantine,
            commands::sync_read_quarantine,
            commands::sync_restore_quarantine,
            commands::sync_delete_quarantine,
            qr::sync_device_join_qr,
            legal::sync_beta_terms_accepted,
            legal::sync_accept_beta_terms,
            tor::sync_get_tor_routing,
            tor::sync_set_tor_routing,
            tor::sync_get_tor_state,
        ])
        .build()
}
