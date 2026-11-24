// SPDX-License-Identifier: AGPL-3.0-only
// No WebView-facing commands — the empty list is deliberate (Rust-only
// bridge; permission autogen is skipped for an empty command set). On Android
// targets `android_path` emits `cargo:android_library_path=…` so the app's
// `tauri-build` auto-includes `android/` in the generated gradle project
// (`gen/android/tauri.settings.gradle`); on iOS/desktop hosts this is inert.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS)
        .android_path("android")
        .build();
}
