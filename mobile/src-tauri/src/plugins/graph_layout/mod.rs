// SPDX-License-Identifier: AGPL-3.0
//! `graph_layout` Tauri plugin (mobile shim).
//!
//! Owns `graph_layout_read` + `graph_layout_write` — the persistence side of
//! the knowledge-graph view's laid-out node positions (the `vault.graph`
//! rebuildable cache, `MYG1`, `protocol.md` § 9.19). Both Slot::Unlocked-gated;
//! both borrow the existing `VaultRuntimeState` singleton (registered by
//! `vault_unlock::init`) via `tauri::State<...>` — this plugin holds NO
//! plugin-private state and needs NO hooks seam (no native side-effect, and a
//! Class-3 never-synced cache must not bump the local sync change counter).
//!
//! ## Capability ACL
//!
//! `graph-layout:default` bundles `allow-graph-layout-read` +
//! `allow-graph-layout-write`, main-window-only.
//!
//! See: `src-tauri/AGENTS.md` (main repo) "Secret-handling logging discipline".

// The `graph_layout` command core and its `error` enums live in `myne-core`
// (shared with the desktop client — the `prefs`/`snapshots` extraction
// precedent). Re-exported so `crate::plugins::graph_layout::{commands,error}`
// paths resolve like every other shared plugin; the `init()` wiring stays
// mobile-side.
#[allow(unused_imports)]
pub use myne_core::plugins::graph_layout::{commands, error};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `graph_layout` plugin. Borrows `VaultRuntimeState` via
/// `tauri::State<...>`; holds no plugin-private state.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("graph-layout")
        .invoke_handler(tauri::generate_handler![
            commands::graph_layout_read,
            commands::graph_layout_write,
        ])
        .build()
}
