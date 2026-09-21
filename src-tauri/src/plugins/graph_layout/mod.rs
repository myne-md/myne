//! `graph_layout` Tauri plugin.
//!
//! Owns `graph_layout_read` + `graph_layout_write` — the persistence side of
//! the knowledge-graph view's laid-out node positions (the `vault.graph`
//! rebuildable cache, `MYG1`, `protocol.md` § 9.19). Both Slot::Unlocked-gated;
//! both borrow the existing `VaultRuntimeState` singleton (registered by
//! `vault_unlock::init`) via `tauri::State<...>`.
//!
//! ## Capability ACL
//!
//! `graph-layout:default` bundles `allow-graph-layout-read` +
//! `allow-graph-layout-write`, main-window-only.
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline".

// The `graph_layout` command core and its `error` enums moved to `myne-core`
// (shared with the mobile client — the `prefs`/`snapshots` extraction
// precedent). Re-exported so existing `crate::plugins::graph_layout::…` paths
// keep resolving. The `init()` wiring stays desktop-side.
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
