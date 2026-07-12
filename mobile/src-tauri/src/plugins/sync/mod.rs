//! `sync` plugin — mobile shim over the shared [`myne_core::plugins::sync`] core.
//!
//! The Phase-2 client sync engine (MYND-424–427) — commands, engine,
//! orchestrator, transport, conflict/reconcile, device enrollment — lives in the
//! shared `myne-core` crate (extracted from the desktop crate, decisions.md
//! 2026-07-07). This mobile crate keeps only the per-client wiring: [`init()`] +
//! `generate_handler!` + the `sync:default` capability entry
//! (`capabilities/default.json`). Same split the `notes`/`prefs`/`quick_unlock`
//! shims use — the command *bodies* are the identical compiled code the desktop
//! runs, so the mobile client has no second sync implementation to audit.
//!
//! ## Capability ACL (deny-by-default, SYNC-15)
//!
//! `sync:default` bundles all fifteen commands into ONE narrow, main-window-only
//! grant — a verbatim mirror of the already-shipped desktop `sync:default`
//! surface (no per-platform ACL, no per-command widening). The device-local
//! endpoint-config pair (`sync_get_endpoint`/`sync_set_endpoint`) is intentionally
//! reachable pre-auth (an operator configures the server before unlocking); the
//! push/pull/status/device commands are gated on an authenticated session inside
//! the shared core. The `build.rs` `InlinedPlugin` command list, the
//! `permissions/sync/default.toml` `commands.allow` entries, and the
//! `generate_handler!` list below MUST match exactly (all fifteen) — a mismatch
//! makes Tauri **fail closed** (the ACL resolver denies the invoke).
//!
//! ## R3 transport review-debt (registration ≠ verified crypto)
//!
//! Registering this plugin exposes enroll/push/pull over the sync transport,
//! whose TOFU cert-pinning path (`PinnedVerifier`) and the empty-channel-binding
//! SCRAM handshake are **not yet primitive-level reviewed** (grill R3, carried in
//! the epic sync-ledger). Exposing the surface on mobile does NOT discharge that
//! debt — no "-PLUS" / "verified cert-trust" claim may be made until R3 lands.
//! The endpoint UX surfaces TOFU pins honestly as *pinned-on-first-connect,
//! compare-across-devices*, never as *verified* (SYNC-43).
//!
//! See the main repo's `src-tauri/CLAUDE.md` "Secret-handling logging discipline"
//! for the DENY-list this wrapper (and the shared core) follow — no token /
//! password / phrase / root_key / items_key bytes in any `tracing`/log/serialize.

// Re-export the whole core sync surface so existing paths
// (`crate::plugins::sync::loop_control::SyncLocalChange`,
// `crate::plugins::sync::commands`, …) keep resolving unchanged in
// `hooks.rs`/`lib.rs` and the generated command handlers — the desktop shim's
// re-export pattern, mirrored here.
pub use myne_core::plugins::sync::*;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the mobile `sync` plugin — registers the client command surface
/// over the shared-core command bodies. All fifteen commands, matching the
/// `build.rs` `InlinedPlugin` + `permissions/sync/default.toml` lists exactly.
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
        ])
        .build()
}
