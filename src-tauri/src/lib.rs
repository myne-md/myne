mod atomic_write;
mod io_failure_kind;
mod paths;
mod plugins;
mod protocol_error_kind;
mod screen_capture;
#[cfg(test)]
mod test_support;
mod vault_meta_hash;

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
        .plugin(plugins::notes::init())
        .setup(|app| {
            // Apply screen-capture protection before `window.show()` so
            // the first frame is protected on macOS + Windows 10 build
            // 19041+. The main window is declared `"visible": false` in
            // `tauri.conf.json` so this is the only `show()` call.
            screen_capture::init(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
