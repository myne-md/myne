// SPDX-License-Identifier: AGPL-3.0
//! `prefs` plugin — shared core.
//!
//! Owns the `vault.prefs` read + the per-field setters. All commands are
//! `Slot::Unlocked`-gated and borrow the shared `VaultRuntimeState`; this
//! plugin holds NO plugin-private state (the per-plugin write mutex is a
//! `OnceLock<Mutex<()>>` scoped to write-side serialization).
//!
//! The two commands with a desktop-only native side-effect — the
//! `screen_capture::apply` after a `set_screen_capture_protection` write and
//! the `auto_lock` clamp on the cached idle-timer timeout — attach through the
//! [`crate::hooks::VaultLifecycleHooks`] seam (no-op on mobile). The
//! `tauri::Builder` `init()` wiring stays in each client crate.
//!
//! See: ../../../CLAUDE.md "Secret-handling logging discipline".

pub mod commands;
pub mod error;

// Re-exports for cross-plugin consumers (e.g., vault_unlock's
// `apply_persisted_prefs` post-pipeline hook).
pub use error::PrefsReadError;
pub use protocol::PrefsView;
