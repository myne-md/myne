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
//! Secret-handling: `note_body` passed to [`VaultLifecycleHooks::fold_attachment_text_for_index`]
//! is plaintext — never log it (see `src-tauri/CLAUDE.md` "Secret-handling
//! logging discipline").

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::plugins::vault_unlock::state::VaultRuntimeState;

/// Boxed-future alias for the hand-rolled async-in-`dyn`-trait methods.
pub type BoxFuture<'a, T = ()> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

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
    fn persist_search_index<'a>(&'a self, state: &'a VaultRuntimeState) -> BoxFuture<'a>;

    /// Embed-on-unlock trigger for the local-AI semantic index (semantic-search-
    /// qa task 3). Desktop, when the `local-inference` feature is on AND the
    /// vault opted in (`ai_enabled`), walks the resident notes and populates the
    /// RAM vector store off the unlock hot path; the default build and mobile
    /// install a no-op. Best-effort — never blocks or fails unlock.
    fn hydrate_ai_vectors<'a>(&'a self, state: &'a VaultRuntimeState) -> BoxFuture<'a>;

    /// Folds cached attachment text into a note body for indexing and RETURNS
    /// the (possibly unchanged) body. `note_body` is plaintext — never log it.
    /// Mobile returns the body verbatim (the note is still saved; only the
    /// search-index feed is skipped).
    fn fold_attachment_text_for_index<'a>(
        &'a self,
        state: &'a VaultRuntimeState,
        note_body: &'a str,
    ) -> BoxFuture<'a, String>;

    // ---- Group 2: sync, app-derived ---------------------------------------
    fn zeroize_search_index(&self);
    fn zeroize_spell(&self);
    fn zeroize_vault_indices(&self);
    fn zeroize_attachment_refs(&self);
    fn abort_active_recording(&self);
    fn pdf_export_teardown_on_lock(&self);
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
    /// Invalidate the device-local quick-unlock credential for a vault dir
    /// (a master-password change must force one full-password unlock).
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
/// resolve immediately; `fold_attachment_text_for_index` returns the body
/// unchanged.
#[derive(Default)]
pub struct NoopHooks;

impl VaultLifecycleHooks for NoopHooks {
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
