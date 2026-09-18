// SPDX-License-Identifier: AGPL-3.0
//! Vault-change-password plugin — shared core.
//!
//! Owns the standalone `change_password` password-rotation command core +
//! `error`. The auth-flow side-effects it triggers — pre-empting an in-flight
//! backup before the rewrite, the force-relock derived-index teardown, and the
//! quick-unlock-credential invalidation — attach through the
//! [`crate::hooks::VaultLifecycleHooks`] seam (no-op on mobile). The
//! `tauri::Builder` `init()` wiring stays in each client crate.
//!
//! See: ../../../AGENTS.md "Secret-handling logging discipline".

pub mod commands;
pub mod error;
