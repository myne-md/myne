//! `workspace` Tauri plugin (MYND-166).
//!
//! Owns `workspace_read` + `workspace_write` + `workspace_stage` — the
//! persistence side of the editor multi-tab/split-pane workspace. All
//! Slot::Unlocked-gated except the RAM-only stage; all borrow the existing
//! `VaultRuntimeState` singleton (registered by `vault_unlock::init`) via
//! `tauri::State<...>`. The descriptor is the frontend's serialized pane-tree
//! (open tabs + layout + cursors), sealed opaque under `session_state_key =
//! DeriveSubkey(root_key, SessionStateKey)` into `vault.workspace` (`MYW1`,
//! `protocol.md` § 9.7).
//!
//! Write cadence is graceful-exit-only (lock / auto-lock grace / quit) —
//! never per tab-switch — so the blob mtime never becomes an editor-activity
//! log (design grill 2026-06-01 Q1). This plugin exposes the primitives; the
//! frontend (`Editor.tsx`) decides when to call them.
//!
//! ## Capability ACL
//!
//! `workspace:default` bundles `allow-workspace-read` +
//! `allow-workspace-write` + `allow-workspace-stage`, main-window-only.
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline".

// The `workspace` command core and its `error` enums moved to `myne-core`
// (phase3-web-client task 65 — the web client had no pane layout at all while
// they lived here; the `graph_layout`/`snapshots` extraction precedent).
// Re-exported so existing `crate::plugins::workspace::…` paths keep resolving.
// The `init()` wiring stays desktop-side.
#[allow(unused_imports)]
pub use myne_core::plugins::workspace::{commands, error};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `workspace` plugin. Borrows `VaultRuntimeState` via
/// `tauri::State<...>`; holds no plugin-private state.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("workspace")
        .invoke_handler(tauri::generate_handler![
            commands::workspace_read,
            commands::workspace_write,
            commands::workspace_stage,
        ])
        .build()
}
