mod atomic_write;
mod io_failure_kind;
mod paths;
mod plugins;
#[cfg(test)]
mod test_support;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(plugins::vault_creation::init())
        .plugin(plugins::vault_unlock::init())
        .plugin(plugins::vault_recover::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
