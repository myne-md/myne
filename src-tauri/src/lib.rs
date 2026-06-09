mod atomic_write;
mod auto_lock;
mod io_failure_kind;
mod paths;
mod plugins;
mod protocol_error_kind;
mod screen_capture;
mod search;
mod snapshot_policy;
mod snapshot_store;
#[cfg(test)]
mod test_support;
mod vault_id;
mod vault_meta_hash;
// SAFETY-CRITICAL eager boot migration `vault/` → `vaults/<id>/` (MYND-202
// task 4). Runs once at boot, before any routing, from the `setup` hook
// below — so every downstream probe/resolver sees only the post-migration
// layout. Idempotent: a no-op when no legacy `vault/` is present.
mod vault_migration;
// Discovery + best-effort registry cache. `discover_vaults` +
// `load_or_rebuild_registry` are now live via the `vault_list` IPC command
// (`plugins::vault_unlock::commands::vault_list_from_base`). The remaining
// not-yet-wired helper (`mint_unique_vault_id`, consumed by sub-feature 3's
// create path) carries its own per-item `#[cfg_attr(not(test), allow(dead_code))]`.
mod vault_registry;
mod vault_sweep;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Desktop-only: register `tauri-plugin-single-instance` FIRST so a
    // second launch is intercepted before any other plugin initializes
    // and is redirected to focus the existing window. Closes the
    // parallel-instance race source at process boundary; the slot-held
    // `vault_meta_bytes_hash` CAS in MYND-22 is the defensive second
    // layer. See `decisions.md` 2026-05-06 entry.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        use tauri::Manager;
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(plugins::vault_creation::init())
        .plugin(plugins::vault_unlock::init())
        .plugin(plugins::vault_recover::init())
        .plugin(plugins::vault_change_password::init())
        .plugin(plugins::vault_delete::init())
        .plugin(plugins::vault_repair::init())
        .plugin(plugins::prefs::init())
        .plugin(plugins::notes::init())
        .plugin(plugins::snapshots::init())
        .plugin(plugins::vault_indices::init())
        .plugin(plugins::attachments::init())
        .plugin(plugins::importer::init())
        // MYND-169: the `attachment://<id>` async custom-URI-scheme
        // handler — decrypts a `MYA1` blob in memory, re-sniffs the
        // content-type from the decrypted bytes, and serves ONLY an
        // allowlisted type (never text/html). Unlock-gated +
        // main-window-scoped inside the handler. Registered on the
        // Builder (not as a plugin invoke handler — custom protocols are
        // a builder-level concern). See `plugins::attachments::scheme`.
        .register_asynchronous_uri_scheme_protocol(
            plugins::attachments::scheme::SCHEME,
            plugins::attachments::scheme::handle,
        )
        .setup(|app| {
            use tauri::Manager;
            // MYND-202: SAFETY-CRITICAL eager boot migration `vault/` →
            // `vaults/<id>/`, run FIRST — before screen-capture init, before
            // any timer/state setup, and (by virtue of `setup` running during
            // `build()`) before the WebView/router is exposed or any vault
            // command can be invoked. The rest of the app therefore only ever
            // observes the post-migration layout (one on-disk invariant).
            //
            // Copy → fsync → verify-new → delete-old-LAST; the old `vault/` is
            // the untouched source of truth until the final delete, so an
            // interrupt at any step leaves it intact and the next boot
            // re-runs. A migration failure is logged with a closed-enum
            // reduction (paths + VaultId are DENY-listed) and is NON-FATAL:
            // the old `vault/` is left intact for the next boot to retry, so
            // the app still starts (the transitional resolver falls back to
            // the legacy `vault/` until a later boot completes the move).
            match app.path().app_data_dir() {
                Ok(base) => match vault_migration::migrate_legacy_vault(&base) {
                    Ok(_) => {}
                    Err(e) => {
                        let kind = vault_migration::migration_failure_kind(&e);
                        tracing::error!(
                            stage = "vault_migration_failed",
                            io_failure_kind = ?kind,
                            "boot migration failed; old vault/ left intact for next-boot retry"
                        );
                    }
                },
                Err(_) => {
                    tracing::error!(
                        stage = "vault_migration_app_data_dir",
                        "could not resolve app_data_dir for boot migration; skipping"
                    );
                }
            }
            // Apply screen-capture protection before `window.show()` so
            // the first frame is protected on macOS + Windows 10 build
            // 19041+. The main window is declared `"visible": false` in
            // `tauri.conf.json` so this is the only `show()` call.
            screen_capture::init(app)?;
            // MYND-121: start the authoritative, fail-closed idle-lock timer.
            // Runs for the process lifetime; no-op until a vault is Unlocked.
            auto_lock::spawn_idle_lock_timer(app.handle().clone());
            // MYND-29: app-level live in-RAM search-index state, updated
            // incrementally by the notes lifecycle (create/update/delete) and
            // queried by the search command; cleared on lock (Task 8).
            app.manage(search::SearchIndexState::default());
            // MYND-31: app-level live in-RAM VaultIndices state (wikilink
            // graph + backlinks + tag index), rebuilt on unlock by the
            // TS-orchestrated sweep and wiped on lock alongside the search
            // index. Twin of SearchIndexState above.
            app.manage(plugins::vault_indices::VaultIndicesState::default());
            // MYND-169: app-level live in-RAM attachment reference graph
            // (note → attachment-ids), the structural twin of
            // VaultIndicesState above. Rebuilt on unlock by the
            // TS-orchestrated note sweep (TODO(attachments reconcile) — see
            // `plugins::attachments::reconcile`) and wiped on lock alongside
            // the search index + VaultIndices.
            app.manage(plugins::attachments::AttachmentRefsState::default());
            // MYND-29 Task 7: periodic best-effort flush of the search index
            // to its encrypted `vault.search` blob while a vault is Unlocked
            // (no-op while locked). Bounds how much a hard quit / crash loses
            // to one flush interval; the next unlock reconciles the delta.
            // Managed state above must exist first (the timer reads it).
            plugins::notes::search_sync::spawn_periodic_flush_timer(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // MYND-29 Task 7: best-effort search-index flush on app exit so
            // the next unlock takes the fast path. Reconcile-on-unlock makes a
            // missed flush non-fatal (the next unlock re-indexes the
            // since-last-flush delta), so any failure here is swallowed. The
            // brief `block_on` is acceptable on the exit path (the run
            // callback is the main event-loop thread, not a tokio worker).
            if let tauri::RunEvent::ExitRequested { .. } = event {
                use tauri::Manager;
                if let Some(state) =
                    app_handle.try_state::<plugins::vault_unlock::state::VaultRuntimeState>()
                {
                    let app = app_handle.clone();
                    tauri::async_runtime::block_on(async move {
                        plugins::notes::search_sync::persist_search_index(&app, state.inner())
                            .await;
                    });
                }
            }
        });
}
