// SPDX-License-Identifier: AGPL-3.0
//! The three tools an agent run may call, and nothing else.
//!
//! Three is a ceiling rather than a starting point. Every tool is a surface an
//! instruction embedded in a note the model read can aim at, so the count is a
//! security decision: list the scope by title, read one note in full, search the
//! scope. A fourth tool is a change to that decision, not an addition to this
//! file.
//!
//! **The clamp is inseparable from the operation, on purpose.** None of these
//! functions is a check a caller performs before doing the real thing; each one
//! *is* the real thing, and takes the reader or the searcher as a seam. A shape
//! where the clamp is its own `check_scope(..)` function is a shape where one
//! call site forgets it, and no compiler says so.
//!
//! **No tool takes a scope.** Every one takes the run id and asks
//! [`super::run::AgentRunState`] what that run's set is. A tool that accepted a
//! note list, a folder, or an excluded-folder set from its arguments would be
//! trusting the caller, and `decisions/ai/0462` already settled why that is not
//! available: "'the caller behaved' is not a property of a seam".

use super::error::AgentError;
use super::run::AgentRunState;
use crate::plugins::vault_indices::state::NoteRecord;
use serde::Serialize;
use std::collections::BTreeMap;

/// One row of the list tool: enough for the model to choose, and no body.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeEntry {
    /// The note's id.
    pub note_id: String,
    /// The note's title, or `None` when it has none. Never a body excerpt: the
    /// list tool exists so the model can pick what to read, and handing it
    /// content here would make the read tool decorative.
    pub title: Option<String>,
}

/// One hit from the search tool.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    /// The note's id.
    pub note_id: String,
    /// The retrieval score the existing ranker produced, passed through.
    pub score: f32,
}

/// Reading one note's plaintext body. The host supplies it.
///
/// A trait rather than a function parameter so the clamp in [`read_note`] cannot
/// be separated from the read: there is no way to call the reader through this
/// module without passing a run id first.
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait NoteReader: Send + Sync {
    /// Read one note's body. The implementation performs no scope check of its
    /// own; that already happened.
    async fn read_body(&self, note_id: &str) -> Result<String, AgentError>;
}

/// Searching the vault. The host supplies the existing retrieval path.
///
/// The seam returns ranked note ids rather than prompt-ready chunks, which is
/// the whole difference between this and the chat pipeline: the model picks
/// what to read in full afterwards, because an anchored edit needs the note's
/// actual bytes and a chunk is not those.
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
pub trait ScopeSearcher: Send + Sync {
    /// Rank the vault against a query. Scope filtering is this module's job, not
    /// the index's: the index does not know about runs, and teaching it would be
    /// a second place for the clamp to be wrong.
    async fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, AgentError>;
}

/// Tool 1: the run's scope, by title.
pub fn list_scope(
    runs: &AgentRunState,
    run_id: &str,
    records: &BTreeMap<String, NoteRecord>,
) -> Result<Vec<ScopeEntry>, AgentError> {
    let scope = runs.scope(run_id)?;
    Ok(scope
        .into_iter()
        .map(|note_id| {
            let title = records.get(&note_id).and_then(|r| r.title.clone());
            ScopeEntry { note_id, title }
        })
        .collect())
}

/// Tool 2: read one note in full, if it is in scope.
pub async fn read_note(
    runs: &AgentRunState,
    run_id: &str,
    note_id: &str,
    reader: &dyn NoteReader,
) -> Result<String, AgentError> {
    if !runs.contains(run_id, note_id)? {
        return Err(AgentError::OutOfScope {
            note_id: note_id.to_string(),
        });
    }
    reader.read_body(note_id).await
}

/// Tool 3: search, clamped to the run's scope.
///
/// Filtering happens after ranking rather than inside it. That costs a little
/// recall at the edges (an out-of-scope note can occupy a slot the ranker would
/// otherwise have given an in-scope one), and it buys the property that matters:
/// the index stays scope-blind, so there is exactly one place the clamp lives.
/// `limit` is applied to the clamped result, so the caller gets what it asked
/// for rather than a silently short list.
pub async fn search_scope(
    runs: &AgentRunState,
    run_id: &str,
    query: &str,
    limit: usize,
    searcher: &dyn ScopeSearcher,
) -> Result<Vec<SearchHit>, AgentError> {
    // Resolve the run BEFORE searching. Filtering only inside the result loop
    // looks equivalent and is not: an empty result set never enters the loop, so
    // an unknown run would return `Ok(vec![])` instead of `NoSuchRun`: a tool
    // answering successfully for a run that does not exist.
    runs.view(run_id)?;
    // Over-fetch so the clamp does not turn `limit` into a ceiling nobody
    // reaches. The factor is a recall convenience with no security meaning: the
    // clamp below is what bounds the result, not this number.
    let over = limit.saturating_mul(4).max(limit);
    let ranked = searcher.search(query, over).await?;
    // One lock for the whole result set, and no copy of the scope: a 400-note
    // scope cloned per search call is 400 String allocations to answer a
    // membership question.
    let ids: Vec<String> = ranked.iter().map(|h| h.note_id.clone()).collect();
    let in_scope = runs.contains_all(run_id, &ids)?;
    let mut out = Vec::new();
    for (hit, keep) in ranked.into_iter().zip(in_scope) {
        if keep {
            out.push(hit);
            if out.len() == limit {
                break;
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::agent::run::AgentRunState;
    use std::collections::BTreeSet;

    fn ids(v: &[&str]) -> BTreeSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn records(pairs: &[(&str, &str)]) -> BTreeMap<String, NoteRecord> {
        pairs
            .iter()
            .map(|(id, title)| {
                (
                    id.to_string(),
                    NoteRecord {
                        title: Some((*title).to_string()),
                        ..Default::default()
                    },
                )
            })
            .collect()
    }

    struct StubReader;

    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl NoteReader for StubReader {
        async fn read_body(&self, note_id: &str) -> Result<String, AgentError> {
            Ok(format!("body of {note_id}"))
        }
    }

    struct StubSearcher(Vec<SearchHit>);

    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl ScopeSearcher for StubSearcher {
        async fn search(&self, _q: &str, _limit: usize) -> Result<Vec<SearchHit>, AgentError> {
            Ok(self.0.clone())
        }
    }

    fn hit(id: &str, score: f32) -> SearchHit {
        SearchHit {
            note_id: id.to_string(),
            score,
        }
    }

    use crate::test_support::block_on as block;

    #[test]
    fn list_returns_only_notes_in_the_runs_set() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let recs = records(&[("a", "In"), ("b", "Out")]);
        let listed = list_scope(&runs, "r", &recs).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].note_id, "a");
        assert_eq!(listed[0].title.as_deref(), Some("In"));
    }

    #[test]
    fn list_carries_no_body_only_a_title() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let listed = list_scope(&runs, "r", &records(&[("a", "T")])).unwrap();
        let json = serde_json::to_string(&listed).unwrap();
        assert!(json.contains("\"title\""));
        assert!(!json.contains("body"));
    }

    // Refusal, tested on its own for the read tool.
    #[test]
    fn read_refuses_a_note_outside_the_set_by_name() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let err = block(read_note(&runs, "r", "b", &StubReader)).unwrap_err();
        assert!(matches!(err, AgentError::OutOfScope { ref note_id } if note_id == "b"));
    }

    #[test]
    fn read_returns_the_body_for_a_note_in_the_set() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        assert_eq!(
            block(read_note(&runs, "r", "a", &StubReader)).unwrap(),
            "body of a"
        );
    }

    // Refusal, tested on its own for the search tool. Note the shape: search
    // does not error on an out-of-scope hit, it drops it. Asserting the drop is
    // the equivalent assertion, and it is the one that matters, because a
    // ranker that surfaced an excluded note would leak its existence.
    #[test]
    fn search_drops_hits_outside_the_set() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let searcher = StubSearcher(vec![hit("b", 0.9), hit("a", 0.5), hit("c", 0.4)]);
        let out = block(search_scope(&runs, "r", "q", 10, &searcher)).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].note_id, "a");
    }

    #[test]
    fn search_honours_the_limit_after_clamping_not_before() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a", "b", "c"]));
        let searcher = StubSearcher(vec![hit("a", 0.9), hit("b", 0.8), hit("c", 0.7)]);
        let out = block(search_scope(&runs, "r", "q", 2, &searcher)).unwrap();
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn every_tool_refuses_an_unknown_run_rather_than_defaulting_open() {
        let runs = AgentRunState::default();
        assert!(matches!(
            list_scope(&runs, "nope", &BTreeMap::new()),
            Err(AgentError::NoSuchRun)
        ));
        assert!(matches!(
            block(read_note(&runs, "nope", "a", &StubReader)),
            Err(AgentError::NoSuchRun)
        ));
        assert!(matches!(
            block(search_scope(&runs, "nope", "q", 5, &StubSearcher(vec![]))),
            Err(AgentError::NoSuchRun)
        ));
    }
}
