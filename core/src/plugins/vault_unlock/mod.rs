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
/// Opening a SOURCE vault for reading while a different vault stays unlocked
/// (vault import, myne-md/myne#464). Lives beside the unlock plugin because it
/// reuses its derivation steps; its COMMANDS are registered under the desktop
/// `importer:` namespace, not this one.
pub mod import_source;
pub mod state;
// Mid-session storage health (phase3-web-client task 22). A sibling of the boot
// probe in `commands`, not an extension of it: the same three on-disk states mean
// different things once a session is unlocked, and "eviction detected, not
// misreported as corruption" is a distinction that only exists here.
pub mod storage_health;
