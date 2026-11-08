// SPDX-License-Identifier: AGPL-3.0
// No WebView-facing commands. The empty list is deliberate (a Rust-only bridge;
// permission autogen is skipped for an empty command set). The Kotlin `saveFile`
// @Command is reached ONLY from the Rust backend via `run_mobile_plugin` (the
// deep-link precedent), so it is intentionally absent here and never exposed to
// the WebView / ACL.
//
// On Android targets `android_path` emits `cargo:android_library_path=…` so the
// app's `tauri-build` auto-includes `android/` in the generated gradle project
// (`gen/android/tauri.settings.gradle`); on iOS/desktop hosts this is inert.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
