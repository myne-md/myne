// SPDX-License-Identifier: AGPL-3.0
//! Vault-recover plugin — shared core.
//!
//! Owns `recover_with_phrase`, `complete_recovery`, and the optional
//! account-number selector. Sibling to `vault_unlock`; both share
//! `VaultRuntimeState`. The post-recovery prefs-apply + search-index hydrate
//! that `complete_recovery` triggers attach through the
//! [`crate::hooks::VaultLifecycleHooks`] seam. The `tauri::Builder` `init()`
//! wiring stays in each client crate.
//!
//! See: ../../../CLAUDE.md "Secret-handling logging discipline".

pub mod account_number_select;
pub mod commands;
pub mod error;
