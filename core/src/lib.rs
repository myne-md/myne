// SPDX-License-Identifier: AGPL-3.0
//! `myne-core` — shared backend logic for the Myne desktop and mobile clients.
//!
//! Extracted from the desktop `myne_desktop_lib` so the vault / notes / prefs
//! plugin cores live in a single source of truth instead of being copied per
//! client (see `design-notes.md` and the `myne-core` extraction plan).
//!
//! Scope:
//! - **Lives here:** host-coupled-but-platform-agnostic plugin cores
//!   (`vault_creation`, `vault_unlock`, `vault_recover`, `vault_change_password`,
//!   `vault_delete`, `notes` CRUD, `prefs`) plus the shared crate-root helpers
//!   (`atomic_write`, `paths`, `vault_registry`, …).
//! - **Stays in each client:** the `tauri::Builder` app wiring,
//!   `generate_handler!` registration, capability/permission ACLs, and the
//!   desktop-only modules (search, spell, snapshots, sync, attachments, backup,
//!   clipper, pdf, workspace), which attach through the
//!   [`hooks::VaultLifecycleHooks`] trait (no-op on mobile, real on desktop).
//!
//! Modules are migrated in phases; this root is intentionally thin until the
//! first module lands.

/// Default auto-lock-on-idle timeout (seconds) applied when the user has
/// stored no preference. The auto-lock *policy enforcement* is desktop-only
/// (`auto_lock` stays in the desktop crate), but this default is the
/// single-source constant the shared `VaultRuntimeState` seeds itself with,
/// so it lives here and the desktop `auto_lock` re-exports it.
pub const DEFAULT_AUTO_LOCK_SECS: u32 = 300;

pub mod atomic_write;
pub mod attachment_nonce;
/// The one decryption-free `content_nonce` reader, shared by every blob family
/// that has one. The generation pair is a required argument, so a
/// single-generation reader cannot be written by accident (myne-md/myne#638).
pub mod content_nonce;
/// The double-buffered container the web client stores singletons in
/// (phase3-web-client task 18) — framing, slot selection, and the write/open
/// algorithm over the [`vault_io`] seam, with the fault-injection points task 19
/// drives. Native builds never reach it: `atomic_write` is their durability
/// contract, and this is what replaces it where no atomic rename exists.
pub mod double_buffer;
/// Named crash states of a double-buffered singleton, as bytes for the web E2E
/// lane's OPFS seeder. Test-support only: the fixtures exist to be written into
/// a browser before an app boots, never by production code.
#[cfg(any(test, feature = "test-support"))]
pub mod double_buffer_fixtures;
pub mod export_naming;
/// The one canonical folder key and the one equal-or-nested folder test, shared
/// by the `ai_excluded_folders` (SYNC-14) clamp in every place that applies it.
pub mod folder_key;
pub mod http;
// The process-host seam (phase3-web-client task 79) — what a command core needs
// from its host that is not already an ordinary Rust value. Sibling of `hooks`,
// which is the same idea one axis over (lifecycle side effects).
pub mod hooks;
pub mod host;
// The async-execution seam (phase3-web-client task 80). `spawn_blocking`
// COMPILES for wasm32 and panics at runtime — the same shape as the clock in
// `host`. Both live here so neither can be reached by accident.
pub mod io_failure_kind;
pub mod note_nonce;
pub mod note_txn;
pub mod paths;
pub mod plugins;
pub mod protocol_error_kind;
pub mod task;
// The full-text search engine (MYS1) + its encrypted persistence/reconcile core.
// Top-level (not under `plugins/`) mirroring the desktop `mod search;` it
// replaces. The desktop crate re-exports it via `pub use myne_core::search;`;
// mobile does not wire it (the search-index feed hangs off the desktop-only
// `search_upsert`/`hydrate` hooks, absent in mobile's `NoopHooks`).
pub mod search;
/// Opening a singleton vault file with crash recovery (phase3-web-client task
/// 18) — the one place that implements "newest copy that verifies wins", so the
/// ~10 singleton readers do not each carry a fallback loop.
pub mod singleton;
pub mod snapshot_policy;
pub mod snapshot_store;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
pub mod text;
pub mod vault_id;
/// The filesystem seam (phase3-web-client task 17) — the third and last of the
/// three that make this crate host-independent, alongside [`host`] (paths, events,
/// clock) and [`task`] (blocking execution, timers).
pub mod vault_io;
/// The sealed label store (`MYL1`, `protocol.md` §9.22): the per-vault
/// keychain key and the device-local file that let the LOCKED picker show a
/// vault's real name. Top-level rather than under `plugins/` because four
/// flows consume it (unlock, rename, vault delete, the picker's list) and none
/// of them owns it.
pub mod vault_label;
pub mod vault_meta_hash;
pub mod vault_registry;
pub mod vault_sweep;
