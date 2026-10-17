// SPDX-License-Identifier: AGPL-3.0
//! Vault-migration Tauri plugin (automerge-sync-migration #420).
//!
//! Owns the `vault-migrate:` IPC commands — `vault_migrate` (the whole-vault
//! v0.1 → v0.2 (`MYV1` → `NTV5`) migration (`protocol.md` §10.4.1). The command
//! core + error live in `myne-core` (`plugins::vault_migrate`); this file is just
//! the desktop `init()` wiring, the same shape as `vault_delete`.
//!
//! It registers no state — it borrows `VaultRuntimeState` (owned by
//! `vault_unlock::init()`) via `tauri::State`. The **phrase-required gate is
//! enforced in the core** (`RecoveryPhraseRequired` unless the phrase opens the
//! old vault's recovery wrap), so a UI bug cannot strand recovery.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `vault-migrate` plugin (binds `vault_migrate`).
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("vault-migrate")
        .invoke_handler(tauri::generate_handler![
            myne_core::plugins::vault_migrate::vault_migrate,
            // §10.4.1 point 5's other half (myne-md/myne#430): the migration is
            // not settled until the user confirms, and until then it can be
            // taken back.
            myne_core::plugins::vault_migrate::vault_migrate_abort,
            myne_core::plugins::vault_migrate::vault_migrate_confirm,
            myne_core::plugins::vault_migrate::vault_migrate_settle_status,
            myne_core::plugins::vault_migrate::progress::vault_migrate_progress
        ])
        .build()
}
