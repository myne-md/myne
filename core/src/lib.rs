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
pub mod export_naming;
pub mod hooks;
pub mod io_failure_kind;
pub mod note_nonce;
pub mod note_txn;
pub mod paths;
pub mod plugins;
pub mod protocol_error_kind;
// The full-text search engine (MYS1) + its encrypted persistence/reconcile core.
// Top-level (not under `plugins/`) mirroring the desktop `mod search;` it
// replaces. The desktop crate re-exports it via `pub use myne_core::search;`;
// mobile does not wire it (the search-index feed hangs off the desktop-only
// `search_upsert`/`hydrate` hooks, absent in mobile's `NoopHooks`).
pub mod search;
pub mod snapshot_policy;
pub mod snapshot_store;
#[cfg(any(test, feature = "test-support"))]
pub mod test_support;
pub mod text;
pub mod vault_id;
pub mod vault_meta_hash;
pub mod vault_registry;
pub mod vault_sweep;
