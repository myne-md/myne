// SPDX-License-Identifier: AGPL-3.0-only
// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Native-messaging host mode (browser↔desktop clip channel, TB10): if
    // a browser launched us with `--native-messaging-host`, run the keyless
    // stdio loop and exit WITHOUT bringing up the WebView. A normal launch
    // returns `false` and proceeds to the Tauri app.
    #[cfg(desktop)]
    if myne_desktop_lib::run_native_messaging_host_if_requested() {
        return;
    }

    myne_desktop_lib::run()
}
