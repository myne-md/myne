// SPDX-License-Identifier: AGPL-3.0
//! `WebHooks` — the browser's [`VaultLifecycleHooks`] (phase3-web-client task 83).
//!
//! # Why inheriting `NoopHooks` was a silent bug, not a placeholder
//!
//! `VaultLifecycleHooks` is the ONLY channel through which the shared command
//! cores trigger index, sync and snapshot side-effects. Desktop installs
//! `DesktopHooks`, mobile installs `NoopHooks` — and the web client, having no
//! implementation, inherited `NoopHooks` by default. That is not a reduced
//! feature set; it is four things quietly not happening, and one of them
//! defeats the client's stated goal:
//!
//! **`bump_local_change` is the only thing that increments the counter the sync
//! loop edge-triggers on.** With `NoopHooks` a browser edit never opens a push
//! cycle, so sync is one-way: a web user pulls everyone else's notes and pushes
//! none of their own, forever, with no error anywhere. That is the single most
//! important line in this file.
//!
//! # Every method has a FATE, and the fates are three
//!
//! The trait is deliberately not shrunk for this client (`hooks.rs`'s own rule:
//! a member that cannot exist on web stays a no-op with a written reason, it is
//! not deleted). So each method below is exactly one of:
//!
//! * **implemented** — it does the web thing;
//! * **decided absent** — the feature is not on this client, and the reason is
//!   the settled one from `decisions.md` 2026-07-26 / task 27's capability set;
//! * **owed** — the subsystem it drives is not ported yet, and the owning task
//!   is named. These are the ones a reader must be able to tell apart from the
//!   line above, because one is a decision and the other is a debt.
//!
//! Nothing here is an unexplained `{}`.

use myne_core::hooks::{BoxFuture, VaultLifecycleHooks};
use myne_core::plugins::vault_unlock::state::VaultRuntimeState;

/// The browser's lifecycle hooks. See the module doc for the three fates.
#[derive(Debug, Default, Clone, Copy)]
pub struct WebHooks;

use myne_core::plugins::notes::search_sync_core::{
    hydrate_search_index_core, log_search_sync_skip, persist_search_index_core, NoAttachmentDocs,
};

impl VaultLifecycleHooks for WebHooks {
    // ── Group 1: unlock-time hydration ──────────────────────────────────────

    /// **Implemented** (tasks 14 + 83). Loads `vault.search`, reconciles it
    /// against the notes directory's `.myn` header nonces and swaps the result
    /// into the Worker's index — the same `search_sync_core` desktop runs.
    ///
    /// `NoAttachmentDocs`: a browser indexes note BODIES only. The `att:`
    /// documents desktop builds come from the `MYE1` extracted-text cache, whose
    /// producers are absent from this target by `cfg`, so there is no path that
    /// could emit one. Carrying stale `att:` docs synced from a desktop would be
    /// worse than having none — they would point at text this client can neither
    /// re-derive nor verify.
    ///
    /// Best-effort, like every caller: a failure here leaves search stale until
    /// the next reconcile and must never block unlock.
    fn hydrate_search_index<'a>(&'a self, state: &'a VaultRuntimeState) -> BoxFuture<'a> {
        Box::pin(async move {
            let Ok(vault_dir) = myne_core::paths::active_vault_root_io_from_host(
                crate::dispatch::host_ctx(),
                state.active_vault_id().await,
            ) else {
                return;
            };
            let mut none = NoAttachmentDocs;
            if let Err(e) = hydrate_search_index_core(
                crate::dispatch::vault_io(),
                crate::dispatch::host_ctx(),
                &vault_dir,
                state,
                crate::session::search(),
                &mut none,
            )
            .await
            {
                log_search_sync_skip("hydrate", &e);
            }
        })
    }

    /// **Decided absent.** Spell-check is not on this client — `spellCheck` is
    /// in the web capability descriptor's ABSENT set and the plugin is
    /// `Class::Unsupported` (task 47: dictionaries are bundled binary resources
    /// and would dominate a bundle whose trust story is that it is small enough
    /// to audit). The `MYD1` personal dictionary is untouched by that: it is
    /// vault content and keeps syncing.
    fn hydrate_spell<'a>(&'a self, _: &'a VaultRuntimeState) -> BoxFuture<'a> {
        Box::pin(std::future::ready(()))
    }

    /// **Owed — task 44's sweep half.** The reclaim walks `attachments/` for
    /// catalog-less strays; the walk is seam-ready but nothing calls it on web
    /// until the unlock pipeline is dispatched.
    fn reclaim_stray_attachment_blobs<'a>(&'a self, _: &'a VaultRuntimeState) -> BoxFuture<'a> {
        Box::pin(std::future::ready(()))
    }

    /// **Owed — the unlock-time reference-graph rebuild is not dispatched on web
    /// yet.** On desktop this scans every note on unlock to repopulate the
    /// RAM-only attachment-reference graph (MYND-171) that backs the "used in N
    /// notes" badge. The scan seam is async-ready on this target, but nothing on
    /// this client drives that per-note badge, and the graph is populated lazily
    /// by `attachment_refs_apply` as notes are SAVED regardless — so an empty
    /// hydrate is honest until that surface ships. Like every caller: best-effort
    /// and must never block an unlock the user completed.
    fn hydrate_attachment_refs<'a>(&'a self, _: &'a VaultRuntimeState) -> BoxFuture<'a> {
        Box::pin(std::future::ready(()))
    }

    /// **Implemented** (tasks 14 + 83). Snapshots the live index, re-derives the
    /// nonce manifest from disk so the snapshot matches exactly, and writes the
    /// encrypted `vault.search` blob. Must run while the slot is still
    /// `Unlocked` — the core holds the writer guard across the write.
    fn persist_search_index<'a>(&'a self, state: &'a VaultRuntimeState) -> BoxFuture<'a> {
        Box::pin(async move {
            let Ok(vault_dir) = myne_core::paths::active_vault_root_io_from_host(
                crate::dispatch::host_ctx(),
                state.active_vault_id().await,
            ) else {
                return;
            };
            if let Err(e) = persist_search_index_core(
                crate::dispatch::vault_io(),
                &vault_dir,
                state,
                crate::session::search(),
            )
            .await
            {
                log_search_sync_skip("persist", &e);
            }
        })
    }

    /// **Owed — task 14** (it writes attachment docs into the same index).
    fn index_note_attachments<'a>(
        &'a self,
        _: &'a VaultRuntimeState,
        _: &'a str,
        _: &'a str,
        _: &'a str,
    ) -> BoxFuture<'a> {
        Box::pin(std::future::ready(()))
    }

    // ── Group 2: lock-time teardown ─────────────────────────────────────────
    //
    // Every member here clears plaintext-bearing RAM, which is what makes lock
    // mean something. The two that are OWED are owed because the RAM they would
    // clear does not exist on this client yet — an empty zeroize is honest only
    // while that stays true, and the naming here is what makes it re-checkable.

    /// **Implemented** (tasks 14 + 83), and it had to land in the same change as
    /// the index itself: a populated index surviving lock is decrypted note text
    /// — titles, tokenised bodies, note ids — outliving the keys that protected
    /// it, in a tab the user believes is locked.
    fn zeroize_search_index(&self) {
        crate::session::search().clear();
    }

    /// **Decided absent** — see `hydrate_spell`.
    fn zeroize_spell(&self) {}

    /// **Implemented.** `vault_indices` IS ported and dispatched (task 31), so
    /// its RAM is real and lock must empty it.
    fn zeroize_vault_indices(&self) {
        crate::session::indices().clear();
    }

    /// **Implemented, and it is the browser-specific one.** The attachment-ref
    /// graph on web is the object-URL cache: each entry is a `blob:` URL, and an
    /// object URL is a GC ROOT for its `Blob`, so an unrevoked one pins
    /// DECRYPTED attachment bytes for the life of the page. Revoking at lock is
    /// exactly what lock is for.
    ///
    /// The dispatcher's `plugin:vault-unlock|lock` arm also revokes, deliberately
    /// — that path runs even when the lock core errors. This is the hook-driven
    /// half, for lock paths that do not go through that arm (idle auto-lock, a
    /// lock triggered by the sync engine).
    fn zeroize_attachment_refs(&self) {
        crate::attachment_url::revoke_all();
    }

    /// **Decided absent.** Voice recording is desktop-only (`voice_record_*` is
    /// not dispatched; task 47's capture decision).
    fn abort_active_recording(&self) {}

    /// **Decided absent.** PDF export drives a hidden Tauri WebView; the
    /// obstacle is the OUTPUT format, not the destination, and `pdf-export` is
    /// `Class::Unsupported` (task 48).
    fn pdf_export_teardown_on_lock(&self) {}
    fn agent_teardown_on_lock(&self) {}
    /// **Decided absent.** Detached pop-out windows are OS windows; a browser tab
    /// cannot open one, so `detached-window` is `Class::Unsupported` and this
    /// client holds no registry to tear down.
    fn detached_windows_teardown_on_lock(&self) {}

    /// **Implemented (epic live-collab).** A live co-editing session holds
    /// decrypted note plaintext; the Worker's registry is a process-global, so it
    /// is cleared here on every vault-leaving hook rather than dropped with a
    /// Tauri `State`.
    fn live_session_teardown_on_lock(&self) {
        crate::session::live_sessions().clear();
    }

    /// **Implemented (task 65).** The staged descriptor is the WORKSPACE one —
    /// the pane tree the frontend mirrors into RAM on every layout change — and
    /// clearing it at lock is what stops the open-tab set from outliving the
    /// slot (A6) and what stops vault A's layout from flushing into vault B on
    /// a switch.
    ///
    /// It was a no-op here while the plugin lived in `src-tauri/`, and the
    /// comment that stood in its place named the wrong subsystem entirely. Both
    /// are fixed by the same change that gave the browser a pane layout at all.
    fn clear_staged_descriptor(&self) {
        myne_core::plugins::workspace::commands::clear_staged_descriptor();
    }

    /// **Decided absent.** Compositor-level screen-capture exclusion has no web
    /// API at all — `screenCaptureProtection` is in the descriptor's ABSENT set,
    /// and `threat-model.md` §7 qualifies that per client.
    fn apply_screen_capture(&self, _: bool, _: &'static str) {}

    // ── Group 3: per-note write side-effects ────────────────────────────────

    /// **Implemented** (tasks 14 + 83). These two are the ONLY writers into the
    /// index, so while they were empty a browser edit never reached search and
    /// the symptom — search missing a note the user had just typed — looked like
    /// a search bug rather than a missing port.
    fn search_upsert(&self, id: &str, title: &str, body: &str) {
        crate::session::search().upsert(id, title, body);
    }

    /// **Implemented.** See `search_upsert`.
    fn search_remove(&self, id: &str) {
        crate::session::search().remove_note_and_attachments(id);
    }

    /// **IMPLEMENTED, and this is the one that makes sync two-way.**
    ///
    /// Desktop bumps a `Manager::try_state` counter that the loop reads each
    /// tick; the browser's equivalent is its own scheduler, so the signal goes
    /// straight there. Without it a browser edit never opens a push cycle and a
    /// web user would pull forever and push nothing, with no error anywhere.
    fn bump_local_change(&self) {
        crate::sync_loop::signal_local_change();
    }

    /// **Implemented.** The event seam exists and the Worker posts it to the
    /// page on the same channel as command replies; a snapshot write failing
    /// silently is exactly the shape of bug this event was added for.
    fn emit_snapshot_write_failed(&self, note_id: &str) {
        use myne_core::host::{EventPayload, HostCtx};
        // The SHARED constant, not a literal (myne#291). The literal here used
        // the PLURAL spelling of the family segment, and nothing subscribes to
        // that: the canonical name is singular, the desktop hook already emits
        // through the constant, and the shared TS listener mirrors the singular
        // form. The Worker host demultiplexes by exact `Map` key, so the message
        // was dropped. Inert only because web has no snapshot writer yet; the
        // moment it gets one, the silent-snapshot-failure warning would have
        // shipped dead — exactly the failure the event exists to surface.
        crate::host::WebHost.emit(
            myne_core::plugins::notes::SNAPSHOT_WRITE_FAILED_EVENT,
            EventPayload::Text(note_id.to_string()),
        );
    }
    // myne#681: no-op. Detached (pop-out) note windows are OS windows a browser
    // tab cannot open, so the web client has nothing to notify of a delete.
    fn emit_notes_deleted(&self, _: &str) {}

    // ── Group 5/6: policy + auth-flow side-effects ──────────────────────────

    // `effective_auto_lock_secs` is deliberately NOT overridden: the trait's
    // default is `myne_core::effective_auto_lock_secs`, which clamps
    // (myne-md/myne#479).
    //
    // The override that stood here returned `prefs_value.unwrap_or(DEFAULT)`
    // under an argument about the idle SOURCE, "not the desktop clamp: that
    // range exists because an OS idle detector feeds it, and `osIdleAutoLock` is
    // in the web descriptor's ABSENT set". That is a fair argument about the
    // FLOOR, which `core/src/lib.rs` documents as a UX-comfort bound and not a
    // security edge. It is not an argument about the CEILING, which is the
    // security half: `AUTO_LOCK_CEILING_SECS` is load-bearing because
    // `vault.prefs` is a replayable blob and the clamp is what keeps a tampered
    // `auto_lock_seconds` able only to SHORTEN the timeout. OPFS is as
    // replayable as a disk, so on this client a replayed 4_000_000_000 gave an
    // unbounded A6 exposure window (`threat-model.md` §7).
    //
    // The same body was found on mobile in the same pass, which is the point
    // worth recording: nothing compares these three files. The twin inventory's
    // `TREE_PAIRS` are `(src, mobile/src)` and `(src-tauri/src,
    // mobile/src-tauri/src)`, so `web/wasm/src/` is outside the inventory, the
    // drift ratchet and `check-twin-drift.mjs` alike, this one was found by
    // reading, not by a guard. If the browser timer turns out to need a
    // different FLOOR, override and argue for that alone.

    /// **Decided absent.** The clipper is a native-messaging host; `clipper` is
    /// in the descriptor's ABSENT set.
    fn hydrate_clipper_pairing(&self, _: &[protocol::PairedExtension]) {}

    /// **Decided absent.** Backup export/restore is `Class::Unsupported`
    /// (`decisions.md` 2026-07-26), so there is never one in flight to pre-empt.
    fn preempt_inflight_backup<'a>(&'a self, _: &'a VaultRuntimeState) -> BoxFuture<'a> {
        Box::pin(std::future::ready(()))
    }

    /// **Owed — task 40** (the PIN quick-unlock path, which IS portable:
    /// Argon2id plus three files under one vault root, no OS secret). Absent
    /// today, so there is no credential to invalidate; `biometricQuickUnlock` is
    /// the part that is decided absent, and it is a different capability.
    fn invalidate_quick_unlock(&self, _: &std::path::Path) {}

    // ── Group 7: note snapshots ─────────────────────────────────────────────

    /// **Owed — task 46/83's snapshot half.** `snapshot_store.rs` is still on the
    /// io-seam ratchet (it writes through `atomic_write`), so it has no OPFS
    /// implementation to call. Returns `false` = "no warning to surface", which
    /// is truthful: nothing failed, because nothing was attempted.
    fn capture_snapshot(
        &self,
        _vault_root: &std::path::Path,
        _note_uuid: &str,
        _old_blob: &[u8],
        _now_ms: u64,
        _force: bool,
    ) -> bool {
        false
    }

    /// **Owed — same as `capture_snapshot`**, and the pairing matters: these two
    /// are the only creation and cryptographic-erase paths for snapshots, so
    /// they must land together. Shipping the capture without the purge would
    /// leave a note's history behind after the note is deleted — the opposite of
    /// SYNC-1's crypto-erase.
    fn purge_note_snapshots(
        &self,
        _vault_root: &std::path::Path,
        _note_uuid: &str,
    ) -> std::io::Result<usize> {
        Ok(0)
    }
}
