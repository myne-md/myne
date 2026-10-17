// SPDX-License-Identifier: AGPL-3.0
//! `vault-indices` plugin — mobile host (MYND-31 / A11 — VaultIndices).
//!
//! Owns the in-RAM wikilink graph + backlinks + tag index + typed-property
//! store for the open vault, plus its query/write/persist surface (the `MYI1`
//! `vault.indices` blob). A plaintext-derived RAM index rebuilt on unlock and
//! wiped on lock — the structural twin of the search index.
//!
//! The whole plugin core (state + commands + `MYI1` persist + error) lives in
//! `myne-core` (`myne_core::plugins::vault_indices`, shared with the desktop
//! client). Mobile registers the same 16 commands the desktop registers and
//! manages `VaultIndicesState` in `lib.rs` setup. Three sites move in lockstep
//! and nothing compares them: this list, `build.rs`'s `InlinedPlugin` mirror,
//! and `permissions/vault-indices/default.toml` (two edits, the `[default]`
//! array and a `[[permission]]` block). The count is written out as a weak stand
//! -in and it has been stale twice, which is the argument for adopting what
//! `plugins::agent` and `plugins::prefs` already carry: an in-crate
//! `#[cfg(test)]` parity check that `include_str!`s all three and compares them
//! both ways.
//!
//! The lock-teardown wipe is wired, and is NOT wired here: `myne-core` calls
//! `VaultLifecycleHooks::zeroize_vault_indices` at every slot-drop site, and
//! `crate::hooks::MobileHooks` implements it against the state `lib.rs`
//! manages (myne-md/myne#454). Until that body existed this comment claimed the
//! opposite and was believed: the index outlived the lock, so a second vault's
//! unlock stacked its records on top of the first vault's, which stayed
//! forever, and a locked vault's titles/folders/tags sat in RAM for the life of
//! the process. `scripts/check-lock-teardown.mjs` now fails if the body goes
//! back to empty.
//!
//! See: the main repo's `src-tauri/AGENTS.md` "Secret-handling logging
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
            commands::vault_indices_property_values,
            commands::vault_indices_property_keys,
            commands::vault_indices_persist,
            commands::vault_indices_hydrate,
            // MYND-620: the whole-vault line-task dump the mobile task surfaces read.
            // Shared with desktop through `myne-core`; mobile was missing only the
            // three registration sites.
            commands::vault_indices_tasks,
            // myne-md/myne#452: the two whole-vault picker dumps, missing here for
            // the same reason the task dump was. Both pickers already MOUNT on
            // mobile (`wikilinkPickerExtension` composes them unconditionally), so
            // an unregistered command is not a latent gap: `[[##` and `[[^^` opened
            // and listed nothing.
            commands::vault_indices_headings,
            commands::vault_indices_block_anchors,
        ])
        .build()
}
