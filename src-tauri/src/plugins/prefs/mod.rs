//! `prefs` Tauri plugin (MYND-160 Task 9).
//!
//! Owns the `prefs_read` + `set_screen_capture_protection` IPC
//! commands. Both Slot::Unlocked-gated; both consume the existing
//! `VaultRuntimeState` singleton (registered by `vault_unlock::init`)
//! via `tauri::State<...>` — this plugin holds NO plugin-private
//! state. The per-plugin write mutex lives inside `commands.rs` as a
//! `OnceLock<Mutex<()>>`, scoped to write-side serialization only.
//!
//! Sibling to `vault_unlock`, `vault_recover`, `vault_change_password`,
//! `vault_delete`, and `notes`. The plugin name in the ACL namespace
//! is `prefs` (hyphenless — single word, no need for kebab-case).
//!
//! ## Design history
//!
//! - PRD: `agent-tooling/features/vault-prefs-blob/prd.md`
//! - Grilling: `agent-tooling/sessions/grill/2026-05-27-mynd-160-encrypted-prefs-blob.md`
//!   Q1 (subkey source), Q3 (storage layer + fall-back-to-defaults),
//!   Q4 (file format + AAD), Q5 (runtime control flow), Q6 (loose ends)
//! - Tasks: `agent-tooling/features/vault-prefs-blob/tasks.md`
//! - decisions.md: 2026-05-27 entries — "Vault preferences blob
//!   (vault.prefs): root_key-derived prefs_key, MYP1 magic, JSON
//!   inner, account_number_hash AAD" + "Lock-on-default-ON" +
//!   "Forward commitment: prefs:write capability stays
//!   main-window-only"
//!
//! ## Critical ordering
//!
//! `set_screen_capture_protection` MUST commit the disk write
//! BEFORE invoking the `screen_capture::apply` native side-effect.
//! Reversed ordering would let a disk-write failure silently leave
//! the native state desynchronized from the persisted preference.
//! See grill Q5.2 — story 16.
//!
//! ## Capability ACL
//!
//! `prefs:default` bundles both `allow-prefs-read` +
//! `allow-set-screen-capture-protection`. Main-window-only invariant:
//! v0.2 multi-window sub-windows MAY receive `allow-prefs-read` but
//! MUST NOT receive `allow-set-screen-capture-protection` (or any
//! future `allow-set-*`) per `decisions.md` 2026-05-27 "Forward
//! commitment: prefs:write capability stays main-window-only".
//!
//! See: ../../CLAUDE.md "Secret-handling logging discipline".

pub mod commands;
pub mod error;

// Re-exports for cross-plugin consumers (e.g., vault_unlock's
// `apply_persisted_prefs` post-pipeline hook).
pub use error::PrefsReadError;
pub use protocol::PrefsView;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `prefs` plugin.
///
/// Binds the two IPC commands declared in [`commands`]. Does NOT
/// register `VaultRuntimeState` — the unlock plugin owns the
/// runtime-state singleton; prefs borrows via `Tauri::State<...>`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("prefs")
        .invoke_handler(tauri::generate_handler![
            commands::prefs_read,
            commands::set_screen_capture_protection,
        ])
        .build()
}
