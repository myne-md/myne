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
use super::scope::ExclusionSource;
use crate::folder_key::{canonical_excluded, folder_matches_excluded};
use crate::plugins::notes::title_extract::{extract_title_slices, fm_folder};
use crate::plugins::vault_indices::state::NoteRecord;
use serde::Serialize;
use std::collections::BTreeMap;
use zeroize::Zeroizing;

/// The SYNC-14 set as it is right now, canonicalised for comparison.
///
/// Asked through the seam rather than taken as an argument: this module's header
/// records that a tool accepting an excluded-folder set from its caller would be
/// trusting the caller, which `decisions/ai/0462` already settled is not
/// available. Each tool therefore pays one prefs read, which is nothing against
/// the model round trip that precedes it.
async fn excluded_now(source: &dyn ExclusionSource) -> Result<Vec<String>, AgentError> {
    Ok(canonical_excluded(&source.excluded_now().await?))
}

/// Whether the note this record describes sits in an excluded folder.
///
/// Uses the snapshot's `folder`, which is what the list and search tools have.
/// The read tool does better (it has the body, so it sees a note MOVED into an
/// excluded folder mid-run) and says so at its own call.
fn record_excluded(records: &BTreeMap<String, NoteRecord>, id: &str, excluded: &[String]) -> bool {
    // **Fails CLOSED on an id the snapshot does not carry**, matching
    // `scope.rs::resolve_grant`, which states the rule: a note id the index does
    // not carry has no known folder, so the exclusion test cannot be applied to
    // it. This used to fall through `unwrap_or_default()` to `""`, and
    // `folder_key` skips empty entries, so every exclusion set answered "not
    // excluded" for exactly the input it could not classify. Two functions
    // applying opposite defaults to the same input, one of them arguing for its
    // choice (myne-md/myne#531 review round six).
    let Some(record) = records.get(id) else {
        return true;
    };
    let folder = record.folder.clone().unwrap_or_default();
    folder_matches_excluded(&folder, excluded)
}

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
pub async fn list_scope(
    runs: &AgentRunState,
    run_id: &str,
    records: &BTreeMap<String, NoteRecord>,
    exclusions: &dyn ExclusionSource,
) -> Result<Vec<ScopeEntry>, AgentError> {
    let scope = runs.scope(run_id)?;
    // The SYNC-14 clamp, on the set as it is NOW. The frozen grant is about what
    // the user approved; an exclusion added since is a control they TIGHTENED,
    // and `apply.rs` re-reads for the same reason at the write boundary.
    let excluded = excluded_now(exclusions).await?;
    Ok(scope
        .into_iter()
        .filter(|note_id| !record_excluded(records, note_id, &excluded))
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
    exclusions: &dyn ExclusionSource,
) -> Result<String, AgentError> {
    if !runs.contains(run_id, note_id)? {
        return Err(AgentError::OutOfScope {
            note_id: note_id.to_string(),
        });
    }
    // **The clamp reads the FOLDER OFF THE BODY, exactly as `apply.rs` does.**
    // A note's folder lives in its frontmatter, so the body is the first point at
    // which it is knowable, and reading it here is what makes this tool catch the
    // two cases the write side already catches: a folder the user excluded since
    // the run started, and a note MOVED into an excluded one. The list and search
    // tools settle for the index snapshot's folder, which cannot see the move;
    // this is the tool that hands a whole note to a model, so it is the one worth
    // the extra read.
    //
    // `Zeroizing` because a refused body is AI-path plaintext that must not
    // outlive the decision (`threat-model.md` §7), and on the refusal path it is
    // dropped without ever reaching the transcript.
    let body = Zeroizing::new(reader.read_body(note_id).await?);
    let excluded = excluded_now(exclusions).await?;
    let folder = extract_title_slices(body.as_bytes())
        .frontmatter_bytes
        .and_then(fm_folder)
        .unwrap_or_default();
    if folder_matches_excluded(&folder, &excluded) {
        return Err(AgentError::ExcludedNow);
    }
    Ok((*body).clone())
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
    records: &BTreeMap<String, NoteRecord>,
    exclusions: &dyn ExclusionSource,
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
    // The SYNC-14 clamp rides with the scope clamp rather than after it, so a hit
    // the user has since excluded never occupies a slot. The header above already
    // argues why an excluded note must not even be ranked into view: surfacing it
    // would leak its existence.
    let excluded = excluded_now(exclusions).await?;
    let mut out = Vec::new();
    for (hit, keep) in ranked.into_iter().zip(in_scope) {
        if keep && !record_excluded(records, &hit.note_id, &excluded) {
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

    /// A reader whose bodies carry a frontmatter `folder:`, so the read tool's
    /// clamp has something to read the folder OFF, the way it does in production.
    struct FolderReader(&'static str);

    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl NoteReader for FolderReader {
        async fn read_body(&self, note_id: &str) -> Result<String, AgentError> {
            Ok(format!(
                "---\nfolder: {}\n---\n\nbody of {note_id}\n",
                self.0
            ))
        }
    }

    /// The exclusion seam, answering whatever the test set it to.
    struct StubExclusions(Vec<String>);

    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl ExclusionSource for StubExclusions {
        async fn excluded_now(&self) -> Result<Vec<String>, AgentError> {
            Ok(self.0.clone())
        }
    }

    fn no_exclusions() -> StubExclusions {
        StubExclusions(Vec::new())
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

    // ── SYNC-14 on the READ path (myne-md/myne#529 review) ──────────────────
    //
    // The write half re-reads `ai_excluded_folders` at the command boundary and
    // says why in `apply.rs`: an exclusion the user adds while a run is open is a
    // control they TIGHTENED, and `threat-model.md` §7 states the rule with no
    // in-flight carve-out. The read half did not, so a folder excluded mid-run
    // kept being read and, on the remote arm, kept being sent off device. These
    // four pin both directions of the fix.

    #[test]
    fn read_refuses_a_note_whose_folder_was_excluded_mid_run() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        // In scope, and the user has since excluded the folder it sits in.
        let err = block(read_note(
            &runs,
            "r",
            "a",
            &FolderReader("Private"),
            &StubExclusions(vec!["Private".into()]),
        ))
        .unwrap_err();
        assert!(
            matches!(err, AgentError::ExcludedNow),
            "expected the read-side twin of EditRejection::ExcludedNow, got {err:?}"
        );
    }

    #[test]
    fn read_still_answers_when_nothing_is_excluded() {
        // The other direction. Without this the test above passes for a
        // `read_note` that refuses everything.
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let body = block(read_note(
            &runs,
            "r",
            "a",
            &FolderReader("Private"),
            &no_exclusions(),
        ))
        .unwrap();
        assert!(body.contains("body of a"));
    }

    #[test]
    fn read_refuses_a_note_moved_into_an_excluded_folder() {
        // The case the index snapshot cannot see, and the reason the read tool
        // takes the folder off the BODY rather than off `records`: the note's
        // folder changed after the run froze its scope.
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let err = block(read_note(
            &runs,
            "r",
            "a",
            // The body says Archive; the snapshot (unused here) would still say
            // whatever it said when the run started.
            &FolderReader("Archive"),
            &StubExclusions(vec!["Archive".into()]),
        ))
        .unwrap_err();
        assert!(matches!(err, AgentError::ExcludedNow));
    }

    #[test]
    fn list_drops_a_note_whose_folder_is_excluded_now() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a", "b"]));
        let mut recs = records(&[("a", "Kept"), ("b", "Gone")]);
        recs.get_mut("b").unwrap().folder = Some("Private".into());
        let listed = block(list_scope(
            &runs,
            "r",
            &recs,
            &StubExclusions(vec!["Private".into()]),
        ))
        .unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|e| e.note_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a"],
            "an excluded note must not even be named to the model"
        );
        // And the reverse: with the set empty, both are listed.
        let all = block(list_scope(&runs, "r", &recs, &no_exclusions())).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn list_returns_only_notes_in_the_runs_set() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let recs = records(&[("a", "In"), ("b", "Out")]);
        let listed = block(list_scope(&runs, "r", &recs, &no_exclusions())).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].note_id, "a");
        assert_eq!(listed[0].title.as_deref(), Some("In"));
    }

    #[test]
    fn list_carries_no_body_only_a_title() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let listed = block(list_scope(
            &runs,
            "r",
            &records(&[("a", "T")]),
            &no_exclusions(),
        ))
        .unwrap();
        let json = serde_json::to_string(&listed).unwrap();
        assert!(json.contains("\"title\""));
        assert!(!json.contains("body"));
    }

    // Refusal, tested on its own for the read tool.
    #[test]
    fn read_refuses_a_note_outside_the_set_by_name() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let err = block(read_note(&runs, "r", "b", &StubReader, &no_exclusions())).unwrap_err();
        assert!(matches!(err, AgentError::OutOfScope { ref note_id } if note_id == "b"));
    }

    #[test]
    fn read_returns_the_body_for_a_note_in_the_set() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        assert_eq!(
            block(read_note(&runs, "r", "a", &StubReader, &no_exclusions())).unwrap(),
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
        // A REAL snapshot rather than an empty map. `record_excluded` fails
        // closed on an id the snapshot does not carry, and an empty map made it
        // answer "not excluded" for everything, which is what left the clamp
        // beside it unexercised (myne-md/myne#531 review round six).
        let out = block(search_scope(
            &runs,
            "r",
            "q",
            10,
            &searcher,
            &records(&[("a", "T"), ("b", "T"), ("c", "T")]),
            &no_exclusions(),
        ))
        .unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].note_id, "a");
    }

    /// **The SYNC-14 clamp on the SEARCH path, which had the clamp and no
    /// test.** All three `search_scope` tests passed `no_exclusions()` and two
    /// also passed an empty records map, so `record_excluded` returned false
    /// unconditionally in every one and deleting the clamp left the suite green
    /// (myne-md/myne#531 review round six). The sibling tools got their clamp
    /// tests in the same change this one was missed by.
    ///
    /// Worth its own test rather than folded into `search_drops_hits_outside_the_set`:
    /// that one drops a hit for being out of SCOPE, which is the run's frozen
    /// grant. This drops a hit that IS in scope and whose folder the user has
    /// since excluded, which is the newest-answer-decides rule and a different
    /// control. On the remote arm a surfaced hit carries a note id and its rank
    /// off device, so an unexercised clamp here is an untested TB13 bound.
    #[test]
    fn search_drops_a_hit_whose_folder_is_excluded_now() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a", "b"]));
        let mut recs = records(&[("a", "Kept"), ("b", "Gone")]);
        recs.get_mut("b").unwrap().folder = Some("Private".into());
        let searcher = StubSearcher(vec![hit("b", 0.9), hit("a", 0.5)]);
        let out = block(search_scope(
            &runs,
            "r",
            "q",
            10,
            &searcher,
            &recs,
            &StubExclusions(vec!["Private".into()]),
        ))
        .unwrap();
        assert_eq!(
            out.iter().map(|h| h.note_id.as_str()).collect::<Vec<_>>(),
            vec!["a"],
            "an excluded note must not be surfaced, not even as a ranked id"
        );
        // The reverse, so a clamp that dropped everything would fail too.
        let both = block(search_scope(
            &runs,
            "r",
            "q",
            10,
            &StubSearcher(vec![hit("b", 0.9), hit("a", 0.5)]),
            &recs,
            &no_exclusions(),
        ))
        .unwrap();
        assert_eq!(both.len(), 2, "with the set empty both are surfaced");
    }

    /// `record_excluded` fails CLOSED on a note the index snapshot does not
    /// carry, matching `resolve_grant` (`scope.rs`), which says of the identical
    /// input: "Unknown ids fail closed. A note id the index does not carry has
    /// no known folder, so the exclusion test cannot be applied to it."
    ///
    /// It used to fail OPEN here: `records.get(id)` missing yielded `""` through
    /// `unwrap_or_default()`, and `folder_key.rs` skips empty entries, so every
    /// exclusion set answered "not excluded". Two functions applied opposite
    /// defaults to the same input and only one argued for its choice
    /// (myne-md/myne#531 review round six).
    #[test]
    fn a_note_missing_from_the_index_snapshot_is_treated_as_excluded() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a", "ghost"]));
        // `ghost` is in the run's frozen scope and absent from the snapshot.
        let recs = records(&[("a", "Kept")]);
        let listed = block(list_scope(
            &runs,
            "r",
            &recs,
            &StubExclusions(vec!["Private".into()]),
        ))
        .unwrap();
        assert_eq!(
            listed
                .iter()
                .map(|e| e.note_id.as_str())
                .collect::<Vec<_>>(),
            vec!["a"],
            "a note whose folder cannot be determined must not be named to the model"
        );
        let found = block(search_scope(
            &runs,
            "r",
            "q",
            10,
            &StubSearcher(vec![hit("ghost", 0.9), hit("a", 0.5)]),
            &recs,
            &StubExclusions(vec!["Private".into()]),
        ))
        .unwrap();
        assert_eq!(
            found.iter().map(|h| h.note_id.as_str()).collect::<Vec<_>>(),
            vec!["a"],
            "and not surfaced by search either"
        );
    }

    #[test]
    fn search_honours_the_limit_after_clamping_not_before() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a", "b", "c"]));
        let searcher = StubSearcher(vec![hit("a", 0.9), hit("b", 0.8), hit("c", 0.7)]);
        let out = block(search_scope(
            &runs,
            "r",
            "q",
            2,
            &searcher,
            &records(&[("a", "T"), ("b", "T"), ("c", "T")]),
            &no_exclusions(),
        ))
        .unwrap();
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn every_tool_refuses_an_unknown_run_rather_than_defaulting_open() {
        let runs = AgentRunState::default();
        assert!(matches!(
            block(list_scope(
                &runs,
                "nope",
                &BTreeMap::new(),
                &no_exclusions()
            )),
            Err(AgentError::NoSuchRun)
        ));
        assert!(matches!(
            block(read_note(&runs, "nope", "a", &StubReader, &no_exclusions())),
            Err(AgentError::NoSuchRun)
        ));
        assert!(matches!(
            block(search_scope(
                &runs,
                "nope",
                "q",
                5,
                &StubSearcher(vec![]),
                &BTreeMap::new(),
                &no_exclusions(),
            )),
            Err(AgentError::NoSuchRun)
        ));
    }
}
