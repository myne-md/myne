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
use crate::search::persist::{
    decode_snapshot, encode_snapshot, read_myn_content_nonce, reconcile, NonceManifest,
    MYN_CONTENT_NONCE_LEN, MYN_HEADER_PREFIX_FOR_NONCE,
};
use crate::search::SearchIndexState;
use protocol::{derive_subkey, parse_vault_meta, SubkeyRole, VAULT_META_ACCOUNT_HASH_LEN};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};

use super::commands::{enumerate_notes_dir, note_read_with_dir};
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

/// Read a single `.myn` file's `content_nonce` from its header WITHOUT
/// decrypting — only the first [`MYN_HEADER_PREFIX_FOR_NONCE`] bytes are
/// read. `None` on any IO failure / short file / bad magic.
fn read_header_nonce(path: &Path) -> Option<[u8; MYN_CONTENT_NONCE_LEN]> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut header = [0u8; MYN_HEADER_PREFIX_FOR_NONCE];
    file.read_exact(&mut header).ok()?;
    read_myn_content_nonce(&header)
}

/// Build the on-disk staleness manifest (`note_id → content_nonce`) by
/// scanning every `.myn` header in `notes_dir` — the decryption-free
/// staleness signal diffed against the persisted manifest. An unreadable
/// dir yields an empty manifest (treated as "no notes" — hydrate then drops
/// everything from a loaded blob, persist writes an empty snapshot).
fn scan_on_disk_manifest(notes_dir: &Path) -> NonceManifest {
    let mut manifest = NonceManifest::new();
    let Ok(ids) = enumerate_notes_dir(notes_dir) else {
        return manifest;
    };
    for id in ids {
        let id_str = id.as_uuid().to_string();
        let path = notes_dir.join(format!("{id_str}.myn"));
        if let Some(nonce) = read_header_nonce(&path) {
            manifest.insert(id_str, nonce);
        }
    }
    manifest
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
    let (root_key, _vmh) = state
        .peek_unlocked_root_key_and_hash_clone()
        .await
        .ok_or(SearchSyncError::SlotNotUnlocked)?;
    let account_number_hash = read_account_number_hash(&vault_dir.join("vault.meta"))?;
    let search_index_key = derive_subkey(&root_key, SubkeyRole::SearchIndexKey);
    let notes_dir = paths::notes_dir_under(vault_dir).map_err(|_| SearchSyncError::Io)?;

    // Decryption-free staleness scan of the current notes dir.
    let on_disk = scan_on_disk_manifest(&notes_dir);

    // Fast path: decode the persisted snapshot. Absent / AEAD-fail /
    // malformed → empty `(manifest, index)` so the reconcile below is a
    // full rebuild against `on_disk`.
    let (mut manifest, mut index) = std::fs::read(vault_dir.join("vault.search"))
        .ok()
        .and_then(|blob| decode_snapshot(&search_index_key, &account_number_hash, &blob))
        .unwrap_or_default();

    // Decrypt ONLY the changed / new notes (nonce differs from, or is absent
    // in, the loaded manifest). Unchanged notes are skipped here — and never
    // reached by `reconcile`'s fetch either, since their nonce matches.
    let mut fetched: HashMap<String, (String, String)> = HashMap::new();
    for (id, nonce) in &on_disk {
        if manifest.get(id) == Some(nonce) {
            continue; // unchanged — no decrypt
        }
        match note_read_with_dir(notes_dir.clone(), state, id.clone()).await {
            Ok(plaintext) => {
                let title = resolve_note_title(plaintext.as_bytes()).unwrap_or_default();
                fetched.insert(id.clone(), (title, plaintext));
            }
            Err(_) => {
                // Unreadable note (locked mid-hydrate / corrupt / non-UTF-8):
                // leave it for the next reconcile pass. No id / cause logged
                // (DENY-list); reconcile leaves the prior index entry intact.
            }
        }
    }
    let reindexed = fetched.len();

    reconcile(&mut index, &mut manifest, &on_disk, |id| fetched.remove(id));
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
                id_a.clone(),
                "# Alpha\nrust tokio reactor".into(),
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
