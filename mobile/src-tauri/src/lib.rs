// Myne mobile — Tauri 2 host. Phase-1 vault + notes + prefs backend that
// consumes the shared `myne-core` crate (the single source of truth for the
// vault / notes / prefs plugin cores, extracted from the desktop crate) and the
// audited `protocol/` crate directly (no port). Desktop-only subsystems
// (clipper, screen-capture, auto-lock, backup, export, importer, sync, themes,
// attachments, workspace, spell, search) are not carried over — the core
// command cores trigger those side-effects through the
// `myne_core::hooks::VaultLifecycleHooks` seam, into which mobile installs
// `hooks::MobileHooks` (no-op for every desktop-only side-effect). The
// snapshots subsystem lives in `myne-core`, so `MobileHooks` wires its two
// snapshot hooks to the real snapshot store — a note overwrite/delete on
// mobile captures/purges `.myn` snapshots just like desktop. `vault-indices`
// (MYI1) IS shared from `myne-core` and registered here (its lock-teardown
// wipe is a desktop-only hooks side-effect).
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

mod hooks;
#[cfg(target_os = "ios")]
mod ios_chrome;
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
        .plugin(plugins::vault_repair::init())
        .plugin(plugins::prefs::init())
        .plugin(plugins::notes::init())
        .plugin(plugins::quick_unlock::init())
        .plugin(plugins::vault_indices::init())
        .plugin(plugins::search::init())
        .plugin(plugins::snapshots::init())
        .plugin(plugins::attachments::init())
        // MYND-211 (whole-vault plaintext markdown tree export): shared from
        // `myne-core`; the same two commands the desktop registers. The plugin
        // manages its own `ExportRuntime` cancel flag in its `.setup()`.
        .plugin(plugins::export::init())
        // Recovery-kit / account-number `.txt` save (vault-creation
        // PhraseStep / AccountStep): shared from `myne-core`; the same single
        // `save_secret_text` command the desktop registers. Narrow-seam file
        // write — the Rust core does the only IO and rejects any destination
        // inside the app-data / vault tree (TB6). Holds no plugin-private state.
        .plugin(plugins::secret_export::init())
        // MYND-169: the `attachment://<id>` async custom-URI-scheme handler.
        // A custom protocol handler is a builder-level concern (not a plugin
        // invoke handler); it decrypts the MYA1 blob in memory, re-sniffs the
        // content-type, and serves only an allowlisted type (never text/html —
        // the XSS-defense invariant). See `plugins::attachments::scheme`.
        .register_asynchronous_uri_scheme_protocol(
            plugins::attachments::scheme::SCHEME,
            plugins::attachments::scheme::handle,
        )
        .setup(|app| {
            // Install the mobile lifecycle hooks the shared `myne-core` command
            // cores take as `State<'_, myne_core::hooks::Hooks>`. Every desktop-
            // only side-effect (search, spell, sync, attachments, …) is a no-op,
            // EXCEPT the two snapshot hooks: the snapshots subsystem lives in
            // `myne-core`, so `MobileHooks::capture_snapshot` / `purge_note_snapshots`
            // drive the real snapshot store — a note overwrite/delete on mobile
            // captures/purges `.myn` snapshots just like desktop. Registered
            // before any command can run — mirrors the desktop `app.manage(hooks)`
            // wiring.
            app.manage::<myne_core::hooks::Hooks>(std::sync::Arc::new(hooks::MobileHooks));
            // MYND-31: app-level live in-RAM VaultIndices state (wikilink graph
            // + backlinks + tag index + typed properties), rebuilt on unlock by
            // the TS-orchestrated sweep. Mirrors the desktop `app.manage(...)`
            // wiring; the lock-teardown wipe is a desktop-only hooks side-effect
            // (mobile installs NoopHooks), so nothing tears it down here.
            app.manage(plugins::vault_indices::VaultIndicesState::default());
            // MYS1: app-level live in-RAM full-text search index (BM25). Fed by
            // the WebView via `search_index_replace` (the mobile client already
            // holds every note's plaintext, so it pushes the corpus down — no
            // Rust-side decryption/hydrate). Mirrors the desktop `app.manage(...)`
            // wiring; the lock-teardown wipe is a desktop-only hooks side-effect
            // (mobile installs NoopHooks), so nothing tears it down here — the
            // frontend re-pushes the corpus on the next unlock.
            app.manage(myne_core::search::SearchIndexState::default());
            // MYND-169: app-level live in-RAM attachment reference graph
            // (note → attachment-ids), rebuilt on unlock by the TS-orchestrated
            // note sweep. Mirrors the desktop `app.manage(...)` wiring; the
            // lock-teardown wipe is a desktop-only hooks side-effect (mobile
            // installs NoopHooks), so nothing tears it down here.
            app.manage(plugins::attachments::AttachmentRefsState::default());
            // Kill the native WKWebView keyboard "form assistant" bar (the
            // ‹ › ⌄ Done strip UIKit draws above the keyboard) — no web-side fix
            // exists for it. See `ios_chrome`. iOS-only; no-op elsewhere.
            #[cfg(target_os = "ios")]
            ios_chrome::suppress_keyboard_accessory_bar();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
