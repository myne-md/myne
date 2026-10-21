// SPDX-License-Identifier: AGPL-3.0
//! `memory` Tauri plugin.
//!
//! Owns the six agent-memory storage commands (the `vault.agent-memory`
//! `MYN1` catalog + `memories/<id-hex>` `MYX1` per-entry files + the
//! `vault.personality` `MYZ1` singleton, myne-md/myne#697, `protocol.md`
//! § 9.25 / § 9.26 / § 9.27). All Slot::Unlocked-gated; all borrow the
//! existing `VaultRuntimeState` singleton (registered by `vault_unlock::init`)
//! via `tauri::State<...>`, plus `Hooks` for the synced-content
//! bump-local-change signal.
//!
//! ## Capability ACL
//!
//! `memory:default` bundles the six allow-* permissions, main-window-only.
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline".

// The memory command core and its `error` enums live in `myne-core` (shared
// with the web + mobile clients). Re-exported so
// `crate::plugins::memory::…` paths resolve; the `init()` wiring stays
// desktop-side.
#[allow(unused_imports)]
pub use myne_core::plugins::memory::{commands, error};

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `memory` plugin. Borrows `VaultRuntimeState` via
/// `tauri::State<...>`; holds no plugin-private state.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("memory")
        .invoke_handler(tauri::generate_handler![
            commands::memory_list,
            commands::memory_read,
            commands::memory_write,
            commands::memory_delete,
            commands::memory_seed_apply,
            commands::personality_read,
            commands::personality_write,
        ])
        .build()
}
