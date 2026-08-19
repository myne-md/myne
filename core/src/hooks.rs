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
//! WITHOUT pulling in the `async-trait` dependency (repo-root CLAUDE.md:
//! "Adding a dependency is a security decision"). Sync methods stay plain.
//!
//! Scope note: this is the note-CRUD + unlock/lock hook surface (the six
//! plugin cores that live in `myne-core`). Hooks that fire only inside the
//! desktop-only `backup` / `quick_unlock` / `workspace` plugin commands are
//! intentionally NOT here — the trait grows a method (plus a one-line
//! `NoopHooks` no-op) if a shared core ever needs one.
//!
//! Secret-handling: `note_body` passed to [`VaultLifecycleHooks::index_note_attachments`]
//! is plaintext — never log it (see `src-tauri/CLAUDE.md` "Secret-handling
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

    /// Embed-on-unlock trigger for the local-AI semantic index (semantic-search-
    /// qa task 3). Desktop, when the `local-inference` feature is on AND the
    /// vault opted in (`ai_enabled`), walks the resident notes and populates the
    /// RAM vector store off the unlock hot path; the default build and mobile
    /// install a no-op. Best-effort — never blocks or fails unlock.
    fn hydrate_ai_vectors<'a>(&'a self, state: &'a VaultRuntimeState) -> BoxFuture<'a>;

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
    fn clear_staged_descriptor(&self);
    /// `site` is the `&'static str` tracing tag the desktop free-fn expects.
    fn apply_screen_capture(&self, enabled: bool, site: &'static str);

    // ---- Group 4: note-CRUD index/sync side-effects -----------------------
    /// Replaces the old `search: State<'_, SearchIndexState>` command param.
    fn search_upsert(&self, id: &str, title: &str, body: &str);
    fn search_remove(&self, id: &str);
    /// Eager per-note AI re-embed on save (MYND-453): (re-)embed this note's
    /// chunks into the RAM vector store so a this-session create/edit is
    /// searchable without a re-unlock. Detached + best-effort in the desktop
    /// impl; the save critical path NEVER blocks on the model-bound embed. A
    /// no-op unless the `local-inference` feature is built and `ai_enabled` is
    /// on. The durable `vault.embeddings` blob is refreshed by the next unlock's
    /// reconcile (§9.17.4), so this hook only touches RAM.
    ///
    /// **`body` is the RAW note body — frontmatter included, and for a drawing
    /// the `kind: drawing` scene JSON, not its projected text** (myne#304).
    /// Unlike `search_upsert`, whose caller projects, the projection belongs to
    /// the implementation here for two reasons:
    ///
    ///   - it needs the frontmatter. The desktop arm resolves the note's folder
    ///     from it to apply the SYNC-14 AI exclusion set, and a projected body
    ///     has no frontmatter — so a drawing inside an excluded folder read as
    ///     root and was embedded anyway;
    ///   - the unlock-time rebuild reads raw bodies off disk and has to project
    ///     for itself regardless. Projecting at the call sites left the two
    ///     paths disagreeing: the eager one embedded scene text, the durable
    ///     one embedded JSON, and every unlock replaced the first with the
    ///     second.
    ///
    /// Three of the five call sites already passed the raw body; the contract
    /// is now that all of them do.
    fn ai_note_changed(&self, id: &str, body: &str);
    /// Drop a deleted note's vectors from the RAM vector store (MYND-453).
    /// Cheap + synchronous — no model call.
    fn ai_note_deleted(&self, id: &str);
    /// Reflect an `ai_enabled` / `ai_excluded_folders` change into the live AI
    /// runtime (SYNC-14): refresh the query-time policy and immediately purge any
    /// resident vector for a now-excluded note, and zeroize the whole store when
    /// AI is turned off — so a control the user just changed takes effect against
    /// ALREADY-embedded notes, not only future embeds. Desktop-only; mobile
    /// no-op. Called AFTER the `vault.prefs` write succeeds.
    fn ai_policy_changed(&self, enabled: bool, excluded: &[String]);
    /// Soft `SyncLocalChange.bump()` — no-op if the sync plugin is unmanaged.
    fn bump_local_change(&self);
    /// `app.emit(SNAPSHOT_WRITE_FAILED_EVENT, note_id)`.
    fn emit_snapshot_write_failed(&self, note_id: &str);

    // ---- Group 5: prefs-application side-effects (post-unlock) -------------
    /// Clamp a persisted `auto_lock_seconds` value into the effective range
    /// (desktop applies the `MIN..=CEILING` clamp; mobile has no auto-lock so
    /// it returns the value or the shared `DEFAULT_AUTO_LOCK_SECS` default).
    fn effective_auto_lock_secs(&self, prefs_value: Option<u32>) -> u32;
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
    fn agent_teardown_on_lock(&self) {}
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
        // Mobile has no auto-lock policy; fall back to the shared default the
        // runtime state seeds itself with (no desktop clamp range available).
        prefs_value.unwrap_or(crate::DEFAULT_AUTO_LOCK_SECS)
    }
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
        fn hydrate_ai_vectors<'a>(&'a self, _: &'a VaultRuntimeState) -> super::BoxFuture<'a> {
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
        fn clear_staged_descriptor(&self) {}
        fn apply_screen_capture(&self, _: bool, _: &'static str) {}
        fn search_upsert(&self, _: &str, _: &str, _: &str) {}
        fn search_remove(&self, _: &str) {}
        fn ai_note_changed(&self, _: &str, _: &str) {}
        fn ai_note_deleted(&self, _: &str) {}
        fn ai_policy_changed(&self, _: bool, _: &[String]) {}
        fn bump_local_change(&self) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        }
        fn emit_snapshot_write_failed(&self, _: &str) {}
        fn effective_auto_lock_secs(&self, prefs_value: Option<u32>) -> u32 {
            prefs_value.unwrap_or(crate::DEFAULT_AUTO_LOCK_SECS)
        }
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
