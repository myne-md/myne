// Myne mobile — Tauri 2 host. Phase-1 vault + notes + prefs backend, mirrored
// from the desktop `src-tauri/` and reusing the audited `protocol/` crate
// directly (no port). The crypto / secret-handling discipline is preserved
// verbatim from desktop; desktop-only subsystems (clipper, screen-capture,
// auto-lock, backup, export, importer, snapshots, sync, themes, attachments,
// workspace, vault-indices, spell, search) are not carried over.
//
// See the main repo's `src-tauri/CLAUDE.md` "Secret-handling logging
// discipline" and `protocol/CLAUDE.md` for the rules these modules follow.

// The support modules (atomic_write, paths, text, vault_registry, …) and the
// notes/prefs error enums are copied VERBATIM from the desktop crate, so some
// helpers exist only for the desktop-only subsystems that were not carried over
// (export's `atomic_write_unclobbered`, snapshots' `snapshots_dir_for`, search's
// `split_nfc`/`turkish_lower`, the boot sweep's `sweep_empty_vault_dirs`, …).
// They are intentionally kept byte-for-byte rather than pruned; allow the
// resulting dead-code warnings crate-wide instead of editing the copies.
#![allow(dead_code)]

mod atomic_write;
mod io_failure_kind;
mod note_txn;
mod paths;
mod plugins;
mod protocol_error_kind;
#[cfg(test)]
mod test_support;
mod text;
mod vault_id;
mod vault_meta_hash;
mod vault_registry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(plugins::vault_creation::init())
        .plugin(plugins::vault_unlock::init())
        .plugin(plugins::vault_recover::init())
        .plugin(plugins::vault_change_password::init())
        .plugin(plugins::vault_delete::init())
        .plugin(plugins::prefs::init())
        .plugin(plugins::notes::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
