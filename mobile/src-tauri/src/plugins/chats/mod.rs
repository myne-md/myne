//! `chats` Tauri plugin (mobile shim).
//!
//! Owns the six AI-conversation storage commands (the `vault.chats` `MYM1`
//! catalog + `chats/<id-hex>` `MYJ1` per-conversation files, myne-md/myne#675,
//! `protocol.md` § 9.23 / § 9.24). All Slot::Unlocked-gated; all borrow the
//! existing `VaultRuntimeState` singleton (registered by `vault_unlock::init`)
//! via `tauri::State<...>`, plus `Hooks` for the synced-content
//! bump-local-change signal (Class-1 synced vault content, unlike the
//! never-synced graph cache).
//!
//! ## Capability ACL
//!
//! `chats:default` bundles the six allow-* permissions, main-window-only.
//!
//! See: `src-tauri/CLAUDE.md` (main repo) "Secret-handling logging discipline".

// The chats command core and its `error` enums live in `myne-core` (shared
// with the desktop + web clients). Re-exported so
// `crate::plugins::chats::{commands,error}` paths resolve like every other
// shared plugin; the `init()` wiring stays mobile-side.
#[allow(unused_imports)]
pub use myne_core::plugins::chats::{commands, error};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `chats` plugin. Borrows `VaultRuntimeState` via
/// `tauri::State<...>`; holds no plugin-private state.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("chats")
        .invoke_handler(tauri::generate_handler![
            commands::chats_create,
            commands::chats_append_turn,
            commands::chats_read,
            commands::chats_list,
            commands::chats_rename,
            commands::chats_delete,
        ])
        .build()
}
