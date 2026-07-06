//! `snapshots` plugin — mobile host (MYND-96, SYNC-9).
//!
//! The read/management surface for encrypted per-note version history:
//! `snapshot_list`, `snapshot_preview`, `snapshot_restore`, `snapshot_prune`.
//! The whole plugin core (commands + error) lives in `myne-core`
//! (`myne_core::plugins::snapshots`, shared with the desktop client); mobile
//! registers the same 4 commands. The plugin holds no plugin-private state — it
//! borrows the `VaultRuntimeState` singleton (registered by `vault-unlock::init`)
//! and, on restore, the `Hooks` singleton (mobile installs `NoopHooks` in
//! `lib.rs` setup).
//!
//! The snapshot **creation hook** + purge are desktop-only
//! `hooks::VaultLifecycleHooks` side-effects; mobile's `NoopHooks` makes them
//! no-ops, so mobile never auto-creates snapshots yet (a documented follow-up).
//! The 4 commands still compile + register cleanly and operate over an empty
//! snapshots dir (list/prune return empty/0; preview/restore return
//! `SnapshotNotFound` for any id).
//!
//! See: the main repo's `src-tauri/CLAUDE.md` "Secret-handling logging
//! discipline".

// Re-exported for path-compatibility with any consumer referencing
// `crate::plugins::snapshots::{commands, error}` (mirrors the desktop re-export
// surface); the commands are registered via the `myne_core` module path below
// so `generate_handler!` finds each command's hidden `__cmd__` items.
#[allow(unused_imports)]
pub use myne_core::plugins::snapshots::{commands, error};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the mobile `snapshots` plugin. Does NOT register
/// `VaultRuntimeState` / `Hooks` — those singletons are owned at the host level
/// (the `vault-unlock` plugin + `lib.rs` setup); this plugin borrows them via
/// `Tauri::State<…>`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("snapshots")
        .invoke_handler(tauri::generate_handler![
            myne_core::plugins::snapshots::commands::snapshot_list,
            myne_core::plugins::snapshots::commands::snapshot_preview,
            myne_core::plugins::snapshots::commands::snapshot_restore,
            myne_core::plugins::snapshots::commands::snapshot_prune,
        ])
        .build()
}
