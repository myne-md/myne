//! `vault_indices` Tauri plugin (MYND-31 / A11 — VaultIndices).
//!
//! Owns the in-RAM wikilink graph + backlinks + tag index for the open
//! vault, plus its query surface. The structural twin of the search
//! index (MYND-29): a plaintext-derived RAM index, rebuilt on unlock and
//! wiped on lock.
//!
//! Sibling to `vault_unlock`, `vault_recover`, `vault_change_password`,
//! `vault_delete`, `prefs`, and `notes`. The plugin holds NO
//! plugin-private auth state; it borrows `VaultRuntimeState` (registered
//! by `vault_unlock::init`) via `tauri::State<...>` for the Slot gate,
//! and its own [`VaultIndicesState`] is registered in `lib.rs` setup
//! (like `SearchIndexState`).
//!
//! ## Design
//!
//! - PRD: `agent-tooling/features/vault-indices/prd.md`
//! - Design session: `agent-tooling/sessions/design/2026-06-07-vault-indices.md`
//! - Architecture: Build-B (TS extraction, Rust struct/query/persistence),
//!   Model-2 (title-keyed edges = source of truth), plain-B resolution
//!   (single TS resolver). See the design session for full rationale.
//!
//! ## Capability ACL
//!
//! `vault-indices:default` bundles the write commands. The plugin name in
//! the ACL namespace is `vault-indices` (multi-word → kebab-case, like
//! `vault-creation` / `vault-unlock`); `build.rs` declares it as an
//! `InlinedPlugin` so permissions resolve under the `vault-indices:`
//! namespace.
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

/// Budget-gated benchmark harness (MYND-31 Task 7) — test-only; see `bench.rs`.
#[cfg(test)]
mod bench;
pub mod commands;
pub mod error;
pub mod state;

pub use state::VaultIndicesState;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, Runtime};

/// Best-effort zeroize + reset of the in-RAM VaultIndices on lock teardown
/// (MYND-31 Task 1). Resolves the app-managed [`VaultIndicesState`] and
/// wipes its plaintext-derived contents (titles / folders overwritten before
/// free). Wired into EVERY slot-drop site so the index never outlives the
/// slot: manual `vault_lock`, idle auto-lock teardown, and `vault_delete` —
/// the twin of `search_sync::zeroize_search_index`. Sync + infallible (no
/// `.await`, no IO); a missing managed state is a silent no-op.
pub fn zeroize_vault_indices<R: Runtime>(app: &AppHandle<R>) {
    if let Some(indices) = app.try_state::<VaultIndicesState>() {
        indices.clear();
    }
}

/// Construct the `vault-indices` plugin.
///
/// Binds the IPC commands declared in [`commands`]. Does NOT register
/// `VaultRuntimeState` (the unlock plugin owns it) nor
/// [`VaultIndicesState`] (registered in `lib.rs` setup so the lock paths
/// can borrow it to clear on lock).
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
        ])
        .build()
}
