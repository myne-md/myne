//! `graph_layout` Tauri plugin.
//!
//! Owns `graph_layout_read` + `graph_layout_write` — the persistence side of
//! the knowledge-graph view's laid-out node positions (the `vault.graph`
//! rebuildable cache, `MYG1`, `protocol.md` § 9.19). Both Slot::Unlocked-gated;
//! both borrow the existing `VaultRuntimeState` singleton (registered by
//! `vault_unlock::init`) via `tauri::State<...>`. The payload is the frontend's
//! serialized position map + a staleness marker, sealed opaque under
//! `graph_layout_key = DeriveSubkey(root_key, GraphLayoutKey)` into
//! `vault.graph`.
//!
//! Class 3 rebuildable cache — never synced, never backed up. A device that
//! lacks it (or finds it stale vs the current index) re-runs the force layout;
//! this plugin exposes the primitives and the frontend decides cadence
//! (write after a fresh layout / a node drag; read on graph mount).
//!
//! ## Capability ACL
//!
//! `graph-layout:default` bundles `allow-graph-layout-read` +
//! `allow-graph-layout-write`, main-window-only.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

pub mod commands;
pub mod error;

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
