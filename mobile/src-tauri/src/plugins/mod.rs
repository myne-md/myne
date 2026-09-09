//! Tauri 2 in-app plugins for vault flows (mobile).
//!
//! Mirror of the desktop `src-tauri/src/plugins/` set, trimmed to the
//! flows that compile on mobile. Each plugin is a self-contained module
//! under `plugins/` with its own commands, state, and error type. The
//! still-desktop-only plugins (clipper pairing, importer, pdf-export,
//! spell) are intentionally absent — mobile reuses the audited
//! `protocol/` crate and the same secret-handling discipline, landing the
//! rest in later phases.
//!
//! `quick_unlock` (PIN path) is registered here — the core moved to
//! `myne-core`; biometric stays desktop-only. `search` (MYS1) runs
//! Rust-side (frontend-fed BM25), not TS-side.
//!
//! `sync` (MYND-458) is the mobile shim over `myne_core::plugins::sync` —
//! ONE plugin, all fourteen commands, a single deny-by-default
//! `sync:default` capability entry (SYNC-15).

// Agentic note editing over a remote provider (myne-md/myne#456). Registered
// unconditionally, unlike desktop's, which sits behind the `local-inference`
// feature: there is no local-inference feature on this client to gate it
// behind, and the arm is either present or the feature does not exist here.
pub mod agent;
pub mod attachments;
pub mod captures;
pub mod export;
// Knowledge-graph layout cache (MYG1, §9.19): a thin re-export wrapper over
// `myne_core::plugins::graph_layout` — read/write of the encrypted
// `vault.graph` node-position cache (Class 3, never synced/backed up).
pub mod graph_layout;
// AI conversations (MYM1 catalog + MYJ1 files, myne-md/myne#675): a thin
// re-export wrapper over `myne_core::plugins::chats`: the six conversation
// storage commands, Class-1 synced vault content.
pub mod chats;
// On-device speech-to-text (Whisper, MYND-563) — a NEW mobile plugin (not a
// `myne-core` re-export: `local_inference` is desktop-side and `core/` must stay
// wasm-clean, so the whisper subset is copied here). Declared unconditionally;
// its candle/whisper internals + real `init()` are feature-gated by
// `local-inference` (default-on), with a no-op `init()` for a
// `--no-default-features` build (see `local_inference/mod.rs`).
pub mod local_inference;
pub mod notes;
pub mod prefs;
pub mod quick_unlock;
// MYND-211 sibling (recovery-kit / account-number `.txt` save): the whole
// plugin core (the `save_secret_text` command + `validate_secret_destination`
// guard + error enum) lives in `myne-core`; this is a thin re-export wrapper
// with a mobile `init()`.
pub mod secret_export;
// Share-import staging queue (MYF1, §9.20): a thin re-export wrapper over
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
// Custom themes (MYT1, §9.21): a thin re-export wrapper over
// `myne_core::plugins::themes` exposing ONE of desktop's five commands —
// `themes_list`. See `themes/mod.rs` for why the other four are out.
pub mod themes;
pub mod vault_change_password;
// `vault_creation` core (commands + state + error + `init()`) lives entirely in
// `myne-core` (shared with the desktop client) — there is no mobile-side
// side-effect to attach, so the whole module is re-exported. The
// `plugins::vault_creation::init()` call in `lib.rs` resolves through this.
pub use myne_core::plugins::vault_creation;
// Account record (the account/vault split, myne-md/myne#684): a thin re-export
// wrapper over `myne_core::account`. All FOUR of desktop's commands; on Android
// the store holds nothing and vaults show standalone.
pub mod account;
pub mod vault_delete;
pub mod vault_indices;
// Sealed label store (MYL1, §9.22): a thin re-export wrapper over
// `myne_core::vault_label`, the device-local hide-vault-names option and the
// erase that turning it on performs (myne-md/myne#411). All THREE of desktop's
// commands, including the keychain probe: on Android the store holds nothing
// today and the probe is what lets the Privacy row say so.
pub mod vault_label;
pub mod vault_recover;
pub mod vault_repair;
pub mod vault_unlock;
// MYND-561: MYW1 `vault.workspace` persistence — a NEW local plugin, not a
// `myne-core` re-export. The desktop client's workspace plugin is bound to
// desktop-crate internals and hoisting it into `myne-core` would mean migrating
// desktop's live multi-tab restore in the same change; the container (codec +
// subkey role) is what must match, and it does. See `workspace/commands.rs`.
pub mod workspace;
