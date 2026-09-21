//! Brute-force cosine retrieval (semantic-search-qa task 5, SYNC-18 / MYND-29)
//! — the single Rust-side nearest-neighbour service. Embeds a query once, scores
//! it by cosine similarity against **every** resident chunk vector, and returns
//! the top-k resolved to `{note_id, byte-range}`. Zero extra dependency: a
//! linear scan over the [`AiVectorStore`], no ANN index.
//!
//! ## Consumer-agnostic + exclusion-aware
//!
//! The signature takes an `is_excluded: Fn(&NoteId) -> bool` predicate rather
//! than reaching into `vault.prefs`, so the same service backs both the QA
//! consumer and the future merge-time semantic-link consumer (sibling 6,
//! SYNC-10). Excluded-folder notes are never embedded (task 3), but the filter
//! is **also** enforced here (defense-in-depth, task 5 acceptance): even a stale
//! resident vector for a now-excluded note can never surface in results.
//!
//! Ties are broken deterministically by `{note_id, start, end}` so ranking is
//! reproducible; `f32::total_cmp` gives a total order over scores (NaN-safe).
//!
//! Secret-handling: never log a query, a vector, a score, or a `note_id`
//! (`src-tauri/AGENTS.md`). The `embed` closure is the `Engine::embed` seam
//! (stub in tests) — no direct inference-crate dependency here.

#![cfg_attr(not(test), allow(dead_code))]

use myne_core::plugins::notes::note_id::NoteId;

use super::vector_store::{AiVectorStore, ChunkKey};

/// One ranked result: the chunk key and its cosine score against the query.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScoredChunk {
    pub key: ChunkKey,
    pub score: f32,
}

/// Cosine similarity of two equal-length vectors in `[-1.0, 1.0]`.
///
/// Defensive on the edges: a zero-norm vector (all zeros — the stub embedding)
/// or a dimension mismatch scores `0.0` rather than `NaN`, so the ranking stays
/// total-orderable and no panic escapes.
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for i in 0..a.len() {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// Score `query` against every resident chunk vector, skipping excluded notes,
/// and return the top `k` by cosine similarity (descending). Deterministic tie
/// order. `k == 0` or an empty store yields an empty result — never a panic.
pub fn top_k_matches(
    query: &[f32],
    store: &AiVectorStore,
    k: usize,
    is_excluded: impl Fn(&NoteId) -> bool,
) -> Vec<ScoredChunk> {
    if k == 0 {
        return Vec::new();
    }
    let mut scored: Vec<ScoredChunk> = store
        .iter()
        .filter(|(key, _)| !is_excluded(&key.note_id))
        .map(|(key, vec)| ScoredChunk {
            key: *key,
            score: cosine_similarity(query, vec),
        })
        .collect();

    scored.sort_by(|a, b| {
        // Score descending (total order, NaN-safe), then key ascending for a
        // reproducible tie order.
        b.score
            .total_cmp(&a.score)
            .then_with(|| a.key.note_id.cmp(&b.key.note_id))
            .then_with(|| a.key.start.cmp(&b.key.start))
            .then_with(|| a.key.end.cmp(&b.key.end))
    });
    scored.truncate(k);
    scored
}

/// Full semantic-search: embed the query string **once** via the `embed` seam
/// (`Engine::embed`, blocking — SYNC-7), then [`top_k_matches`]. Returns the
/// ranked `{note_id, byte-range}` chunks. `embed`'s error type is propagated
/// unchanged so the command layer maps it to its closed error enum.
pub fn semantic_search<E>(
    query_text: &str,
    store: &AiVectorStore,
    k: usize,
    is_excluded: impl Fn(&NoteId) -> bool,
    mut embed: impl FnMut(&str) -> Result<Vec<f32>, E>,
) -> Result<Vec<ScoredChunk>, E> {
    let query_vec = embed(query_text)?;
    Ok(top_k_matches(&query_vec, store, k, is_excluded))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nid(last: &str) -> NoteId {
        NoteId::parse(&format!("01970e83-4f2f-7000-8000-0000000000{last}")).unwrap()
    }

    fn key(note: NoteId, start: usize, end: usize) -> ChunkKey {
        ChunkKey {
            note_id: note,
            start,
            end,
        }
    }

    // ---- cosine_similarity -------------------------------------------------

    #[test]
    fn cosine_identical_vectors_is_one() {
        let v = [1.0, 2.0, 3.0];
        assert!((cosine_similarity(&v, &v) - 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_orthogonal_is_zero() {
        assert!((cosine_similarity(&[1.0, 0.0], &[0.0, 1.0])).abs() < 1e-6);
    }

    #[test]
    fn cosine_opposite_is_minus_one() {
        assert!((cosine_similarity(&[1.0, 1.0], &[-1.0, -1.0]) + 1.0).abs() < 1e-6);
    }

    #[test]
    fn cosine_scale_invariant() {
        let a = cosine_similarity(&[1.0, 2.0], &[2.0, 4.0]);
        assert!(
            (a - 1.0).abs() < 1e-6,
            "same direction, different magnitude"
        );
    }

    #[test]
    fn cosine_zero_norm_and_mismatch_are_zero_not_nan() {
        assert_eq!(cosine_similarity(&[0.0, 0.0], &[1.0, 2.0]), 0.0);
        assert_eq!(cosine_similarity(&[1.0], &[1.0, 2.0]), 0.0);
        assert_eq!(cosine_similarity(&[], &[]), 0.0);
    }

    // ---- top_k_matches -----------------------------------------------------

    #[test]
    fn ranks_by_cosine_and_selects_top_k() {
        let mut store = AiVectorStore::new();
        let n = nid("11");
        // query direction ~ [1,0]
        store.insert_vector(key(n, 0, 5), vec![1.0, 0.0]); // best
        store.insert_vector(key(n, 5, 10), vec![0.7, 0.7]); // mid
        store.insert_vector(key(n, 10, 15), vec![0.0, 1.0]); // worst (orthogonal)

        let out = top_k_matches(&[1.0, 0.0], &store, 2, |_| false);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].key, key(n, 0, 5));
        assert_eq!(out[1].key, key(n, 5, 10));
        assert!(out[0].score >= out[1].score);
    }

    #[test]
    fn empty_store_and_k_zero_yield_empty() {
        let store = AiVectorStore::new();
        assert!(top_k_matches(&[1.0, 0.0], &store, 5, |_| false).is_empty());

        let mut store2 = AiVectorStore::new();
        store2.insert_vector(key(nid("12"), 0, 5), vec![1.0, 0.0]);
        assert!(top_k_matches(&[1.0, 0.0], &store2, 0, |_| false).is_empty());
    }

    #[test]
    fn ties_are_broken_deterministically_by_key() {
        let mut store = AiVectorStore::new();
        let a = nid("13");
        let b = nid("14");
        // three identical vectors → identical scores → key order decides.
        store.insert_vector(key(b, 5, 10), vec![1.0, 0.0]);
        store.insert_vector(key(a, 0, 5), vec![1.0, 0.0]);
        store.insert_vector(key(a, 10, 15), vec![1.0, 0.0]);

        let out = top_k_matches(&[1.0, 0.0], &store, 3, |_| false);
        // a < b by note_id; within a, start 0 < 10.
        assert_eq!(out[0].key, key(a, 0, 5));
        assert_eq!(out[1].key, key(a, 10, 15));
        assert_eq!(out[2].key, key(b, 5, 10));

        // Reproducible across calls.
        let again = top_k_matches(&[1.0, 0.0], &store, 3, |_| false);
        assert_eq!(out, again);
    }

    #[test]
    fn excluded_notes_never_appear_in_results() {
        let mut store = AiVectorStore::new();
        let keep = nid("15");
        let excluded = nid("16");
        store.insert_vector(key(excluded, 0, 5), vec![1.0, 0.0]); // best match
        store.insert_vector(key(keep, 0, 5), vec![0.5, 0.5]);

        let out = top_k_matches(&[1.0, 0.0], &store, 5, |id| *id == excluded);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].key, key(keep, 0, 5));
        assert!(out.iter().all(|s| s.key.note_id != excluded));
    }

    #[test]
    fn k_larger_than_store_returns_all() {
        let mut store = AiVectorStore::new();
        store.insert_vector(key(nid("17"), 0, 5), vec![1.0, 0.0]);
        let out = top_k_matches(&[1.0, 0.0], &store, 100, |_| false);
        assert_eq!(out.len(), 1);
    }

    // ---- semantic_search (embed seam) --------------------------------------

    #[test]
    fn semantic_search_embeds_query_once_then_ranks() {
        let mut store = AiVectorStore::new();
        let n = nid("18");
        store.insert_vector(key(n, 0, 5), vec![1.0, 0.0]);
        store.insert_vector(key(n, 5, 10), vec![0.0, 1.0]);

        // Fake embedder: maps "left" → [1,0]. Counts calls to prove single-embed.
        let mut calls = 0;
        let embed = |q: &str| -> Result<Vec<f32>, ()> {
            calls += 1;
            Ok(if q == "left" {
                vec![1.0, 0.0]
            } else {
                vec![0.0, 1.0]
            })
        };
        let out = semantic_search("left", &store, 1, |_| false, embed).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].key, key(n, 0, 5));
        assert_eq!(calls, 1, "query embedded exactly once");
    }

    #[test]
    fn semantic_search_propagates_embed_error() {
        let store = AiVectorStore::new();
        let embed = |_: &str| -> Result<Vec<f32>, &'static str> { Err("engine down") };
        let out = semantic_search("q", &store, 1, |_| false, embed);
        assert_eq!(out, Err("engine down"));
    }
}
