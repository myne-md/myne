//! Tauri 2 in-app plugins for vault flows (mobile).
//!
//! Mirror of the desktop `src-tauri/src/plugins/` set, trimmed to the
//! Phase-1 vault + notes + prefs flows that compile on mobile. Each
//! plugin is a self-contained module under `plugins/` with its own
//! commands, state, and error type. Desktop-only plugins (clipper
//! pairing, sync, themes, workspace, importer, pdf-export) are
//! intentionally absent — mobile reuses the audited
//! `protocol/` crate and the same secret-handling discipline, but does
//! search / spell / attachments / sync TS-side or in later phases.
//!
//! `quick_unlock` (PIN path) is registered here — the core moved to
//! `myne-core`; biometric stays desktop-only.

pub mod attachments;
pub mod export;
pub mod notes;
pub mod prefs;
pub mod quick_unlock;
// MYND-211 sibling (recovery-kit / account-number `.txt` save): the whole
// plugin core (the `save_secret_text` command + `validate_secret_destination`
// guard + error enum) lives in `myne-core`; this is a thin re-export wrapper
// with a mobile `init()`.
pub mod secret_export;
// MYS1 full-text search — a NEW local plugin (not a `myne-core` re-export): the
// index engine lives in `myne_core::search`, but the mobile plugin that drives
// it is frontend-fed (the WebView pushes the corpus down), so its two commands
// are defined locally in `search/mod.rs`.
pub mod search;
pub mod snapshots;
pub mod vault_change_password;
// `vault_creation` core (commands + state + error + `init()`) lives entirely in
// `myne-core` (shared with the desktop client) — there is no mobile-side
// side-effect to attach, so the whole module is re-exported. The
// `plugins::vault_creation::init()` call in `lib.rs` resolves through this.
pub use myne_core::plugins::vault_creation;
pub mod vault_delete;
pub mod vault_indices;
pub mod vault_recover;
pub mod vault_repair;
pub mod vault_unlock;
