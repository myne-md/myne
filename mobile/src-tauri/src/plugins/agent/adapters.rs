// SPDX-License-Identifier: AGPL-3.0
//! The mobile side of the agent seams (myne-md/myne#456).
//!
//! **Deliberately short.** Everything a Tauri client needs to run an agent and
//! is not specific to one of them lives in `myne-core` since myne-md/myne#456:
//! the engine adapter (which decides which backend answers, whether the request
//! leaves the device, how much of the user's writing goes with it, and how the
//! prompt is framed), and the three host adapters for reading a note, taking a
//! restore point and writing the approved batch. This file is what genuinely
//! differs.
//!
//! **One thing genuinely differs, and it is the search.** Desktop's
//! `ScopeSearcher` used to query the embedding index: it embeds the query on the
//! strict local-only accessor and takes the top vector matches. That searcher
//! was retired with the `MYR1` AI-embeddings family, so this client's tool is
//! now the only one that answers with anything. Mobile has no vector store and
//! no embedder: `embed` is refused for a remote backend by construction, and
//! on-device inference is out of scope on a phone by decision: so the same tool
//! is answered from the full-text index instead. That is a real difference in
//! behaviour rather than a shim, and it is stated on the implementation rather
//! than hidden inside it.
//!
//! See: src-tauri/AGENTS.md "Secret-handling logging discipline".

use myne_core::plugins::agent::error::AgentError;
use myne_core::plugins::agent::tools::{ScopeSearcher, SearchHit};
use myne_core::search::SearchIndexState;

/// Search a run's scope, through the full-text index.
///
/// **Why this is not desktop's implementation.** Desktop embeds the query and
/// takes the nearest vectors, which is a semantic match: a run asking about
/// "the trip" finds a note that says "holiday" and never uses the word.
/// Full-text matching does not, and that is a capability mobile does not have
/// rather than one it chose to skip. The tool contract is unchanged, a ranked
/// list of note ids: so the loop is unaffected and the difference reaches the
/// user only as a run that occasionally has to be asked more literally.
///
/// **Scope filtering is NOT done here; core does it.** What desktop's version
/// additionally applies at this layer is the vector store's own
/// `ai_excluded_folders` filter, and the equivalent here is the
/// [`ExclusionSource`] below, which the loop re-reads at every read tool. The
/// exclusion is therefore enforced once, on the read, rather than twice on
/// different axes.
pub struct MobileSearchAdapter<'a> {
    pub search: &'a SearchIndexState,
}

#[async_trait::async_trait]
impl ScopeSearcher for MobileSearchAdapter<'_> {
    async fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, AgentError> {
        let hits = self.search.query(query);
        Ok(hits
            .into_iter()
            .take(limit)
            .map(|hit| SearchHit {
                note_id: hit.id,
                score: hit.score,
            })
            .collect())
    }
}

// **There is no mobile `ExclusionSource` here, and that is deliberate.** A
// first draft of this file had one, mirroring the desktop plugin's, and it was
// dead on arrival: `step` builds `HostExclusions` itself in `myne-core`, so the
// client never supplies one. A struct that implements a seam nothing asks it
// for is the shape `scripts/check-unwired.mjs` exists to catch, and it reads to
// the next person as though this client had its own exclusion policy.
//
// The exclusion set IS re-read at every read tool inside the loop, which is the
// property that matters and which SYNC-14 requires (it carries no in-flight
// carve-out, so a folder the user excludes while a run is executing must stop
// being read at once). It is simply not this file's job.

#[cfg(test)]
mod tests {
    use super::*;

    /// The full-text answer is capped at the limit the tool asked for.
    ///
    /// Worth a test rather than reading as obvious: `SearchIndexState::query`
    /// takes no limit, so the cap is this adapter's alone, and a run whose
    /// scope search returned the whole vault would put every matching note's id
    /// and title in front of a remote provider on the model's next turn, which
    /// is the disclosure `threat-model.md` TB13's 2026-08-16 amendment records.
    #[tokio::test]
    async fn the_scope_search_never_returns_more_than_it_was_asked_for() {
        let index = SearchIndexState::default();
        for i in 0..10 {
            index.upsert(&format!("n{i}"), "shared title word", "body");
        }
        let adapter = MobileSearchAdapter { search: &index };

        let hits = adapter
            .search("shared", 3)
            .await
            .expect("the index answers");
        assert_eq!(hits.len(), 3, "the tool's limit is the adapter's to apply");
    }

    /// A query that matches nothing is an empty list, not an error.
    ///
    /// The loop treats a tool error as a run failure, so answering `Err` for
    /// "your vault does not contain that word" would end a run the user could
    /// have carried on by asking differently.
    #[tokio::test]
    async fn a_query_that_matches_nothing_answers_an_empty_list() {
        let index = SearchIndexState::default();
        index.upsert("n1", "Groceries", "milk");
        let adapter = MobileSearchAdapter { search: &index };

        let hits = adapter
            .search("quarterly-revenue-projection", 5)
            .await
            .expect("the index answers");
        assert!(hits.is_empty());
    }
}
