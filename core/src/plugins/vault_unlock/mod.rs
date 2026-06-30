// SPDX-License-Identifier: AGPL-3.0
//! Vault-unlock plugin — shared core.
//!
//! The platform-agnostic pieces live here in `myne-core`:
//! [`state::VaultRuntimeState`] (the singleton unlocked-vault slot map that
//! `vault_creation` depends on), the [`error`] enum, and the
//! [`commands`] core (`unlock` / `lock` / the read-only status probes). Inline
//! desktop-only side-effects (search/spell/attachments/pdf/workspace teardown,
//! screen-capture, clipper hydration) attach through the
//! [`crate::hooks::VaultLifecycleHooks`] seam. The `tauri::Builder` `init()`
//! wiring stays in each client crate.
//!
//! See: ../../../CLAUDE.md "Secret-handling logging discipline".

pub mod commands;
pub mod error;
pub mod state;
