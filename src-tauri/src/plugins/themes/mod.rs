//! `themes` Tauri plugin — desktop wiring of the shared `myne-core`
//! vault-content custom-theme core (MYND-486).
//!
//! Before MYND-486 this module was a **device-local plaintext** plugin over
//! `app_config_dir/themes/<name>.json` (custom-themes epic, MYND-297). It is now
//! a thin desktop shim over the vault-content core in
//! [`myne_core::plugins::themes`]: the palettes live in the encrypted
//! `vault.themes` (`MYT1`) singleton blob, `Slot::Unlocked`-gated and
//! `root_key`-derived (`protocol.md` § 9.21). The device-local files are retired
//! (no migration — pre-alpha; the old `app_config_dir/themes/` dir is
//! best-effort removed on boot in `lib.rs`).
//!
//! Mirrors the `prefs` shim: the command core + its error enum live in
//! `myne-core` (shared with mobile); this crate keeps only the `tauri::Builder`
//! `init()` / `generate_handler!` registration + the capability ACL. The command
//! module is re-exported so any `crate::plugins::themes::commands::…` path
//! resolves; the error type is reachable as `myne_core::plugins::themes::error`
//! (or the re-exported `ThemesError`).
//!
//! ## Capability ACL
//!
//! `themes:default` bundles the five vault-content commands (`themes_list` /
//! `themes_read` / `themes_import` / `themes_export` / `themes_delete`). All are
//! `Slot::Unlocked`-gated readers/writers of `vault.themes`; like the other
//! write-capable plugins, v0.2 multi-window MUST NOT grant the mutating grants
//! (`allow-themes-import` / `allow-themes-delete`) to any non-main window.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

// The `themes` command core (vault.themes read/import/export/delete) lives in
// `myne-core` (shared with the mobile client). Re-exported so existing
// `crate::plugins::themes::commands::…` paths keep resolving; the `init()`
// wiring stays desktop-side (like notes / prefs / vault_indices).
pub use myne_core::plugins::themes::commands;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `themes` plugin (MYND-486).
///
/// Binds the vault-content custom-theme commands over the encrypted
/// `vault.themes` blob. Holds NO plugin-private state — every command borrows
/// the `VaultRuntimeState` singleton (registered by `vault_unlock::init`) via
/// `tauri::State<...>` and resolves the active vault dir per call. The plugin
/// name in the ACL namespace is `themes`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("themes")
        .invoke_handler(tauri::generate_handler![
            commands::themes_list,
            commands::themes_read,
            commands::themes_import,
            commands::themes_export,
            commands::themes_delete,
        ])
        .build()
}
