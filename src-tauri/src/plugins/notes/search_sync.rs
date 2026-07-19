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
use crate::search::persist::{decode_snapshot, encode_snapshot, reconcile};
use crate::search::SearchIndexState;
use protocol::{derive_subkey, parse_vault_meta, SubkeyRole, VAULT_META_ACCOUNT_HASH_LEN};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};

// The decryption-free on-disk nonce scan moved to `myne-core`
// (`myne_core::note_nonce::scan_on_disk_manifest`, shared with the vault-indices
// plugin). Re-exported so existing
// `crate::plugins::notes::search_sync::scan_on_disk_manifest` paths (the sync
// orchestrator, this module's own hydrate/persist) keep resolving.
pub(crate) use myne_core::note_nonce::scan_on_disk_manifest;

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

/// Bounded failure surface for the search-index IO lifecycle. Every variant
/// is swallowed (logged, then ignored) at the call site — the `Result`
/// exists only so the `_with_dir` cores are unit-testable. Variant names are
/// DENY-list-safe (no payload).
#[derive(Debug)]
pub enum SearchSyncError {
    /// The slot was not `Unlocked` when hydrate / persist ran (peek of
    /// `root_key` failed). Hydrate: nothing to load into. Persist: no key.
    SlotNotUnlocked,
    /// `vault.meta` was missing or unreadable (needed for the
    /// `account_number_hash` AAD binding).
    InvalidVaultMeta,
    /// A filesystem failure reading `vault.meta` / scanning headers /
    /// writing `vault.search`.
    Io,
    /// `encode_search_index_blob` failed (structurally unreachable under
    /// v0.1 fixed AEAD params; mapped defensively).
    Encode,
    /// The `spawn_blocking` encode task panicked / the runtime shut down.
    Join,
}

/// Static-string label for [`SearchSyncError`] — tracing-safe, drift-
/// detecting (a new variant compile-fails the match). Mirrors the
/// `*_error_kind` discipline across the plugins.
fn sync_error_kind(e: &SearchSyncError) -> &'static str {
    match e {
        SearchSyncError::SlotNotUnlocked => "slot_not_unlocked",
        SearchSyncError::InvalidVaultMeta => "invalid_vault_meta",
        SearchSyncError::Io => "io_error",
        SearchSyncError::Encode => "encode_failed",
        SearchSyncError::Join => "join_failure",
    }
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
    let meta = parse_vault_meta(&bytes).map_err(|_| SearchSyncError::InvalidVaultMeta)?;
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
        let Ok(plaintext) = note_read_with_dir(notes_dir.clone(), state, note_id.clone()).await
        else {
            continue;
        };
        let title = resolve_note_title(plaintext.as_bytes()).unwrap_or_default();
        let atts = note_attachment_docs(state, &vault_dir, &title, &plaintext).await;
        search.set_note_attachments(&note_id, &atts);
    }
    tracing::info!(event = "transcript_search_docs_refreshed");
}

/// Testable core of [`hydrate_search_index`]. Loads `vault.search` (fast
/// path) and reconciles it against the notes dir's current header nonces,
/// then swaps the result into `search`. A note is decrypted ONLY when its
/// nonce changed / first appeared; unchanged notes are never decrypted
/// (acceptance criterion 2). Absent / AEAD-fail / malformed blob → empty
/// `(manifest, index)` → reconcile becomes a full rebuild against every
/// on-disk note (criterion 4).
pub(crate) async fn hydrate_search_index_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    search: &SearchIndexState,
) -> Result<(), SearchSyncError> {
    // MYND-328: also need items_key + items_key_id to decrypt MYA1 sources for
    // the lazy backfill of attachments imported before the eager cache.
    let (items_key, items_key_id, root_key) = state
        .peek_unlocked_attachment_material()
        .await
        .ok_or(SearchSyncError::SlotNotUnlocked)?;
    let account_number_hash = read_account_number_hash(&vault_dir.join("vault.meta"))?;
    let search_index_key = derive_subkey(&root_key, SubkeyRole::SearchIndexKey);
    // MYND-328: KEK for the per-attachment extracted-text cache, folded into the
    // indexed note bodies below. `memo` dedups cache reads across notes within
    // this rebuild (an attachment embedded in N notes is read once — § 9.6.4).
    let attachment_text_key = derive_subkey(&root_key, SubkeyRole::AttachmentTextKey);
    let mut attachment_text_memo: std::collections::HashMap<[u8; 32], Option<String>> =
        std::collections::HashMap::new();
    // Catalog (content_type + filename per attachment) drives the backfill's
    // MYA1 decrypt + extraction dispatch. Best-effort: empty on any read error.
    let catalog_key = derive_subkey(&root_key, SubkeyRole::AttachmentsCatalogKey);
    let attachment_catalog = crate::plugins::attachments::commands::read_catalog(
        &vault_dir.join("vault.attachments"),
        &catalog_key,
        &account_number_hash,
    )
    .unwrap_or_else(|_| protocol::AttachmentsCatalog::empty());
    let notes_dir = paths::notes_dir_under(vault_dir).map_err(|_| SearchSyncError::Io)?;

    // Decryption-free staleness scan of the current notes dir.
    let on_disk = scan_on_disk_manifest(&notes_dir);

    // Fast path: decode the persisted snapshot. Absent / AEAD-fail /
    // malformed / stale schema → empty `(manifest, index)` so the reconcile
    // below is a full rebuild against `on_disk`. MYND-448a: a v1 (folded-body)
    // blob is rejected by the schema-version gate → rebuild into the v2
    // separate-attachment-doc model.
    let (mut manifest, mut index) = std::fs::read(vault_dir.join("vault.search"))
        .ok()
        .and_then(|blob| decode_snapshot(&search_index_key, &account_number_hash, &blob))
        .unwrap_or_default();

    // MYND-448a: notes that vanished from disk — reconcile drops their BODY doc;
    // their separate attachment docs (`att:*:<note_id>`) are dropped below.
    let deleted_note_ids: Vec<String> = manifest
        .keys()
        .filter(|id| !on_disk.contains_key(*id))
        .cloned()
        .collect();

    // Decrypt ONLY the changed / new notes (nonce differs from, or is absent
    // in, the loaded manifest). Unchanged notes are skipped here — and never
    // reached by `reconcile`'s fetch either, since their nonce matches; their
    // body doc AND attachment docs stay as loaded from the blob.
    let mut fetched: HashMap<String, (String, String)> = HashMap::new();
    // MYND-448a: for every changed/new note, its attachment docs
    // `(attachment_id_hex, title, text)`. An entry is inserted even when EMPTY,
    // so `set_note_attachments` below clears attachment docs the note no longer
    // embeds (e.g. an attachment removed from an edited note).
    let mut note_attachments: HashMap<String, Vec<(String, String, String)>> = HashMap::new();
    for (id, nonce) in &on_disk {
        if manifest.get(id) == Some(nonce) {
            continue; // unchanged — no decrypt
        }
        match note_read_with_dir(notes_dir.clone(), state, id.clone()).await {
            Ok(plaintext) => {
                let title = resolve_note_title(plaintext.as_bytes()).unwrap_or_default();
                // MYND-328: backfill any uncached embedded attachment from its
                // MYA1 source (pre-eager-cache attachments) so `collect` below
                // sees its extracted text.
                crate::plugins::attachments::text_cache::backfill_note_attachment_text(
                    &plaintext,
                    vault_dir,
                    &attachment_text_key,
                    &account_number_hash,
                    &items_key,
                    &items_key_id,
                    &attachment_catalog,
                    &mut attachment_text_memo,
                    // The MYE1 producer is injected so the shared cache module
                    // (myne-core) stays free of the desktop-only extractor deps.
                    crate::plugins::attachments::extract::extract,
                );
                // MYND-448a: each embedded attachment becomes its OWN doc; the
                // note's body doc carries the UNFOLDED plaintext.
                // SF5 (MYND-502): a `kind: drawing` note has no markdown embeds —
                // rebuild its body doc from projected scene text, never the raw
                // ```excalidraw JSON (SYNC-4 body-only), and skip attachment docs,
                // so the projection survives lock→unlock and never repollutes the
                // index (parity with the incremental path).
                if myne_core::plugins::notes::drawing_text::is_drawing(plaintext.as_bytes()) {
                    let body = myne_core::plugins::notes::drawing_text::project_drawing_text(
                        plaintext.as_bytes(),
                    )
                    .unwrap_or_default();
                    fetched.insert(id.clone(), (title, body));
                } else {
                    let atts: Vec<(String, String, String)> =
                        crate::plugins::attachments::text_cache::collect_attachment_texts(
                            &plaintext,
                            vault_dir,
                            &attachment_text_key,
                            &account_number_hash,
                            &mut attachment_text_memo,
                        )
                        .into_iter()
                        .map(|(att_id_hex, text)| (att_id_hex, title.clone(), text))
                        .collect();
                    note_attachments.insert(id.clone(), atts);
                    fetched.insert(id.clone(), (title, plaintext));
                }
            }
            Err(_) => {
                // Unreadable note (locked mid-hydrate / corrupt / non-UTF-8):
                // leave it for the next reconcile pass. No id / cause logged
                // (DENY-list); reconcile leaves the prior index entry intact.
            }
        }
    }
    let reindexed = fetched.len();

    // reconcile handles NOTE body docs only (unfolded); it is the untouched
    // shared core. MYND-448a layers the separate attachment docs on top.
    reconcile(&mut index, &mut manifest, &on_disk, |id| fetched.remove(id));
    for id in &deleted_note_ids {
        index.remove_note_attachments(id);
    }
    for (note_id, atts) in &note_attachments {
        index.set_note_attachments(note_id, atts);
    }
    search.replace(index);

    tracing::info!(
        event = "search_index_hydrated",
        reindexed,
        total = on_disk.len(),
    );
    Ok(())
}

/// Testable core of [`persist_search_index`]. Snapshots the live index,
/// pairs it with a freshly-scanned nonce manifest (so the persisted snapshot
/// matches disk exactly → the next unlock skips everything), encrypts to the
/// `vault.search` blob, and atomically writes it. The CPU-bound serialize +
/// AEAD runs in `spawn_blocking`. MUST be called while the slot is still
/// `Unlocked` (it peeks `root_key`).
pub(crate) async fn persist_search_index_with_dir(
    vault_dir: &Path,
    state: &VaultRuntimeState,
    search: &SearchIndexState,
) -> Result<(), SearchSyncError> {
    // SYNC-6 writer-guard (MYND-32): guard bound across the atomic_write
    // below — see `state::hold_unlocked_root_key_and_hash`.
    let (_slots_guard, root_key, _vmh) = state
        .hold_unlocked_root_key_and_hash()
        .await
        .ok_or(SearchSyncError::SlotNotUnlocked)?;
    let account_number_hash = read_account_number_hash(&vault_dir.join("vault.meta"))?;
    let search_index_key = derive_subkey(&root_key, SubkeyRole::SearchIndexKey);
    let notes_dir = paths::notes_dir_under(vault_dir).map_err(|_| SearchSyncError::Io)?;

    // Re-derive the manifest from disk so the persisted snapshot is exactly
    // consistent with the current `.myn` nonces (the in-RAM index already
    // reflects the session's incremental upserts/removes).
    let on_disk = scan_on_disk_manifest(&notes_dir);
    let total = on_disk.len();
    let index = search.snapshot();
    let search_path = vault_dir.join("vault.search");

    // Serialize + AEAD-encrypt off the runtime worker (the index can be
    // large at 10k notes). `search_index_key` (Zeroizing) moves into the
    // closure and wipes on its exit.
    let blob = tokio::task::spawn_blocking(move || {
        encode_snapshot(&search_index_key, &account_number_hash, &on_disk, &index)
    })
    .await
    .map_err(|_| SearchSyncError::Join)?
    .map_err(|_| SearchSyncError::Encode)?;

    crate::atomic_write::atomic_write(&search_path, &blob, /* replace = */ true)
        .map_err(|_| SearchSyncError::Io)?;

    tracing::info!(event = "search_index_persisted", total);
    Ok(())
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
    if let Err(e) = hydrate_search_index_with_dir(&vault_dir, state, search.inner()).await {
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
            )
            .await
            .expect("create A");
            let id_b = note_create_with_dir(
                notes_dir.clone(),
                &state,
                "# Beta\npython data science".into(),
            )
            .await
            .expect("create B");

            // First hydrate (no blob) → full rebuild → both searchable
            // (criterion 4: full rebuild on absent blob).
            let s1 = SearchIndexState::default();
            hydrate_search_index_with_dir(vault.path(), &state, &s1)
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
            hydrate_search_index_with_dir(vault.path(), &state, &s2)
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

            let id_a =
                note_create_with_dir(notes_dir.clone(), &state, "# Alpha\nrust async".into())
                    .await
                    .expect("create A");
            let id_b =
                note_create_with_dir(notes_dir.clone(), &state, "# Beta\npython data".into())
                    .await
                    .expect("create B");

            // Build + persist the baseline.
            let s1 = SearchIndexState::default();
            hydrate_search_index_with_dir(vault.path(), &state, &s1)
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
            )
            .await
            .expect("edit A");

            // Warm hydrate: A re-indexed (new term present, stale term gone),
            // B untouched (kept from the blob — criterion 3).
            let s2 = SearchIndexState::default();
            hydrate_search_index_with_dir(vault.path(), &state, &s2)
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

            let id_a =
                note_create_with_dir(notes_dir.clone(), &state, "# Alpha\nrust async".into())
                    .await
                    .expect("create A");
            let id_b =
                note_create_with_dir(notes_dir.clone(), &state, "# Beta\npython data".into())
                    .await
                    .expect("create B");

            let s1 = SearchIndexState::default();
            hydrate_search_index_with_dir(vault.path(), &state, &s1)
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
            hydrate_search_index_with_dir(vault.path(), &state, &s2)
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
                hydrate_search_index_with_dir(vault.path(), &state, &search).await,
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
}
