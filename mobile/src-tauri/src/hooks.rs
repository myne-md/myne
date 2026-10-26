// SPDX-License-Identifier: AGPL-3.0
//! Mobile implementation of [`myne_core::hooks::VaultLifecycleHooks`].
//!
//! Mobile carries none of the desktop-only side-effect subsystems (spell,
//! backup, importer, clipper pairing), so most hooks are no-ops — the same
//! shape as `myne_core::hooks::NoopHooks`. The search, workspace and themes
//! plugins that do exist here are driven by their own commands.
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
//! The eighth is [`agent_teardown_on_lock`](MobileHooks::agent_teardown_on_lock)
//! (myne-md/myne#456), and it belongs to the same family as the three above for
//! the same reason: this client now holds the agent's run table and its session
//! transcript, so an empty body would be a lock that does not lock. On this
//! client it is also the ORDINARY path rather than an exceptional one, because
//! a run dies with the foreground here by decision.
//!
//! Every other hook stays a no-op until its subsystem lands on mobile (see
//! `mobile/AGENTS.md`) — `zeroize_spell`, `abort_active_recording`,
//! `pdf_export_teardown_on_lock`, `detached_windows_teardown_on_lock` and
//! `clear_staged_descriptor` are empty because mobile holds no spell engine, no
//! in-process recording session, no pdf-export window, no detached (pop-out)
//! note windows (there are no OS windows to pop out into) and no staged
//! workspace descriptor (it does not register `workspace_stage`). Those are
//! absences, not omissions.

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
    // (`src-tauri/AGENTS.md` "Secret-handling logging discipline").
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
    /// **Not empty since myne-md/myne#456**, and the empty version is worth
    /// naming because it is what `scripts/check-lock-teardown.mjs` exists to
    /// refuse: this client now HOLDS both tables, so an empty body here is not
    /// "the subsystem is not here", it is a lock that does not lock.
    ///
    /// A run holds a note-id set derived from decrypted plaintext, a transcript
    /// containing whole note bodies, and a proposal of anchors and replacements
    /// copied verbatim out of them. `myne-core` calls this at every slot-drop
    /// site, manual lock, idle auto-lock, the vault-SWITCH branch of unlock,
    /// `vault_delete`, the change-password force-relock: so the body is all
    /// this client owes.
    ///
    /// The vault-switch site is the one that makes it urgent rather than
    /// hygienic: without this, vault A's proposal is still in memory while
    /// vault B is open. And on this client it is also the ORDINARY path, not an
    /// exceptional one: a run dies with the foreground here by decision, so
    /// locking or pocketing the phone is how most runs end.
    fn agent_teardown_on_lock(&self) {
        crate::plugins::agent::teardown_on_lock(&self.app);
    }
    fn detached_windows_teardown_on_lock(&self) {}
    /// Drop every open live co-editing session (epic live-collab,
    /// `collab-editor-bridge`): a session holds decrypted note plaintext, so none
    /// may survive a lock, a switch, a delete or a force-relock.
    ///
    /// It also forgets the participant label `live_session_set_presence` stored on
    /// the awareness signal (myne-md/myne#849): that is the name this device shows
    /// peers in the vault being left, and it must not ride into the next one.
    fn live_session_teardown_on_lock(&self) {
        let registry = self
            .app
            .try_state::<myne_core::plugins::live::LiveSessionRegistry>();
        let signal = self
            .app
            .try_state::<myne_core::plugins::sync::awareness_listener::AwarenessSignal>();
        myne_core::plugins::live::teardown_on_lock(registry.as_deref(), signal.as_deref());
    }
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
    // myne#681: no-op. Detached (pop-out) note windows are desktop-only; mobile
    // has no OS window to notify of an out-of-band delete.
    fn emit_notes_deleted(&self, _: &str) {}

    // ---- Group 5: prefs application ---------------------------------------
    // `effective_auto_lock_secs` is deliberately NOT overridden: the trait's
    // default is `myne_core::effective_auto_lock_secs`, which clamps
    // (myne-md/myne#479).
    //
    // The body that stood here was `prefs_value.unwrap_or(DEFAULT_AUTO_LOCK_SECS)`
    // under a comment reading "mobile has no auto-lock policy … no desktop
    // clamp range available". Both halves were wrong by then: this client does
    // have an auto-lock, and the clamp was not desktop-specific, it was merely
    // in the desktop crate.
    //
    // What it cost is narrower than an earlier version of this comment claimed,
    // and the correction matters because the wrong version reads as a shipped
    // exposure. The value this hook returns feeds
    // `VaultRuntimeState::auto_lock_timeout_secs`, whose only production reader
    // is the desktop tick loop, which this client does not compile. This
    // client's actual idle timer is in the WebView and already clamped through
    // its own copy of the envelope. So the unclamped body was a TRAP for the
    // next Rust-side reader here, not a live A6 window. Defaulting the method is
    // what makes silence land on the guarantee; a client that wants a different
    // envelope overrides and argues for it.
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
