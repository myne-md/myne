// Myne mobile — Tauri 2 host. Phase-1 vault + notes + prefs backend that
// consumes the shared `myne-core` crate (the single source of truth for the
// vault / notes / prefs plugin cores, extracted from the desktop crate) and the
// audited `protocol/` crate directly (no port). Desktop-only subsystems
// (clipper, screen-capture, auto-lock, backup, export, importer, snapshots,
// sync, themes, attachments, workspace, vault-indices, spell, search) are not
// carried over — the core command cores trigger those side-effects through the
// `myne_core::hooks::VaultLifecycleHooks` seam, into which mobile installs the
// no-op `NoopHooks`.
//
// See the main repo's `src-tauri/CLAUDE.md` "Secret-handling logging
// discipline" and `protocol/CLAUDE.md` for the rules these modules follow.

// The crate-root support modules (atomic_write, paths, text, vault_registry, …)
// moved to `myne-core` (shared with the desktop client). Re-exported so existing
// `crate::<module>::…` paths keep resolving — the desktop `lib.rs` re-export
// pattern, mirrored here.
#[cfg(test)]
pub use myne_core::test_support;
pub use myne_core::{
    atomic_write, io_failure_kind, note_txn, paths, protocol_error_kind, text, vault_id,
    vault_meta_hash, vault_registry,
};

mod plugins;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use tauri::Manager;

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(plugins::vault_creation::init())
        .plugin(plugins::vault_unlock::init())
        .plugin(plugins::vault_recover::init())
        .plugin(plugins::vault_change_password::init())
        .plugin(plugins::vault_delete::init())
        .plugin(plugins::prefs::init())
        .plugin(plugins::notes::init())
        .setup(|app| {
            // Mobile has no desktop-only vault-lifecycle side-effects (search,
            // spell, snapshots, sync, attachments, …); install the no-op hooks
            // implementation the shared `myne-core` command cores take as
            // `State<'_, myne_core::hooks::Hooks>`. Registered before any
            // command can run — mirrors the desktop `app.manage(hooks)` wiring.
            app.manage::<myne_core::hooks::Hooks>(std::sync::Arc::new(myne_core::hooks::NoopHooks));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
