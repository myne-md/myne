//! Vault-delete Tauri plugin (MYND-105).
//!
//! Owns the standalone `vault_delete::vault_delete` IPC command —
//! one-shot destruction of the local vault. Zeroizes in-memory keys
//! (via `state.take()` on `Slot::Unlocked` / `Slot::Recovering`),
//! then recursively unlinks every file under `<app_data_dir>/vault/`.
//!
//! Sibling to `vault_unlock`, `vault_recover`, and
//! `vault_change_password`. All four plugins share `VaultRuntimeState`
//! (registered at the host level by `vault_unlock::init()`);
//! vault_delete borrows via `Tauri::State<VaultRuntimeState>` and
//! holds no plugin-private state (no `state.rs`).
//!
//! Plugin layout (Pl1 per the MYND-105 grill Q8-S1): own plugin
//! sibling to `vault_unlock`, NOT bundled into `vault_unlock` (which
//! is auth-ops-focused). The destruction semantic class warrants
//! its own ACL surface so audit readers see the destroy capability
//! under its own permission file rather than buried in an
//! auth-ops allow-list.
//!
//! Design history:
//! - PRD: `myne-agents/features/backend-vault-delete/prd.md`
//! - Grilling: `myne-agents/sessions/grill/2026-05-26-mynd-105-vault-delete.md`
//!   Q1–Q9 (cryptographic-erase claim, slot precondition matrix,
//!   R3 escape, partial-fail posture, artefact taxonomy, plugin
//!   layout, test surface)
//! - Tasks: `myne-agents/features/backend-vault-delete/tasks.md`
//! - decisions.md: 2026-05-26 entries (a) crypto-erase claim, (b) Slot precondition matrix + R3, (c) partial-fail posture + v0.2 vault_repair (Plane MYND-159), (d) VaultArtifactsPresent rename
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

// The vault-delete command core + `error` moved to `myne-core` (shared with the
// mobile client). The backup-preempt + delete-proceeded teardown side-effects
// attach through the `hooks::VaultLifecycleHooks` seam; the recursive unlink
// uses the shared `myne_core::vault_sweep` pipeline. Re-exported so existing
// `crate::plugins::vault_delete::{commands,error}::…` paths keep resolving.
// The `init()` wiring stays desktop-side.
pub use myne_core::plugins::vault_delete::commands;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `vault-delete` plugin.
///
/// Binds the single IPC command [`commands::vault_delete`]. Does NOT
/// register `VaultRuntimeState` — the unlock plugin owns the
/// runtime-state singleton; vault_delete borrows via `Tauri::State<...>`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("vault-delete")
        .invoke_handler(tauri::generate_handler![commands::vault_delete])
        .build()
}
