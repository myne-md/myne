// SPDX-License-Identifier: AGPL-3.0
//! Desktop implementation of [`myne_core::hooks::VaultLifecycleHooks`].
//!
//! Holds the `AppHandle<R>` so the core trait methods stay AppHandle-free
//! (keeping the trait `R`-free and object-safe). Each method delegates to the
//! existing desktop free functions in the desktop-only modules (`search`,
//! `spell`, `attachments`, `pdf_export`, `workspace`, `screen_capture`, `sync`)
//! that do NOT live in `myne-core`.

use tauri::{AppHandle, Emitter, Manager, Runtime};

use myne_core::hooks::{BoxFuture, VaultLifecycleHooks};
use myne_core::plugins::vault_unlock::state::VaultRuntimeState;

/// Desktop wiring for the shared command-core lifecycle hooks.
pub struct DesktopHooks<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> DesktopHooks<R> {
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> VaultLifecycleHooks for DesktopHooks<R> {
    // ---- Group 1: async ---------------------------------------------------
    fn hydrate_attachment_refs<'a>(&'a self, state: &'a VaultRuntimeState) -> BoxFuture<'a> {
        // Same shape as `reclaim_stray_attachment_blobs` below: a plain core
        // helper, reached through the host seam rather than an `AppHandle`.
        let host = myne_core::host::tauri_host::TauriHost::new(self.app.clone());
        let app = self.app.clone();
        Box::pin(async move {
            // The graph itself is managed host-side; without it there is
            // nothing to fill, which is the mobile/no-plugin case.
            let Some(refs) =
                app.try_state::<myne_core::plugins::attachments::reconcile::AttachmentRefsState>()
            else {
                return;
            };
            myne_core::plugins::attachments::commands::hydrate_attachment_refs_core(
                &host,
                &myne_core::vault_io::StdVaultIo,
                state,
                refs.inner(),
            )
            .await
        })
    }

    fn hydrate_search_index<'a>(&'a self, state: &'a VaultRuntimeState) -> BoxFuture<'a> {
        let app = self.app.clone();
        Box::pin(async move {
            crate::plugins::notes::search_sync::hydrate_search_index(&app, state).await;
            // MYND-441: the rebuild above defers OCR (it injects
            // `extract_deferring_ocr`), so image and scanned-PDF attachments
            // finish it with no cache entry. Kick the background worker that
            // drains them. DETACHED on purpose — waiting here would put
            // seconds-per-page work back on the unlock path, which is the exact
            // stall the deferral exists to remove.
            crate::plugins::attachments::ocr_queue::spawn(app.clone());
        })
    }

    fn hydrate_spell<'a>(&'a self, state: &'a VaultRuntimeState) -> BoxFuture<'a> {
        Box::pin(crate::spell::sync::hydrate_spell(&self.app, state))
    }

    fn reclaim_stray_attachment_blobs<'a>(&'a self, state: &'a VaultRuntimeState) -> BoxFuture<'a> {
        // The core helper now takes `&dyn HostCtx` rather than an `AppHandle`
        // (phase3-web-client task 79). This is the ONE host-crate edit the whole
        // port needed, and it is instructive: Option B keeps every
        // `#[tauri::command]` wrapper — and therefore every `generate_handler!`
        // line — untouched, but this is not a command. It is a hooks
        // implementation calling a plain helper, so a signature change reaches
        // the host directly. Mobile is unaffected: its `NoopHooks`-style impl
        // ignores this method entirely.
        let host = myne_core::host::tauri_host::TauriHost::new(self.app.clone());
        Box::pin(async move {
            crate::plugins::attachments::commands::reclaim_stray_attachment_blobs(
                &host,
                &myne_core::vault_io::StdVaultIo,
                state,
            )
            .await
        })
    }

    fn persist_search_index<'a>(&'a self, state: &'a VaultRuntimeState) -> BoxFuture<'a> {
        Box::pin(crate::plugins::notes::search_sync::persist_search_index(
            &self.app, state,
        ))
    }

    fn hydrate_ai_vectors<'a>(&'a self, state: &'a VaultRuntimeState) -> BoxFuture<'a> {
        // semantic-search-qa task 3: embed-on-unlock. Feature-gated so the
        // default auditable build carries no AI trigger; the walk itself is
        // opt-in (`ai_enabled`) + best-effort + off the unlock hot path.
        #[cfg(feature = "local-inference")]
        {
            Box::pin(crate::plugins::local_inference::hydrate::hydrate_ai_vectors(&self.app, state))
        }
        #[cfg(not(feature = "local-inference"))]
        {
            let _ = state;
            Box::pin(std::future::ready(()))
        }
    }

    fn index_note_attachments<'a>(
        &'a self,
        state: &'a VaultRuntimeState,
        note_id: &'a str,
        note_title: &'a str,
        note_body: &'a str,
    ) -> BoxFuture<'a> {
        let app = self.app.clone();
        let note_id = note_id.to_string();
        let note_title = note_title.to_string();
        let body = note_body.to_string();
        Box::pin(async move {
            // MYND-448a: derive this note's per-attachment search docs. The
            // refs-first guard skips even the `vault_dir` resolution + KEK derive
            // for the common no-attachment save (it still syncs an empty set
            // below, dropping any attachment docs the note no longer embeds).
            let atts = if crate::plugins::attachments::reconcile::extract_att_ids(&body).is_empty()
            {
                Vec::new()
            } else if let Ok(vault_dir) =
                crate::paths::vault_dir_for_id(&app, state.active_vault_id().await)
            {
                crate::plugins::notes::search_sync::note_attachment_docs(
                    state,
                    &vault_dir,
                    &note_title,
                    &body,
                )
                .await
            } else {
                Vec::new()
            };
            // Always reconcile the live index: an empty set removes the docs of
            // any attachment this save un-embedded.
            if let Some(s) = app.try_state::<crate::search::SearchIndexState>() {
                s.set_note_attachments(&note_id, &atts);
            }
        })
    }

    // ---- Group 2: sync ----------------------------------------------------
    fn zeroize_search_index(&self) {
        crate::plugins::notes::search_sync::zeroize_search_index(&self.app);
    }
    fn zeroize_spell(&self) {
        crate::spell::sync::zeroize_spell(&self.app);
    }
    fn zeroize_vault_indices(&self) {
        crate::plugins::vault_indices::zeroize_vault_indices(&self.app);
        // semantic-search-qa task 2: the AI vector store is a plaintext-derived
        // RAM index wiped on the SAME leg as vault.indices (manual lock / relock
        // / delete route through here). Feature-gated so the default auditable
        // build carries no AI teardown.
        #[cfg(feature = "local-inference")]
        crate::plugins::local_inference::zeroize_ai_vectors(&self.app);
    }
    fn zeroize_attachment_refs(&self) {
        crate::plugins::attachments::zeroize_attachment_refs(&self.app);
    }
    fn abort_active_recording(&self) {
        crate::plugins::attachments::abort_active_recording(&self.app);
    }
    fn pdf_export_teardown_on_lock(&self) {
        crate::plugins::pdf_export::teardown_on_lock(&self.app);
    }
    /// myne#529: an agent run holds a note-id set derived from decrypted
    /// plaintext, a transcript containing whole note bodies, and a proposal
    /// built out of them. None of it may outlive the unlocked session, and the
    /// feature persists nothing across a lock because there is no blob to wipe.
    ///
    /// **This used to be two lines inside `zeroize_vault_indices`, and moving
    /// it out is the whole point.** That body is already non-empty for its own
    /// state, so deleting the agent lines left every gate green while a locked
    /// vault's note bodies stayed in the transcript:
    /// `scripts/check-lock-teardown.mjs` is keyed on `<hook, holder>` and had
    /// no hook to key on. It now has two rows here, one per state type.
    fn agent_teardown_on_lock(&self) {
        #[cfg(feature = "local-inference")]
        crate::plugins::agent::teardown_on_lock(&self.app);
    }
    /// myne#679: destroy every open detached (`note-<id>`) pop-out window and
    /// clear the registry. A detached window is a second plaintext-bearing
    /// WebView (the same shape as the hidden pdf-export window above), so on lock
    /// its V8 heap must be dropped along with the main window's — a locked vault
    /// leaves no note text on screen in ANY window (threat-model A6).
    fn detached_windows_teardown_on_lock(&self) {
        crate::plugins::detached_window::teardown_on_lock(&self.app);
    }
    fn clear_staged_descriptor(&self) {
        crate::plugins::workspace::commands::clear_staged_descriptor();
    }
    fn apply_screen_capture(&self, enabled: bool, site: &'static str) {
        crate::screen_capture::apply(&self.app, enabled, site);
    }

    // ---- Group 4: note-CRUD index/sync side-effects -----------------------
    fn search_upsert(&self, id: &str, title: &str, body: &str) {
        if let Some(s) = self.app.try_state::<crate::search::SearchIndexState>() {
            s.upsert(id, title, body);
        }
    }
    fn search_remove(&self, id: &str) {
        if let Some(s) = self.app.try_state::<crate::search::SearchIndexState>() {
            // MYND-448a: a note delete drops its body doc AND its separate
            // attachment docs (`att:*:<id>`).
            s.remove_note_and_attachments(id);
        }
    }
    fn ai_note_changed(&self, id: &str, body: &str) {
        // MYND-453: eager per-note re-embed into the RAM vector store so a
        // this-session save is searchable without a re-unlock. Feature-gated;
        // the target is detached + best-effort, so the save path never blocks.
        #[cfg(feature = "local-inference")]
        crate::plugins::local_inference::hydrate::reembed_one_note(&self.app, id, body);
        #[cfg(not(feature = "local-inference"))]
        {
            let _ = (id, body);
        }
    }
    fn ai_note_deleted(&self, id: &str) {
        #[cfg(feature = "local-inference")]
        crate::plugins::local_inference::hydrate::drop_one_note(&self.app, id);
        #[cfg(not(feature = "local-inference"))]
        {
            let _ = id;
        }
    }
    fn ai_policy_changed(&self, enabled: bool, excluded: &[String]) {
        // SYNC-14: apply the just-written opt-in + exclusion set to the resident
        // store so it takes effect against ALREADY-embedded notes. Turning AI off
        // zeroizes the whole store (and bumps the teardown generation so any
        // in-flight embed walk's publish is a no-op); an exclusion change refreshes
        // the query-time policy and purges the now-excluded notes.
        #[cfg(feature = "local-inference")]
        {
            use crate::plugins::local_inference::vector_store::LocalInferenceVectorState;
            if !enabled {
                crate::plugins::local_inference::zeroize_ai_vectors(&self.app);
            } else if let Some(vs) = self.app.try_state::<LocalInferenceVectorState>() {
                let mut store = vs.lock();
                store.set_policy(true, excluded);
                store.purge_excluded();
            }
        }
        #[cfg(not(feature = "local-inference"))]
        {
            let _ = (enabled, excluded);
        }
    }
    fn bump_local_change(&self) {
        if let Some(sig) = self
            .app
            .try_state::<crate::plugins::sync::loop_control::SyncLocalChange>()
        {
            sig.bump();
        }
    }
    fn emit_snapshot_write_failed(&self, note_id: &str) {
        let _ = self
            .app
            .emit(crate::plugins::notes::SNAPSHOT_WRITE_FAILED_EVENT, note_id);
    }
    fn emit_notes_deleted(&self, note_id: &str) {
        // myne#681: tell every window a note was deleted, so a detached (pop-out)
        // window holding it shows the terminal "deleted elsewhere" state rather
        // than autosaving its stale buffer back. note_id only, never plaintext.
        let _ = self
            .app
            .emit(crate::plugins::notes::NOTES_DELETED_EVENT, note_id);
    }

    // ---- Group 5: prefs application ---------------------------------------
    // `effective_auto_lock_secs` is deliberately NOT overridden: the trait's
    // default IS `myne_core::effective_auto_lock_secs`, which is what this body
    // delegated to through `crate::auto_lock`'s re-export (myne-md/myne#479).
    // Three implementors each writing the same one-line delegation is three
    // places the next reader has to check, and two of the three were wrong when
    // this was measured.
    fn hydrate_clipper_pairing(&self, paired: &[protocol::PairedExtension]) {
        // MYND-443: hydrate the browser-clipper pairing-token registry from the
        // just-read prefs blob so a paired extension keeps working after a
        // relaunch and a revoked one stays revoked. The `PairingState`
        // singleton is managed by the `clipper-pairing` plugin; its absence
        // (clipper plugin not installed) is a no-op. Token VALUES never log.
        if let Some(pairing) = self
            .app
            .try_state::<crate::plugins::clipper_pairing::state::PairingState>()
        {
            let registry = crate::clipper::token::TokenRegistry::from_paired_extensions(paired);
            let live = registry.live_extension_ids().len();
            pairing.replace_registry(registry);
            tracing::debug!(
                event = "clipper_pairing_registry_loaded",
                live_pairings = live,
            );
        }
    }

    // ---- Group 6: auth-flow side-effects ----------------------------------
    fn preempt_inflight_backup<'a>(&'a self, state: &'a VaultRuntimeState) -> BoxFuture<'a> {
        Box::pin(
            crate::plugins::backup::commands::preempt_inflight_backup_for_user_auth(
                state, &self.app,
            ),
        )
    }
    fn invalidate_quick_unlock(&self, vault_dir: &std::path::Path) {
        crate::plugins::quick_unlock::commands::invalidate_credential(vault_dir);
    }

    // ---- Group 7: note snapshot capture -----------------------------------
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
        crate::snapshot_store::remove_all_note_snapshots(&vault_root.join("snapshots"), note_uuid)
    }
}
