//! Tauri 2 in-app plugins for vault flows.
//!
//! Each plugin is a self-contained module under `plugins/` with its
//! own commands, state, and error type. The plugin-pattern over
//! flat-app-level commands is documented in
//! `agent-tooling/sessions/design/2026-04-28-vault-creation-flow.md`
//! Q8.3 — domain isolation enforced at compile time, future
//! `vault-unlock` / `change-password` plugins follow the same shape.

pub mod attachments;
pub mod backup;
pub mod clipper_pairing;
pub mod export;
pub mod importer;
// local-ai epic (MYND-406): on-device inference plugin, gated behind the
// default-off `local-inference` cargo feature (SYNC-5). Absent — zero symbols —
// from the default build.
#[cfg(feature = "local-inference")]
pub mod local_inference;
pub mod notes;
pub mod pdf_export;
pub mod prefs;
pub mod quick_unlock;
pub mod snapshots;
pub mod sync;
pub mod themes;
pub mod vault_change_password;
// `vault_creation` core (commands + state + error + `init()`) moved to
// `myne-core` (shared with the mobile client). Re-exported so existing
// `crate::plugins::vault_creation::…` paths keep resolving.
pub use myne_core::plugins::vault_creation;
pub mod vault_delete;
pub mod vault_indices;
pub mod vault_recover;
pub mod vault_repair;
pub mod vault_unlock;
pub mod workspace;
