//! `snapshots` plugin (MYND-96, SYNC-9) — the read/management surface for
//! encrypted per-note version history: `snapshot_list`, `snapshot_preview`,
//! `snapshot_restore`, `snapshot_prune`.
//!
//! Snapshot logic deliberately spans two plugins: the **creation hook** +
//! prune-on-create + purge-on-delete live in the `notes` plugin (the
//! `note_update` / `note_delete` seam, where the pre-overwrite content is in
//! hand); this plugin owns only the read/management commands. It holds no
//! plugin-private state and borrows `VaultRuntimeState` (+ `SearchIndexState`
//! for restore) cross-plugin — the `vault_recover` / `notes` precedent.
//!
//! Restore reuses `notes::commands::note_snapshot_flush_with_dir` (force undo
//! point) + `note_update_with_dir` (overwrite) rather than duplicating the
//! write path; the creation hook is coalesced so there is no double snapshot
//! (SYNC-5).
//!
//! ACL: `snapshots:default` declares the four `allow-snapshot-*` permissions;
//! `permissions/snapshots/default.toml` + the `build.rs` `InlinedPlugin`
//! command mirror are lock-stepped (the mirror is load-bearing — without it
//! permissions flatten into `__app-acl__` and never match `plugin:snapshots|…`).
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

pub mod commands;
pub mod error;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `snapshots` plugin. Does NOT register `VaultRuntimeState` /
/// `SearchIndexState` — those singletons are owned at the host level; this
/// plugin borrows them via `Tauri::State<…>`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("snapshots")
        .invoke_handler(tauri::generate_handler![
            commands::snapshot_list,
            commands::snapshot_preview,
            commands::snapshot_restore,
            commands::snapshot_prune,
        ])
        .build()
}
