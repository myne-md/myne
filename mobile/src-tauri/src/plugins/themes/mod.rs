//! `themes` Tauri plugin (mobile shim).
//!
//! Owns `themes_list` — and nothing else. The custom-theme palettes are vault
//! content (the encrypted `vault.themes` `MYT1` singleton, `protocol.md`
//! § 9.21): the desktop authors them, sync carries them here, and this plugin is
//! the reader mobile was missing. `Slot::Unlocked`-gated; borrows the existing
//! `VaultRuntimeState` singleton (registered by `vault_unlock::init`) via
//! `tauri::State<...>`, so this plugin holds NO plugin-private state and needs
//! NO hooks seam.
//!
//! ## Why one command of desktop's five
//!
//! `themes_import` / `themes_delete` / `themes_export` are the authoring
//! surface, and mobile does not author themes — leaving them unregistered is the
//! honest expression of that, and the smaller attack surface. `themes_read` is
//! omitted for a different reason: `themes_list` already returns each theme's
//! **palette**, because `vault.themes` is a single blob whose read decodes every
//! palette to answer a list at all. Both mobile callers — the picker and the
//! apply-at-unlock path resolving one stored name — are served by the list
//! alone, so `themes_read` would be a command with no caller.
//!
//! ## Capability ACL
//!
//! `themes:default` grants exactly `allow-themes-list`, main-window-only. There
//! is no mutating grant to withhold from a v0.2 non-main window, because there is
//! no mutating command.
//!
//! See: `src-tauri/CLAUDE.md` (main repo) "Secret-handling logging discipline".

// The `themes` command core (the `vault.themes` read/import/export/delete
// bodies) and its `error` enum live in `myne-core`, shared with the desktop
// client — the `prefs` / `graph_layout` precedent. Re-exported so
// `crate::plugins::themes::{commands,error}` paths resolve like every other
// shared plugin; the `init()` wiring stays mobile-side. Re-exporting the whole
// command module does NOT expose the unregistered commands over IPC: reachability
// is decided by `generate_handler!` below plus the ACL, not by module visibility.
#[allow(unused_imports)]
pub use myne_core::plugins::themes::{commands, error};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `themes` plugin. Borrows `VaultRuntimeState` via
/// `tauri::State<...>`; holds no plugin-private state.
///
/// The command list here, `build.rs`'s `InlinedPlugin` declaration, and
/// `permissions/themes/default.toml` MUST stay in lockstep — a mismatch fails
/// closed at app boot (the ACL resolver), not at compile time.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("themes")
        .invoke_handler(tauri::generate_handler![commands::themes_list])
        .build()
}
