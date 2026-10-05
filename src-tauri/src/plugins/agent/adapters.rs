// SPDX-License-Identifier: AGPL-3.0
//! The desktop side of the agent seams.
//!
//! `myne-core`'s agent plugin is engine-free by design: it depends on narrow
//! traits and this module implements them out of the desktop's existing parts.
//! Nothing here holds policy. Scope, the excluded-folder clamp and the request
//! class all live in core, and an adapter that started making one of those
//! decisions would be the second place it lives.
//!
//! Two of these are doing something worth naming.
//!
//! [`EngineAdapter`] hands core's role-structured request to the engine's
//! **role-structured** surface, `chat_streaming_cancellable`, through
//! [`chat_shape`]. It does not flatten, and the earlier version of this comment
//! described a version that did.
//!
//! That flattening is worth recording because nothing caught it. The adapter
//! called `render_chatml` and passed the resulting string to `Engine::infer`;
//! both arms then ran `sanitize_chatml` over that whole string, stripping the
//! scaffold `render_chatml` had just emitted, and the candle arm re-framed the
//! remains under a system prompt of "You are a helpful assistant." So the
//! agent's own instruction sat inside the user turn beside the note text it was
//! meant to outrank, and per-span tokenization with special-token parsing
//! disabled was unreachable because the engine had a finished string. The
//! module doc, `core`'s engine module doc and `threat-model.md` §7 all asserted
//! the opposite.
//!
//! What the role surface reaches, per arm: `build_chatml_tokens` on the candle
//! arm encodes the scaffold as special tokens and every untrusted turn with
//! special parsing OFF (the **structural** half), and the Ollama arm posts
//! `/api/chat` with a real `messages` array and its own system role. On a
//! **remote provider** the far side tokenizes and Myne cannot disable special
//! parsing there, so the role-structured body plus the string filter is what
//! remains and the guarantee degrades from structural to behavioural
//! (`decisions/ai/0461`, `threat-model.md` §7). That degradation is a property
//! of the boundary, not of this module skipping a step.
//!
//! [`RestoreAdapter`] forces the capture. An agent run's restore point may not
//! be coalesced away by the snapshot window, because the interface has told the
//! user the whole run can be undone.

use myne_core::plugins::agent::error::AgentError;
use myne_core::plugins::agent::tools::{ScopeSearcher, SearchHit};
use std::collections::BTreeMap;

// The engine adapter moved to `myne-core` (myne-md/myne#456), with the four
// pure helpers it is built from. Re-exported here so every `adapters::…` path
// in this tree, and the tests below, keep resolving: and so a reader who comes
// looking for `EngineAdapter` in the file its callers name finds a pointer
// rather than nothing.
//
// It moved because it is the piece where a per-client copy would cost the most:
// it decides which backend answers, whether the request leaves the device, how
// much of the user's writing goes with it, and how the prompt is framed. What
// stayed here is the host-coupled half, which has nothing shared to extract.
//
// `chat_shape`, `host_class` and `note_chars` are re-exported without an
// in-crate reader today: `commands.rs` names `EngineAdapter` and the probe test
// below names `chat_shape`. They are kept rather than trimmed to the two
// currently used because callers in this tree have historically reached for all
// five together, and a re-export list that tracks today's call sites is a list
// that churns. `allow(unused_imports)` says so out loud instead of letting the
// warning be silenced by a wildcard.
#[allow(unused_imports)]
pub use myne_core::inference::agent_adapter::{
    agent_error_of, chat_shape, host_class, note_chars, EngineAdapter,
};
// The three Tauri-host adapters moved with it, for the same reason: both
// clients build them out of the same `TauriHost` + `VaultRuntimeState` + notes
// cores, so a second copy would have differed only in which crate it sat in.
//
// `SearchAdapter` stayed, and that is the interesting half of the split: it
// queries the embedding index, and mobile has no vector store to query. Each
// client implements `ScopeSearcher` for itself.
#[allow(unused_imports)]
pub use myne_core::plugins::agent::host_adapters::{NoteReadAdapter, RestoreAdapter, WriteAdapter};

use crate::plugins::local_inference::retrieval;
use crate::plugins::local_inference::state::LocalInferenceState;
use crate::plugins::local_inference::vector_store::LocalInferenceVectorState;

/// Search, through the existing embedding index.
///
/// Scope filtering is NOT done here; core does it. What is done here is the
/// store's own `ai_excluded_folders` filter, a second and independent control on
/// a different axis, which stays exactly where it already was.
pub struct SearchAdapter<'a> {
    pub state: &'a LocalInferenceState,
    pub vectors: &'a LocalInferenceVectorState,
}

#[async_trait::async_trait]
impl ScopeSearcher for SearchAdapter<'_> {
    async fn search(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>, AgentError> {
        // The strict embedding accessor, which never hands back a remote backend
        // (SYNC-16). The index stays on the device even when generation does not.
        let engine = self.state.embedding_engine().map_err(agent_error_of)?;
        let owned = zeroize::Zeroizing::new(query.to_string());
        let vector = tokio::task::spawn_blocking(move || engine.embed_query(&owned))
            .await
            .map_err(|_| AgentError::ReadFailed)?
            .map_err(agent_error_of)?;
        let hits = {
            let store = self.vectors.lock();
            if !store.is_enabled() {
                return Ok(Vec::new());
            }
            retrieval::top_k_matches(&vector, &store, limit, |id| store.is_note_excluded(id))
        };
        // Collapse chunk hits to one row per note, keeping the best score: the
        // agent reads whole notes, so N chunks of one note are one candidate.
        let mut best: BTreeMap<String, f32> = BTreeMap::new();
        for hit in hits {
            let note_id = hit.key.note_id.to_string();
            let entry = best.entry(note_id).or_insert(hit.score);
            if hit.score > *entry {
                *entry = hit.score;
            }
        }
        let mut out: Vec<SearchHit> = best
            .into_iter()
            .map(|(note_id, score)| SearchHit { note_id, score })
            .collect();
        out.sort_by(|a, b| b.score.total_cmp(&a.score));
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ops::ControlFlow;

    /// The stub must PASS the capability probe, driven through the real
    /// `run_probe` and the real grader.
    ///
    /// **This test lives here rather than beside `StubEngine`**, which moved to
    /// `myne-core` with the inference seam (myne-md/myne#456). Its whole value is
    /// that the stub is exercised through the REAL [`chat_shape`] this adapter
    /// ships: a second mapping written next to the engine would let it pass
    /// while the shipped one was wrong, which is the shape this suite exists to
    /// catch. `chat_shape` is what stayed, so the test followed it.
    ///
    /// This is the test the composer's gate made necessary and its absence made
    /// expensive: wiring `agentCapability()` into the composer (which is what
    /// makes the anchored format's right to refuse a near-miss mean anything)
    /// disabled Send until the probe passes, and the stub answered the probe
    /// with `list_scope` because `probe_request` carries the same system
    /// instructions a run does. Every agent E2E scenario went red on a button
    /// that never enabled, one container build later.
    ///
    /// Asserted through `run_probe` rather than by inspecting the reply, because
    /// the reply being well-formed is not the claim. The claim is that the
    /// grader accepts it.
    #[test]
    fn the_stub_passes_the_capability_probe_it_is_asked() {
        use myne_core::plugins::agent::engine::{
            AgentCompletion, AgentEngine, AgentRequest, AgentRequestClass,
        };
        use myne_core::plugins::agent::error::AgentError;
        use myne_core::plugins::agent::probe::{run_probe, AttemptVerdict, ProbeThreshold};
        // `StubEngine` and the `Engine` trait its `chat_streaming` comes from
        // both live in `myne-core` since the inference seam moved
        // (myne-md/myne#456); this module reaches them through the desktop
        // plugin's re-export in every other place, but the test names them
        // directly so the import is explicit about what it is exercising.
        use myne_core::inference::{Engine, StubEngine};

        /// The stub behind the agent seam, mapped by the REAL `chat_shape` the
        /// desktop adapter uses. A second mapping written here would let this
        /// test pass while the shipped one was wrong, which is the whole shape
        /// this suite exists to catch.
        struct StubBehindTheSeam;
        #[async_trait::async_trait]
        impl AgentEngine for StubBehindTheSeam {
            async fn complete(
                &self,
                _class: AgentRequestClass,
                request: &AgentRequest,
            ) -> Result<AgentCompletion, AgentError> {
                let (system, messages) = chat_shape(request, &|s: &str| s.to_string());
                let mut sink = |_: &str| ControlFlow::Continue(());
                let reply = StubEngine
                    .chat_streaming(&system, &messages, &mut sink)
                    .map_err(|_| AgentError::ReadFailed)?;
                Ok(AgentCompletion {
                    // `false`, and it is a claim rather than a placeholder: this
                    // stub imposes no ceiling, so nothing here can cut a reply
                    // off. The field arrived with myne-md/myne#617.
                    truncated: false,
                    reply,
                    chars_off_device: None,
                })
            }
        }

        let verdict = myne_core::test_support::block_on(run_probe(
            &StubBehindTheSeam,
            ProbeThreshold {
                attempts: 3,
                required: 2,
                provisional: false,
            },
            // This test is about the stub clearing the bar, not about progress.
            &|_| {},
        ))
        .expect("the probe runs");
        assert!(
            verdict.passed,
            "the stub must be a backend Myne would offer agent mode on: {verdict:?}"
        );
        // **Every attempt that RAN was clean**, which is what this was always
        // about; it used to say `passes == 3` and the number was a coincidence
        // of the probe running every attempt regardless. Since the early exit
        // (myne-md/myne#575) the bar of 2 settles it at 2, so asserting 3 would
        // be asserting that the saving does not happen.
        assert!(
            verdict
                .attempts
                .iter()
                .all(|a| *a == AttemptVerdict::Passed),
            "the stub must not miss a single attempt it was asked: {verdict:?}"
        );
        assert_eq!(verdict.passes as usize, verdict.attempts.len());
    }
}
