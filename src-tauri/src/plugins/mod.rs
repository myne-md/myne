//! Tauri 2 in-app plugins for vault flows.
//!
//! Each plugin is a self-contained module under `plugins/` with its
//! own commands, state, and error type. The plugin-pattern over
//! flat-app-level commands is documented in
//! `myne-agents/sessions/design/2026-04-28-vault-creation-flow.md`
//! Q8.3 — domain isolation enforced at compile time, future
//! `vault-unlock` / `change-password` plugins follow the same shape.

pub mod notes;
pub mod prefs;
pub mod vault_change_password;
pub mod vault_creation;
pub mod vault_delete;
pub mod vault_indices;
pub mod vault_recover;
pub mod vault_repair;
pub mod vault_unlock;
