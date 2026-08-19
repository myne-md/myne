// SPDX-License-Identifier: AGPL-3.0
//! The agent loop.
//!
//! Named `run_loop` rather than `loop` because `loop` is a Rust keyword and
//! `pub mod loop;` does not parse.
//!
//! One iteration: build a role-structured request, ask the engine, parse the
//! actions, dispatch the tool calls, collect the proposed edits, repeat. It ends
//! when the model finishes, when it asks the user to widen the scope, when the
//! run is cancelled, or when it hits the iteration ceiling.
//!
//! **This loop never writes.** It produces a [`super::prompt::Proposal`] and
//! hands it back. Applying is [`super::apply`], behind the user's approval, and
//! the separation is the SYNC-17 restatement in code: the explicit user action
//! sits between these two modules.
//!
//! **The ceiling is a liveness stop, not a policy.** A model that loops forever
//! calling `list_scope` has to be stopped by something, and this is that
//! something. It is not a cap on scope growth and it is not a spend cap: both of
//! those were considered and declined (`docs/decisions/ai/` entry for
//! myne-md/myne#529). Do not repurpose it as one without reopening that.

use super::edit::ProposedEdit;
use super::engine::{AgentEngine, Content, Message, Role, AGENT_REQUEST_CLASS};
use super::error::AgentError;
use super::prompt::{build_request, parse_actions, AgentAction, Proposal, ProposedNote};
use super::run::AgentRunState;
use super::scope::ExclusionSource;
use super::tools::{list_scope, read_note, search_scope, NoteReader, ScopeSearcher};
use crate::plugins::vault_indices::state::NoteRecord;
use serde::Serialize;
use std::collections::BTreeMap;

/// How many model round-trips one run may make before it stops on its own.
///
/// A liveness backstop. See the module note on what it is not.
pub const MAX_ITERATIONS: usize = 24;

/// How many search hits one `search_scope` call returns to the model.
const SEARCH_LIMIT: usize = 10;

/// Why the loop stopped.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LoopEnd {
    /// The model said it was done.
    Finished,
    /// The model asked for a wider scope. The run is paused, not over: the user
    /// answers and the caller resumes with the same transcript.
    AwaitingScope {
        /// The folder it asked for.
        folder: String,
        /// Why it says it needs it, shown on the approval screen. Note content
        /// can steer this string, so the surface presents it as the model's
        /// claim rather than as a fact.
        reason: String,
    },
    /// The run was cancelled, by the user or by a vault lock.
    Cancelled,
    /// The iteration ceiling was reached.
    ExhaustedIterations,
}

/// What one loop invocation produced.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopOutcome {
    /// Everything proposed so far.
    pub proposal: Proposal,
    /// Why it stopped.
    pub end: LoopEnd,
    /// How many model round-trips it made. Feeds the post-run summary, which is
    /// the only place an uncapped remote run becomes visible to the user.
    pub iterations: usize,
    /// How many notes it read in full. Same purpose.
    pub notes_read: usize,
    /// Characters that left the device across every request this invocation
    /// made, or `None` when none of them did.
    ///
    /// Summed rather than per-request, because the figure the user needs is the
    /// total for the run. `None` and `Some(0)` stay distinguishable all the way
    /// to the surface for the reason
    /// [`AgentCompletion::chars_off_device`](super::engine::AgentCompletion::chars_off_device)
    /// gives: a local run transmitted nothing, and a remote run that somehow
    /// transmitted nothing is a different and more alarming statement.
    pub chars_off_device: Option<usize>,
}

/// Everything the loop needs from the host.
pub struct LoopDeps<'a> {
    pub engine: &'a dyn AgentEngine,
    pub reader: &'a dyn NoteReader,
    pub searcher: &'a dyn ScopeSearcher,
    /// An index snapshot, taken by the caller. Never re-read mid-loop: the list
    /// tool answering differently between two iterations of the same run would
    /// make the run's own view of its scope drift from the frozen set.
    pub records: &'a BTreeMap<String, NoteRecord>,
    /// The `ai_excluded_folders` set, asked for AGAIN by every read tool.
    ///
    /// The opposite property to `records` above, and deliberately so. The index
    /// is frozen because a scope that drifts mid-run is not the scope the user
    /// approved; the exclusion set is re-read because SYNC-14 carries no
    /// in-flight carve-out, so a folder the user excludes while a run is
    /// executing must stop being read at once. `apply.rs` re-reads it at the
    /// write boundary for exactly that reason, and until myne-md/myne#529's
    /// review the read half did not, which left a tightened control governing
    /// writes and not reads.
    pub exclusions: &'a dyn ExclusionSource,
}

/// Run the loop until it stops.
pub async fn drive(
    runs: &AgentRunState,
    run_id: &str,
    task: &str,
    transcript: &mut Vec<Message>,
    deps: &LoopDeps<'_>,
) -> Result<LoopOutcome, AgentError> {
    let mut proposal = Proposal::default();
    let mut iterations = 0usize;
    let mut notes_read = 0usize;
    // Stays `None` until some request reports that it went off-device, which is
    // what keeps "nothing was transmitted" and "a transmission carried nothing"
    // separable at the surface.
    let mut chars_off_device: Option<usize> = None;

    loop {
        if runs.is_cancelled(run_id)? {
            return Ok(LoopOutcome {
                proposal,
                end: LoopEnd::Cancelled,
                iterations,
                notes_read,
                chars_off_device,
            });
        }
        if iterations >= MAX_ITERATIONS {
            return Ok(LoopOutcome {
                proposal,
                end: LoopEnd::ExhaustedIterations,
                iterations,
                notes_read,
                chars_off_device,
            });
        }

        let request = build_request(task, transcript);
        // The class is the constant, passed here, in the loop's own code. It is
        // never read from a payload and never varies per iteration.
        let completion = deps.engine.complete(AGENT_REQUEST_CLASS, &request).await?;
        iterations += 1;
        if let Some(n) = completion.chars_off_device {
            chars_off_device = Some(chars_off_device.unwrap_or(0) + n);
        }
        let reply = completion.reply;
        // Parse before the reply moves into the transcript, so the reply is not
        // cloned just to be borrowed.
        let actions = parse_actions(&reply);
        // **The reply is note-derived, so it is tagged untrusted.** It was
        // `Content::Trusted`, which `engine.rs` defines as "written by the
        // host, tokenized normally" -- and an anchor is by definition text the
        // model copied VERBATIM out of a note, so a reply carries exactly the
        // content the tag exists to mark. Today both desktop arms sanitize
        // every non-system turn regardless, so nothing became a control token;
        // the tag is the contract a SECOND host implements against, and 0515
        // put this loop in core so mobile would inherit it.
        transcript.push(Message {
            role: Role::Assistant,
            content: vec![Content::note(reply)],
        });
        if actions.is_empty() {
            // Nothing usable came back. Say so in the transcript and let the
            // next iteration try, rather than failing the run on one bad reply.
            transcript.push(Message {
                role: Role::User,
                content: vec![Content::Trusted(
                    "No valid action found. Reply with one JSON action per line.".into(),
                )],
            });
            continue;
        }

        for action in actions {
            // Re-check between actions: a lock landing mid-iteration must not
            // let the rest of a parsed batch run.
            if runs.is_cancelled(run_id)? {
                return Ok(LoopOutcome {
                    proposal,
                    end: LoopEnd::Cancelled,
                    iterations,
                    notes_read,
                    chars_off_device,
                });
            }
            match action {
                AgentAction::ListScope => {
                    let entries = list_scope(runs, run_id, deps.records, deps.exclusions).await?;
                    let rendered = entries
                        .iter()
                        .map(|e| {
                            format!(
                                "{} {}",
                                e.note_id,
                                e.title.as_deref().unwrap_or("(untitled)")
                            )
                        })
                        .collect::<Vec<_>>()
                        .join("\n");
                    // Titles come out of note plaintext, so they are untrusted.
                    transcript.push(Message {
                        role: Role::User,
                        content: vec![Content::note(rendered)],
                    });
                }
                AgentAction::ReadNote { note_id } => {
                    match read_note(runs, run_id, &note_id, deps.reader, deps.exclusions).await {
                        Ok(body) => {
                            notes_read += 1;
                            transcript.push(Message {
                                role: Role::User,
                                content: vec![Content::note(body)],
                            });
                        }
                        Err(AgentError::OutOfScope { note_id }) => {
                            transcript.push(Message {
                                role: Role::User,
                                // Host prose, model-supplied id. Split rather
                                // than tagged wholesale, so the sentence keeps
                                // its trusted provenance and only the part the
                                // model chose is marked.
                                content: vec![
                                    Content::Trusted("Note ".into()),
                                    Content::note(note_id),
                                    Content::Trusted(
                                        " is outside the approved scope. \
                                         Use request_scope if you need it."
                                            .into(),
                                    ),
                                ],
                            });
                        }
                        Err(AgentError::ExcludedNow) => {
                            // Not a run-ending error, and not the same sentence
                            // as out-of-scope. The note IS in the approved
                            // scope; the user excluded its folder since, so the
                            // model must stop asking for it rather than be told
                            // to request a scope it already has. The refusal
                            // stays generic on purpose: naming the folder would
                            // put a folder the user just excluded into the
                            // transcript, which on the remote arm is the very
                            // thing the exclusion is for.
                            transcript.push(Message {
                                role: Role::User,
                                content: vec![
                                    Content::Trusted("Note ".into()),
                                    Content::note(note_id),
                                    Content::Trusted(
                                        " is no longer available to this run. \
                                         Continue with the others."
                                            .into(),
                                    ),
                                ],
                            });
                        }
                        Err(e) => return Err(e),
                    }
                }
                AgentAction::SearchScope { query } => {
                    let hits = search_scope(
                        runs,
                        run_id,
                        &query,
                        SEARCH_LIMIT,
                        deps.searcher,
                        deps.records,
                        deps.exclusions,
                    )
                    .await?;
                    let rendered = hits
                        .iter()
                        .map(|h| h.note_id.clone())
                        .collect::<Vec<_>>()
                        .join("\n");
                    transcript.push(Message {
                        role: Role::User,
                        content: vec![Content::Trusted(rendered)],
                    });
                }
                AgentAction::ProposeEdit {
                    note_id,
                    anchor,
                    replacement,
                } => {
                    // Scope is checked at proposal time as well as at apply
                    // time. Not redundant: catching it here means the model is
                    // told, and can correct itself, instead of the user seeing
                    // an edit that was always going to be refused.
                    if !runs.contains(run_id, &note_id)? {
                        transcript.push(Message {
                            role: Role::User,
                            // Same split as the read refusal above.
                            content: vec![
                                Content::Trusted("Note ".into()),
                                Content::note(note_id.clone()),
                                Content::Trusted(
                                    " is outside the approved scope; edit discarded.".into(),
                                ),
                            ],
                        });
                        continue;
                    }
                    proposal.edits.push(ProposedEdit {
                        note_id,
                        anchor,
                        replacement,
                    });
                }
                AgentAction::ProposeNote {
                    title,
                    body,
                    folder,
                } => {
                    proposal.new_notes.push(ProposedNote {
                        title,
                        body,
                        folder,
                    });
                }
                AgentAction::RequestScope { folder, reason } => {
                    return Ok(LoopOutcome {
                        proposal,
                        end: LoopEnd::AwaitingScope { folder, reason },
                        iterations,
                        notes_read,
                        chars_off_device,
                    });
                }
                AgentAction::Finish { summary } => {
                    proposal.summary = summary;
                    return Ok(LoopOutcome {
                        proposal,
                        end: LoopEnd::Finished,
                        iterations,
                        notes_read,
                        chars_off_device,
                    });
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::agent::engine::{AgentCompletion, AgentRequest, AgentRequestClass};
    use crate::plugins::agent::tools::SearchHit;
    use crate::test_support::block_on;
    use std::collections::BTreeSet;
    use std::sync::Mutex;

    fn ids(v: &[&str]) -> BTreeSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    /// Replies in order, and records the class it was asked with.
    struct ScriptEngine {
        replies: Mutex<Vec<String>>,
        seen_classes: Mutex<Vec<AgentRequestClass>>,
        /// When set, refuse a remote-class engine an ambient request, which is
        /// the seam contract the host implements for real.
        remote: bool,
    }

    impl ScriptEngine {
        fn new(replies: &[&str]) -> Self {
            Self {
                replies: Mutex::new(replies.iter().rev().map(|s| s.to_string()).collect()),
                seen_classes: Mutex::new(Vec::new()),
                remote: false,
            }
        }
        fn remote(replies: &[&str]) -> Self {
            let mut e = Self::new(replies);
            e.remote = true;
            e
        }
    }

    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl AgentEngine for ScriptEngine {
        async fn complete(
            &self,
            class: AgentRequestClass,
            r: &AgentRequest,
        ) -> Result<AgentCompletion, AgentError> {
            self.seen_classes.lock().unwrap().push(class);
            if self.remote && class == AgentRequestClass::Ambient {
                return Err(AgentError::Cancelled);
            }
            // Stands in for what the host does: count the text that would be
            // sent, and only when the arm that served the request was the
            // remote one. Counts the request's own spans rather than a rendered
            // prompt: the host counts `(system, messages)` after `chat_shape`,
            // and the flat renderer this used to call was removed as dead
            // (myne-md/myne#531 review round six).
            let chars_off_device = self.remote.then(|| {
                r.messages
                    .iter()
                    .flat_map(|m| m.content.iter())
                    .map(|span| span.text().chars().count())
                    .sum::<usize>()
            });
            Ok(AgentCompletion {
                reply: self.replies.lock().unwrap().pop().unwrap_or_else(|| {
                    r#"{"action":"finish","summary":"out of script"}"#.to_string()
                }),
                chars_off_device,
            })
        }
    }

    struct Reader;
    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl NoteReader for Reader {
        async fn read_body(&self, id: &str) -> Result<String, AgentError> {
            Ok(format!("body-{id}"))
        }
    }

    struct Searcher;
    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl ScopeSearcher for Searcher {
        async fn search(&self, _q: &str, _l: usize) -> Result<Vec<SearchHit>, AgentError> {
            Ok(vec![SearchHit {
                note_id: "a".into(),
                score: 1.0,
            }])
        }
    }

    fn records() -> BTreeMap<String, NoteRecord> {
        [(
            "a".to_string(),
            NoteRecord {
                title: Some("A".into()),
                ..Default::default()
            },
        )]
        .into_iter()
        .collect()
    }

    /// The exclusion seam for the loop tests, answering a fixed set.
    struct Excl(Vec<String>);

    #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
    #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
    impl ExclusionSource for Excl {
        async fn excluded_now(&self) -> Result<Vec<String>, AgentError> {
            Ok(self.0.clone())
        }
    }

    static NO_EXCL: std::sync::LazyLock<Excl> = std::sync::LazyLock::new(|| Excl(Vec::new()));

    fn deps<'a>(engine: &'a ScriptEngine, recs: &'a BTreeMap<String, NoteRecord>) -> LoopDeps<'a> {
        LoopDeps {
            engine,
            reader: &Reader,
            searcher: &Searcher,
            records: recs,
            exclusions: &*NO_EXCL,
        }
    }

    #[test]
    fn every_iteration_carries_the_user_initiated_class() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"list_scope"}"#,
            r#"{"action":"read_note","note_id":"a"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let recs = records();
        let mut transcript = Vec::new();
        let out = block_on(drive(
            &runs,
            "r",
            "task",
            &mut transcript,
            &deps(&engine, &recs),
        ))
        .unwrap();
        assert_eq!(out.end, LoopEnd::Finished);
        let classes = engine.seen_classes.lock().unwrap().clone();
        assert_eq!(classes.len(), 3);
        assert!(
            classes
                .iter()
                .all(|c| *c == AgentRequestClass::UserInitiated),
            "the class is a constant in the loop, not a per-call parameter"
        );
    }

    // The seam contract, from core's side: a remote backend refuses an ambient
    // request. The host's real registry mapping is tested on the host.
    #[test]
    fn a_remote_backend_refuses_an_ambient_request() {
        let engine = ScriptEngine::remote(&[]);
        let r = block_on(engine.complete(
            AgentRequestClass::Ambient,
            &AgentRequest { messages: vec![] },
        ));
        assert!(r.is_err());
        let ok = block_on(engine.complete(
            AgentRequestClass::UserInitiated,
            &AgentRequest { messages: vec![] },
        ));
        assert!(ok.is_ok());
    }

    #[test]
    fn the_loop_collects_edits_and_never_writes() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"propose_edit","note_id":"a","anchor":"x","replacement":"y"}"#,
            r#"{"action":"finish","summary":"done"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        let out = block_on(drive(&runs, "r", "task", &mut t, &deps(&engine, &recs))).unwrap();
        assert_eq!(out.proposal.edits.len(), 1);
        assert_eq!(out.proposal.summary, "done");
    }

    #[test]
    fn an_edit_proposed_outside_scope_is_discarded_and_the_model_is_told() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"propose_edit","note_id":"zzz","anchor":"x","replacement":"y"}"#,
            r#"{"action":"finish","summary":"done"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        let out = block_on(drive(&runs, "r", "task", &mut t, &deps(&engine, &recs))).unwrap();
        assert!(out.proposal.edits.is_empty());
    }

    #[test]
    fn a_scope_request_pauses_the_run_rather_than_widening_it() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"request_scope","folder":"Archive","reason":"need it"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        let out = block_on(drive(&runs, "r", "task", &mut t, &deps(&engine, &recs))).unwrap();
        assert_eq!(
            out.end,
            LoopEnd::AwaitingScope {
                folder: "Archive".into(),
                reason: "need it".into()
            }
        );
        // And the scope did not move.
        assert_eq!(runs.view("r").unwrap().scope_total, 1);
    }

    #[test]
    fn cancellation_stops_the_loop_and_reports_it() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        runs.cancel("r");
        let engine = ScriptEngine::new(&[r#"{"action":"finish","summary":"never"}"#]);
        let recs = records();
        let mut t = Vec::new();
        let out = block_on(drive(&runs, "r", "task", &mut t, &deps(&engine, &recs))).unwrap();
        assert_eq!(out.end, LoopEnd::Cancelled);
        assert_eq!(out.iterations, 0, "cancelled before any model call");
    }

    #[test]
    fn note_bodies_enter_the_transcript_tagged_untrusted() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"read_note","note_id":"a"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        block_on(drive(&runs, "r", "task", &mut t, &deps(&engine, &recs))).unwrap();
        assert!(
            t.iter().any(|m| m.content.iter().any(|c| matches!(
                c,
                Content::UntrustedNote(s) if s.contains("body-a")
            ))),
            "the note body is tagged so the host can tokenize it without special tokens"
        );
    }

    #[test]
    fn a_reply_with_no_usable_action_does_not_fail_the_run() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            "I am not going to do that",
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        let out = block_on(drive(&runs, "r", "task", &mut t, &deps(&engine, &recs))).unwrap();
        assert_eq!(out.end, LoopEnd::Finished);
        assert_eq!(out.iterations, 2);
    }

    #[test]
    fn the_iteration_ceiling_stops_a_model_that_never_finishes() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        // The script runs out and the stub then always replies list_scope-free
        // "finish"; use a reply that never finishes instead.
        let engine = ScriptEngine {
            replies: Mutex::new(vec![]),
            seen_classes: Mutex::new(Vec::new()),
            remote: false,
        };
        // Empty script means the stub's fallback "finish" fires, so drive a
        // never-finishing engine explicitly.
        struct Forever;
        #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
        #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
        impl AgentEngine for Forever {
            async fn complete(
                &self,
                _c: AgentRequestClass,
                _r: &AgentRequest,
            ) -> Result<AgentCompletion, AgentError> {
                Ok(AgentCompletion {
                    reply: r#"{"action":"list_scope"}"#.to_string(),
                    chars_off_device: None,
                })
            }
        }
        let recs = records();
        let d = LoopDeps {
            exclusions: &*NO_EXCL,
            engine: &Forever,
            reader: &Reader,
            searcher: &Searcher,
            records: &recs,
        };
        let mut t = Vec::new();
        let out = block_on(drive(&runs, "r", "task", &mut t, &d)).unwrap();
        assert_eq!(out.end, LoopEnd::ExhaustedIterations);
        assert_eq!(out.iterations, MAX_ITERATIONS);
        drop(engine);
    }

    #[test]
    fn the_run_reports_what_it_actually_did_for_the_post_run_summary() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            r#"{"action":"read_note","note_id":"a"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        let out = block_on(drive(&runs, "r", "task", &mut t, &deps(&engine, &recs))).unwrap();
        assert_eq!(out.notes_read, 1);
        assert_eq!(out.iterations, 2);
        // A local run transmitted nothing, and the summary must be able to say
        // that rather than reporting a zero it cannot distinguish from a remote
        // request that carried nothing.
        assert_eq!(out.chars_off_device, None);
    }

    #[test]
    fn a_remote_run_reports_how_much_text_left_the_device_summed_over_its_requests() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::remote(&[
            r#"{"action":"read_note","note_id":"a"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        let out = block_on(drive(&runs, "r", "task", &mut t, &deps(&engine, &recs))).unwrap();
        assert_eq!(out.iterations, 2);
        let total = out
            .chars_off_device
            .expect("a remote run must report a figure, not None");

        // The figure has to be the SUM across requests rather than the last
        // one, and the second request is strictly larger than the first because
        // the note it read is now in the transcript. Asserting the sum exceeds
        // the largest single request is what separates the two, without pinning
        // a prompt-scaffold character count that any wording change would break.
        let mut t2 = Vec::new();
        let single = ScriptEngine::remote(&[r#"{"action":"finish","summary":"ok"}"#]);
        let runs2 = AgentRunState::default();
        runs2.start("r".into(), ids(&["a"]));
        let one = block_on(drive(&runs2, "r", "task", &mut t2, &deps(&single, &recs))).unwrap();
        assert_eq!(one.iterations, 1);
        assert!(
            total > one.chars_off_device.unwrap(),
            "a two-request run must report more than a one-request run: {total} vs {:?}",
            one.chars_off_device
        );
    }

    #[test]
    fn the_offdevice_figure_counts_the_note_body_that_was_actually_sent() {
        // The point of the disclosure is that it tracks vault text, so a run
        // that reads a note must report more than one that does not. A counter
        // measuring only the scaffold would pass every assertion above and fail
        // this one.
        let recs = records();
        let mut with_read = Vec::new();
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let read_engine = ScriptEngine::remote(&[
            r#"{"action":"read_note","note_id":"a"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let read = block_on(drive(
            &runs,
            "r",
            "task",
            &mut with_read,
            &deps(&read_engine, &recs),
        ))
        .unwrap();

        let mut without = Vec::new();
        let runs2 = AgentRunState::default();
        runs2.start("r".into(), ids(&["a"]));
        let list_engine = ScriptEngine::remote(&[
            r#"{"action":"list_scope"}"#,
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let listed = block_on(drive(
            &runs2,
            "r",
            "task",
            &mut without,
            &deps(&list_engine, &recs),
        ))
        .unwrap();

        assert_eq!(read.iterations, listed.iterations, "same request count");
        assert!(
            read.chars_off_device.unwrap() > listed.chars_off_device.unwrap(),
            "reading a note has to move the figure: {:?} vs {:?}",
            read.chars_off_device,
            listed.chars_off_device
        );
    }
}
