//! `search` plugin — mobile host (MYS1 full-text search, frontend-fed).
//!
//! Drives the shared BM25 full-text search engine (`myne_core::search`:
//! `SearchIndexState` / `InvertedIndex` / `Document`) from the mobile WebView.
//! Unlike desktop — where the notes lifecycle hooks feed the index Rust-side
//! from decrypted `.myn` blobs — mobile is **frontend-fed**: the WebView
//! already holds every note's plaintext (it crossed IPC as note bodies), so it
//! pushes the whole `(id, title, body)` corpus down via `search_index_replace`
//! and queries it via `note_search`. No Rust-side decryption / hydrate path is
//! needed, and no persisted `vault.search` (MYS1) blob is written on mobile —
//! the index is a live, session-only, plaintext-derived RAM structure rebuilt
//! from the WebView on each unlock.
//!
//! No slot gate: the frontend only calls these while the vault is unlocked, and
//! the plaintext already crossed IPC as the note bodies it is re-pushing here.
//! The index (`SearchIndexState`) is managed in `lib.rs` setup, like the
//! structurally-twin `vault-indices` state.
//!
//! See: the main repo's `src-tauri/CLAUDE.md` "Secret-handling logging
//! discipline" — no note plaintext (title/body/query) is ever logged here.

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

/// `note_search` — BM25 full-text search over the live in-RAM index. Returns
/// the top-`NOTE_SEARCH_RESULT_CAP` hits, highest score first (as the engine
/// ranks them). Empty on an empty/absent index. Never logs the query.
#[tauri::command]
fn note_search(
    query: String,
    search: State<'_, SearchIndexState>,
) -> Result<Vec<SearchResult>, ()> {
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
        .invoke_handler(tauri::generate_handler![search_index_replace, note_search])
        .build()
}
