//! Vault-change-password Tauri plugin.
//!
//! Owns the standalone `vault_change_password::commit` command —
//! user-knows-current-password password rotation flow. NOT for
//! post-recovery password reset (that's `vault_recover::complete_recovery`,
//! A8f). The two are split because their signatures differ — see
//! `myne-agents/features/vault-change-password/prd.md` Problem
//! Statement.
//!
//! Sibling to `vault_unlock` and `vault_recover`. All three share
//! `VaultRuntimeState` (registered at the host level by
//! `vault_unlock::init()`); change-password borrows via
//! `Tauri::State<VaultRuntimeState>`.
//!
//! Design history:
//! - PRD: `myne-agents/features/vault-change-password/prd.md`
//! - Grilling: `myne-agents/sessions/grill/2026-05-06-mynd-22-vault-change-password.md`
//!   Q1–Q9 (CAS posture, AEAD-tag-verify proof, force-relock,
//!   post-Argon2id slot peek, PR shape, naming discipline, strength
//!   gating, tracing pattern, test posture)
//! - Tasks: `myne-agents/features/vault-change-password/tasks.md`
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

pub mod commands;
pub mod error;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `vault-change-password` plugin.
///
/// Binds the IPC commands declared in [`commands`]. Does NOT register
/// `VaultRuntimeState` — the unlock plugin owns the runtime-state
/// singleton; change-password borrows via `Tauri::State<...>`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("vault-change-password")
        .invoke_handler(tauri::generate_handler![commands::change_password])
        .build()
}
