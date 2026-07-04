// SPDX-License-Identifier: AGPL-3.0
//! Shared, host-coupled-but-platform-agnostic Tauri plugin cores.
//!
//! Each plugin is a self-contained module with its own commands, state, and
//! error type. The plugin-pattern over flat-app-level commands is documented
//! in `myne-agents/sessions/design/2026-04-28-vault-creation-flow.md` Q8.3 —
//! domain isolation enforced at compile time.
//!
//! These cores are shared between the desktop (`myne-desktop`) and future
//! mobile clients. Desktop-only plugins (search, snapshots, sync, …) stay in
//! the desktop crate and attach through the `hooks::VaultLifecycleHooks`
//! seam rather than living here.

pub mod attachments;
pub mod notes;
pub mod prefs;
pub mod quick_unlock;
pub mod snapshots;
pub mod vault_change_password;
pub mod vault_creation;
pub mod vault_delete;
pub mod vault_indices;
pub mod vault_recover;
pub mod vault_unlock;
