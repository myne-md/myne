//! Search-index IO lifecycle: the impure shell that drives the pure
//! persistence core (`crate::search::persist`) on the unlock / lock / quit
//! paths (`search-index` feature, MYND-29 Task 7).
//!
//! - [`hydrate_search_index`] (unlock + post-recovery): load the encrypted
//!   `vault.search` blob (fast path) and incrementally reconcile it against
//!   the notes dir's current `.myn` header nonces — re-indexing only the
//!   notes whose `content_nonce` changed, decrypting NOTHING for unchanged
//!   notes. Absent / AEAD-fail / unreadable blob → full rebuild (reconcile
//!   from an empty index).
//! - [`persist_search_index`] (graceful lock + periodic flush + quit):
//!   snapshot the live index, pair it with a freshly-scanned nonce manifest,
//!   encrypt to the `vault.search` blob, and `atomic_write` it.
//!
//! Both are BEST-EFFORT at every call site: a search-persistence failure
//! must never block unlock, lock, or quit, and never surfaces a user-facing
//! error — a stale / empty index only degrades search until the next
//! reconcile, never findability or note data. The manifest is re-derived
//! from the `.myn` headers at BOTH ends rather than held in state, so the
//! persisted snapshot always matches disk and the next unlock takes the
//! skip-everything fast path; the headers are the single source of truth for
//! staleness (the grill decision — `content_nonce` changes on every save).
//!
//! Lives in the `notes` plugin (not `search`) because it bridges the two:
//! it owns the impure glue (decrypt-via-`note_read`, scan the notes dir,
//! touch `SearchIndexState` + `VaultRuntimeState`), while the pure codec +
//! reconcile core stays in `crate::search::persist`. The notes plugin
//! already owns the live incremental updates (Task 4 `upsert`/`remove`), so
//! the whole notes↔search bridge sits here.
//!
//! DENY-list discipline (see ../../CLAUDE.md "Secret-handling logging
//! discipline"): note_ids, nonces, account_number_hash, plaintext, and path
//! strings never reach a `tracing` argument — only stage tags + bounded
//! counts.

use crate::paths;
use crate::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};
use crate::search::SearchIndexState;
use protocol::{derive_subkey, SubkeyRole, VAULT_META_ACCOUNT_HASH_LEN};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};

// The blocking manifest twin that used to live here is GONE. It existed because
// the desktop path walked the notes directory synchronously while the seam's
// version was async; now both clients call the same
// `search_sync_core::hydrate_search_index_core`, which walks through the seam,
// so a second implementation would only be a way for the two to disagree about
// what a `.myn` header means.

use super::commands::note_read_with_dir;
use super::title_extract::resolve_note_title;

// The account-hash we read from `vault.meta` (`VAULT_META_ACCOUNT_HASH_LEN`)
// is fed straight into the snapshot codec, which binds it as
// `SEARCH_BLOB_ACCOUNT_HASH_LEN`. They are the same 16-byte field today; this
// build-time assert fails the compile if either ever diverges, catching the
// otherwise-silent cross-module length coupling.
const _: () = assert!(VAULT_META_ACCOUNT_HASH_LEN == protocol::SEARCH_BLOB_ACCOUNT_HASH_LEN);

/// Periodic flush cadence while a vault is Unlocked. The idle auto-lock
/// (Task 8) SKIPS persist, so the blob is routinely a few minutes stale;
/// this bounds how much the next unlock must reconcile (a hard quit / crash
/// loses at most this much incremental indexing — the next unlock
/// reconciles the delta regardless, so it is never data loss).
///
/// **PLACEHOLDER — 2 minutes.** Final cadence is a perf tuning owned by the
/// Task 9 benchmark (blob-write cost at 10k notes); the constant lives in
/// code, mirroring the `auto_lock` placeholder-constant discipline.
const FLUSH_INTERVAL: Duration = Duration::from_secs(120);

/// Re-exported from `myne-core`: the two `_with_dir` cores moved there
/// (phase3-web-client tasks 14 + 83) and their error type moved with them, so
/// there is one definition rather than a desktop copy that can drift.
pub use myne_core::plugins::notes::search_sync_core::SearchSyncError;

/// Static-string label for [`SearchSyncError`] — delegates to the shared one so
/// a new variant is labelled in exactly one place.
fn sync_error_kind(e: &SearchSyncError) -> &'static str {
    myne_core::plugins::notes::search_sync_core::search_sync_error_kind(e)
}

/// Resolve the ACTIVE vault root for the running app. Local mirror of the
/// prefs / vault_unlock helpers — kept private to avoid a cross-plugin pub
/// re-export of a 5-line wrapper. `active_id` is read from the runtime state
/// by the caller (`state.active_vault_id().await`) — the only place with
/// `.await` access to the slot map. SYNC-6: hydrate/persist always operate on
/// the unlocked vault, so resolving via the active id (not the transitional
/// sole-vault disk heuristic) keeps the search blob targeting the correct
/// vault once two or more exist.
fn resolve_vault_dir<R: Runtime>(
    app: &AppHandle<R>,
    active_id: Option<crate::vault_id::VaultId>,
) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|base| crate::paths::active_vault_root_from_base(&base, active_id))
}

/// Resolve the `(vault_dir, app-managed SearchIndexState)` pair the best-effort
/// hydrate/persist wrappers both need, emitting the shared skip-warn under
/// `skipped_event` on either resolution miss. `None` → the caller returns
/// (best-effort: a search-IO miss never blocks unlock / lock / quit).
fn resolve_search_io<'a, R: Runtime>(
    app: &'a AppHandle<R>,
    active_id: Option<crate::vault_id::VaultId>,
    skipped_event: &'static str,
) -> Option<(PathBuf, tauri::State<'a, SearchIndexState>)> {
    let Some(vault_dir) = resolve_vault_dir(app, active_id) else {
        tracing::warn!(
            event = skipped_event,
            reason = "vault_dir_resolution_failed"
        );
        return None;
    };
    let Some(search) = app.try_state::<SearchIndexState>() else {
        tracing::warn!(event = skipped_event, reason = "state_unavailable");
        return None;
    };
    Some((vault_dir, search))
}

/// Read `vault.meta`'s `account_number_hash` (the AAD binding for the
/// search blob; spec §9.3 offset 6). Not cached in `Slot::Unlocked` — a
/// single ~345-byte read + parse, same lazy cadence rationale as prefs.
fn read_account_number_hash(
    vault_meta_path: &Path,
) -> Result<[u8; VAULT_META_ACCOUNT_HASH_LEN], SearchSyncError> {
    let bytes = std::fs::read(vault_meta_path).map_err(|_| SearchSyncError::Io)?;
    // Either generation (myne-md/myne#433). This failure is swallowed as ONE
    // `warn` upstream, so an `NTV5` rejection here meant search returned zero
    // results forever with nothing user-visible saying why. The core twin
    // (`search_sync_core.rs`) was already version-aware.
    let meta =
        protocol::parse_vault_meta_any(&bytes).map_err(|_| SearchSyncError::InvalidVaultMeta)?;
    Ok(meta.account_number_hash)
}

/// MYND-448a: the per-attachment search docs for a note — `(attachment_id_hex,
/// title, extracted_text)` for every embedded form-C attachment whose extracted
/// text is cached. Replaces the old `fold_note_body_for_index`: instead of
/// folding attachment text INTO the note body, each attachment becomes its OWN
/// search doc (`att:<id>:<note_id>`, built by the caller from these), so an
/// attachment-content hit surfaces as a distinct result. `title` is the
/// embedding note's title — the result row reads as the note, badged as an
/// attachment match via the doc-id's `att:` provenance. The single canonical
/// home for the note→attachment-doc derivation; every live re-index call site
/// (`note_create` / `note_update` / `note_write_batch_transactional` /
/// `snapshot_restore`) routes through the `index_note_attachments` hook to here.
///
/// Fast path — a note with no `![[att:…]]` embeds returns empty without the
/// `vault.meta` read or KEK derive. Best-effort: any failure (locked slot,
/// missing/invalid meta) returns empty and can never break a save.
pub(crate) async fn note_attachment_docs(
    state: &VaultRuntimeState,
    vault_dir: &Path,
    note_title: &str,
    note_body: &str,
) -> Vec<(String, String, String)> {
    if crate::plugins::attachments::reconcile::extract_att_ids(note_body).is_empty() {
        return Vec::new();
    }
    let Some(root_key) = state.peek_unlocked_root_key_clone().await else {
        return Vec::new();
    };
    let Ok(account_number_hash) = read_account_number_hash(&vault_dir.join("vault.meta")) else {
        return Vec::new();
    };
    let key = derive_subkey(&root_key, SubkeyRole::AttachmentTextKey);
    let mut memo = std::collections::HashMap::new();
    crate::plugins::attachments::text_cache::collect_attachment_texts(
        note_body,
        vault_dir,
        &key,
        &account_number_hash,
        &mut memo,
    )
    .into_iter()
    .map(|(att_id_hex, text)| (att_id_hex, note_title.to_string(), text))
    .collect()
}

/// Live-refresh the `att:` search docs of every note embedding
/// `attachment_id_hex`, after its transcript `MYE1` cache was written
/// out-of-band (voice-to-text, MYND-551, Task 4). The transcribe command writes
/// the transcript cache WITHOUT re-saving the note, so its `content_nonce` is
/// unchanged and the incremental reconcile skips it — the transcript would not
/// be findable until a lock→unlock cycle re-hydrated it. This resolves the
/// embedding notes via the attachment reference graph
/// ([`crate::plugins::attachments::AttachmentRefsState`]) and re-derives each
/// note's attachment docs through the SAME [`note_attachment_docs`] →
/// [`crate::search::SearchIndexState::set_note_attachments`] path a live save
/// uses (so the just-written transcript is picked up), making it findable
/// IN-SESSION and part of the next persisted snapshot.
///
/// Best-effort: a locked slot, missing graph/index state, or an unreadable note
/// is skipped — a search-doc refresh must never fail a transcription the user
/// already has. DENY-list: no note_id / title / body / transcript is logged.
pub async fn refresh_attachment_docs_for<R: Runtime>(
    app: &AppHandle<R>,
    state: &VaultRuntimeState,
    attachment_id_hex: &str,
) {
    let Some(refs) = app.try_state::<crate::plugins::attachments::AttachmentRefsState>() else {
        return;
    };
    let note_ids = refs.referencing_notes(attachment_id_hex);
    if note_ids.is_empty() {
        return; // not embedded in any note → nothing to surface
    }
    let Some(search) = app.try_state::<SearchIndexState>() else {
        return;
    };
    let active_id = state.active_vault_id().await;
    let Some(vault_dir) = resolve_vault_dir(app, active_id) else {
        return;
    };
    let Ok(notes_dir) = paths::notes_dir_under(&vault_dir) else {
        return;
    };
    for note_id in note_ids {
        // Read the embedding note to recover its title + body (the body names the
        // embeds `note_attachment_docs` re-reads from the MYE1 caches).
        let Ok(plaintext) = note_read_with_dir(
            notes_dir.clone(),
            state,
            note_id.clone(),
            &myne_core::vault_io::StdVaultIo,
            &myne_core::host::tauri_host::TauriHost::new(app.clone()),
        )
        .await
        else {
            continue;
        };
        let title = resolve_note_title(plaintext.as_bytes()).unwrap_or_default();
        let atts = note_attachment_docs(state, &vault_dir, &title, &plaintext).await;
        search.set_note_attachments(&note_id, &atts);
    }
    tracing::info!(event = "transcript_search_docs_refreshed");
}

/// Desktop's `hydrate_search_index_with_dir`: the shared core plus THIS
/// platform's attachment-document layer.
///
/// The whole body moved to `myne_core::plugins::notes::search_sync_core`
/// (phase3-web-client tasks 14 + 83) — loading `vault.search`, the
/// decryption-free staleness scan, the reconcile and the swap are the same
/// operations on every client. What stayed here is [`DesktopAttachmentDocs`],
/// because the `MYE1` extracted-text cache it reads has no `wasm32` producers by
/// construction and the extractors behind it are bound to desktop-only crates.
pub(crate) async fn hydrate_search_index_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    search: &SearchIndexState,
    // `note_read_with_dir` takes the host for its duration metric; a `NoopHost`
    // here would compile and silently log every desktop note-read as 0 ms.
    host: &dyn myne_core::host::HostCtx,
) -> Result<(), SearchSyncError> {
    let mut attachments = DesktopAttachmentDocs::new(vault_dir, state).await?;
    myne_core::plugins::notes::search_sync_core::hydrate_search_index_core(
        &myne_core::vault_io::StdVaultIo,
        host,
        vault_dir,
        state,
        search,
        &mut attachments,
    )
    .await
}

/// The attachment-document layer for a client that can extract attachment text.
///
/// Holds the two KEKs, the catalog and the cross-note memo for one rebuild pass.
/// The memo is what keeps §9.6.4's promise that an attachment embedded in N
/// notes is decoded once, and it is per-pass rather than global on purpose: a
/// cache entry rewritten between rebuilds must be re-read.
struct DesktopAttachmentDocs {
    vault_dir: PathBuf,
    account_number_hash: [u8; VAULT_META_ACCOUNT_HASH_LEN],
    attachment_text_key: zeroize::Zeroizing<[u8; 32]>,
    items_key: zeroize::Zeroizing<[u8; 32]>,
    items_key_id: [u8; 16],
    catalog: protocol::AttachmentsCatalog,
    memo: HashMap<[u8; 32], Option<String>>,
}

impl DesktopAttachmentDocs {
    async fn new(vault_dir: &Path, state: &VaultRuntimeState) -> Result<Self, SearchSyncError> {
        // items_key + items_key_id decrypt MYA1 sources for the lazy backfill of
        // attachments imported before the eager cache existed (MYND-328).
        let (items_key, items_key_id, root_key) = state
            .peek_unlocked_attachment_material()
            .await
            .ok_or(SearchSyncError::SlotNotUnlocked)?;
        let account_number_hash = read_account_number_hash(&vault_dir.join("vault.meta"))?;
        let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
        // Best-effort: an unreadable catalog yields an empty one, which makes the
        // backfill a no-op rather than failing the whole rebuild.
        let catalog = crate::plugins::attachments::blocking_reads::read_catalog(
            &vault_dir.join("vault.attachments"),
            &catalog_key,
            &account_number_hash,
        )
        .unwrap_or_else(|_| protocol::AttachmentsCatalog::empty());
        Ok(Self {
            vault_dir: vault_dir.to_path_buf(),
            account_number_hash,
            attachment_text_key: derive_subkey(&root_key, SubkeyRole::AttachmentTextKey),
            items_key,
            items_key_id,
            catalog,
            memo: HashMap::new(),
        })
    }
}

impl myne_core::plugins::notes::search_sync_core::AttachmentDocs for DesktopAttachmentDocs {
    fn for_note(
        &mut self,
        _note_id: &str,
        title: &str,
        plaintext: &str,
    ) -> Vec<(String, String, String)> {
        // Backfill any uncached embedded attachment from its MYA1 source, so the
        // collect below sees its extracted text. OCR is DEFERRED here — this
        // extractor reports image / scanned-PDF candidates as `Unsupported`,
        // which the backfill does not cache, leaving them for the background
        // worker. Seconds-per-page work inside the rebuild would stall the first
        // search after unlock.
        crate::plugins::attachments::text_cache::backfill_note_attachment_text(
            plaintext,
            &self.vault_dir,
            &self.attachment_text_key,
            &self.account_number_hash,
            &self.items_key,
            &self.items_key_id,
            &self.catalog,
            &mut self.memo,
            crate::plugins::attachments::extract::extract_deferring_ocr,
        );
        crate::plugins::attachments::text_cache::collect_attachment_texts(
            plaintext,
            &self.vault_dir,
            &self.attachment_text_key,
            &self.account_number_hash,
            &mut self.memo,
        )
        .into_iter()
        .map(|(att_id_hex, text)| (att_id_hex, title.to_string(), text))
        .collect()
    }
}

/// Desktop's `persist_search_index_with_dir` — a straight delegate.
///
/// Nothing about snapshotting the index, re-deriving the manifest, encrypting
/// and writing is platform-specific, so unlike hydrate this one has no layer to
/// inject: the whole body is `search_sync_core::persist_search_index_core`.
pub(crate) async fn persist_search_index_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    search: &SearchIndexState,
) -> Result<(), SearchSyncError> {
    myne_core::plugins::notes::search_sync_core::persist_search_index_core(
        &myne_core::vault_io::StdVaultIo,
        vault_dir,
        state,
        search,
    )
    .await
}

/// Best-effort hydrate on unlock / post-recovery. Resolves the vault dir +
/// app-managed [`SearchIndexState`], then runs the core; any failure is
/// logged and swallowed (search must never block unlock). Wired into
/// `vault_unlock::commands::unlock` and
/// `vault_recover::commands::complete_recovery` after the slot transitions
/// to `Unlocked`.
///
/// Runs INLINE (the caller awaits it before returning to the WebView) so it
/// cannot race a concurrent `vault_lock` into repopulating a just-cleared
/// index. On a cold first unlock (no blob yet) this is a full rebuild that
/// decrypts every note — a known latency cost the Task 9 benchmark will
/// measure (a background-hydrate refinement is a candidate then; the warm
/// path is a header scan + decode + skip-all reconcile).
pub async fn hydrate_search_index<R: Runtime>(app: &AppHandle<R>, state: &VaultRuntimeState) {
    let active_id = state.active_vault_id().await;
    let Some((vault_dir, search)) =
        resolve_search_io(app, active_id, "search_index_hydrate_skipped")
    else {
        return;
    };
    if let Err(e) = hydrate_search_index_with_dir(
        &vault_dir,
        state,
        search.inner(),
        &myne_core::host::tauri_host::TauriHost::new(app.clone()),
    )
    .await
    {
        tracing::warn!(
            event = "search_index_hydrate_skipped",
            reason = sync_error_kind(&e),
        );
    }
}

/// Best-effort persist on graceful lock / periodic flush / quit. Resolves
/// the vault dir + app-managed [`SearchIndexState`], then runs the core; any
/// failure is logged and swallowed. MUST be called while the slot is still
/// `Unlocked` (the core peeks `root_key`).
pub async fn persist_search_index<R: Runtime>(app: &AppHandle<R>, state: &VaultRuntimeState) {
    let active_id = state.active_vault_id().await;
    let Some((vault_dir, search)) =
        resolve_search_io(app, active_id, "search_index_persist_skipped")
    else {
        return;
    };
    if let Err(e) = persist_search_index_with_dir(&vault_dir, state, search.inner()).await {
        tracing::warn!(
            event = "search_index_persist_skipped",
            reason = sync_error_kind(&e),
        );
    }
}

/// Best-effort zeroize + reset of the in-RAM search index on lock teardown
/// (MYND-29 Task 8). Resolves the app-managed [`SearchIndexState`] and wipes
/// its plaintext-derived contents (terms / titles / note ids overwritten
/// before free). Wired into EVERY slot-drop site so the index never outlives
/// the slot: manual `vault_lock` (after the keys zeroize), idle auto-lock
/// teardown (same leg as the key zeroize, WITHOUT a persist — fail-closed),
/// and `vault_delete`. Sync + infallible (no `.await`, no IO); a missing
/// managed state is a silent no-op.
pub fn zeroize_search_index<R: Runtime>(app: &AppHandle<R>) {
    if let Some(search) = app.try_state::<SearchIndexState>() {
        search.clear();
    }
}

/// Spawn the periodic search-index flush timer for the process lifetime.
/// Each tick, if a vault is `Unlocked`, best-effort persists the index so a
/// hard quit / crash loses at most [`FLUSH_INTERVAL`] of incremental
/// indexing. No-op while locked. Integration-level (the loop is exercised by
/// the running app, not unit tests — same posture as
/// `auto_lock::spawn_idle_lock_timer`; the persist core is unit-tested).
pub fn spawn_periodic_flush_timer<R: Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
        // `tokio::time::interval` fires its first tick immediately; skip it
        // so a just-booted (still-locked) app does not attempt a t=0 persist.
        ticker.tick().await;
        loop {
            ticker.tick().await;
            let Some(state) = app.try_state::<VaultRuntimeState>() else {
                continue;
            };
            if matches!(state.slot_kind_active().await, SlotKind::Unlocked) {
                persist_search_index(&app, state.inner()).await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::notes::commands::{note_create_with_dir, note_update_with_dir};
    use crate::plugins::vault_unlock::state::{
        fixture_unlocked_with_keys, test_vault_id, VaultRuntimeState,
    };
    use crate::test_support::ScopedTempDir;

    /// No-op `Hooks` for the `note_update_with_dir` index/snapshot side-effect:
    /// this test drives the hydrate/persist path directly, so the CRUD-side
    /// hooks are inert.
    fn noop_hooks() -> myne_core::hooks::Hooks {
        std::sync::Arc::new(myne_core::hooks::NoopHooks)
    }

    // Fixture key bytes — `note_create_with_dir` encrypts under these, and
    // the persist/hydrate path derives `search_index_key` from the same
    // `root_key` (so the second hydrate decrypts the blob it wrote).
    const ROOT: u8 = 0x07;
    const ITEMS: u8 = 0x09;
    const ITEMS_ID: u8 = 0x01;

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("multi-thread runtime")
    }

    /// Seed a parse-valid `vault.meta` whose `account_number_hash` is fixed.
    /// The search codec only consumes `account_number_hash`; the other
    /// fields just need to parse-pass. Mirrors the prefs-plugin test seeder.
    fn seed_vault_meta(vault_dir: &Path, account_byte: u8) {
        let meta = protocol::VaultMeta {
            account_number_hash: [account_byte; VAULT_META_ACCOUNT_HASH_LEN],
            kdf_params: protocol::DEFAULT_V0_1_KDF_PARAMS,
            random_salt_password: [1u8; 16],
            random_salt_recovery: [2u8; 16],
            nonce_password_wrap: [3u8; 24],
            enc_root_key_password: [4u8; 64],
            nonce_recovery_wrap: [5u8; 24],
            enc_root_key_recovery: [6u8; 64],
            items_key_id: [7u8; 16],
            items_key_nonce: [8u8; 24],
            enc_items_key: [9u8; 64],
        };
        std::fs::write(
            vault_dir.join("vault.meta"),
            protocol::serialize_vault_meta(&meta),
        )
        .expect("seed vault.meta");
    }

    async fn unlocked_state() -> VaultRuntimeState {
        let state = VaultRuntimeState::default();
        state
            .set_unlocked(
                test_vault_id(),
                fixture_unlocked_with_keys(ROOT, ITEMS, ITEMS_ID),
            )
            .await;
        state
    }

    fn query_ids(search: &SearchIndexState, q: &str) -> Vec<String> {
        search.query(q).into_iter().map(|h| h.id).collect()
    }

    #[test]
    fn persist_then_hydrate_round_trips_query_results() {
        rt().block_on(async {
            let vault = ScopedTempDir::new("search-sync-roundtrip").unwrap();
            seed_vault_meta(vault.path(), 0x33);
            let state = unlocked_state().await;
            let notes_dir = paths::notes_dir_under(vault.path()).unwrap();

            let id_a = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "# Alpha\nrust async runtime".into(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("create A");
            let id_b = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "# Beta\npython data science".into(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("create B");

            // First hydrate (no blob) → full rebuild → both searchable
            // (criterion 4: full rebuild on absent blob).
            let s1 = SearchIndexState::default();
            hydrate_search_index_with_dir(vault.path(), &state, &s1, &myne_core::host::NoopHost)
                .await
                .expect("hydrate full-rebuild");
            assert_eq!(query_ids(&s1, "rust"), vec![id_a.clone()]);
            assert_eq!(query_ids(&s1, "python"), vec![id_b.clone()]);

            // Persist → vault.search exists on disk.
            persist_search_index_with_dir(vault.path(), &state, &s1)
                .await
                .expect("persist");
            assert!(
                vault.path().join("vault.search").is_file(),
                "persist must write vault.search"
            );

            // Fresh state → warm hydrate from the blob → identical results
            // (criterion 2: warm unlock loads the blob).
            let s2 = SearchIndexState::default();
            hydrate_search_index_with_dir(vault.path(), &state, &s2, &myne_core::host::NoopHost)
                .await
                .expect("hydrate warm");
            assert_eq!(query_ids(&s2, "rust"), vec![id_a]);
            assert_eq!(query_ids(&s2, "python"), vec![id_b]);
        });
    }

    #[test]
    fn warm_hydrate_reconciles_edited_note_and_keeps_others() {
        rt().block_on(async {
            let vault = ScopedTempDir::new("search-sync-reconcile").unwrap();
            seed_vault_meta(vault.path(), 0x55);
            let state = unlocked_state().await;
            let notes_dir = paths::notes_dir_under(vault.path()).unwrap();

            let id_a = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "# Alpha\nrust async".into(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("create A");
            let id_b = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "# Beta\npython data".into(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("create B");

            // Build + persist the baseline.
            let s1 = SearchIndexState::default();
            hydrate_search_index_with_dir(vault.path(), &state, &s1, &myne_core::host::NoopHost)
                .await
                .expect("baseline hydrate");
            persist_search_index_with_dir(vault.path(), &state, &s1)
                .await
                .expect("baseline persist");

            // Edit note A on disk (new content → fresh content_nonce in the
            // header → the staleness signal flips for A only).
            note_update_with_dir(
                notes_dir.clone(),
                &state,
                &noop_hooks(),
                id_a.clone(),
                "# Alpha\nrust tokio reactor".into(),
                None,
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("edit A");

            // Warm hydrate: A re-indexed (new term present, stale term gone),
            // B untouched (kept from the blob — criterion 3).
            let s2 = SearchIndexState::default();
            hydrate_search_index_with_dir(vault.path(), &state, &s2, &myne_core::host::NoopHost)
                .await
                .expect("reconcile hydrate");
            assert_eq!(
                query_ids(&s2, "tokio"),
                vec![id_a.clone()],
                "edited note's new term is searchable"
            );
            assert!(
                query_ids(&s2, "async").is_empty(),
                "edited note's stale term is gone (replace semantics via reconcile)"
            );
            assert_eq!(
                query_ids(&s2, "python"),
                vec![id_b],
                "unchanged note is preserved from the blob without re-decrypt"
            );
        });
    }

    #[test]
    fn hydrate_drops_deleted_note_on_warm_load() {
        rt().block_on(async {
            let vault = ScopedTempDir::new("search-sync-delete").unwrap();
            seed_vault_meta(vault.path(), 0x66);
            let state = unlocked_state().await;
            let notes_dir = paths::notes_dir_under(vault.path()).unwrap();

            let id_a = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "# Alpha\nrust async".into(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("create A");
            let id_b = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "# Beta\npython data".into(),
                &myne_core::vault_io::StdVaultIo,
                &myne_core::host::NoopHost,
            )
            .await
            .expect("create B");

            let s1 = SearchIndexState::default();
            hydrate_search_index_with_dir(vault.path(), &state, &s1, &myne_core::host::NoopHost)
                .await
                .expect("baseline hydrate");
            persist_search_index_with_dir(vault.path(), &state, &s1)
                .await
                .expect("baseline persist");

            // Delete note B's .myn directly (its header drops out of the
            // on-disk manifest).
            let note_uuid = id_b; // canonical UUID string
            std::fs::remove_file(notes_dir.join(format!("{note_uuid}.myn"))).expect("delete B");

            let s2 = SearchIndexState::default();
            hydrate_search_index_with_dir(vault.path(), &state, &s2, &myne_core::host::NoopHost)
                .await
                .expect("reconcile hydrate");
            assert_eq!(
                query_ids(&s2, "rust"),
                vec![id_a],
                "surviving note still searchable"
            );
            assert!(
                query_ids(&s2, "python").is_empty(),
                "deleted note dropped from the index on reconcile"
            );
        });
    }

    #[test]
    fn hydrate_and_persist_reject_when_slot_not_unlocked() {
        rt().block_on(async {
            let vault = ScopedTempDir::new("search-sync-locked").unwrap();
            seed_vault_meta(vault.path(), 0x11);
            let state = VaultRuntimeState::default(); // Slot::Empty
            let search = SearchIndexState::default();

            assert!(matches!(
                hydrate_search_index_with_dir(
                    vault.path(),
                    &state,
                    &search,
                    &myne_core::host::NoopHost
                )
                .await,
                Err(SearchSyncError::SlotNotUnlocked)
            ));
            assert!(matches!(
                persist_search_index_with_dir(vault.path(), &state, &search).await,
                Err(SearchSyncError::SlotNotUnlocked)
            ));
        });
    }

    #[test]
    fn persist_with_missing_vault_meta_surfaces_invalid_vault_meta() {
        rt().block_on(async {
            let vault = ScopedTempDir::new("search-sync-no-meta").unwrap();
            // Unlocked slot, but no vault.meta seeded → account-hash read fails.
            let state = unlocked_state().await;
            let search = SearchIndexState::default();
            assert!(matches!(
                persist_search_index_with_dir(vault.path(), &state, &search).await,
                Err(SearchSyncError::Io)
            ));
        });
    }

    // ── myne#307: an out-of-band MYE1 write must reach DISK, not just RAM ───
    //
    // `refresh_attachment_docs_for` is a LIVE-index patch, and the note whose
    // `att:` docs it rebuilds is never re-saved — a MYE1 cache write does not
    // touch the note's `content_nonce`. So without a persist the extracted text
    // is findable for exactly one session: an idle auto-lock (default 300 s)
    // zeroizes the index and deliberately skips persist, and the next unlock
    // cannot recover it, because hydrate skips the note (nonce unchanged) while
    // the OCR backlog skips the attachment (its cache exists). The bytes sit on
    // disk, unreachable, until an unrelated `extractor_version` bump.
    //
    // Source-level because the defect is an ABSENT line at a call site, in
    // functions that need a live `AppHandle`, an OCR engine and a model on disk
    // to drive. A unit test of either producer would need all three and would
    // still not see the missing statement. This sees exactly it, and it
    // generalises: a THIRD out-of-band producer gets held to the same rule.
    #[test]
    fn every_out_of_band_attachment_doc_refresh_is_followed_by_a_persist() {
        let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
        let mut files = Vec::new();
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            for e in std::fs::read_dir(dir).expect("read src tree") {
                let p = e.expect("dir entry").path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.extension().is_some_and(|x| x == "rs") {
                    out.push(p);
                }
            }
        }
        walk(&root, &mut files);

        let mut checked = 0usize;
        for path in files {
            // The definition's own file is not a call site.
            if path.ends_with("search_sync.rs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("read source");
            let mut from = 0usize;
            while let Some(rel) = text[from..].find("refresh_attachment_docs_for(") {
                let at = from + rel;
                from = at + 1;
                // Skip a prose mention inside a comment line.
                let line_start = text[..at].rfind('\n').map_or(0, |i| i + 1);
                if text[line_start..at].trim_start().starts_with("//") {
                    continue;
                }
                checked += 1;
                // The persist must follow, in the same function. A generous
                // window rather than an exact next-statement match: the OCR
                // producer's is at the end of the enclosing loop's function,
                // several statements and a long comment later.
                let after = &text[at..];
                let persist = after.find("persist_search_index(");
                assert!(
                    persist.is_some(),
                    "{}: a live-index attachment-doc refresh is not followed by a \
                     persist — the extracted text will not survive the session",
                    path.display()
                );
            }
        }
        assert!(
            checked >= 2,
            "expected to find the OCR-backlog and transcript producers; found {checked}"
        );
    }
}
