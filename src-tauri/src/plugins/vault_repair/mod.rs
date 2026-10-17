// SPDX-License-Identifier: AGPL-3.0
//! Vault-repair Tauri plugin (MYND-159).
//!
//! In-app cleanup of orphan vault artefacts left under
//! `<app_data_dir>/vault/` by a partial-fail `vault_delete` (file locks
//! from antivirus / Spotlight / OneDrive during the unlink loop). When
//! `vault.meta` was removed but orphan `.myn` blobs + directories survived,
//! every other lifecycle command refuses (`vault_create` →
//! `VaultArtifactsPresent`, `vault_delete` → `VaultNotFound`,
//! `vault_unlock` → nothing to unlock), stranding the user at a manual
//! `rm -rf` instruction. This plugin is the in-app escape hatch — the
//! committed v0.2 second-half of the MYND-105 scope split.
//!
//! Sibling to `vault_delete`. Owns its own ACL surface (`vault-repair:default`)
//! so the destroy-adjacent capability is auditable under its own permission
//! file rather than buried in another plugin's allow-list.
//!
//! Commands:
//! - [`commands::vault_residue_scan`] — read-only detection (Task 3).
//! - [`commands::vault_repair`] — gate-free orphan sweep (Task 4): the
//!   exact mirror of `vault_delete::dispatch_empty_arm`, proceeding only on
//!   (slot Empty + vault.meta byte-absent + residue), `auth_permits`-gated
//!   across check + sweep, `RootDisposal::KeepRoot`.
//!
//! Shares `VaultRuntimeState` (registered by `vault_unlock::init()`) for the
//! sweep's `auth_permits` gating; the scan takes no state. Drives the same
//! `crate::vault_sweep` pipeline as `vault_delete`, differing only in
//! precondition and `RootDisposal::KeepRoot`.
//!
//! Design history:
//! - Design session: `agent-tooling/sessions/design/2026-06-06-vault-repair.md`
//! - PRD: `agent-tooling/features/vault-repair/prd.md`
//!
//! See: ../../AGENTS.md "Secret-handling logging discipline".

pub mod commands;
pub mod error;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `vault-repair` plugin.
///
/// Binds the read-only [`commands::vault_residue_scan`] (detection) and the
/// destructive [`commands::vault_repair`] (sweep) commands. Does NOT
/// register `VaultRuntimeState` — the unlock plugin owns the runtime-state
/// singleton; the sweep borrows it via `Tauri::State<...>` for the
/// `auth_permits` gate.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("vault-repair")
        .invoke_handler(tauri::generate_handler![
            commands::vault_residue_scan,
            commands::vault_repair
        ])
        .build()
}
