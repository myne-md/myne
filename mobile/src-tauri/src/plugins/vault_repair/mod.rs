//! Vault-repair Tauri plugin (MYND-159) — mobile port of the desktop plugin.
//!
//! In-app cleanup of orphan vault artefacts left under `<app_data_dir>/vault/`
//! by a partial-fail `vault_delete` (file locks during the unlink loop). When
//! `vault.meta` was removed but orphan `.myn` blobs + directories survived,
//! every other lifecycle command refuses, stranding the user. This plugin is the
//! in-app escape hatch.
//!
//! Sibling to `vault_delete`. Owns its own ACL surface (`vault-repair:default`)
//! so the destroy-adjacent capability is auditable under its own permission
//! file. Shares `VaultRuntimeState` (registered by `vault_unlock::init()`) for
//! the sweep's `auth_permits` gating; drives the same `myne_core::vault_sweep`
//! pipeline as `vault_delete`, differing only in precondition and
//! `RootDisposal::KeepRoot`.
//!
//! The command logic is identical to the desktop plugin — the only divergence is
//! the `vault_sweep` path (mobile references `myne_core::vault_sweep` directly).
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

pub mod commands;
pub mod error;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `vault-repair` plugin.
///
/// Binds the read-only [`commands::vault_residue_scan`] (detection) and the
/// destructive [`commands::vault_repair`] (sweep) commands. Does NOT register
/// `VaultRuntimeState` — the unlock plugin owns the runtime-state singleton; the
/// sweep borrows it via `Tauri::State<...>` for the `auth_permits` gate.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("vault-repair")
        .invoke_handler(tauri::generate_handler![
            commands::vault_residue_scan,
            commands::vault_repair
        ])
        .build()
}
