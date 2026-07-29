//! `vault-indices` plugin — mobile host (MYND-31 / A11 — VaultIndices).
//!
//! Owns the in-RAM wikilink graph + backlinks + tag index + typed-property
//! store for the open vault, plus its query/write/persist surface (the `MYI1`
//! `vault.indices` blob). A plaintext-derived RAM index rebuilt on unlock and
//! wiped on lock — the structural twin of the search index.
//!
//! The whole plugin core (state + commands + `MYI1` persist + error) lives in
//! `myne-core` (`myne_core::plugins::vault_indices`, shared with the desktop
//! client). Mobile registers the same 12 commands and manages
//! `VaultIndicesState` in `lib.rs` setup. The lock-teardown wipe is a
//! desktop-only `hooks::VaultLifecycleHooks` side-effect; mobile installs
//! `NoopHooks`, so there is no teardown to wire here — the index simply lives
//! for the process while a vault is unlocked (same posture as the search index
//! being absent on mobile).
//!
//! See: the main repo's `src-tauri/CLAUDE.md` "Secret-handling logging
//! discipline".

// Re-exported for path-compatibility with any consumer referencing
// `crate::plugins::vault_indices::{commands, error, persist, state}` (mirrors the
// desktop re-export surface); `commands` is the only symbol `init()` registers.
#[allow(unused_imports)]
pub use myne_core::plugins::vault_indices::{commands, error, persist, state};

pub use myne_core::plugins::vault_indices::state::VaultIndicesState;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the mobile `vault-indices` plugin. The `VaultRuntimeState` it
/// borrows is registered by the `vault-unlock` plugin; its own
/// [`VaultIndicesState`] is managed in `lib.rs` setup (like desktop).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("vault-indices")
        .invoke_handler(tauri::generate_handler![
            commands::vault_indices_apply,
            commands::vault_indices_remove,
            commands::vault_indices_forward,
            commands::vault_indices_all_edges,
            commands::vault_indices_orphans,
            commands::vault_indices_backlink_candidates,
            commands::vault_indices_by_tag,
            commands::vault_indices_tag_tree,
            commands::vault_indices_note_properties,
            commands::vault_indices_property_values,
            commands::vault_indices_property_keys,
            commands::vault_indices_persist,
            commands::vault_indices_hydrate,
            // MYND-620: the whole-vault line-task dump the mobile task surfaces read.
            // Shared with desktop through `myne-core`; mobile was missing only the
            // three registration sites.
            commands::vault_indices_tasks,
        ])
        .build()
}
