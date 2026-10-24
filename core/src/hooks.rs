// SPDX-License-Identifier: AGPL-3.0
//! Desktop-only vault-lifecycle side-effects, abstracted behind one
//! object-safe trait so the shared command cores call them uniformly while
//! mobile supplies a no-op.
//!
//! The desktop implementation stores its `AppHandle<R>` *inside* the impl
//! struct, so the trait methods take no `AppHandle` parameter and the trait
//! stays `R`-free and object-safe — a single `Arc<dyn VaultLifecycleHooks>`
//! is taken by every command as `State<'_, Hooks>` regardless of `R`.
//!
//! Async methods return a hand-rolled `Pin<Box<dyn Future + Send>>` (the
//! `async-trait` desugaring, written by hand) so the trait is object-safe
//! WITHOUT pulling in the `async-trait` dependency (repo-root AGENTS.md:
//! "Adding a dependency is a security decision"). Sync methods stay plain.
//!
//! Scope note: this is the note-CRUD + unlock/lock hook surface (the six
//! plugin cores that live in `myne-core`). Hooks that fire only inside the
//! desktop-only `backup` / `quick_unlock` / `workspace` plugin commands are
//! intentionally NOT here — the trait grows a method (plus a one-line
//! `NoopHooks` no-op) if a shared core ever needs one.
//!
//! Secret-handling: `note_body` passed to [`VaultLifecycleHooks::index_note_attachments`]
//! is plaintext — never log it (see `src-tauri/AGENTS.md` "Secret-handling
//! logging discipline").

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::plugins::vault_unlock::state::VaultRuntimeState;

/// Boxed-future alias for the hand-rolled async-in-`dyn`-trait methods.
///
/// **`Send` on native, `?Send` on `wasm32`** — the same split
/// `#[async_trait]` / `#[async_trait(?Send)]` already draws across this crate,
/// and drawn here for the same reason. A hook that touches storage awaits a
/// `VaultIo` future, and on `wasm32` those are `?Send` because the browser
/// arm's OPFS handles are bound to their Worker thread and cannot be moved off
/// it. Requiring `Send` there would make every storage-touching hook
/// unimplementable, which is what a `WebHooks` that reads `vault.search`
/// discovered.
///
/// Native behaviour is byte-identical: on every non-`wasm32` target this is the
/// bound it always was, so desktop and mobile see no change at all.
#[cfg(not(target_arch = "wasm32"))]
pub type BoxFuture<'a, T = ()> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
#[cfg(target_arch = "wasm32")]
pub type BoxFuture<'a, T = ()> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// The managed-state handle the command cores take as `State<'_, Hooks>`.
pub type Hooks = Arc<dyn VaultLifecycleHooks>;

/// Desktop-only side-effects the shared command cores trigger at note-CRUD and
/// vault unlock/lock boundaries. Desktop wires the real implementation; mobile
/// installs [`NoopHooks`].
///
/// Object-safe: no generic methods, async methods return [`BoxFuture`]. The
/// `AppHandle` each desktop method needs is captured by the concrete impl,
/// never threaded through these signatures.
pub trait VaultLifecycleHooks: Send + Sync + 'static {
    // ---- Group 1: async, vault-runtime-state-scoped ------------------------
    fn hydrate_search_index<'a>(&'a self, state: &'a VaultRuntimeState) -> BoxFuture<'a>;
    fn hydrate_spell<'a>(&'a self, state: &'a VaultRuntimeState) -> BoxFuture<'a>;
    fn reclaim_stray_attachment_blobs<'a>(&'a self, state: &'a VaultRuntimeState) -> BoxFuture<'a>;
    /// Rebuild the attachment reference graph from the notes on disk.
    ///
    /// The graph is RAM-only and `zeroize_attachment_refs` wipes it on lock, so
    /// unlike `vault.indices` (persisted, MYI1) it does not survive. It was only
    /// ever populated by `attachment_refs_apply` as notes are SAVED — which
    /// meant that after every app start each attachment reported "used in 0
    /// notes" until its referencing note happened to be re-saved.
    /// `reconcile.rs` names this gap in its own header; this is the sweep it
    /// says is missing.
    ///
    /// Best-effort like the other hydrates: a failure leaves the graph as empty
    /// as it already was and must never fail an unlock the user completed.
    fn hydrate_attachment_refs<'a>(&'a self, state: &'a VaultRuntimeState) -> BoxFuture<'a>;
    fn persist_search_index<'a>(&'a self, state: &'a VaultRuntimeState) -> BoxFuture<'a>;

    /// MYND-448a: index each attachment embedded in `note_body` as its OWN
    /// search doc (`att:<attachment>:<note_id>`), REPLACING the note's prior
    /// attachment docs (so an un-embedded attachment's doc is dropped). The
    /// note's own body doc is upserted separately with the UNFOLDED plaintext via
    /// [`Self::search_upsert`], so an attachment-content hit surfaces as a
    /// distinct result rather than folded into the note. `note_title` /
    /// `note_body` are plaintext — never log them. Mobile is a no-op (the note is
    /// still saved; only the attachment-content search feed is skipped).
    fn index_note_attachments<'a>(
        &'a self,
        state: &'a VaultRuntimeState,
        note_id: &'a str,
        note_title: &'a str,
        note_body: &'a str,
    ) -> BoxFuture<'a>;

    // ---- Group 2: sync, app-derived ---------------------------------------
    fn zeroize_search_index(&self);
    fn zeroize_spell(&self);
    fn zeroize_vault_indices(&self);
    fn zeroize_attachment_refs(&self);
    fn abort_active_recording(&self);
    fn pdf_export_teardown_on_lock(&self);
    /// Drop the agent run's plaintext-derived RAM tables (myne-md/myne#529).
    ///
    /// **A hook of its own rather than a line inside another body, and the
    /// reason is what makes this class invisible.** The desktop first cleared
    /// these inside `zeroize_vault_indices`, whose body is already non-empty for
    /// its own state, so deleting that one line left `cargo build`, `clippy
    /// -D warnings`, `cargo test`, `pre-commit` and CI all green while a locked
    /// vault's note bodies stayed resident in the agent transcript.
    /// `scripts/check-lock-teardown.mjs` is keyed on `<hook, holder>` pairs and
    /// can only speak for a hook that exists, which is why this one does.
    /// `pdf_export_teardown_on_lock` above is the same shape for the same reason.
    fn agent_teardown_on_lock(&self);
    /// Destroy every open detached (pop-out) note window and clear the registry
    /// on lock (myne-md/myne#679, epic #173).
    ///
    /// A hook of its own for the same reason as `pdf_export_teardown_on_lock`
    /// above: a detached window is a SECOND plaintext-bearing WebView, and its
    /// note body lives in that window's own V8 heap, which the main window's
    /// teardown cannot reach. Destroying the window drops that heap
    /// (`threat-model.md` A6); leaving it would keep a locked vault's note text
    /// on screen in the pop-out. Desktop holds the [`DetachedWindowRegistry`] and
    /// wires the real body; mobile and web have no OS windows and no-op it.
    /// `scripts/check-lock-teardown.mjs` keys a PAIRS row on that registry so a
    /// client that holds it cannot ship the body empty.
    fn detached_windows_teardown_on_lock(&self);
    /// Drop every open live co-editing session on lock (epic live-collab,
    /// `collab-editor-bridge`).
    ///
    /// A live session holds decrypted note plaintext (the whole note is the
    /// Automerge `Text`) for as long as it is open, so a lock, a vault switch, a
    /// delete or a change-password force-relock that left one resident would
    /// recreate the `myne-md/myne#454` class: a locked vault's content in RAM, and
    /// records leaking into the next vault. The client holds `LiveSessionRegistry`
    /// (`app.manage` on desktop/mobile, a `OnceLock` on web) and clears it here;
    /// `scripts/check-lock-teardown.mjs` keys a PAIRS row on that registry so an
    /// empty body cannot ship.
    fn live_session_teardown_on_lock(&self);
    fn clear_staged_descriptor(&self);
    /// `site` is the `&'static str` tracing tag the desktop free-fn expects.
    fn apply_screen_capture(&self, enabled: bool, site: &'static str);

    // ---- Group 4: note-CRUD index/sync side-effects -----------------------
    /// Replaces the old `search: State<'_, SearchIndexState>` command param.
    fn search_upsert(&self, id: &str, title: &str, body: &str);
    fn search_remove(&self, id: &str);
    /// Soft `SyncLocalChange.bump()` — no-op if the sync plugin is unmanaged.
    fn bump_local_change(&self);
    /// `app.emit(SNAPSHOT_WRITE_FAILED_EVENT, note_id)`.
    fn emit_snapshot_write_failed(&self, note_id: &str);
    /// Emit a global "this note was deleted" event (myne-md/myne#681).
    ///
    /// Called from `note_delete_from_host` after a successful delete. A detached
    /// (pop-out) note window holding this id shows the terminal "deleted
    /// elsewhere" state instead of autosaving its stale buffer back over nothing.
    /// Carries only the `note_id` (already an IPC value), never plaintext.
    /// Desktop emits it; mobile and web have no OS windows to notify and no-op.
    /// Deletes are one-shot, so unlike the change/rename reload (which reuses the
    /// existing `sync://changed`) this needs its own event and is not an autosave
    /// storm.
    fn emit_notes_deleted(&self, note_id: &str);

    // ---- Group 5: prefs-application side-effects (post-unlock) -------------
    /// Clamp a persisted `auto_lock_seconds` value into the effective range.
    ///
    /// **Defaulted, and the default is the security-relevant answer**
    /// (myne-md/myne#479). This used to be a required method whose docstring
    /// said "desktop applies the `MIN..=CEILING` clamp; mobile has no auto-lock
    /// so it returns the value or the shared default", and by then mobile did
    /// have an auto-lock, so what it actually had was an unclamped one. Both
    /// unclamped bodies (mobile's hook and `NoopHooks` below) were a plausible
    /// `unwrap_or`, which is why nothing reported them.
    ///
    /// `vault.prefs` is a replayable on-disk blob, so the clamp is what keeps a
    /// tampered `auto_lock_seconds` able only to SHORTEN the timeout, never
    /// lengthen it past [`crate::AUTO_LOCK_CEILING_SECS`]
    /// (`threat-model.md` §7). A defaulted method makes a client that says
    /// nothing land on that guarantee rather than off it; a client with a
    /// genuinely different policy overrides it and argues for the difference.
    fn effective_auto_lock_secs(&self, prefs_value: Option<u32>) -> u32 {
        crate::effective_auto_lock_secs(prefs_value)
    }
    /// Hydrate the browser-clipper pairing-token registry from the just-read
    /// `vault.prefs` `paired_extensions` array (desktop-only; mobile no-op).
    fn hydrate_clipper_pairing(&self, paired: &[protocol::PairedExtension]);

    // ---- Group 6: auth-flow side-effects (change-password / delete) --------
    /// Pre-empt any in-flight automatic backup before a user-auth rewrite
    /// (change-password / delete) mutates `vault.meta` underneath it.
    fn preempt_inflight_backup<'a>(&'a self, state: &'a VaultRuntimeState) -> BoxFuture<'a>;
    /// Invalidate the device-local quick-unlock credential for a vault dir.
    ///
    /// Called on EVERY master-password commit — both the `change_password`
    /// rotation and the completion of a phrase recovery, which is the same
    /// commit reached from the other direction (`protocol.md` §9.14.4, §7.3).
    /// It used to say "a master-password change", and recovery was left out on
    /// the strength of that wording for as long as the rule existed.
    fn invalidate_quick_unlock(&self, vault_dir: &std::path::Path);

    // ---- Group 7: note snapshot capture (note_update) ---------------------
    /// Best-effort pre-overwrite snapshot of a note's OLD `.myn` blob, gated by
    /// the coalescing window. Returns `true` if the snapshot could not be
    /// written (a non-blocking warning the caller surfaces). Desktop delegates
    /// to the snapshot store; mobile returns `false` (no snapshot subsystem).
    fn capture_snapshot(
        &self,
        vault_root: &std::path::Path,
        note_uuid: &str,
        old_blob: &[u8],
        now_ms: u64,
        force: bool,
    ) -> bool;

    /// [`Self::capture_snapshot`], reporting WHICH snapshot was written.
    ///
    /// Exists because one caller needs the id and the rest only need "did it
    /// fail": a view's bulk field write groups several notes into one undo, so it
    /// has to know which notes it can restore and which it cannot. Reporting the
    /// id through this seam rather than calling
    /// `snapshot_store::capture_snapshot_reporting_uuid` directly is what keeps a
    /// client that has NO snapshot subsystem (web) from reaching into a
    /// filesystem store it does not have.
    ///
    /// The default body delegates to [`Self::capture_snapshot`] and reports no
    /// id, which is right for any client that captures nothing: web inherits it
    /// and reports `Coalesced` without touching a store. Desktop and mobile
    /// override it, both delegating to the same uuid-reporting function so the
    /// capture rule cannot drift between the id-less and id-bearing callers.
    fn capture_snapshot_reporting(
        &self,
        vault_root: &std::path::Path,
        note_uuid: &str,
        old_blob: &[u8],
        now_ms: u64,
        force: bool,
    ) -> crate::snapshot_store::CaptureOutcome {
        if self.capture_snapshot(vault_root, note_uuid, old_blob, now_ms, force) {
            crate::snapshot_store::CaptureOutcome::Failed
        } else {
            crate::snapshot_store::CaptureOutcome::Coalesced
        }
    }

    /// Purge ALL snapshots of a note (note_delete, SYNC-1) — the cryptographic
    /// erase of the note's history. `vault_root` is the parent of `notes/`; the
    /// desktop impl derives the sibling `snapshots/` dir. Returns the number of
    /// snapshot files removed. Mobile (no snapshot subsystem) returns `Ok(0)`.
    fn purge_note_snapshots(
        &self,
        vault_root: &std::path::Path,
        note_uuid: &str,
    ) -> std::io::Result<usize>;
}

/// Mobile / headless implementation: every hook is a no-op. Async hooks
/// resolve immediately; `index_note_attachments` indexes nothing.
#[derive(Default)]
pub struct NoopHooks;

impl VaultLifecycleHooks for NoopHooks {
    fn hydrate_attachment_refs<'a>(&'a self, _: &'a VaultRuntimeState) -> BoxFuture<'a> {
        Box::pin(std::future::ready(()))
    }
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
    fn agent_teardown_on_lock(&self) {}
    fn detached_windows_teardown_on_lock(&self) {}
    fn live_session_teardown_on_lock(&self) {}
    fn clear_staged_descriptor(&self) {}
    fn apply_screen_capture(&self, _: bool, _: &'static str) {}

    fn search_upsert(&self, _: &str, _: &str, _: &str) {}
    fn search_remove(&self, _: &str) {}
    fn bump_local_change(&self) {}
    fn emit_snapshot_write_failed(&self, _: &str) {}
    fn emit_notes_deleted(&self, _: &str) {}

    // `effective_auto_lock_secs` is deliberately NOT overridden here: the
    // trait's default clamps, and a no-op host wanting the unclamped value is
    // exactly the shape myne-md/myne#479 removed.
    fn hydrate_clipper_pairing(&self, _: &[protocol::PairedExtension]) {}

    fn preempt_inflight_backup<'a>(&'a self, _: &'a VaultRuntimeState) -> BoxFuture<'a> {
        Box::pin(std::future::ready(()))
    }
    fn invalidate_quick_unlock(&self, _: &std::path::Path) {}

    fn capture_snapshot(
        &self,
        _vault_root: &std::path::Path,
        _note_uuid: &str,
        _old_blob: &[u8],
        _now_ms: u64,
        _force: bool,
    ) -> bool {
        // Mobile: no snapshot subsystem; nothing captured, no warning.
        false
    }

    fn purge_note_snapshots(
        &self,
        vault_root: &std::path::Path,
        note_uuid: &str,
    ) -> std::io::Result<usize> {
        // Mobile: no snapshot subsystem; nothing to purge.
        let _ = (vault_root, note_uuid);
        Ok(0)
    }
}

/// Test doubles for this seam, behind the same gate as `crate::test_support`.
#[cfg(any(test, feature = "test-support"))]
pub mod test_hooks {
    use crate::plugins::vault_unlock::state::VaultRuntimeState;
    use std::path::Path;

    /// A `Hooks` that counts `bump_local_change` calls and no-ops everything
    /// else (the snapshots test-mock pattern) — asserts the MYND-517 wiring:
    /// a shared-pref edit opens the coalesced sync push window, a device-local
    /// or no-op edit never does.
    ///
    /// Construct with [`CountingHooks::new`] rather than the tuple literal.
    pub struct CountingHooks(
        pub std::sync::Arc<std::sync::atomic::AtomicU64>,
        /// Vault dirs passed to `invalidate_quick_unlock`, in call order.
        ///
        /// Here rather than in a second mock because the alternative is a
        /// third hand-written 27-method impl of this trait, and because the
        /// property it exists for is one nothing asserted before: `protocol.md`
        /// §9.14.4's deletion is mandatory on EVERY credential rotation, and
        /// both rotation paths could have their wiring removed with the suite
        /// still green.
        pub std::sync::Arc<std::sync::Mutex<Vec<std::path::PathBuf>>>,
    );

    impl CountingHooks {
        /// The counter is the caller's (it usually asserts on it); the
        /// invalidation log is the mock's own.
        pub fn new(counter: std::sync::Arc<std::sync::atomic::AtomicU64>) -> Self {
            Self(
                counter,
                std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
            )
        }

        /// Vault dirs handed to `invalidate_quick_unlock`, oldest first.
        pub fn quick_unlock_invalidations(&self) -> Vec<std::path::PathBuf> {
            self.1.lock().expect("counting hooks mutex").clone()
        }
    }

    impl super::VaultLifecycleHooks for CountingHooks {
        fn hydrate_attachment_refs<'a>(&'a self, _: &'a VaultRuntimeState) -> super::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn hydrate_search_index<'a>(&'a self, _: &'a VaultRuntimeState) -> super::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn hydrate_spell<'a>(&'a self, _: &'a VaultRuntimeState) -> super::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn reclaim_stray_attachment_blobs<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
        ) -> super::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn persist_search_index<'a>(&'a self, _: &'a VaultRuntimeState) -> super::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn index_note_attachments<'a>(
            &'a self,
            _: &'a VaultRuntimeState,
            _: &'a str,
            _: &'a str,
            _: &'a str,
        ) -> super::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn zeroize_search_index(&self) {}
        fn zeroize_spell(&self) {}
        fn zeroize_vault_indices(&self) {}
        fn zeroize_attachment_refs(&self) {}
        fn abort_active_recording(&self) {}
        fn pdf_export_teardown_on_lock(&self) {}
        fn agent_teardown_on_lock(&self) {}
        fn detached_windows_teardown_on_lock(&self) {}
        fn live_session_teardown_on_lock(&self) {}
        fn clear_staged_descriptor(&self) {}
        fn apply_screen_capture(&self, _: bool, _: &'static str) {}
        fn search_upsert(&self, _: &str, _: &str, _: &str) {}
        fn search_remove(&self, _: &str) {}
        fn bump_local_change(&self) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        fn emit_snapshot_write_failed(&self, _: &str) {}
        fn emit_notes_deleted(&self, _: &str) {}
        // `effective_auto_lock_secs` deliberately not overridden: the trait's
        // default clamps (myne-md/myne#479). This body used to be the unclamped
        // `unwrap_or`, which is the exact shape that change removed from two
        // production clients, so a fixture carrying it handed the next author
        // the defect as the copyable example.
        fn hydrate_clipper_pairing(&self, _: &[protocol::PairedExtension]) {}
        fn preempt_inflight_backup<'a>(&'a self, _: &'a VaultRuntimeState) -> super::BoxFuture<'a> {
            Box::pin(std::future::ready(()))
        }
        fn invalidate_quick_unlock(&self, vault_dir: &Path) {
            self.1
                .lock()
                .expect("counting hooks mutex")
                .push(vault_dir.to_path_buf());
        }
        fn capture_snapshot(&self, _: &Path, _: &str, _: &[u8], _: u64, _: bool) -> bool {
            false
        }
        fn purge_note_snapshots(&self, _: &Path, _: &str) -> std::io::Result<usize> {
            Ok(0)
        }
    }
}
