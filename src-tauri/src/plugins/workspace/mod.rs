//! `workspace` Tauri plugin (MYND-166).
//!
//! Owns `workspace_read` + `workspace_write` — the persistence side of the
//! editor multi-tab/split-pane workspace. Both Slot::Unlocked-gated; both
//! borrow the existing `VaultRuntimeState` singleton (registered by
//! `vault_unlock::init`) via `tauri::State<...>`. The descriptor is the
//! frontend's serialized pane-tree (open tabs + layout + cursors), sealed
//! opaque under `session_state_key = DeriveSubkey(root_key,
//! SessionStateKey)` into `vault.workspace` (`MYW1`, `protocol.md` § 9.7).
//!
//! Write cadence is graceful-exit-only (lock / auto-lock grace / quit) —
//! never per tab-switch — so the blob mtime never becomes an editor-activity
//! log (design grill 2026-06-01 Q1). This plugin exposes the primitives; the
//! frontend (`Editor.tsx`) decides when to call them.
//!
//! ## Capability ACL
//!
//! `workspace:default` bundles `allow-workspace-read` +
//! `allow-workspace-write`, main-window-only.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

pub mod commands;
pub mod error;

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
