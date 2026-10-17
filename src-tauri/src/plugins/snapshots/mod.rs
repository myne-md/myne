// SPDX-License-Identifier: AGPL-3.0
//! `snapshots` plugin (MYND-96, SYNC-9) — the read/management surface for
//! encrypted per-note version history: `snapshot_list`, `snapshot_preview`,
//! `snapshot_restore`, `snapshot_prune`.
//!
//! Snapshot logic deliberately spans two plugins: the **creation hook** +
//! prune-on-create + purge-on-delete live in the `notes` plugin (the
//! `note_update` / `note_delete` seam, where the pre-overwrite content is in
//! hand); this plugin owns only the read/management commands. It holds no
//! plugin-private state and borrows `VaultRuntimeState` (+ `Hooks` for restore)
//! cross-plugin — the `vault_recover` / `notes` precedent.
//!
//! Restore captures the pre-restore undo point through the desktop
//! `hooks::VaultLifecycleHooks::capture_snapshot` seam (force=true) and reuses
//! `note_update_with_dir` (overwrite) rather than duplicating the write path;
//! the creation hook is coalesced so there is no double snapshot (SYNC-5).
//!
//! ACL: `snapshots:default` declares the four `allow-snapshot-*` permissions;
//! `permissions/snapshots/default.toml` + the `build.rs` `InlinedPlugin`
//! command mirror are lock-stepped (the mirror is load-bearing — without it
//! permissions flatten into `__app-acl__` and never match `plugin:snapshots|…`).
//!
//! The plugin core (commands + error) moved to `myne-core`
//! (`myne_core::plugins::snapshots`, shared with the mobile client). Re-exported
//! so existing `crate::plugins::snapshots::{commands, error}::…` paths keep
//! resolving; this crate keeps only the desktop `init()`. The commands are
//! registered via the `myne_core::plugins::snapshots::commands::…` module path
//! so `generate_handler!` finds each command's hidden `__cmd__` items (a bare
//! `pub use` of the `#[tauri::command]` fns would drop them).
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline".

#[allow(unused_imports)]
pub use myne_core::plugins::snapshots::{commands, error};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `snapshots` plugin. Does NOT register `VaultRuntimeState` /
/// `Hooks` — those singletons are owned at the host level; this plugin borrows
/// them via `Tauri::State<…>`.
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
