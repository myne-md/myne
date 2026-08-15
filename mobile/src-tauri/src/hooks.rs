// SPDX-License-Identifier: AGPL-3.0
//! Mobile implementation of [`myne_core::hooks::VaultLifecycleHooks`].
//!
//! Mobile carries few of the desktop-only side-effect subsystems (search,
//! spell, workspace, … are still absent), so most hooks are no-ops — the same
//! shape as `myne_core::hooks::NoopHooks`.
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
//! harmless nudge.
//!
//! A fourth live hook is
//! [`apply_screen_capture`](MobileHooks::apply_screen_capture) (MYND-469):
//! native screen-capture protection via `crate::screen_guard` (iOS
//! secure-field layer splice / Android FLAG_SECURE bridge).
//!
//! The fifth, sixth and seventh are the **lock-teardown** hooks
//! [`zeroize_search_index`](MobileHooks::zeroize_search_index),
//! [`zeroize_vault_indices`](MobileHooks::zeroize_vault_indices) and
//! [`zeroize_attachment_refs`](MobileHooks::zeroize_attachment_refs)
//! (myne-md/myne#454). Each resolves the state `lib.rs` manages and `clear()`s
//! it, mirroring the desktop twins. They are not optional the way the absent
//! subsystems below are: mobile HOLDS all three of these states for the process
//! lifetime, so an empty body means a locked vault's plaintext-derived strings
//! stay in RAM and bleed into the next vault to unlock. `scripts/check-lock-
//! teardown.mjs` is the machine half of that rule.
//!
//! Every other hook stays a no-op until its subsystem lands on mobile (see
//! `mobile/CLAUDE.md`) — `zeroize_spell`, `abort_active_recording`,
//! `pdf_export_teardown_on_lock` and `clear_staged_descriptor` are empty
//! because mobile holds no spell engine, no in-process recording session, no
//! pdf-export window and no staged workspace descriptor (it does not register
//! `workspace_stage`). Those are absences, not omissions.

use myne_core::hooks::{BoxFuture, VaultLifecycleHooks};
use myne_core::plugins::vault_unlock::state::VaultRuntimeState;
use tauri::{AppHandle, Manager, Runtime};

/// Mobile wiring for the shared command-core lifecycle hooks: no-op for every
/// subsystem mobile does not carry, live for the two snapshot hooks (which
/// drive the `myne-core` snapshot store), `bump_local_change` (nudges the
/// shared `SyncLocalChange` counter), `apply_screen_capture` (native
/// screen-capture protection, MYND-469) and the three lock-teardown wipes
/// (myne-md/myne#454). Holds an [`AppHandle`] because all of those resolve
/// app-managed state via `try_state` — the teardown wipes reach
/// `SearchIndexState` / `VaultIndicesState` / `AttachmentRefsState`,
/// `bump_local_change` reaches `SyncLocalChange`, and the screen-capture hook
/// reaches `screen_guard::apply` (which owns its per-platform threading).
/// Mirrors the desktop `DesktopHooks`.
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
    // Owed like its siblings: the unlock-time reference-graph rebuild (MYND-171,
    // desktop `myne#143`) is not dispatched on mobile yet, and the RAM graph is
    // populated lazily on save regardless. No-op; never blocks an unlock.
    fn hydrate_attachment_refs<'a>(&'a self, _: &'a VaultRuntimeState) -> BoxFuture<'a> {
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

    // ---- Group 2: sync ----------------------------------------------------
    //
    // The three teardown hooks below were empty bodies until myne-md/myne#454,
    // while `lib.rs` managed all three states for the process lifetime. Nothing
    // else can wipe them: `myne-core` already calls these hooks at every
    // slot-drop site there is (manual/auto `lock_from_host`, the vault-SWITCH
    // branch of `unlock_from_host`, `vault_delete`, the change-password
    // force-relock), so the client supplies the bodies and only the bodies.
    // Empty, a lock left the prior vault's index in RAM and mobile's additive
    // re-seed stacked the next vault's records on top of it.
    // The `else` arms are not decoration. A wipe that reaches nothing is the
    // same defect as an empty body wearing a body, and it is invisible to
    // `scripts/check-lock-teardown.mjs`, which can only see that a body is
    // non-empty. If the state stops being managed under this exact type, the
    // teardown silently stops happening and the log stays clean, which is
    // precisely how myne#454 survived. Static tag only, no vault content
    // (`src-tauri/CLAUDE.md` "Secret-handling logging discipline").
    fn zeroize_search_index(&self) {
        match self.app.try_state::<myne_core::search::SearchIndexState>() {
            Some(search) => search.clear(),
            None => tracing::warn!(
                event = "lock_teardown_state_absent",
                hook = "zeroize_search_index"
            ),
        }
    }
    fn zeroize_spell(&self) {}
    fn zeroize_vault_indices(&self) {
        // No AI arm, unlike the desktop twin: mobile `local_inference` is
        // transcription-only (no embedding role), so there is no vector store
        // to wipe on this leg.
        match self
            .app
            .try_state::<crate::plugins::vault_indices::VaultIndicesState>()
        {
            Some(indices) => indices.clear(),
            None => tracing::warn!(
                event = "lock_teardown_state_absent",
                hook = "zeroize_vault_indices"
            ),
        }
    }
    fn zeroize_attachment_refs(&self) {
        match self
            .app
            .try_state::<crate::plugins::attachments::AttachmentRefsState>()
        {
            Some(refs) => refs.clear(),
            None => tracing::warn!(
                event = "lock_teardown_state_absent",
                hook = "zeroize_attachment_refs"
            ),
        }
    }
    fn abort_active_recording(&self) {}
    fn pdf_export_teardown_on_lock(&self) {}
    fn clear_staged_descriptor(&self) {}
    fn apply_screen_capture(&self, enabled: bool, site: &'static str) {
        // Native screen-capture protection lives in `crate::screen_guard`,
        // which owns the per-platform threading: iOS hops to the main thread
        // itself (UIKit), while the Android arm is a blocking JNI round-trip
        // SERVICED BY the main thread — it must run right here on the async
        // command thread (dispatching it onto the main thread would deadlock;
        // see `screen_guard.rs` "Threading").
        crate::screen_guard::apply(&self.app, enabled, site);
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
    fn emit_snapshot_write_failed(&self, note_id: &str) {
        // #47: this was a bare empty body while mobile really does capture
        // snapshots (`capture_snapshot_best_effort` below), so a snapshot that
        // failed to write was silent — the user kept editing a note whose
        // version history had quietly stopped recording, and the BK-05 banner
        // the design calls for had no signal to render from.
        //
        // Best-effort like the desktop twin: a failed emit must never fail the
        // save that produced the warning.
        use tauri::Emitter;
        let _ = self.app.emit(
            myne_core::plugins::notes::SNAPSHOT_WRITE_FAILED_EVENT,
            note_id,
        );
    }

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
    fn invalidate_quick_unlock(&self, vault_dir: &std::path::Path) {
        // Master-password change wipes the quick-unlock credential (blob +
        // attempt counter + the iOS Keychain item, if biometric) — the § 9.14.4
        // lifecycle rule, same delegation as desktop `hooks.rs`.
        myne_core::plugins::quick_unlock::commands::invalidate_credential(vault_dir);
    }

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
