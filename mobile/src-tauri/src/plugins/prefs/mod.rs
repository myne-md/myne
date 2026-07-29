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

// The `prefs` command core (`vault.prefs` read + every per-field setter) and
// its `error` enum live in `myne-core` (shared with the desktop client).
// Re-exported so existing `crate::plugins::prefs::{commands,error}::…` paths
// keep resolving; the no-op `NoopHooks` installed in `lib.rs` satisfies the
// screen-capture / auto-lock-clamp hook seam. The `init()` wiring stays
// mobile-side.
pub use myne_core::plugins::prefs::{commands, error};

// Re-exports for cross-plugin consumers (e.g., vault_unlock's
// `apply_persisted_prefs` post-pipeline hook). Kept for path-compatibility with
// the desktop re-export surface even though the consuming code now lives in
// `myne-core`, hence the `unused_imports` allow.
#[allow(unused_imports)]
pub use error::PrefsReadError;
#[allow(unused_imports)]
pub use protocol::PrefsView;

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Runtime;

/// Construct the `prefs` plugin.
///
/// Binds the IPC commands declared in [`commands`]. Does NOT
/// register `VaultRuntimeState` — the unlock plugin owns the
/// runtime-state singleton; prefs borrows via `Tauri::State<...>`.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("prefs")
        .invoke_handler(tauri::generate_handler![
            commands::prefs_read,
            commands::set_screen_capture_protection,
            commands::set_deliberate_folders,
            commands::set_archived_folders,
            commands::set_auto_lock_timeout,
            commands::set_item_order,
            commands::set_hidden_bar_items,
            commands::set_bar_items_order,
            commands::set_favorites,
            commands::set_editor_layout,
            commands::set_theme,
            commands::set_custom_theme,
            commands::set_daily_date_format,
            commands::set_daily_folder,
            commands::set_daily_template,
            commands::set_new_note_location,
            commands::set_startup_open,
            commands::set_editor_text_size,
            commands::set_editor_line_numbers,
            commands::set_archive_disabled,
            commands::set_editor_line_spacing,
            commands::set_editor_content_width,
            commands::set_editor_font_family,
            commands::set_active_workspace,
            commands::set_editor_default_view_mode,
            commands::set_editor_focus_dim_inactive,
            commands::set_editor_focus_typewriter,
            commands::set_item_colors,
            commands::set_folder_icons,
            // MYND-548 device naming. Each needs a matching `allow-` entry in
            // permissions/prefs/default.toml AND a name in build.rs's inlined
            // command list — the desktop build.rs calls a mismatch here a
            // security regression, and the same holds on this side.
            commands::set_device_name,
            commands::device_platform,
            commands::vault_set_label,
            commands::set_spell_enabled,
            commands::set_spell_languages,
            commands::set_show_note_timestamps,
            commands::set_keymap_binding,
            commands::upsert_saved_view,
            commands::delete_saved_view,
            commands::set_view_order,
            commands::set_right_panel_active_tab,
            commands::set_right_panel_hidden_tabs,
            commands::set_right_panel_tab_order,
            // MYND-555: editor format-bar customization. Bodies are the SHARED
            // `myne-core` prefs core desktop already uses — mobile only registers
            // them. Device-local fields (`sync-protocol.md` §10.2.1), so a phone
            // layout never propagates to a desktop. Must stay in lockstep with
            // `permissions/prefs/default.toml` or the ACL resolver fails closed.
            commands::set_editor_toolbar_order,
            commands::set_editor_toolbar_hidden,
            commands::set_reminders_enabled,
            commands::set_reminder_horizon_days,
        ])
        .build()
}
