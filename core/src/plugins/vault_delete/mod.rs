// SPDX-License-Identifier: AGPL-3.0-only
//! Vault-delete plugin — shared core.
//!
//! Owns the one-shot `vault_delete` command core + `error`. The auth-flow
//! side-effects it triggers — pre-empting an in-flight backup and the
//! delete-proceeded derived-index teardown — attach through the
//! [`crate::hooks::VaultLifecycleHooks`] seam (no-op on mobile). The recursive
//! unlink runs through the shared [`crate::vault_sweep`] pipeline. The
//! `tauri::Builder` `init()` wiring stays in each client crate.
//!
//! See: ../../../AGENTS.md "Secret-handling logging discipline".

pub mod commands;
pub mod error;
