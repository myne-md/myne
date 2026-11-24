// SPDX-License-Identifier: AGPL-3.0-only
//! `search` plugin — mobile host (MYS1 full-text search, frontend-fed).
//!
//! Drives the shared BM25 full-text search engine (`myne_core::search`:
//! `SearchIndexState` / `InvertedIndex` / `Document`) from the mobile WebView.
//! Unlike desktop — where the notes lifecycle hooks feed the index Rust-side
//! from decrypted `.myn` blobs — mobile is **frontend-fed**: the WebView
//! already holds every note's plaintext (it crossed IPC as note bodies), so it
//! pushes `(id, title, body)` down and queries the result via `note_search`.
//! It feeds the corpus in two modes: `search_index_replace` seeds the whole
//! index after unlock, and `search_index_apply` / `search_index_remove` carry
//! the per-note delta after that (myne-mobile#41 — feeding the whole corpus on
//! every save made one note's edit cost work proportional to the vault). No
//! Rust-side decryption / hydrate path is needed, and no persisted
//! `vault.search` (MYS1) blob is written on mobile —
//! the index is a live, session-only, plaintext-derived RAM structure rebuilt
//! from the WebView on each unlock.
//!
//! No slot gate: the frontend only calls these while the vault is unlocked, and
//! the plaintext already crossed IPC as the note bodies it is re-pushing here.
//! The index (`SearchIndexState`) is managed in `lib.rs` setup, like the
//! structurally-twin `vault-indices` state, and torn down on the same leg:
//! `crate::hooks::MobileHooks::zeroize_search_index` clears it wherever
//! `myne-core` drops the slot (myne-md/myne#454). Nothing is flushed first, and
//! nothing needs to be — mobile writes no `vault.search` blob, so the index is
//! purely a rebuildable RAM cache the WebView re-seeds with
//! `search_index_replace` on the next unlock.
//!
//! See: the main repo's `src-tauri/AGENTS.md` "Secret-handling logging
//! discipline" — no note plaintext (title/body/query) is ever logged here.

use myne_core::plugins::vault_unlock::state::{SlotKind, VaultRuntimeState};
use myne_core::search::{Document, InvertedIndex, SearchIndex, SearchIndexState};
use serde::{Deserialize, Serialize};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{Runtime, State};

/// Upper bound on results returned to the WebView per query — mirrors the
/// desktop `NOTE_SEARCH_RESULT_CAP`. The index returns the full BM25-ranked
/// match set; a broad type-ahead prefix on a large vault can match thousands of
/// notes, so the command caps to the top-N highest-scored (the palette renders
/// ~10-20 rows). Result-shaping only.
const NOTE_SEARCH_RESULT_CAP: usize = 50;

/// One note pushed to the index by the WebView: the note's id plus its display
/// title and plaintext body. The frontend feeds the whole corpus on unlock (and
/// re-feeds on edit); mirrors `myne_core::search::Document` at the IPC boundary.
#[derive(Debug, Clone, Deserialize)]
pub struct SearchDoc {
    pub id: String,
    pub title: String,
    pub body: String,
}

/// A ranked search result for the WebView: the matching note's id + display
/// title + BM25 score, best score first. (The engine also computes a
/// `matched_in` field; mobile's palette does not render the body-match badge
/// yet, so it is omitted here — the 3-field shape is the mobile contract.)
#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub note_id: String,
    pub title: String,
    pub score: f32,
}

/// `search_index_replace` — rebuild the live in-RAM index from the WebView's
/// full `(id, title, body)` corpus (bulk, atomic replace). Called on unlock and
/// after any change that the frontend wants reflected. Not slot-gated: the
/// frontend only calls it while unlocked, and the plaintext already crossed IPC
/// as note bodies. Never logs any title/body.
#[tauri::command]
fn search_index_replace(
    docs: Vec<SearchDoc>,
    search: State<'_, SearchIndexState>,
) -> Result<(), ()> {
    let documents: Vec<Document> = docs
        .into_iter()
        .map(|d| Document {
            id: d.id,
            title: d.title,
            body: d.body,
        })
        .collect();
    // Bulk build off the passed corpus, then atomically swap it in (no window
    // where a concurrent query sees a half-built index).
    search.replace(InvertedIndex::build(documents));
    Ok(())
}

/// `search_index_apply` — re-index just the notes that changed, leaving the
/// rest of the corpus untouched (myne-mobile#41). The engine's per-document
/// `upsert` is replace-semantics per id, so one call fully overwrites each
/// listed note's terms — the same primitive the desktop feeds from its note
/// write hooks. Takes a batch rather than a single doc so a sweep costs one
/// round-trip no matter how many notes moved.
///
/// `search_index_replace` stays the corpus-level verb: it is what seeds the
/// index after unlock, when there is no prior state to delta against.
/// Not slot-gated, for the same reason as its two siblings.
#[tauri::command]
fn search_index_apply(docs: Vec<SearchDoc>, search: State<'_, SearchIndexState>) -> Result<(), ()> {
    for d in docs {
        search.upsert(&d.id, &d.title, &d.body);
    }
    Ok(())
}

/// `search_index_remove` — drop notes from the live index by id (no-op per
/// absent id). The delete half of `search_index_apply`: without it a purged
/// note keeps matching queries until the next full replace.
#[tauri::command]
fn search_index_remove(ids: Vec<String>, search: State<'_, SearchIndexState>) -> Result<(), ()> {
    for id in ids {
        search.remove(&id);
    }
    Ok(())
}

/// `note_search` — BM25 full-text search over the live in-RAM index. Returns
/// the top-`NOTE_SEARCH_RESULT_CAP` hits, highest score first (as the engine
/// ranks them). Empty on an empty/absent index. Never logs the query.
///
/// **Slot-gated, and the gate is the point.** The shared core rests the
/// no-IPC-leak property of the whole lock path on exactly this door:
/// `lock_from_host` states that `note_search` "gates on `Slot::Unlocked`
/// (returns empty when locked), so there is no IPC leak, only raw RAM
/// retention", and `search_sync_core.rs` states the rule outright, that an index
/// which has not yet been zeroized must not answer through this door. That was
/// true of desktop and false here: mobile answered queries against a locked
/// vault's titles and bodies over IPC, which made myne#454 a locked-vault READ
/// surface rather than the residency problem it was recorded as.
///
/// The teardown hook this change wires is the other half, not a replacement for
/// this one. It is best-effort by construction: `SearchIndexState::clear()`
/// no-ops on a poisoned lock, and a `try_state` miss is an unlogged no-op, so a
/// lock whose only defence was the wipe would be weaker than the threat model's
/// A6 row describes for a native client. The same reasoning is already written
/// down one directory over: `local_inference` re-reads its gate host-side
/// because "a compromised WebView is not trusted to stop calling".
#[tauri::command]
async fn note_search(
    query: String,
    search: State<'_, SearchIndexState>,
    runtime: State<'_, VaultRuntimeState>,
) -> Result<Vec<SearchResult>, ()> {
    if runtime.slot_kind_active().await != SlotKind::Unlocked {
        return Ok(Vec::new());
    }
    let results = search
        .query(&query)
        .into_iter()
        .take(NOTE_SEARCH_RESULT_CAP)
        .map(|hit| SearchResult {
            note_id: hit.id,
            title: hit.title,
            score: hit.score,
        })
        .collect();
    Ok(results)
}

/// Construct the mobile `search` plugin. Borrows the [`SearchIndexState`]
/// singleton managed in `lib.rs` setup (like the `vault-indices` state); the
/// plugin holds no plugin-private state of its own.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::<R>::new("search")
        .invoke_handler(tauri::generate_handler![
            search_index_replace,
            search_index_apply,
            search_index_remove,
            note_search
        ])
        .build()
}
