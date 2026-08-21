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
//! those were considered and declined (`design-notes/ai/` entry for
//! myne-md/myne#529). Do not repurpose it as one without reopening that.

use super::edit::ProposedEdit;
use super::engine::{AgentEngine, Content, Message, Role, AGENT_REQUEST_CLASS};
use super::error::AgentError;
use super::prompt::{
    build_request, parse_actions, reply_shape, AgentAction, Proposal, ProposedNote,
};
use super::run::AgentRunState;
use super::scope::ExclusionSource;
use super::tools::{list_scope, read_note, search_scope, NoteReader, ScopeSearcher};
use crate::plugins::vault_indices::state::NoteRecord;
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

/// How many model round-trips one run may make before it stops on its own.
///
/// A liveness backstop. See the module note on what it is not.
pub const MAX_ITERATIONS: usize = 24;

/// How many **barren** iterations in a row end the run.
///
/// A barren iteration is one that moved nothing: the reply parsed into no
/// action at all, or into nothing but tool calls this run has already made. See
/// [`LoopEnd::Stalled`] for why that is worth its own stop.
///
/// Three rather than one, because a single barren turn is a normal recovery:
/// the loop tells the model its reply was unusable and the next turn is often
/// fine. Three in a row is a model that cannot hold the format, and the run has
/// then made three requests it will not use.
///
/// The same liveness-not-policy note as [`MAX_ITERATIONS`] applies: this bounds
/// wasted work, it is not a cap on scope and it is not a spend cap.
pub const MAX_BARREN_ITERATIONS: usize = 3;

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
    /// The model stopped making progress: [`MAX_BARREN_ITERATIONS`] replies in
    /// a row produced no action, or only tool calls the run had already made.
    ///
    /// **Distinct from [`LoopEnd::ExhaustedIterations`], and the difference is
    /// what the user does next.** Exhausting the ceiling means the run was
    /// working and ran out of room, so widening the scope or asking for less is
    /// the answer. Stalling means the backend cannot hold the anchored format
    /// at all, so a different model is. Reaching the ceiling by 24 barren turns
    /// reported the first sentence for the second situation, and each of those
    /// turns is a request that was paid for, sent, and thrown away.
    Stalled {
        /// How many barren iterations in a row ended it. Surfaced so the
        /// sentence can say what happened rather than only that it happened.
        /// A count, never any part of a reply: the model's text is
        /// note-derived and has no place in a status value.
        #[serde(rename = "barrenIterations")]
        barren_iterations: usize,
    },
}

impl LoopEnd {
    /// The end's name, as a compile-time string.
    ///
    /// For logging. `AwaitingScope` carries a folder name and a model-written
    /// reason, both of which come out of note content, so a `Debug` format of
    /// this value has no place in a log line.
    pub fn tag(&self) -> &'static str {
        match self {
            Self::Finished => "finished",
            Self::AwaitingScope { .. } => "awaiting_scope",
            Self::Cancelled => "cancelled",
            Self::ExhaustedIterations => "exhausted_iterations",
            Self::Stalled { .. } => "stalled",
        }
    }
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
///
/// A thin wrapper over [`drive_inner`] whose only job is to report the outcome
/// once, wherever the loop left from. There are six exits and a log line at
/// each would be six chances to add a seventh without one (myne-md/myne#546).
pub async fn drive(
    runs: &AgentRunState,
    run_id: &str,
    task: &str,
    transcript: &mut Vec<Message>,
    deps: &LoopDeps<'_>,
) -> Result<LoopOutcome, AgentError> {
    // Target note, once for this module: `myne_core::agent`, not the `myne::…`
    // product target the desktop crate uses for `myne::ai`. `tracing-test`
    // filters its capture on the crate name, so a `myne::…` target here would be
    // invisible to the tests that assert these lines carry no note content —
    // and an untested DENY-list claim is the kind this repo does not make.
    // `RUST_LOG=myne_core=debug` turns them on.
    let outcome = drive_inner(runs, run_id, task, transcript, deps).await;
    match &outcome {
        Ok(o) => tracing::debug!(
            target: "myne_core::agent",
            event = "run_stopped",
            end = o.end.tag(),
            iterations = o.iterations,
            notes_read = o.notes_read,
            edits = o.proposal.edits.len(),
            new_notes = o.proposal.new_notes.len(),
        ),
        // `kind()`, never the error itself: two variants carry a `note_id`.
        Err(e) => tracing::debug!(
            target: "myne_core::agent",
            event = "run_failed",
            error_kind = e.kind(),
        ),
    }
    outcome
}

async fn drive_inner(
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
    // **What this run has already asked for**, one signature per tool call, so
    // a repeat can be told from a first ask. A model looping on `list_scope`
    // learns nothing new on the second call and the loop has no way to notice
    // that from the reply alone; the signature is how it notices.
    //
    // Signatures, not results: two `search_scope` calls with the same query are
    // the same ask whatever they return, and holding the results would mean
    // keeping note-derived text alive for the length of the run to answer a
    // liveness question.
    let mut asked: BTreeSet<String> = BTreeSet::new();
    // Barren iterations SINCE THE LAST PRODUCTIVE ONE. Reset rather than
    // cumulative: a run that recovers has not stalled, and counting every
    // barren turn of a long healthy run would end it for being slow.
    let mut barren = 0usize;

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
        // **What the reply looked like, in counts** (myne-md/myne#546). The
        // failure this exists for is a model whose replies parse into nothing:
        // from the outside that is indistinguishable from a slow backend, and
        // identifying it once cost a code read. `objects` against `actions`
        // separates "it wrote no JSON" from "it wrote JSON we do not accept".
        //
        // Counts only. `reply_shape`'s own note says why the unknown verb's
        // name is not among them.
        let shape = reply_shape(&reply);
        // The verbs belong on THIS line rather than on the iteration line
        // below, and the reason is a defect the first version had: the dispatch
        // loop RETURNS on `finish` and on `request_scope`, so a line written
        // after it never runs for the turn that ended the run — the one turn a
        // reader most wants named. `verb()` is a compile-time string per
        // variant, so this cannot carry a note id, an anchor or a replacement.
        let verb_list = actions
            .iter()
            .map(AgentAction::verb)
            .collect::<Vec<_>>()
            .join(",");
        tracing::debug!(
            target: "myne_core::agent",
            event = "reply",
            iteration = iterations,
            lines = shape.lines,
            brace_lines = shape.brace_lines,
            objects = shape.objects,
            actions = shape.actions,
            unknown_verbs = shape.unknown_verbs,
            verbs = verb_list.as_str(),
        );
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
            //
            // **No `continue` here.** The barren check at the bottom of the
            // iteration is what ends a run whose model cannot hold the format,
            // and skipping to the next turn skipped it: an empty parse is the
            // most barren turn there is, and it was the one turn that never
            // reached the counter. `actions` is empty, so the loop below runs
            // zero times and the fall-through costs nothing.
            transcript.push(Message {
                role: Role::User,
                content: vec![Content::Trusted(
                    "No valid action found. Reply with one JSON action per line.".into(),
                )],
            });
        }

        // Whether this iteration moved anything: a tool call this run had not
        // made before, or something added to the proposal. Set inside the loop
        // below and read at the bottom of the iteration.
        let mut productive = false;

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
                    productive |= asked.insert("list_scope".to_string());
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
                    // The signature covers the refusal arms too: a note outside
                    // the scope answers the same sentence every time, so asking
                    // twice is as barren as reading the same note twice.
                    productive |= asked.insert(format!("read_note:{note_id}"));
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
                    productive |= asked.insert(format!("search_scope:{query}"));
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
                        // Refusing the same out-of-scope note again teaches the
                        // model nothing it was not already told, so only the
                        // first refusal counts as movement.
                        productive |= asked.insert(format!("propose_edit_refused:{note_id}"));
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
                    // Something reached the proposal, which is the run's whole
                    // output. Unconditionally productive: an edit the user will
                    // see on the review screen is progress even if the model
                    // then repeats itself, and the review screen is where a
                    // duplicate is judged, not here.
                    productive = true;
                    proposal.edits.push(ProposedEdit {
                        note_id,
                        anchor,
                        replacement,
                    });
                    // **The model is told, and this is not politeness**
                    // (myne-md/myne#547). Every other action answers: the
                    // listing, the body, a refusal sentence. These two used to
                    // answer with silence, which cost two separate things.
                    //
                    // The model had no way to tell "recorded, keep going" from
                    // "ignored", which is the difference between proposing the
                    // next edit and repeating the last one.
                    //
                    // And the transcript ENDED on an assistant turn, so that is
                    // how the next request went out. A provider may reject that
                    // shape outright: Anthropic accepts a trailing assistant
                    // turn but not one ending in whitespace, and a model's JSON
                    // reply ends with a newline. The run this was found on got
                    // HTTP 400 on the turn after a good edit and threw the
                    // proposal away, reporting it as a failure to read a note.
                    transcript.push(Message {
                        role: Role::User,
                        content: vec![Content::Trusted(
                            "Edit recorded. Propose another, or finish.".into(),
                        )],
                    });
                }
                AgentAction::ProposeNote {
                    title,
                    body,
                    folder,
                } => {
                    // Same as the edit arm above: it reached the proposal, and
                    // the same acknowledgement for the same two reasons.
                    productive = true;
                    proposal.new_notes.push(ProposedNote {
                        title,
                        body,
                        folder,
                    });
                    transcript.push(Message {
                        role: Role::User,
                        content: vec![Content::Trusted(
                            "New note recorded. Propose another, or finish.".into(),
                        )],
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

        // **The barren check, at the bottom of every iteration.** A run that
        // moved nothing this turn has one more strike; a run that moved
        // something has none. Both halves matter: without the reset a long
        // healthy run would end for having had three scattered bad turns, and
        // without the increment the only stop left is the 24-iteration ceiling,
        // which is 24 provider requests spent on a model that answered the
        // first three unusably.
        tracing::debug!(
            target: "myne_core::agent",
            event = "iteration",
            iteration = iterations,
            productive,
            barren_streak = if productive { 0 } else { barren + 1 },
            notes_read,
            edits = proposal.edits.len(),
        );

        if productive {
            barren = 0;
        } else {
            barren += 1;
            if barren >= MAX_BARREN_ITERATIONS {
                return Ok(LoopOutcome {
                    proposal,
                    end: LoopEnd::Stalled {
                        barren_iterations: barren,
                    },
                    iterations,
                    notes_read,
                    chars_off_device,
                });
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
    fn an_accepted_proposal_answers_the_model_so_the_turn_does_not_end_on_it() {
        // myne-md/myne#547. Two properties in one, and the second is the one
        // that cost a run: the model is told its edit landed, AND the request
        // that goes out next does not end on an assistant turn. A provider may
        // reject that shape (Anthropic rejects a trailing assistant turn ending
        // in whitespace, and a JSON reply ends with a newline), which is how a
        // good proposal was thrown away under an error blaming the note store.
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

        // The turn after the accepted edit is the model's own reply, then the
        // acknowledgement. Assert the SHAPE the provider sees rather than the
        // sentence: what matters is that a user turn follows the assistant one.
        let after_edit = t
            .iter()
            .position(|m| {
                m.role == Role::Assistant
                    && m.content.iter().any(|c| c.text().contains("propose_edit"))
            })
            .expect("the model's proposing reply is in the transcript");
        assert_eq!(
            t[after_edit + 1].role,
            Role::User,
            "an accepted edit must be answered, or the request ends on an assistant turn"
        );
        // Host prose, so it is trusted content: it is not note-derived and must
        // not be tagged as though it were.
        assert!(matches!(t[after_edit + 1].content[0], Content::Trusted(_)));
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
        //
        // **Each turn asks something NEW**, and that is the point of the test
        // rather than a detail of it: a model repeating one tool call now stops
        // on `LoopEnd::Stalled` three turns in, so a `list_scope` on every turn
        // would no longer reach the ceiling and this test would silently be
        // testing the stall instead. A fresh query per turn is a run that is
        // genuinely working and genuinely never finishing, which is the only
        // shape the ceiling exists for.
        struct Forever {
            turn: Mutex<usize>,
        }
        #[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
        #[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
        impl AgentEngine for Forever {
            async fn complete(
                &self,
                _c: AgentRequestClass,
                _r: &AgentRequest,
            ) -> Result<AgentCompletion, AgentError> {
                let mut turn = self.turn.lock().unwrap();
                *turn += 1;
                Ok(AgentCompletion {
                    reply: format!(r#"{{"action":"search_scope","query":"q{turn}"}}"#),
                    chars_off_device: None,
                })
            }
        }
        let recs = records();
        let forever = Forever {
            turn: Mutex::new(0),
        };
        let d = LoopDeps {
            exclusions: &*NO_EXCL,
            engine: &forever,
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

    // ---- the diagnostic trail (myne-md/myne#546) ------------------------

    #[test]
    #[tracing_test::traced_test]
    fn a_run_leaves_a_trail_naming_the_shape_of_what_came_back() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        // Prose, then a finish. The prose turn is the one the trail has to
        // describe: it is the failure that cost a code read to identify, and
        // from outside the process it looks exactly like a slow backend.
        let engine = ScriptEngine::new(&[
            "I will not be doing that",
            r#"{"action":"finish","summary":"ok"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        block_on(drive(&runs, "r", "task", &mut t, &deps(&engine, &recs))).unwrap();

        // The reply that parsed into nothing says so in counts.
        assert!(logs_contain("event=\"reply\""));
        assert!(
            logs_contain("objects=0 actions=0"),
            "a reply with no JSON in it must be visible as such"
        );
        // …and the reply that did parse is distinguishable from it.
        assert!(logs_contain("objects=1 actions=1"));
        // The reply line names the verb vocabulary, not the values — including
        // for the turn that ENDED the run, which is the turn a line written
        // after the dispatch loop would have missed.
        assert!(logs_contain("verbs=\"finish\""));
        // And the run says how it ended, once.
        assert!(logs_contain("event=\"run_stopped\" end=\"finished\""));
    }

    #[test]
    #[tracing_test::traced_test]
    fn the_trail_carries_no_part_of_the_reply_or_the_note() {
        // **The DENY-list assertion, injected rather than reasoned about.**
        // Every marker below is a string the run genuinely handles: the model's
        // prose, an anchor and a replacement it copied out of a note, a note
        // id, and the task the user typed. None may reach a log line. A verb
        // the vocabulary does not know is here too, because its name is the one
        // field of `ReplyShape` that is deliberately a count rather than a
        // string — a model can be steered into putting note text there.
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&[
            "PROSEMARKER the model wrote this",
            r#"{"action":"incinerate_note","note_id":"VERBMARKER"}"#,
            r#"{"action":"propose_edit","note_id":"a","anchor":"ANCHORMARKER","replacement":"REPLACEMENTMARKER"}"#,
            r#"{"action":"finish","summary":"SUMMARYMARKER"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        block_on(drive(
            &runs,
            "r",
            "TASKMARKER",
            &mut t,
            &deps(&engine, &recs),
        ))
        .unwrap();

        for marker in [
            "PROSEMARKER",
            "VERBMARKER",
            "incinerate_note",
            "ANCHORMARKER",
            "REPLACEMENTMARKER",
            "SUMMARYMARKER",
            "TASKMARKER",
        ] {
            assert!(
                !logs_contain(marker),
                "{marker} reached a log line (DENY-list violation)"
            );
        }
        // The unknown verb is COUNTED, which is the whole point of not naming
        // it: the diagnostic survives without the string.
        assert!(logs_contain("unknown_verbs=1"));
    }

    #[test]
    #[tracing_test::traced_test]
    fn a_stalled_run_says_so_in_the_trail() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        let engine = ScriptEngine::new(&["no", "still no", "nor now"]);
        let recs = records();
        let mut t = Vec::new();
        block_on(drive(&runs, "r", "task", &mut t, &deps(&engine, &recs))).unwrap();
        assert!(logs_contain("event=\"run_stopped\" end=\"stalled\""));
        assert!(logs_contain("barren_streak=3"));
    }

    #[test]
    fn three_barren_replies_in_a_row_stall_the_run() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        // Prose, three times. Each one parses into nothing, so each one is as
        // barren as an iteration gets. The fourth reply would finish the run,
        // and the assertion that it never ran is the whole point: the stop has
        // to fire before it.
        let engine = ScriptEngine::new(&[
            "I am not going to do that",
            "Still not doing it",
            "Nor now",
            r#"{"action":"finish","summary":"never reached"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        let out = block_on(drive(&runs, "r", "task", &mut t, &deps(&engine, &recs))).unwrap();
        assert_eq!(
            out.end,
            LoopEnd::Stalled {
                barren_iterations: MAX_BARREN_ITERATIONS
            }
        );
        assert_eq!(
            out.iterations, MAX_BARREN_ITERATIONS,
            "it stops at the third unusable reply, not at the 24-iteration ceiling"
        );
    }

    #[test]
    fn a_model_repeating_one_tool_call_stalls_rather_than_burning_the_ceiling() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        // Every reply parses, and every reply asks for something this run
        // already has. That is the failure the empty-reply counter alone would
        // miss: the actions are valid, so `actions.is_empty()` is false every
        // time, and nothing else notices that the run is standing still.
        let engine = ScriptEngine::new(&[
            r#"{"action":"list_scope"}"#,
            r#"{"action":"list_scope"}"#,
            r#"{"action":"list_scope"}"#,
            r#"{"action":"list_scope"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        let out = block_on(drive(&runs, "r", "task", &mut t, &deps(&engine, &recs))).unwrap();
        assert_eq!(
            out.end,
            LoopEnd::Stalled {
                barren_iterations: MAX_BARREN_ITERATIONS
            }
        );
        // The FIRST list_scope was new information, so it is not barren: the
        // three that stalled the run are the repeats after it.
        assert_eq!(out.iterations, MAX_BARREN_ITERATIONS + 1);
    }

    #[test]
    fn a_productive_turn_resets_the_barren_counter() {
        let runs = AgentRunState::default();
        runs.start("r".into(), ids(&["a"]));
        // Two barren turns, then real work, then two more barren turns, then a
        // finish. Nine barren turns in total across the run and never three in
        // a row, so the run must survive to its own ending.
        let engine = ScriptEngine::new(&[
            "nope",
            "still nope",
            r#"{"action":"read_note","note_id":"a"}"#,
            "nope again",
            "and again",
            r#"{"action":"finish","summary":"done"}"#,
        ]);
        let recs = records();
        let mut t = Vec::new();
        let out = block_on(drive(&runs, "r", "task", &mut t, &deps(&engine, &recs))).unwrap();
        assert_eq!(out.end, LoopEnd::Finished);
        assert_eq!(out.iterations, 6);
        assert_eq!(out.notes_read, 1);
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
