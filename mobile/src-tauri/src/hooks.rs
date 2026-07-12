// SPDX-License-Identifier: AGPL-3.0
//! Mobile implementation of [`myne_core::hooks::VaultLifecycleHooks`].
//!
//! Mobile carries none of the desktop-only side-effect subsystems (search,
//! spell, sync, attachments, workspace, screen-capture, quick-unlock, …), so
//! almost every hook is a no-op — the same shape as `myne_core::hooks::NoopHooks`.
//!
//! The two exceptions wire the **snapshots** subsystem, which lives entirely in
//! `myne-core` (`snapshot_store` + `snapshot_policy`, no desktop dependency):
//!
//! - [`capture_snapshot`](MobileHooks::capture_snapshot) delegates to the shared
//!   [`myne_core::snapshot_store::capture_snapshot_best_effort`] write-path, so a
//!   note overwrite on mobile captures a pre-overwrite `.myn` snapshot exactly
//!   as it does on desktop (gated by the same coalescing window).
//! - [`purge_note_snapshots`](MobileHooks::purge_note_snapshots) removes all of a
//!   deleted note's snapshots via
//!   [`myne_core::snapshot_store::remove_all_note_snapshots`] (SYNC-1 crypto
//!   erase — orphan ciphertext under a now-unrecoverable `item_key` must not
//!   linger).
//!
//! The already-registered `snapshots` plugin (list / preview / restore / prune
//! commands) therefore has real data to operate on.
//!
//! A third live hook is [`bump_local_change`](MobileHooks::bump_local_change): a
//! local note edit nudges the shared `SyncLocalChange` counter (via `try_state`)
//! so the future background-sync loop (MYND-460) can open its coalesced-push
//! window. Until the loop lands nothing reads the counter, so the bump is a
//! harmless nudge. Every other hook stays a no-op until its subsystem lands on
//! mobile (see `myne-mobile/CLAUDE.md`).

use myne_core::hooks::{BoxFuture, VaultLifecycleHooks};
use myne_core::plugins::vault_unlock::state::VaultRuntimeState;
use tauri::{AppHandle, Manager, Runtime};

/// Mobile wiring for the shared command-core lifecycle hooks: no-op everywhere
/// except the two snapshot hooks (which drive the `myne-core` snapshot store)
/// and `bump_local_change` (nudges the shared `SyncLocalChange` counter) and
/// `apply_screen_capture` (native screen-capture protection). Holds an
/// [`AppHandle`] so `bump_local_change` reaches the managed `SyncLocalChange`
/// via `try_state`, and the screen-capture hook dispatches its UIKit/Android
/// work onto the main thread via `run_on_main_thread` — mirrors the desktop
/// `DesktopHooks`.
pub struct MobileHooks<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> MobileHooks<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> VaultLifecycleHooks for MobileHooks<R> {
    // ---- Group 1: async ---------------------------------------------------
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
    fn fold_attachment_text_for_index<'a>(
        &'a self,
        _: &'a VaultRuntimeState,
        note_body: &'a str,
    ) -> BoxFuture<'a, String> {
        let body = note_body.to_string();
        Box::pin(std::future::ready(body))
    }

    // ---- Group 2: sync ----------------------------------------------------
    fn zeroize_search_index(&self) {}
    fn zeroize_spell(&self) {}
    fn zeroize_vault_indices(&self) {}
    fn zeroize_attachment_refs(&self) {}
    fn abort_active_recording(&self) {}
    fn pdf_export_teardown_on_lock(&self) {}
    fn clear_staged_descriptor(&self) {}
    fn apply_screen_capture(&self, enabled: bool, _site: &'static str) {
        // Native screen-capture protection lives in `crate::screen_guard`. UIKit
        // (iOS) and `Window.setFlags` (Android) must run on the UI/main thread,
        // but this hook fires from the async command context — hop over via
        // Tauri's main-thread dispatch. Best-effort: a dispatch error (event loop
        // gone mid-teardown) is swallowed, matching desktop's warn-and-drop.
        let _ = self
            .app
            .run_on_main_thread(move || crate::screen_guard::apply(enabled));
    }

    // ---- Group 4: note-CRUD index/sync side-effects -----------------------
    fn search_upsert(&self, _: &str, _: &str, _: &str) {}
    fn search_remove(&self, _: &str) {}
    fn ai_note_changed(&self, _: &str, _: &str) {}
    fn ai_note_deleted(&self, _: &str) {}
    fn ai_policy_changed(&self, _: bool, _: &[String]) {}
    fn bump_local_change(&self) {
        // A local note edit nudges the coalesced-push counter so that when the
        // background sync loop lands (MYND-460) its push window actually opens.
        // Until then nothing reads the counter, so the bump is harmless. Guarded
        // by `try_state`: if `SyncLocalChange` is unmanaged the bump is a no-op
        // (mirrors desktop `src-tauri/src/hooks.rs::bump_local_change`).
        if let Some(sig) = self
            .app
            .try_state::<myne_core::plugins::sync::loop_control::SyncLocalChange>()
        {
            sig.bump();
        }
    }
    fn emit_snapshot_write_failed(&self, _: &str) {}

    // ---- Group 5: prefs application ---------------------------------------
    fn effective_auto_lock_secs(&self, prefs_value: Option<u32>) -> u32 {
        // Mobile has no auto-lock policy; fall back to the shared default the
        // runtime state seeds itself with (no desktop clamp range available).
        prefs_value.unwrap_or(myne_core::DEFAULT_AUTO_LOCK_SECS)
    }
    fn hydrate_clipper_pairing(&self, _: &[protocol::PairedExtension]) {}

    // ---- Group 6: auth-flow side-effects ----------------------------------
    fn preempt_inflight_backup<'a>(&'a self, _: &'a VaultRuntimeState) -> BoxFuture<'a> {
        Box::pin(std::future::ready(()))
    }
    fn invalidate_quick_unlock(&self, _: &std::path::Path) {}

    // ---- Group 7: note snapshot capture (the two live hooks) --------------
    fn capture_snapshot(
        &self,
        vault_root: &std::path::Path,
        note_uuid: &str,
        old_blob: &[u8],
        now_ms: u64,
        force: bool,
    ) -> bool {
        myne_core::snapshot_store::capture_snapshot_best_effort(
            vault_root, note_uuid, old_blob, now_ms, force,
        )
    }

    fn purge_note_snapshots(
        &self,
        vault_root: &std::path::Path,
        note_uuid: &str,
    ) -> std::io::Result<usize> {
        // The flat `snapshots/` dir is a sibling of `notes/` under the vault
        // root; the core hands us the vault root and we derive it here.
        myne_core::snapshot_store::remove_all_note_snapshots(
            &vault_root.join("snapshots"),
            note_uuid,
        )
    }
}
