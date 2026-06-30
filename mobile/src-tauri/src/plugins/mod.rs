//! Tauri 2 in-app plugins for vault flows (mobile).
//!
//! Mirror of the desktop `src-tauri/src/plugins/` set, trimmed to the
//! Phase-1 vault + notes + prefs flows that compile on mobile. Each
//! plugin is a self-contained module under `plugins/` with its own
//! commands, state, and error type. Desktop-only plugins (clipper
//! pairing, snapshots, sync, themes, attachments, workspace,
//! vault-indices, vault-repair, importer, export, pdf-export,
//! quick-unlock) are intentionally absent — mobile reuses the audited
//! `protocol/` crate and the same secret-handling discipline, but does
//! search / spell / attachments / sync TS-side or in later phases.

pub mod notes;
pub mod prefs;
pub mod vault_change_password;
// `vault_creation` core (commands + state + error + `init()`) lives entirely in
// `myne-core` (shared with the desktop client) — there is no mobile-side
// side-effect to attach, so the whole module is re-exported. The
// `plugins::vault_creation::init()` call in `lib.rs` resolves through this.
pub use myne_core::plugins::vault_creation;
pub mod vault_delete;
pub mod vault_recover;
pub mod vault_unlock;
