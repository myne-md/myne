//! Tauri 2 in-app plugins for vault flows (mobile).
//!
//! Mirror of the desktop `src-tauri/src/plugins/` set, trimmed to the
//! flows that compile on mobile. Each plugin is a self-contained module
//! under `plugins/` with its own commands, state, and error type. The
//! still-desktop-only plugins (clipper pairing, themes, workspace,
//! importer, pdf-export, spell) are intentionally absent — mobile reuses
//! the audited `protocol/` crate and the same secret-handling discipline,
//! landing the rest in later phases.
//!
//! `quick_unlock` (PIN path) is registered here — the core moved to
//! `myne-core`; biometric stays desktop-only. `search` (MYS1) runs
//! Rust-side (frontend-fed BM25), not TS-side.
//!
//! `sync` (MYND-458) is the mobile shim over `myne_core::plugins::sync` —
//! ONE plugin, all fourteen commands, a single deny-by-default
//! `sync:default` capability entry (SYNC-15).

pub mod attachments;
pub mod captures;
pub mod export;
pub mod notes;
pub mod prefs;
pub mod quick_unlock;
// MYND-211 sibling (recovery-kit / account-number `.txt` save): the whole
// plugin core (the `save_secret_text` command + `validate_secret_destination`
// guard + error enum) lives in `myne-core`; this is a thin re-export wrapper
// with a mobile `init()`.
pub mod secret_export;
// Share-import staging queue (MYF1, §9.19): a thin re-export wrapper over
// `myne_core::plugins::share_import` (device-key seal + host-side drain into the
// attachment library). Files shared via the OS share sheet (SF2 iOS extension /
// SF3 Android intent) are sealed here while locked and drained on unlock.
pub mod share_import;
// MYS1 full-text search — a NEW local plugin (not a `myne-core` re-export): the
// index engine lives in `myne_core::search`, but the mobile plugin that drives
// it is frontend-fed (the WebView pushes the corpus down), so its two commands
// are defined locally in `search/mod.rs`.
pub mod search;
pub mod snapshots;
// MYND-458: the mobile `sync` shim over `myne_core::plugins::sync` — a thin
// `pub use myne_core::plugins::sync::*` + a local `init()` registering all 14
// commands. Deny-by-default `sync:default` capability; see `sync/mod.rs` for the
// R3 transport review-debt banner.
pub mod sync;
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
