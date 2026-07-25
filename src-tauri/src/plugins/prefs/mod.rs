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
// its `error` enum moved to `myne-core` (shared with the mobile client). The
// two commands with a desktop-only native side-effect (`screen_capture::apply`
// after `set_screen_capture_protection`; the `auto_lock` clamp on the cached
// idle-timer timeout) attach through the `hooks::VaultLifecycleHooks` seam.
// Re-exported so existing `crate::plugins::prefs::{commands,error}::…` paths
// keep resolving. The `init()` wiring stays desktop-side.
pub use myne_core::plugins::prefs::{commands, error};

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
            commands::set_editor_vim_mode,
            commands::set_archive_disabled,
            commands::set_editor_line_spacing,
            commands::set_editor_content_width,
            commands::set_editor_font_family,
            commands::set_active_workspace,
            commands::set_ai_enabled,
            commands::set_ai_excluded_folders,
            commands::set_editor_default_view_mode,
            commands::set_editor_focus_dim_inactive,
            commands::set_editor_focus_typewriter,
            commands::set_item_colors,
            commands::set_folder_icons,
            commands::vault_set_label,
            commands::vault_set_icon,
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
            // MYND-336 editor toolbar / slash-menu customization setters. Each
            // needs a matching capabilities/default.json permission — verify via
            // `pnpm tauri dev` (permission autogen).
            commands::set_editor_toolbar_order,
            commands::set_editor_toolbar_hidden,
            commands::set_editor_slash_order,
            commands::set_editor_slash_hidden,
        ])
        .build()
}

/// Desktop-side prefs tests that exercise a core `_with_dir` command core but
/// depend on a desktop-only behavior — the `auto_lock` clamp wiring and the
/// browser-clipper `TokenRegistry`. Relocated here from the core `prefs`
/// command-module tests so the core stays free of desktop-only types.
#[cfg(test)]
mod desktop_tests {
    use myne_core::hooks::{BoxFuture, Hooks, VaultLifecycleHooks};
    use myne_core::plugins::prefs::commands::{
        persist_paired_extensions_with_dir, prefs_read_with_dir, set_auto_lock_timeout_with_dir,
    };
    use myne_core::plugins::vault_unlock::state::{
        fixture_unlocked_with_keys, test_vault_id, VaultRuntimeState,
    };
    use myne_core::test_support::{seed_real_vault_meta, ScopedTempDir};
    use std::path::Path;
    use std::sync::Arc;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("current-thread runtime build")
    }

    async fn make_temp_vault_with_unlocked_state(
        seed_account_hash: u8,
    ) -> (ScopedTempDir, VaultRuntimeState) {
        let tmp = ScopedTempDir::new("prefs-desktop-it").expect("scoped tempdir");
        seed_real_vault_meta(tmp.path(), seed_account_hash);
        let state = VaultRuntimeState::default();
        let unlocked = fixture_unlocked_with_keys(0x42, 0x99, 1);
        state.set_unlocked(test_vault_id(), unlocked).await;
        (tmp, state)
    }

    /// A `Hooks` whose `effective_auto_lock_secs` delegates to the REAL desktop
    /// `auto_lock` clamp; everything else is a no-op. This is exactly what
    /// `DesktopHooks` does for `effective_auto_lock_secs`, without needing an
    /// `AppHandle` / `tauri::test` harness (TB9 Cargo.lock discipline).
    struct ClampHooks;
    impl VaultLifecycleHooks for ClampHooks {
        fn hydrate_search_index<'a>(&'a self, _: &'a VaultRuntimeState) -> BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn hydrate_spell<'a>(&'a self, _: &'a VaultRuntimeState) -> BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn reclaim_stray_attachment_blobs<'a>(&'a self, _: &'a VaultRuntimeState) -> BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn persist_search_index<'a>(&'a self, _: &'a VaultRuntimeState) -> BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn hydrate_ai_vectors<'a>(&'a self, _: &'a VaultRuntimeState) -> BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn index_note_attachments<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
            _: &'a str,
            _: &'a str,
            _: &'a str,
        ) -> BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn zeroize_search_index(&self) {}
        fn zeroize_spell(&self) {}
        fn zeroize_vault_indices(&self) {}
        fn zeroize_attachment_refs(&self) {}
        fn abort_active_recording(&self) {}
        fn pdf_export_teardown_on_lock(&self) {}
        fn clear_staged_descriptor(&self) {}
        fn apply_screen_capture(&self, _: bool, _: &'static str) {}
        fn search_upsert(&self, _: &str, _: &str, _: &str) {}
        fn search_remove(&self, _: &str) {}
        fn ai_note_changed(&self, _: &str, _: &str) {}
        fn ai_note_deleted(&self, _: &str) {}
        fn ai_policy_changed(&self, _: bool, _: &[String]) {}
        fn bump_local_change(&self) {}
        fn emit_snapshot_write_failed(&self, _: &str) {}
        fn effective_auto_lock_secs(&self, prefs_value: Option<u32>) -> u32 {
            crate::auto_lock::effective_auto_lock_secs(prefs_value)
        }
        fn hydrate_clipper_pairing(&self, _: &[protocol::PairedExtension]) {}
        fn preempt_inflight_backup<'a>(&'a self, _: &'a VaultRuntimeState) -> BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn invalidate_quick_unlock(&self, _: &Path) {}
        fn capture_snapshot(&self, _: &Path, _: &str, _: &[u8], _: u64, _: bool) -> bool {
            false
        }
        fn purge_note_snapshots(&self, _: &Path, _: &str) -> std::io::Result<usize> {
            Ok(0)
        }
    }

    fn clamp_hooks() -> Hooks {
        Arc::new(ClampHooks)
    }

    #[test]
    fn set_auto_lock_timeout_stores_raw_but_caches_clamped() {
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x33).await;

            // A huge value is stored RAW on disk (replay-resistance lives in
            // the read-time clamp, not the write)...
            set_auto_lock_timeout_with_dir(tmp.path(), &state, &clamp_hooks(), u32::MAX)
                .await
                .expect("write must succeed");
            let view = prefs_read_with_dir(tmp.path(), &state)
                .await
                .expect("read must succeed");
            assert_eq!(view.auto_lock_seconds, Some(u32::MAX));

            // ...but the cached effective timeout is clamped to the ceiling.
            assert_eq!(
                state.auto_lock_timeout_secs(),
                crate::auto_lock::AUTO_LOCK_CEILING_SECS
            );
        });
    }

    #[test]
    fn paired_extensions_persist_and_read_round_trip_valid_and_revoked() {
        // MYND-443 task 7 acceptance — the FULL persistence path through the
        // encrypted prefs blob: issue → snapshot → persist to vault.prefs →
        // re-read → hydrate a fresh registry → token still valid; revoke →
        // persist → re-read → hydrate → RegistryGate rejects it.
        use crate::clipper::token::{RegistryGate, TokenRegistry, TokenValidation};
        const EXT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        rt().block_on(async {
            let (tmp, state) = make_temp_vault_with_unlocked_state(0x4c).await;

            let mut reg = TokenRegistry::new();
            let token = reg.issue(EXT).unwrap();
            persist_paired_extensions_with_dir(
                tmp.path(),
                &state,
                &clamp_hooks(),
                reg.to_paired_extensions(),
            )
            .await
            .expect("persist issued");

            let view = prefs_read_with_dir(tmp.path(), &state).await.expect("read");
            assert_eq!(view.paired_extensions.len(), 1);
            let restored = TokenRegistry::from_paired_extensions(&view.paired_extensions);
            assert_eq!(
                restored.validate(EXT, token.value()),
                TokenValidation::Valid
            );

            reg.revoke_extension(EXT);
            persist_paired_extensions_with_dir(
                tmp.path(),
                &state,
                &clamp_hooks(),
                reg.to_paired_extensions(),
            )
            .await
            .expect("persist revoked");
            let view = prefs_read_with_dir(tmp.path(), &state).await.expect("read");
            let restored = TokenRegistry::from_paired_extensions(&view.paired_extensions);
            let gate = RegistryGate::new(&restored, EXT, token.value());
            assert_eq!(gate.validation(), TokenValidation::Revoked);
            assert_ne!(gate.validation(), TokenValidation::Valid);

            assert!(view.screen_capture_protection);
        });
    }

    #[test]
    fn paired_extensions_persist_rejects_when_slot_empty() {
        use crate::clipper::token::TokenRegistry;
        const EXT: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        rt().block_on(async {
            let tmp = ScopedTempDir::new("prefs-paired-locked").expect("scoped tempdir");
            seed_real_vault_meta(tmp.path(), 0x4d);
            let state = VaultRuntimeState::default(); // never unlocked
            let mut reg = TokenRegistry::new();
            reg.issue(EXT).unwrap();
            let result = persist_paired_extensions_with_dir(
                tmp.path(),
                &state,
                &clamp_hooks(),
                reg.to_paired_extensions(),
            )
            .await;
            assert!(matches!(
                result,
                Err(myne_core::plugins::prefs::error::PrefsWriteError::SlotNotUnlocked)
            ));
        });
    }
}
